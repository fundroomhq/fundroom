import { z } from "@hono/zod-openapi";
import { InviteGrantBodySchema } from "./access.js";
import { EmailSchema, TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Share links (E2.3, EXECUTION_PLAN §9.3, design/05 §5, ADR-0041).
 *
 * Handlers live in `apps/server/src/routes/links.ts` — kernel routes behind a `required`
 * `share-links` manifest, the `access` / `compliance` / `branding` / `domains` / `embed`
 * precedent. The services are `@fundroom/share-links`.
 *
 * Two audiences, and the split is the whole design:
 *
 *  - **Three public routes** keyed on the link's *token*, for somebody who has no session, no
 *    membership and no account yet. They are the only surface a stranger can reach, and every
 *    "no" they can provoke about the link's existence is the same 404 (D7): unknown, revoked,
 *    paused, expired and exhausted are one answer, because a caller who could tell them apart
 *    could enumerate live links — and that a link *exists* is already the interesting fact about
 *    a confidential data room.
 *  - **Six admin routes** keyed on the link's *id*, behind `share-links.read` / `.manage`. These
 *    read the row directly, so the real reason a visitor was refused lives here (and in the
 *    `share_link.admission_refused` audit entries), where an authenticated admin may see it.
 *
 * The token never appears in an admin path and the id never appears in a public one. That is
 * deliberate (contract C4): if possession of the *id* bought anything, the passcode would be
 * bypassable, because an id — unlike its token — ends up in URLs, logs and admin screens.
 *
 * The plaintext token exists exactly once, in the response to `POST /links`. The column holds
 * `sha256(token)`; nothing can show it again.
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema: `.nullable()` on a
 * `.openapi("X")` schema marks the *component* nullable and the SDK type becomes `X | null`
 * everywhere it is used.
 */

/** Mirrors `core.share_link_status`. The database enum is the authority. */
export const ShareLinkStatusSchema = z.enum(["active", "paused", "revoked"]).openapi({
  description:
    "`active` admits and grants; `paused` is a reversible stop that ALSO suspends everyone the link already admitted; `revoked` is final",
  example: "active",
});

/**
 * 32 bytes of base64url (43 characters) as `mintToken()` produces it. The bound is here so an
 * unauthenticated prober cannot make the server hash and index-probe arbitrary input; the
 * service checks the same thing again (`isPlausibleToken`).
 */
export const ShareLinkTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, "base64url")
  .openapi({
    description: "The link's secret. Shown once, at creation, and stored only as a sha256.",
    example: "8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA",
  });

export const ShareLinkTokenParams = z.object({ token: ShareLinkTokenSchema });
export const ShareLinkIdParams = z.object({ id: UuidSchema });

/**
 * A link's admission policy (`core.share_link.policy`, schema version 1).
 *
 * `domains` are bare, lower-cased domains with no leading `@`, and they do **not** admit
 * subdomains: `acme.com` admits `jane@acme.com` and refuses `jane@mail.acme.com`. That is a
 * decision rather than an oversight — subdomains of a corporate domain are routinely delegated
 * to third parties, and under Rule 506(b) the size of the audience is the whole question. An
 * admin who wants a subdomain adds it explicitly.
 *
 * Empty `domains` **and** empty `emails` is an "any verified email" link, which is legal under
 * `506c` and `closed` and refused under `506b` (`audience_too_open`).
 */
export const LinkPolicySchema = z
  .object({
    domains: z
      .array(z.string().min(1).max(253))
      .max(100)
      .default([])
      .openapi({ example: ["acme.com"] }),
    emails: z.array(EmailSchema).max(200).default([]),
    /** A link may force watermarking on; it may never turn an inherited watermark off. */
    forceWatermark: z.boolean().default(false),
  })
  .openapi("LinkPolicy");

/** What the admin list shows. Never the token, never the passcode, never either digest. */
export const ShareLinkSchema = z
  .object({
    id: UuidSchema,
    label: z.string(),
    status: ShareLinkStatusSchema,
    policy: LinkPolicySchema,
    grants: z.array(InviteGrantBodySchema),
    groupIds: z.array(UuidSchema),
    /** Whether a passcode is set — never the passcode, and never its hash. */
    passcodeRequired: z.boolean(),
    /** `null` = no cap. `uses` counts distinct memberships admitted (design/05 §5). */
    maxUses: z.union([z.number().int().positive(), z.null()]),
    uses: z.number().int().nonnegative(),
    /** `null` = no cap. `views` counts distinct view *sessions*, not requests (design/05 §4.4). */
    maxViews: z.union([z.number().int().positive(), z.null()]),
    views: z.number().int().nonnegative(),
    expiresAt: z.union([TimestampSchema, z.null()]),
    createdBy: z.union([UuidSchema, z.null()]),
    createdAt: TimestampSchema,
    revokedAt: z.union([TimestampSchema, z.null()]),
    /** Live bindings: memberships this link admitted and has not had individually revoked. */
    visits: z.number().int().nonnegative(),
  })
  .openapi("ShareLink");

