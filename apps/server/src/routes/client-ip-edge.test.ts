import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeForwardingMiddleware } from "../edge.js";
import type { AppEnv } from "../env.js";
import { createLogger, logHook } from "../logger.js";
import { requestId } from "../middleware/request-id.js";
import { requestLog } from "../middleware/request-log.js";
import { clientIp, edgeForwardingOptionsOf, proxyTrustOf } from "./deps.js";

/*
 * E-UP-7: `clientIp` — every per-IP rate limit, audit row and operator CIDR check — answers the
 * visitor address the edge Worker forwarded, but only on a request whose edge secret matched.
 */

const SECRET = "edge-secret-current-0123456789abcdef";
const HOST_HEADER = "X-Fundroom-Forwarded-Host";
const IP_HEADER = "X-Fundroom-Client-IP";

const RAW = {
  FORWARDED_HOST_HEADER: HOST_HEADER,
  FORWARDED_CLIENT_IP_HEADER: IP_HEADER,
  EDGE_SHARED_SECRET: SECRET,
};

function appWith(trust: Parameters<typeof clientIp>[1], lines?: string[]) {
  const app = new Hono<AppEnv>();
  const sink = lines ?? [];
  const log = logHook(
    createLogger({
      level: "debug",
      destination: new Writable({
        write(chunk: Buffer, _enc, done) {
          sink.push(chunk.toString("utf8"));
          done();
        },
      }),
    }),
    "http",
  );
  app.use("*", requestId());
  const edge = edgeForwardingMiddleware(RAW, log, trust === true ? { hops: 1 } : trust);
  if (edge === undefined) throw new Error("edge forwarding should be configured");
  app.use("*", edge);
  app.use("*", requestLog(log));
  app.get("/", (c) => c.text(clientIp(c, trust) ?? "none"));
  return app;
}

const ipOf = async (
  trust: Parameters<typeof clientIp>[1],
  headers: Record<string, string>,
): Promise<string> => (await appWith(trust).request("/", { headers })).text();

const edge = (extra: Record<string, string> = {}): Record<string, string> => ({
  "x-fundroom-edge": SECRET,
  [HOST_HEADER]: "investors.acme.com",
  [IP_HEADER]: "198.51.100.23",
  "x-forwarded-for": "104.28.1.9",
  ...extra,
});

describe("edgeForwardingOptionsOf", () => {
  it("is undefined unless both the host header and the secret are configured", () => {
    expect(edgeForwardingOptionsOf({})).toBeUndefined();
    expect(edgeForwardingOptionsOf({ FORWARDED_HOST_HEADER: HOST_HEADER })).toBeUndefined();
    expect(edgeForwardingOptionsOf({ EDGE_SHARED_SECRET: SECRET })).toBeUndefined();
    expect(
      edgeForwardingOptionsOf({ ...RAW, EDGE_SHARED_SECRET_PREVIOUS: "p".repeat(32) }),
    ).toEqual({
      hostHeader: HOST_HEADER,
      clientIpHeader: IP_HEADER,
      secret: SECRET,
      previousSecret: "p".repeat(32),
    });
  });
});

describe("clientIp on an edge-forwarded request", () => {
  const trusted = proxyTrustOf({ TRUST_PROXY: true, TRUST_PROXY_HOPS: 1 });

  it("answers the forwarded visitor IP, with or without TRUST_PROXY", async () => {
    expect(await ipOf(trusted, edge())).toBe("198.51.100.23");
    expect(await ipOf(false, edge())).toBe("198.51.100.23");
    // Even over the Cloudflare rule: the Worker already read CF-Connecting-IP.
    const cf = proxyTrustOf({
      TRUST_PROXY: true,
      TRUST_PROXY_HOPS: 1,
      CLOUDFLARE_TRUSTED_PROXY: "on",
    });
    expect(
      await ipOf(cf, edge({ "x-forwarded-for": "172.70.1.9", "cf-connecting-ip": "1.1.1.1" })),
    ).toBe("198.51.100.23");
  });

  it("without the secret the forwarded IP header is a client-written string and is ignored", async () => {
    const headers = edge();
    delete headers["x-fundroom-edge"];
    expect(await ipOf(trusted, headers)).toBe("104.28.1.9");
  });

  it("an invalid forwarded IP falls back to the ordinary derivation", async () => {
    expect(await ipOf(trusted, edge({ [IP_HEADER]: "garbage" }))).toBe("104.28.1.9");
    expect(await ipOf(trusted, edge({ [IP_HEADER]: "198.51.100.23:443" }))).toBe("104.28.1.9");
  });

  it("logs a mismatch without the presented value, and never logs the configured secret", async () => {
    const lines: string[] = [];
    const app = appWith(trusted, lines);
    const wrong = "an-attacker-guess-0123456789abcdefgh";
    const refused = await app.request("/s/sharetoken123?code=1", {
      method: "POST",
      headers: edge({ "x-fundroom-edge": wrong, "x-forwarded-for": "6.6.6.6, 192.0.2.44" }),
    });
    expect(refused.status).toBe(403);
    // Attributable: method, the path redacted like the access log (no query, no token) and the
    // ordinary derivation's address (the XFF entry the trusted proxy appended), truncated.
    const line = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l["event"] === "http.edge_secret_mismatch");
    expect(line).toMatchObject({
      level: "warn",
      method: "POST",
      path: "/s/:token",
      clientNetwork: "192.0.2.0/24",
      reason: "mismatch",
    });
    expect(JSON.stringify(line)).not.toContain("sharetoken123");
    expect(JSON.stringify(line)).not.toContain("198.51.100");
    expect((await app.request("/", { headers: edge() })).status).toBe(200);
    const all = lines.join("\n");
    expect(all).toContain('"event":"http.edge_secret_mismatch"');
    expect(all).toContain('"level":"warn"');
    expect(all).not.toContain(wrong);
    expect(all).not.toContain(SECRET);
  });
});

