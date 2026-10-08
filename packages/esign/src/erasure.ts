import type { TenantContext, Tx } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import { isLiveAtVendor, pseudonymousSigner } from "./policy.js";
import { ESignConnectionRepo } from "./repos/connection-repo.js";
import { ESignEnvelopeRepo } from "./repos/envelope-repo.js";

/*
 * Identity erasure (E2.6/E3.5, contract §4 "Erasure"), called by `@fundroom/compliance`'s
 * kernel identity step exactly like the API-key hooks (E3.4).
 *
 * Signed records are retained under legal hold (≥ 6 years): nothing is deleted, the artifacts
 * stay, and the signer's name and address on every envelope that names the member are replaced
 * by a pseudonym keyed on the envelope row id (never on a hash of the old value). An envelope
 * that is still open at the vendor is scheduled for an immediate sweep (`next_sync_at = now`);
 * the sweep sees it due and enqueues `esign.sync`, which for a pseudonymised signer pulls the
 * vendor's status first and voids only what is still open there (a signed envelope is collected
 * and kept — E3.5 fix A1). `error` rows with a vendor ref count as live (A13).
 *
 * Lock order. The identity step runs under the audit chain, while every e-sign write path locks
 * the envelope row BEFORE the chain. So the rows are locked earlier — `lockESignEnvelopesOfMember`
 * from `prelockIdentityErasure` / `DsarRequestRepo.lockById`, before the chain — and the
 * pseudonymisation below re-locks rows this transaction already holds. The connection advisory
 * lock is taken first: envelope creation takes it before inserting, so while the erasure holds it
 * no new envelope can appear for the member (the API-key cap-lock lesson, E3.4 fix round 2).
 * Order: esign advisory lock → envelope rows (id order) → audit chain.
 */

export async function emailOf(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<string | null> {
  return (
    (await new MembershipRepo(ctx, tx).namesFor([membershipId])).get(membershipId)?.email ?? null
  );
}

/** Pre-lock (before the audit chain). Idempotent within a transaction. */
export async function lockESignEnvelopesOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<void> {
  await new ESignConnectionRepo(ctx, tx).lockSingleton();
  await new ESignEnvelopeRepo(ctx, tx).lockOfSigner(
    membershipId,
    await emailOf(tx, ctx, membershipId),
  );
}

/**
 * Pseudonymises the signer on every envelope naming the member (by membership, or by `email` —
 * read by the caller BEFORE the identity is scrubbed). Returns how many rows changed
 * (`esignEnvelopesPseudonymised`). Audit is the caller's (`compliance.identity_erased` counts).
 */
export async function pseudonymiseESignEnvelopesOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  email: string | null,
  at: Date,
): Promise<number> {
  // No advisory lock here: it and the rows were taken before the chain by the pre-lock, and
  // taking it now (under the chain) would invert the order envelope creation uses.
  const repo = new ESignEnvelopeRepo(ctx, tx);
  let n = 0;
  for (const row of await repo.lockOfSigner(membershipId, email)) {
    const p = pseudonymousSigner(row.id);
    await repo.update(row.id, {
      signerName: p.name,
      signerEmail: p.email,
      signerPseudonymisedAt: at,
      // Live at the vendor (open, or `error` with a vendor ref — A13): the next sweep pulls it and
      // voids what is still open.
      ...(isLiveAtVendor(row) ? { nextSyncAt: at } : {}),
    });
    n += 1;
  }
  return n;
}

/**
 * DSAR: the member's envelopes as plain metadata (no artifacts, no vendor ids) — every envelope
 * erasure would pseudonymise: by membership or by the member's address (E3.5 fix A12).
 */
export async function esignSubjectEnvelopes(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<Record<string, unknown>[]> {
  const iso = (d: Date | null) => (d === null ? null : d.toISOString());
  const email = await emailOf(tx, ctx, membershipId);
  return (await new ESignEnvelopeRepo(ctx, tx).ofMember(membershipId, email)).map((r) => ({
    id: r.id,
    purpose: r.purpose,
    title: r.title,
    driver: r.driver,
    status: r.status,
    signerStatus: r.signerStatus ?? null,
    signerName: r.signerName,
    signerEmail: r.signerEmail,
    legalDocumentId: r.legalDocumentId,
    legalVersionNo: r.legalVersionNo,
    createdAt: iso(r.createdAt),
    sentAt: iso(r.sentAt),
    completedAt: iso(r.completedAt),
    terminalAt: iso(r.terminalAt),
    signedCopy:
      r.artifacts === null
        ? null
        : { sha256: r.artifacts.signed.sha256, file: `esign/${r.id}-signed.pdf` },
    pseudonymisedAt: iso(r.signerPseudonymisedAt),
  }));
}
