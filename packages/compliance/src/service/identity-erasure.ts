import { deleteAiRequestsOfMember } from "@fundroom/ai";
import { auditAutoRevoked, revokeApiKeysOfMember } from "@fundroom/api-keys";
import { bumpAcl, GrantRepo } from "@fundroom/authz";
import { DSAR_IDENTITY_STEP, type DsarRequest } from "@fundroom/db";
import { pseudonymiseESignEnvelopesOfMember } from "@fundroom/esign";
import { publish } from "@fundroom/events";
import { AccessRequestRepo, MembershipRepo } from "@fundroom/identity";
import { pseudonymiseIntegrationBookingsOfMember } from "@fundroom/integrations";
import { WebhookDeliveryRepo } from "@fundroom/webhooks";
import { ComplianceError } from "../errors.js";
import { DsarStepRepo } from "../repos/dsar-repo.js";
import { IdentityErasureRepo, prelockErasureSubject } from "../repos/identity-erasure-repo.js";
import type { ErasureDeps, TenantContext, Tx } from "./types.js";

/*
 * The kernel's own erasure step, `core.identity` (E2.7 DSAR, contract §5).
 *
 * It runs **last**: in the transaction of whichever module reported the final expected step (or
 * in the request's own transaction when no module is expected), after every module has already
 * erased what it holds. That ordering is load-bearing. Modules read the member's address and
 * profile while they erase — the CRM matches unlinked contacts by email — so the identity must
 * still be readable when their step runs, and only the kernel may take it away afterwards.
 *
 * In order, on the caller's transaction and connection:
 *  1. the membership profile → `{}` and the staff-written relationship note → null;
 *  2. the membership → `revoked` (reason `erased`, with its delegates, groups, grants and the
 *     invites it issued, exactly as a People-screen revocation);
 *  3. invites that carried the address → pseudonymised, pending ones revoked; access requests
 *     (E3.1) that became the membership or carried the address → pseudonymised, open ones closed;
 *  4. this workspace's login challenges for the person → deleted;
 *  5. this workspace's sessions → revoked, ip/user agent scrubbed (sessions serving another
 *     workspace are that tenant's fact);
 *  5b. the API keys the member created → revoked (reason `erased`, E3.4), counted as
 *     `apiKeysRevoked`, with `api_key.auto_revoked` entries at the end, next to this step's own.
 *     By the time this step runs the transaction ALREADY holds the audit chain (`lockById` takes
 *     it; a module handler may have audited before reporting), while a key's own paths (revoke,
 *     rotate, rename, sweep) lock the key row and then audit. So the workspace's key cap lock and
 *     then the member's key rows are locked earlier, before the chain, by `prelockIdentityErasure`
 *     (the cap lock keeps a key from being minted for the member later in the same window, fix
 *     round 2) — at the start of every transaction
 *     that can reach this step: `DsarRequestRepo.lockById`, `erasure.request`, and (container) the
 *     start of every `member.erasure_requested` subscriber — and the revoke here re-locks rows
 *     this transaction already holds (E3.4 fix round 1, D1; E3.3 pre-locked Q&A rows the same way).
 *     The workspace row (`bumpAcl` below) is still taken under the chain, as on every kernel
 *     audit-then-`bumpAcl` path; nothing that locks the workspace row may then wait for the chain
 *     (D2: key creation takes its own advisory cap lock instead);
 *  5d. e-sign envelopes naming the member (by membership, or by the address for a signer who
 *     was never linked) → signer name/email pseudonymised (E3.5), counted as
 *     `esignEnvelopesPseudonymised`. Signed records and their artifacts are retained under legal
 *     hold; still-open envelopes are voided at the vendor by the e-sign sweep (`esign.void`). The
 *     e-sign connection advisory lock and the envelope rows are pre-locked before the chain by
 *     `prelockIdentityErasure`, like the API keys (entity rows are locked before the chain on
 *     every e-sign path);
 *  5e. recorded bookings (Calendly / Cal.com meetings, E3.6) naming the member by membership or
 *     by any of their email identities → pseudonymised (address → tombstone, name/title dropped,
 *     row kept for vendor-retry dedupe), counted as `integrationBookings`, and each of their
 *     addresses suppressed for future booking events (keyed hash, fix round 2) —
 *     `integrationBookingEmailsSuppressed`; the booking advisory lock and
 *     the rows are pre-locked before the chain by `prelockIdentityErasure`, as booking ingest
 *     takes them (so none is inserted for the member in between);
 *  5f. SCIM (E3.8): the member's `scim_user` rows → `user_name` `erased-<id>@invalid`, the other
 *     personal fields null, deactivated (`scimUsers`; pre-locked, step 2c); their group edges are
 *     kept (ids only). And the member's SSO identities of this workspace's connections
 *     (`user_identity` oidc|saml `<connectionId>|<subject>`) → deleted (`ssoIdentities`), so the
 *     tenant's IdP can no longer sign the pseudonymised account in; other tenants' links stay;
 *  5c. outbound webhook deliveries not yet `succeeded` whose payload names the member → deleted
 *     (E3.4), counted as `webhookDeliveries`: nothing queued or dead-lettered carries their id to
 *     a receiver after this. Delivered rows stay as the record of what left;
 *  6. `core.erase_user_identity`: pseudonymises the global user — display name '', every
 *     identifier → `erased+<identity row id>@erased.invalid`, credentials and devices deleted, every session
 *     revoked — **only** when the person holds no other live membership anywhere; otherwise the
 *     per-workspace erasure above is all there is, and the answer says so (`global: false`).
 *
 * `LegalServices.isErased` stays true afterwards: it reads the (completed) erasure request, not
 * the identity.
 *
 * **The last active owner is never erased.** The request route refuses one, but a co-owner may
 * step down between the request and the last module's report. The step is therefore gated on
 * `identityBlockedBy` at completion time, by the caller (`./erasure.ts`): a blocked request stays
 * `requested`, every module step stays recorded, nothing about the identity is touched (no
 * membership revoke, no session revoke, no `erase_user_identity`), and the request detail reports
 * `blockedReason: "last_owner"` (computed on read, never stored — `dsar_step` is insert-only and
 * a stored "blocked" step would stand in for the real one forever). Once ownership has moved,
 * `POST /compliance/data-requests/{id}/complete` runs the step and completes the request.
 * `eraseIdentity` itself refuses a last owner as a backstop.
 */

