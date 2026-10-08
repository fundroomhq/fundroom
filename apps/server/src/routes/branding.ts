import { createHash } from "node:crypto";
import {
  brandThemeDocument,
  brandThemeTokens,
  checkLogo,
  contrastReport,
  LOGO_MAX_BYTES,
  type LogoRejection,
  logoCandidates,
} from "@fundroom/branding";
import {
  ApiError,
  type ApiErrorCode,
  branding as b,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import {
  lockWorkspaceFacts,
  type ResolvedWorkspace,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import { type BrandLogo, parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import type { EmailBrand } from "@fundroom/mail";
import { type JsonObject, OutboundHttpError } from "@fundroom/ports";
import { brandingLogoKey } from "@fundroom/storage";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { mountedUrl } from "../path-mount.js";
import { type ApiDeps, brandingLogoUrl } from "./deps.js";

/*
 * Branding (E1.7, EXECUTION_PLAN §12 "branding basics", design/03 F1, design/08 §4).
 *
 * Kernel routes behind a `required` manifest, for the third time and the same reason E1.1's
 * `access` and E1.6's `compliance` gave: every fact lives on `core.workspace` — here the
 * `branding` block of the `settings` jsonb — and a module package reaching into `core.*`
 * would break the boundary that makes modules safe to reason about.
 *
 * Three things in this file are deliberate and worth stating:
 *
 *  1. **Tokens are derived, never stored.** `GET /branding` returns `tokens` and `contrast`
 *     read-only; `PATCH` accepts only the small brand. A workspace that could post a token
 *     map could make its own portal unreadable, and the design system could never add a
 *     token without migrating every stored theme.
 *  2. **The logo is ours to serve.** The bytes land in object storage under
 *     `ws/<ws>/branding/<sha256>` and come back from `GET /branding/logo` on our own origin.
 *     Hot-linking the customer's marketing host would leak every portal view and every email
 *     open to that host and would break the day they redesign. The content type is decided by
 *     the BYTES (`checkLogo`), never by the request's `Content-Type` or a file name, because
 *     the stored value is echoed as a response header on a route anyone may call.
 *  3. **`GET /branding/logo` and `GET /branding/theme` are public.** The logo route is what an
 *     email's `<img src>` points at, and a mail client carries no session; the theme route is
 *     what an unauthenticated sign-in page themes itself from. Both are GETs, so the CSRF
 *     middleware never looks at them, and neither reveals anything the portal's own landing
 *     page does not already show.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 415, 429, 500, 503);
const TAGS = ["branding"];

/** Five minutes with revalidation: long enough to matter, short enough that a change shows. */
const LOGO_CACHE_CONTROL = "public, max-age=300, must-revalidate";

/** Binary response shape for the OpenAPI document (the SDK treats it as a blob). */
const binaryResponse = (description: string) => ({
  description,
  content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } },
});

interface Signed {
  readonly tenant: NonNullable<AppEnv["Variables"]["tenant"]>;
  readonly workspace: ResolvedWorkspace;
}

function signed(c: Context<AppEnv>): Signed {
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!tenant || !workspace) throw new ApiError("unauthenticated");
  return { tenant, workspace };
}

/** The resolved workspace, for the two routes that serve anyone. */
function anyWorkspace(c: Context<AppEnv>): ResolvedWorkspace {
  const workspace = c.get("workspace");
  if (workspace === undefined) throw new ApiError("setup_required");
  return workspace;
}

/** `BrandingSchema`: the stored block, plus everything derived from it. */
function brandingBody(c: Context<AppEnv>, deps: ApiDeps, workspace: ResolvedWorkspace) {
  const brand = parseWorkspaceSettings(workspace.settings).branding;
  return {
    displayName: brand.displayName,
    tagline: brand.tagline,
    accentColor: brand.accentColor,
    fontFamily: brand.fontFamily,
    radius: brand.radius,
    logo:
      brand.logo === null
        ? null
        : {
            // Same-origin on a mounted page (E3.9; the CSP's img-src is 'self').
            url:
              mountedUrl(c, `/api/v1/branding/logo?v=${brand.logo.sha256.slice(0, 16)}`) ??
              brandingLogoUrl(deps, workspace, brand.logo),
            contentType: brand.logo.contentType,
            width: brand.logo.width,
            height: brand.logo.height,
            bytes: brand.logo.bytes,
            source: brand.logo.source,
            updatedAt: brand.logo.updatedAt,
          },
    supportEmail: brand.supportEmail,
    showPoweredBy: brand.showPoweredBy,
    tokens: brandThemeTokens(brand),
    contrast: contrastReport(brand).map((f) => ({ ...f })),
    // The name actually rendered. `displayName` is an override, not a rename: `workspace.name`
    // stays the legal-ish name the setup wizard captured and the audit trail refers to.
    effectiveName: brand.displayName ?? workspace.name,
  };
}

