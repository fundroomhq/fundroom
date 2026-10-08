import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brandThemeTokens } from "@fundroom/branding";
import type { TenancyMode } from "@fundroom/config";
import { ApiError } from "@fundroom/contracts";
import {
  type EmbedSettings,
  isAllowedEmbedOrigin,
  normalizeEmbedOrigin,
  parseWorkspaceSettings,
} from "@fundroom/domain";
import { cspNonceOf, type PathMount } from "@fundroom/http";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import type { AppEnv } from "./env.js";
import { pageErrorResponse } from "./middleware/errors.js";
import { workspaceStatusView } from "./middleware/workspace-status.js";
import { isMountOrigin, mountedUrl, publicBaseOf, publicOriginOf } from "./path-mount.js";
import { brandingLogoUrl } from "./routes/deps.js";
import type { Classification } from "./tenancy.js";
import { SERVER_VERSION } from "./version.js";

/*
 * The `web` role (E0.7, ADR-0030). The SPA is built once by Vite with
 * `html.cspNonce: "__CSP_NONCE__"` and `base: "/"`; this module turns that static
 * `index.html` into a per-request document:
 *
 *   - every `__CSP_NONCE__` becomes the request's CSP nonce (script-src is
 *     'nonce-…' 'strict-dynamic'; no 'unsafe-inline' for CSP3 browsers);
 *   - under a public base (BASE_PATH, or the prefix of the path mount the request came through,
 *     E3.9), root-relative `src="/…"` / `href="/…"` URLs get that prefix;
 *   - a `<meta name="seed-host:config">` tag carries the `WebConfig` the SPA boots from
 *     (route tree, router base, API prefix, workspace, auth methods) so the client never
 *     guesses at deployment mode.
 *
 * Hashed `assets/*` are immutable; other files copied from `public/` are cacheable for an hour;
 * the document itself is `private, no-store`. Missing assets are 404, never the index.
 */
export type AuthMethod = "email_otp" | "magic_link" | "passkey" | "password" | "oidc";

/**
 * The workspace brand, inlined into the document (E1.7).
 *
 * This is what kills the flash of unbranded content: the SPA writes `tokens` onto the root
 * element on its very first paint instead of waiting for `GET /branding`. It is built from the
 * ALREADY-RESOLVED workspace row the tenant middleware put on the context — its `settings` is
 * in hand, so the page costs no extra query — and it is null when no workspace resolved.
 *
 * Only what the first paint needs: the name and tagline for the header, the logo URL for the
 * `<img>`, and both palettes because the viewer's colour scheme is not known server-side.
 * Everything else (the contrast report, the stored logo metadata) belongs to the admin screen
 * and comes from the API when that screen is opened.
 */
export interface WebBranding {
  readonly name: string;
  readonly tagline: string | null;
  readonly logoUrl: string | null;
  readonly tokens: {
    readonly light: Record<string, string>;
    readonly dark: Record<string, string>;
  };
}

