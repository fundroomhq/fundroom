import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClassifyOptions, classifyRequest } from "./tenancy.js";
import {
  CONFIG_META_NAME,
  isSourceMapPath,
  loadWebDist,
  renderIndexHtml,
  type WebConfig,
  type WebControlPlaneFacts,
  type WebLinks,
  webConfigFor,
} from "./web.js";

const TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="csp-nonce" nonce="__CSP_NONCE__">
<script type="module" crossorigin src="/assets/index-abc.js" nonce="__CSP_NONCE__"></script>
<link rel="modulepreload" crossorigin href="/assets/react-def.js" nonce="__CSP_NONCE__">
<link rel="stylesheet" crossorigin href="/assets/index-ghi.css" nonce="__CSP_NONCE__">
<link rel="dns-prefetch" href="//fonts.example">
<a href='/portal/already'>x</a>
</head><body><div id="root"></div></body></html>`;

const AUTH = { methods: ["email_otp", "passkey"] as const, passkeyRpId: "portal.example.test" };

function config(over: Partial<WebConfig> = {}): WebConfig {
  return {
    v: 1,
    instanceName: "FundRoom",
    serverVersion: "0.0.0-test",
    tenancy: "single",
    basePath: "",
    routerBase: "",
    apiBase: "",
    tree: "app",
    workspace: null,
    branding: null,
    canonicalOrigin: "https://portal.example.test",
    embedOrigins: [],
    auth: AUTH,
    setupRequired: false,
    workspaceStatus: null,
    centralAuth: null,
    signup: false,
    signupTerms: null,
    links: { terms: null, privacy: null, support: null, status: null },
    controlPlane: false,
    billing: false,
    ai: false,
    ...over,
  };
}

function metaConfig(html: string): WebConfig {
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error("no config meta");
  const json = m[1]
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
  return JSON.parse(json) as WebConfig;
}

describe("renderIndexHtml", () => {
  it("E3.9: prefixes with the request's public base (a mount's), whatever BASE_PATH is", () => {
    const html = renderIndexHtml(TEMPLATE, { nonce: "n", basePath: "/portal", config: config() });
    expect(html).toContain('src="/portal/assets/index-abc.js"');
    expect(html).toContain('href="/portal/assets/react-def.js"');
    expect(html).toContain('href="/portal/favicon.svg"');
    const investors = renderIndexHtml(TEMPLATE, {
      nonce: "n",
      basePath: "/investors",
      config: config(),
    });
    expect(investors).toContain('src="/investors/assets/index-abc.js"');
    expect(investors).not.toContain('"/assets/');
  });

  it("replaces every nonce placeholder", () => {
    const html = renderIndexHtml(TEMPLATE, { nonce: "n0nce", basePath: "", config: config() });
    expect(html).not.toContain("__CSP_NONCE__");
    expect(html.match(/nonce="n0nce"/gu)).toHaveLength(4);
  });

  it("leaves root-relative URLs alone without a base path", () => {
    const html = renderIndexHtml(TEMPLATE, { nonce: "n", basePath: "", config: config() });
    expect(html).toContain('src="/assets/index-abc.js"');
    expect(html).toContain('href="/favicon.svg"');
  });

  it("prefixes root-relative src/href under a base path, not protocol-relative or prefixed ones", () => {
    const html = renderIndexHtml(TEMPLATE, {
      nonce: "n",
      basePath: "/portal",
      config: config({ basePath: "/portal" }),
    });
    expect(html).toContain('src="/portal/assets/index-abc.js"');
    expect(html).toContain('href="/portal/assets/react-def.js"');
    expect(html).toContain('href="/portal/assets/index-ghi.css"');
    expect(html).toContain('href="/portal/favicon.svg"');
    expect(html).toContain('href="//fonts.example"');
    expect(html).toContain("href='/portal/already'");
    expect(html).not.toContain("/portal/portal/");
  });

  it("injects the config meta before </head>, HTML-escaped and inert", () => {
    const hostile = `Acme "</head><script>alert(1)</script>' & <b>`;
    const html = renderIndexHtml(TEMPLATE, {
      nonce: "n",
      basePath: "",
      config: config({ workspace: { slug: "acme", name: hostile } }),
    });
    expect(html.indexOf(`<meta name="${CONFIG_META_NAME}"`)).toBeLessThan(html.indexOf("</head>"));
    // Exactly one closing head and one script element survive.
    expect(html.match(/<\/head>/gu)).toHaveLength(1);
    expect(html.match(/<script/gu)).toHaveLength(1);
    expect(html).not.toContain("alert(1)</script>");
    expect(metaConfig(html).workspace?.name).toBe(hostile);
  });

  it("appends the meta when the template has no </head>", () => {
    const html = renderIndexHtml("<div></div>", { nonce: "n", basePath: "", config: config() });
    expect(html.startsWith("<div></div><meta")).toBe(true);
  });
});

