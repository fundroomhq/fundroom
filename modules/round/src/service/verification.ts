import { createHash } from "node:crypto";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import { systemContext, type TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, RoundError } from "../errors.js";
import {
  EVIDENCE_KEY_PURPOSE,
  EVIDENCE_MAX_BYTES,
  evidenceKeyFor,
  evidenceRef,
  isEvidenceContentType,
  methodNeedsFile,
  type VerificationMethod,
  type VerificationStatus,
  verificationExpiry,
} from "../model.js";
import {
  type EvidenceEncryption,
  readRoundSettings,
  type VerificationRecord,
  VerificationRepo,
} from "../repos/round-repo.js";

/*
 * Accreditation verification (E2.5 D6, design/04 §1.6 and §183).
 *
 * Under Rule 506(c) an issuer may solicit publicly only if it takes reasonable steps to verify
 * that every purchaser is accredited; the investor's own word is not enough, which is exactly
 * where E2.3's self-certification stops. This service is the second step, and three rules in it
 * are compliance requirements rather than product choices:
 *
 *  1. **`verified` without evidence is refused.** The column CHECK requires a method, something
 *     read, and somebody who read it; this service is stricter — a document review and a
 *     professional letter need a *file*, because "I saw a bank statement" is a claim about
 *     evidence, not evidence.
 *  2. **The evidence is envelope-encrypted and scanned**, stored under a key nobody outside this
 *     module knows, and never named in an audit row or a log line.
 *  3. **It expires.** `round.evidence_purge` deletes the object `evidenceRetentionDays` after
 *     the decision. The decision, its method and the sha256 of what was read survive, which is
 *     what keeps the verification provable once the tax return is gone (design/04 §102).
 */

