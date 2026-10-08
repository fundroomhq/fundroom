import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { pathMountResolution } from "../path-mount.js";
import { createReadiness } from "../readiness.js";
import { startTelemetry } from "../telemetry.js";
import {
  CSP_LABEL_SETS_MAX,
  LEGACY_WELL_KNOWN_CAPABILITIES_PATH,
  normalizeCspReports,
  type OpsOptions,
  opsRoutes,
  renderSecurityTxt,
  SECURITY_TXT_DEFAULT_CONTACT,
  SECURITY_TXT_DEFAULT_POLICY,
  WELL_KNOWN_CAPABILITIES_PATH,
} from "./ops.js";

/*
 * The E2.10 ops additions without a database: the CSP report collector (both wire formats,
 * normalisation, the metric, the global log cap) and RFC 9116 security.txt.
 */
const telemetry = startTelemetry({ serviceName: "ops-test", serviceVersion: "0" });
afterAll(() => telemetry.shutdown());

const readiness = createReadiness({
  db: { ping: async () => true, pool: {} } as never,
  storage: { driver: "fs", healthCheck: async () => {} } as never,
  mailer: { driver: "memory", healthCheck: async () => {} } as never,
  queue: { stats: async () => [] } as never,
  renderer: { driver: "pdfium", healthCheck: async () => {} } as never,
  migrationSources: [],
});

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function build(over: Partial<OpsOptions> = {}) {
  const logged: Record<string, unknown>[] = [];
  const app = new Hono();
  app.route(
    "/",
    opsRoutes({
      readiness,
      telemetry,
      metricsEnabled: true,
      metricsToken: undefined,
      tenancy: "single",
      features: [],
      authMethods: ["email_otp"],
      passkeyRpId: "localhost",
      basePath: "",
      log: (event, fields) => logged.push({ event, ...fields }),
      startedAt: NOW,
      canonicalHost: "portal.test",
      issuable: async () => false,
      now: () => NOW,
      ...over,
    }),
  );
  return { app, logged };
}

const legacy = (report: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/csp-report" },
  body: JSON.stringify({ "csp-report": report }),
});

const LEGACY_STYLE = {
  "document-uri":
    "https://portal.test/login/verify?email=ada%40example.com&returnTo=%2Fupdates#frag",
  referrer: "https://portal.test/login",
  "violated-directive": "style-src-elem",
  "effective-directive": "style-src-elem",
  "original-policy": "default-src 'self'; style-src 'self' 'nonce-abc'",
  disposition: "enforce",
  "blocked-uri": "inline",
  "line-number": 2,
  "source-file": "https://portal.test/assets/index-BEkM2Pxi.js?v=1",
  "status-code": 200,
  "script-sample": "",
};

const REPORTING_API = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://portal.test/s/Zm9vYmFyYmF6cXV4cXV1eHF1dXg",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://portal.test/s/Zm9vYmFyYmF6cXV4cXV1eHF1dXg?x=1",
      blockedURL: "https://evil.example/steal.js?sid=secret#x",
      effectiveDirective: "script-src-elem",
      originalPolicy: "script-src 'nonce-abc'",
      sourceFile: "https://portal.test/assets/api-CRRJtkmQ.js",
      sample: "",
      disposition: "enforce",
      statusCode: 200,
      lineNumber: 1,
      columnNumber: 1,
    },
  },
  {
    type: "csp-violation",
    url: "https://portal.test/admin/updates/0b5f0c3e-8d4c-4a45-9d7b-5c7d3a1f2e10",
    body: {
      documentURL: "https://portal.test/admin/updates/0b5f0c3e-8d4c-4a45-9d7b-5c7d3a1f2e10",
      blockedURL: "trusted-types-sink",
      effectiveDirective: "require-trusted-types-for",
      sourceFile: "https://portal.test/assets/admin-BJ8jh2Bo.js",
      sample: "Element innerHTML|<p>Quarterly numbers for ada@example.com</p>",
      disposition: "report",
    },
  },
  { type: "deprecation", url: "https://portal.test/", body: { id: "x" } },
];

