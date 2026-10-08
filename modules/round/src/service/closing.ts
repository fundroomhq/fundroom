import {
  type Membership,
  pgErrorCode,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ESignEnvelopeView, ModuleServices } from "@fundroom/module-kit";
import {
  buildPrefill,
  type ClosingChecklist,
  type ClosingSummary,
  closingChecklist,
  closingSummary,
  isKernelEnvelopeLive,
  isOpenSignatureStatus,
  isVoidableSignatureRequest,
  mirrorStatus,
  nextMirrorStatus,
  PENDING_CLAIM_TTL_MS,
  signatureRequestRefusal,
  signedTransition,
  vaultFolderFor,
} from "../closing/rules.js";
import { type Actor, RoundError } from "../errors.js";
import { type SignatureRequestRecord, SignatureRequestRepo } from "../repos/closing-repo.js";
import {
  type ClosingTaskRecord,
  ClosingTaskRepo,
  type CommitmentRecord,
  CommitmentRepo,
  type RoundRecord,
  RoundRepo,
  readRoundSettings,
  TermsRepo,
} from "../repos/round-repo.js";

/*
 * The round closing workflow (E3.5 §6, ADR-0053): sending a commitment's subscription agreement
 * for e-signature, mirroring the kernel envelope's status, confirming wired money, and the
 * derived closing checklist.
 *
 * **Sending, and why there is a `pending` row.** The kernel e-sign service's `request()` talks to
 * the vendor and so MUST NOT run inside a transaction (E2.6's pool-deadlock rule). A naive
 * "check there is no open request → call the vendor → insert the row" loses the race between two
 * admins pressing Send at once: both checks pass and the vendor gets two envelopes. So the claim
 * comes first:
 *
 *   tx1  lock the commitment's open request rows, then the commitment row; check every
 *        precondition; INSERT a `pending` request (the partial unique index on open statuses is
 *        what makes the claim exclusive — the loser of a race gets 23505 → 409);
 *   ---  `services.esign.request()` with no transaction open;
 *   tx2  lock the request row, attach the envelope, mirror its status, audit, publish.
 *
 * A vendor failure turns the claim into `error` (with no envelope id that is final, so the next
 * Send is free). A process that dies between the vendor call and tx2 leaves a `pending` claim;
 * the `esign.envelope_changed` handler adopts the envelope (it names the commitment as its
 * subject), and a claim older than `PENDING_CLAIM_TTL_MS` is expired by the next Send regardless.
 *
 * **Kernel `error` is not the end (fix C1).** An envelope the kernel marks `error` after it
 * reached the vendor is still live there and may yet be signed: the mirror follows it back out of
 * `error` (`nextMirrorStatus`), `completed` always wins, and a Send is refused while any earlier
 * request's envelope is still live (`isKernelEnvelopeLive`) — void it first.
 *
 * **Orphans (fix C2).** If `request()` fails after the vendor created the envelope (the kernel's
 * own second transaction failed, or the vendor answered too late), the claim is released as
 * `error` with no envelope and the vendor may still hold a live agreement we cannot see. We never
 * re-send by ourselves. The failure is audited (`round.signature_request_failed`, meta
 * `orphanRisk`); when the kernel later publishes that envelope (its stale-draft sweep marks it
 * `error`/`orphaned_draft`, which also raises the staff `esign.envelope_attention` alert), the
 * handler attaches it to the released claim and audits `round.signature_orphaned`, so the
 * checklist and the audit log show which request it belonged to.
 *
 * Lock order everywhere (contract §0): signature_request row(s) → commitment row → audit chain →
 * outbox. The kernel's envelope row is locked only inside the kernel's own transactions, which
 * never overlap these.
 */

export interface SendInput {
  readonly commitmentId: string;
  readonly message?: string | undefined;
  readonly signer?: { readonly name: string; readonly email: string } | undefined;
  readonly companyName: string;
  readonly actor: Actor;
}

export interface SendResult {
  readonly request: SignatureRequestRecord;
  readonly envelope: ESignEnvelopeView;
}

export interface RoundClosingRow {
  readonly commitment: CommitmentRecord;
  readonly investorName: string | null;
  readonly checklist: ClosingChecklist;
  readonly latest: SignatureRequestRecord | undefined;
}