export interface WebConfig {
  readonly v: 1;
  readonly instanceName: string;
  readonly serverVersion: string;
  readonly tenancy: TenancyMode;
  /** `""` or `/x`: the request's PUBLIC base (BASE_PATH, or a path mount's prefix; E3.9). */
  readonly basePath: string;
  /** Router base: `basePath` + `""` | `/w/<slug>` | `/embed/<slug>`. */
  readonly routerBase: string;
  /** Prefix in front of `/api/v1` for this page's API calls. */
  readonly apiBase: string;
  readonly tree: "app" | "admin" | "embed";
  readonly workspace: { readonly slug: string; readonly name: string } | null;
  /** This workspace's brand, for the first paint; null without a workspace (E1.7). */
  readonly branding: WebBranding | null;
  /** Absolute portal root for this workspace ("open in a new tab"). */
  readonly canonicalOrigin: string;
  /** Host origins allowed to frame this page (postMessage bridge targets); embed only. */
  readonly embedOrigins: readonly string[];
  readonly auth: { readonly methods: readonly AuthMethod[]; readonly passkeyRpId: string };
  /** No workspace exists yet: the SPA shows the `/setup` wizard and nothing else. */
  readonly setupRequired: boolean;
  /**
   * E3.10: the workspace is not `active` — the admin shell shows the suspension / review banner,
   * an investor the "portal unavailable" screen. Null when active or without a workspace.
   */
  readonly workspaceStatus: {
    readonly status: "pending_review" | "suspended";
    readonly reason: "operator" | "billing" | "sanctions" | "relocation" | null;
  } | null;
  /**
   * E3.10: central auth (CENTRAL_AUTH=on) applies to this page — a custom domain or a
   * `<slug>.<canonical>` host — and the sign-in screen's primary path is this start URL. Null
   * otherwise (the canonical host itself, a single-tenant install, CENTRAL_AUTH=off).
   */
  readonly centralAuth: { readonly startPath: string } | null;
  /** E3.10: self-service signup is open (SIGNUP_MODE=open) and this is the canonical host. */
  readonly signup: boolean;
  /**
   * E3.10 (fix round 2): the version of the host's signup terms the checkbox accepts — sent back
   * as `termsVersion` on `POST /signup/start` — and where to read them. Non-null exactly when
   * `signup` is true. E-UP-4: the version is SIGNUP_TERMS_VERSION, the URL TERMS_URL (or null).
   */
  readonly signupTerms: { readonly version: number; readonly url: string | null } | null;
  /** E-UP-4: the operator's footer links (TERMS_URL, PRIVACY_URL, SUPPORT_URL, STATUS_URL). */
  readonly links: WebLinks;
  /** E-UP-4: CONTROL_PLANE=on — a managed host (the setup wizard skips the operator's steps). */
  readonly controlPlane: boolean;
  /** E3.10: billing is on (CONTROL_PLANE=on with a BILLING_DRIVER): show the billing settings. */
  readonly billing: boolean;
  /** E3.12: an AI model is configured on this install (show Settings → AI assist). */
  readonly ai: boolean;
}

/** The footer links of every page (E-UP-4); each is null when its key is unset. */
export interface WebLinks {
  readonly terms: string | null;
  readonly privacy: string | null;
  readonly support: string | null;
  readonly status: string | null;
}

const NO_LINKS: WebLinks = { terms: null, privacy: null, support: null, status: null };

/** `settings.branding` → `WebBranding`. Pure; `logoUrl` is passed in because only the app knows it. */
export function webBrandingFor(
  workspace: { name: string; settings?: unknown },
  logoUrl: string | null,
): WebBranding {
  const brand = parseWorkspaceSettings(workspace.settings).branding;
  const tokens = brandThemeTokens(brand);
  return {
    name: brand.displayName ?? workspace.name,
    tagline: brand.tagline,
    logoUrl: brand.logo === null ? null : logoUrl,
    tokens: { light: tokens.light, dark: tokens.dark },
  };
}

export interface WebConfigInput {
  readonly classification: Classification;
  readonly workspace:
    | {
        id: string;
        slug: string;
        name: string;
        settings?: unknown;
        /** The workspace's `active` custom domain, when it has one (E2.1 decision 5). */
        primaryHost?: string | null;
        /** E3.10: `core.workspace.status` / `suspended_reason`. */
        status?: "active" | "pending_review" | "suspended";
        suspendedReason?: "operator" | "billing" | "sanctions" | "relocation" | null;
      }
    | undefined;
  readonly tenancy: TenancyMode;
  /** The request's PUBLIC base (E3.9): a path mount's prefix when mounted, else BASE_PATH. */
  readonly basePath: string;
  readonly baseUrl: URL;
  /** Host (with non-default port) of BASE_URL, lower-case. */
  readonly canonicalHost: string;
  /** The path mount the request came through (E3.9); the portal root is then the mount. */
  readonly pathMount?: PathMount | undefined;
  /**
   * E3.9 FR1: BASE_URL's origin is a path mount's (the host site's). An unmounted request must
   * then not be pointed there — popup / new tab / postMessage must be same-origin with the page —
   * so the portal root is `requestOrigin` + BASE_PATH instead.
   */
  readonly baseOriginIsMount?: boolean | undefined;
  /** The request's own public origin (used only with `baseOriginIsMount`). */
  readonly requestOrigin?: string | undefined;
  readonly instanceName: string;
  readonly auth: WebConfig["auth"];
  readonly embedOrigins: readonly string[];
  readonly serverVersion?: string | undefined;
  /** From the setup gate (E0.8): no workspace exists yet. Defaults to the single-mode derivation. */
  readonly setupRequired?: boolean | undefined;
  /** Absolute URL of `GET /branding/logo` for this workspace; ignored when it has no logo. */
  readonly brandingLogoUrl?: string | undefined;
  /** E3.10: the control-plane facts of the page (see `WebConfig`); all off when omitted. */
  readonly controlPlane?: WebControlPlaneFacts | undefined;
  /** E3.10: the request carries a staff membership here (sees the status reason). */
  readonly viewerIsStaff?: boolean | undefined;
  /** E3.12: an AI model is configured (see `WebConfig.ai`); off when omitted. */
  readonly ai?: boolean | undefined;
  /** E-UP-4: the footer links (see `WebConfig.links`); none when omitted. */
  readonly links?: WebLinks | undefined;
}