const BASE_URL = new URL("https://portal.example.test");
const acme = { id: "00000000-0000-0000-0000-000000000001", slug: "acme", name: "Acme" };

function derive(input: {
  host: string;
  path: string;
  mode: ClassifyOptions["mode"];
  basePath?: string;
  workspace?: typeof acme | undefined;
  embedOrigins?: string[];
  setupRequired?: boolean;
  /** E3.9: the path mount the request came through (its prefix is the public base). */
  pathMount?: { origin: string; prefix: string };
  controlPlane?: WebControlPlaneFacts;
  links?: WebLinks;
}): WebConfig {
  const basePath = input.basePath ?? "";
  const classification = classifyRequest(
    { host: input.host, path: input.path },
    { mode: input.mode, canonicalHost: "portal.example.test", basePath },
  );
  if (!classification) throw new Error("unclassifiable");
  return webConfigFor({
    classification,
    workspace: input.workspace,
    tenancy: input.mode,
    basePath: input.pathMount?.prefix ?? basePath,
    baseUrl: basePath ? new URL(basePath, BASE_URL) : BASE_URL,
    canonicalHost: "portal.example.test",
    pathMount: input.pathMount,
    instanceName: "FundRoom",
    auth: AUTH,
    embedOrigins: input.embedOrigins ?? [],
    serverVersion: "0.0.0-test",
    setupRequired: input.setupRequired,
    controlPlane: input.controlPlane,
    links: input.links,
  });
}

