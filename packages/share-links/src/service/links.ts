import type { InviteGrant } from "@fundroom/domain";
import { type Actor, ShareLinkError } from "../errors.js";
import {
  type AdmissionRefusal,
  admits as admitsPure,
  emailRefusal,
  isOpen,
  type LinkPolicy,
  linkPolicyPermitted,
  normalizeLinkPolicy,
  passcodeLockUntil,
  passcodeVerdict,
  type ResolvedLink,
} from "../policy.js";
import { ShareLinkRepo } from "../repos/share-link-repo.js";
import {
  hashPasscode,
  isAcceptablePasscode,
  isPlausibleToken,
  mintToken,
  tokenHash,
  verifyPasscode,
} from "../token.js";
import {
  databaseViewSessionLedger,
  type LinkSummary,
  type LinkVisit,
  type ListFilter,
  nowOf,
  type ShareLinkDeps,
  type ShareLinkStore,
  type TenantContext,
  type Tx,
  toLinkSummary,
  toResolvedLink,
} from "./types.js";

/*
 * The share-link service (EXECUTION_PLAN §9.3, design/05 §5, ADR-0041, E2.3).
 *
 * Six things happen to a share link and they are all here: it is minted, it is resolved from a
 * token, its passcode is checked, it is redeemed into a membership binding, its views are
 * counted, and it is revoked. The rules that decide any of them are pure and live in
 * `policy.ts`; the queries are one statement each and live in `repos/`.
 *
 * ## The refusal discipline
 *
 * Unknown, revoked, paused, expired, use-exhausted and view-exhausted are **one wire answer**:
 * `not_found`. The distinction is kept on the row (for the admin screen, which reads it directly)
 * and in the `share_link.admission_refused` audit entry, and is never returned to an
 * unauthenticated caller — somebody who could tell "revoked" from "never existed" could enumerate
 * live links, and that a link *exists* is already the interesting fact about a confidential data
 * room (D7).
 *
 * The two exhaustion refusals are made **one step later than the other four**, and that is the
 * point of `isOpen` vs `isLive`. A spent link still resolves, because the people it already
 * admitted must be able to come back; a *new* visitor is refused by `admits` — and, on the wire,
 * by the route declining to send them a code, which is the same silent answer an ineligible
 * address gets at any other OTP start. No refusal a stranger can provoke tells them anything
 * more than it did before.
 *
 * Every method that branches on whether a token exists should be wrapped by the route in
 * `withMinimumDuration` (`@fundroom/identity`), so the timing does not answer the question the
 * status code refuses to.
 *
 * ## Every method here runs under `system` or `staff` — never under the visitor
 *
 * `core.share_link` has **no permissive RLS policy for `external` at all** (work package A's A4):
 * Postgres RLS is row-level, so there is no policy that could hand back the row while withholding
 * `token_hash` and `passcode_hash`, and a share-link visitor *is* an external member the moment
 * they are admitted. `core.share_link_visit` is the same story from the other side (A5): external
 * gets `FOR SELECT` on its own row and no INSERT or UPDATE at all, because that row is the
 * authorization edge `PrincipalRepo` walks to emit the `link` subject — an external member who
 * could write one would grant themselves everything the link carries without ever holding the
 * token, the passcode or the OTP.
 *
 * Under an `external` context these methods would therefore see **zero rows and raise nothing** —
 * the worst failure shape there is, because it looks exactly like "no such link". So every method
 * refuses an `external` context up front, loudly. The public link routes run under
 * `systemContext(workspaceId)`, which the tenant classifier has resolved from the host or slug
 * long before any membership exists; a fact the visitor's UI needs off the link (its label, its
 * `forceWatermark`) is projected server-side from that read. Adding an `external` policy to
 * `core.share_link` is not the fix — it would carry both digests with it.
 *
 * ## Why `checkPasscode` returns instead of throwing
 *
 * It runs in the caller's transaction, so a thrown refusal would roll the attempt counter back
 * and hand the guesser unlimited tries — the opposite of the OTP flow, which can afford to commit
 * the attempt in a transaction of its own first
 * (`packages/identity/src/services/email-otp.ts:187`). Returning an `AdmissionRefusal` makes the
 * counted attempt part of the caller's successful commit. **A route that turns this into an
 * exception before committing has removed the rate limit.**
 */

