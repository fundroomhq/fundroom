import type { OfferingStatus } from "@fundroom/db";

/*
 * Admission (EXECUTION_PLAN §11, design/05 §5, design/04 §4.4, ADR-0041, E2.3).
 *
 * Pure: no database, no clock of its own, no crypto. Everything a share link answers "no" to
 * before a principal exists is decided here, so the same rules run at OTP start, at redemption,
 * in the admin preview and in a unit test with nothing behind them.
 *
 * ## Admission is not a gate
 *
 * A *gate* (`nda`, `accredited`, `min_auth_level`, `ip_allowlist`) is evaluated for a principal
 * that already exists, by `@fundroom/authz`. *Admission* decides whether a principal may come
 * into existence at all: the domain allowlist picks **which emails may become members**, and it
 * is checked before any membership exists (E2.3 D3). That is why these rules live in the kernel
 * next to the link row rather than as policy rows the evaluator reads.
 *
 * ## One wire answer for every "no"
 *
 * Unknown, revoked, paused, expired, use-exhausted and view-exhausted all collapse to
 * `not_found` (D7). A caller who could tell them apart could enumerate live links, and could
 * learn that a link they were refused *exists* — which is itself the interesting fact about a
 * confidential data room. The real reason stays on the row for the admin screen and in the
 * `share_link.admission_refused` audit entry, both of which read the row directly.
 *
 * ## Two questions, not one
 *
 * "Is this link still there?" and "may somebody new come in through it?" are different, and
 * conflating them is the bug work package H fixed in two places. `isOpen` answers the first,
 * `isLive` the second, and the difference between them is exactly the use and view caps — which
 * limit **how many people may come in, not how long the ones who did may stay** (D3, A6). Every
 * function here says which of the two it is asking.
 */

/**
 * Mirrors `core.share_link_status` (migration `core/0008_share_links.sql`). Declared here rather
 * than imported so this file stays database-free, exactly as `custom-domains/src/state.ts` does
 * for `core.custom_domain_status`; the repository narrows the row's status against this union, so
 * the two cannot drift without the build saying so.
 */
export const SHARE_LINK_STATUSES = ["active", "paused", "revoked"] as const;
export type ShareLinkStatus = (typeof SHARE_LINK_STATUSES)[number];

/** Bumped only when `LinkPolicy`'s shape changes; `share_link.policy_schema_version` defaults to it. */
export const LINK_POLICY_SCHEMA_VERSION = 1;

export interface LinkPolicy {
  /** Lower-cased email domains, no leading `@`. Empty = no domain restriction. */
  readonly domains: readonly string[];
  /** Exact addresses that may redeem. Empty = no named-contact restriction. */
  readonly emails: readonly string[];
  /** A link may force watermarking on; it may never turn an inherited watermark off. */
  readonly forceWatermark: boolean;
}

/** The policy of a link that restricts nothing. Any verified email may redeem it. */
export const OPEN_LINK_POLICY: LinkPolicy = Object.freeze({
  domains: Object.freeze([]),
  emails: Object.freeze([]),
  forceWatermark: false,
});

/**
 * Why admission was refused. `not_found` is the one an unauthenticated caller is allowed to see
 * for anything to do with the link's *existence*; the three passcode answers are only ever
 * returned to someone who already holds a resolvable token, and `email_not_allowed` only after
 * the passcode (if any) has been satisfied — so neither reveals whether a link exists.
 */
export type AdmissionRefusal =
  | "not_found"
  | "passcode_required"
  | "passcode_wrong"
  | "passcode_locked"
  | "email_not_allowed";

/** Why the offering status refuses this link's *shape* (D6). */
export type LinkPolicyRefusal =
  | { readonly code: "links_not_permitted"; readonly status: OfferingStatus }
  | { readonly code: "audience_too_open"; readonly status: OfferingStatus };

/**
 * A link as `resolve()` returns it: everything admission needs, and nothing that would let a
 * caller learn what the link points at before they are admitted (D7 — `resolve` reveals the
 * workspace and a masked email hint at most; the label and grants are for the admin surfaces and
 * for `redeem`, which runs after admission).
 */