describe("webConfigFor", () => {
  it("names the signup terms version exactly where signup is offered (fix round 2)", () => {
    const cp: WebControlPlaneFacts = {
      enabled: true,
      centralAuth: false,
      signup: true,
      billing: false,
      signupTermsVersion: 1,
    };
    const canon = derive({
      host: "portal.example.test",
      path: "/signup",
      mode: "multi",
      controlPlane: cp,
    });
    expect(canon).toMatchObject({ signup: true, signupTerms: { version: 1, url: null } });
    const tenant = derive({
      host: "acme.portal.example.test",
      path: "/",
      mode: "multi",
      workspace: acme,
      controlPlane: cp,
    });
    expect(tenant).toMatchObject({ signup: false, signupTerms: null });
    const closed = derive({
      host: "portal.example.test",
      path: "/",
      mode: "multi",
      controlPlane: { ...cp, signup: false },
    });
    expect(closed).toMatchObject({ signup: false, signupTerms: null });
  });

  it("E-UP-4: the terms version is the configured one, linked to TERMS_URL when set", () => {
    const cp: WebControlPlaneFacts = {
      enabled: true,
      centralAuth: false,
      signup: true,
      billing: false,
      signupTermsVersion: 7,
    };
    const terms = "https://www.example.com/terms";
    const canon = derive({
      host: "portal.example.test",
      path: "/signup",
      mode: "multi",
      controlPlane: cp,
      links: { terms, privacy: null, support: null, status: null },
    });
    expect(canon.signupTerms).toEqual({ version: 7, url: terms });
  });

  it("E-UP-4: every page carries the footer links, set or not", () => {
    const links: WebLinks = {
      terms: "https://www.example.com/terms",
      privacy: "https://www.example.com/privacy",
      support: "mailto:support@example.com",
      status: null,
    };
    const single = derive({
      host: "ir.acme.com",
      path: "/",
      mode: "single",
      workspace: acme,
      links,
    });
    expect(single.links).toEqual(links);
    const tenant = derive({
      host: "acme.portal.example.test",
      path: "/admin",
      mode: "multi",
      workspace: acme,
      links,
    });
    expect(tenant.links).toEqual(links);
    // Unset: present, all null (the SPA renders only the accessibility link).
    expect(
      derive({ host: "ir.acme.com", path: "/", mode: "single", workspace: acme }).links,
    ).toEqual({ terms: null, privacy: null, support: null, status: null });
  });

  it("E-UP-4: controlPlane follows CONTROL_PLANE on every host", () => {
    const facts = (enabled: boolean): WebControlPlaneFacts => ({
      enabled,
      centralAuth: false,
      signup: false,
      billing: false,
      signupTermsVersion: 1,
    });
    for (const [host, workspace] of [
      ["portal.example.test", undefined],
      ["acme.portal.example.test", acme],
    ] as const) {
      expect(
        derive({ host, path: "/setup", mode: "multi", workspace, controlPlane: facts(true) })
          .controlPlane,
        host,
      ).toBe(true);
      expect(
        derive({ host, path: "/setup", mode: "multi", workspace, controlPlane: facts(false) })
          .controlPlane,
        host,
      ).toBe(false);
    }
    // A self-host passes no facts at all.
    expect(derive({ host: "ir.acme.com", path: "/", mode: "single" }).controlPlane).toBe(false);
  });

  it("single mode, app tree", () => {
    const c = derive({ host: "ir.acme.com", path: "/updates/1", mode: "single", workspace: acme });
    expect(c).toMatchObject({
      tree: "app",
      routerBase: "",
      apiBase: "",
      workspace: { slug: "acme", name: "Acme" },
      canonicalOrigin: "https://portal.example.test",
      setupRequired: false,
      embedOrigins: [],
      tenancy: "single",
      auth: { methods: ["email_otp", "passkey"], passkeyRpId: "portal.example.test" },
    });
  });

  it("single mode before setup flags setupRequired", () => {
    const c = derive({ host: "portal.example.test", path: "/", mode: "single" });
    expect(c.setupRequired).toBe(true);
    expect(c.workspace).toBeNull();
  });

  it("takes setupRequired from the gate when given (E0.8), in either mode", () => {
    const multi = { host: "portal.example.test", path: "/", mode: "multi" as const };
    expect(derive({ ...multi, setupRequired: true }).setupRequired).toBe(true);
    expect(derive({ ...multi, setupRequired: false }).setupRequired).toBe(false);
    const single = { host: "portal.example.test", path: "/", mode: "single" as const };
    expect(derive({ ...single, setupRequired: false }).setupRequired).toBe(false);
    expect(derive({ ...single, workspace: acme, setupRequired: true }).setupRequired).toBe(true);
  });

  it("multi mode is never setupRequired without the gate", () => {
    const c = derive({ host: "portal.example.test", path: "/", mode: "multi" });
    expect(c.setupRequired).toBe(false);
    expect(c.routerBase).toBe("");
    expect(c.canonicalOrigin).toBe("https://portal.example.test");
  });

  it("multi mode subdomain host keeps the router at the root", () => {
    const c = derive({
      host: "acme.portal.example.test",
      path: "/data-room",
      mode: "multi",
      workspace: acme,
    });
    expect(c.routerBase).toBe("");
    expect(c.apiBase).toBe("");
    expect(c.canonicalOrigin).toBe("https://acme.portal.example.test");
  });

  it("multi mode /w/<slug> carries the prefix in routerBase and apiBase", () => {
    const c = derive({
      host: "portal.example.test",
      path: "/w/acme/admin/people",
      mode: "multi",
      workspace: acme,
    });
    expect(c.tree).toBe("admin");
    expect(c.routerBase).toBe("/w/acme");
    expect(c.apiBase).toBe("/w/acme");
    expect(c.canonicalOrigin).toBe("https://acme.portal.example.test");
  });

  it("multi mode canonical-host embed routes and calls the API under its own prefix", () => {
    const c = derive({
      host: "portal.example.test",
      path: "/embed/acme/updates",
      mode: "multi",
      workspace: acme,
      embedOrigins: ["https://acme.com"],
    });
    expect(c.tree).toBe("embed");
    expect(c.routerBase).toBe("/embed/acme");
    // Not `/w/acme` (E2.2): the API call has to stay inside the embed prefix so the classifier
    // can see it is in the embed context and `cookieModeFor` issues the partitioned cookie a
    // third-party frame can send back. See `tenancy.ts`.
    expect(c.apiBase).toBe("/embed/acme");
    expect(c.embedOrigins).toEqual(["https://acme.com"]);
  });

  it("a tenant host and single mode use the embed prefix too: the cookie recipe decides, not the host", () => {
    const tenant = derive({
      host: "acme.portal.example.test",
      path: "/embed/acme",
      mode: "multi",
      workspace: acme,
    });
    expect(tenant.routerBase).toBe("/embed/acme");
    expect(tenant.apiBase).toBe("/embed/acme");

    const single = derive({
      host: "ir.acme.com",
      path: "/embed/acme",
      mode: "single",
      workspace: acme,
    });
    expect(single.routerBase).toBe("/embed/acme");
    expect(single.apiBase).toBe("/embed/acme");
  });

  it("BASE_PATH prefixes everything", () => {
    const c = derive({
      host: "portal.example.test",
      path: "/portal/embed/acme/x",
      mode: "multi",
      basePath: "/portal",
      workspace: acme,
    });
    expect(c.basePath).toBe("/portal");
    expect(c.tree).toBe("embed");
    expect(c.routerBase).toBe("/portal/embed/acme");
    expect(c.apiBase).toBe("/portal/embed/acme");
    expect(c.canonicalOrigin).toBe("https://acme.portal.example.test/portal");
    const plain = derive({
      host: "acme.portal.example.test",
      path: "/portal/admin",
      mode: "multi",
      basePath: "/portal",
      workspace: acme,
    });
    expect(plain.routerBase).toBe("/portal");
    expect(plain.apiBase).toBe("/portal");
    expect(plain.tree).toBe("admin");
  });

  it("E3.9: a mounted request presents the mount's prefix and origin, never BASE_PATH", () => {
    // Replace shape: the host serves `/portal/*`, the app runs under `/investors`.
    const mount = { origin: "https://caddy.test", prefix: "/portal" };
    const app = derive({
      host: "portal.example.test",
      path: "/investors/updates",
      mode: "single",
      basePath: "/investors",
      workspace: acme,
      pathMount: mount,
    });
    expect(app).toMatchObject({
      basePath: "/portal",
      routerBase: "/portal",
      apiBase: "/portal",
      canonicalOrigin: "https://caddy.test/portal",
    });
    const embed = derive({
      host: "portal.example.test",
      path: "/investors/embed/acme",
      mode: "single",
      basePath: "/investors",
      workspace: acme,
      pathMount: mount,
    });
    expect(embed.routerBase).toBe("/portal/embed/acme");
    expect(embed.apiBase).toBe("/portal/embed/acme");
    // Strip shape: the app at the root, the mount adds `/investors` for presentation only.
    const stripped = derive({
      host: "portal.example.test",
      path: "/admin",
      mode: "single",
      workspace: acme,
      pathMount: { origin: "https://acme.com", prefix: "/investors" },
    });
    expect(stripped).toMatchObject({
      tree: "admin",
      basePath: "/investors",
      routerBase: "/investors",
      canonicalOrigin: "https://acme.com/investors",
    });
  });

  it("E3.9 FR1 B4: an unmounted page never gets a mount origin as its portal root", () => {
    const classification = classifyRequest(
      { host: "portal.example.test", path: "/updates" },
      { mode: "single", canonicalHost: "acme.com", basePath: "" },
    );
    if (!classification) throw new Error("unclassifiable");
    const base = {
      classification,
      workspace: acme,
      tenancy: "single" as const,
      basePath: "",
      baseUrl: new URL("https://acme.com/investors"),
      canonicalHost: "acme.com",
      instanceName: "FundRoom",
      auth: AUTH,
      embedOrigins: [],
      requestOrigin: "https://portal.example.test",
    };
    expect(webConfigFor({ ...base, baseOriginIsMount: true }).canonicalOrigin).toBe(
      "https://portal.example.test",
    );
    // Today's shapes (BASE_URL's origin is the portal's): unchanged.
    expect(webConfigFor({ ...base, baseOriginIsMount: false }).canonicalOrigin).toBe(
      "https://acme.com",
    );
  });

  it("embedOrigins are dropped outside the embed tree", () => {
    const c = derive({
      host: "acme.portal.example.test",
      path: "/",
      mode: "multi",
      workspace: acme,
      embedOrigins: ["https://acme.com"],
    });
    expect(c.embedOrigins).toEqual([]);
  });
});

