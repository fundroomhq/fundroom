import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildCsp, frameAncestorsSources } from "./csp.js";
import { isLocalOrIpHost, isSecureRequest, requestOrigin } from "./request.js";
import {
  cspNonceOf,
  type HeaderProfile,
  PERMISSIONS_POLICY,
  type SecurityHeadersEnv,
  type SecurityHeadersOptions,
  securityHeaders,
} from "./security-headers.js";

function profileByPath(c: { req: { path: string } }): HeaderProfile {
  const p = c.req.path;
  if (p.startsWith("/admin")) return "admin";
  if (p.startsWith("/embed")) return "embed";
  if (p.startsWith("/api")) return "api";
  if (p.startsWith("/assets")) return "asset";
  return "app";
}

function build(overrides: Partial<SecurityHeadersOptions> = {}) {
  const app = new Hono<SecurityHeadersEnv>();
  app.use(
    "*",
    securityHeaders({
      profile: profileByPath,
      robots: "noindex",
      trustProxy: false,
      hsts: { enabled: true },
      frameAncestors: () => ["https://acme.com", "https://www.acme.com"],
      ...overrides,
    }),
  );
  app.get("/nonce", (c) => c.text(cspNonceOf(c) ?? ""));
  app.get("/cached", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.text("x");
  });
  app.get("/auth/popup", (c) => c.text("popup"));
  app.get("/api/chart.png", (c) => {
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    return c.body("png");
  });
  app.get("/api/handoff", (c) => {
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'nonce-x'");
    return c.html("<p>page</p>");
  });
  app.get("/api/json-own-csp", (c) => {
    c.header("Content-Security-Policy", "default-src *");
    return c.json({ ok: true });
  });
  app.get("*", (c) => c.text("ok"));
  return app;
}

const COMMON: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-permitted-cross-domain-policies": "none",
  "x-dns-prefetch-control": "off",
  "origin-agent-cluster": "?1",
  "permissions-policy": PERMISSIONS_POLICY,
};

function expectCommon(res: Response): void {
  for (const [k, v] of Object.entries(COMMON)) expect(res.headers.get(k)).toBe(v);
}