export interface ResolvedLink {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: ShareLinkStatus;
  readonly policy: LinkPolicy;
  readonly passcodeRequired: boolean;
  readonly passcodeAttempts: number;
  readonly passcodeLockedUntil: Date | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly maxViews: number | null;
  readonly views: number;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/*
 * ## Domain matching
 *
 * `@acme.com` admits `jane@acme.com` and nothing else. It does **not** admit:
 *
 *  - `evil-acme.com` — a suffix match would; we compare whole strings.
 *  - `acme.com.evil.net` — a prefix match would; an attacker registers one domain and walks into
 *    every workspace that ever allowlisted `acme.com`.
 *  - `mail.acme.com` — a *subdomain* of an allowed domain. This one is a deliberate choice, not
 *    an accident: subdomains of a corporate domain are routinely delegated to third parties
 *    (marketing suites, status pages, acquired companies), so "anyone under acme.com" is a wider
 *    audience than the admin who typed `acme.com` meant, and under 506(b) the size of the
 *    audience is the whole question. An admin who wants a subdomain adds it explicitly.
 *
 * The comparison is on the normalised form of both sides: lower-cased, trimmed, one trailing dot
 * tolerated, a leading `@` stripped. Normalising on the way in *and* on the way out is what stops
 * `@ACME.com ` in the policy from silently admitting nobody.
 */

/** The stored spelling of an allowlist entry, or `undefined` if it cannot be one. */
export function normalizeDomain(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase().replace(/^@/u, "").replace(/\.$/u, "");
  if (trimmed.length === 0 || trimmed.length > 253) return undefined;
  // Every label non-empty: `acme..com` and `.acme.com` have two spellings each, so refuse them.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * The domain half of an address. `EMAIL_RE` in `@fundroom/identity` permits exactly one `@`
 * (neither side may contain one), so there is no "last `@` wins" ambiguity to exploit here —
 * but the split is written against the last `@` anyway, because that is the half a mail server
 * routes on and the reading must not depend on the validator staying as strict as it is today.
 */
export function domainOf(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  return normalizeDomain(email.slice(at + 1));
}

/** Lower-cases and trims an address for comparison. Not a validator; `admits` rejects nonsense. */
export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Reads `share_link.policy` jsonb into a `LinkPolicy`, dropping anything that is not a usable
 * entry rather than throwing: a policy row written by an older schema version must still admit
 * the people it can, and a single unparseable domain must not take a live link offline. Entries
 * are normalised and de-duplicated, so the stored form and the compared form are the same string.
 */
export function normalizeLinkPolicy(raw: unknown): LinkPolicy {
  if (typeof raw !== "object" || raw === null) return OPEN_LINK_POLICY;
  const record: Record<string, unknown> = { ...raw };
  const domains = [
    ...new Set(
      stringsOf(record["domains"])
        .map((d) => normalizeDomain(d))
        .filter((d): d is string => d !== undefined),
    ),
  ];
  const emails = [
    ...new Set(
      stringsOf(record["emails"])
        .map((e) => normalizeAddress(e))
        .filter((e) => domainOf(e) !== undefined),
    ),
  ];
  return { domains, emails, forceWatermark: record["forceWatermark"] === true };
}

function stringsOf(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Does this policy name its audience at all, or will it take any verified email? (D6) */
export function policyNamesAnAudience(policy: LinkPolicy): boolean {
  return policy.domains.length > 0 || policy.emails.length > 0;
}

/**
 * Is the link *open* — not paused, not revoked, not past its expiry?
 *
 * This is deliberately **exactly** the predicate `PrincipalRepo.listActive()` uses when it decides
 * whether to emit a `link` subject for a membership (work package A's A6): `status = 'active'`,
 * `revoked_at IS NULL`, and an unexpired `expires_at`. Keeping the two spellings identical is what
 * makes "revoking a link takes access away" true rather than merely plausible — if this function
 * were laxer, a link could stop admitting while still granting; if it were stricter, a link could
 * go on granting after this package considered it dead.
 *
 * It says nothing about the use and view caps. That is the point: see `isLive`.
 *
 * **This is the predicate that maps a token to a link** — `resolve` and `checkPasscode` both use
 * it, so a link that has spent its caps still resolves for the people it already admitted. See
 * `isLive` for who may be admitted *through* it.
 */
export function isOpen(link: ResolvedLink, now: Date): boolean {
  if (link.status !== "active") return false;
  if (link.revokedAt !== null) return false;
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Is the link still capable of admitting *somebody new*? Open, and with budget left.
 *
 * The cap comparisons are `>=`, not `>`: `uses` is the number already admitted, so a link with
 * `max_uses = 1` and `uses = 1` has nothing left to give. The *authoritative* enforcement is the
 * conditional `UPDATE` in the repository (two concurrent redemptions must not both pass a check
 * made in JavaScript); this is the read-side answer that keeps a link from offering a seat it
 * cannot honour.
 *
 * **This is the admission predicate, and it is deliberately stricter than `isOpen`.** A use cap is
 * a limit on how many people may come in, not a lease on the ones who did (D3, confirmed by A6:
 * `PrincipalRepo` does not consult `uses`). So it answers **"may somebody NEW come in?"** and
 * nothing else. The three callers are exactly the three that ask that question: `admits` (the
 * pure rule), `admitsEmail` (the eligibility half `checkEligibility` calls), and nobody in the
 * token → link mapping — `resolve`, `checkPasscode` and `redeem` all use `isOpen`, because a
 * visitor the link has already admitted must be able to come back on a new device or after their
 * session expired. The cap is then spent, or refused, by the one statement that can settle it.
 * Revoking or pausing is how access is taken away, and on those two the predicates agree exactly.
 */
export function isLive(link: ResolvedLink, now: Date): boolean {
  if (!isOpen(link, now)) return false;
  if (link.maxUses !== null && link.uses >= link.maxUses) return false;
  if (link.maxViews !== null && link.views >= link.maxViews) return false;
  return true;
}

/**
 * The policy half of admission, with no reference to the link's state: may *this address* be one
 * of the people this link is for? Split out of `admits` because `redeem` asks the two questions
 * separately — a returning visitor on an exhausted link is still one of its people.
 */
export function emailRefusal(policy: LinkPolicy, email: string): AdmissionRefusal | undefined {
  const address = normalizeAddress(email);
  const domain = domainOf(address);
  if (domain === undefined) return "email_not_allowed";
  const { domains, emails } = policy;
  if (domains.length === 0 && emails.length === 0) return undefined;
  if (emails.includes(address)) return undefined;
  if (domains.includes(domain)) return undefined;
  return "email_not_allowed";
}

/**
 * May this email be admitted through this link? `undefined` means yes.
 *
 * Pure, and the same function on both sides of the seam: the route calls it through
 * `ShareLinkService.admits`, and `checkEligibility` in `@fundroom/identity` calls it through the
 * structural `ShareLinkAccess.admits` so that the link's own policy *is* the OTP eligibility rule
 * (E2.3 §6). Two implementations of "who may redeem this link" would be one too many.
 *
 * The passcode is **not** checked here, and that is deliberate: a passcode is proof held by
 * whoever opened the URL, not a property of the email, and it is satisfied once per resolution
 * (`checkPasscode`) rather than re-demanded at every step. `passcode_required` and its siblings
 * come from `passcodeVerdict` below.
 *
 * `now` is optional so the frozen two-argument signature in the contract still type-checks; it
 * exists because expiry and exhaustion are part of "may this email be admitted" and a function
 * that reached for `Date.now()` itself could not be tested at a boundary.
 */
export function admits(
  link: ResolvedLink,
  email: string,
  now: Date = new Date(),
): AdmissionRefusal | undefined {
  // Liveness first, so a dead link never confirms its own policy by answering `email_not_allowed`.
  // `isLive`, not `isOpen`: this is the *new visitor* question, and a spent link admits nobody
  // new. A caller holding an already-admitted visitor must not ask it — see `isLive`.
  if (!isLive(link, now)) return "not_found";
  return emailRefusal(link.policy, email);
}

/*
 * ## Passcode attempts
 *
 * Counted **on the link row** (`passcode_attempts`, `passcode_locked_until`), the way
 * `core.auth_challenge.attempts` / `max_attempts` already counts OTP attempts — never in a bucket
 * keyed on the client IP. Behind the shipped Caddy, `TRUST_PROXY=true` takes the first
 * `X-Forwarded-For` hop, which is attacker-supplied (ADR-0039 decision 4): an IP-keyed limit gives
 * the attacker a fresh bucket per spoofed value while every honest visitor shares Caddy's. Count
 * the thing being guessed. An IP bucket may be added on top; it may never be the only one.
 */

/** Wrong passcodes tolerated before the link stops answering for `PASSCODE_LOCK_MS`. */
export const PASSCODE_MAX_ATTEMPTS = 5;

/** How long a link is locked once the attempts are spent. Long enough to make guessing useless. */
export const PASSCODE_LOCK_MS = 15 * 60_000;

/** A passcode short enough to be typed is short enough to be guessed; these bound both ends. */
export const PASSCODE_MIN_LENGTH = 6;
export const PASSCODE_MAX_LENGTH = 128;

export interface PasscodeFacts {
  /** Does the link carry a passcode at all? */
  readonly required: boolean;
  /** What the visitor typed, or `undefined` if they typed nothing. */
  readonly supplied: string | undefined;
  /** Did the supplied passcode verify against the stored HMAC? See `token.ts`. */
  readonly matches: boolean;
  /** `passcode_attempts` *including* this one. */
  readonly attempts: number;
  readonly lockedUntil: Date | null;
}

/**
 * The passcode half of admission, pure so the lock boundary is testable to the millisecond.
 * `undefined` means the passcode is satisfied (including "the link has no passcode").
 *
 * Order matters: the lock is checked **before** the match, so a locked link cannot be used as an
 * oracle by an attacker who has guessed correctly — and so that a correct guess does not reset a
 * lock somebody else's guessing earned.
 */
export function passcodeVerdict(facts: PasscodeFacts, now: Date): AdmissionRefusal | undefined {
  if (!facts.required) return undefined;
  if (facts.lockedUntil !== null && facts.lockedUntil.getTime() > now.getTime()) {
    return "passcode_locked";
  }
  if (facts.supplied === undefined || facts.supplied.length === 0) return "passcode_required";
  if (facts.matches) return undefined;
  return facts.attempts >= PASSCODE_MAX_ATTEMPTS ? "passcode_locked" : "passcode_wrong";
}

/** When a link locks out, given the attempt that spent the last one. */
export function passcodeLockUntil(now: Date): Date {
  return new Date(now.getTime() + PASSCODE_LOCK_MS);
}

/*
 * ## Offering mode gates issuance *and shape* (D6)
 *
 * `permits(status).shareLinks` in `@fundroom/compliance` is already the "may links be issued at
 * all" boolean. This is the stricter, shape-aware version of the same EXECUTION_PLAN §11 table,
 * and it lives here rather than there because it takes a `LinkPolicy` — a share-link concept —
 * and because `@fundroom/compliance` must not learn about share links to answer it.
 *
 * | status          | §11 says                            | this returns                      |
 * |-----------------|-------------------------------------|-----------------------------------|
 * | `none`          | no links                            | `links_not_permitted`             |
 * | `informational` | no links                            | `links_not_permitted`             |
 * | `506b`          | email-verify **+ allowlist** only   | `audience_too_open` if unrestricted |
 * | `506c`          | permitted with tracking             | permitted                         |
 * | `non_us`        | permitted                           | permitted                         |
 *
 * 506(b) forbids general solicitation, and a link that admits any verified email *is* general
 * solicitation the moment it is forwarded — the fact that a visitor proves an email address says
 * nothing about a pre-existing relationship. So under `506b` the link must name its audience:
 * a domain allowlist, a named-email list, or both. Not re-derived in the browser; the admin
 * screen renders the server's refusal.
 */
export function linkPolicyPermitted(
  status: OfferingStatus,
  policy: LinkPolicy,
): LinkPolicyRefusal | undefined {
  switch (status) {
    case "none":
    case "informational":
      return { code: "links_not_permitted", status };
    case "506b":
      return policyNamesAnAudience(policy) ? undefined : { code: "audience_too_open", status };
    case "506c":
    case "non_us":
      return undefined;
    default:
      // A status added to `core.offering_status` without a decision here is refused, not
      // permitted: a new regulatory mode must not inherit "links are fine" by omission.
      return { code: "links_not_permitted", status };
  }
}
