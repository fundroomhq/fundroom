import { z } from "zod";

/*
 * The `embed` block of `core.workspace.settings` (E2.2, EXECUTION_PLAN §9.3, design/08 §1c/§6,
 * ADR-0008/0009/0040) and the pure rules that turn it into a `frame-ancestors` list and an
 * allow/deny answer for one observed origin.
 *
 * Why settings and not a table: `frame-ancestors` must be resolved *before* the embed document
 * handler runs (packages/http resolves it ahead of `next()` so a failing lookup can never serve
 * a framed page without the header), on every request. `ResolvedWorkspace` already carries the
 * whole `settings` jsonb on every resolved request, so the allow-list costs no query and has no
 * cache to invalidate — the mistake E1.7 recorded about synchronous resolvers reading a cache
 * that can be cold. An origin list is configuration, not an entity: a handful of strings, no
 * lifecycle of its own, nothing to join against.
 *
 * There is deliberately no embed key. See ADR-0040: an unauthenticated public identifier that
 * gates nothing is either theatre or a rotation footgun, and `<slug>.<canonical>` plus
 * `/w/<slug>` already make the slug public.
 */

/**
 * Builder preview origins, enabled per workspace by `allowPreviewOrigins`.
 *
 * These are wildcards, and every site on the builder shares them: while the toggle is on, any
 * Webflow/Framer/Wix/Squarespace site can frame this workspace's portal. That is the documented
 * trade (design/08 §2, plan §9.3 "enabled during setup with a warning to tighten") — the
 * customer cannot know their published origin until they publish, and a portal that will not
 * render in the builder's preview reads as broken. The admin screen says to turn it off once the
 * real origin is on the list; nothing turns it off automatically, because a workspace that never
 * leaves a builder preview is a legitimate configuration.
 *
 * Deliberately absent: `*.notion.site` / `notion.so`. Notion pages are public by default, so an
 * embed there is reachable by anyone with the link; a workspace that wants it adds the exact
 * origin by hand and owns that decision (design/08 §2).
 */
export const PREVIEW_ORIGIN_PATTERNS = [
  "https://*.webflow.io",
  "https://*.framer.app",
  "https://*.framer.website",
  "https://*.wixsite.com",
  "https://*.wix.com",
  "https://*.squarespace.com",
] as const;

/** Most origins a workspace may list. A portal serves one company's site, not a network. */
export const MAX_EMBED_ORIGINS = 20;

/** Most handoff verification keys a workspace may register (rotation needs two; four is slack). */
export const MAX_HANDOFF_KEYS = 4;

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EXACT_ORIGIN_RE = new RegExp(
  `^https://${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::[1-9][0-9]{0,4})?$`,
  "u",
);
const LOCAL_ORIGIN_RE = new RegExp(
  `^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|${HOST_LABEL}\\.localhost)(?::[1-9][0-9]{0,4})?$`,
  "u",
);
const WILDCARD_ORIGIN_RE = new RegExp(`^https://\\*\\.${HOST_LABEL}(?:\\.${HOST_LABEL})+$`, "u");

/**
 * Normalises one admin-entered origin, or returns `undefined` when it is not one we will accept.
 *
 * Accepted: an `https://` origin with no path, query, fragment or credentials, and `http://` on
 * loopback only. A cookie with `Secure; Partitioned` cannot be set from an `http:` page at all
 * (design/08 §7 "Mixed content"), so accepting a plain-http customer origin would store a value
 * that can only ever produce the "open in a new tab" fallback; loopback is exempt because
 * browsers treat it as a secure context and local development is the one place it is useful.
 *
 * Refused: wildcards. A customer-entered `https://*.acme.com` looks like a convenience and is
 * really an instruction to trust every host anyone can put under that zone, including a stale
 * staging box or a subdomain-takeover target. The only wildcards in the product are
 * `PREVIEW_ORIGIN_PATTERNS`, which we curate, and they arrive through one boolean.
 */
export function normalizeEmbedOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  // Upper case, a trailing slash and an explicit default port are spellings of the same origin
  // and are canonicalised. Anything that carries *more* than an origin is refused rather than
  // repaired: an admin who pasted a page URL meant something we would have to guess at, and
  // silently keeping the host while dropping the path is how an allow-list ends up wider than
  // the person editing it believes.
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const origin = url.origin.toLowerCase();
  // `origin` is "null" for a scheme URL cannot give an origin to (data:, javascript:, file:).
  if (origin === "null") return undefined;
  if (EXACT_ORIGIN_RE.test(origin) || LOCAL_ORIGIN_RE.test(origin)) return origin;
  return undefined;
}