/**
 * Why a logo was refused, in words the founder can act on. Every reason maps onto an error
 * code that already exists — inventing a `logo_rejected` code would make one more thing for
 * every client to branch on when the status and the message already say it.
 */
const LOGO_REJECTIONS: Record<LogoRejection, { code: ApiErrorCode; message: string }> = {
  empty: { code: "invalid_request", message: "the logo is empty" },
  too_large: {
    code: "payload_too_large",
    message: `the logo must be ${LOGO_MAX_BYTES / 1024} KiB or smaller`,
  },
  unsupported_type: {
    code: "unsupported_media_type",
    message: "the logo must be a PNG, JPEG or WebP image (SVG is not accepted)",
  },
  corrupt: { code: "invalid_request", message: "the image header does not parse" },
  too_small: { code: "invalid_request", message: "the logo is smaller than 32×32 pixels" },
  too_wide: { code: "invalid_request", message: "the logo is larger than 2048×2048 pixels" },
};

function rejectLogo(reason: LogoRejection): never {
  const { code, message } = LOGO_REJECTIONS[reason];
  throw new ApiError(code, message, { reason });
}

/**
 * An `OutboundHttpError` is the guard doing its job, not the server failing: the founder typed
 * a host that does not resolve, or one that resolves somewhere we refuse to go. Every code
 * becomes a 4xx naming the URL, because a 500 here would send them to support for something
 * only they can fix.
 */
function rejectOutbound(error: OutboundHttpError): never {
  const message =
    error.code === "response_too_large"
      ? "that page is too large to read"
      : error.code === "timeout"
        ? "that site did not answer in time"
        : error.code === "dns_failed"
          ? "that host does not resolve"
          : "that address cannot be fetched from here";
  throw new ApiError(
    error.code === "response_too_large" ? "payload_too_large" : "invalid_request",
    message,
    { reason: error.code, ...(error.url === undefined ? {} : { url: error.url }) },
  );
}

/**
 * Anything else the fetch throws is the network (connection refused or reset, TLS failure, a
 * body cut off mid-read): the site the founder named, not this server, is what failed. The
 * cause is not repeated, because undici's messages can quote the URL including its query.
 */
function rejectUnreachable(): never {
  throw new ApiError("invalid_request", "that site could not be reached", {
    reason: "unreachable",
  });
}

