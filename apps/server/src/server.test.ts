import { Writable } from "node:stream";
import { ApiError } from "@fundroom/contracts";
import { AuthError } from "@fundroom/identity";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { createLogger, logHook } from "./logger.js";
import { apiCors, normalizeOrigin } from "./middleware/cors.js";
import { normalizeError } from "./middleware/errors.js";
import { requestId } from "./middleware/request-id.js";
import { assertBootInvariants, createReadiness } from "./readiness.js";
import { opsRoutes } from "./routes/ops.js";
import { createHttpMetrics, startTelemetry } from "./telemetry.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean))
        lines.push(JSON.parse(line) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, stream };
}

describe("logger", () => {
  it("redacts emails, tokens and codes wherever they appear and infers levels from event names", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ level: "debug", destination: stream });
    const log = logHook(logger, "test");
    log("auth.login_failed", {
      email: "ada@example.com",
      nested: { token: "t", code: "123456" },
      userId: "u1",
    });
    log("jobs.registered", { name: "x" });
    log("custom", { level: "error", cookie: "sid=1" });
    expect(lines[0]).toMatchObject({
      level: "warn",
      component: "test",
      event: "auth.login_failed",
      email: "[redacted]",
      userId: "u1",
    });
    const nested = (lines[0] as Record<string, unknown>)["nested"] as Record<string, unknown>;
    expect(nested["token"]).toBe("[redacted]");
    expect(nested["code"]).toBe("[redacted]");
    expect(lines[1]).toMatchObject({ level: "debug" });
    expect(lines[2]).toMatchObject({ level: "error", cookie: "[redacted]" });
    expect(lines[2]).not.toHaveProperty("level.explicit");
  });
});

describe("normalizeError", () => {
  it("maps AuthError, HTTPException and unknown errors onto the envelope", () => {
    expect(
      normalizeError(new AuthError("rate_limited", "slow", { retryAfterMs: 3000 })),
    ).toMatchObject({ code: "rate_limited", status: 429, headers: { "Retry-After": "3" } });
    expect(normalizeError(new HTTPException(413))).toMatchObject({ code: "payload_too_large" });
    expect(normalizeError(new HTTPException(415))).toMatchObject({
      code: "unsupported_media_type",
    });
    expect(normalizeError(new ApiError("not_found"))).toMatchObject({ code: "not_found" });
    const internal = normalizeError(new Error("db exploded"));
    expect(internal).toMatchObject({ code: "internal_error", status: 500 });
    expect(internal.toBody("r").error["message"]).not.toContain("exploded");
  });
});

