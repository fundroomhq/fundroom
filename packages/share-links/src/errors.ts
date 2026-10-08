/*
 * The package's own error type, mirroring `@fundroom/compliance` and `@fundroom/custom-domains`.
 *
 * Every code here maps onto an `ApiErrorCode` (`packages/contracts/src/errors.ts`), which is a
 * **closed** enum this epic does not extend (E2.3 contract S9): the route layer answers with the
 * shared code and disambiguates with `error.reason`, exactly as `domains.ts` and `branding.ts` do.
 * The mapping is written down in the comment on each code so that a route cannot invent a
 * different one and so a reader can see, here, what the wire will say.
 */
export const SHARE_LINK_ERROR_CODES = [
  /**
   * `not_found` → 404. **The only answer an unauthenticated caller ever gets for a bad link**:
   * unknown, revoked, paused, expired and exhausted all collapse here (D7). Anything finer is an
   * enumeration oracle — the admin UI, which reads the row directly, is where the real reason
   * lives, together with the `share_link.admission_refused` audit row.
   */
  "not_found",
  /** `validation_failed` → 400. A label, passcode or policy the row's CHECKs would refuse. */
  "validation_failed",
  /** `conflict` → 409. The link is not in a state that admits the requested transition. */
  "conflict",
  /** `forbidden` → 403. The caller may not operate on this link. */
  "forbidden",
  /**
   * `unsupported` → 400. A grant names a resource kind no module registered (contract S3). The
   * kernel never checks that the resource *exists* — the owning module does — but an unknown
   * *kind* can never be satisfied by anybody, so it is refused at mint time rather than becoming
   * a grant that silently grants nothing.
   */
  "unsupported",
  /**
   * `forbidden` → 403, `reason: "links_not_permitted"`. The offering status forbids issuing share
   * links at all (`none`, `informational` — EXECUTION_PLAN §11, D6).
   */
  "links_not_permitted",
  /**
   * `forbidden` → 403, `reason: "audience_too_open"`. Under `506b` a link must name its audience:
   * a domain allowlist or a named-email list. An "any verified email" link is general
   * solicitation, which 506(b) does not permit (D6).
   */
  "audience_too_open",
] as const;

export type ShareLinkErrorCode = (typeof SHARE_LINK_ERROR_CODES)[number];

export class ShareLinkError extends Error {
  override readonly name = "ShareLinkError";
  constructor(
    readonly code: ShareLinkErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function isShareLinkError(e: unknown): e is ShareLinkError {
  return e instanceof ShareLinkError;
}

/**
 * Who is making the change. `membershipId` is the staff member who minted or revoked the link;
 * `core.share_link.created_by` / `revoked_by` store it and the audit row repeats it, because
 * "who shared this and when did they stop" is the first question asked of a leaked link.
 */
export interface Actor {
  readonly membershipId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
}