export interface RoundClosingView {
  readonly round: RoundRecord;
  readonly summary: ClosingSummary;
  readonly rows: readonly RoundClosingRow[];
  readonly tasks: readonly ClosingTaskRecord[];
}

export interface InvestorClosingRow {
  readonly commitment: CommitmentRecord;
  readonly checklist: ClosingChecklist;
  readonly latest: SignatureRequestRecord | undefined;
  readonly canSign: boolean;
  readonly signedDocumentAvailable: boolean;
}

export interface InvestorClosingView {
  readonly round: RoundRecord | undefined;
  readonly rows: readonly InvestorClosingRow[];
  readonly readOnly: boolean;
}

const auditActor = (actor: Actor) => ({
  actorMembershipId: actor.membershipId,
  ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
  ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
  ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
});

const checklistFor = (c: CommitmentRecord, latest: SignatureRequestRecord | undefined) =>
  closingChecklist({
    status: c.status,
    signedAt: c.signedAt,
    wiredAt: c.wiredAt,
    confirmedAt: c.confirmedAt,
    latestRequest:
      latest === undefined ? undefined : { status: latest.status, sentAt: latest.sentAt },
  });

/**
 * Applies one kernel envelope status to the round's mirror, in the caller's (handler's)
 * transaction. Idempotent: a redelivered or out-of-order event is a no-op (`nextMirrorStatus`),
 * and the `signed` move plus `round.signature_completed` happen exactly once — on the
 * transition into `completed`, under the request row lock.
 *
 * Returns what happened, for logs and tests.
 */