describe("normalizeCspReports", () => {
  it("legacy application/csp-report: path only, no query, no fragment, script without query", () => {
    expect(normalizeCspReports({ "csp-report": LEGACY_STYLE })).toEqual([
      {
        directive: "style-src-elem",
        blockedURI: "inline",
        documentURI: "/login/verify",
        sourceFile: "https://portal.test/assets/index-BEkM2Pxi.js",
        disposition: "enforce",
      },
    ]);
  });

  it("Reporting API application/reports+json: csp-violation entries only, identifiers redacted", () => {
    expect(normalizeCspReports(REPORTING_API)).toEqual([
      {
        directive: "script-src-elem",
        blockedURI: "https://evil.example/steal.js",
        documentURI: "/s/:id",
        sourceFile: "https://portal.test/assets/api-CRRJtkmQ.js",
        disposition: "enforce",
      },
      {
        directive: "require-trusted-types-for",
        blockedURI: "trusted-types-sink",
        documentURI: "/admin/updates/:id",
        sourceFile: "https://portal.test/assets/admin-BJ8jh2Bo.js",
        disposition: "report",
        // The sink, never the value that was assigned to it.
        trustedTypes: "Element innerHTML",
      },
    ]);
  });

  it("drops the unparseable and bounds the untrusted", () => {
    expect(normalizeCspReports("nope")).toEqual([]);
    expect(normalizeCspReports({ other: 1 })).toEqual([]);
    const [odd] = normalizeCspReports({
      "csp-report": {
        "effective-directive": "style-src; injected",
        "blocked-uri": "data:text/css,body{}",
        "document-uri": "not a url",
        disposition: "whatever",
        "source-file": "chrome-extension://abc/content.js",
      },
    });
    expect(odd).toEqual({
      directive: "unknown",
      blockedURI: "data",
      documentURI: "invalid",
      sourceFile: "chrome-extension",
      disposition: "unknown",
    });
    const many = Array.from({ length: 100 }, () => REPORTING_API[0]);
    expect(normalizeCspReports(many)).toHaveLength(20);
    const [email] = normalizeCspReports({
      "csp-report": { "document-uri": "https://portal.test/people/ada%40example.com/edit" },
    });
    expect(email?.documentURI).toBe("/people/:id/edit");
  });
});

describe("POST /csp-report", () => {
  it("accepts both content types, logs only normalised fields, counts per directive/origin", async () => {
    const { app, logged } = build();
    expect((await app.request("/csp-report", legacy(LEGACY_STYLE))).status).toBe(204);
    const batch = await app.request("/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify(REPORTING_API),
    });
    expect(batch.status).toBe(204);
    expect(logged.map((l) => l["event"])).toEqual(["csp.report", "csp.report", "csp.report"]);
    const text = JSON.stringify(logged);
    for (const secret of ["ada", "returnTo", "secret", "Zm9vYmFy", "Quarterly", "frag"]) {
      expect(text).not.toContain(secret);
    }

    const metrics = await (await app.request("/metrics")).text();
    expect(metrics).toMatch(
      /fundroom_csp_violations_total\{[^}]*directive="style-src-elem"[^}]*blocked="inline"[^}]*\} \d+/u,
    );
    expect(metrics).toMatch(
      /fundroom_csp_violations_total\{[^}]*directive="script-src-elem"[^}]*blocked="https:\/\/evil.example"[^}]*\}/u,
    );
    // A-2: the series and its meter scope carry the FundRoom name only.
    expect(metrics).toMatch(/otel_scope_name="fundroom\.csp"/u);
    expect(metrics).not.toMatch(/seed_?host/iu);
  });

  it("answers 204 to garbage and 413 to an oversized body", async () => {
    const { app, logged } = build();
    const junk = await app.request("/csp-report", { method: "POST", body: "{not json" });
    expect(junk.status).toBe(204);
    expect(logged).toEqual([]);
    const big = await app.request("/csp-report", {
      method: "POST",
      headers: { "content-length": String(64 * 1024) },
      body: "x",
    });
    expect(big.status).toBe(413);
  });

  it("refuses a chunked body past 16 KiB without reading it all (no Content-Length)", async () => {
    const { app, logged } = build();
    const chunk = new TextEncoder().encode(`[${" ".repeat(4094)}`);
    let pulled = 0;
    // Endless unless someone stops reading: a collector that buffers first never returns.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 8 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json", "transfer-encoding": "chunked" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(64 * 1024);
    expect(logged).toEqual([]);
  });

  it("caps log lines globally, whatever X-Forwarded-For says, and keeps counting", async () => {
    const { app, logged } = build();
    for (let i = 0; i < 80; i++) {
      await app.request("/csp-report", {
        ...legacy({ ...LEGACY_STYLE, "blocked-uri": `https://cdn${i % 3}.example/x.css` }),
        headers: {
          "content-type": "application/csp-report",
          "x-forwarded-for": `10.0.0.${i}`,
        },
      });
    }
    expect(logged.length).toBeLessThanOrEqual(60);
    const metrics = await (await app.request("/metrics")).text();
    expect(metrics).toContain('blocked="https://cdn2.example"');
  });

  it("bounds metric cardinality: past the label-set budget everything is `other`", async () => {
    const { app } = build();
    for (let i = 0; i < CSP_LABEL_SETS_MAX + 5; i++) {
      await app.request(
        "/csp-report",
        legacy({ ...LEGACY_STYLE, "blocked-uri": `https://spray${i}.example/` }),
      );
    }
    const metrics = await (await app.request("/metrics")).text();
    expect(metrics).toMatch(
      /directive="other"[^}]*blocked="other"|blocked="other"[^}]*directive="other"/u,
    );
    expect(metrics).not.toContain(`spray${CSP_LABEL_SETS_MAX + 4}.example`);
  });
});