/*
 * Duplicate and padded secret headers over a real socket: what @hono/node-server hands the app
 * when a client repeats `X-Fundroom-Edge` (it appends each raw header line, so the value is the
 * ", "-joined list) or pads it with optional whitespace (the HTTP parser strips it).
 */
describe("the edge secret header over a real socket", () => {
  let server: ReturnType<typeof serve>;
  let port = 0;
  beforeAll(async () => {
    const app = appWith(proxyTrustOf({ TRUST_PROXY: true, TRUST_PROXY_HOPS: 1 }));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Sends raw header lines (an array value is sent as repeated lines). */
  function send(secret: string | string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
          headers: {
            "x-fundroom-edge": secret,
            [HOST_HEADER]: "investors.acme.com",
            [IP_HEADER]: "198.51.100.23",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("accepts the secret once", async () => {
    expect(await send(SECRET)).toEqual({ status: 200, body: "198.51.100.23" });
  });

  it("refuses the right secret twice, and a wrong one beside the right one", async () => {
    expect((await send([SECRET, SECRET])).status).toBe(403);
    expect((await send(["wrong-0123456789abcdef0123456789abcdef", SECRET])).status).toBe(403);
    expect((await send([SECRET, "wrong-0123456789abcdef0123456789abcdef"])).status).toBe(403);
  });

  it("strips optional whitespace around the value (it is not part of it), but not inside", async () => {
    expect((await send(`  ${SECRET}\t`)).status).toBe(200);
    expect((await send(`${SECRET.slice(0, 8)} ${SECRET.slice(8)}`)).status).toBe(403);
  });
});

/*
 * L10: once accepted, the secret is gone from the request every handler and adapter sees — on
 * @hono/node-server's own Request, with a body-reading POST, and with the socket still intact.
 */
describe("the accepted secret never reaches a handler (real socket)", () => {
  let server: ReturnType<typeof serve>;
  let port = 0;
  let original: Request | undefined;
  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    const edge = edgeForwardingMiddleware(RAW, () => {}, { hops: 1 });
    if (edge === undefined) throw new Error("edge forwarding should be configured");
    app.use("/plain", async (c, next) => {
      original = c.req.raw;
      await next();
    });
    app.use("*", edge);
    app.use("*", bodyLimit({ maxSize: 64 * 1024 }));
    app.post("/hook", async (c) => {
      // What `mail-webhook.ts` does: read the bytes, hand an adapter a fresh Request over them.
      const bytes = await c.req.arrayBuffer();
      const forAdapter = new Request(c.req.url, {
        method: "POST",
        headers: c.req.raw.headers,
        body: bytes,
      });
      return c.json({
        header: c.req.header("x-fundroom-edge") ?? null,
        raw: c.req.raw.headers.get("x-fundroom-edge"),
        rawHas: c.req.raw.headers.has("x-fundroom-edge"),
        names: Object.keys(c.req.header()),
        adapterHas: forAdapter.headers.has("x-fundroom-edge"),
        adapterBody: await forAdapter.json(),
        forwardedHost: c.req.header(HOST_HEADER) ?? null,
        socket: getConnInfo(c).remote.address ?? null,
        ip: clientIp(c, { hops: 1 }) ?? null,
      });
    });
    app.get("/plain", (c) =>
      c.json({
        header: c.req.header("x-fundroom-edge") ?? null,
        raw: c.req.raw.headers.get("x-fundroom-edge"),
        rawHas: c.req.raw.headers.has("x-fundroom-edge"),
        // Still node-server's own lightweight Request: the in-place delete path, not a copy.
        sameRequest: c.req.raw === original,
      }),
    );
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a GET on node-server's own Request: neither c.req.header nor c.req.raw.headers has it", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/plain",
          method: "GET",
          headers: { "x-fundroom-edge": SECRET, [HOST_HEADER]: "investors.acme.com" },
        },
        (r) => {
          let text = "";
          r.setEncoding("utf8");
          r.on("data", (chunk: string) => {
            text += chunk;
          });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(JSON.parse(res.body)).toEqual({
      header: null,
      raw: null,
      rawHas: false,
      sameRequest: true,
    });
  });

  function post(body: string, chunked: boolean): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/hook",
          method: "POST",
          headers: {
            "x-fundroom-edge": SECRET,
            [HOST_HEADER]: "investors.acme.com",
            [IP_HEADER]: "198.51.100.23",
            "content-type": "application/json",
            ...(chunked ? {} : { "content-length": String(Buffer.byteLength(body)) }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      if (chunked) {
        // Two writes without a content-length: Transfer-Encoding: chunked.
        req.write(body.slice(0, 5));
        req.end(body.slice(5));
      } else req.end(body);
    });
  }

  for (const chunked of [false, true]) {
    it(`a POST handler and its adapter see no secret, and the body and socket are intact (${chunked ? "chunked" : "content-length"})`, async () => {
      const payload = { type: "delivery", id: "evt_1" };
      const res = await post(JSON.stringify(payload), chunked);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(SECRET);
      const got = JSON.parse(res.body) as Record<string, unknown>;
      expect(got).toEqual({
        header: null,
        raw: null,
        rawHas: false,
        names: expect.not.arrayContaining(["x-fundroom-edge"]),
        adapterHas: false,
        adapterBody: payload,
        forwardedHost: "investors.acme.com",
        socket: "127.0.0.1",
        ip: "198.51.100.23",
      });
    });
  }
});