export interface MintLinkInput {
  readonly label: string;
  /** Missing fields default to unrestricted; `linkPolicyPermitted` decides when that is refused. */
  readonly policy?: Partial<LinkPolicy> | undefined;
  readonly grants?: readonly InviteGrant[] | undefined;
  readonly groupIds?: readonly string[] | undefined;
  /** Plaintext; stored only as a keyed HMAC, and never returned by anything. */
  readonly passcode?: string | undefined;
  readonly maxUses?: number | null | undefined;
  readonly maxViews?: number | null | undefined;
  readonly expiresAt?: Date | null | undefined;
  readonly actor?: Actor | undefined;
}

export interface MintedLink {
  readonly link: LinkSummary;
  /**
   * The plaintext token. Returned **once**, by this call, and stored nowhere: the column holds
   * `sha256(token)`. Losing it means minting a new link.
   */
  readonly token: string;
}

export interface RedeemInput {
  readonly linkId: string;
  readonly membershipId: string;
  /**
   * The address that was verified. Re-checked against the link's policy here, because between OTP
   * start and OTP verify an admin may have narrowed the allowlist, and the narrower answer is the
   * one that should win.
   */
  readonly email?: string | undefined;
  readonly actor?: Actor | undefined;
  /** When the passcode was satisfied for this visitor; recorded on the binding. */
  readonly passcodeOkAt?: Date | null | undefined;
}

export interface RedeemResult {
  readonly linkId: string;
  readonly membershipId: string;
  readonly visitId: string;
  /** False when this membership had already been admitted; no second seat was spent. */
  readonly firstRedemption: boolean;
  /** Target groups to apply to the membership (`share_link.group_ids`). */
  readonly groupIds: readonly string[];
  /**
   * What the link grants — reported, **never to be copied onto the membership** (contract §2).
   *
   * These already exist as `core.access_grant` rows whose subject is the *link*, written once by
   * `mint`. The redeemer reaches them through the `core.share_link_visit` row this call wrote,
   * which is what `PrincipalRepo` walks to emit the `link` subject. A caller that wrote a second
   * copy against `subject_kind='membership'` would be re-creating the defect this shape exists to
   * remove: the copy outlives the link, so pausing, expiring, unbinding or revoking would take
   * nothing away. The field stays because "what did the link promise me?" is a fair question for
   * an audit row or a confirmation screen to ask.
   */
  readonly grants: readonly InviteGrant[];
  /** A link may force watermarking on; it may never turn an inherited watermark off. */
  readonly forceWatermark: boolean;
}

export interface RevokeInput {
  readonly linkId: string;
  readonly actor?: Actor | undefined;
  /**
   * Also revoke the bindings of the memberships this link admitted. Revoking a *link* does not
   * revoke the memberships it created unless the admin asks (design/05 §5: "admin chooses in a
   * confirmation dialog"); ending the memberships themselves is the existing membership
   * revocation path, which this package does not own.
   */
  readonly revokeVisitors?: boolean | undefined;
}

export interface ShareLinkService {
  mint(ctx: TenantContext, tx: Tx, input: MintLinkInput): Promise<MintedLink>;
  /**
   * Never consumes. `undefined` for unknown, revoked, paused and expired alike — but **not** for
   * a link that has spent its `max_uses` or `max_views`: a cap limits how many people may come
   * in, not how long the ones who did may stay, and this is the only token → link mapping the
   * public routes have. Whether a *new* visitor may be admitted is `admits`, and it is settled
   * by `claimUse`. See `isOpen` vs `isLive` in `policy.ts`.
   */
  resolve(ctx: TenantContext, tx: Tx, token: string): Promise<ResolvedLink | undefined>;
  checkPasscode(
    ctx: TenantContext,
    tx: Tx,
    linkId: string,
    passcode: string,
  ): Promise<AdmissionRefusal | undefined>;
  /** PURE. On the service so a route holds one object rather than an object and an import. */
  admits(link: ResolvedLink, email: string, now?: Date): AdmissionRefusal | undefined;
  /**
   * The async half: load the link and ask the same pure question. This is what backs the
   * structural `ShareLinkAccess.admits` (contract S2) that `checkEligibility` calls, and it is a
   * separate name because the pure one is the two-argument function above — an overload making
   * one name mean both would be a trap for whoever wires them together.
   */
  admitsEmail(ctx: TenantContext, tx: Tx, linkId: string, email: string): Promise<boolean>;
  redeem(ctx: TenantContext, tx: Tx, input: RedeemInput): Promise<RedeemResult>;
  noteView(
    ctx: TenantContext,
    tx: Tx,
    linkId: string,
    membershipId: string,
    sessionId: string,
  ): Promise<void>;
  revoke(ctx: TenantContext, tx: Tx, input: RevokeInput): Promise<void>;
  /** `paused` is a reversible stop; to a visitor it is indistinguishable from revoked. */
  setPaused(ctx: TenantContext, tx: Tx, linkId: string, paused: boolean): Promise<LinkSummary>;
  list(ctx: TenantContext, tx: Tx, filter?: ListFilter): Promise<readonly LinkSummary[]>;
  visits(ctx: TenantContext, tx: Tx, linkId: string): Promise<readonly LinkVisit[]>;
  /**
   * Binds one membership to the link (contract S2's `bind`): the `core.share_link_visit` row, the
   * use count, and a report of what the link carries.
   *
   * The **groups** are the caller's to apply, exactly as an invitation's are. The **grants** are
   * not: they are already written against the link (see `RedeemResult.grants`), and copying them
   * is the one thing a caller of this method must not do.
   */
  bind(
    ctx: TenantContext,
    tx: Tx,
    input: { readonly linkId: string; readonly membershipId: string },
  ): Promise<{ readonly groupIds: readonly string[]; readonly grants: readonly InviteGrant[] }>;
}

