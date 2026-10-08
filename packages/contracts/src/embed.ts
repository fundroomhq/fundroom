import { z } from "@hono/zod-openapi";
import { TimestampSchema } from "./schemas.js";

/*
 * Embed (E2.2, EXECUTION_PLAN §9.3, design/08, ADR-0008/0009/0040).
 *
 * Handlers live in `apps/server/src/routes/embed.ts` — kernel routes behind a `required`
 * manifest, the shape E1.1 used for `access`, E1.6 for `compliance`, E1.7 for `branding` and
 * E2.1 for `domains`. The reason is the same one custom domains had and is worth restating: the
 * framing allow-list becomes a response *header*, computed by the kernel's security-headers
 * middleware before the handler runs and before module enablement is consulted. A module that
 * owned it could be switched off, and a switched-off framing control fails open — the portal
 * would keep rendering in an iframe with no `frame-ancestors` at all. A security header must not
 * be owned by something that can be disabled.
 *
 * Three surfaces are deliberately NOT here, because they are not OpenAPI operations:
 *   - `${basePath}/embed/<slug>/theme.json` — public DTCG tokens, cacheable, CORS-open.
 *   - `${basePath}/embed/<version>/embed.(js|mjs)` and `.../manifest.json` — the loader.
 *   - `${basePath}/embed/<slug>/...` — the SPA document itself.
 * All three are unauthenticated static-ish responses in the same category as `/healthz` and
 * `/assets/*`: no session, no tenant data beyond the branding that the sign-in page already
 * serves publicly. They are registered ahead of the SPA catch-all in `app.ts` and covered by
 * integration tests rather than by the authz matrix, which describes API operations.
 *
 * The enum values and limits are spelled out rather than imported from `@fundroom/domain`:
 * this package keeps no `@fundroom/*` dependencies so the generated SDK builds from the contract
 * alone. `packages/domain/src/embed/embed-origins.ts` is the authority and a unit test there
 * pins the two lists together.
 */

export const EmbedOriginSchema = z.string().trim().max(255).openapi({
  description:
    "An https:// origin with no path (http:// only on loopback). Wildcards are refused; the only wildcards in the product are the curated builder-preview patterns behind allowPreviewOrigins.",
  example: "https://acme.com",
});

export const HandoffKeySchema = z
  .object({
    /** JWS `kid`. */
    id: z.string(),
    /** Raw Ed25519 public key, 32 bytes, base64url. The private half never leaves the host. */
    publicKey: z.string(),
    label: z.string(),
    addedAt: TimestampSchema,
  })
  .openapi("EmbedHandoffKey");

export const HandoffKeyInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    publicKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .openapi({ description: "32-byte Ed25519 public key, base64url, unpadded" }),
    label: z.string().trim().max(80).default(""),
  })
  .openapi("EmbedHandoffKeyInput");

export const EmbedSettingsSchema = z
  .object({
    origins: z.array(EmbedOriginSchema),
    allowPreviewOrigins: z.boolean(),
    trustHostIdentity: z.boolean(),
    handoffKeys: z.array(HandoffKeySchema),
    /**
     * The rendered `frame-ancestors` source list, read-only. Derived on every read, never
     * stored: a stored copy is wrong the moment the origin list or the toggle changes, and
     * wrong asymmetrically — the screen would claim one allow-list while the header sent
     * another. (E1.7 made the same call for theme tokens, E2.1 for DNS records.)
     */
    frameAncestors: z.array(z.string()),
    /** What `allowPreviewOrigins` adds, so the screen can name them in its warning. */
    previewOriginPatterns: z.array(z.string()),
    /** Where the iframe points: the workspace's canonical origin plus `/embed/<slug>`. */
    embedUrl: z.string(),
    /** Where the loader is served from on this install (self-hosters have no CDN). */
    loaderUrl: z.string(),
    /** Subresource-integrity value for `loaderUrl`, for a pinned snippet. */
    loaderIntegrity: z.string(),
    /** The pinned, immutable loader URL the SRI value belongs to. */
    loaderPinnedUrl: z.string(),
  })
  .openapi("EmbedSettings");

export const EmbedSettingsPatchBody = z
  .object({
    origins: z.array(EmbedOriginSchema).max(20).optional(),
    allowPreviewOrigins: z.boolean().optional(),
    trustHostIdentity: z.boolean().optional(),
    /**
     * The complete list, not a delta: a key that is absent is removed. `addedAt` is stamped by
     * the server, and preserved for a key that was already registered under the same id and
     * public key.
     */
    handoffKeys: z.array(HandoffKeyInputSchema).max(4).optional(),
  })
  .openapi("EmbedSettingsPatch");

/**
 * A signed host-identity assertion (design/08 §3 option B).
 *
 * Compact JWS, EdDSA (Ed25519) only. Claims: `iss` (the host origin), `aud` (the workspace
 * slug), `sub` (the investor's email address), `iat`, `exp` (≤ 60 s after `iat`), `jti`. It
 * arrives in a POST body rather than a URL because a URL is logged, refereed, shared and kept
 * in history (ADR-0009).
 */
export const HandoffBody = z
  .object({
    assertion: z
      .string()
      .trim()
      .min(32)
      .max(4096)
      // Three base64url segments. Stated as a pattern so the document says what `trim` and
      // `min` already mean together: whitespace is not part of the 32.
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
      .openapi({ description: "Compact JWS (EdDSA), signed by a registered handoff key" }),
  })
  .openapi("EmbedHandoffRequest");

export const HandoffResultSchema = z
  .object({
    ok: z.literal(true),
    /**
     * `auth_level` 0: the host asserted this identity, nobody proved it to us. Every step-up
     * gate in the product still applies, which is the point.
     */
    authLevel: z.literal(0),
  })
  .openapi("EmbedHandoffResult");

export type EmbedSettings = z.output<typeof EmbedSettingsSchema>;
export type EmbedSettingsPatch = z.output<typeof EmbedSettingsPatchBody>;
export type HandoffKey = z.output<typeof HandoffKeySchema>;
