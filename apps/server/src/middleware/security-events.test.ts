import { Writable } from "node:stream";
import { ApiError } from "@fundroom/contracts";
import { csrfMiddleware } from "@fundroom/identity/http";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { createLogger, type Log, logHook } from "../logger.js";
import { startTelemetry } from "../telemetry.js";
import { apiKeyNotAllowed } from "./auth.js";
import { apiErrorHandler } from "./errors.js";
import { requestLog } from "./request-log.js";
import {
  countSecurityEvent,
  createSecurityEvents,
  markAuthzDenial,
  SECURITY_EVENT_LOG_MAX_PER_MINUTE,
} from "./security-events.js";

/*
 * E2.10 F-29 (ASVS 16.3.2 / 16.3.3): authorization denials and CSRF rejections produce a
 * structured security event and a counter, without PII, and the log line cannot be flooded.
 */
const telemetry = startTelemetry({ serviceName: "t", serviceVersion: "0" });
afterAll(() => telemetry.shutdown());

type Line = { event: string } & Record<string, unknown>;

function appWith(lines: Line[]) {
  const log: Log = (event, fields) => lines.push({ event, ...fields });
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", requestLog(log));
  app.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    await next();
  });
  app.use(
    "*",
    csrfMiddleware({ selfOrigin: "https://acme.test" }) as unknown as MiddlewareHandler<AppEnv>,
  );
  const api = new Hono<AppEnv>({ strict: false });
  api.onError(apiErrorHandler(log));
  api.get("/people/:id", () => {
    throw new ApiError("forbidden", "your role (editor) cannot do this", {
      permission: "access.manage",
    });
  });
  api.get("/staff-only", () => {
    throw markAuthzDenial(new ApiError("not_found", "no such path"));
  });
  api.get("/missing", () => {
    throw new ApiError("not_found", "no such document");
  });
  api.post("/things", (c) => c.json({ ok: true }));
  // E3.4 fix round 1 (D5): a key request's refusals name the key (prefix + id), never the token.
  api.get("/keyed/:kind", (c) => {
    c.set("apiKey", {
      id: "01a0db00-0000-7000-8000-0000000000aa",
      name: "zap",
      prefix: "frk_AbCdEfGh",
      scopes: ["access.read"],
      creatorMembershipId: "01a0db00-0000-7000-8000-0000000000bb",
    });
    if (c.req.param("kind") === "scope")
      throw new ApiError("forbidden", "no scope", {
        reason: "scope_missing",
        permission: "audit.read",
      });
    throw apiKeyNotAllowed(c as never);
  });
  app.route("/api/v1", api);
  return app;
}

const events = (lines: Line[]) => lines.filter((l) => l.event.startsWith("security."));