/** What `app.ts` knows about the control plane for the page config (E3.10). */
export interface WebControlPlaneFacts {
  /** E-UP-4: CONTROL_PLANE=on (`WebConfig.controlPlane`). */
  readonly enabled: boolean;
  /** CENTRAL_AUTH=on. The start path is only offered on a workspace host (see `centralAuthFor`). */
  readonly centralAuth: boolean;
  /** SIGNUP_MODE=open. Offered on the canonical host only. */
  readonly signup: boolean;
  /** CONTROL_PLANE=on and a BILLING_DRIVER. */
  readonly billing: boolean;
  /** E-UP-4: SIGNUP_TERMS_VERSION, the terms version a signup accepts. */
  readonly signupTermsVersion: number;
}

/** The central-auth start path, on a custom domain or `<slug>.<canonical>` host only (E3.10). */
export function centralAuthFor(
  facts: WebControlPlaneFacts | undefined,
  cl: Pick<Classification, "host">,
  basePath: string,
): WebConfig["centralAuth"] {
  if (facts?.centralAuth !== true) return null;
  if (cl.host !== "custom" && cl.host !== "tenant") return null;
  return { startPath: `${basePath}/auth/central/start` };
}

const PAGE_TREES: ReadonlySet<Classification["tree"]> = new Set(["app", "admin", "embed"]);

/**
 * The workspace's own portal root, which "open in a new tab", every copyable link and the embed
 * rejection page point at.
 *
 * A verified custom domain wins in BOTH tenancy modes (E2.1 decision 5): once a workspace has
 * one it *is* the portal's address, and a page that kept pointing at `<slug>.<canonical>` would
 * hand investors a link to an origin whose session cookie is not the one they are signed in
 * with — `__Host-` cookies are host-scoped, so the two origins are two sessions.
 */
export function workspaceCanonicalOrigin(
  input: Pick<
    WebConfigInput,
    | "workspace"
    | "tenancy"
    | "basePath"
    | "baseUrl"
    | "canonicalHost"
    | "pathMount"
    | "baseOriginIsMount"
    | "requestOrigin"
  >,
): string {
  const { workspace, basePath } = input;
  // A mounted page's portal root is the mount (E3.9): its session cookie lives there, and the
  // popup / postMessage origin the SPA derives from this must be the page's own.
  if (input.pathMount !== undefined) return `${input.pathMount.origin}${input.pathMount.prefix}`;
  if (workspace?.primaryHost != null && workspace.primaryHost !== "") {
    return `${input.baseUrl.protocol}//${workspace.primaryHost}${basePath}`;
  }
  if (input.tenancy === "multi" && workspace !== undefined) {
    return `${input.baseUrl.protocol}//${workspace.slug}.${input.canonicalHost}${basePath}`;
  }
  if (input.baseOriginIsMount === true && input.requestOrigin !== undefined)
    return `${input.requestOrigin}${basePath}`;
  return `${input.baseUrl.origin}${basePath}`;
}