/** Bytes of a guarded response, refusing anything past the logo cap before it is buffered. */
async function boundedBytes(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) rejectLogo("too_large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > LOGO_MAX_BYTES) rejectLogo("too_large");
  return bytes;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function registerBrandingRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string) => requirePermission({ authz: () => deps.authz }, p);

  /**
   * Writes the `branding` block, and only that block (A-3 R2 M1). The patch is merged into the
   * block as the row-locked transaction reads it (`lockWorkspaceFacts`), never the request's
   * cached copy, so a concurrent branding save is not undone field by field; and the write sets
   * the `branding` key alone (`updateWorkspaceSettingsBlock`), so a concurrent writer of another
   * block (Q&A switched off, say) keeps its change. Row lock first, audit last (E3.5 LX).
   */
  async function writeBranding(
    c: Context<AppEnv>,
    s: Signed,
    patch: Record<string, unknown>,
    audit: { action: string; meta: JsonObject },
  ) {
    const next = await deps.db.withTenant(s.tenant, async (tx) => {
      const current = parseWorkspaceSettings(
        (await lockWorkspaceFacts(tx, s.workspace.id))?.settings,
      );
      const next = WorkspaceSettingsSchema.parse({
        ...current,
        branding: { ...current.branding, ...patch },
      });
      await updateWorkspaceSettingsBlock(tx, s.workspace.id, "branding", next.branding);
      await deps.audit.record(tx, s.tenant, {
        action: audit.action,
        resourceKind: "workspace",
        resourceId: s.workspace.id,
        requestId: requestIdOf(c),
        diff: { before: { ...current.branding }, after: { ...next.branding } },
        meta: audit.meta,
      });
      return next;
    });
    // The resolved workspace carries `settings`, and the SSR config, the theme route and the
    // email brand resolver all read it: a stale cached workspace would keep serving the old
    // brand to every page and every send.
    deps.resolver.invalidate();
    // `signed()` handed us the request's copy; return the body from the row we just wrote.
    return brandingBody(c, deps, { ...s.workspace, settings: next });
  }

  /** Best-effort: the old object is nobody's any more, but its absence is not an error. */
  async function forgetLogo(previous: BrandLogo | null, keepKey?: string): Promise<void> {
    if (previous === null || previous.key === keepKey) return;
    await deps.storage.delete(previous.key).catch(() => undefined);
  }

  // --- the brand ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/branding",
      tags: TAGS,
      summary: "The workspace brand, with the theme tokens and contrast report derived from it",
      description:
        "`tokens` and `contrast` are read-only derivations of the fields above them: the portal themes itself from `tokens` and the admin form warns from `contrast`. `effectiveName` is `displayName` or, when that is null, the workspace's own name.",
      security: sessionSecurity,
      "x-requires": "branding.read",
      middleware: [perm("branding.read")] as const,
      responses: { 200: jsonResponse(b.BrandingSchema, "Branding"), ...ERRORS },
    }),
    async (c) => c.json(brandingBody(c, deps, signed(c).workspace), 200),
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/branding",
      tags: TAGS,
      summary: "Change the workspace brand",
      description:
        "Only the small brand is settable — one colour, a bundled font stack, a corner radius, the names and the support address. The `--sh-*` tokens are derived from it and returned; they are never accepted, so a workspace cannot post a palette that makes its own portal unreadable. A colour whose hue cannot reach WCAG AA is not refused: the derivation pushes each pair as far as the hue allows and `contrast` reports what it could not reach.",
      security: sessionSecurity,
      "x-requires": "branding.manage",
      middleware: [perm("branding.manage")] as const,
      request: { body: jsonBody(b.BrandingPatchBody) },
      responses: { 200: jsonResponse(b.BrandingSchema, "Branding"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const patch = c.req.valid("json");
      return c.json(
        await writeBranding(c, s, patch, {
          action: "branding.settings_changed",
          meta: { fields: Object.keys(patch) },
        }),
        200,
      );
    },
  );

  // --- the logo -------------------------------------------------------------------------------
  /** Shared by the upload and the website import: store the bytes, then record them. */
  async function storeLogo(
    c: Context<AppEnv>,
    s: Signed,
    bytes: Uint8Array,
    info: { contentType: string; width: number; height: number },
    source: "upload" | "website",
  ) {
    const sha256 = sha256Of(bytes);
    const key = brandingLogoKey(s.workspace.id, sha256);
    await deps.storage.put(key, bytes, {
      contentType: info.contentType,
      contentLength: bytes.byteLength,
      sha256,
      cacheControl: LOGO_CACHE_CONTROL,
    });
    const previous = parseWorkspaceSettings(s.workspace.settings).branding.logo;
    const result = await writeBranding(
      c,
      s,
      {
        logo: {
          key,
          contentType: info.contentType,
          width: info.width,
          height: info.height,
          bytes: bytes.byteLength,
          sha256,
          source,
          updatedAt: new Date().toISOString(),
        },
      },
      { action: "branding.logo_changed", meta: { source, sha256, bytes: bytes.byteLength } },
    );
    await forgetLogo(previous, key);
    return result;
  }

  api.openapi(
    createRoute({
      method: "post",
      path: "/branding/logo",
      tags: TAGS,
      summary: "Upload the workspace logo",
      description:
        "Base64 bytes in a JSON body: a logo is capped at 1 MiB, well inside the ordinary API body limit, so this needs none of the resumable upload machinery the data room has. The stored content type comes from the image header, never from `contentType` or a file name, and SVG is refused outright — serving one from our own origin would hand a workspace admin stored XSS on the portal.",
      security: sessionSecurity,
      "x-requires": "branding.manage",
      middleware: [perm("branding.manage")] as const,
      request: { body: jsonBody(b.LogoUploadBody) },
      responses: { 200: jsonResponse(b.BrandingSchema, "Branding"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const bytes = new Uint8Array(Buffer.from(body.data, "base64"));
      const check = checkLogo(bytes);
      if (!check.ok) rejectLogo(check.reason);
      const logo = await storeLogo(c, s, bytes, check.info, "upload");
      return c.json(logo, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/branding/logo/fetch",
      tags: TAGS,
      summary: "Import the logo from the company website",
      description:
        "Fetches the page through the SSRF-guarded outbound client (DNS pre-resolve, private ranges refused, pinned address, redirects re-checked per hop), reads its Open Graph image and favicon links, and tries each candidate **through the same guard** — never a raw fetch, because a candidate URL comes from a third party's markup and is exactly the string an attacker would aim at the metadata service. The first candidate whose bytes pass `checkLogo` wins.",
      security: sessionSecurity,
      "x-requires": "branding.manage",
      middleware: [perm("branding.manage")] as const,
      request: { body: jsonBody(b.LogoFetchBody) },
      responses: { 200: jsonResponse(b.BrandingSchema, "Branding"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { url } = c.req.valid("json");
      let html: string;
      let finalUrl = url;
      try {
        const page = await deps.outbound.fetch(url, { headers: { accept: "text/html,*/*" } });
        if (!page.ok) {
          throw new ApiError("invalid_request", `that page answered ${page.status}`, {
            status: page.status,
          });
        }
        finalUrl = page.url === "" ? url : page.url;
        html = await page.text();
      } catch (error) {
        if (error instanceof OutboundHttpError) rejectOutbound(error);
        if (error instanceof ApiError) throw error;
        rejectUnreachable();
      }

      const candidates = logoCandidates(html, finalUrl);
      const tried: { url: string; reason: string }[] = [];
      for (const candidate of candidates.slice(0, 8)) {
        try {
          // Re-validated by the guard on its own terms: `logoCandidates` only parses strings
          // out of someone else's markup, it makes no promises about where they point.
          const res = await deps.outbound.fetch(candidate, { headers: { accept: "image/*" } });
          if (!res.ok) {
            tried.push({ url: candidate, reason: `http_${res.status}` });
            continue;
          }
          const bytes = await boundedBytes(res);
          const check = checkLogo(bytes);
          if (!check.ok) {
            tried.push({ url: candidate, reason: check.reason });
            continue;
          }
          return c.json(await storeLogo(c, s, bytes, check.info, "website"), 200);
        } catch (error) {
          if (error instanceof OutboundHttpError || error instanceof ApiError) {
            tried.push({ url: candidate, reason: error.code });
            continue;
          }
          // A candidate that cannot be reached is one more image that did not work out.
          tried.push({ url: candidate, reason: "unreachable" });
        }
      }
      throw new ApiError(
        "invalid_request",
        candidates.length === 0
          ? "that page names no logo we could use; upload one instead"
          : "none of the images that page names is a usable logo; upload one instead",
        { tried },
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/branding/logo",
      tags: TAGS,
      summary: "Remove the workspace logo",
      description:
        "Clears the `logo` block and deletes the stored object. The portal and the emails fall back to the workspace name.",
      security: sessionSecurity,
      "x-requires": "branding.manage",
      middleware: [perm("branding.manage")] as const,
      responses: { 200: jsonResponse(b.BrandingSchema, "Branding"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const previous = parseWorkspaceSettings(s.workspace.settings).branding.logo;
      if (previous === null) throw new ApiError("not_found", "this workspace has no logo");
      const result = await writeBranding(
        c,
        s,
        { logo: null },
        { action: "branding.logo_changed", meta: { source: "removed", sha256: previous.sha256 } },
      );
      await forgetLogo(previous);
      return c.json(result, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/branding/logo",
      tags: TAGS,
      summary: "The workspace logo bytes (public)",
      description:
        "Unauthenticated by design: this is what an investor update's `<img src>` points at, and a mail client carries no session. The response is the stored object with the content type the bytes were sniffed as, an `ETag` of their SHA-256 and a five-minute revalidating cache; `If-None-Match` answers 304. A workspace with no logo answers 404 rather than a placeholder, so a client can tell 'no logo' from 'logo not loaded yet'.",
      "x-requires": "public",
      request: { query: z.object({ v: z.string().max(64).optional() }) },
      responses: {
        200: binaryResponse("The logo"),
        304: { description: "Not modified (`If-None-Match` matched the stored digest)" },
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      const logo = parseWorkspaceSettings(workspace.settings).branding.logo;
      if (logo === null) throw new ApiError("not_found", "this workspace has no logo");
      const etag = `"${logo.sha256}"`;
      const headers = {
        "Cache-Control": LOGO_CACHE_CONTROL,
        ETag: etag,
        // The bytes are not a document: they must never be sniffed into something executable,
        // and they must never be treated as same-origin script by a browser that gets here.
        "X-Content-Type-Options": "nosniff",
      };
      const inm = c.req.header("if-none-match");
      if (inm !== undefined && matchesEtag(inm, logo.sha256)) {
        return c.body(null, 304, headers) as never;
      }
      const read = await deps.storage.get(logo.key);
      // The settings say there is a logo but the bucket disagrees: a 404 is honest, and the
      // admin's next upload fixes it. Answering 500 would page an operator over a stale row.
      if (read === undefined) throw new ApiError("not_found", "the logo object is missing");
      // Length from the object we just read, not from `logo.bytes`: the settings row records
      // what was stored, and if the two ever diverge a stale number would frame the real body
      // and make the response malformed rather than merely wrong. A backend that cannot state
      // a size gets no header at all — chunked is honest, a guess is not.
      const size = read.stat.size;
      const length = Number.isFinite(size) && size > 0 ? { "Content-Length": String(size) } : {};
      return c.body(read.body, 200, {
        ...headers,
        "Content-Type": logo.contentType,
        ...length,
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/branding/theme",
      tags: TAGS,
      summary: "The workspace's theme as a W3C Design Tokens document (public)",
      description:
        "Only this workspace's overrides, so a consumer merges it over the default theme. Public for the same reason the logo is: the sign-in page themes itself before anyone has signed in.",
      "x-requires": "public",
      responses: { 200: jsonResponse(b.ThemeDocumentSchema, "Theme document"), ...ERRORS },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      c.header("Cache-Control", LOGO_CACHE_CONTROL);
      return c.json(brandThemeDocument(parseWorkspaceSettings(workspace.settings).branding), 200);
    },
  );
}

/** `If-None-Match` is a list, may be weak, and `*` matches anything we hold. */
export function matchesEtag(header: string, sha256: string): boolean {
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//u, "").replace(/"/gu, "") === sha256);
}

/**
 * The brand as the mailer needs it, for one workspace. Lives here rather than in the container
 * so the logo URL is built by the same function the API returns, and the two can never drift.
 */
export function emailBrandOf(
  deps: Pick<ApiDeps, "baseUrl" | "tenancy" | "basePath">,
  workspace: ResolvedWorkspace,
  productName: string,
): EmailBrand {
  const settings = parseWorkspaceSettings(workspace.settings);
  const brand = settings.branding;
  return {
    productName,
    workspaceName: brand.displayName ?? workspace.name,
    ...(brand.tagline === null ? {} : { tagline: brand.tagline }),
    ...(brand.logo === null ? {} : { logoUrl: brandingLogoUrl(deps, workspace, brand.logo) }),
    ...(brand.accentColor === null ? {} : { accentColor: brand.accentColor }),
    ...(brand.supportEmail === null ? {} : { supportEmail: brand.supportEmail }),
    ...(settings.updates.postalAddress === null
      ? {}
      : { addressLine: settings.updates.postalAddress }),
    showPoweredBy: brand.showPoweredBy,
  };
}

/**
 * Has this workspace chosen a brand? The setup wizard's progress asks it, and it asks here so
 * the wizard and the branding screen can never disagree about what "done" means.
 *
 * "Has a brand" means the founder has told us something about the company's identity: a name,
 * a tagline, a colour, a logo or a support address. Only the nullable fields count, because
 * only they can distinguish a choice from an absence — `fontFamily`, `radius` and
 * `showPoweredBy` have non-null defaults, so counting them would mark the step done for a
 * workspace nobody has opened yet and the wizard would skip the company step entirely.
 * `supportEmail` counts: it defaults to null, so a value there is someone's decision, and it is
 * rendered as part of the brand in the email footer and the portal's help affordances.
 *
 * The set has to be this wide because the wizard's company step saves a display name and a
 * tagline on their own (it sends `accentColor: null` when the colour is left blank). A narrower
 * test would leave `progress.branding` false after a completed step and `resumeStep()` would
 * send that founder back to `company` on every cold load.
 */
export function hasBrand(workspace: Pick<ResolvedWorkspace, "settings">): boolean {
  const brand = parseWorkspaceSettings(workspace.settings).branding;
  return (
    brand.displayName !== null ||
    brand.tagline !== null ||
    brand.accentColor !== null ||
    brand.logo !== null ||
    brand.supportEmail !== null
  );
}