/** Why the identity step cannot run right now, if it cannot. */
export type IdentityBlockedReason = "last_owner";

/**
 * `"last_owner"` when no *other* owner could administer the workspace once this member is gone:
 * erasing them would revoke the membership (and, globally, the login) of the one person able to
 * administer it. "Other owner" is `countActiveOwners`' predicate (E3.2) — active and unexpired at
 * `now`, the erasure's own clock — so an invited or dormant co-owner does not unblock it.
 *
 * Every erase path passes `lock: true` (the default): the owner rows are locked (`lockOwners`,
 * the same lock revoke/demote/transfer take, R1-A5) **before** the target is read and the others
 * counted. Without it a concurrent revocation of owner B and erasure of owner A each counted the
 * other as the surviving owner and the workspace was left with none (E3.2 L-1). On every path
 * that completes an erasure the owner rows are already held by then — `prelockIdentityErasure`
 * takes them before the workspace row and the chain (R3B: taken here, under them, they closed a
 * cycle with an ownership transfer that held them and waited for the workspace row). Only a read that
 * merely *reports* the reason (`withBlockedReason`) passes `lock: false`.
 */
export async function identityBlockedBy(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  now: Date = new Date(),
  options: { readonly lock?: boolean } = {},
): Promise<IdentityBlockedReason | undefined> {
  const memberships = new MembershipRepo(ctx, tx);
  if (options.lock !== false) await memberships.lockOwners();
  const target = await new IdentityErasureRepo(ctx, tx).membership(membershipId);
  if (target === undefined || target.role !== "owner" || target.status === "revoked") {
    return undefined;
  }
  const others = await memberships.countActiveOwners(now, {
    excluding: membershipId,
  });
  return others < 1 ? "last_owner" : undefined;
}

/**
 * Locks what the identity step will lock under the workspace row and the audit chain but other
 * paths lock BEFORE them — API keys (D1), e-sign envelopes (E3.5), and (R3B) the owner rows, the
 * membership and its delegates, their group rows, invites and grants, the address's access
 * requests and challenges: see `prelockErasureSubject` for the order and why. Call it before the
 * transaction's first audit entry and before `DsarRequestRepo.lockById` (which calls it too);
 * idempotent within a transaction.
 */