export async function applyEnvelopeStatus(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  input: { readonly envelopeId: string; readonly status: string; readonly commitmentId: string },
): Promise<"unknown" | "unchanged" | "updated" | "completed"> {
  const requests = new SignatureRequestRepo(ctx, tx);
  let row = await requests.lockByEnvelope(input.envelopeId);
  let kernel: ESignEnvelopeView | undefined;
  let orphan: { requestId: string; envelope: ESignEnvelopeView } | undefined;
  if (row === undefined) {
    /*
     * No mirror carries this envelope yet: either tx2 of the send has not committed (the kernel
     * publishes before `request()` returns), or the sending process died after the vendor call.
     * Adopt the commitment's `pending` claim — but only one created no later than the envelope,
     * so a late event for an envelope whose claim was already expired can never hijack a newer
     * claim. The envelope is read in this transaction (never a second pool connection).
     */
    const open = await requests.lockOpenForCommitment(input.commitmentId);
    const pending = open.find((r) => r.status === "pending" && r.envelopeId === null);
    const envelope = await services.esign.get(tx, ctx, input.envelopeId);
    if (
      envelope === undefined ||
      envelope.subject.module !== "round" ||
      envelope.subject.kind !== "commitment" ||
      envelope.subject.id !== input.commitmentId
    ) {
      return "unknown";
    }
    const createdAt = new Date(Date.parse(envelope.createdAt));
    let claim: SignatureRequestRecord | undefined;
    if (pending !== undefined) {
      if (createdAt.getTime() < pending.createdAt.getTime()) return "unknown";
      claim = pending;
    } else {
      /*
       * Fix C2: no open claim, but a send for this commitment was released as `error` before
       * the envelope was created — its `request()` failed after (or while) the vendor created
       * it. Only an envelope that did (or may have) reached the vendor is such an orphan: a
       * plain refused create (never sent, not an orphaned draft) is left alone, as before.
       */
      if (envelope.sentAt === null && envelope.errorCode !== "orphaned_draft") return "unknown";
      claim = await requests.lockReleasedForCommitment(input.commitmentId, createdAt);
      if (claim === undefined) return "unknown";
      orphan = { requestId: claim.id, envelope };
    }
    kernel = envelope;
    row = claim;
  }
  const now = services.now();
  let incoming = mirrorStatus(input.status);
  /*
   * Fix C1: every move into or out of `error` is checked against the kernel's row as it is now
   * (read in this transaction). A stale `sent` redelivered after a real error does not mask it; a
   * stale `error` after a recovery does not re-enter it; and an `error` published for an envelope
   * whose row is `completed` (a permanent collect failure) mirrors the truth — signed.
   */
  if (incoming === "error" || row.status === "error") {
    kernel ??= await services.esign.get(tx, ctx, input.envelopeId);
    if (kernel !== undefined && incoming !== "completed") incoming = mirrorStatus(kernel.status);
  }
  let next = nextMirrorStatus(row.status, incoming, { hasEnvelope: true });
  if (next !== undefined && row.status === "error" && isOpenSignatureStatus(next)) {
    // Re-opening a released/`error` mirror while another request is open would break the
    // one-open-request rule (and the unique index): it stays `error`, and staff see the orphan.
    const others = await requests.lockOpenForCommitment(row.commitmentId);
    if (others.some((r) => r.id !== row?.id)) next = undefined;
  }
  const attach = row.envelopeId === null;
  if (orphan !== undefined) {
    await services.audit.record(tx, ctx, {
      action: "round.signature_orphaned",
      resourceKind: "round_signature_request",
      resourceId: orphan.requestId,
      meta: {
        roundId: row.roundId,
        commitmentId: row.commitmentId,
        envelopeId: input.envelopeId,
        envelopeStatus: orphan.envelope.status,
        errorCode: orphan.envelope.errorCode,
      },
    });
    services.log("round.signature_orphaned", {
      level: "warn",
      workspaceId: ctx.workspaceId,
      requestId: orphan.requestId,
      envelopeId: input.envelopeId,
    });
  }
  if (next === undefined && !attach) return "unchanged";
  const updated = await requests.apply(row.id, {
    status: next ?? row.status,
    envelopeId: input.envelopeId,
    at: now,
  });
  if (updated === undefined) return "unknown";
  if (next !== "completed") return next === undefined ? "unchanged" : "updated";

  const commitments = new CommitmentRepo(ctx, tx);
  const before = await commitments.lock(row.commitmentId);
  if (before !== undefined) {
    const move = signedTransition({ status: before.status, signedAt: before.signedAt });
    if (move.status !== undefined || move.stampSignedAt) {
      const after = await commitments.markSigned(before.id, { status: move.status, at: now });
      if (after !== undefined && after.status !== before.status) {
        await services.audit.record(tx, ctx, {
          action: "round.commitment_changed",
          resourceKind: "round_commitment",
          resourceId: before.id,
          ...(before.membershipId === null ? {} : { subjectMembershipId: before.membershipId }),
          meta: {
            roundId: before.roundId,
            from: before.status,
            to: after.status,
            source: "esign",
            envelopeId: input.envelopeId,
          },
        });
        await publish(tx, ctx, "round.commitment_changed", {
          commitmentId: before.id,
          roundId: before.roundId,
          status: after.status,
        });
      }
    }
  }
  await services.audit.record(tx, ctx, {
    action: "round.signature_completed",
    resourceKind: "round_signature_request",
    resourceId: row.id,
    meta: { roundId: row.roundId, commitmentId: row.commitmentId, envelopeId: input.envelopeId },
  });
  await publish(tx, ctx, "round.signature_completed", {
    roundId: row.roundId,
    commitmentId: row.commitmentId,
    envelopeId: input.envelopeId,
    ...(before?.membershipId == null ? {} : { membershipId: before.membershipId }),
  });
  return "completed";
}

/** `document.vaulted`: link the signed copy to the request and its commitment. Idempotent. */
export async function linkVaultedDocument(
  ctx: TenantContext,
  tx: Tx,
  input: { readonly envelopeId: string; readonly documentId: string },
): Promise<boolean> {
  const requests = new SignatureRequestRepo(ctx, tx);
  const row = await requests.lockByEnvelope(input.envelopeId);
  if (row === undefined) return false;
  const changed = await requests.setSignedDocument(row.id, input.documentId);
  if (!changed) return false;
  const commitments = new CommitmentRepo(ctx, tx);
  if ((await commitments.lock(row.commitmentId)) !== undefined)
    await commitments.setSignedDocument(row.commitmentId, input.documentId);
  return true;
}

/**
 * What a failed `request()` tells us (fix C2). A kernel refusal (`ESignError`: a code and an HTTP
 * status) happened before or instead of the vendor call — except a provider error that may have
 * reached the vendor anyway (`unavailable` = timed out, `invalid_response` = it answered but we
 * could not read it). Anything else (a database failure in the kernel's second transaction, a
 * crash) may have come after the vendor created the envelope.
 */
