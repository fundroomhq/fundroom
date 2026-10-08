import * as z from "zod/mini";

/*
 * Boot configuration (ADR-0030). The server injects
 *   <meta name="seed-host:config" content="<HTML-escaped JSON>">
 * into index.html on every request: which route tree this origin/path serves, the router
 * base (BASE_PATH plus `/w/<slug>` or `/embed/<slug>`), where the API lives, which auth
 * methods are on, and the canonical origin used by "Open in a new tab". Nothing secret.
 * Without the meta (Vite dev server) we fall back to a dev config and read auth methods
 * from the capability document.
 */
export const AUTH_METHODS = ["email_otp", "magic_link", "passkey", "password", "oidc"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
export type RouteTree = "app" | "admin" | "embed";

export const WebConfigSchema = z.object({
  v: z.literal(1),
  instanceName: z.string().check(z.minLength(1)),
  serverVersion: z.string(),
  tenancy: z.enum(["single", "multi"]),
  basePath: z.string().check(z.regex(/^(?:|\/[^/].*)$/u, "basePath is empty or starts with /")),
  routerBase: z.string(),
  apiBase: z.string(),
  tree: z.enum(["app", "admin", "embed"]),
  workspace: z.nullable(z.object({ slug: z.string(), name: z.string() })),
  canonicalOrigin: z.url(),
  embedOrigins: z.array(z.string()),
  auth: z.object({ methods: z.array(z.enum(AUTH_METHODS)), passkeyRpId: z.string() }),
  setupRequired: z.boolean(),
  /*
   * The workspace brand, resolved server-side and injected with the rest of the boot config
   * (E1.7). It rides the meta tag rather than `GET /branding` because the portal has to be
   * branded on the first paint: a query would theme the app one round trip late and every
   * visitor would see the unbranded palette first. Only what the chrome needs is here —
   * the admin form reads the full record from the API. `null` when no workspace resolved;
   * `tokens` are empty maps when the workspace has picked no accent, which is how "no brand"
   * stays distinct from "a brand that matches the default".
   */
  branding: z.nullable(
    z.object({
      name: z.string(),
      tagline: z.nullable(z.string()),
      logoUrl: z.nullable(z.string()),
      tokens: z.object({
        light: z.record(z.string(), z.string()),
        dark: z.record(z.string(), z.string()),
      }),
    }),
  ),
  /*
   * The managed-host control plane (E3.10). Optional so a page rendered by an older server (and
   * the test fixtures) still parses. `workspaceStatus`: the workspace is suspended or held — staff
   * see the status and reason, everybody else `suspended` with no reason (show "portal
   * unavailable"). `centralAuth`: sign in through the canonical host (a custom domain or
   * `<slug>.<canonical>` host with CENTRAL_AUTH on). `signup`: self-service signup is open on
   * this (canonical) host. `billing`: show the billing settings. `signupTerms`: the version of
   * the host's signup terms the checkbox accepts (sent as `termsVersion`) and where they can be
   * read (`url`, null when the host has not published them). `controlPlane` (A-5): the install
   * runs the control plane, so the wizard leaves out what the host already runs (token, mail,
   * storage).
   */
  workspaceStatus: z.optional(
    z.nullable(
      z.object({
        status: z.enum(["pending_review", "suspended"]),
        reason: z.nullable(z.enum(["operator", "billing", "sanctions", "relocation"])),
      }),
    ),
  ),
  centralAuth: z.optional(z.nullable(z.object({ startPath: z.string() }))),
  signup: z.optional(z.boolean()),
  signupTerms: z.optional(
    z.nullable(z.object({ version: z.number(), url: z.optional(z.nullable(z.string())) })),
  ),
  billing: z.optional(z.boolean()),
  controlPlane: z.optional(z.boolean()),
  /**
   * A-5: the host's footer links (`TERMS_URL`, `PRIVACY_URL`, `SUPPORT_URL`, `STATUS_URL`); null
   * for one that is not set. Optional so a page from an older server still parses.
   */
  links: z.optional(
    z.object({
      terms: z.nullable(z.string()),
      privacy: z.nullable(z.string()),
      support: z.nullable(z.string()),
      status: z.nullable(z.string()),
    }),
  ),
  /** E3.12: an AI model is configured on this install (show Settings → AI assist); absent = off. */
  ai: z.optional(z.boolean()),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

export const CONFIG_META_NAME = "seed-host:config";

export function treeForPath(pathname: string): RouteTree {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (pathname.startsWith("/embed/")) return "embed";
  return "app";
}

export function devWebConfig(loc: Pick<Location, "pathname" | "origin" | "hostname">): WebConfig {
  return {
    v: 1,
    instanceName: "FundRoom (dev)",
    serverVersion: "dev",
    tenancy: "single",
    basePath: "",
    routerBase: "",
    apiBase: "",
    tree: treeForPath(loc.pathname),
    workspace: null,
    canonicalOrigin: loc.origin,
    embedOrigins: [],
    auth: { methods: ["email_otp", "passkey"], passkeyRpId: loc.hostname },
    setupRequired: false,
    branding: null,
    workspaceStatus: null,
    centralAuth: null,
    signup: false,
    signupTerms: null,
    billing: false,
    controlPlane: false,
    links: { terms: null, privacy: null, support: null, status: null },
    ai: false,
  };
}

export class WebConfigError extends Error {
  override readonly name = "WebConfigError";
}

/** Parses the injected config; falls back to the dev config when the meta tag is absent. */
export function readWebConfig(
  doc: Pick<Document, "querySelector"> = document,
  loc: Pick<Location, "pathname" | "origin" | "hostname"> = window.location,
): WebConfig {
  const meta = doc.querySelector(`meta[name="${CONFIG_META_NAME}"]`);
  const content = meta?.getAttribute("content");
  if (content === null || content === undefined) return devWebConfig(loc);
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new WebConfigError(`${CONFIG_META_NAME} is not valid JSON`, { cause });
  }
  const parsed = WebConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new WebConfigError(`${CONFIG_META_NAME} is invalid: ${issues.join("; ")}`);
  }
  return parsed.data;
}

/** True when the page was served by Vite rather than the FundRoom server. */
export function isDevConfig(config: WebConfig): boolean {
  return config.serverVersion === "dev";
}

const CapabilityAuthSchema = z.object({
  auth: z.object({ methods: z.array(z.enum(AUTH_METHODS)), passkeyRpId: z.string() }),
});

/**
 * Dev only: take auth methods from the running server's capability document (its A-2 name; the
 * server also answers the pre-rename `/.well-known/seed-host.json` for one minor release).
 */
export async function refreshDevAuth(
  config: WebConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WebConfig> {
  try {
    const res = await fetchImpl(`${config.basePath}/.well-known/fundroom.json`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return config;
    const parsed = CapabilityAuthSchema.safeParse(await res.json());
    return parsed.success ? { ...config, auth: parsed.data.auth } : config;
  } catch {
    return config;
  }
}
