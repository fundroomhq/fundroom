import { listActiveWorkspaceIds, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import {
  ACCREDITATION_VENDOR_DRIVERS,
  AccreditationProviderError,
  type AccreditationVendorCheck,
  type AccreditationVendorDriver,
} from "@fundroom/ports";
import { RoundError } from "../errors.js";
import { EVIDENCE_MAX_BYTES, type InterestSubject } from "../model.js";
import {
  readRoundSettings,
  type VerificationRecord,
  VerificationRepo,
} from "../repos/round-repo.js";
import {
  canRenew,
  nextCheckAt,
  parseHandoff,
  pollingExhausted,
  START_ATTEMPTS,
  StoredHandoffSchema,
  SYNC_LEASE_MS,
  splitName,
  vendorExpiry,
  type WidgetHandoff,
} from "./vendor-rules.js";
import { storeEvidenceObject } from "./verification.js";

/*
 * Vendor-settled accreditation verification (E3.7, ADR-0055, contract §0 and §5).
 *
 * The rule everything here is shaped by: **a vendor is never called inside a database
 * transaction.** A verification row is inserted in the caller's transaction; the vendor start runs
 * from `round.verification_start` after that transaction commits; every check runs from
 * `round.verification_sync`, reading the row in one short transaction, calling the vendor with none
 * open, and writing the answer in another. A vendor callback is only a wake-up
 * (`accreditation.provider_updated` → a sync); what the vendor said is always re-read over its
 * authenticated API.
 *
 * Lock order of a decision: the verification row `FOR UPDATE` → (`legal` / audit →
 * `lockAuditChain`, which takes the workspace row first) → outbox. Only a row still `pending` is
 * decided: an admin who decided first (manually) wins over a later vendor answer. The sweeps
 * (`claimDue`, the lifecycle's expiry and reminder) take their rows `FOR UPDATE SKIP LOCKED` before
 * their first audit, so they never wait on a row while holding the chain.
 */

export const JOB_VERIFICATION_START = "round.verification_start";
export const JOB_VERIFICATION_SYNC = "round.verification_sync";
export const JOB_VERIFICATION_SYNC_DUE = "round.verification_sync_due";
export const JOB_VERIFICATION_LIFECYCLE = "round.verification_lifecycle";
export const VERIFICATION_SYNC_DUE_CRON = "*/15 * * * *";
export const VERIFICATION_LIFECYCLE_CRON = "10 5 * * *";

/** Five (re)verification starts per member per hour (contract §5). */
export const VERIFICATION_START_RATE = { max: 5, windowMs: 60 * 60_000 } as const;
/** Rows one sweep hands to the sync job per workspace (per-workspace fairness). */
export const SYNC_CLAIM_PER_WORKSPACE = 25;
/** VerifyInvestor callbacks name `vr:` refs a row may still know as `inv:`: wake at most this many. */
export const INV_WAKE_LIMIT = 50;
/** Lifecycle bounds per workspace and run. */
const LIFECYCLE_BATCH = 200;
const RECHECK_BATCH = 50;
/** A vendor-verified row nearing expiry is re-asked at most this often. */
const RECHECK_EVERY_MS = 20 * 60 * 60_000;
/** A running start's lease; the start queue's `expireInSeconds` is at least this. */
export const START_LEASE_MS = 10 * 60_000;
/** A vendor start with nothing recorded this long after the row was opened is re-queued. */
export const STALE_START_MS = 15 * 60_000;
/** …at most until the row has counted this many start attempts; then it is `start_failed`. */
export const STALE_START_ATTEMPTS = START_ATTEMPTS + 2;
/** Vendor starts an investor may ask for per day, and a workspace per hour (billing). */
export const VERIFICATION_START_DAILY = { max: 10, windowMs: 24 * 60 * 60_000 } as const;
export const WORKSPACE_START_RATE = { max: 50, windowMs: 60 * 60_000 } as const;
/** An expiry older than this is backlog (e.g. from before E3.7): marked, never mailed. */
const EXPIRED_NOTICE_MS = 7 * 86_400_000;
/** An aborted sync puts its row back this much later (deferred, not failed). */
const ABORT_DEFER_MS = 2 * 60_000;

export interface VerificationJobData {
  readonly workspaceId: string;
  readonly verificationId: string;
  readonly subject?: InterestSubject | undefined;
}

export const isVendorDriver = (p: string): p is AccreditationVendorDriver =>
  (ACCREDITATION_VENDOR_DRIVERS as readonly string[]).includes(p);

const codeOf = (error: unknown): { code: string; retryable: boolean } =>
  error instanceof AccreditationProviderError
    ? { code: error.code, retryable: error.retryable }
    : { code: "unavailable", retryable: true };

const idempotency = (job: string, id: string) => ({ idempotencyKey: `${job}:${id}` });

/** The attestation's evidence reference for a vendor decision (contract §0). */
export const vendorEvidenceNote = (driver: string, ref: string): string =>
  `vendor:${driver}:${ref}`.slice(0, 2000);

export interface OpenVerificationInput {
  readonly membershipId: string;
  readonly interestSubmissionId?: string | null | undefined;
  readonly reverificationOf?: string | null | undefined;
  readonly subject?: InterestSubject | undefined;
  readonly actorKind: "external" | "staff" | "system";
  readonly actor?:
    | {
        readonly membershipId: string;
        readonly requestId?: string | undefined;
        readonly sessionId?: string | undefined;
      }
    | undefined;
}

/**
 * Opens a verification inside the caller's transaction (a system context: the verification is
 * the company's record about the member, which no external may write). The provider is the
 * workspace's effective one *now*: a manual row carries `{kind:"upload"}` from the start; a vendor
 * row gets its handoff from the start job, which is enqueued in this same transaction so it exists
 * exactly when the row does — and runs only after the commit, so the vendor call is outside it.
 *
 * The caller holds the member's lock (`VerificationRepo.lockMember`) when it must not open a second
 * pending one.
 */
export async function openVerification(
  services: ModuleServices,
  tx: Tx,
  sys: TenantContext,
  input: OpenVerificationInput,
): Promise<{ readonly verification: VerificationRecord; readonly vendor: boolean }> {
  const provider = await services.accreditation.effective(tx, sys);
  const vendor = isVendorDriver(provider.driver);
  const verification = await new VerificationRepo(sys, tx).insert({
    membershipId: input.membershipId,
    interestSubmissionId: input.interestSubmissionId ?? null,
    provider: provider.driver,
    handoff: vendor ? null : { kind: "upload" },
    reverificationOf: input.reverificationOf ?? null,
  });
  const actor = input.actor;
  await services.audit.record(tx, sys, {
    action: "round.verification_requested",
    actorKind: input.actorKind,
    resourceKind: "round_verification",
    resourceId: verification.id,
    subjectMembershipId: input.membershipId,
    ...(actor === undefined
      ? {}
      : {
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        }),
    meta: {
      submissionId: input.interestSubmissionId ?? null,
      provider: verification.provider,
      reverificationOf: input.reverificationOf ?? null,
    },
  });
  await publish(tx, sys, "round.verification_requested", {
    verificationId: verification.id,
    membershipId: input.membershipId,
    ...(input.interestSubmissionId == null ? {} : { submissionId: input.interestSubmissionId }),
  });
  if (vendor) {
    await services.queue.sendInTransaction(
      tx,
      JOB_VERIFICATION_START,
      {
        workspaceId: sys.workspaceId,
        verificationId: verification.id,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
      },
      idempotency(JOB_VERIFICATION_START, verification.id),
    );
  }
  return { verification, vendor };
}

export type StartForMemberResult =
  | { readonly kind: "started"; readonly verification: VerificationRecord }
  | { readonly kind: "pending"; readonly verification: VerificationRecord };

export function createVendorVerificationService(services: ModuleServices) {
  const { db } = services;

  async function audit(
    tx: Tx,
    ctx: TenantContext,
    action: string,
    row: VerificationRecord,
    meta: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await services.audit.record(tx, ctx, {
      action,
      actorKind: "system",
      resourceKind: "round_verification",
      resourceId: row.id,
      subjectMembershipId: row.membershipId,
      meta: { verificationId: row.id, provider: row.provider, ...meta },
    });
  }

  /** A vendor decision: `verified` (with the certificate when there is one), `rejected`, `expired`. */
  async function decide(
    sys: TenantContext,
    row: VerificationRecord & { provider: AccreditationVendorDriver },
    check: AccreditationVendorCheck,
    signal: AbortSignal | undefined,
  ): Promise<VerificationRecord | undefined> {
    const now = services.now();
    const driver = row.provider;
    const ref = check.providerRef ?? row.providerRef ?? "";
    let status: "verified" | "rejected" | "expired";
    let expiresAt: Date | null = null;
    // The decision is recorded when WE made it (the certificate's retention clock and the audit
    // trail run from here); the vendor's own certification date only bounds the expiry and is kept
    // in the audit entry.
    const decidedAt = now;
    if (check.status === "accredited") {
      const exp = vendorExpiry({ expiresAt: check.expiresAt, decidedAt: check.decidedAt, now });
      /*
       * A renewal answered with the OLD accreditation (Parallel reuses the investor's record, so
       * a renewal's ref is the renewed row's ref) must not verify it. Two cases (fix round 3):
       *
       *  - an earlier decision of the SAME provider sharing the ref exists — the vendor may be
       *    repeating it: accept only an accreditation CERTIFIED after that one (after this row
       *    was opened when it has no vendor date); with no certification date at all, only one
       *    that names its own expiry, later than that decision's.
       *  - otherwise the renewed row (`reverification_of`) was decided by another provider or on
       *    another ref, so this cannot be the same accreditation: accept when the renewed row has
       *    already run out (expired), else when the answer stands until later than it.
       *
       * A held answer keeps polling and says why (`renewal_not_recertified`).
       */
      const previous = await db.withTenant(sys, (tx) =>
        new VerificationRepo(sys, tx).previousDecision(row, [
          ...new Set([row.providerRef, check.providerRef].filter((r): r is string => !!r)),
        ]),
      );
      let newer = true;
      if (previous.sameRef !== undefined) {
        const same = previous.sameRef;
        newer =
          check.decidedAt !== undefined
            ? check.decidedAt.getTime() > (same.vendorDecidedAt ?? row.createdAt).getTime()
            : check.expiresAt !== undefined &&
              exp !== "expired" &&
              exp.expiresAt.getTime() > same.expiresAt.getTime();
      } else if (previous.renewed !== undefined && previous.renewed.status === "verified") {
        const renewedUntil = previous.renewed.expiresAt;
        newer =
          renewedUntil === null ||
          (exp !== "expired" && exp.expiresAt.getTime() > renewedUntil.getTime());
      }
      if (!newer) {
        await db.withTenant(sys, (tx) =>
          new VerificationRepo(sys, tx).recordCheck(row.id, {
            vendorStatus: check.vendorStatus,
            ...(check.providerRef === undefined ? {} : { providerRef: check.providerRef }),
            checkedAt: now,
            nextCheckAt: nextCheckAt(now, row.checkAttempts + 1),
            // Said out loud: the investor still has to re-certify with the vendor.
            vendorError: "renewal_not_recertified",
          }),
        );
        return undefined;
      }
      if (exp === "expired") {
        status = "expired";
        expiresAt = check.expiresAt ?? null;
      } else {
        status = "verified";
        expiresAt = exp.expiresAt;
      }
    } else {
      status = "rejected";
    }

    // The certificate, fetched and stored with no transaction open (a vendor call, a scan and a
    // storage write). Any failure falls back to the `vendor:` note: the decision must not wait on
    // a PDF the vendor may not offer.
    let evidence:
      | (Awaited<ReturnType<typeof storeEvidenceObject>> & { contentType: string; bytes: number })
      | undefined;
    if (status === "verified") {
      try {
        const pdf = await services.accreditation.fetchEvidence(sys, {
          driver,
          providerRef: ref,
          ...(signal === undefined ? {} : { signal }),
        });
        if (
          pdf !== null &&
          pdf.bytes.byteLength > 0 &&
          pdf.bytes.byteLength <= EVIDENCE_MAX_BYTES
        ) {
          // Nothing overwrites a certificate a decision already recorded: the row is re-read
          // right before the object is written (and syncs of one row never run concurrently).
          const fresh = await db.withTenant(sys, (tx) =>
            new VerificationRepo(sys, tx).find(row.id),
          );
          if (fresh?.status !== "pending") return undefined;
          const stored = await storeEvidenceObject(services, sys.workspaceId, row.id, pdf.bytes);
          evidence = { ...stored, contentType: pdf.contentType, bytes: pdf.bytes.byteLength };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        services.log("round.verification_certificate_unavailable", {
          level: "warn",
          workspaceId: sys.workspaceId,
          verificationId: row.id,
          provider: driver,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }

    const outcome = await db.withTenant(sys, async (tx) => {
      const repo = new VerificationRepo(sys, tx);
      // Lock order: this row first, then (legal, audit →) the audit chain, then the outbox.
      const locked = await repo.lock(row.id);
      if (locked === undefined || locked.status !== "pending") {
        return { updated: undefined, lockedKey: locked?.evidenceKey ?? null };
      }
      /*
       * The late-writer rule: the member may have been erased while the vendor was being asked.
       * Nothing about them is written now — no decision, no attestation, no event — and the
       * certificate stored above is removed below (the row names no file).
       */
      if (await services.legal.isErased(tx, sys, locked.membershipId)) {
        await repo.recordVendorError(row.id, {
          vendorError: "member_erased",
          attempt: false,
          nextCheckAt: null,
        });
        return { updated: undefined, lockedKey: locked.evidenceKey };
      }
      const note = evidence === undefined ? vendorEvidenceNote(driver, ref) : null;
      const updated = await repo.decideByProvider(row.id, {
        status,
        method: status === "verified" ? "third_party" : null,
        provider: driver,
        providerRef: ref,
        vendorStatus: check.vendorStatus,
        decidedAt,
        ...(check.decidedAt === undefined ? {} : { vendorDecidedAt: check.decidedAt }),
        expiresAt,
        decisionNote:
          status === "rejected" ? (check.rejectionReason ?? null)?.slice(0, 2000) : null,
        evidenceNote: status === "verified" ? note : null,
        ...(evidence === undefined
          ? {}
          : {
              evidence: {
                key: evidence.key,
                sha256: evidence.sha256,
                contentType: evidence.contentType,
                bytes: evidence.bytes,
                encryption: evidence.encryption,
              },
            }),
      });
      if (updated === undefined) return { updated: undefined, lockedKey: locked.evidenceKey };
      if (status === "verified" && expiresAt !== null) {
        await services.legal.recordVerifiedAccreditation(tx, sys, {
          membershipId: updated.membershipId,
          method: "third_party",
          evidenceRef: evidence === undefined ? (note ?? "") : `storage:${evidence.key}`,
          expiresAt,
          actor: { provider: driver },
        });
      }
      await audit(tx, sys, "round.verification_synced", updated, {
        status: updated.status,
        vendorStatus: check.vendorStatus.slice(0, 100),
        method: updated.method,
        expiresAt: expiresAt?.toISOString() ?? null,
        vendorDecidedAt: check.decidedAt?.toISOString() ?? null,
        hasFile: evidence !== undefined,
        submissionId: updated.interestSubmissionId,
      });
      await publish(tx, sys, "round.verification_decided", {
        verificationId: updated.id,
        membershipId: updated.membershipId,
        status: updated.status,
      });
      return { updated, lockedKey: null };
    });

    // Somebody decided first (an admin, most likely): the certificate just written is nobody's.
    if (
      outcome.updated === undefined &&
      evidence !== undefined &&
      outcome.lockedKey !== evidence.key
    ) {
      const key = evidence.key;
      await services.storage.delete(key).catch((error: unknown) => {
        // The object is sealed under the workspace key and named by no row; it stays until
        // somebody removes it by hand (the evidence purge only follows rows). Said loudly.
        services.log("round.verification_orphan_certificate", {
          level: "warn",
          workspaceId: sys.workspaceId,
          verificationId: row.id,
          storageKey: key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return outcome.updated;
  }

  return {
    /**
     * `round.verification_start`: the vendor start, after the row's transaction committed. Retried
     * by the queue on a retryable failure; `check_attempts` counts the attempts, and after
     * `START_ATTEMPTS` (or at once on a refusal that will not change) the row says
     * `start_failed` and is not polled — an admin can retry it (check-now) or decide it.
     */
    async start(data: VerificationJobData, signal?: AbortSignal): Promise<void> {
      const sys = systemContext(data.workspaceId);
      const prep = await db.withTenant(sys, async (tx) => {
        const repo = new VerificationRepo(sys, tx);
        const row = await repo.find(data.verificationId);
        if (row === undefined || row.status !== "pending" || row.providerRef !== null) return;
        if (!isVendorDriver(row.provider) || row.vendorStatus === "start_failed") return;
        if (row.vendorError === "imported") return;
        if (await services.legal.isErased(tx, sys, row.membershipId)) {
          await repo.recordVendorError(row.id, {
            vendorError: "member_erased",
            attempt: false,
            nextCheckAt: null,
            vendorStatus: "start_failed",
          });
          return;
        }
        // Revoked, suspended, dormant or still invited: nobody the company should pay to verify.
        if ((await repo.memberStatus(row.membershipId)) !== "active") {
          const updated = await repo.recordVendorError(row.id, {
            vendorError: "member_inactive",
            attempt: false,
            nextCheckAt: null,
            vendorStatus: "start_failed",
          });
          if (updated !== undefined) {
            await audit(tx, sys, "round.verification_start_failed", updated, {
              code: "member_inactive",
            });
          }
          return;
        }
        /*
         * An attempt that actually runs: counted, and leased so neither the stale-start sweep nor a
         * redelivered job (the queue re-runs a job that expired mid-call) starts the vendor again
         * while it may still be running. At the attempt cap the start gives up.
         */
        const began = await repo.beginStart(row.id, {
          now: services.now(),
          leaseUntil: new Date(services.now().getTime() + START_LEASE_MS),
          maxAttempts: STALE_START_ATTEMPTS,
        });
        if (!began) {
          if (row.checkAttempts >= STALE_START_ATTEMPTS && row.vendorError !== "member_erased") {
            const updated = await repo.recordVendorError(row.id, {
              vendorError: "start_timeout",
              attempt: false,
              nextCheckAt: null,
              vendorStatus: "start_failed",
            });
            if (updated !== undefined) {
              await audit(tx, sys, "round.verification_start_failed", updated, {
                code: "start_timeout",
              });
            }
          }
          return;
        }
        const who = (await new MembershipRepo(sys, tx).namesFor([row.membershipId])).get(
          row.membershipId,
        );
        const submission =
          row.interestSubmissionId === null
            ? undefined
            : await repo.submissionSubject(row.interestSubmissionId);
        return {
          row: row as VerificationRecord & { provider: AccreditationVendorDriver },
          email: who?.email ?? null,
          displayName: who?.displayName ?? null,
          subject: data.subject ?? submission?.subject ?? ("individual" as const),
          entityName: submission?.entityName ?? null,
          portalName: await repo.workspaceName(),
        };
      });
      if (prep === undefined) return;
      const { row } = prep;

      const fail = async (code: string, final: boolean): Promise<void> => {
        await db.withTenant(sys, async (tx) => {
          const repo = new VerificationRepo(sys, tx);
          const updated = await repo.recordVendorError(row.id, {
            vendorError: code,
            // `beginStart` already counted this attempt.
            attempt: false,
            nextCheckAt: null,
            ...(final ? { vendorStatus: "start_failed" } : {}),
          });
          if (final && updated !== undefined) {
            await audit(tx, sys, "round.verification_start_failed", updated, { code });
          }
        });
      };

      if (prep.email === null) {
        await fail("no_email", true);
        return;
      }
      const names = splitName(prep.displayName);
      let result: Awaited<ReturnType<typeof services.accreditation.start>>;
      try {
        result = await services.accreditation.start(sys, {
          driver: row.provider,
          verificationId: row.id,
          subject: prep.subject,
          email: prep.email,
          ...names,
          ...(prep.subject === "entity" && prep.entityName !== null
            ? { legalName: prep.entityName }
            : prep.displayName !== null && !prep.displayName.includes("@")
              ? { legalName: prep.displayName }
              : {}),
          ...(prep.portalName === undefined ? {} : { portalName: prep.portalName }),
        });
      } catch (error) {
        /*
         * Stopping mid-call is as ambiguous as a timeout (the vendor may have created the
         * invitation): it is recorded as `unavailable` so the at-most-one-more-attempt rule below
         * applies to the redelivery, and the lease is released so that redelivery can begin.
         */
        if (signal?.aborted) {
          const final = row.vendorError === "unavailable";
          await fail("unavailable", final);
          if (final) return;
          throw error;
        }
        const { code, retryable } = codeOf(error);
        const mapped = code === "not_connected" ? "connection_changed" : code;
        /*
         * `unavailable` includes a timeout, after which the vendor may well have created the
         * invitation (VerifyInvestor has no lookup by our id): after one such ambiguous failure the
         * start is retried at most once more, so an investor is not invited three times.
         */
        const final =
          !retryable ||
          row.checkAttempts + 1 >= START_ATTEMPTS ||
          (code === "unavailable" && row.vendorError === "unavailable");
        await fail(mapped, final);
        if (!final) throw error;
        return;
      }

      const handoff = StoredHandoffSchema.safeParse(result.handoff);
      const ref = result.providerRef;
      if (
        !handoff.success ||
        handoff.data.kind === "upload" ||
        typeof ref !== "string" ||
        ref.length === 0 ||
        ref.length > 200
      ) {
        await fail("invalid_response", true);
        return;
      }
      const now = services.now();
      await db.withTenant(sys, async (tx) => {
        const repo = new VerificationRepo(sys, tx);
        // The late-writer rule: erased while the vendor was starting → none of the vendor's
        // handoff (the investor's email and name) is stored, and the row is never polled.
        const locked = await repo.lock(row.id);
        if (locked === undefined || locked.status !== "pending") return;
        if (await services.legal.isErased(tx, sys, locked.membershipId)) {
          await repo.recordVendorError(row.id, {
            vendorError: "member_erased",
            attempt: false,
            nextCheckAt: null,
            vendorStatus: "start_failed",
          });
          return;
        }
        const updated = await repo.recordStart(row.id, {
          providerRef: ref,
          handoff: handoff.data,
          vendorStatus: result.vendorStatus?.slice(0, 100) ?? null,
          checkedAt: now,
          nextCheckAt: nextCheckAt(now, 0),
        });
        if (updated !== undefined) {
          await audit(tx, sys, "round.verification_started", updated, {
            handoff: handoff.data.kind,
          });
        }
      });
    },

    /**
     * `round.verification_sync`: ask the vendor, then decide (see `decide`) or reschedule. Never
     * throws for a vendor failure — the row's backoff is the retry — and an abort defers the row
     * instead of counting against it.
     */
    async sync(data: VerificationJobData, signal?: AbortSignal): Promise<void> {
      const sys = systemContext(data.workspaceId);
      const now = services.now();
      const row = await db.withTenant(sys, async (tx) => {
        const repo = new VerificationRepo(sys, tx);
        const found = await repo.find(data.verificationId);
        if (found === undefined || found.status !== "pending" || found.providerRef === null) {
          return undefined;
        }
        if (!isVendorDriver(found.provider) || found.vendorError === "imported") return undefined;
        if (pollingExhausted(found.createdAt, now)) {
          await repo.recordVendorError(found.id, {
            vendorError: "polling_stopped",
            attempt: false,
            nextCheckAt: null,
          });
          return undefined;
        }
        if (await services.legal.isErased(tx, sys, found.membershipId)) {
          await repo.recordVendorError(found.id, {
            vendorError: "member_erased",
            attempt: false,
            nextCheckAt: null,
          });
          return undefined;
        }
        return found as VerificationRecord & { provider: AccreditationVendorDriver };
      });
      if (row === undefined || row.providerRef === null) return;

      let check: AccreditationVendorCheck;
      try {
        check = await services.accreditation.check(sys, {
          driver: row.provider,
          providerRef: row.providerRef,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        await db.withTenant(sys, async (tx) => {
          const repo = new VerificationRepo(sys, tx);
          if (signal?.aborted) {
            await repo.setNextCheck(row.id, new Date(now.getTime() + ABORT_DEFER_MS));
            return;
          }
          const { code } = codeOf(error);
          if (code === "not_connected") {
            // The workspace's connection is no longer this vendor: an admin decides this one.
            await repo.recordVendorError(row.id, {
              vendorError: "connection_changed",
              attempt: false,
              nextCheckAt: null,
            });
            return;
          }
          await repo.recordVendorError(row.id, {
            vendorError: code,
            attempt: true,
            nextCheckAt: nextCheckAt(now, row.checkAttempts + 1),
          });
        });
        return;
      }

      switch (check.status) {
        case "accredited":
        case "not_accredited":
        case "canceled":
        case "expired":
          try {
            await decide(sys, row, check, signal);
          } catch (error) {
            if (!signal?.aborted) throw error;
            await db.withTenant(sys, (tx) =>
              new VerificationRepo(sys, tx).setNextCheck(
                row.id,
                new Date(now.getTime() + ABORT_DEFER_MS),
              ),
            );
          }
          return;
        default:
          await db.withTenant(sys, (tx) =>
            new VerificationRepo(sys, tx).recordCheck(row.id, {
              vendorStatus: check.vendorStatus,
              ...(check.providerRef === undefined ? {} : { providerRef: check.providerRef }),
              checkedAt: now,
              nextCheckAt: nextCheckAt(now, row.checkAttempts + 1),
            }),
          );
      }
    },

    /**
     * `round.verification_sync_due`: every 15 minutes, per active workspace with the module on,
     * claims at most `SYNC_CLAIM_PER_WORKSPACE` due rows (`FOR UPDATE SKIP LOCKED`, leased) and
     * enqueues a sync for each in the same transaction.
     */
    async syncDue(input: {
      readonly workspaceId?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    }): Promise<number> {
      const ids =
        input.workspaceId === undefined ? await listActiveWorkspaceIds(db) : [input.workspaceId];
      let queued = 0;
      for (const workspaceId of ids) {
        if (input.signal?.aborted) break;
        const sys = systemContext(workspaceId);
        try {
          queued += await db.withTenant(sys, async (tx) => {
            const view = await services.enablement.get(db, sys, tx);
            if (!view.enabled.has("round")) return 0;
            const now = services.now();
            const repo = new VerificationRepo(sys, tx);
            // Every row this transaction acts on is locked (SKIP LOCKED) before its first audit.
            const claimed = await repo.claimDue(
              now,
              new Date(now.getTime() + SYNC_LEASE_MS),
              SYNC_CLAIM_PER_WORKSPACE,
            );
            const stale = await repo.lockStaleStarts(
              now,
              new Date(now.getTime() - STALE_START_MS),
              SYNC_CLAIM_PER_WORKSPACE,
            );
            for (const id of claimed) {
              await services.queue.sendInTransaction(
                tx,
                JOB_VERIFICATION_SYNC,
                { workspaceId, verificationId: id },
                idempotency(JOB_VERIFICATION_SYNC, id),
              );
            }
            /*
             * A start that never recorded anything (the job crashed or timed out on every attempt)
             * would leave the row pending with no ref forever: re-queue it (no lease here — the
             * start leases itself when it runs, and `stately` dedupes a queued one), until the
             * attempts the start job counted reach the cap, then give up like a failed start.
             */
            for (const row of stale) {
              if (row.checkAttempts >= STALE_START_ATTEMPTS) {
                const updated = await repo.recordVendorError(row.id, {
                  vendorError: "start_timeout",
                  attempt: false,
                  nextCheckAt: null,
                  vendorStatus: "start_failed",
                });
                if (updated !== undefined) {
                  await audit(tx, sys, "round.verification_start_failed", updated, {
                    code: "start_timeout",
                  });
                }
                continue;
              }
              await services.queue.sendInTransaction(
                tx,
                JOB_VERIFICATION_START,
                { workspaceId, verificationId: row.id },
                idempotency(JOB_VERIFICATION_START, row.id),
              );
            }
            return claimed.length + stale.length;
          });
        } catch (error) {
          services.log("round.verification_sync_due_failed", {
            level: "warn",
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return queued;
    },

    /**
     * `accreditation.provider_updated` (in the dispatcher's transaction): enqueue a sync for every
     * pending row of that driver naming one of the refs. VerifyInvestor's callback names the
     * verification request (`vr:`), which a row still knows by its invitation (`inv:`) until a
     * check upgrades it — so an unmatched VerifyInvestor ref wakes that workspace's `inv:` rows
     * (at most `INV_WAKE_LIMIT`).
     */
    async onProviderUpdated(
      tx: Tx,
      ctx: TenantContext,
      payload: { readonly driver: AccreditationVendorDriver; readonly refs: readonly string[] },
    ): Promise<number> {
      const repo = new VerificationRepo(ctx, tx);
      const refs = [...new Set(payload.refs)].slice(0, 20);
      const rows = await repo.pendingByRefs(payload.driver, refs);
      const matched = new Set(rows.map((r) => r.providerRef));
      const ids = new Set(rows.map((r) => r.id));
      if (payload.driver === "verifyinvestor" && refs.some((r) => !matched.has(r))) {
        for (const r of await repo.pendingWithRefPrefix("verifyinvestor", "inv:", INV_WAKE_LIMIT)) {
          ids.add(r.id);
        }
      }
      for (const id of ids) {
        await services.queue.sendInTransaction(
          tx,
          JOB_VERIFICATION_SYNC,
          { workspaceId: ctx.workspaceId, verificationId: id },
          idempotency(JOB_VERIFICATION_SYNC, id),
        );
      }
      return ids.size;
    },

    /**
     * An admin's "check now": a pending vendor row gets a sync (or, when its start never
     * succeeded, its start again).
     */
    async requestCheck(ctx: TenantContext, id: string): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const repo = new VerificationRepo(ctx, tx);
        const row = await repo.find(id);
        if (row === undefined) throw new RoundError("not_found", "no such verification");
        if (!isVendorDriver(row.provider)) {
          throw new RoundError(
            "verification_not_vendor",
            "this verification is decided by your team, not by an accreditation service",
            { provider: row.provider },
          );
        }
        if (row.status !== "pending") {
          throw new RoundError("conflict", "this verification has already been decided", {
            status: row.status,
          });
        }
        if (row.vendorError === "imported") {
          throw new RoundError(
            "conflict",
            "this verification was imported from another installation; decide it by hand",
            { vendorError: row.vendorError },
          );
        }
        if (row.providerRef === null) {
          if (row.vendorStatus === "start_failed") await repo.resetStart(row.id);
          await services.queue.sendInTransaction(
            tx,
            JOB_VERIFICATION_START,
            { workspaceId: ctx.workspaceId, verificationId: row.id },
            idempotency(JOB_VERIFICATION_START, row.id),
          );
          return;
        }
        await services.queue.sendInTransaction(
          tx,
          JOB_VERIFICATION_SYNC,
          { workspaceId: ctx.workspaceId, verificationId: row.id },
          idempotency(JOB_VERIFICATION_SYNC, row.id),
        );
      });
    },

    /** The investor's latest verification and whether they may start another. */
    async current(
      ctx: TenantContext,
      membershipId: string,
      reminderDays: number,
    ): Promise<{ readonly latest: VerificationRecord | undefined; readonly canRenew: boolean }> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new VerificationRepo(ctx, tx);
        const latest = await repo.latestForMember(membershipId);
        const pending =
          latest?.status === "pending" ? latest : await repo.pendingForMember(membershipId);
        return {
          latest,
          canRenew: canRenew({
            latest,
            pending: pending !== undefined,
            reminderDays,
            now: services.now(),
          }),
        };
      });
    },

    /**
     * The investor starting (or renewing) their own verification. Rate-limited first; one pending
     * verification per member (under the member's lock); refused while a verified one is far from
     * its expiry (a vendor bills the company per verification).
     */
    async startForMember(input: {
      readonly ctx: TenantContext;
      readonly membershipId: string;
      readonly subject: InterestSubject;
      readonly reminderDays: number;
      readonly actor: {
        readonly membershipId: string;
        readonly requestId?: string | undefined;
        readonly sessionId?: string | undefined;
      };
    }): Promise<StartForMemberResult> {
      /*
       * Budgets (a vendor bills the company per verification). The member's own (five an hour,
       * ten a day) are checked first and SPENT only when a verification is actually opened — a
       * 409 or a refusal costs nothing. The workspace's (50 vendor verifications an hour) is a
       * count of rows under a workspace-scoped lock, taken after the member's lock and before
       * the audit chain, so a burst cannot overshoot it.
       */
      const refused = (retryAfterMs: number) =>
        new RoundError("rate_limited", "too many verification requests; try again later", {
          retryAfterMs,
        });
      const memberBudgets = [
        [`round.verification_start:${input.membershipId}`, VERIFICATION_START_RATE],
        [`round.verification_start_day:${input.membershipId}`, VERIFICATION_START_DAILY],
      ] as const;
      for (const [key, rule] of memberBudgets) {
        const limit = await services.rateLimiter.peek(key, rule);
        if (!limit.allowed) throw refused(limit.retryAfterMs);
      }
      const sys = systemContext(input.ctx.workspaceId);
      const actorKind =
        input.ctx.actorKind === "external" ? ("external" as const) : ("staff" as const);
      const result = await db.withTenant(sys, async (tx) => {
        const repo = new VerificationRepo(sys, tx);
        await repo.lockMember(input.membershipId);
        const pending = await repo.pendingForMember(input.membershipId);
        if (pending !== undefined) return { kind: "pending" as const, verification: pending };
        const now = services.now();
        const latest = await repo.latestForMember(input.membershipId);
        if (!canRenew({ latest, pending: false, reminderDays: input.reminderDays, now })) {
          throw new RoundError(
            "conflict",
            "you are already verified; you can renew closer to the expiry",
            { expiresAt: latest?.expiresAt?.toISOString() ?? null },
          );
        }
        const provider = await services.accreditation.effective(tx, sys);
        if (isVendorDriver(provider.driver)) {
          await repo.lockWorkspaceStarts();
          const since = new Date(now.getTime() - WORKSPACE_START_RATE.windowMs);
          const opened = await repo.vendorOpenedSince(since);
          if (opened.count >= WORKSPACE_START_RATE.max) {
            const oldest = opened.oldest ?? now;
            throw refused(
              Math.max(0, oldest.getTime() + WORKSPACE_START_RATE.windowMs - now.getTime()),
            );
          }
        }
        const opened = await openVerification(services, tx, sys, {
          membershipId: input.membershipId,
          subject: input.subject,
          reverificationOf: latest !== undefined && latest.status !== "rejected" ? latest.id : null,
          actorKind,
          actor: input.actor,
        });
        return { kind: "started" as const, verification: opened.verification };
      });
      if (result.kind === "started") {
        for (const [key, rule] of memberBudgets) await services.rateLimiter.hit(key, rule);
      }
      return result;
    },

    /** The widget handoff of the member's latest pending verification, when it has one. */
    async widgetHandoff(
      ctx: TenantContext,
      membershipId: string,
    ): Promise<{ readonly row: VerificationRecord; readonly handoff: WidgetHandoff } | undefined> {
      const row = await db.withTenant(ctx, (tx) =>
        new VerificationRepo(ctx, tx).pendingForMember(membershipId),
      );
      if (row === undefined) return undefined;
      const handoff = parseHandoff(row.handoff);
      if (handoff?.kind !== "widget") return undefined;
      return { row, handoff };
    },

    /**
     * `round.verification_lifecycle` (daily): per active workspace with the module on —
     *   (a) re-check vendor rows nearing expiry, renewing in place when the vendor still says
     *       accredited until later (Parallel's income renewal sends no callback);
     *   (b) move verified rows past `expires_at` to `expired`;
     *   (c) remind each verification's investor once, `reminderDays` before expiry;
     *   (d) with `autoStart` and a vendor connection, open the renewal at reminder time.
     */
    async lifecycle(input: {
      readonly workspaceId?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    }): Promise<{ expired: number; reminded: number; renewed: number; started: number }> {
      const out = { expired: 0, reminded: 0, renewed: 0, started: 0 };
      const ids =
        input.workspaceId === undefined ? await listActiveWorkspaceIds(db) : [input.workspaceId];
      for (const workspaceId of ids) {
        if (input.signal?.aborted) break;
        try {
          const counted = await lifecycleOne(workspaceId, input.signal);
          out.expired += counted.expired;
          out.reminded += counted.reminded;
          out.renewed += counted.renewed;
          out.started += counted.started;
        } catch (error) {
          services.log("round.verification_lifecycle_failed", {
            level: "warn",
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return out;
    },
  };

  async function lifecycleOne(
    workspaceId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ expired: number; reminded: number; renewed: number; started: number }> {
    const sys = systemContext(workspaceId);
    const counted = { expired: 0, reminded: 0, renewed: 0, started: 0 };
    const now = services.now();
    const prep = await db.withTenant(sys, async (tx) => {
      const view = await services.enablement.get(db, sys, tx);
      if (!view.enabled.has("round")) return undefined;
      // A plain read: the sweep below must not hold the workspace row before its row locks.
      const settings = await readRoundSettings(tx, workspaceId);
      const until = new Date(now.getTime() + settings.reverification.reminderDays * 86_400_000);
      const candidates = await new VerificationRepo(sys, tx).recheckCandidates(
        now,
        until,
        new Date(now.getTime() - RECHECK_EVERY_MS),
        RECHECK_BATCH,
      );
      // An erased member is never re-checked (no vendor call, no new attestation).
      const recheck: VerificationRecord[] = [];
      for (const row of candidates) {
        if (!(await services.legal.isErased(tx, sys, row.membershipId))) recheck.push(row);
      }
      return { settings, until, recheck };
    });
    if (prep === undefined) return counted;

    // (a) Vendor re-checks, each outside any transaction.
    for (const row of prep.recheck) {
      if (signal?.aborted) return counted;
      if (!isVendorDriver(row.provider) || row.providerRef === null) continue;
      const driver = row.provider;
      let check: AccreditationVendorCheck;
      try {
        check = await services.accreditation.check(sys, {
          driver,
          providerRef: row.providerRef,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        services.log("round.verification_recheck_failed", {
          level: "warn",
          workspaceId,
          verificationId: row.id,
          code: codeOf(error).code,
        });
        continue;
      }
      // Renew only on a vendor expiry of its own: with none, `vendorExpiry` would default to 90
      // days from now on every run and renew forever.
      const exp =
        check.status === "accredited" && check.expiresAt !== undefined
          ? vendorExpiry({ expiresAt: check.expiresAt, decidedAt: check.decidedAt, now })
          : "expired";
      const renewed = await db.withTenant(sys, async (tx) => {
        const repo = new VerificationRepo(sys, tx);
        const locked = await repo.lock(row.id);
        if (locked === undefined || locked.status !== "verified") return false;
        // Erased while the vendor was asked: no new attestation for them.
        if (await services.legal.isErased(tx, sys, locked.membershipId)) return false;
        if (exp === "expired" || locked.expiresAt === null || exp.expiresAt <= locked.expiresAt) {
          await repo.noteRecheck(row.id, check.vendorStatus, now);
          return false;
        }
        const updated = await repo.renew(row.id, {
          expiresAt: exp.expiresAt,
          vendorStatus: check.vendorStatus,
          at: now,
          ...(check.decidedAt === undefined ? {} : { vendorDecidedAt: check.decidedAt }),
        });
        if (updated === undefined) return false;
        const ref = check.providerRef ?? locked.providerRef ?? "";
        await services.legal.recordVerifiedAccreditation(tx, sys, {
          membershipId: updated.membershipId,
          method: "third_party",
          evidenceRef:
            updated.evidenceKey !== null
              ? `storage:${updated.evidenceKey}`
              : vendorEvidenceNote(driver, ref),
          expiresAt: exp.expiresAt,
          actor: { provider: driver },
        });
        await audit(tx, sys, "round.verification_renewed", updated, {
          vendorStatus: check.vendorStatus.slice(0, 100),
          expiresAt: exp.expiresAt.toISOString(),
          previousExpiresAt: locked.expiresAt.toISOString(),
        });
        return true;
      });
      if (renewed) counted.renewed += 1;
    }
    if (signal?.aborted) return counted;

    /*
     * (b)–(d) One transaction. The expiry and reminder rows are locked (SKIP LOCKED) before its
     * first audit; the auto-start rows after the reminders are stamped (SKIP LOCKED never waits,
     * and the reminded rows are this transaction's own locks).
     */
    const { autoStart } = prep.settings.reverification;
    await db.withTenant(sys, async (tx) => {
      const repo = new VerificationRepo(sys, tx);
      const expired = await repo.lockExpired(now, LIFECYCLE_BATCH);
      const reminders = await repo.lockReminderDue(now, prep.until, LIFECYCLE_BATCH);
      for (const { row, superseded } of expired) {
        if (!(await repo.markExpired(row.id))) continue;
        /*
         * Nobody is told about an expiry that means nothing to them — a newer verification
         * already stands (or is under way) — or about backlog: a verification that ran out more
         * than a week ago (rows from before this job existed). Both are still audited.
         */
        const notify =
          !superseded &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() > now.getTime() - EXPIRED_NOTICE_MS;
        await audit(tx, sys, "round.verification_expired", row, {
          expiresAt: row.expiresAt?.toISOString() ?? null,
          superseded,
          notified: notify,
        });
        if (notify) {
          await publish(tx, sys, "round.verification_decided", {
            verificationId: row.id,
            membershipId: row.membershipId,
            status: "expired",
          });
        }
        counted.expired += 1;
      }
      for (const row of reminders) {
        if (!(await repo.stampReminder(row.id, now))) continue;
        await audit(tx, sys, "round.verification_reminder_sent", row, {
          expiresAt: row.expiresAt?.toISOString() ?? null,
        });
        await publish(tx, sys, "round.verification_expiring", {
          verificationId: row.id,
          membershipId: row.membershipId,
        });
        counted.reminded += 1;
      }
      if (!autoStart) return;
      const provider = await services.accreditation.effective(tx, sys);
      if (!isVendorDriver(provider.driver) || provider.connectionId === undefined) return;
      /*
       * Tracked by the rows themselves, not by the reminder: any reminded, un-superseded row with
       * no renewal (`reverification_of`) yet is a candidate on every run — so a member who was
       * busy on the last run, or a workspace that turned `autoStart` on after the reminder, still
       * gets the renewal opened.
       */
      /*
       * Auto-started renewals count against the workspace's hourly vendor budget too. This
       * transaction already holds the audit chain, so the workspace start lock (taken BEFORE the
       * chain by investor starts) is not taken here — the count is read without it and the run
       * stops at the budget; a concurrent investor start can overshoot it by a few rows.
       */
      let budget =
        WORKSPACE_START_RATE.max -
        (await repo.vendorOpenedSince(new Date(now.getTime() - WORKSPACE_START_RATE.windowMs)))
          .count;
      for (const row of await repo.lockAutoStartDue(now, prep.until, LIFECYCLE_BATCH)) {
        if (budget <= 0) {
          services.log("round.verification_autostart_budget", { level: "warn", workspaceId });
          break;
        }
        // Never waits: this transaction already holds the audit chain (see `tryLockMember`).
        if (!(await repo.tryLockMember(row.membershipId))) continue;
        if ((await repo.pendingForMember(row.membershipId)) !== undefined) continue;
        if (await services.legal.isErased(tx, sys, row.membershipId)) continue;
        if ((await repo.memberStatus(row.membershipId)) !== "active") continue;
        const subject =
          row.interestSubmissionId === null
            ? undefined
            : (await repo.submissionSubject(row.interestSubmissionId))?.subject;
        await openVerification(services, tx, sys, {
          membershipId: row.membershipId,
          reverificationOf: row.id,
          ...(subject === undefined ? {} : { subject }),
          actorKind: "system",
        });
        counted.started += 1;
        budget -= 1;
      }
    });
    return counted;
  }
}

export type VendorVerificationService = ReturnType<typeof createVendorVerificationService>;
