import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AppEnv } from "./env.js";
import type { Log } from "./logger.js";
import { redactPath, requestLog } from "./middleware/request-log.js";
import { CATCH_ALL_ROUTE, createHttpMetrics, routeLabel, startTelemetry } from "./telemetry.js";

/*
 * E2.10 F-01. The metrics middleware used to label every catch-all hit with its raw path, so
 * `/s/<share-token>` and `/invite/<token>` were published on `/metrics`, and each distinct path
 * was a new histogram series. The access log carried the same raw path.
 */
const SHARE_TOKEN = "Zk3qT9vB2mXw7LpR4sYc8NdH6aJ1eUoG";
const INVITE_TOKEN = "inv_Q2w3E4r5T6y7U8i9O0pA1sD2f";

const telemetry = startTelemetry({ serviceName: "t", serviceVersion: "0" });
afterAll(() => telemetry.shutdown());

function appWith(basePath: string, lines: Record<string, unknown>[]) {
  const log: Log = (_event, fields) => lines.push({ ...fields });
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", async (c, next) => {
    c.set("log", log);
    await next();
  });
  app.use("*", requestLog(log, { basePath }));
  app.use("*", createHttpMetrics({ basePath }).middleware);
  app.get(`${basePath}/api/v1/links/:token`, (c) => c.json({ ok: true }));
  // The SPA catch-all (web.ts): every portal page, including /s/<token> and /invite/<token>.
  app.get(`${basePath}/*`, (c) => c.html("<!doctype html>"));
  return app;
}

describe("route labels (F-01)", () => {
  it("maps the catch-all to one constant label and keeps templates", () => {
    expect(routeLabel("/*")).toBe(CATCH_ALL_ROUTE);
    expect(routeLabel("*")).toBe(CATCH_ALL_ROUTE);
    expect(routeLabel("/investors/*", "/investors")).toBe(CATCH_ALL_ROUTE);
    expect(routeLabel("/api/v1/links/:token")).toBe("/api/v1/links/:token");
  });

  it("never puts a token-bearing path on /metrics or in the access log", async () => {
    for (const basePath of ["", "/investors"]) {
      const lines: Record<string, unknown>[] = [];
      const app = appWith(basePath, lines);
      for (const path of [
        `/s/${SHARE_TOKEN}`,
        `/invite/${INVITE_TOKEN}`,
        `/w/acme/s/${SHARE_TOKEN}`,
        `/api/v1/links/${SHARE_TOKEN}`,
        `/nope/${INVITE_TOKEN}`,
      ]) {
        expect((await app.request(`${basePath}${path}`)).status).toBeLessThan(500);
      }
      const text = await telemetry.metricsText();
      expect(text).toContain(`http_route="${CATCH_ALL_ROUTE}"`);
      expect(text).toContain(`http_route="${basePath}/api/v1/links/:token"`);
      const logged = JSON.stringify(lines);
      for (const secret of [SHARE_TOKEN, INVITE_TOKEN]) {
        expect(text).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
      expect(lines.map((l) => l["path"])).toContain(
        `${basePath === "" ? "" : "/investors"}/s/:token`,
      );
    }
  });

  it("keeps the series count bounded under a stream of random paths and methods", async () => {
    const app = appWith("", []);
    const seriesCount = async () =>
      (await telemetry.metricsText())
        .split("\n")
        .filter((l) => l.startsWith("http_server_request_duration_count")).length;
    await app.request("/warm-up");
    const before = await seriesCount();
    for (let i = 0; i < 300; i++) {
      await app.request(`/random/${crypto.randomUUID()}/${i}`, {
        method: i % 3 === 0 ? `X${i}` : "GET",
      });
    }
    // At most: one new status code (404 for unknown methods) × the `_OTHER` method label.
    expect((await seriesCount()) - before).toBeLessThanOrEqual(2);
  });
});

describe("redactPath", () => {
  it.each([
    ["/s/abc", "/s/:token"],
    [`/invite/${INVITE_TOKEN}`, "/invite/:token"],
    [`/w/acme/s/${SHARE_TOKEN}`, "/w/acme/s/:token"],
    // Short enough to escape the identifier shape: only the parent rule redacts it.
    ["/api/v1/metrics/chart/aB3-short.png", "/api/v1/metrics/chart/:token"],
    ["/admin/people/0f8fad5b-d9cb-469f-a165-70867728950e", "/admin/people/:id"],
    ["/updates/2026-q3", "/updates/2026-q3"],
    ["/a/b/c/d/e/f/g/h/i/j", "/a/b/c/d/e/f/g/h/…"],
  ])("%s → %s", (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });
});