export function webConfigFor(input: WebConfigInput): WebConfig {
  const { classification: cl, workspace, basePath } = input;
  const tree: WebConfig["tree"] = cl.tree === "admin" || cl.tree === "embed" ? cl.tree : "app";
  // Slug named by the path: `/w/<slug>` (stripped from `cl.path`) or `/embed/<slug>` (kept).
  // A `tenant` or `custom` host already names the workspace, so neither needs a `/w/<slug>`
  // router base — and on a custom domain the slug did not come from the path at all: the tenant
  // middleware put it there from the hostname lookup (E2.1 §1.12).
  const pathSlug =
    cl.slug !== undefined && cl.host !== "tenant" && cl.host !== "custom" ? cl.slug : undefined;
  let routerBase = basePath;
  let apiBase = basePath;
  if (cl.embed && cl.slug !== undefined) {
    routerBase = `${basePath}/embed/${cl.slug}`;
    /*
     * The framed page calls the API *under its own prefix*, in every tenancy mode (E2.2).
     *
     * It names the workspace, which the canonical host in multi mode does not — but that is the
     * lesser half. The reason it is not `/w/<slug>` is the session cookie: `cookieModeFor` picks
     * `SameSite=None; Partitioned` from the request's classification, and a `/w/<slug>/api/v1`
     * call is indistinguishable from a first-party one, so a login made inside the iframe was
     * issued a `Lax` cookie the browser then refused to send back. See `tenancy.ts`.
     */
    apiBase = routerBase;
  } else if (pathSlug !== undefined) {
    routerBase = `${basePath}/w/${pathSlug}`;
    apiBase = routerBase;
  }
  const canonicalOrigin = workspaceCanonicalOrigin(input);
  const cp = input.controlPlane;
  const signupOpen = cp?.signup === true && cl.host === "canonical" && workspace === undefined;
  const links = input.links ?? NO_LINKS;
  return {
    v: 1,
    instanceName: input.instanceName,
    serverVersion: input.serverVersion ?? SERVER_VERSION,
    tenancy: input.tenancy,
    basePath,
    routerBase,
    apiBase,
    tree,
    workspace: workspace ? { slug: workspace.slug, name: workspace.name } : null,
    branding: workspace ? webBrandingFor(workspace, input.brandingLogoUrl ?? null) : null,
    canonicalOrigin,
    embedOrigins: tree === "embed" && workspace ? [...input.embedOrigins] : [],
    auth: { methods: [...input.auth.methods], passkeyRpId: input.auth.passkeyRpId },
    setupRequired: input.setupRequired ?? (input.tenancy === "single" && workspace === undefined),
    workspaceStatus: workspaceStatusView(workspace, input.viewerIsStaff === true),
    centralAuth: centralAuthFor(input.controlPlane, cl, basePath),
    signup: signupOpen,
    signupTerms:
      signupOpen && cp !== undefined ? { version: cp.signupTermsVersion, url: links.terms } : null,
    links: { ...links },
    controlPlane: cp?.enabled === true,
    billing: cp?.billing === true,
    ai: input.ai === true,
  };
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/gu,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export const CONFIG_META_NAME = "seed-host:config";
const NONCE_PLACEHOLDER = /__CSP_NONCE__/gu;
// `src="/x"` / `href="/x"` but not protocol-relative `//` and not an already-prefixed path.
const ROOT_URL_RE = /\b(src|href)=(["'])\/(?!\/)/gu;

export interface RenderIndexOptions {
  readonly nonce: string;
  readonly basePath: string;
  readonly config: WebConfig;
}

/** Pure: template → document for one request. */
export function renderIndexHtml(template: string, options: RenderIndexOptions): string {
  let html = template.replace(NONCE_PLACEHOLDER, options.nonce);
  if (options.basePath !== "") {
    const prefixed = `${options.basePath}/`;
    html = html.replace(ROOT_URL_RE, (match, attr: string, quote: string, offset: number) => {
      const after = html.slice(offset + match.length - 1);
      if (after.startsWith(prefixed)) return match;
      return `${attr}=${quote}${options.basePath}/`;
    });
  }
  const meta = `<meta name="${CONFIG_META_NAME}" content="${escapeHtml(JSON.stringify(options.config))}">`;
  const head = html.indexOf("</head>");
  return head === -1 ? `${html}${meta}` : `${html.slice(0, head)}${meta}\n${html.slice(head)}`;
}

export interface WebDist {
  readonly root: string;
  readonly template: string;
  /** Top-level files copied from `public/` (never `index.html`, never directories). */
  readonly rootFiles: readonly string[];
}

/** Reads the build once at startup; `undefined` when `WEB_DIST_PATH` is unset or absent. */
export function loadWebDist(dist: string | undefined): WebDist | undefined {
  if (dist === undefined || !existsSync(dist)) return undefined;
  const indexPath = join(dist, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`WEB_DIST_PATH=${dist} has no index.html; build the web app first`);
  }
  const rootFiles = readdirSync(dist).filter(
    (f) => f !== "index.html" && !f.startsWith(".") && statSync(join(dist, f)).isFile(),
  );
  return { root: dist, template: readFileSync(indexPath, "utf8"), rootFiles };
}

export interface MountWebOptions {
  readonly dist: WebDist | undefined;
  readonly basePath: string;
  readonly tenancy: TenancyMode;
  readonly baseUrl: URL;
  readonly canonicalHost: string;
  readonly instanceName: string;
  readonly auth: WebConfig["auth"];
  readonly embedOrigins: (workspaceId: string) => Promise<readonly string[]>;
  /** `PATH_MOUNTS` (E3.9): BASE_URL's origin may be a host site's (see `baseOriginIsMount`). */
  readonly pathMounts?: readonly PathMount[] | undefined;
  /** The setup gate (E0.8). When absent, single mode without a workspace means "required". */
  readonly setupRequired?: (() => Promise<boolean>) | undefined;
  /** E3.10: central auth, signup and billing for the page config. */
  readonly controlPlane?: WebControlPlaneFacts | undefined;
  /** E3.12: an AI model is configured on this install (`WebConfig.ai`). */
  readonly ai?: boolean | undefined;
  /** E-UP-4: the footer links (`WebConfig.links`). */
  readonly links?: WebLinks | undefined;
  /**
   * E2.2: an embed document was refused because its initiator is not on the workspace's
   * allow-list. `app.ts` turns this into the throttled `embed.origin_rejected` audit event; the
   * page has already been refused by the time it is called, so it must never throw or block.
   */
  readonly onEmbedOriginRejected?:
    | ((c: Context<AppEnv>, rejection: { workspaceId: string; origin: string }) => void)
    | undefined;
}

/** `*.map`, however the request spelled it (case, percent-encoding). */
export function isSourceMapPath(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape: judge the raw path; serveStatic will not find such a file either.
  }
  return /\.map$/iu.test(decoded.trimEnd());
}

export function mountWeb(app: Hono<AppEnv>, options: MountWebOptions): void {
  const { basePath, dist } = options;
  if (dist === undefined) {
    app.get(`${basePath}/*`, (c) => {
      if (!isPageTree(c)) return pageErrorResponse(c, new ApiError("not_found", "no such page"));
      // The same refusal as the built SPA gets. An install without a web build still serves
      // *something* at `/embed/<slug>`, and a framing control that only applies once the assets
      // exist is a framing control with a configuration-shaped hole in it.
      const refused = refuseEmbed(c, options);
      if (refused !== undefined) return refused;
      return c.html(placeholderPage(c, options.instanceName));
    });
    return;
  }

  const strip = (p: string) => (basePath ? p.slice(basePath.length) : p);

  // `serveStatic` builds its Response before `onFound` runs, so headers must be staged
  // beforehand; the 404 fallthrough resets them so a miss is never cached.
  const cacheFor = (value: string) => async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.header("Cache-Control", value);
    await next();
  };
  const notFound = (c: Context<AppEnv>, what: string) => {
    c.header("Cache-Control", "private, no-store");
    return pageErrorResponse(c, new ApiError("not_found", what));
  };

  app.use(`${basePath}/assets/*`, cacheFor("public, max-age=31536000, immutable"));
  // F-32 (ASVS 15.2.3): source maps are never served, even if a build left one in the dist
  // (the web build emits them "hidden" for error tooling and the image deletes them).
  app.use(`${basePath}/assets/*`, async (c, next) => {
    if (isSourceMapPath(c.req.path)) return notFound(c, "no such asset");
    await next();
  });
  app.use(`${basePath}/assets/*`, serveStatic({ root: dist.root, rewriteRequestPath: strip }));
  app.all(`${basePath}/assets/*`, (c) => notFound(c, "no such asset"));

  for (const file of dist.rootFiles.filter((f) => !isSourceMapPath(f))) {
    app.use(`${basePath}/${file}`, cacheFor("public, max-age=3600"));
    app.get(`${basePath}/${file}`, serveStatic({ root: dist.root, path: file }));
    app.get(`${basePath}/${file}`, (c) => notFound(c, "no such file"));
  }

  app.get(`${basePath}/*`, async (c) => {
    if (!isPageTree(c)) return notFound(c, "no such page");
    const classification = c.get("classification") as Classification;
    const workspace = c.get("workspace");
    const refused = refuseEmbed(c, options);
    if (refused !== undefined) return refused;
    // The document's public face (E3.9): the mount's prefix on a mounted request, else BASE_PATH.
    const publicBase = publicBaseOf(c, basePath);
    const pathMount = c.get("pathMount");
    // The workspace row the tenant middleware resolved already carries `settings`, so the
    // brand costs this page no query at all — which is the point: the SPA themes itself on
    // the first paint instead of flashing the default palette until `GET /branding` lands.
    const logo =
      workspace === undefined ? null : parseWorkspaceSettings(workspace.settings).branding.logo;
    const config = webConfigFor({
      classification,
      workspace,
      ...(logo === null || workspace === undefined
        ? {}
        : {
            // Same-origin on a mounted page (the CSP's img-src is 'self'), else BASE_URL-based.
            brandingLogoUrl:
              mountedUrl(c, `/api/v1/branding/logo?v=${logo.sha256.slice(0, 16)}`) ??
              brandingLogoUrl(
                { baseUrl: options.baseUrl, tenancy: options.tenancy, basePath },
                workspace,
                logo,
              ),
          }),
      tenancy: options.tenancy,
      basePath: publicBase,
      baseUrl: options.baseUrl,
      canonicalHost: options.canonicalHost,
      pathMount,
      baseOriginIsMount: isMountOrigin(options.baseUrl.origin, options.pathMounts ?? []),
      requestOrigin: publicOriginOf(c),
      instanceName: options.instanceName,
      // E3.9 FR1 B5: no passkey where the page is not on the passkey RP origin.
      auth:
        c.get("offPasskeyOrigin") === true
          ? { ...options.auth, methods: options.auth.methods.filter((m) => m !== "passkey") }
          : options.auth,
      embedOrigins:
        classification.tree === "embed" && workspace
          ? await options.embedOrigins(workspace.id)
          : [],
      setupRequired: options.setupRequired ? await options.setupRequired() : undefined,
      controlPlane: options.controlPlane,
      viewerIsStaff: c.get("membership")?.kind === "staff",
      ai: options.ai,
      links: options.links,
    });
    const html = renderIndexHtml(dist.template, {
      nonce: cspNonceOf(c) ?? "",
      basePath: publicBase,
      config,
    });
    c.header("Cache-Control", "private, no-store");
    return c.html(html);
  });
}