describe("GET /.well-known/fundroom.json (and the pre-rename seed-host.json, A-2)", () => {
  it("serves the same capability document on both paths", async () => {
    expect(WELL_KNOWN_CAPABILITIES_PATH).toBe("/.well-known/fundroom.json");
    expect(LEGACY_WELL_KNOWN_CAPABILITIES_PATH).toBe("/.well-known/seed-host.json");
    const { app } = build({ features: ["access"] });
    const current = await app.request("https://portal.test/.well-known/fundroom.json");
    const legacy = await app.request("https://portal.test/.well-known/seed-host.json");
    expect(current.status).toBe(200);
    expect(legacy.status).toBe(200);
    const body = await current.json();
    expect(body).toMatchObject({ apiVersion: "v1", apiBase: "/api/v1", features: ["access"] });
    expect(await legacy.json()).toEqual(body);
    for (const res of [current, legacy]) {
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("vary")).toContain("X-Forwarded-Prefix");
    }
    expect((await app.request("https://portal.test/.well-known/fundroom")).status).toBe(404);
  });
});

describe("GET /.well-known/security.txt", () => {
  const baseUrl = new URL("https://investors.acme.test");

  it("serves RFC 9116 fields with the project defaults", async () => {
    const { app } = build({ securityTxt: { enabled: true, baseUrl } });
    const res = await app.request("https://investors.acme.test/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(await res.text()).toBe(
      [
        `Contact: ${SECURITY_TXT_DEFAULT_CONTACT[0]}`,
        `Contact: ${SECURITY_TXT_DEFAULT_CONTACT[1]}`,
        "Expires: 2027-03-22T12:00:00Z",
        `Policy: ${SECURITY_TXT_DEFAULT_POLICY}`,
        "Preferred-Languages: en",
        "Canonical: https://investors.acme.test/.well-known/security.txt",
        "",
      ].join("\n"),
    );
  });

  it("uses the operator's contacts and policy, and BASE_PATH in Canonical", () => {
    const body = renderSecurityTxt(
      {
        enabled: true,
        baseUrl: new URL("https://example.org/investors"),
        contact: ["mailto:sec@example.org"],
        policy: "https://example.org/disclosure",
      },
      NOW,
    );
    expect(body).toContain("Contact: mailto:sec@example.org\n");
    expect(body).not.toContain("security@fundroom.com");
    expect(body).toContain("Policy: https://example.org/disclosure\n");
    expect(body).toContain("Canonical: https://example.org/investors/.well-known/security.txt\n");
  });

  it("R2-09: omits Canonical off the canonical host (a workspace's custom domain)", async () => {
    const { app } = build({ securityTxt: { enabled: true, baseUrl } });
    const custom = await (
      await app.request("https://ir.customer.test/.well-known/security.txt")
    ).text();
    expect(custom).toContain("Contact: ");
    expect(custom).not.toContain("Canonical:");
    const own = await (
      await app.request("https://investors.acme.test:443/.well-known/security.txt")
    ).text();
    expect(own).toContain("Canonical: https://investors.acme.test/.well-known/security.txt");
    // Behind a trusted proxy the host comes from X-Forwarded-Host.
    const proxied = build({ securityTxt: { enabled: true, baseUrl, trustProxy: true } }).app;
    const viaProxy = await proxied.request("http://app:3000/.well-known/security.txt", {
      headers: { "x-forwarded-host": "investors.acme.test" },
    });
    expect(await viaProxy.text()).toContain("Canonical: ");
  });

  it("Expires rolls forward with the clock", () => {
    const later = renderSecurityTxt({ enabled: true, baseUrl }, NOW + 86_400_000);
    expect(later).toContain("Expires: 2027-03-23T12:00:00Z");
  });

  it("404s when SECURITY_TXT=false or not configured", async () => {
    const off = build({ securityTxt: { enabled: false, baseUrl } }).app;
    expect((await off.request("/.well-known/security.txt")).status).toBe(404);
    expect((await off.request("/security.txt")).status).toBe(404);
    expect((await build().app.request("/.well-known/security.txt")).status).toBe(404);
  });

  it("redirects the legacy /security.txt to the well-known path (under BASE_PATH)", async () => {
    const root = build({ securityTxt: { enabled: true, baseUrl } }).app;
    const res = await root.request("/security.txt");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/security.txt");

    const mounted = new Hono();
    mounted.route(
      "/investors",
      build({
        basePath: "/investors",
        securityTxt: { enabled: true, baseUrl: new URL("https://example.org/investors") },
      }).app,
    );
    const prefixed = await mounted.request("/investors/security.txt");
    expect(prefixed.status).toBe(301);
    expect(prefixed.headers.get("location")).toBe("/investors/.well-known/security.txt");
    const followed = await mounted.request(
      "https://example.org/investors/.well-known/security.txt",
    );
    expect(await followed.text()).toContain(
      "Canonical: https://example.org/investors/.well-known/security.txt",
    );
  });
});

