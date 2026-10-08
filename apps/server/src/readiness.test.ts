import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { readinessDetailGuard } from "./readiness.js";

/*
 * E2.10 F-31: `/readyz` is public (load balancers, uptime monitors) but its check details are
 * driver error text — hosts, ports, bucket names. Strangers get the verdicts; loopback callers
 * and METRICS_TOKEN bearers get everything.
 */
const TOKEN = "m".repeat(24);
const full = {
  status: "not_ready",
  version: "1.2.3",
  checks: [
    { name: "database", status: "ok", checkedAt: "2026-09-23T00:00:00Z", latencyMs: 2 },
    {
      name: "storage",
      status: "fail",
      detail: "connect ECONNREFUSED s3.internal.acme:9000 bucket=acme-prod-docs",
      checkedAt: "2026-09-23T00:00:00Z",
    },
  ],
};

function app(trustProxy = false) {
  const a = new Hono();
  a.use("/readyz", readinessDetailGuard(TOKEN, { trustProxy }));
  a.get("/readyz", (c) => c.json(full, 503));
  return a;
}

describe("readinessDetailGuard", () => {
  it("strips details, latencies and timestamps for an anonymous caller, keeping the status code", async () => {
    const res = await app().request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("acme-prod-docs");
    expect(JSON.parse(text)).toEqual({
      status: "not_ready",
      version: "1.2.3",
      checks: [
        { name: "database", status: "ok" },
        { name: "storage", status: "fail" },
      ],
    });
    const wrong = await app().request("/readyz", { headers: { authorization: "Bearer nope" } });
    expect(await wrong.text()).not.toContain("ECONNREFUSED");
  });

  it("serves the full body to a METRICS_TOKEN bearer", async () => {
    const res = await app().request("/readyz", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(full);
  });

  /** A request as @hono/node-server hands it over, from the given peer address. */
  const fromPeer = (a: Hono, address: string, headers: Record<string, string> = {}) =>
    a.request(
      "/readyz",
      { headers },
      {
        incoming: { socket: { remoteAddress: address, remotePort: 5555, remoteFamily: "IPv4" } },
      },
    );

  it("serves the full body to a loopback peer when no proxy is trusted", async () => {
    expect(await (await fromPeer(app(), "127.0.0.1")).json()).toEqual(full);
    expect(await (await fromPeer(app(), "::1")).json()).toEqual(full);
    expect(await (await fromPeer(app(), "10.0.0.7")).text()).not.toContain("ECONNREFUSED");
  });

  it("R2-04: does not trust loopback behind TRUST_PROXY or with forwarding headers", async () => {
    // nginx/Caddy on the same host, or a mesh sidecar: every internet request is loopback.
    expect(await (await fromPeer(app(true), "127.0.0.1")).text()).not.toContain("ECONNREFUSED");
    const xff = { "x-forwarded-for": "203.0.113.9" };
    expect(await (await fromPeer(app(), "127.0.0.1", xff)).text()).not.toContain("ECONNREFUSED");
    const fwd = { forwarded: "for=203.0.113.9" };
    expect(await (await fromPeer(app(), "127.0.0.1", fwd)).text()).not.toContain("ECONNREFUSED");
    // The token still works.
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect(await (await fromPeer(app(true), "127.0.0.1", bearer)).json()).toEqual(full);
  });
});