/**
 * The origin check as the page handlers apply it: `undefined` to carry on, a 403 page otherwise.
 *
 * Both the built SPA and the placeholder call it, and only for the embed tree with a resolved
 * workspace — `/embed/<slug>` is the only document anyone frames, and without a workspace there
 * is no allow-list to consult (the request is already on its way to a 404).
 */
function refuseEmbed(c: Context<AppEnv>, options: MountWebOptions): Response | undefined {
  const classification = c.get("classification");
  const workspace = c.get("workspace");
  if (classification?.tree !== "embed" || workspace === undefined) return undefined;
  const origin = workspaceCanonicalOrigin({
    workspace,
    tenancy: options.tenancy,
    basePath: publicBaseOf(c, options.basePath),
    baseUrl: options.baseUrl,
    canonicalHost: options.canonicalHost,
    pathMount: c.get("pathMount"),
    baseOriginIsMount: isMountOrigin(options.baseUrl.origin, options.pathMounts ?? []),
    requestOrigin: publicOriginOf(c),
  });
  const verdict = checkEmbedInitiator({
    secFetchSite: c.req.header("sec-fetch-site"),
    origin: c.req.header("origin"),
    referer: c.req.header("referer"),
    settings: parseWorkspaceSettings(workspace.settings).embed,
    selfOrigin: new URL(origin).origin,
  });
  if (verdict.allowed) return undefined;
  options.onEmbedOriginRejected?.(c, { workspaceId: workspace.id, origin: verdict.origin });
  c.header("Cache-Control", "private, no-store");
  return c.html(embedRejectedPage(c, origin), 403);
}