export function sendFailure(error: unknown): { code: string; orphanRisk: boolean } {
  const e = error as { code?: unknown; status?: unknown; details?: unknown } | null;
  if (
    e === null ||
    typeof e !== "object" ||
    typeof e.code !== "string" ||
    typeof e.status !== "number"
  )
    return { code: "internal", orphanRisk: true };
  if (e.code === "esign_provider_error") {
    const providerCode = (e.details as { providerCode?: unknown } | undefined)?.providerCode;
    return {
      code: e.code,
      orphanRisk: providerCode === "unavailable" || providerCode === "invalid_response",
    };
  }
  return { code: e.code, orphanRisk: false };
}

export function createClosingService(services: ModuleServices) {
  const { db } = services;

  /** tx1 of a send: the checks and the claim. Returns everything the vendor call needs. */
  async function claim(ctx: TenantContext, input: SendInput) {
    try {
      return await db.withTenant(ctx, async (tx) => {
        const requests = new SignatureRequestRepo(ctx, tx);
        const commitments = new CommitmentRepo(ctx, tx);
        // Lock order: the request rows first, then the commitment.
        const open = await requests.lockOpenForCommitment(input.commitmentId);
        const commitment = await commitments.lock(input.commitmentId);
        if (commitment === undefined) throw new RoundError("not_found", "no such commitment");
        const round = await new RoundRepo(ctx, tx).find(commitment.roundId);
        if (round === undefined) throw new RoundError("not_found", "no such commitment");
        const settings = await readRoundSettings(tx, ctx.workspaceId);
        const connection = await services.esign.connection(tx, ctx);
        const refusal = signatureRequestRefusal({
          roundStatus: round.status,
          commitmentStatus: commitment.status,
          connection:
            connection === undefined
              ? undefined
              : { supportsTemplates: connection.supports.templates },
          templateRef: settings.closing.subscriptionTemplateRef,
        });
        if (refusal !== undefined) {
          const messages: Record<typeof refusal.code, string> = {
            round_not_open: "a planning round has nothing to sign yet; open it first",
            commitment_not_signable: "only a soft or verbal commitment is sent for signature",
            esign_not_configured: "connect an e-signature vendor first",
            esign_template_unsupported:
              "the connected e-signature vendor cannot create envelopes from a template",
            subscription_template_missing:
              "set the subscription agreement template in the round settings first",
          };
          throw new RoundError(refusal.code, messages[refusal.code], {
            ...("status" in refusal ? { status: refusal.status } : {}),
          });
        }
        const now = services.now();
        const stale = open.filter(
          (r) =>
            r.status === "pending" && now.getTime() - r.createdAt.getTime() > PENDING_CLAIM_TTL_MS,
        );
        if (stale.length > 0) {
          await requests.expireStalePending(
            commitment.id,
            new Date(now.getTime() - PENDING_CLAIM_TTL_MS),
            now,
          );
        }
        if (open.length > stale.length) {
          throw new RoundError(
            "signature_request_open",
            "a signature request for this commitment is already open; void it first",
            { commitmentId: commitment.id },
          );
        }
        /*
         * Fix C1: an earlier request whose mirror says `error` may still be live at the vendor
         * (the kernel keeps polling it, and the investor may be signing it right now). A second
         * agreement would be a duplicate for the same deal: refuse until it is voided.
         */
        for (const errored of await requests.erroredWithEnvelope(commitment.id)) {
          if (errored.envelopeId === null) continue;
          const envelope = await services.esign.get(tx, ctx, errored.envelopeId);
          if (envelope !== undefined && isKernelEnvelopeLive(envelope)) {
            throw new RoundError(
              "signature_request_open",
              "an earlier signature request for this commitment is still live at the e-signature vendor; void it first",
              {
                commitmentId: commitment.id,
                requestId: errored.id,
                envelopeStatus: envelope.status,
              },
            );
          }
        }
        // The signer: the commitment's member, else whoever the admin named.
        let signer: { name: string; email: string; membershipId?: string } | undefined;
        if (commitment.membershipId !== null) {
          const names = await new MembershipRepo(ctx, tx).namesFor([commitment.membershipId]);
          const who = names.get(commitment.membershipId);
          const erased = await services.legal.isErased(tx, ctx, commitment.membershipId);
          if (who !== undefined && who.email !== null && !erased) {
            signer = {
              name: who.displayName,
              email: who.email,
              membershipId: commitment.membershipId,
            };
          }
        } else if (input.signer !== undefined) {
          signer = { name: input.signer.name, email: input.signer.email };
        }
        if (signer === undefined) {
          throw new RoundError(
            "signer_email_missing",
            commitment.membershipId === null
              ? "this commitment names no member: say who signs (name and email)"
              : "the investor has no email address to send the agreement to",
            { commitmentId: commitment.id },
          );
        }
        const terms = await new TermsRepo(ctx, tx).current(round.id, round.instrumentKind);
        const templateRef = settings.closing.subscriptionTemplateRef ?? "";
        const prefill = buildPrefill(settings.closing.prefill, {
          investorName: signer.name,
          investorEmail: signer.email,
          amount: commitment.amount,
          currency: round.currency,
          roundName: round.name,
          companyName: input.companyName,
          terms: terms?.terms,
          now,
        });
        const pending = await requests.insertPending({
          roundId: round.id,
          commitmentId: commitment.id,
          templateRef,
          sentByMembershipId: input.actor.membershipId,
          at: now,
        });
        const templateRole = settings.closing.templateRole;
        return { pending, round, commitment, signer, templateRef, templateRole, prefill };
      });
    } catch (error) {
      // `signature_request_open_idx`: another Send won the race between our lock read and insert.
      if (pgErrorCode(error) === "23505") {
        throw new RoundError(
          "signature_request_open",
          "a signature request for this commitment is already open; void it first",
          { commitmentId: input.commitmentId },
        );
      }
      throw error;
    }
  }

  return {
    async send(ctx: TenantContext, input: SendInput): Promise<SendResult> {
      const claimed = await claim(ctx, input);
      let envelope: ESignEnvelopeView;
      try {
        // No transaction is open here: the kernel runs its own short ones around the vendor.
        envelope = await services.esign.request(ctx, {
          purpose: "round_closing",
          subject: { module: "round", kind: "commitment", id: claimed.commitment.id },
          // The vendor template's signer role (DocuSign, multi-role DocuSeal; fix C3).
          signer: { ...claimed.signer, role: claimed.templateRole },
          title: `${claimed.round.name} — subscription agreement`,
          ...(input.message === undefined ? {} : { message: input.message }),
          document: {
            kind: "template",
            templateRef: claimed.templateRef,
            prefill: claimed.prefill,
          },
          vaultFolder: vaultFolderFor(claimed.round.name),
          // The vendor emails the signing link: an investor signs from their own mailbox.
          embedded: false,
          requestedByMembershipId: input.actor.membershipId,
        });
      } catch (error) {
        // Release the claim: an `error` with no envelope is final, so the next Send is free.
        const failure = sendFailure(error);
        await db.withTenant(ctx, async (tx) => {
          const requests = new SignatureRequestRepo(ctx, tx);
          const row = await requests.lock(claimed.pending.id);
          if (row === undefined || row.status !== "pending") return;
          await requests.apply(row.id, { status: "error", at: services.now() });
          /*
           * Fix C2: audited either way; `orphanRisk` when the failure may have come after the
           * vendor created the envelope (not a clean kernel refusal). We never re-send: the
           * kernel's stale-draft sweep surfaces the envelope (staff alert) and the handler then
           * attaches it to this claim (`round.signature_orphaned`).
           */
          await services.audit.record(tx, ctx, {
            action: "round.signature_request_failed",
            resourceKind: "round_signature_request",
            resourceId: row.id,
            ...auditActor(input.actor),
            ...(claimed.commitment.membershipId === null
              ? {}
              : { subjectMembershipId: claimed.commitment.membershipId }),
            meta: {
              roundId: claimed.round.id,
              commitmentId: claimed.commitment.id,
              errorCode: failure.code,
              orphanRisk: failure.orphanRisk,
            },
          });
        });
        if (failure.orphanRisk) {
          services.log("round.signature_request_orphan_risk", {
            level: "warn",
            workspaceId: ctx.workspaceId,
            requestId: claimed.pending.id,
            errorCode: failure.code,
          });
        }
        throw error;
      }
      const request = await db.withTenant(ctx, async (tx) => {
        const requests = new SignatureRequestRepo(ctx, tx);
        const row = await requests.lock(claimed.pending.id);
        if (row === undefined) throw new RoundError("not_found", "the signature request is gone");
        let current = row;
        if (row.envelopeId === null || row.envelopeId === envelope.id) {
          const next = nextMirrorStatus(row.status, mirrorStatus(envelope.status), {
            hasEnvelope: true,
          });
          if (next !== undefined || row.envelopeId === null) {
            current =
              (await requests.apply(row.id, {
                status: next ?? row.status,
                envelopeId: envelope.id,
                at: services.now(),
              })) ?? row;
          }
        } else {
          services.log("round.signature_request_envelope_mismatch", {
            level: "warn",
            workspaceId: ctx.workspaceId,
            requestId: row.id,
          });
        }
        await services.audit.record(tx, ctx, {
          action: "round.signature_requested",
          resourceKind: "round_signature_request",
          resourceId: row.id,
          ...auditActor(input.actor),
          ...(claimed.commitment.membershipId === null
            ? {}
            : { subjectMembershipId: claimed.commitment.membershipId }),
          meta: {
            roundId: claimed.round.id,
            commitmentId: claimed.commitment.id,
            envelopeId: envelope.id,
            status: current.status,
            prefillFields: Object.keys(claimed.prefill).length,
          },
        });
        await publish(tx, ctx, "round.commitment_changed", {
          commitmentId: claimed.commitment.id,
          roundId: claimed.round.id,
          status: claimed.commitment.status,
        });
        return current;
      });
      return { request, envelope };
    },

    async void(
      ctx: TenantContext,
      id: string,
      reason: string,
      actor: Actor,
    ): Promise<SignatureRequestRecord> {
      const row = await db.withTenant(ctx, async (tx) => {
        const requests = new SignatureRequestRepo(ctx, tx);
        const found = await requests.lock(id);
        if (found === undefined) throw new RoundError("not_found", "no such signature request");
        // An `error` mirror with an envelope may still be live at the vendor (fix C1): voidable.
        if (!isVoidableSignatureRequest(found.status, found.envelopeId)) {
          throw new RoundError("envelope_not_open", "this signature request is already closed", {
            status: found.status,
          });
        }
        if (found.envelopeId === null) {
          const age = services.now().getTime() - found.createdAt.getTime();
          if (age <= PENDING_CLAIM_TTL_MS) {
            throw new RoundError(
              "signature_request_pending",
              "this signature request is still being created; try again in a moment",
              {},
            );
          }
          // A crashed claim: nothing reached the vendor that we know of.
          const released = await requests.apply(found.id, {
            status: "error",
            at: services.now(),
          });
          return { record: released ?? found, done: true as const };
        }
        return { record: found, done: false as const };
      });
      if (row.done) return row.record;
      const envelopeId = row.record.envelopeId;
      if (envelopeId === null) return row.record;
      // Outside any transaction: the kernel voids at the vendor.
      const envelope = await services.esign.void(ctx, envelopeId, reason, actor.membershipId);
      return db.withTenant(ctx, async (tx) => {
        const requests = new SignatureRequestRepo(ctx, tx);
        const locked = await requests.lock(id);
        if (locked === undefined) throw new RoundError("not_found", "no such signature request");
        const next = nextMirrorStatus(locked.status, mirrorStatus(envelope.status), {
          hasEnvelope: true,
        });
        const updated =
          next === undefined
            ? locked
            : ((await requests.apply(locked.id, { status: next, at: services.now() })) ?? locked);
        await services.audit.record(tx, ctx, {
          action: "round.signature_voided",
          resourceKind: "round_signature_request",
          resourceId: locked.id,
          ...auditActor(actor),
          meta: {
            roundId: locked.roundId,
            commitmentId: locked.commitmentId,
            envelopeId,
            status: updated.status,
          },
        });
        return updated;
      });
    },

    async confirm(
      ctx: TenantContext,
      commitmentId: string,
      actor: Actor,
    ): Promise<{ commitment: CommitmentRecord; currency: string }> {
      return db.withTenant(ctx, async (tx) => {
        const commitments = new CommitmentRepo(ctx, tx);
        const c = await commitments.lock(commitmentId);
        if (c === undefined) throw new RoundError("not_found", "no such commitment");
        const round = await new RoundRepo(ctx, tx).find(c.roundId);
        if (round === undefined) throw new RoundError("not_found", "no such commitment");
        if (c.status !== "wired") {
          throw new RoundError("commitment_not_wired", "only a wired commitment can be confirmed", {
            status: c.status,
          });
        }
        // Idempotent: confirming twice is not a second confirmation (nor a second email).
        if (c.confirmedAt !== null) return { commitment: c, currency: round.currency };
        const confirmed = await commitments.confirm(c.id, actor.membershipId, services.now());
        if (confirmed === undefined) throw new RoundError("not_found", "no such commitment");
        await services.audit.record(tx, ctx, {
          action: "round.commitment_confirmed",
          resourceKind: "round_commitment",
          resourceId: c.id,
          ...auditActor(actor),
          ...(c.membershipId === null ? {} : { subjectMembershipId: c.membershipId }),
          meta: { roundId: c.roundId },
        });
        await publish(tx, ctx, "round.commitment_confirmed", {
          roundId: c.roundId,
          commitmentId: c.id,
          ...(c.membershipId === null ? {} : { membershipId: c.membershipId }),
        });
        return { commitment: confirmed, currency: round.currency };
      });
    },

    /** The staff checklist for one round (derived; nothing here is stored). */
    async roundClosing(ctx: TenantContext, roundId: string): Promise<RoundClosingView> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const commitments = await new CommitmentRepo(ctx, tx).listForRound(roundId);
        const latest = await new SignatureRequestRepo(ctx, tx).latestForRound(roundId);
        const tasks = await new ClosingTaskRepo(ctx, tx).listForRound(roundId);
        const names = await new MembershipRepo(ctx, tx).namesFor(
          commitments.flatMap((c) => (c.membershipId === null ? [] : [c.membershipId])),
        );
        const rows = commitments.map((c) => {
          const last = latest.get(c.id);
          return {
            commitment: c,
            investorName:
              (c.membershipId === null ? undefined : names.get(c.membershipId)?.displayName) ??
              c.displayName,
            checklist: checklistFor(c, last),
            latest: last,
          };
        });
        return {
          round,
          summary: closingSummary(
            rows.map((r) => ({ stage: r.checklist.stage, amount: r.commitment.amount })),
          ),
          rows,
          tasks,
        };
      });
    },

    /**
     * The investor's own closing card: their commitments to the round they are shown
     * (`/round/current`'s round). A delegate (scope `all`; narrower ones are refused by the
     * route) sees their **principal's** card, read-only — they act for the principal and already
     * read the round; they cannot sign (the envelope is addressed to the principal) and cannot
     * download the signed copy (the kernel serves it to the signer only).
     *
     * `round.commitment` has no external RLS path, so the commitments are read in a system
     * context narrowed to the one membership — the same pattern as the progress bar.
     */
    async investorClosing(ctx: TenantContext, viewer: Membership): Promise<InvestorClosingView> {
      const readOnly = viewer.role === "delegate";
      const subject = readOnly ? viewer.principalMembershipId : viewer.id;
      const round = await db.withTenant(ctx, (tx) => new RoundRepo(ctx, tx).currentForInvestor());
      if (round === undefined || subject === null || subject === undefined)
        return { round, rows: [], readOnly };
      const sys = systemContext(ctx.workspaceId);
      return db.withTenant(sys, async (tx) => {
        const commitments = await new CommitmentRepo(sys, tx).listForMember(round.id, subject);
        const latest = await new SignatureRequestRepo(sys, tx).latestForRound(round.id);
        const rows: InvestorClosingRow[] = [];
        for (const c of commitments) {
          const last = latest.get(c.id);
          let signedDocumentAvailable = false;
          if (!readOnly && last?.envelopeId != null && last.status === "completed") {
            const envelope = await services.esign.get(tx, sys, last.envelopeId);
            signedDocumentAvailable =
              envelope?.hasSigned === true && envelope.membershipId === viewer.id;
          }
          rows.push({
            commitment: c,
            checklist: checklistFor(c, last),
            latest: last,
            canSign:
              !readOnly &&
              last !== undefined &&
              (last.status === "sent" || last.status === "delivered"),
            signedDocumentAvailable,
          });
        }
        return { round, rows, readOnly };
      });
    },
  };
}

export type ClosingService = ReturnType<typeof createClosingService>;