describe("securityHeaders profiles", () => {
  it("app: strict nonce CSP, DENY, same-origin COOP, same-origin CORP, no-store", async () => {
    const res = await build().request("http://portal.test/");
    expectCommon(res);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(
      /^default-src 'self'; script-src 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic' 'unsafe-inline' https: http:; style-src 'self' 'nonce-[A-Za-z0-9+/=]+'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard$/u,
    );
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("reporting-endpoints")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    // E2.10 ZAP-02: same-site would let sibling tenant subdomains load the shell no-cors.
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("strict-transport-security")).toBeNull(); // http
  });

  it("app honours ROBOTS=index; admin never does", async () => {
    const app = build({ robots: "index" });
    expect((await app.request("http://portal.test/")).headers.get("x-robots-tag")).toBe(
      "index, follow",
    );
    expect((await app.request("http://portal.test/admin/x")).headers.get("x-robots-tag")).toBe(
      "noindex, nofollow",
    );
    expect((await app.request("http://portal.test/assets/a.js")).headers.get("x-robots-tag")).toBe(
      "index, follow",
    );
  });

  it("admin: same as app but always noindex and never framed", async () => {
    const res = await build().request("http://portal.test/admin/dashboard");
    expectCommon(res);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("worker-src 'none'");
  });

  it("embed: frame-ancestors from the resolver, no X-Frame-Options, no COOP, no-referrer", async () => {
    const res = await build().request("http://portal.test/embed/acme");
    expectCommon(res);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors https://acme.com https://www.acme.com");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("worker-src 'none'");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("embed: an empty allow-list means 'none'; an async resolver works", async () => {
    const app = build({ frameAncestors: async () => [] });
    const res = await app.request("http://portal.test/embed/acme");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const none = build({ frameAncestors: undefined });
    expect(
      (await none.request("http://portal.test/embed/acme")).headers.get("content-security-policy"),
    ).toContain("frame-ancestors 'none'");
  });

  it("api: default-src 'none', same-origin CORP, no-referrer, no-store", async () => {
    const res = await build().request("http://portal.test/api/v1/modules");
    expectCommon(res);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("asset: no CSP, cross-origin CORP, cache left to the handler", async () => {
    const res = await build().request("http://portal.test/assets/embed.js");
    expectCommon(res);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("securityHeaders details", () => {
  it("an api handler's own CSP survives only on an HTML document it serves (E3.7)", async () => {
    const app = build();
    const own = await app.request("http://portal.test/api/handoff");
    expect(own.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'nonce-x'",
    );
    const json = await app.request("http://portal.test/api/json-own-csp");
    expect(json.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    const plain = await app.request("http://portal.test/api/anything");
    expect(plain.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("nonce differs per request and matches c.get('cspNonce')", async () => {
    const app = build();
    const r1 = await app.request("http://portal.test/nonce");
    const r2 = await app.request("http://portal.test/nonce");
    const n1 = await r1.text();
    const n2 = await r2.text();
    expect(n1).not.toBe(n2);
    expect(Buffer.from(n1, "base64").length).toBe(16);
    expect(r1.headers.get("content-security-policy")).toContain(`'nonce-${n1}'`);
    expect(r1.headers.get("content-security-policy")).toContain(`style-src 'self' 'nonce-${n1}'`);
    expect(r2.headers.get("content-security-policy")).toContain(`'nonce-${n2}'`);
  });

  it("Trusted Types are enforced on every document profile by default, with or without a report URI (E3.2)", async () => {
    const TT = "require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard";
    for (const app of [build(), build({ cspReportUri: "/csp-report" })]) {
      for (const path of ["/", "/w/acme", "/admin/people", "/embed/acme"]) {
        const res = await app.request(`http://portal.test${path}`);
        expect(res.headers.get("content-security-policy"), path).toContain(TT);
        expect(res.headers.get("content-security-policy-report-only"), path).toBeNull();
      }
      for (const path of ["/api/x", "/assets/app.js"]) {
        const res = await app.request(`http://portal.test${path}`);
        expect(res.headers.get("content-security-policy") ?? "", path).not.toMatch(
          /trusted-types/u,
        );
        expect(res.headers.get("content-security-policy-report-only"), path).toBeNull();
      }
    }
    // `report` (the rollback switch) moves the directives out of the enforced policy.
    const report = await build({ trustedTypes: "report", cspReportUri: "/csp-report" }).request(
      "http://portal.test/admin",
    );
    expect(report.headers.get("content-security-policy")).not.toMatch(/trusted-types/u);
    expect(report.headers.get("content-security-policy-report-only")).toContain(TT);
    // Nowhere to report to: report mode sends nothing rather than a policy nobody reads.
    const silent = await build({ trustedTypes: "report" }).request("http://portal.test/");
    expect(silent.headers.get("content-security-policy")).not.toMatch(/trusted-types/u);
    expect(silent.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("reporting: report-uri/report-to in CSP, Trusted Types report-only, Reporting-Endpoints", async () => {
    const app = build({ cspReportUri: "/csp-report", trustedTypes: "report" });
    const res = await app.request("http://portal.test/");
    expect(res.headers.get("content-security-policy")).toMatch(
      /; report-uri \/csp-report; report-to csp$/u,
    );
    expect(res.headers.get("content-security-policy-report-only")).toBe(
      "require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard; report-uri /csp-report; report-to csp",
    );
    // Report-only stays report-only: nothing about Trusted Types in the enforced policy.
    expect(res.headers.get("content-security-policy")).not.toMatch(/trusted-types/u);
    // …and the enforced style-src stays strict (E2.10 fixed the injectors instead).
    expect(res.headers.get("content-security-policy")).not.toMatch(
      /style-src[^;]*'unsafe-inline'/u,
    );
    // The Reporting API ignores a relative or non-secure endpoint: absolute, on the request's own
    // origin, and left out entirely over plain http to a non-loopback host.
    expect(res.headers.get("reporting-endpoints")).toBeNull();
    const secure = await app.request("https://portal.test/w/acme");
    expect(secure.headers.get("reporting-endpoints")).toBe('csp="https://portal.test/csp-report"');
    const custom = await build({ cspReportUri: "/investors/csp-report", trustProxy: true }).request(
      "http://internal:3000/",
      { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "ir.acme.com" } },
    );
    expect(custom.headers.get("reporting-endpoints")).toBe(
      'csp="https://ir.acme.com/investors/csp-report"',
    );
    expect(custom.headers.get("content-security-policy")).toContain(
      "report-uri /investors/csp-report",
    );
    const dev = await app.request("http://localhost:3000/");
    expect(dev.headers.get("reporting-endpoints")).toBe('csp="http://localhost:3000/csp-report"');
    const absolute = await build({ cspReportUri: "https://collector.test/r" }).request(
      "http://portal.test/",
    );
    expect(absolute.headers.get("reporting-endpoints")).toBe('csp="https://collector.test/r"');
    const api = await app.request("http://portal.test/api/x");
    expect(api.headers.get("content-security-policy-report-only")).toBeNull();
    // A Host the header cannot carry is not reflected, and 127.<name> is not loopback.
    const quoted = await build({ cspReportUri: "/csp-report", trustProxy: true }).request(
      "http://internal:3000/",
      { headers: { "x-forwarded-proto": "https", "x-forwarded-host": 'evil.com"x' } },
    );
    expect(quoted.headers.get("reporting-endpoints")).toBeNull();
    const fakeLoopback = await app.request("http://127.evil.com/");
    expect(fakeLoopback.headers.get("reporting-endpoints")).toBeNull();
    const loopback = await app.request("http://127.0.0.1:3000/");
    expect(loopback.headers.get("reporting-endpoints")).toBe(
      'csp="http://127.0.0.1:3000/csp-report"',
    );
  });

  it("reporting: a per-request report URI (E3.9 path mounts) is resolved once per document", async () => {
    const seen: string[] = [];
    const app = build({
      trustedTypes: "report",
      cspReportUri: (c) => {
        seen.push(c.req.path);
        return c.req.header("x-test-report") ?? "https://acme.com/investors/csp-report";
      },
    });
    const res = await app.request("https://portal.test/investors/home");
    expect(res.headers.get("content-security-policy")).toContain(
      "report-uri https://acme.com/investors/csp-report; report-to csp",
    );
    expect(res.headers.get("content-security-policy-report-only")).toContain(
      "report-uri https://acme.com/investors/csp-report",
    );
    expect(res.headers.get("reporting-endpoints")).toBe(
      'csp="https://acme.com/investors/csp-report"',
    );
    expect(seen).toEqual(["/investors/home"]);
    // Not consulted for API / asset responses.
    await app.request("https://portal.test/api/x");
    await app.request("https://portal.test/assets/a.js");
    expect(seen).toEqual(["/investors/home"]);
    // An answer that could forge a directive or a quoted header value means "no report URI".
    for (const bad of ['https://a.test/r"x', "https://a.test/r;x", "https://a.test/r,x", "/r x"]) {
      const r = await app.request("https://portal.test/", { headers: { "x-test-report": bad } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).not.toMatch(/report-uri/u);
      expect(r.headers.get("content-security-policy-report-only")).toBeNull();
      expect(r.headers.get("reporting-endpoints")).toBeNull();
    }
    const none = build({ cspReportUri: () => undefined });
    const n = await none.request("https://portal.test/");
    expect(n.headers.get("content-security-policy")).not.toMatch(/report-uri/u);
  });

  it("E3.9: omits HSTS on a response the omitHsts callback marks (a mounted request)", async () => {
    const app = build({
      trustProxy: true,
      omitHsts: (c) => c.req.header("x-forwarded-prefix") === "/investors",
    });
    const mounted = await app.request("http://app:3000/investors/x", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "acme.com",
        "x-forwarded-prefix": "/investors",
      },
    });
    expect(mounted.headers.get("strict-transport-security")).toBeNull();
    // Everything else about the response is unchanged.
    expect(mounted.headers.get("x-content-type-options")).toBe("nosniff");
    const direct = await app.request("http://app:3000/investors/x", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "portal.acme.com" },
    });
    expect(direct.headers.get("strict-transport-security")).toMatch(/^max-age=/u);
  });

  it("extra CSP sources are merged in", async () => {
    const app = build({
      csp: {
        connectSrc: ["https://api.test", "wss://api.test"],
        imgSrc: ["https://cdn.test"],
        fontSrc: ["https://fonts.gstatic.com"],
        styleSrc: ["https://fonts.googleapis.com"],
        frameSrc: ["https://cal.com"],
        scriptSrcExtra: ["'sha256-abc'"],
      },
    });
    const csp = (await app.request("http://portal.test/")).headers.get("content-security-policy");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("'strict-dynamic' 'sha256-abc' 'unsafe-inline' https: http:");
    expect(csp).toContain("connect-src 'self' https://api.test wss://api.test");
    expect(csp).toContain("img-src 'self' data: blob: https://cdn.test");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("style-src 'self' 'nonce-");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("frame-src https://cal.com");
  });

  it("Permissions-Policy delegates passkeys to our own origin and nothing else", async () => {
    // E2.2: a host page that opts in with `allow="publickey-credentials-get"` on the frame can
    // offer a passkey inside the embed. `(self)` is the framed document's own origin, so the
    // delegation stays the host's decision; every other feature is still `()`.
    const embed = await build().request("http://portal.test/embed/acme");
    expect(embed.headers.get("permissions-policy")).toContain("publickey-credentials-get=(self)");
    expect(embed.headers.get("permissions-policy")).toContain("camera=()");
    expect(embed.headers.get("permissions-policy")).not.toContain("publickey-credentials-get=*");
  });

  it("a handler's Cache-Control wins", async () => {
    const res = await build().request("http://portal.test/cached");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("popup auth paths get same-origin-allow-popups", async () => {
    const app = build({ popupAuthPaths: ["/auth/popup"] });
    expect(
      (await app.request("http://portal.test/auth/popup")).headers.get(
        "cross-origin-opener-policy",
      ),
    ).toBe("same-origin-allow-popups");
    expect(
      (await app.request("http://portal.test/auth/other")).headers.get(
        "cross-origin-opener-policy",
      ),
    ).toBe("same-origin");
  });

  it("keeps a CORP the handler set (email chart images are loaded cross-site)", async () => {
    const app = build();
    const chart = await app.request("https://portal.test/api/chart.png");
    expect(chart.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const api = await app.request("https://portal.test/api/other");
    expect(api.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  describe("HSTS", () => {
    it("is sent on direct https with the default max-age", async () => {
      const res = await build().request("https://portal.test/");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000");
      expect(res.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    });
    it("preload adds includeSubDomains; preload, max-age configurable", async () => {
      const app = build({ hsts: { enabled: true, preload: true, maxAgeSeconds: 31536000 } });
      expect(
        (await app.request("https://portal.test/")).headers.get("strict-transport-security"),
      ).toBe("max-age=31536000; includeSubDomains; preload");
    });
    it("includeSubDomains without preload (E2.10 F-15)", async () => {
      const app = build({ hsts: { enabled: true, includeSubDomains: true } });
      expect(
        (await app.request("https://portal.test/")).headers.get("strict-transport-security"),
      ).toBe("max-age=63072000; includeSubDomains");
      const both = build({ hsts: { enabled: true, includeSubDomains: false, preload: true } });
      expect(
        (await both.request("https://portal.test/")).headers.get("strict-transport-security"),
      ).toBe("max-age=63072000; includeSubDomains; preload");
    });
    it("R2-02: includeSubDomains/preload only on the canonical host and its subdomains", async () => {
      const hstsOf = async (hsts: SecurityHeadersOptions["hsts"], url: string) =>
        (await build({ hsts }).request(url)).headers.get("strict-transport-security");
      const sub = { enabled: true, includeSubDomains: true, canonicalHost: "portal.test" };
      expect(await hstsOf(sub, "https://portal.test/")).toBe("max-age=63072000; includeSubDomains");
      expect(await hstsOf(sub, "https://acme.portal.test/")).toBe(
        "max-age=63072000; includeSubDomains",
      );
      // A workspace's custom domain, possibly the customer's zone apex: never pin its subdomains.
      expect(await hstsOf(sub, "https://acme.com/")).toBe("max-age=63072000");
      expect(await hstsOf(sub, "https://evilportal.test/")).toBe("max-age=63072000");
      const preload = { ...sub, preload: true, canonicalHost: "portal.test:8443" };
      expect(await hstsOf(preload, "https://portal.test:8443/")).toBe(
        "max-age=63072000; includeSubDomains; preload",
      );
      expect(await hstsOf(preload, "https://investors.acme.com/")).toBe("max-age=63072000");
    });
    it("honours X-Forwarded-Proto only with trustProxy", async () => {
      const headers = { "x-forwarded-proto": "https" };
      const untrusted = await build().request("http://portal.test/", { headers });
      expect(untrusted.headers.get("strict-transport-security")).toBeNull();
      const trusted = await build({ trustProxy: true }).request("http://portal.test/", { headers });
      expect(trusted.headers.get("strict-transport-security")).toBe("max-age=63072000");
      const downgraded = await build({ trustProxy: true }).request("https://portal.test/", {
        headers: { "x-forwarded-proto": "http" },
      });
      expect(downgraded.headers.get("strict-transport-security")).toBeNull();
    });
    it("is never sent for localhost or IP hosts, or when disabled", async () => {
      expect(
        (await build().request("https://localhost:3000/")).headers.get("strict-transport-security"),
      ).toBeNull();
      expect(
        (await build().request("https://127.0.0.1/")).headers.get("strict-transport-security"),
      ).toBeNull();
      expect(
        (await build().request("https://dev.localhost/")).headers.get("strict-transport-security"),
      ).toBeNull();
      expect(
        (await build({ hsts: { enabled: false } }).request("https://portal.test/")).headers.get(
          "strict-transport-security",
        ),
      ).toBeNull();
      const forwardedHost = await build({ trustProxy: true }).request("https://portal.test/", {
        headers: { "x-forwarded-host": "localhost" },
      });
      expect(forwardedHost.headers.get("strict-transport-security")).toBeNull();
    });
  });
});

describe("buildCsp", () => {
  it("keeps insertion order, de-duplicates and renders valueless directives", () => {
    expect(
      buildCsp({
        "default-src": ["'self'", "'self'"],
        "upgrade-insecure-requests": true,
        "object-src": ["'none'"],
      }),
    ).toBe("default-src 'self'; upgrade-insecure-requests; object-src 'none'");
  });
  it("rejects directive/source injection", () => {
    expect(() => buildCsp({ "bad name": ["x"] })).toThrow(/directive/u);
    expect(() => buildCsp({ "img-src": ["https://a.test; script-src *"] })).toThrow(/source/u);
    expect(() => buildCsp({ "img-src": [""] })).toThrow(/source/u);
  });
  it("frameAncestorsSources trims and falls back to 'none'", () => {
    expect(frameAncestorsSources([" https://a.test ", ""])).toEqual(["https://a.test"]);
    expect(frameAncestorsSources([])).toEqual(["'none'"]);
  });
});

describe("request helpers", () => {
  const app = new Hono();
  app.get("/o", (c) => {
    const trust = c.req.query("trust") === "1";
    return c.json({
      origin: requestOrigin(c, trust),
      secure: isSecureRequest(c, trust),
    });
  });

  it.each([
    ["http://portal.test/o", {}, false, "http://portal.test", false],
    ["https://portal.test/o", {}, false, "https://portal.test", true],
    ["http://portal.test/o", { "x-forwarded-proto": "https" }, false, "http://portal.test", false],
    ["http://portal.test/o", { "x-forwarded-proto": "https" }, true, "https://portal.test", true],
    [
      "http://internal:3000/o",
      { "x-forwarded-proto": "https", "x-forwarded-host": "Investors.Acme.com" },
      true,
      "https://investors.acme.com",
      true,
    ],
    [
      "http://internal:3000/o",
      // E2.10 F-07: the rightmost entry is the one our proxy wrote; the left is the client's.
      { "x-forwarded-proto": "http, https", "x-forwarded-host": "evil.test, b.test" },
      true,
      "https://b.test",
      true,
    ],
    [
      "http://internal:3000/o",
      { host: "portal.test:8443" },
      false,
      "http://portal.test:8443",
      false,
    ],
  ] as const)("%s %o trust=%s → %s", async (url, headers, trust, origin, secure) => {
    const u = new URL(url);
    u.searchParams.set("trust", trust ? "1" : "0");
    const res = await app.request(u.href, { headers: { ...headers } });
    expect(await res.json()).toEqual({ origin, secure });
  });

  it("isLocalOrIpHost", () => {
    expect(isLocalOrIpHost("localhost")).toBe(true);
    expect(isLocalOrIpHost("LOCALHOST:3000")).toBe(true);
    expect(isLocalOrIpHost("acme.localhost")).toBe(true);
    expect(isLocalOrIpHost("10.0.0.1:8080")).toBe(true);
    expect(isLocalOrIpHost("[::1]:3000")).toBe(true);
    expect(isLocalOrIpHost("investors.acme.com")).toBe(false);
    expect(isLocalOrIpHost("investors.acme.com:8443")).toBe(false);
  });
});
