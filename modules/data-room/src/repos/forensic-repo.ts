import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { documentVersion } from "../schema/dataroom.js";
import { type ForensicMark, forensicMark } from "../schema/forensic.js";

/*
 * `dataroom.forensic_mark` (E3.13, ADR-0061). Staff may read; only the system context writes
 * (RLS), so delivery issues marks in a short system-context transaction of its own for every
 * viewer kind.
 */
export interface ForensicRecipientRow {
  readonly mark: ForensicMark;
  readonly versionNo: number;
}

export class ForensicMarkRepo extends TenantRepo<typeof forensicMark> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(forensicMark, ctx, tx);
  }

  /**
   * The mark of (membership, version): inserted with `token`/`keyId` on first sight, otherwise
   * `last_served_at` moves to now (never backwards) and the stored token is returned unchanged.
   */
  async upsertServed(values: {
    membershipId: string;
    documentId: string;
    versionId: string;
    token: Uint8Array;
    keyId: string;
    /** Served while viewing as this investor (view-as): recorded on the row. */
    viewAsMembershipId?: string | undefined;
  }): Promise<ForensicMark> {
    const viewAs =
      values.viewAsMembershipId === undefined
        ? {}
        : { lastViewAsAt: sql`now()`, viewAsMembershipId: values.viewAsMembershipId };
    const rows = await this.tx
      .insert(forensicMark)
      .values({
        workspaceId: this.ctx.workspaceId,
        membershipId: values.membershipId,
        documentId: values.documentId,
        versionId: values.versionId,
        token: Buffer.from(values.token),
        keyId: values.keyId,
        ...(values.viewAsMembershipId === undefined
          ? {}
          : { lastViewAsAt: sql`now()`, viewAsMembershipId: values.viewAsMembershipId }),
      })
      .onConflictDoUpdate({
        target: [forensicMark.workspaceId, forensicMark.membershipId, forensicMark.versionId],
        set: { lastServedAt: sql`greatest(now(), ${forensicMark.lastServedAt})`, ...viewAs },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("forensic mark upsert returned nothing");
    return row;
  }

  /**
   * Re-keys a mark whose key has left the key ring: the pages served under the old key can no
   * longer be detected anyway, so the recipient gets a fresh token under the current key.
   */
  async rekey(id: string, token: Uint8Array, keyId: string): Promise<ForensicMark | undefined> {
    const rows = await this.tx
      .update(forensicMark)
      .set({ token: Buffer.from(token), keyId })
      .where(this.scope(eq(forensicMark.id, id)))
      .returning();
    return rows[0];
  }

  /** Every mark of one version (detection candidates), at most `limit`. */
  forVersion(versionId: string, limit: number): Promise<ForensicMark[]> {
    return this.tx
      .select()
      .from(forensicMark)
      .where(this.scope(eq(forensicMark.versionId, versionId)))
      .orderBy(asc(forensicMark.id))
      .limit(limit);
  }

  /** The recipients of a document (or one version), keyset-paged by mark id. */
  async recipients(filter: {
    documentId: string;
    versionId?: string | undefined;
    after?: string | undefined;
    limit: number;
  }): Promise<ForensicRecipientRow[]> {
    const conds = [eq(forensicMark.documentId, filter.documentId)];
    if (filter.versionId !== undefined) conds.push(eq(forensicMark.versionId, filter.versionId));
    if (filter.after !== undefined) conds.push(gt(forensicMark.id, filter.after));
    const rows = await this.tx
      .select({ mark: forensicMark, versionNo: documentVersion.versionNo })
      .from(forensicMark)
      .innerJoin(
        documentVersion,
        and(
          eq(documentVersion.id, forensicMark.versionId),
          eq(documentVersion.workspaceId, forensicMark.workspaceId),
        ),
      )
      .where(this.scope(and(...conds)))
      .orderBy(asc(forensicMark.id))
      .limit(filter.limit);
    return rows;
  }
}