describe("isSourceMapPath (F-32)", () => {
  it("matches .map however it is spelled, and nothing else", () => {
    for (const p of [
      "/assets/index-abc.js.map",
      "/assets/index-abc.JS.MAP",
      "/assets/index-abc.js%2Emap",
      "/assets/index-abc.js%2emap",
      "/investors/assets/x.css.map",
    ])
      expect(isSourceMapPath(p), p).toBe(true);
    for (const p of ["/assets/index-abc.js", "/assets/map.js", "/assets/sitemap", "/assets/%E0%A4"])
      expect(isSourceMapPath(p), p).toBe(false);
  });
});

describe("loadWebDist", () => {
  it("returns undefined when unset or missing", () => {
    expect(loadWebDist(undefined)).toBeUndefined();
    expect(loadWebDist(join(tmpdir(), "definitely-missing-fundroom-dist"))).toBeUndefined();
  });

  it("throws when the directory has no index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "fundroom-web-"));
    expect(() => loadWebDist(dir)).toThrow(/no index\.html/u);
  });

  it("reads the template and lists root files only", () => {
    const dir = mkdtempSync(join(tmpdir(), "fundroom-web-"));
    writeFileSync(join(dir, "index.html"), TEMPLATE);
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");
    writeFileSync(join(dir, ".hidden"), "");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "a.js"), "");
    const dist = loadWebDist(dir);
    expect(dist?.template).toBe(TEMPLATE);
    expect(dist?.rootFiles).toEqual(["favicon.svg"]);
  });
});