describe("E3.9 path mounts", () => {
  /** The ops routes behind `pathMountResolution`, as `app.ts` mounts them under BASE_PATH. */
  function mounted(basePath: string, baseUrl: URL) {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      pathMountResolution({
        mounts: [
          { origin: "https://acme.com", prefix: "/investors" },
          { origin: "https://caddy.test", prefix: "/portal" },
        ],
        basePath,
        trustProxy: false,
      }),
    );
    app.route(basePath || "/", build({ basePath, securityTxt: { enabled: true, baseUrl } }).app);
    return app;
  }
  const xfp = (prefix: string) => ({ headers: { "x-forwarded-prefix": prefix } });

  it("the capability doc's apiBase is the public base, and varies by X-Forwarded-Prefix", async () => {
    const app = mounted("/investors", new URL("https://portal.test/investors"));
    const direct = await app.request("https://portal.test/investors/.well-known/fundroom.json");
    expect(await direct.json()).toMatchObject({ apiBase: "/investors/api/v1" });
    expect(direct.headers.get("vary")).toContain("X-Forwarded-Prefix");
    const replaced = await app.request(
      "https://portal.test/investors/.well-known/fundroom.json",
      xfp("/portal"),
    );
    expect(await replaced.json()).toMatchObject({ apiBase: "/portal/api/v1" });
    // FR1 B3: through a mount it is private (a host CDN may ignore Vary); direct stays public.
    expect(replaced.headers.get("cache-control")).toBe("private, no-store");
    expect(direct.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("security.txt's legacy redirect lands under the public base; Canonical is BASE_URL's", async () => {
    const app = mounted("", new URL("https://acme.com/investors"));
    const redirect = await app.request("https://portal.test/security.txt", xfp("/investors"));
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/investors/.well-known/security.txt");
    expect(redirect.headers.get("vary")).toContain("X-Forwarded-Prefix");
    const direct = await app.request("https://portal.test/security.txt");
    expect(direct.headers.get("location")).toBe("/.well-known/security.txt");

    // Fetched through the mount BASE_URL names: Canonical is written, BASE_URL-based.
    const viaMount = await app.request(
      "https://portal.test/.well-known/security.txt",
      xfp("/investors"),
    );
    expect(await viaMount.text()).toContain(
      "Canonical: https://acme.com/investors/.well-known/security.txt\n",
    );
    // The portal's own face is not where Canonical points: omitted (RFC 9116 §2.5.2).
    const own = await app.request("https://portal.test/.well-known/security.txt");
    expect(await own.text()).not.toContain("Canonical:");
  });
});