export async function prelockIdentityErasure(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<void> {
  await prelockErasureSubject(ctx, tx, membershipId);
}

export interface IdentityErasureResult {
  readonly global: boolean;
  readonly counts: Readonly<Record<string, number>>;
}

export async function eraseIdentity(
  deps: Pick<ErasureDeps, "audit" | "log" | "bookingSuppressionKeys">,
  ctx: TenantContext,
  tx: Tx,
  request: DsarRequest,
  at: Date,
): Promise<IdentityErasureResult> {
  const repo = new IdentityErasureRepo(ctx, tx);
  const target = await repo.membership(request.membershipId);
  const counts = {
    profiles: 0,
    memberships: 0,
    grants: 0,
    invites: 0,
    accessRequests: 0,
    challenges: 0,
    sessions: 0,
    apiKeysRevoked: 0,
    webhookDeliveries: 0,
    esignEnvelopesPseudonymised: 0,
    integrationBookings: 0,
    integrationBookingEmailsSuppressed: 0,
    scimUsers: 0,
    ssoIdentities: 0,
    aiRequests: 0,
    global: 0,
  };
  let revokedKeys: Awaited<ReturnType<typeof revokeApiKeysOfMember>> = [];
  let global = false;

  if (target !== undefined) {
    const memberships = new MembershipRepo(ctx, tx);
    // Read before anything is scrubbed: the address is what matches invites and challenges.
    const email = (await memberships.namesFor([request.membershipId])).get(
      request.membershipId,
    )?.email;
    if ((await identityBlockedBy(ctx, tx, request.membershipId, at)) !== undefined) {
      // The caller checks first; this is the backstop, before anything is scrubbed.
      throw new ComplianceError(
        "conflict",
        "the workspace's last owner cannot be erased; transfer ownership first",
        { reason: "last_owner" },
      );
    }
    revokedKeys = await revokeApiKeysOfMember(tx, ctx, request.membershipId, "erased", at);
    counts.apiKeysRevoked = revokedKeys.length;
    counts.profiles = await repo.scrubMembership(request.membershipId);

    if (target.status !== "revoked") {
      const revoked = await memberships.revoke(request.membershipId, { reason: "erased" });
      counts.memberships = revoked.length;
      if (revoked.length > 0) {
        counts.grants = await new GrantRepo(ctx, tx).revokeForMemberships(revoked);
        await publish(tx, ctx, "membership.revoked", {
          membershipIds: revoked,
          byMembershipId: null,
          reason: "erased",
        });
        await bumpAcl(tx, ctx, "membership");
      }
    }

    counts.invites = await repo.scrubInvites(request.membershipId, email ?? null);
    // E3.1: the public access requests that became this member or carried the address.
    counts.accessRequests = await new AccessRequestRepo(ctx, tx).scrubForSubject(
      request.membershipId,
      email ?? null,
      at,
    );
    counts.challenges = await repo.deleteChallenges(target.userId, email ?? null);
    counts.sessions = await repo.revokeWorkspaceSessions(target.userId);
    counts.webhookDeliveries = await new WebhookDeliveryRepo(ctx, tx).deleteUnsentReferencing(
      request.membershipId,
    );
    counts.esignEnvelopesPseudonymised = await pseudonymiseESignEnvelopesOfMember(
      tx,
      ctx,
      request.membershipId,
      email ?? null,
      at,
    );
    const bookings = await pseudonymiseIntegrationBookingsOfMember(
      tx,
      ctx,
      request.membershipId,
      email ?? null,
      at,
      deps.bookingSuppressionKeys,
    );
    counts.integrationBookings = bookings.rows;
    counts.integrationBookingEmailsSuppressed = bookings.suppressed;
    counts.scimUsers = await repo.scrubScimUsers(request.membershipId, target.userId);
    counts.ssoIdentities = await repo.deleteSsoIdentities(target.userId);
    // E3.12: the member's AI requests (suggestions + params) → deleted; row locks only.
    counts.aiRequests = await deleteAiRequestsOfMember(tx, ctx, request.membershipId);
    global = await repo.eraseUserIdentity(target.userId);
    counts.global = global ? 1 : 0;
  }

  await auditAutoRevoked(deps.audit, tx, ctx, revokedKeys, "erased");
  await new DsarStepRepo(ctx, tx).record({
    requestId: request.id,
    module: DSAR_IDENTITY_STEP,
    completedAt: at,
    counts,
  });
  await deps.audit.record(tx, ctx, {
    action: "compliance.identity_erased",
    resourceKind: "dsar_request",
    resourceId: request.id,
    subjectMembershipId: request.membershipId,
    meta: { global, counts },
  });
  return { global, counts };
}