/** `allowed: false` carries the origin we saw, which is the only thing worth auditing. */
export type EmbedInitiatorVerdict = { allowed: true } | { allowed: false; origin: string };

export interface EmbedInitiatorInput {
  readonly secFetchSite: string | undefined;
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  readonly settings: EmbedSettings;
  /** The workspace's own portal origin, which `'self'` stands for in the CSP. */
  readonly selfOrigin: string;
}

/**
 * May this request render the embed document? (design/08 §6, plan §15 "origin checks + audit of
 * rejections".)
 *
 * **Rejects only on positive evidence of a disallowed initiator.** Absence of evidence is not
 * rejection, and that asymmetry is the whole design: a host page with `Referrer-Policy:
 * no-referrer` sends us nothing at all, an older browser sends no `Sec-Fetch-*`, and a direct
 * top-level visit to `/embed/<slug>` is a person opening the "open in a new tab" fallback URL,
 * not an attack. Refusing any of those would break working embeds to catch an attacker who is
 * already stopped by `frame-ancestors` — the browser-enforced control this one only backs up.
 * (Same principle as E2.1's DoH quorum: disagreement resolves to the weaker answer, so the
 * failure mode is "not yet", never "verified".)
 *
 * So the one refusal is: the browser says `Sec-Fetch-Site: cross-site` **and** names an
 * initiator (`Origin`, else `Referer`) **and** that origin is not on the allow-list. `same-site`
 * is deliberately not refused: in multi-tenant mode the admin screen previews its own embed from
 * `<slug>.<canonical>` while the document is served from the canonical host, which is same-site
 * and cross-origin, and `frame-ancestors 'self'` is already the control there.
 *
 * On a top-level navigation no `Origin` header is sent, so `Referer` is usually the only
 * initiator signal — which is why the loader must not suppress it (E2.2 §4).
 */