describe("security events (F-29)", () => {
  it("a key request's 401 api_key_not_allowed and 403 scope_missing name the key (D5)", async () => {
    const lines: Line[] = [];
    const app = appWith(lines);
    expect((await app.request("/api/v1/keyed/route")).status).toBe(401);
    expect((await app.request("/api/v1/keyed/scope")).status).toBe(403);
    expect(events(lines)).toEqual([
      expect.objectContaining({
        event: "security.api_key_rejected",
        status: 401,
        errorCode: "unauthenticated",
        reason: "api_key_not_allowed",
        keyPrefix: "frk_AbCdEfGh",
        apiKeyId: "01a0db00-0000-7000-8000-0000000000aa",
      }),
      expect.objectContaining({
        event: "security.authz_denied",
        status: 403,
        errorCode: "forbidden",
        permission: "audit.read",
        keyPrefix: "frk_AbCdEfGh",
        apiKeyId: "01a0db00-0000-7000-8000-0000000000aa",
      }),
    ]);
  });

  it("logs a 403 as security.authz_denied with ids and templates only", async () => {
    const lines: Line[] = [];
    const res = await appWith(lines).request("/api/v1/people/bob@example.test?x=secret");
    expect(res.status).toBe(403);
    expect(events(lines)).toEqual([
      expect.objectContaining({
        event: "security.authz_denied",
        level: "warn",
        requestId: "req-1",
        method: "GET",
        route: "/api/v1/people/:id",
        status: 403,
        errorCode: "forbidden",
        permission: "access.manage",
      }),
    ]);
    const logged = JSON.stringify(events(lines));
    expect(logged).not.toContain("bob@example.test");
    expect(logged).not.toContain("secret");
  });

  it("logs the authz layer's hiding 404, and not an ordinary one", async () => {
    const lines: Line[] = [];
    const app = appWith(lines);
    expect((await app.request("/api/v1/staff-only")).status).toBe(404);
    expect((await app.request("/api/v1/missing")).status).toBe(404);
    expect(events(lines).map((l) => [l.event, l["route"], l["errorCode"]])).toEqual([
      ["security.authz_denied", "/api/v1/staff-only", "not_found"],
    ]);
  });

  it("logs a CSRF rejection as security.csrf_rejected with its reason", async () => {
    const lines: Line[] = [];
    const res = await appWith(lines).request("/api/v1/things", {
      method: "POST",
      headers: { cookie: "__Host-sid=x", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(events(lines)).toEqual([
      expect.objectContaining({
        event: "security.csrf_rejected",
        errorCode: "csrf_rejected",
        reason: "cross-site",
        status: 403,
      }),
    ]);
  });

  it("counts every event on /metrics with bounded labels", async () => {
    const lines: Line[] = [];
    const app = appWith(lines);
    await app.request("/api/v1/people/x");
    const text = await telemetry.metricsText();
    expect(text).toMatch(
      /fundroom_security_events_total\{[^}]*event="authz_denied"[^}]*code="forbidden"[^}]*\} \d+/u,
    );
    expect(text).not.toMatch(/fundroom_security_events_total\{[^}]*route=/u);
    // A-2: the series and its meter scope carry the FundRoom name only.
    expect(text).toMatch(/otel_scope_name="fundroom\.security"/u);
    expect(text).not.toMatch(/seed_?host/iu);
  });

  it("counts a skipped breached-password check with the fail mode as reason (E3.2 F-21)", async () => {
    countSecurityEvent("breach_check_unavailable", "breach_check_unavailable", "open");
    countSecurityEvent("breach_check_unavailable", "breach_check_unavailable", "closed");
    countSecurityEvent("breach_check_unavailable", "Not A Label!", undefined);
    const text = await telemetry.metricsText();
    for (const reason of ["open", "closed"])
      expect(text).toMatch(
        new RegExp(
          `fundroom_security_events_total\\{[^}]*event="breach_check_unavailable"[^}]*reason="${reason}"[^}]*\\} 1`,
          "u",
        ),
      );
    expect(text).toMatch(/event="breach_check_unavailable"[^}]*code="other"[^}]*reason="none"/u);
  });

  it("survives the production logger's redaction (the error code is not under a redacted key)", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        for (const line of String(chunk).split("\n").filter(Boolean))
          lines.push(JSON.parse(line) as Record<string, unknown>);
        cb();
      },
    });
    const log = logHook(createLogger({ level: "debug", destination: stream }), "http");
    const app = new Hono<AppEnv>({ strict: false });
    app.use("*", requestLog(log));
    app.onError(apiErrorHandler(log));
    app.get("/x", () => {
      throw new ApiError("forbidden", "no");
    });
    await app.request("/x");
    expect(lines.find((l) => l["event"] === "security.authz_denied")).toMatchObject({
      level: "warn",
      errorCode: "forbidden",
    });
  });

  it("caps the log lines per minute and reports what it suppressed", () => {
    const lines: Line[] = [];
    let t = 60_000 * 1000;
    const emitter = createSecurityEvents((event, fields) => lines.push({ event, ...fields }), {
      now: () => t,
    });
    const vars: Record<string, unknown> = {
      securityEvent: { event: "authz_denied", code: "forbidden" },
    };
    const c = {
      get: (k: string) => vars[k],
      req: { method: "GET", routePath: "/api/v1/x" },
      res: { status: 403 },
    } as never;
    for (let i = 0; i < SECURITY_EVENT_LOG_MAX_PER_MINUTE + 30; i++) emitter.emit(c);
    expect(lines).toHaveLength(SECURITY_EVENT_LOG_MAX_PER_MINUTE);
    t += 60_000;
    emitter.emit(c);
    expect(lines.at(-1)).toMatchObject({ event: "security.authz_denied", suppressed: 30 });
  });
});
