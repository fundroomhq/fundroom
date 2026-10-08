import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describe, expect, it } from "vitest";
import {
  createEdgeSecretCheck,
  EDGE_SECRET_HEADER,
  type EdgeEnv,
  type EdgeForwardingOptions,
  edgeForwardedOf,
  edgeForwarding,
  parseForwardedClientIp,
  parseForwardedHost,
  stripEdgeSecret,
} from "./edge.js";
import { isSecureRequest, requestHost, requestOrigin } from "./request.js";
import { securityHeaders } from "./security-headers.js";

/* E-UP-7 (ADR-0064): edge forwarding behind a shared secret. */

const SECRET = "edge-secret-current-0123456789abcdef";
const PREVIOUS = "edge-secret-previous-0123456789abcdef";
const HOST_HEADER = "X-Fundroom-Forwarded-Host";
const IP_HEADER = "X-Fundroom-Client-IP";

describe("parseForwardedHost", () => {
  it("accepts one DNS name and lower-cases it", () => {
    expect(parseForwardedHost("investors.acme.com")).toBe("investors.acme.com");
    expect(parseForwardedHost("Investors.ACME.com")).toBe("investors.acme.com");
    expect(parseForwardedHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(parseForwardedHost("a-b.c-d.example")).toBe("a-b.c-d.example");
    expect(parseForwardedHost("localhost")).toBe("localhost");
    expect(parseForwardedHost(`${"a".repeat(63)}.example`)).toBe(`${"a".repeat(63)}.example`);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["a port", "investors.acme.com:443"],
    ["a trailing dot", "investors.acme.com."],
    ["a comma list", "investors.acme.com, evil.test"],
    ["a comma without space", "a.test,b.test"],
    ["whitespace", " investors.acme.com"],
    ["inner whitespace", "investors .acme.com"],
    ["an empty label", "investors..acme.com"],
    ["a leading dot", ".acme.com"],
    ["a leading hyphen", "-acme.com"],
    ["a trailing hyphen label", "acme-.com"],
    ["an underscore", "in_vestors.acme.com"],
    ["a 64-char label", `${"a".repeat(64)}.example`],
    ["over 253 chars", `${"a.".repeat(127)}com`],
    ["an IPv4 literal", "203.0.113.7"],
    ["an IPv6 literal", "[2001:db8::1]"],
    ["a bare IPv6", "2001:db8::1"],
    ["a URL", "https://acme.com"],
    ["a path", "acme.com/x"],
    ["non-ASCII", "bücher.example"],
    ["a quote", 'acme.com"'],
    ["CRLF", "acme.com\r\nx: y"],
  ])("refuses %s", (_label, value) => {
    expect(parseForwardedHost(value)).toBeUndefined();
  });

  it("accepts exactly 253 chars", () => {
    const name = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(name.length).toBe(253);
    expect(parseForwardedHost(name)).toBe(name);
  });
});

describe("parseForwardedClientIp", () => {
  it("accepts IPv4 and IPv6 literals", () => {
    expect(parseForwardedClientIp("203.0.113.7")).toBe("203.0.113.7");
    expect(parseForwardedClientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(parseForwardedClientIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
  });
  it.each([
    undefined,
    null,
    "",
    "203.0.113.7:443",
    "[2001:db8::1]",
    "[2001:db8::1]:443",
    "203.0.113.7, 198.51.100.1",
    " 203.0.113.7",
    "999.0.0.1",
    "unknown",
    "acme.com",
  ])("ignores %s", (value) => {
    expect(parseForwardedClientIp(value)).toBeUndefined();
  });
});

describe("createEdgeSecretCheck", () => {
  it("accepts the current secret, and the previous one only when configured", () => {
    const check = createEdgeSecretCheck(SECRET);
    expect(check(SECRET)).toBe(true);
    expect(check(PREVIOUS)).toBe(false);
    const rotating = createEdgeSecretCheck(SECRET, PREVIOUS);
    expect(rotating(SECRET)).toBe(true);
    expect(rotating(PREVIOUS)).toBe(true);
  });
  it("refuses a wrong value, a wrong length, a prefix and the empty string", () => {
    const check = createEdgeSecretCheck(SECRET, PREVIOUS);
    expect(check(`${SECRET.slice(0, -1)}X`)).toBe(false);
    expect(check(SECRET.slice(0, -1))).toBe(false);
    expect(check(`${SECRET}x`)).toBe(false);
    expect(check("")).toBe(false);
    expect(check(SECRET.toUpperCase())).toBe(false);
  });
});

interface Logged {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function build(overrides: Partial<EdgeForwardingOptions> | "off" = {}) {
  const logs: Logged[] = [];
  const refusals: [string, string][] = [];
  const app = new Hono<EdgeEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    await next();
  });
  if (overrides !== "off") {
    app.use(
      "*",
      edgeForwarding({
        hostHeader: HOST_HEADER,
        clientIpHeader: IP_HEADER,
        secret: SECRET,
        log: (event, fields) => logs.push({ event, fields }),
        attribution: (c) => ({ path: c.req.path, clientNetwork: "198.51.100.0/24" }),
        onRefused: (code, reason) => refusals.push([code, reason]),
        ...overrides,
      }),
    );
  }
  app.get("/facts", (c) => {
    const trust = c.req.query("trust") === "1";
    return c.json({
      edge: edgeForwardedOf(c) ?? null,
      host: requestHost(c, trust),
      origin: requestOrigin(c, trust),
      secure: isSecureRequest(c, trust),
    });
  });
  app.get("/varied", (c) => {
    c.header("Vary", "Cookie");
    return c.text("x");
  });
  app.get("/star", (c) => {
    c.header("Vary", "*");
    return c.text("x");
  });
  return { app, logs, refusals };
}

const edgeHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  [EDGE_SECRET_HEADER]: SECRET,
  [HOST_HEADER]: "Investors.Acme.com",
  [IP_HEADER]: "203.0.113.7",
  ...extra,
});

