import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";

const { esignEnvelope } = core;

export type ESignEnvelopeRow = typeof esignEnvelope.$inferSelect;
export type NewESignEnvelopeValues = Omit<typeof esignEnvelope.$inferInsert, "workspaceId">;
export type ESignEnvelopePatch = Partial<
  Pick<
    ESignEnvelopeRow,
    | "providerRef"
    | "status"
    | "signerStatus"
    | "errorCode"
    | "errorDetail"
    | "sentAt"
    | "completedAt"
    | "terminalAt"
    | "nextSyncAt"
    | "syncAttempts"
    | "artifacts"
    | "vaultedDocumentId"
    | "signerName"
    | "signerEmail"
    | "signerPseudonymisedAt"
  >
>;

const OPEN = ["sent", "delivered"] as const;

/*
 * `core.esign_envelope` (migration `core/0019_esign.sql`; the SQL is authoritative — the
 * terminal-status guard trigger in particular). Query builder only: the raw path returns
 * `timestamptz` as text. Row locks are always taken by id (or in id order for a set), which is the
 * first lock of every e-sign write path: envelope row → [module rows] → audit chain → outbox.
 */
export class ESignEnvelopeRepo extends TenantRepo<typeof esignEnvelope> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(esignEnvelope, ctx, tx);
  }

  async insert(values: NewESignEnvelopeValues): Promise<ESignEnvelopeRow> {
    return this.insertOne(values);
  }

  async byId(id: string): Promise<ESignEnvelopeRow | undefined> {
    return this.findById(id);
  }

  async lockById(id: string): Promise<ESignEnvelopeRow | undefined> {
    const rows = await this.tx
      .select()
      .from(esignEnvelope)
      .where(this.scope(eq(esignEnvelope.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async update(id: string, patch: ESignEnvelopePatch): Promise<ESignEnvelopeRow | undefined> {
    const rows = await this.tx
      .update(esignEnvelope)
      .set(patch)
      .where(this.scope(eq(esignEnvelope.id, id)))
      .returning();
    return rows[0];
  }

  /** Keyset page over (created_at desc, id desc). */
  async page(query: {
    readonly status?: ESignEnvelopeRow["status"] | undefined;
    readonly purpose?: ESignEnvelopeRow["purpose"] | undefined;
    readonly membershipId?: string | undefined;
    readonly before?: { readonly createdAt: Date; readonly id: string } | undefined;
    readonly limit: number;
  }): Promise<ESignEnvelopeRow[]> {
    const where: SQL[] = [];
    if (query.status !== undefined) where.push(eq(esignEnvelope.status, query.status));
    if (query.purpose !== undefined) where.push(eq(esignEnvelope.purpose, query.purpose));
    if (query.membershipId !== undefined)
      where.push(eq(esignEnvelope.membershipId, query.membershipId));
    if (query.before !== undefined) {
      const b = query.before;
      const cond = or(
        lt(esignEnvelope.createdAt, b.createdAt),
        and(eq(esignEnvelope.createdAt, b.createdAt), lt(esignEnvelope.id, b.id)),
      );
      if (cond !== undefined) where.push(cond);
    }
    return this.tx
      .select()
      .from(esignEnvelope)
      .where(this.scope(where.length === 0 ? undefined : and(...where)))
      .orderBy(desc(esignEnvelope.createdAt), desc(esignEnvelope.id))
      .limit(query.limit);
  }

  /** The envelope a verified callback names, within one connection. */
  async forCallback(
    connectionId: string,
    ref: { readonly providerRef?: string | undefined; readonly externalId?: string | undefined },
  ): Promise<ESignEnvelopeRow | undefined> {
    const byRef =
      ref.providerRef === undefined || ref.providerRef.length === 0 || ref.providerRef.length > 200
        ? undefined
        : eq(esignEnvelope.providerRef, ref.providerRef);
    const byExt =
      ref.externalId === undefined || !UUID_RE.test(ref.externalId)
        ? undefined
        : eq(esignEnvelope.id, ref.externalId);
    const match = byRef !== undefined && byExt !== undefined ? or(byRef, byExt) : (byRef ?? byExt);
    if (match === undefined) return undefined;
    const rows = await this.tx
      .select()
      .from(esignEnvelope)
      .where(this.scope(and(eq(esignEnvelope.connectionId, connectionId), match)))
      .limit(1);
    return rows[0];
  }

  /** An open (draft/sent/delivered) NDA envelope for this member, document and version. */
  async openNda(
    membershipId: string,
    documentId: string,
    versionNo: number,
  ): Promise<ESignEnvelopeRow | undefined> {
    const rows = await this.tx
      .select()
      .from(esignEnvelope)
      .where(
        this.scope(
          and(
            eq(esignEnvelope.purpose, "nda"),
            eq(esignEnvelope.membershipId, membershipId),
            eq(esignEnvelope.legalDocumentId, documentId),
            eq(esignEnvelope.legalVersionNo, versionNo),
            inArray(esignEnvelope.status, ["draft", ...OPEN]),
          ),
        ),
      )
      .orderBy(desc(esignEnvelope.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * NDA envelopes this member started since `since` (the per-member start budget, E3.5 fix A7):
   * how many, and the oldest one's creation time (when the budget frees up again).
   */
  async ndaStartsSince(
    membershipId: string,
    since: Date,
  ): Promise<{ readonly n: number; readonly oldest: Date | null }> {
    const rows = await this.tx
      .select({ createdAt: esignEnvelope.createdAt })
      .from(esignEnvelope)
      .where(
        this.scope(
          and(
            eq(esignEnvelope.purpose, "nda"),
            eq(esignEnvelope.requestedByMembershipId, membershipId),
            gte(esignEnvelope.createdAt, since),
          ),
        ),
      )
      .orderBy(asc(esignEnvelope.createdAt))
      .limit(100);
    return { n: rows.length, oldest: rows[0]?.createdAt ?? null };
  }

  /** Every NDA envelope of this member for this document, newest first (bounded). */
  async ndasFor(membershipId: string, documentId: string): Promise<ESignEnvelopeRow[]> {
    return this.tx
      .select()
      .from(esignEnvelope)
      .where(
        this.scope(
          and(
            eq(esignEnvelope.purpose, "nda"),
            eq(esignEnvelope.membershipId, membershipId),
            eq(esignEnvelope.legalDocumentId, documentId),
          ),
        ),
      )
      .orderBy(desc(esignEnvelope.createdAt), desc(esignEnvelope.id))
      .limit(50);
  }

  /**
   * The sweep's claim: rows that need a job now, locked with SKIP LOCKED (a row some other path
   * holds is simply left for the next turn), in `next_sync_at` order, bounded. What qualifies:
   *  - open (`sent`/`delivered`) rows due for a pull;
   *  - `error` rows that have a vendor envelope (a failed pull recovers on a later one);
   *  - `completed` rows whose artifacts are not collected yet and whose collection has not
   *    failed permanently (`error_code` null);
   *  - `draft` rows older than `staleBefore` (orphaned between the vendor call and tx2).
   */
  async claimDue(now: Date, staleBefore: Date, limit: number): Promise<ESignEnvelopeRow[]> {
    const due = and(isNotNull(esignEnvelope.nextSyncAt), lte(esignEnvelope.nextSyncAt, now));
    return this.tx
      .select()
      .from(esignEnvelope)
      .where(
        this.scope(
          or(
            and(inArray(esignEnvelope.status, [...OPEN]), due),
            and(eq(esignEnvelope.status, "error"), isNotNull(esignEnvelope.providerRef), due),
            and(
              eq(esignEnvelope.status, "completed"),
              isNull(esignEnvelope.artifacts),
              isNull(esignEnvelope.errorCode),
              due,
            ),
            and(eq(esignEnvelope.status, "draft"), lt(esignEnvelope.createdAt, staleBefore)),
          ),
        ),
      )
      .orderBy(asc(esignEnvelope.nextSyncAt), asc(esignEnvelope.id))
      .limit(limit)
      .for("update", { skipLocked: true });
  }

  /**
   * Identity erasure: row-locks (id order) every envelope that names the member — by membership
   * or, for a signer who was never linked to the membership, by the address — and has not been
   * pseudonymised yet. Called BEFORE the audit chain (see `lockESignEnvelopesOfMember`).
   */
  async lockOfSigner(membershipId: string, email: string | null): Promise<ESignEnvelopeRow[]> {
    const who =
      email === null || email === ""
        ? eq(esignEnvelope.membershipId, membershipId)
        : or(eq(esignEnvelope.membershipId, membershipId), eq(esignEnvelope.signerEmail, email));
    return this.tx
      .select()
      .from(esignEnvelope)
      .where(this.scope(and(who, isNull(esignEnvelope.signerPseudonymisedAt))))
      .orderBy(asc(esignEnvelope.id))
      .for("update");
  }

  /**
   * The member's envelopes for a DSAR export, oldest first — selected exactly like erasure's
   * `lockOfSigner` (by membership, or by the member's address; E3.5 fix A12), so an export shows
   * everything an erasure would pseudonymise.
   */
  async ofMember(membershipId: string, email: string | null = null): Promise<ESignEnvelopeRow[]> {
    const who =
      email === null || email === ""
        ? eq(esignEnvelope.membershipId, membershipId)
        : or(eq(esignEnvelope.membershipId, membershipId), eq(esignEnvelope.signerEmail, email));
    return this.tx
      .select()
      .from(esignEnvelope)
      .where(this.scope(who))
      .orderBy(asc(esignEnvelope.createdAt), asc(esignEnvelope.id));
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