export const EmbedOriginSchema = z
  .string()
  .trim()
  .max(255)
  .refine((v) => normalizeEmbedOrigin(v) !== undefined, {
    message:
      "an https:// origin with no path (http:// only on loopback); wildcards are not allowed",
  })
  .transform((v) => normalizeEmbedOrigin(v) as string);

/**
 * An Ed25519 public key a host's server may sign handoff assertions with (design/08 §3 option B).
 *
 * The *public* half only, so there is no secret of ours at rest and none in the settings jsonb
 * that every request already carries. The host generates the pair (in PHP, `sodium`'s
 * `crypto_sign_keypair` is core since 7.2) and keeps the private half; we never see it, and a
 * compromise of our database cannot mint an assertion.
 */
export const HandoffKeySchema = z
  .object({
    /** JWS `kid`. Short, host-chosen, opaque to us. */
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    /** Raw Ed25519 public key, 32 bytes, base64url, unpadded. */
    publicKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/u, "32-byte Ed25519 public key, base64url"),
    /** Free-text note so an admin can tell two keys apart ("acme.com WordPress"). */
    label: z.string().trim().max(80).default(""),
    addedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** E2.2 owns `embed`. */
export const EmbedSettingsSchema = z
  .object({
    /**
     * Exact origins allowed to frame `/embed/<slug>`. This list *is* the framing control: it
     * becomes `frame-ancestors`, and the embed document independently refuses a request whose
     * observed initiator is not on it.
     */
    origins: z.array(EmbedOriginSchema).max(MAX_EMBED_ORIGINS).default([]),
    /** Add `PREVIEW_ORIGIN_PATTERNS`; see the warning on that constant. */
    allowPreviewOrigins: z.boolean().default(false),
    /**
     * Accept a signed handoff assertion from the host's server as proof of who the visitor is
     * (design/08 §3 option B). Off by default and worth reading as what it is: a host-site
     * compromise becomes investor impersonation in this workspace. Mitigated by a 60-second
     * assertion, single use, an existing membership requirement, `auth_level` 0 (so the data
     * room's step-up still asks), and an audit event per use.
     */
    trustHostIdentity: z.boolean().default(false),
    handoffKeys: z.array(HandoffKeySchema).max(MAX_HANDOFF_KEYS).default([]),
  })
  .prefault({});

export type EmbedSettings = z.output<typeof EmbedSettingsSchema>;
export type HandoffKey = z.output<typeof HandoffKeySchema>;

/**
 * The `frame-ancestors` source list for this workspace's embed tree.
 *
 * `'self'` is always present: the admin screen previews the embed in an iframe on our own
 * origin, and a same-origin frame can reach nothing that same-origin script could not already.
 * An empty result is impossible, so `frameAncestorsSources()` never has to fall back to
 * `'none'` for a workspace that simply has not been configured yet — the honest answer for one
 * with no listed origins is "only we may frame it", not "nobody may".
 */
export function embedFrameAncestors(settings: EmbedSettings): readonly string[] {
  return [
    "'self'",
    ...settings.origins,
    ...(settings.allowPreviewOrigins ? PREVIEW_ORIGIN_PATTERNS : []),
  ];
}

/** Does `pattern` (exact origin, or `https://*.example.com`) cover `origin`? */
export function originMatchesPattern(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (!WILDCARD_ORIGIN_RE.test(pattern)) return false;
  const suffix = pattern.slice("https://*".length); // ".example.com"
  if (!origin.startsWith("https://")) return false;
  const host = origin.slice("https://".length);
  // A wildcard covers subdomains, never the bare domain: `*.webflow.io` is every customer's
  // preview, and `webflow.io` is Webflow's own marketing site.
  return host.endsWith(suffix) && host.length > suffix.length;
}

/**
 * May `origin` frame this workspace's embed tree? `selfOrigin` is the portal's own origin, which
 * `'self'` stands for in the CSP.
 */
export function isAllowedEmbedOrigin(
  settings: EmbedSettings,
  origin: string,
  selfOrigin: string,
): boolean {
  const normalized = origin.trim().toLowerCase();
  if (normalized === "" || normalized === "null") return false;
  if (normalized === selfOrigin.trim().toLowerCase()) return true;
  if (settings.origins.includes(normalized)) return true;
  if (!settings.allowPreviewOrigins) return false;
  return PREVIEW_ORIGIN_PATTERNS.some((p) => originMatchesPattern(p, normalized));
}

/** Is any origin at all allowed to frame this workspace, beyond our own? */
export function isEmbedConfigured(settings: EmbedSettings): boolean {
  return settings.origins.length > 0 || settings.allowPreviewOrigins;
}