export interface VerificationRow extends VerificationRecord {
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface DecideVerificationInput {
  readonly status: "verified" | "rejected";
  readonly method?: VerificationMethod | undefined;
  readonly note?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

export interface EvidenceUpload {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface EvidenceRead {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

/**
 * The one pipeline every evidence object goes through — an investor's upload and a vendor's
 * certificate alike (E3.7): scan → sha256 → SHE1 seal under the workspace's `round-evidence` key
 * (a short transaction for the key only) → `storage.put` at `evidenceKeyFor`. Nothing here holds a
 * transaction across the scan or the upload. Refuses (`scan_failed`) what the scanner will not
 * pass, and never logs the bytes, the name or the signature.
 */
export async function storeEvidenceObject(
  services: ModuleServices,
  workspaceId: string,
  verificationId: string,
  bytes: Uint8Array,
): Promise<{
  readonly key: string;
  readonly sha256: string;
  readonly encryption: EvidenceEncryption;
  readonly scan: string;
}> {
  const scan = await services.scanner.scan({ body: bytes, size: bytes.byteLength });
  if (scan.verdict === "infected" || scan.verdict === "error") {
    // Never the file name and never the bytes: the reason is the verdict, and the signature
    // (which can name a customer's document) stays in the log.
    services.log("round.evidence_rejected", {
      level: "warn",
      workspaceId,
      verificationId,
      verdict: scan.verdict,
      engine: scan.engine,
    });
    throw new RoundError("scan_failed", "this file could not be accepted", {
      verdict: scan.verdict,
    });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = evidenceKeyFor(workspaceId, verificationId);
  const sys = systemContext(workspaceId);
  const { sealed, encryption } = await services.db.withTenant(sys, async (tx) => {
    const dek = await services.crypto.currentKey(tx, sys, EVIDENCE_KEY_PURPOSE);
    return {
      sealed: await encryptBytes(dek.key, bytes),
      // Which key sealed it: a rotation keeps the file readable, and a workspace export can
      // decrypt it with the source key and re-seal it under the target's (E2.8).
      encryption: { format: "she1" as const, keyId: dek.keyId, keyRef: dek.keyRef },
    };
  });
  await services.storage.put(key, sealed, {
    // The ciphertext's own type, not the plaintext's: nothing downstream may be tempted to
    // serve these bytes to a browser as a PDF.
    contentType: "application/octet-stream",
    contentLength: sealed.byteLength,
  });
  return { key, sha256, encryption, scan: scan.verdict };
}

export function createVerificationService(services: ModuleServices) {
  const { db } = services;

  return {
    async list(ctx: TenantContext, status?: VerificationStatus): Promise<VerificationRow[]> {
      return db.withTenant(ctx, async (tx) => {
        const rows = await new VerificationRepo(ctx, tx).list(status);
        const names = await new MembershipRepo(ctx, tx).namesFor(rows.map((r) => r.membershipId));
        return rows.map((r) => {
          const who = names.get(r.membershipId);
          return { ...r, displayName: who?.displayName ?? null, email: who?.email ?? null };
        });
      });
    },

    async get(ctx: TenantContext, id: string): Promise<VerificationRow> {
      return db.withTenant(ctx, async (tx) => {
        const found = await new VerificationRepo(ctx, tx).find(id);
        if (found === undefined) throw new RoundError("not_found", "no such verification");
        const who = (await new MembershipRepo(ctx, tx).namesFor([found.membershipId])).get(
          found.membershipId,
        );
        return { ...found, displayName: who?.displayName ?? null, email: who?.email ?? null };
      });
    },

    /**
     * The investor uploading their own evidence (raw route).
     *
     * Ownership is checked in the *caller's* context — RLS lets an external read only their own
     * verification rows, so a stranger's id is already a `not_found` there — and the write then
     * runs in a system context. An RLS UPDATE policy wide enough to let an investor write
     * `evidence_key` would be wide enough to let them write `status`, so the narrow policy stays
     * and the service carries the ownership check explicitly.
     */
    async uploadEvidence(
      ctx: TenantContext,
      id: string,
      membershipId: string,
      upload: EvidenceUpload,
      actor: Actor,
    ): Promise<VerificationRecord> {
      if (!isEvidenceContentType(upload.contentType)) {
        throw new RoundError("unsupported_media_type", "upload a PDF, a PNG or a JPEG", {
          contentType: upload.contentType,
        });
      }
      const ceiling = Math.min(EVIDENCE_MAX_BYTES, services.limits.uploadMaxBytes);
      if (upload.bytes.byteLength === 0) {
        throw new RoundError("validation_failed", "the upload is empty", {});
      }
      if (upload.bytes.byteLength > ceiling) {
        throw new RoundError("payload_too_large", "this file is too large", {
          limitBytes: ceiling,
        });
      }

      const owned = await db.withTenant(ctx, (tx) => new VerificationRepo(ctx, tx).find(id));
      if (owned === undefined || owned.membershipId !== membershipId) {
        throw new RoundError("not_found", "no such verification");
      }
      if (owned.status !== "pending") {
        throw new RoundError("conflict", "this verification has already been decided", {
          status: owned.status,
        });
      }
      // E3.7: a vendor verification is settled by the vendor, never by a file the investor sends
      // us (`requires.evidenceUpload` is false for it).
      if (owned.provider !== "manual") {
        throw new RoundError(
          "conflict",
          "this verification is handled by the accreditation service; continue with them",
          { provider: owned.provider },
        );
      }

      const stored = await storeEvidenceObject(services, ctx.workspaceId, id, upload.bytes);
      const { sha256, key, encryption, scan } = stored;
      const sys = systemContext(ctx.workspaceId);
      return db.withTenant(sys, async (tx) => {
        const updated = await new VerificationRepo(sys, tx).recordEvidence(id, {
          key,
          sha256,
          contentType: upload.contentType,
          bytes: upload.bytes.byteLength,
          uploadedAt: services.now(),
          encryption,
        });
        if (updated === undefined) {
          throw new RoundError("conflict", "this verification has already been decided", {});
        }
        await services.audit.record(tx, sys, {
          action: "round.evidence_uploaded",
          resourceKind: "round_verification",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          // The sha256 and the size, never the name and never the key.
          meta: {
            sha256,
            bytes: upload.bytes.byteLength,
            contentType: upload.contentType,
            scan,
          },
        });
        return updated;
      });
    },

    /** Staff reading the evidence. Decrypts, audits, and never caches. */
    async readEvidence(ctx: TenantContext, id: string, actor: Actor): Promise<EvidenceRead> {
      const row = await db.withTenant(ctx, (tx) => new VerificationRepo(ctx, tx).find(id));
      if (row === undefined) throw new RoundError("not_found", "no such verification");
      if (row.evidenceKey === null) {
        throw new RoundError("not_found", "this verification has no evidence on file", {
          purgedAt: row.evidencePurgedAt?.toISOString() ?? null,
        });
      }
      const object = await services.storage.get(row.evidenceKey);
      if (object === undefined) {
        // The row says there is a file and the bucket disagrees: a restore, a manual deletion,
        // a half-finished purge. An honest 404 beats a 500 on a compliance screen.
        services.log("round.evidence_missing", {
          level: "warn",
          workspaceId: ctx.workspaceId,
          verificationId: id,
        });
        throw new RoundError("not_found", "this verification has no evidence on file", {});
      }
      const ciphertext = new Uint8Array(await new Response(object.body).arrayBuffer());
      const sys = systemContext(ctx.workspaceId);
      const plaintext = await db.withTenant(sys, async (tx) => {
        // Objects sealed before 0002 carry no descriptor; the current key is the only one they
        // can have been sealed with (nothing rotates `round-evidence`).
        const keyId = row.evidenceEncryption?.keyId;
        const dek =
          keyId === undefined
            ? await services.crypto.currentKey(tx, sys, EVIDENCE_KEY_PURPOSE)
            : await services.crypto.keyById(tx, sys, keyId);
        if (dek === undefined) {
          throw new RoundError("not_found", "this verification has no evidence on file", {});
        }
        return decryptBytes(dek.key, ciphertext);
      });
      await db.withTenant(ctx, (tx) =>
        services.audit.record(tx, ctx, {
          action: "round.evidence_viewed",
          resourceKind: "round_verification",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: row.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { sha256: row.evidenceSha256, bytes: row.evidenceBytes },
        }),
      );
      return {
        bytes: plaintext,
        contentType: row.evidenceContentType ?? "application/octet-stream",
        sha256: row.evidenceSha256 ?? "",
      };
    },

    /**
     * The decision.
     *
     * `verified` writes the kernel's `accredited` attestation through
     * `legal.recordVerifiedAccreditation` — never by touching `core.attestation`, because that
     * row's expiry and revocation belong to the kernel and the policy gate reads it. The
     * evidence reference travelling with it is `storage:<key>` or `note:<sha256 of the note>`:
     * either names what was read without copying a private document into a kernel table.
     */
    async decide(
      ctx: TenantContext,
      id: string,
      input: DecideVerificationInput,
      actor: Actor,
    ): Promise<VerificationRecord> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new VerificationRepo(ctx, tx);
        const found = await repo.find(id);
        if (found === undefined) throw new RoundError("not_found", "no such verification");
        if (found.status !== "pending") {
          throw new RoundError("conflict", "this verification has already been decided", {
            status: found.status,
          });
        }
        /*
         * E3.7 fix round 2: an erased member gets no new accreditation (the late-writer rule —
         * an attestation written now would be a fresh fact about a person who asked to be
         * forgotten). Rejecting still works, so the queue can be cleared.
         */
        if (
          input.status === "verified" &&
          (await services.legal.isErased(tx, ctx, found.membershipId))
        ) {
          throw new RoundError(
            "member_erased",
            "this investor has been erased; their accreditation cannot be recorded",
            {},
          );
        }

        const decidedAt = services.now();
        let method: VerificationMethod | null = null;
        let expiresAt: Date | null = null;
        let ref: string | undefined;

        if (input.status === "verified") {
          if (input.method === undefined) {
            throw new RoundError(
              "validation_failed",
              "say how you verified this investor's accredited status",
              { field: "method" },
            );
          }
          method = input.method;
          const note = (input.note ?? found.evidenceNote ?? "").trim();
          if (methodNeedsFile(method)) {
            if (found.evidenceKey === null) {
              throw new RoundError(
                "evidence_required",
                method === "professional_letter"
                  ? "attach the letter before recording this as verified"
                  : "attach the document you reviewed before recording this as verified",
                { field: "method", method },
              );
            }
            ref = evidenceRef({ key: found.evidenceKey });
          } else {
            if (found.evidenceKey === null && note.length === 0) {
              throw new RoundError(
                "evidence_required",
                "record what you relied on before marking this verified",
                { field: "note", method },
              );
            }
            ref =
              found.evidenceKey !== null
                ? evidenceRef({ key: found.evidenceKey })
                : evidenceRef({ noteSha256: createHash("sha256").update(note).digest("hex") });
          }
          expiresAt = input.expiresAt ?? verificationExpiry(method, decidedAt);
        }

        // A note is only *evidence* on the two methods where the record is the words; on a
        // document review it is a comment beside the file and belongs in `decision_note`.
        const noteIsEvidence =
          input.status === "verified" && method !== null && !methodNeedsFile(method);
        const updated = await repo.decide(id, {
          status: input.status,
          method,
          decidedBy: actor.membershipId,
          decidedAt,
          decisionNote: input.note ?? null,
          ...(noteIsEvidence ? { evidenceNote: input.note ?? null } : {}),
          expiresAt,
        });
        if (updated === undefined) {
          throw new RoundError("conflict", "this verification has already been decided", {});
        }

        if (input.status === "verified" && method !== null && expiresAt !== null) {
          await services.legal.recordVerifiedAccreditation(tx, ctx, {
            membershipId: updated.membershipId,
            method,
            evidenceRef: ref ?? "",
            expiresAt,
            actor: {
              membershipId: actor.membershipId,
              ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
              ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
            },
          });
        }

        await services.audit.record(tx, ctx, {
          action: "round.verification_decided",
          resourceKind: "round_verification",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: updated.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            status: updated.status,
            method,
            expiresAt: expiresAt?.toISOString() ?? null,
            hasFile: updated.evidenceKey !== null,
            submissionId: updated.interestSubmissionId,
          },
        });
        await publish(tx, ctx, "round.verification_decided", {
          verificationId: id,
          membershipId: updated.membershipId,
          status: updated.status,
        });
        return updated;
      });
    },

    /**
     * One workspace's share of the nightly purge.
     *
     * The clock is `decided_at`, not `evidence_uploaded_at`: design/04 §102 says the evidence
     * expires *after the decision*, and a file uploaded in January against a decision taken in
     * June has to be readable while the decision is being made.
     */
    async purge(workspaceId: string): Promise<number> {
      const ctx = systemContext(workspaceId);
      const settings = await db.withTenant(ctx, (tx) => readRoundSettings(tx, workspaceId));
      const before = new Date(
        services.now().getTime() - settings.evidenceRetentionDays * 86_400_000,
      );
      const due = await db.withTenant(ctx, (tx) => new VerificationRepo(ctx, tx).duePurge(before));
      let purged = 0;
      for (const row of due) {
        if (row.evidenceKey === null) continue;
        try {
          await services.storage.delete(row.evidenceKey);
        } catch (error) {
          // One unreachable object must not stop the sweep; the row keeps its key and the next
          // run tries again.
          services.log("round.evidence_purge_failed", {
            level: "warn",
            workspaceId,
            verificationId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        await db.withTenant(ctx, async (tx) => {
          await new VerificationRepo(ctx, tx).markPurged(row.id, services.now());
          await services.audit.record(tx, ctx, {
            action: "round.evidence_purged",
            resourceKind: "round_verification",
            resourceId: row.id,
            actorKind: "system",
            subjectMembershipId: row.membershipId,
            meta: {
              sha256: row.evidenceSha256,
              retentionDays: settings.evidenceRetentionDays,
              decidedAt: row.decidedAt?.toISOString() ?? null,
            },
          });
        });
        purged += 1;
      }
      return purged;
    },
  };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