export const ShareLinkListSchema = z
  .object({ links: z.array(ShareLinkSchema) })
  .openapi("ShareLinkList");

export const ShareLinkListQuery = z.object({
  status: ShareLinkStatusSchema.optional(),
  /**
   * Spelled as an explicit `"true" | "false"` rather than a coerced boolean: a query string has
   * no booleans, and `z.coerce.boolean()` reads `?includeRevoked=false` as **true** — the kind of
   * bug that only surfaces in the one screen that bothers to pass the flag.
   */
  includeRevoked: z.enum(["true", "false"]).default("false").openapi({
    description: "Revoked links are omitted by default: the list is about live sharing",
  }),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const ShareLinkCreateBody = z.object({
  label: z.string().min(1).max(200),
  policy: LinkPolicySchema.optional(),
  grants: z.array(InviteGrantBodySchema).max(50).default([]),
  groupIds: z.array(UuidSchema).max(50).default([]),
  /**
   * Plaintext, stored only as a keyed HMAC and never returned by anything. A passcode is
   * *admission*, not a gate (D3): what it buys is that a forwarded URL without it admits nobody,
   * and that is a question asked before any principal exists.
   */
  passcode: z.string().min(6).max(128).optional(),
  maxUses: z.number().int().positive().optional(),
  maxViews: z.number().int().positive().optional(),
  expiresAt: TimestampSchema.optional(),
});

/** The **only** time the plaintext token exists on the wire. */
export const ShareLinkCreatedSchema = z
  .object({
    link: ShareLinkSchema,
    token: ShareLinkTokenSchema,
    /** The absolute URL to send, on the workspace's own origin (a custom domain when it has one). */
    url: z.url().openapi({
      example: "https://investors.acme.com/s/8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA",
    }),
  })
  .openapi("ShareLinkCreated");

export const ShareLinkRevokeBody = z.object({
  /**
   * Also cut the link's **bindings** to the memberships it admitted (`core.share_link_visit`).
   *
   * Read the name precisely: it does not end anybody's membership, and it must not. The people
   * the link let in are members now, hold their own sessions, and may have access from groups and
   * grants that have nothing to do with this link. What this flag removes is the edge the
   * evaluator walks — so the access *the link* gave them ends, and everything else they hold
   * survives. Ending a membership is the membership-revocation path, which is a different
   * decision with a different confirmation.
   *
   * It defaults to `false` because design/05 §5 makes it the admin's explicit choice, and because
   * the common case — a link that has served its purpose — is not a reason to evict its visitors.
   */
  revokeMemberships: z.boolean().default(false),
});

/** One membership the link admitted, for the "who came in through this link" list. */
export const ShareLinkVisitSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    email: z.union([z.string(), z.null()]),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    views: z.number().int().nonnegative(),
    revokedAt: z.union([TimestampSchema, z.null()]),
  })
  .openapi("ShareLinkVisit");

export const ShareLinkVisitListSchema = z
  .object({ visits: z.array(ShareLinkVisitSchema) })
  .openapi("ShareLinkVisitList");

// --- the public surface -------------------------------------------------------------------------

/**
 * What a stranger holding a token is told, and it is deliberately almost nothing.
 *
 * `valid` is always `true` on a 200: a token that does not resolve — unknown, revoked, paused,
 * expired or exhausted — answers **404**, the same as an unknown path (D7), so the field is the
 * shape the client branches on rather than a second channel. It is kept because the landing
 * screen holds one response type either way.
 *
 * The target resource's name is **not** here and must never be: the whole point of admission is
 * that it happens before anyone is inside. `emailHint` is a masked address and appears only when
 * the link names exactly one, which is the case where it helps a visitor ("which of my addresses
 * was this sent to?") without widening what a leaked URL reveals.
 */
export const ShareLinkResolutionSchema = z
  .object({
    valid: z.literal(true),
    requiresPasscode: z.boolean(),
    workspaceName: z.string().optional(),
    /** `a***@acme.com`, and only for a link that names exactly one address. */
    emailHint: z.string().optional(),
  })
  .openapi("ShareLinkResolution");

export const ShareLinkStartBody = z.object({
  email: EmailSchema,
  passcode: z.string().min(1).max(128).optional(),
});

/**
 * Identical for an address the link admits and one it does not, and identical whether or not a
 * mail was actually sent — the `/auth/otp/start` contract, for the same anti-enumeration reason,
 * with a `withMinimumDuration` floor so the timing does not answer what the body refuses to.
 */
export const ShareLinkStartResultSchema = z
  .object({
    status: z.literal("sent"),
    emailHint: z.string(),
    ttlMinutes: z.number().int().positive(),
  })
  .openapi("ShareLinkStartResult");

export const ShareLinkVerifyBody = z.object({
  email: EmailSchema,
  code: z.string().min(4).max(16),
  rememberDevice: z.boolean().default(false),
});