describe("cors", () => {
  it("allows exact origins only", async () => {
    const app = new Hono();
    app.use(
      "*",
      apiCors({
        staticOrigins: ["https://app.example.com", "not a url"],
        workspaceOrigins: () => ["https://ws.example.com"],
      }),
    );
    app.get("/", (c) => c.text("ok"));
    const ok = await app.request("/", { headers: { origin: "https://app.example.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(ok.headers.get("vary")).toContain("Origin");
    const ws = await app.request("/", { headers: { origin: "https://ws.example.com" } });
    expect(ws.headers.get("access-control-allow-origin")).toBe("https://ws.example.com");
    const sub = await app.request("/", { headers: { origin: "https://evil.app.example.com" } });
    expect(sub.headers.get("access-control-allow-origin")).toBeNull();
    expect(normalizeOrigin("HTTPS://App.Example.com/path")).toBe("https://app.example.com");
    expect(normalizeOrigin("ftp://x")).toBeUndefined();
  });
});

describe("request id", () => {
  it("accepts safe ids and generates otherwise", async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", requestId());
    app.get("/", (c) => c.text(c.get("requestId")));
    const given = await app.request("/", { headers: { "x-request-id": "abc-123" } });
    expect(await given.text()).toBe("abc-123");
    const generated = await app.request("/", { headers: { "x-request-id": "<script>" } });
    const id = await generated.text();
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(generated.headers.get("x-request-id")).toBe(id);
  });
});

describe("readiness", () => {
  function fakes(
    overrides: Partial<{
      ping: boolean;
      storage: boolean;
      mail: boolean;
      queue: boolean;
      render: boolean;
    }> = {},
  ) {
    const o = { ping: true, storage: true, mail: true, queue: true, render: true, ...overrides };
    let mailCalls = 0;
    const r = createReadiness({
      db: {
        ping: async () => o.ping,
        pool: {
          connect: async () => {
            throw new Error("no pool in unit test");
          },
        },
      } as never,
      storage: {
        driver: "fs",
        healthCheck: async () => {
          if (!o.storage) throw new Error("postgres://u:p@h/db down");
        },
      } as never,
      mailer: {
        driver: "memory",
        healthCheck: async () => {
          mailCalls++;
          if (!o.mail) throw new Error("smtp down");
        },
      } as never,
      queue: {
        stats: async () => {
          if (!o.queue) throw new Error("boss down");
          return [];
        },
      } as never,
      renderer: {
        driver: "pdfium",
        healthCheck: async () => {
          if (!o.render) throw new Error("no fonts available to librsvg");
        },
      } as never,
      migrationSources: [],
    });
    return { r, calls: () => mailCalls };
  }

  it("reports each check, caches slow probes and scrubs credentials", async () => {
    const { r, calls } = fakes({ storage: false });
    const first = await r.run();
    expect(first.ready).toBe(false);
    const byName = Object.fromEntries(first.checks.map((c) => [c.name, c]));
    expect(byName["migrations"]?.status).toBe("fail"); // no pool in the unit fake
    expect(byName["storage"]).toMatchObject({ status: "fail", detail: "postgres://***@h/db down" });
    expect(byName["mail"]?.status).toBe("ok");
    await r.run();
    expect(calls()).toBe(1);
  });

  it("remembers a wizard probe as passed and primes the cache (E0.8)", async () => {
    const { r, calls } = fakes({ storage: false });
    expect(r.passed("storage")).toBe(false);
    r.markPassed("storage", "fs");
    expect(r.passed("storage")).toBe(true);
    const run = await r.run();
    expect(run.checks.find((c) => c.name === "storage")).toMatchObject({
      status: "ok",
      detail: "fs",
    });
    expect(r.passed("mail")).toBe(true); // the health check passed during run()
    expect(calls()).toBe(1);
  });

  /*
   * E2.4: the renderer's health check compares each probe glyph against a code point no font
   * can have a glyph for, because under a missing font every glyph is the same `.notdef`
   * rectangle and a naive "is there any ink" probe passes. Readiness reports it — but the
   * load-bearing call is `assertBootInvariants`, below: nothing in the shipped deployment
   * polls `/readyz`, so a fontless image that merely went "not ready" would still be answering
   * 200 to its container health check and to Caddy while serving blank watermarks.
   */
  it("fails readiness when the renderer cannot find a font (E2.4)", async () => {
    const { r } = fakes({ render: false });
    const res = await r.run();
    const render = res.checks.find((c) => c.name === "render");
    expect(render?.status).toBe("fail");
    expect(render?.detail).toContain("no fonts available to librsvg");
    expect(res.ready).toBe(false);
  });

  /*
   * E2.4 finding 14. A probe that hangs is the one failure a readiness endpoint exists to
   * report, and before this it was the one failure it could not: `/readyz` awaited the check
   * with no ceiling, so a renderer whose `healthCheck()` never settled held the request, the
   * connection and the prober open indefinitely. A readiness endpoint that can hang is worse
   * than one that reports a failure.
   */
  it("fails a probe that hangs instead of hanging /readyz (E2.4)", async () => {
    const r = createReadiness({
      db: { ping: async () => true, pool: {} } as never,
      storage: { driver: "fs", healthCheck: async () => {} } as never,
      mailer: { driver: "memory", healthCheck: async () => {} } as never,
      queue: { stats: async () => [] } as never,
      renderer: { driver: "pdfium", healthCheck: () => new Promise<void>(() => {}) } as never,
      migrationSources: [],
      probeTimeoutMs: 25,
    });
    const started = Date.now();
    const res = await r.run();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.checks.find((c) => c.name === "render")).toMatchObject({
      status: "fail",
      detail: "render probe timed out after 25 ms",
    });
    expect(res.ready).toBe(false);
  });

  it("skips dependent checks when the database is down and turns 503 while draining", async () => {
    const { r } = fakes({ ping: false });
    const res = await r.run();
    expect(res.checks.find((c) => c.name === "queue")?.status).toBe("skipped");
    r.setDraining();
    expect((await r.run()).ready).toBe(false);
  });
});

/*
 * E2.4 finding 5. `readiness.ts` said "a guard nothing calls is not a guard" and that was its
 * own state: `/readyz` runs the checks, and nothing in the shipped deployment polls `/readyz`.
 * The container HEALTHCHECK (`deploy/docker/Dockerfile` → `healthcheck.ts`), Compose's
 * `healthcheck:` and Caddy's `health_uri` all poll `/healthz`, which runs no checks at all — so
 * an image whose font layer regressed answered 200 to every gate it was actually asked, stayed
 * in Caddy's pool and went on compositing blank watermarks. Repointing those at `/readyz` is
 * the wrong repair (it makes a Postgres blip restart the container); the font is fixed when the
 * image is built, so it is asserted once, before the listener opens.
 */
describe("boot invariants", () => {
  it("refuses to start when the renderer cannot find a font (E2.4)", async () => {
    await expect(
      assertBootInvariants({
        renderer: {
          driver: "pdfium",
          healthCheck: async () => {
            throw new Error("no font available to librsvg: ...");
          },
        } as never,
      }),
    ).rejects.toThrow(/no font available to librsvg/u);
  });

  it("does not wait forever on a renderer that hangs", async () => {
    await expect(
      assertBootInvariants({
        renderer: { driver: "pdfium", healthCheck: () => new Promise<void>(() => {}) } as never,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/renderer boot check timed out after 25 ms/u);
  });

  it("starts when the renderer is healthy", async () => {
    await expect(
      assertBootInvariants({
        renderer: { driver: "pdfium", healthCheck: async () => {} } as never,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ops routes", () => {
  const telemetry = startTelemetry({ serviceName: "t", serviceVersion: "0" });
  const readiness = createReadiness({
    db: { ping: async () => true, pool: {} } as never,
    storage: { driver: "fs", healthCheck: async () => {} } as never,
    mailer: { driver: "memory", healthCheck: async () => {} } as never,
    queue: { stats: async () => [] } as never,
    renderer: { driver: "pdfium", healthCheck: async () => {} } as never,
    migrationSources: [],
  });
  const app = new Hono();
  app.use("*", createHttpMetrics().middleware);
  /** Stands in for the custom-domain lookup: only this hostname is verified. */
  const issuableHosts = new Set(["investors.acme.example"]);
  app.route(
    "/",
    opsRoutes({
      readiness,
      telemetry,
      metricsEnabled: true,
      metricsToken: "s3cret-s3cret-s3cret",
      tenancy: "single",
      features: [],
      authMethods: ["email_otp"],
      passkeyRpId: "localhost",
      basePath: "",
      log: () => {},
      startedAt: Date.now(),
      canonicalHost: "localhost:3000",
      issuable: (hostname) => Promise.resolve(issuableHosts.has(hostname)),
    }),
  );

  it("answers the Caddy on-demand TLS ask for the canonical host only", async () => {
    expect((await app.request("/internal/tls/ask?domain=localhost")).status).toBe(200);
    expect((await app.request("/internal/tls/ask?domain=LOCALHOST")).status).toBe(200);
    expect((await app.request("/internal/tls/ask?domain=evil.example")).status).toBe(404);
    expect((await app.request("/internal/tls/ask")).status).toBe(404);
  });

  it("answers the ask for a verified custom domain, and only through the lookup", async () => {
    // The canonical host never reaches the lookup at all (E2.1 §1.11's fast path); a custom
    // domain does, and only a verified one is answered 200.
    expect((await app.request("/internal/tls/ask?domain=investors.acme.example")).status).toBe(200);
    expect((await app.request("/internal/tls/ask?domain=INVESTORS.ACME.EXAMPLE")).status).toBe(200);
    expect((await app.request("/internal/tls/ask?domain=not-verified.example")).status).toBe(404);
  });

  it("keeps the canonical-host fast path free of the lookup entirely", async () => {
    // E2.1 S3 / decision 3: the overwhelmingly common case on a self-hosted install must cost
    // nothing — no cache, no database, no rate-limit budget. The route used to key an in-process
    // limiter on `clientIp(c, trustProxy)`, which `TRUST_PROXY=true` plus Caddy *appending* to
    // `X-Forwarded-For` made attacker-supplied: a fresh bucket per spoofed value, so it never
    // fired, while every legitimate ask shared Caddy's own container-IP bucket. The limit now
    // lives on cache misses inside the lookup, where it counts database reads instead.
    let asked = 0;
    const counted = new Hono();
    counted.route(
      "/",
      opsRoutes({
        readiness,
        telemetry,
        metricsEnabled: false,
        metricsToken: undefined,
        tenancy: "single",
        features: [],
        authMethods: ["email_otp"],
        passkeyRpId: "localhost",
        basePath: "",
        log: () => {},
        startedAt: Date.now(),
        canonicalHost: "localhost:3000",
        issuable: (hostname) => {
          asked++;
          return Promise.resolve(issuableHosts.has(hostname));
        },
      }),
    );
    for (let i = 0; i < 50; i++) {
      const res = await counted.request("/internal/tls/ask?domain=localhost", {
        // A spoofed first hop, which used to buy a fresh bucket per value.
        headers: { "x-forwarded-for": `10.0.0.${i}, 172.20.0.2` },
      });
      expect(res.status).toBe(200);
    }
    expect(asked).toBe(0);
  });

  it("never answers 429: a rate limit tells a prober it found one, and Caddy only needs non-2xx", async () => {
    // Over budget the lookup answers "not issuable" and this route answers 404 — the same answer
    // an unknown hostname gets, which is deliberately uninformative.
    const refusing = new Hono();
    refusing.route(
      "/",
      opsRoutes({
        readiness,
        telemetry,
        metricsEnabled: false,
        metricsToken: undefined,
        tenancy: "single",
        features: [],
        authMethods: ["email_otp"],
        passkeyRpId: "localhost",
        basePath: "",
        log: () => {},
        startedAt: Date.now(),
        canonicalHost: "localhost:3000",
        issuable: () => Promise.resolve(false),
      }),
    );
    for (let i = 0; i < 500; i++) {
      const res = await refusing.request(`/internal/tls/ask?domain=probe${i}.example.com`);
      expect(res.status).toBe(404);
    }
  });

  it("guards /metrics with the bearer token and records the histogram", async () => {
    expect((await app.request("/metrics")).status).toBe(401);
    expect(
      (await app.request("/metrics", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    await app.request("/healthz");
    const ok = await app.request("/metrics", {
      headers: { authorization: "Bearer s3cret-s3cret-s3cret" },
    });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain("http_server_request_duration_count");
    expect(text).toContain('http_route="/healthz"');
  });

  it("caps CSP reports by size", async () => {
    const big = await app.request("/csp-report", {
      method: "POST",
      headers: { "content-length": String(64 * 1024) },
      body: "x",
    });
    expect(big.status).toBe(413);
  });
});