export function checkEmbedInitiator(input: EmbedInitiatorInput): EmbedInitiatorVerdict {
  if (input.secFetchSite !== "cross-site") return { allowed: true };
  const initiator = originOfHeader(input.origin) ?? originOfHeader(input.referer);
  if (initiator === undefined) return { allowed: true };
  if (isAllowedEmbedOrigin(input.settings, initiator, input.selfOrigin)) return { allowed: true };
  return { allowed: false, origin: initiator };
}

/**
 * The origin of an `Origin` or `Referer` header, normalised the way the stored allow-list is.
 *
 * `normalizeEmbedOrigin` refuses anything carrying a path, so a `Referer` (which is a full URL)
 * is reduced to its origin first. `"null"` — an opaque origin from a sandboxed frame or a
 * `data:` document — normalises to nothing and so reads as *no evidence* rather than as a
 * disallowed origin: there is no origin there to put on anyone's allow-list, and treating it as
 * positive evidence would let a sandbox attribute manufacture rejections.
 */
function originOfHeader(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return normalizeEmbedOrigin(new URL(value).origin);
  } catch {
    return undefined;
  }
}

/**
 * What a refused frame shows: minimal, unbranded, and a link to the portal on its own origin.
 *
 * Unbranded on purpose. This page renders inside a site the workspace has not allow-listed, so
 * anything it showed — the logo, the display name, a tagline — would be the workspace's identity
 * rendered on an unauthorised page, which is the phishing wrapper the allow-list exists to
 * prevent. It says what happened, names nobody, and offers the one safe action.
 */
export function embedRejectedPage(c: Context<AppEnv>, canonicalOrigin: string): string {
  // Usually nobody sees this. `frame-ancestors` refuses the same framing one layer earlier, and
  // the browser blanks the frame before this body can render — so this is the answer for a
  // client that does not enforce CSP, and a legible one for anyone who opens the URL directly,
  // rather than the user-visible outcome of a refusal.
  const nonce = cspNonceOf(c) ?? "";
  const href = escapeHtml(canonicalOrigin);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available here</title><style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1.25rem;color:#1a1a1a;background:#fff}p{max-width:32rem}a{color:#1a4fd6}</style></head><body><p>This portal is not configured to be shown on this site.</p><p>The site owner can add this page&#39;s address to the portal&#39;s embed settings. In the meantime you can <a href="${href}" target="_blank" rel="noopener noreferrer">open the portal directly</a>.</p></body></html>`;
}

function isPageTree(c: Context<AppEnv>): boolean {
  const tree = c.get("classification")?.tree;
  return tree !== undefined && PAGE_TREES.has(tree);
}

/** Served until the web app is built: proves the pipeline, CSP nonce included. */
export function placeholderPage(c: Context<AppEnv>, name: string): string {
  const nonce = cspNonceOf(c) ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:36rem;padding:0 1rem;color:#1a1a1a}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style></head><body><h1>${escapeHtml(name)}</h1><p>The server is running (v${escapeHtml(SERVER_VERSION)}). The web app has not been built or <code>WEB_DIST_PATH</code> is unset.</p><p>API: <code>/api/v1</code> · capability doc: <code>/.well-known/fundroom.json</code> · readiness: <code>/readyz</code></p></body></html>`;
}