/**
 * The seam `@fundroom/identity` declares and the server wires (contract S2). Structural on
 * purpose: identity must never import this package, and this package must never import identity's
 * declaration of it — the shapes match, and the compiler checks that where they are wired
 * together. The dependency runs share-links → identity (for `randomToken`, `sha256`, `hashCode`,
 * `verifyCode`) and never the other way, so there is no cycle.
 */
export interface ShareLinkAccess {
  admits(ctx: TenantContext, tx: Tx, linkId: string, email: string): Promise<boolean>;
  bind(
    ctx: TenantContext,
    tx: Tx,
    input: { readonly linkId: string; readonly membershipId: string },
  ): Promise<{ readonly groupIds: readonly string[]; readonly grants: readonly InviteGrant[] }>;
}

/**
 * The one sentence every "this link is not there" answer carries.
 *
 * It is **byte-identical** to `routes/links.ts`'s own `notFound()` on purpose. Unknown, revoked,
 * paused, expired and "the seat was taken between `start` and `verify`" all collapse into one
 * wire answer (D7), and two 404s that differ by their prose are a distinction a prober can read
 * even when the status code refuses to make it. A constant rather than a shared export because
 * this package must not depend on the server that mounts it; the integration suite compares whole
 * bodies, which is what keeps the two in step.
 */
const NOT_FOUND_MESSAGE = "no such link";

/** Labels are what an admin recognises a link by; the migration CHECKs the same bound. */
const LABEL_MAX = 200;

/** `InviteGrantsSchema` caps grants at 50; target groups get the same ceiling. */
const GROUPS_MAX = 50;

/**
 * Refuses a visitor's own context before it can turn into a silent empty read (A4/A5).
 *
 * This is a wiring error, not something a request can provoke, so it is loud and specific: the
 * alternative is `resolve()` answering `undefined` for a perfectly good token because RLS filtered
 * the row, which is indistinguishable from an expired link and would be debugged for a day.
 */
function requirePrivilegedContext(ctx: TenantContext, method: string): void {
  if (ctx.actorKind === "external") {
    throw new ShareLinkError(
      "forbidden",
      `share links must be read under a system or staff context; ${method}() was called as external`,
      { reason: "external_context", method },
    );
  }
}

/** `core.session.id` is a uuid, and so is the column the claim lands in. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Refuses a session id that is not a uuid, **before** it reaches a statement.
 *
 * Not defensive noise: `noteView` runs inside the caller's transaction, and a non-uuid handed to
 * `INSERT … (session_id) VALUES ($1)` raises 22P02, which aborts that whole transaction — the
 * membership creation, the audit row and everything else sharing it. Caught here it is one
 * thrown error the caller can decide about, and it says which value was wrong. Like the context
 * guard above, this is a wiring mistake rather than something a request can provoke: the server
 * passes `core.session.id`.
 */
function requireSessionId(sessionId: string): void {
  if (!UUID_RE.test(sessionId)) {
    throw new ShareLinkError(
      "validation_failed",
      "noteView() needs a core.session id (a uuid); the view ledger is keyed by one",
      { reason: "invalid_session_id" },
    );
  }
}