describe("edgeForwarding middleware", () => {
  it("not configured: forwarded headers are never read, even with a valid secret", async () => {
    const { app } = build("off");
    const res = await app.request("http://app.up.railway.test/facts", { headers: edgeHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      edge: null,
      host: "app.up.railway.test",
      origin: "http://app.up.railway.test",
      secure: false,
    });
    expect(res.headers.get("vary")).toBeNull();
  });

  it("no secret header: an ordinary request, forwarded headers ignored entirely", async () => {
    const { app, logs } = build();
    const headers = edgeHeaders();
    delete headers[EDGE_SECRET_HEADER];
    const res = await app.request("http://app.up.railway.test/facts", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      edge: null,
      host: "app.up.railway.test",
      secure: false,
    });
    expect(res.headers.get("vary")).toBeNull();
    expect(logs).toEqual([]);
  });

  it("wrong secret: 403 edge_unauthorized, warn log without the value", async () => {
    const { app, logs, refusals } = build();
    const wrong = "an-attacker-guess-0123456789abcdefgh";
    const res = await app.request("http://app.up.railway.test/facts?token=abc", {
      headers: edgeHeaders({ [EDGE_SECRET_HEADER]: wrong }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "edge_unauthorized",
        message: "the edge credential was not accepted",
        requestId: "req-1",
      },
    });
    expect(body).not.toContain(wrong);
    expect(body).not.toContain(SECRET);
    // Attributable (method, the server's path + client network), never a header value.
    expect(logs).toEqual([
      {
        event: "http.edge_secret_mismatch",
        fields: {
          level: "warn",
          requestId: "req-1",
          method: "GET",
          path: "/facts",
          clientNetwork: "198.51.100.0/24",
          reason: "mismatch",
        },
      },
    ]);
    expect(refusals).toEqual([["edge_unauthorized", "mismatch"]]);
    expect(JSON.stringify(logs)).not.toContain(wrong);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("duplicate secret headers are one joined value and never match; OWS padding is not part of it", async () => {
    // Fetch `Headers` (and @hono/node-server, which builds them by appending each raw line)
    // join repeated fields with ", ": two copies of the right secret are not the right secret.
    const { app, refusals } = build({ previousSecret: PREVIOUS });
    for (const values of [
      [SECRET, SECRET],
      ["wrong-0123456789abcdef0123456789abcdef", SECRET],
      [SECRET, PREVIOUS],
    ]) {
      const headers = new Headers(edgeHeaders());
      headers.delete(EDGE_SECRET_HEADER);
      for (const v of values) headers.append(EDGE_SECRET_HEADER, v);
      expect((await app.request("http://x.test/facts", { headers })).status).toBe(403);
    }
    expect(refusals).toHaveLength(3);
    // Leading/trailing SP/HTAB is optional whitespace around a field value (RFC 9110 §5.5);
    // `Headers` strips it, as the node HTTP parser does, so the value compared is the secret.
    const padded = await app.request("http://x.test/facts", {
      headers: edgeHeaders({ [EDGE_SECRET_HEADER]: ` \t${SECRET} ` }),
    });
    expect(padded.status).toBe(200);
    // Inner padding is part of the value.
    const inner = await app.request("http://x.test/facts", {
      headers: edgeHeaders({ [EDGE_SECRET_HEADER]: `${SECRET.slice(0, 10)} ${SECRET.slice(10)}` }),
    });
    expect(inner.status).toBe(403);
  });

  it("a throwing log, attribution or counter hook never turns a refusal into a 500", async () => {
    const boom = () => {
      throw new Error("hook failed");
    };
    for (const hooks of [
      { attribution: boom },
      { log: boom },
      { onRefused: boom },
      { attribution: boom, log: boom, onRefused: boom },
    ]) {
      const { app } = build(hooks);
      const res = await app.request("http://x.test/facts", {
        headers: edgeHeaders({ [EDGE_SECRET_HEADER]: "wrong-0123456789abcdef0123456789abcdef" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "edge_unauthorized",
          message: "the edge credential was not accepted",
          requestId: "req-1",
        },
      });
      const missing = edgeHeaders();
      delete missing[HOST_HEADER];
      const bad = await app.request("http://x.test/facts", { headers: missing });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_request",
      );
    }
    // A failed attribution still leaves the line itself.
    const { app, logs } = build({ attribution: boom });
    await app.request("http://x.test/facts", {
      headers: edgeHeaders({ [EDGE_SECRET_HEADER]: "wrong-0123456789abcdef0123456789abcdef" }),
    });
    expect(logs).toEqual([
      {
        event: "http.edge_secret_mismatch",
        fields: { level: "warn", requestId: "req-1", method: "GET", reason: "mismatch" },
      },
    ]);
  });

  it("the previous secret is refused unless configured, accepted during a rotation", async () => {
    const headers = edgeHeaders({ [EDGE_SECRET_HEADER]: PREVIOUS });
    expect((await build().app.request("http://x.test/facts", { headers })).status).toBe(403);
    const rotating = build({ previousSecret: PREVIOUS }).app;
    const res = await rotating.request("http://x.test/facts", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ host: "investors.acme.com", secure: true });
  });

  it("valid secret: customer host, https and the visitor IP, whatever TRUST_PROXY says", async () => {
    const { app, logs } = build();
    for (const trust of ["0", "1"]) {
      const res = await app.request(`http://app.up.railway.test/facts?trust=${trust}`, {
        headers: edgeHeaders({
          // Railway's edge overwrites these; they must not win over the edge's facts.
          "x-forwarded-host": "app.up.railway.test",
          "x-forwarded-proto": "http",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        edge: { host: "investors.acme.com", clientIp: "203.0.113.7" },
        host: "investors.acme.com",
        origin: "https://investors.acme.com",
        secure: true,
      });
    }
    expect(logs).toEqual([]);
  });

  it("valid secret: an invalid or absent client IP is simply not edge-provided", async () => {
    const { app } = build();
    for (const ip of ["garbage", "203.0.113.7:80", "[2001:db8::1]", "1.1.1.1, 2.2.2.2"]) {
      const res = await app.request("http://x.test/facts", {
        headers: edgeHeaders({ [IP_HEADER]: ip }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { edge: unknown }).edge).toEqual({
        host: "investors.acme.com",
      });
    }
    const v6 = await app.request("http://x.test/facts", {
      headers: edgeHeaders({ [IP_HEADER]: "2001:db8::7" }),
    });
    expect(((await v6.json()) as { edge: unknown }).edge).toEqual({
      host: "investors.acme.com",
      clientIp: "2001:db8::7",
    });
    // No FORWARDED_CLIENT_IP_HEADER configured: the header is never read.
    const noIp = build({ clientIpHeader: undefined }).app;
    const res = await noIp.request("http://x.test/facts", { headers: edgeHeaders() });
    expect(((await res.json()) as { edge: unknown }).edge).toEqual({ host: "investors.acme.com" });
  });

  it("valid secret with a missing or invalid forwarded host: 400 invalid_request", async () => {
    const { app, logs, refusals } = build();
    const missing = edgeHeaders();
    delete missing[HOST_HEADER];
    const cases: [Record<string, string>, string][] = [
      [missing, "missing"],
      [edgeHeaders({ [HOST_HEADER]: "investors.acme.com:443" }), "invalid"],
      [edgeHeaders({ [HOST_HEADER]: "a.test, b.test" }), "invalid"],
      [edgeHeaders({ [HOST_HEADER]: "investors.acme.com." }), "invalid"],
    ];
    for (const [headers] of cases) {
      const res = await app.request("http://x.test/facts", { headers });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "the edge sent no valid forwarded host",
          requestId: "req-1",
        },
      });
    }
    expect(logs.map((l) => [l.event, l.fields?.["reason"]])).toEqual(
      cases.map(([, reason]) => ["http.edge_forwarded_host_invalid", reason]),
    );
    expect(logs[0]?.fields).toMatchObject({ method: "GET", path: "/facts" });
    expect(refusals).toEqual(cases.map(([, reason]) => ["invalid_request", reason]));
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain("acme");
  });

  it("appends the forwarded-host header to Vary on edge-forwarded responses only", async () => {
    const { app } = build();
    const plain = await app.request("http://x.test/facts", { headers: edgeHeaders() });
    expect(plain.headers.get("vary")).toBe(HOST_HEADER);
    const varied = await app.request("http://x.test/varied", { headers: edgeHeaders() });
    expect(varied.headers.get("vary")).toBe(`Cookie, ${HOST_HEADER}`);
    const star = await app.request("http://x.test/star", { headers: edgeHeaders() });
    expect(star.headers.get("vary")).toBe("*");
    const direct = await app.request("http://x.test/varied");
    expect(direct.headers.get("vary")).toBe("Cookie");
  });

  it("the security headers see the customer host and https (HSTS, Reporting-Endpoints)", async () => {
    const app = new Hono<EdgeEnv>();
    app.use("*", edgeForwarding({ hostHeader: HOST_HEADER, secret: SECRET }));
    app.use(
      "*",
      securityHeaders({
        profile: () => "app",
        robots: "noindex",
        trustProxy: false,
        hsts: { enabled: true, includeSubDomains: true, canonicalHost: "app.fundroom.test" },
        cspReportUri: () => "/csp-report",
      }) as never,
    );
    app.get("*", (c) => c.text("ok"));
    const res = await app.request("http://app.up.railway.test/", { headers: edgeHeaders() });
    expect(res.status).toBe(200);
    // A custom domain (not under the canonical host): plain max-age, no includeSubDomains.
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000");
    expect(res.headers.get("reporting-endpoints")).toBe(
      'csp="https://investors.acme.com/csp-report"',
    );
    // Without the secret the same request is plain http on the platform host: no HSTS.
    const headers = edgeHeaders();
    delete headers[EDGE_SECRET_HEADER];
    const direct = await app.request("http://app.up.railway.test/", { headers });
    expect(direct.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("the accepted secret is removed from the request (L10)", () => {
  function echoApp(before?: Parameters<Hono<EdgeEnv>["use"]>[1]) {
    const app = new Hono<EdgeEnv>();
    if (before !== undefined) app.use("*", before);
    app.use("*", edgeForwarding({ hostHeader: HOST_HEADER, secret: SECRET }));
    // Downstream of the edge: a body limit that may replace c.req.raw, then the handler.
    app.use("*", bodyLimit({ maxSize: 1024 }));
    app.all("*", async (c) => {
      const all = c.req.header();
      // What a webhook adapter would get: a fresh Request over c.req.raw's headers.
      const adapterCopy = new Request(c.req.url, { method: "GET", headers: c.req.raw.headers });
      return c.json({
        one: c.req.header(EDGE_SECRET_HEADER) ?? null,
        raw: c.req.raw.headers.get(EDGE_SECRET_HEADER),
        names: Object.keys(all),
        entries: [...c.req.raw.headers].some(([, v]) => v.includes(SECRET)),
        adapter: adapterCopy.headers.has(EDGE_SECRET_HEADER),
        forwardedHost: c.req.header(HOST_HEADER) ?? null,
        body: c.req.method === "POST" ? await c.req.json() : null,
      });
    });
    return app;
  }

  const expectClean = (got: Record<string, unknown>) => {
    expect(got).toMatchObject({ one: null, raw: null, entries: false, adapter: false });
    expect(got["names"]).not.toContain(EDGE_SECRET_HEADER);
    // The forwarded host/IP headers are harmless and stay.
    expect(got["forwardedHost"]).toBe("Investors.Acme.com");
  };

  it("a GET handler sees no secret in c.req.header(), c.req.raw.headers or a copy of them", async () => {
    const res = await echoApp().request("http://x.test/", { headers: edgeHeaders() });
    expect(res.status).toBe(200);
    expectClean((await res.json()) as Record<string, unknown>);
  });

  it("a body-reading POST still reads its body, with or without a content length", async () => {
    const payload = { hello: "world", n: 1 };
    const sized = await echoApp().request("http://x.test/hook", {
      method: "POST",
      headers: edgeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    expect(sized.status).toBe(200);
    const got = (await sized.json()) as Record<string, unknown>;
    expectClean(got);
    expect(got["body"]).toEqual(payload);
    // A streamed body (no content-length): body-limit reads it and replaces c.req.raw.
    const streamed = await echoApp().request("http://x.test/hook", {
      method: "POST",
      headers: edgeHeaders({ "content-type": "application/json" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(200);
    const s2 = (await streamed.json()) as Record<string, unknown>;
    expectClean(s2);
    expect(s2["body"]).toEqual(payload);
  });

  it("immutable headers: the Request is replaced by a copy without the header, body intact", async () => {
    // A runtime whose request headers refuse `delete` (guard "immutable").
    const freeze: Parameters<Hono<EdgeEnv>["use"]>[1] = async (c, next) => {
      Object.defineProperty(c.req.raw.headers, "delete", {
        value: () => {
          throw new TypeError("immutable");
        },
      });
      await next();
    };
    const payload = { a: [1, 2, 3] };
    const res = await echoApp(freeze).request("http://x.test/hook", {
      method: "POST",
      headers: edgeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const got = (await res.json()) as Record<string, unknown>;
    expectClean(got);
    expect(got["body"]).toEqual(payload);
  });

  it("an ordinary request is left as it was, and a refused one never reaches a handler", async () => {
    let reached = 0;
    const app = new Hono<EdgeEnv>();
    app.use("*", edgeForwarding({ hostHeader: HOST_HEADER, secret: SECRET }));
    app.get("*", (c) => {
      reached += 1;
      return c.text(c.req.header(EDGE_SECRET_HEADER) ?? "none");
    });
    // No secret header at all: nothing to strip, nothing changed.
    expect(await (await app.request("http://x.test/")).text()).toBe("none");
    expect(reached).toBe(1);
    // A wrong secret: refused before any handler (so no handler can see the presented value).
    const wrong = "wrong-0123456789abcdef0123456789abcdef";
    const refused = await app.request("http://x.test/", {
      headers: edgeHeaders({ [EDGE_SECRET_HEADER]: wrong }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(wrong);
    // A matching secret with a bad host: also refused before any handler.
    const badHost = await app.request("http://x.test/", {
      headers: edgeHeaders({ [HOST_HEADER]: "a.test:8443" }),
    });
    expect(badHost.status).toBe(400);
    expect(reached).toBe(1);
  });

  it("stripEdgeSecret is a no-op without the header", async () => {
    const app = new Hono();
    app.get("*", (c) => {
      const before = c.req.raw;
      stripEdgeSecret(c);
      return c.text(String(c.req.raw === before));
    });
    expect(await (await app.request("http://x.test/")).text()).toBe("true");
  });
});
