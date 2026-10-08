import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRowsFor } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq, inArray } from "drizzle-orm";
import { commitment, interestSubmission, round, verification } from "../schema/round.js";

/**
 * Everything the round module holds about one member (E2.7 DSAR export; see `../dsar.ts`).
 * Erasure *retains* these rows as legal evidence (E2.6 decision 5) — which is exactly why the
 * member is entitled to see them.
 */
export async function readMemberRound(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  contactIds: readonly string[] = [],
): Promise<JsonObject> {
  const interests = await dsarRowsFor(
    tx,
    ctx,
    interestSubmission,
    interestSubmission.membershipId,
    membershipId,
    {
      omit: ["workspaceId", "membershipId"],
      orderBy: [asc(interestSubmission.createdAt), asc(interestSubmission.id)],
    },
  );
  const verifications = await dsarRowsFor(
    tx,
    ctx,
    verification,
    verification.membershipId,
    membershipId,
    {
      // The storage key names an encrypted object (not a fact) and its envelope descriptor names a
      // key; the file's digest, type, size and the decision are exported. E3.7: the vendor's
      // reference (the investor's own record at the vendor, also named in `evidenceNote`) and its
      // answers (status, error, when it was asked, who decided, the renewal chain, the reminder)
      // are exported; the handoff is not — it is the vendor SDK's configuration.
      omit: [
        "workspaceId",
        "membershipId",
        "evidenceKey",
        "evidenceEncryption",
        "evidenceEncryptionSchemaVersion",
        "handoff",
        "handoffSchemaVersion",
      ],
      orderBy: [asc(verification.createdAt), asc(verification.id)],
    },
  );
  const commitments = await dsarRowsFor(
    tx,
    ctx,
    commitment,
    commitment.membershipId,
    membershipId,
    {
      omit: ["workspaceId", "membershipId"],
      orderBy: [asc(commitment.createdAt), asc(commitment.id)],
    },
  );
  // Commitments recorded against the member's CRM contacts (ids from the CRM's own export) and
  // not already exported above through the membership.
  const own = new Set(commitments.rows.map((r) => r["id"]));
  const byContact: (typeof commitments.rows)[number][] = [];
  for (const contactId of contactIds) {
    const found = await dsarRowsFor(tx, ctx, commitment, commitment.contactId, contactId, {
      omit: ["workspaceId"],
      orderBy: [asc(commitment.createdAt), asc(commitment.id)],
    });
    for (const r of found.rows) {
      if (own.has(r["id"])) continue;
      own.add(r["id"]);
      byContact.push(r);
    }
  }
  const roundIds = [
    ...new Set(
      [...interests.rows, ...commitments.rows, ...byContact]
        .map((r) => r["roundId"])
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const rounds =
    roundIds.length === 0
      ? []
      : await tx
          .select({ id: round.id, name: round.name, currency: round.currency })
          .from(round)
          .where(and(eq(round.workspaceId, ctx.workspaceId), inArray(round.id, roundIds)))
          .orderBy(asc(round.id));
  return {
    version: 1,
    rounds: rounds.map((r) => ({ id: r.id, name: r.name, currency: r.currency })),
    interestSubmissions: interests.rows,
    verifications: verifications.rows,
    commitments: commitments.rows,
    contactCommitments: byContact,
  };
}