export function createShareLinkService(deps: ShareLinkDeps): ShareLinkService {
  const storeOf = (ctx: TenantContext, tx: Tx): ShareLinkStore =>
    deps.store?.(ctx, tx) ?? new ShareLinkRepo(ctx, tx);
  const viewSessions = deps.viewSessions ?? databaseViewSessionLedger;

  /**
   * One audit row per refusal an *unauthenticated* caller receives, so the admin screen can show
   * "17 refusals on this link in the last hour" — the signal the 404-for-everything wire contract
   * deliberately keeps off the wire. The actor is the system actor: there is no membership yet,
   * which is the whole reason admission exists.
   */
  async function auditRefusal(
    ctx: TenantContext,
    tx: Tx,
    linkId: string | null,
    reason: AdmissionRefusal,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await deps.audit.record(tx, ctx, {
      action: "share_link.admission_refused",
      resourceKind: "share_link",
      resourceId: linkId,
      outcome: "denied",
      actorKind: "system",
      meta: { reason, ...extra },
    });
  }

  const service: ShareLinkService = {
    async mint(ctx, tx, input) {
      requirePrivilegedContext(ctx, "mint");
      const now = nowOf(deps);
      const store = storeOf(ctx, tx);

      const label = input.label.trim();
      if (label.length === 0 || label.length > LABEL_MAX) {
        throw new ShareLinkError("validation_failed", "a share link needs a label", {
          field: "label",
        });
      }
      const policy = normalizeLinkPolicy({ ...input.policy });
      const grants = [...(input.grants ?? [])];
      const groupIds = [...(input.groupIds ?? [])];
      if (groupIds.length > GROUPS_MAX) {
        throw new ShareLinkError("validation_failed", "too many target groups", {
          field: "groupIds",
        });
      }

      // S3: a resource *kind* no module registered can never be satisfied by anybody, so a grant
      // naming one is refused here rather than written as a grant that silently grants nothing.
      // That the resource *exists* in this workspace, and the rule's `path`, are the route's to
      // settle before it calls `mint` (`canonicalResource`, P1-03 / R1-A1): this package cannot
      // see module tables, so it writes each grant's resource exactly as it is handed.
      const kinds = deps.resourceKinds?.();
      if (kinds !== undefined) {
        const known = new Set(kinds);
        const unknown = grants.map((g) => g.resource.kind).find((k) => !known.has(k));
        if (unknown !== undefined) {
          throw new ShareLinkError("unsupported", "no module owns that resource kind", {
            reason: "unknown_resource_kind",
            kind: unknown,
          });
        }
      }

      checkCap(input.maxUses, "maxUses");
      checkCap(input.maxViews, "maxViews");
      const expiresAt = input.expiresAt ?? null;
      if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
        throw new ShareLinkError("validation_failed", "expiry is already past", {
          field: "expiresAt",
        });
      }
      if (input.passcode !== undefined && !isAcceptablePasscode(input.passcode)) {
        throw new ShareLinkError("validation_failed", "passcode is too short or too long", {
          field: "passcode",
        });
      }

      // D6: offering mode gates issuance *and* shape. A workspace we cannot read is not a reason
      // to permit a link, so an absent status is treated as the most restrictive one.
      const offeringStatus = (await store.offeringStatus()) ?? "none";
      const refusal = linkPolicyPermitted(offeringStatus, policy);
      if (refusal !== undefined) {
        throw new ShareLinkError(refusal.code, explainRefusal(refusal.code), {
          reason: refusal.code,
          offeringStatus: refusal.status,
        });
      }

      const token = mintToken();
      let record = await store.create({
        label,
        tokenHash: tokenHash(token),
        policy,
        grants,
        groupIds,
        // The passcode's HMAC scope contains the link id, which does not exist until the row
        // does (`core.uuidv7()` is a column default), so it is written in a second statement
        // inside the caller's transaction. Both commit together or neither does.
        passcodeHash: null,
        maxUses: input.maxUses ?? null,
        maxViews: input.maxViews ?? null,
        expiresAt,
        createdBy: input.actor?.membershipId ?? null,
      });
      if (input.passcode !== undefined) {
        const updated = await store.setPasscodeHash(
          record.id,
          hashPasscode(deps.keyRing, input.passcode, record.id),
        );
        if (updated === undefined) {
          throw new ShareLinkError("conflict", "the link vanished while it was being created");
        }
        record = updated;
      }

      /*
       * The link's grants are written **here, once, against the link** (contract §2).
       *
       * "The link remains the grant subject. Grants are written once against
       * `subject_kind='link', subject_id=<link id>` — never copied per visitor… Revoking the link
       * stops emitting the subject, so one write revokes everyone it admitted." Everything the
       * epic claims about revocation rests on this one decision, and the alternative — copying
       * the grants onto each visitor as `membership` subjects, the way an *invitation* legitimately
       * does — makes the link's pause, expiry, per-visitor unbinding and revoke into four controls
       * that change a row and change no access. An invitation is a one-time promise that becomes
       * the member's own; a share link is a standing grant that the admin must be able to withdraw.
       *
       * Nothing revokes these rows afterwards and nothing needs to: `PrincipalRepo.listActive()`
       * (contract A6) emits a `link` subject only for a live binding on a link that is `active`,
       * unrevoked and unexpired, so a paused, expired or revoked link resolves to no subject and
       * these rules match nobody. Leaving them in place keeps the record of what the link offered,
       * which is the same reason a revoked grant row is kept rather than deleted.
       *
       * No `bumpAcl` here, and that is provable rather than an oversight: the link's id did not
       * exist a statement ago, so it has no `core.share_link_visit` row, so no principal carries
       * its subject and no `core.effective_access` entry can change. The first binding is written
       * by `redeem`, and `establishMembership` bumps the version around it.
       */
      const written = await store.writeLinkGrants({
        linkId: record.id,
        grants,
        note: `link:${record.id}`,
        createdBy: input.actor?.membershipId ?? null,
      });

      await deps.audit.record(tx, ctx, {
        action: "share_link.created",
        resourceKind: "share_link",
        resourceId: record.id,
        actorMembershipId: input.actor?.membershipId ?? null,
        requestId: input.actor?.requestId ?? null,
        sessionId: input.actor?.sessionId ?? null,
        // Counts and flags, never the addresses themselves: an audit row is exportable evidence
        // and `design/02` §6 keeps PII out of `meta`.
        meta: {
          label,
          domains: policy.domains.length,
          emails: policy.emails.length,
          forceWatermark: policy.forceWatermark,
          passcode: input.passcode !== undefined,
          grants: grants.length,
          /** How many `subject_kind='link'` rules those grants became. */
          grantRules: written,
          groupIds: groupIds.length,
          maxUses: input.maxUses ?? null,
          maxViews: input.maxViews ?? null,
          expiresAt: expiresAt?.toISOString() ?? null,
          offeringStatus,
        },
      });
      deps.log?.("share_link.created", { workspaceId: ctx.workspaceId, linkId: record.id });
      return { link: toLinkSummary(record, 0), token };
    },

    async resolve(ctx, tx, token) {
      requirePrivilegedContext(ctx, "resolve");
      // Length and alphabet first: an unauthenticated prober must not be able to make us hash and
      // index-probe arbitrary input (`InviteService.resolve` guards the same way at
      // `packages/identity/src/services/invites.ts:199`).
      if (!isPlausibleToken(token)) return undefined;
      const now = nowOf(deps);
      const record = await storeOf(ctx, tx).byTokenHash(tokenHash(token));
      if (record === undefined) return undefined;
      const link = toResolvedLink(record);
      /*
       * `isOpen`, **not** `isLive` — the same correction `redeem` already carries, applied to the
       * only token → link mapping this package exposes.
       *
       * `resolve` answers "is this link still there?", which the use and view caps do not bear
       * on: a cap limits how many people may come in, not how long the ones who did may stay
       * (D3, and A6 confirms `PrincipalRepo` never consults `uses`). With `isLive` here, a link
       * that reached `max_uses` answered `undefined` — a 404 at `GET /links/{token}` and at
       * `POST /links/{token}/start` — **before** `redeem` could run, so a visitor the link had
       * already admitted could not sign in again from a new device or after their session
       * expired, while the link went on granting them everything. The link had stopped letting
       * its own people back in.
       *
       * Paused, revoked and expired still collapse into "no such link" here, once, so no caller
       * further out has to remember to do it — and on those three `isOpen` is *exactly*
       * `PrincipalRepo.listActive()`'s predicate, so a link that resolves is a link that grants.
       *
       * The caps are not lost. They are asked by `admits`/`admitsEmail`, which is the
       * "may somebody NEW come in?" question and the one `checkEligibility` calls, and they are
       * *settled* by the conditional `UPDATE` in `claimUse` — the only check that holds under
       * concurrency. A spent link therefore resolves, and admits nobody new.
       */
      return isOpen(link, now) ? link : undefined;
    },

    async checkPasscode(ctx, tx, linkId, passcode) {
      requirePrivilegedContext(ctx, "checkPasscode");
      const now = nowOf(deps);
      const store = storeOf(ctx, tx);
      const record = await store.byId(linkId);
      if (record === undefined) return "not_found";
      const link = toResolvedLink(record);
      // `isOpen` for the same reason `resolve` uses it: this runs *after* `resolve` on a link the
      // caller already holds, and a returning visitor on a spent link still has to get past its
      // passcode. Refusing here would put the lockout back in front of the people the link
      // already admitted. Paused, revoked and expired still answer `not_found`, giving nothing
      // about the passcode away.
      if (!isOpen(link, now)) {
        await auditRefusal(ctx, tx, linkId, "not_found", { stage: "passcode" });
        return "not_found";
      }
      const stored = record.passcodeHash;
      // Nothing to check. The comparison is still run below for links that *do* carry one, so the
      // two paths do not differ by an HMAC — but there is no honest way to spend an attempt on a
      // link with no passcode, and nothing to guess.
      if (stored === null) return undefined;

      // Decided with no attempt spent: a locked link answers before the comparison, so a correct
      // guess cannot clear a lockout somebody else's guessing earned, and an empty box is not an
      // attempt. `attempts: 0` because this is the pre-attempt question.
      const gate = passcodeVerdict(
        {
          required: true,
          supplied: passcode,
          matches: false,
          attempts: 0,
          lockedUntil: link.passcodeLockedUntil,
        },
        now,
      );
      if (gate === "passcode_locked") {
        await auditRefusal(ctx, tx, linkId, "passcode_locked");
        return "passcode_locked";
      }
      if (gate === "passcode_required") return "passcode_required";

      // Counted *before* the comparison: a process that dies between the two has still spent the
      // attempt, where the other order gives a free guess per crash.
      const attempts = await store.recordPasscodeAttempt(linkId, now);
      if (attempts === undefined) {
        await auditRefusal(ctx, tx, linkId, "not_found", { stage: "passcode" });
        return "not_found";
      }
      const matches = verifyPasscode(deps.keyRing, passcode, linkId, stored);
      const verdict = passcodeVerdict(
        { required: true, supplied: passcode, matches, attempts, lockedUntil: null },
        now,
      );
      if (verdict === undefined) {
        // Honest typos must not accumulate into a lockout across months.
        await store.clearPasscodeAttempts(linkId);
        return undefined;
      }
      if (verdict === "passcode_locked") {
        // The lock also resets the counter: the lock *is* the punishment, and a counter left at
        // the ceiling would make every attempt after the lock expired instantly "locked" again.
        await store.lockPasscode(linkId, passcodeLockUntil(now));
      }
      await auditRefusal(ctx, tx, linkId, verdict, { attempts });
      return verdict;
    },

    admits: (link, email, now) => admitsPure(link, email, now ?? nowOf(deps)),

    async admitsEmail(ctx, tx, linkId, email) {
      requirePrivilegedContext(ctx, "admitsEmail");
      const record = await storeOf(ctx, tx).byId(linkId);
      if (record === undefined) return false;
      return admitsPure(toResolvedLink(record), email, nowOf(deps)) === undefined;
    },

    async redeem(ctx, tx, input) {
      requirePrivilegedContext(ctx, "redeem");
      const now = nowOf(deps);
      const store = storeOf(ctx, tx);
      const record = await store.byId(input.linkId);
      if (record === undefined) throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
      const link = toResolvedLink(record);

      // `isOpen`, **not** `isLive`: a use cap limits how many people may come in, not how long the
      // ones who did may stay (D3, A6). A visitor who already holds a binding must still be able
      // to redeem — that spends no seat — and an exhausted link must refuse a *new* one, which is
      // `claimUse`'s job and only `claimUse`'s job, because it is the one check that holds under
      // concurrency. Checking `isLive` here refused returning visitors the moment the link filled
      // up, while `PrincipalRepo` went on emitting its subject for them: a link that had stopped
      // letting its own people back in while still granting them everything.
      if (!isOpen(link, now)) {
        await auditRefusal(ctx, tx, input.linkId, "not_found", { stage: "redeem" });
        throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
      }
      if (input.email !== undefined) {
        const refusal = emailRefusal(link.policy, input.email);
        if (refusal !== undefined) {
          await auditRefusal(ctx, tx, input.linkId, refusal, { stage: "redeem" });
          throw refusalError(refusal);
        }
      }

      const claim = await store.upsertVisit({
        linkId: input.linkId,
        membershipId: input.membershipId,
        now,
        passcodeOkAt: input.passcodeOkAt ?? null,
      });
      if (claim.revokedAt !== null) {
        // The admin removed this visitor individually. Re-opening the URL must not undo that.
        await auditRefusal(ctx, tx, input.linkId, "not_found", { stage: "redeem_revoked_visit" });
        throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
      }
      if (claim.inserted) {
        // `max_uses` counts distinct memberships admitted, so only a *new* binding spends a seat;
        // a visitor returning on a second device does not. Throwing here rolls the binding back
        // with it, because the service runs inside the caller's transaction — which is the reason
        // the two statements can be trusted to agree.
        const uses = await store.claimUse(input.linkId, now);
        if (uses === undefined) {
          await auditRefusal(ctx, tx, input.linkId, "not_found", { stage: "claim_use" });
          throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
        }
      }

      await deps.audit.record(tx, ctx, {
        action: "share_link.redeemed",
        resourceKind: "share_link",
        resourceId: input.linkId,
        subjectMembershipId: input.membershipId,
        actorMembershipId: input.actor?.membershipId ?? input.membershipId,
        requestId: input.actor?.requestId ?? null,
        sessionId: input.actor?.sessionId ?? null,
        meta: { firstRedemption: claim.inserted, grants: record.grants.length },
      });
      deps.log?.("share_link.redeemed", {
        workspaceId: ctx.workspaceId,
        linkId: input.linkId,
        firstRedemption: claim.inserted,
      });
      return {
        linkId: input.linkId,
        membershipId: input.membershipId,
        visitId: claim.visitId,
        firstRedemption: claim.inserted,
        groupIds: record.groupIds,
        grants: record.grants,
        forceWatermark: record.policy.forceWatermark,
      };
    },

    async noteView(ctx, tx, linkId, membershipId, sessionId) {
      requirePrivilegedContext(ctx, "noteView");
      requireSessionId(sessionId);
      const now = nowOf(deps);
      const store = storeOf(ctx, tx);
      // `design/05` §4.4 counts unique *sessions*, not requests. The claim is the dedup: by
      // default one row in `core.share_link_view`, inserted with ON CONFLICT DO NOTHING, so a
      // reload inside an already-counted session costs one cheap conflicting insert and nothing
      // else — and, unlike the per-process set this replaced, a restart or a second node reads
      // the same row and does not count the session again.
      if (!(await viewSessions.claim(store, { linkId, membershipId, sessionId, now }))) return;
      // No live binding means this membership was never admitted through this link (or was
      // individually revoked) — there is no budget of theirs to spend. The claim above has
      // already been written, which is harmless and terminal: a revoked binding is never
      // resurrected (`upsertVisit` leaves `revoked_at` alone and `redeem` refuses on it), so
      // there is no later view of this session that the stale claim could wrongly suppress.
      if (!(await store.countVisitView(linkId, membershipId, now))) return;
      // The link-level budget is claimed with the same one-statement idiom as `max_uses`. A spent
      // budget is not an error here — the view has already happened; what it stops is the *next*
      // admission, which `admits` refuses on `isLive`. It does not stop the people already
      // inside from signing back in: `resolve` asks `isOpen` (see there).
      await store.claimView(linkId, now);
    },

    async revoke(ctx, tx, input) {
      requirePrivilegedContext(ctx, "revoke");
      const now = nowOf(deps);
      const store = storeOf(ctx, tx);
      const record = await store.byId(input.linkId);
      if (record === undefined) throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
      const revoked = await store.revoke(input.linkId, now, input.actor?.membershipId ?? null);
      if (revoked === undefined) {
        // Already revoked. Idempotent rather than a 409: the admin's intent is satisfied, and
        // moving `revoked_at` forward would lie about when sharing actually stopped.
        return;
      }
      let visitorsRevoked = 0;
      if (input.revokeVisitors === true) {
        for (const visit of await store.visits(input.linkId)) {
          if (await store.revokeVisit(input.linkId, visit.membershipId, now)) visitorsRevoked += 1;
        }
      }
      // D8: one write stops everyone the link admitted. `PrincipalRepo` stops emitting the `link`
      // subject and the bump makes every node re-read. Within one node the server's
      // `authz.invalidate(ws)` makes it immediate; across nodes it is bounded by the 5 s
      // `acl_version` re-read — which is what we claim, rather than design/03 B3's "< 1 s".
      await deps.audit.record(tx, ctx, {
        action: "share_link.revoked",
        resourceKind: "share_link",
        resourceId: input.linkId,
        actorMembershipId: input.actor?.membershipId ?? null,
        requestId: input.actor?.requestId ?? null,
        sessionId: input.actor?.sessionId ?? null,
        meta: { label: record.label, uses: record.uses, visitorsRevoked },
      });
      // After the audit row, as every bump-with-event is (the outbox write last).
      await store.bumpAcl("share_link.revoked");
      deps.log?.("share_link.revoked", {
        workspaceId: ctx.workspaceId,
        linkId: input.linkId,
        visitorsRevoked,
      });
    },

    async setPaused(ctx, tx, linkId, paused) {
      requirePrivilegedContext(ctx, "setPaused");
      const store = storeOf(ctx, tx);
      const moved = await store.setPaused(linkId, paused);
      if (moved === undefined) {
        const current = await store.byId(linkId);
        if (current === undefined) throw new ShareLinkError("not_found", NOT_FOUND_MESSAGE);
        throw new ShareLinkError("conflict", `the link is already ${current.status}`, {
          status: current.status,
        });
      }
      // A paused link stops admitting, so the subject must stop being emitted just as it does on a
      // revoke: a pause that only hid the row from the admin list would go on admitting people.
      await deps.audit.record(tx, ctx, {
        action: paused ? "share_link.paused" : "share_link.resumed",
        resourceKind: "share_link",
        resourceId: linkId,
        meta: { label: moved.label },
      });
      await store.bumpAcl(paused ? "share_link.paused" : "share_link.resumed");
      return toLinkSummary(moved, (await store.visits(linkId)).length);
    },

    list(ctx, tx, filter) {
      requirePrivilegedContext(ctx, "list");
      return storeOf(ctx, tx).list(filter);
    },

    visits(ctx, tx, linkId) {
      requirePrivilegedContext(ctx, "visits");
      return storeOf(ctx, tx).visits(linkId);
    },

    async bind(ctx, tx, input) {
      // `establishMembership` calls this while creating the visitor's membership, so it must do so
      // under the `system` context and not under the membership it is in the middle of creating.
      // What it writes is the binding; the grants were written against the link at mint time and
      // are returned here only so the caller can say what the link promised (contract §2).
      requirePrivilegedContext(ctx, "bind");
      const result = await service.redeem(ctx, tx, input);
      return { groupIds: result.groupIds, grants: result.grants };
    },
  };

  return service;
}

/**
 * The structural `ShareLinkAccess` (contract S2), adapted from the service.
 *
 * A separate object rather than two more methods on the service, because `ShareLinkService.admits`
 * is the *pure* two-argument function while `ShareLinkAccess.admits` is the async four-argument
 * one. `admits` here answers `false` for a link that does not exist, which is the same collapse
 * the wire makes: `checkEligibility` must not be able to distinguish "no such link" from "not
 * your email", or the OTP start endpoint becomes the enumeration oracle the 404 was protecting.
 */
export function createShareLinkAccess(service: ShareLinkService): ShareLinkAccess {
  return {
    admits: (ctx, tx, linkId, email) => service.admitsEmail(ctx, tx, linkId, email),
    bind: (ctx, tx, input) => service.bind(ctx, tx, input),
  };
}

/** `email_not_allowed` is the one refusal a redeemer has earned the right to be told apart. */
function refusalError(refusal: AdmissionRefusal): ShareLinkError {
  if (refusal === "email_not_allowed") {
    return new ShareLinkError("forbidden", "that address is not on this link's list", {
      reason: refusal,
    });
  }
  return new ShareLinkError("not_found", NOT_FOUND_MESSAGE, { reason: "not_found" });
}

function checkCap(value: number | null | undefined, field: string): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ShareLinkError("validation_failed", `${field} must be a positive whole number`, {
      field,
    });
  }
}

function explainRefusal(code: "links_not_permitted" | "audience_too_open"): string {
  return code === "links_not_permitted"
    ? "this offering mode does not permit share links"
    : "under Rule 506(b) a share link must name its audience (a domain allowlist or named emails)";
}
