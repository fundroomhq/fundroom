import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SecurityKind, SnapshotSource, SnapshotStatus } from "../model.js";
import { holding, securityClass, snapshot } from "../schema/captable.js";

/*
 * Repositories over `captable.*` (design/06 §3: the only file in this module that touches drizzle
 * or SQL). Everything runs on the caller's transaction, so RLS decides what comes back: staff and
 * system see the workspace's rows; an external member sees only their own holding lines of the
 * published snapshot (and nothing of `snapshot` / `security_class`).
 *
 * Numeric columns stay strings here (`pg` returns them so); the services parse them with
 * `@fundroom/decimal` and never through a double.
 */

export interface SnapshotRow {
  readonly id: string;
  readonly asOf: string;
  readonly source: SnapshotSource;
  readonly status: SnapshotStatus;
  readonly note: string | null;
  readonly totals: unknown;
  readonly importedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface ClassRow {
  readonly id: string;
  readonly name: string;
  readonly kind: SecurityKind;
  readonly position: number;
}

export interface HoldingRow {
  readonly id: string;
  readonly snapshotId: string;
  readonly classId: string;
  readonly holderName: string;
  readonly holderEmail: string | null;
  readonly membershipId: string | null;
  readonly shares: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly issuedOn: string | null;
  readonly erasedAt: Date | null;
}

export interface NewHolding {
  readonly classIndex: number;
  readonly holderName: string;
  readonly holderEmail: string | null;
  readonly membershipId: string | null;
  readonly shares: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly issuedOn: string | null;
}

/** One DSAR line: a holding of the subject with the class and the snapshot it belongs to. */
export interface DsarHoldingRow extends HoldingRow {
  readonly className: string;
  readonly kind: SecurityKind;
  readonly asOf: string;
  readonly snapshotStatus: SnapshotStatus;
}

const SNAPSHOT_COLUMNS = {
  id: snapshot.id,
  asOf: snapshot.asOf,
  source: snapshot.source,
  status: snapshot.status,
  note: snapshot.note,
  totals: snapshot.totals,
  importedBy: snapshot.importedBy,
  createdAt: snapshot.createdAt,
  publishedAt: snapshot.publishedAt,
};

const HOLDING_COLUMNS = {
  id: holding.id,
  snapshotId: holding.snapshotId,
  classId: holding.classId,
  holderName: holding.holderName,
  holderEmail: holding.holderEmail,
  membershipId: holding.membershipId,
  shares: holding.shares,
  amount: holding.amount,
  currency: holding.currency,
  issuedOn: holding.issuedOn,
  erasedAt: holding.erasedAt,
};

/** Rows per INSERT statement: 11 parameters a row stays far below Postgres' 65535. */
const INSERT_CHUNK = 1000;

export class CaptableRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  private get ws() {
    return this.ctx.workspaceId;
  }

  /**
   * The per-workspace cap-table lock, taken first by every writer — import, publish, delete and
   * the erasure subscriber — so they serialise: two publishes cannot both see "no other
   * published snapshot", a delete cannot race a publish of the same draft, and an import cannot
   * link a line to a member whose erasure is running beside it. Lock order: this advisory lock →
   * snapshot rows → holding rows → workspace row (the audit chain).
   */
  async lockWorkspace(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`captable.snapshot:${this.ws}`}, 0))`,
    );
  }

  // --- snapshots ------------------------------------------------------------------------------

  async insertSnapshot(values: {
    asOf: string;
    source: SnapshotSource;
    note: string | null;
    totals: Record<string, unknown>;
    totalsSchemaVersion: number;
    importedBy: string | null;
  }): Promise<SnapshotRow> {
    const rows = await this.tx
      .insert(snapshot)
      .values({ workspaceId: this.ws, status: "draft", ...values })
      .returning(SNAPSHOT_COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error("snapshot insert returned no row");
    return row;
  }

  /** Inserts the classes in order; returns their ids in the same order. */
  async insertClasses(
    snapshotId: string,
    classes: readonly { name: string; kind: SecurityKind; position: number }[],
  ): Promise<string[]> {
    if (classes.length === 0) return [];
    const rows = await this.tx
      .insert(securityClass)
      .values(classes.map((c) => ({ ...c, snapshotId, workspaceId: this.ws })))
      .returning({ id: securityClass.id, position: securityClass.position });
    const byPosition = new Map(rows.map((r) => [r.position, r.id]));
    return classes.map((c) => {
      const id = byPosition.get(c.position);
      if (id === undefined) throw new Error("class insert lost a row");
      return id;
    });
  }

  async insertHoldings(
    snapshotId: string,
    classIds: readonly string[],
    lines: readonly NewHolding[],
  ): Promise<number> {
    let n = 0;
    for (let i = 0; i < lines.length; i += INSERT_CHUNK) {
      const chunk = lines.slice(i, i + INSERT_CHUNK);
      await this.tx.insert(holding).values(
        chunk.map((l) => {
          const classId = classIds[l.classIndex];
          if (classId === undefined) throw new Error("holding names an unknown class");
          return {
            snapshotId,
            workspaceId: this.ws,
            classId,
            holderName: l.holderName,
            holderEmail: l.holderEmail,
            membershipId: l.membershipId,
            shares: l.shares,
            amount: l.amount,
            currency: l.currency,
            issuedOn: l.issuedOn,
          };
        }),
      );
      n += chunk.length;
    }
    return n;
  }

  async list(limit: number): Promise<SnapshotRow[]> {
    return this.tx
      .select(SNAPSHOT_COLUMNS)
      .from(snapshot)
      .where(eq(snapshot.workspaceId, this.ws))
      .orderBy(desc(snapshot.createdAt), desc(snapshot.id))
      .limit(limit);
  }

  async byId(id: string): Promise<SnapshotRow | undefined> {
    const rows = await this.tx
      .select(SNAPSHOT_COLUMNS)
      .from(snapshot)
      .where(and(eq(snapshot.workspaceId, this.ws), eq(snapshot.id, id)));
    return rows[0];
  }

  async lockById(id: string): Promise<SnapshotRow | undefined> {
    const rows = await this.tx
      .select(SNAPSHOT_COLUMNS)
      .from(snapshot)
      .where(and(eq(snapshot.workspaceId, this.ws), eq(snapshot.id, id)))
      .for("update");
    return rows[0];
  }

  async published(): Promise<SnapshotRow | undefined> {
    const rows = await this.tx
      .select(SNAPSHOT_COLUMNS)
      .from(snapshot)
      .where(and(eq(snapshot.workspaceId, this.ws), eq(snapshot.status, "published")));
    return rows[0];
  }

  /** The published snapshot (if any) → `superseded`; returns its id. */
  async supersedePublished(): Promise<string | null> {
    const rows = await this.tx
      .update(snapshot)
      .set({ status: "superseded" })
      .where(and(eq(snapshot.workspaceId, this.ws), eq(snapshot.status, "published")))
      .returning({ id: snapshot.id });
    return rows[0]?.id ?? null;
  }

  async markPublished(id: string, at: Date): Promise<SnapshotRow> {
    const rows = await this.tx
      .update(snapshot)
      .set({ status: "published", publishedAt: at })
      .where(and(eq(snapshot.workspaceId, this.ws), eq(snapshot.id, id)))
      .returning(SNAPSHOT_COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error("publish updated no row");
    return row;
  }

  /** Deletes a draft (its classes and holdings cascade). */
  async deleteDraft(id: string): Promise<boolean> {
    const rows = await this.tx
      .delete(snapshot)
      .where(
        and(eq(snapshot.workspaceId, this.ws), eq(snapshot.id, id), eq(snapshot.status, "draft")),
      )
      .returning({ id: snapshot.id });
    return rows.length > 0;
  }

  // --- classes and holdings -----------------------------------------------------------------

  async classesOf(snapshotId: string): Promise<ClassRow[]> {
    return this.tx
      .select({
        id: securityClass.id,
        name: securityClass.name,
        kind: securityClass.kind,
        position: securityClass.position,
      })
      .from(securityClass)
      .where(and(eq(securityClass.workspaceId, this.ws), eq(securityClass.snapshotId, snapshotId)))
      .orderBy(asc(securityClass.position), asc(securityClass.id));
  }

  async holdingsOf(snapshotId: string): Promise<HoldingRow[]> {
    return this.tx
      .select(HOLDING_COLUMNS)
      .from(holding)
      .where(and(eq(holding.workspaceId, this.ws), eq(holding.snapshotId, snapshotId)))
      .orderBy(asc(holding.id));
  }

  /**
   * One member's lines of a snapshot. Deliberately no join to `security_class`: an external
   * caller has no policy there, and RLS on `holding` is what decides which lines come back.
   */
  async holdingsOfMember(snapshotId: string, membershipId: string): Promise<HoldingRow[]> {
    return this.tx
      .select(HOLDING_COLUMNS)
      .from(holding)
      .where(
        and(
          eq(holding.workspaceId, this.ws),
          eq(holding.snapshotId, snapshotId),
          eq(holding.membershipId, membershipId),
        ),
      )
      .orderBy(asc(holding.id));
  }

  // --- erasure and DSAR ---------------------------------------------------------------------

  private subjectCondition(membershipId: string, emails: readonly string[]) {
    const linked = eq(holding.membershipId, membershipId);
    if (emails.length === 0) return linked;
    // An unlinked line carrying any of the member's addresses is the same person's data (citext).
    return or(
      linked,
      and(
        isNull(holding.membershipId),
        sql`${holding.holderEmail} = ANY(${sql.param([...emails])}::citext[])`,
      ),
    );
  }

  /**
   * Every email identity of the member's user (primary or not), lower-cased: the addresses that
   * make an unlinked line "theirs" for erasure, DSAR and the investor view (R5). Read on the
   * caller's workspace transaction (`core.user_identity` admits a workspace member's rows).
   */
  async memberEmails(membershipId: string): Promise<string[]> {
    const rows = await this.tx
      .select({ email: core.userIdentity.identifier })
      .from(core.userIdentity)
      .innerJoin(core.membership, eq(core.membership.userId, core.userIdentity.userId))
      .where(
        and(
          eq(core.membership.workspaceId, this.ws),
          eq(core.membership.id, membershipId),
          eq(core.userIdentity.type, "email"),
        ),
      );
    return [...new Set(rows.map((r) => r.email.toLowerCase()))].sort();
  }

  /** The not-yet-erased lines about a member, locked (id order). */
  async lockSubjectHoldings(membershipId: string, emails: readonly string[]): Promise<string[]> {
    const rows = await this.tx
      .select({ id: holding.id })
      .from(holding)
      .where(
        and(
          eq(holding.workspaceId, this.ws),
          isNull(holding.erasedAt),
          this.subjectCondition(membershipId, emails),
        ),
      )
      .orderBy(asc(holding.id))
      .for("update");
    return rows.map((r) => r.id);
  }

  /** Name → pseudonym, address → NULL, member link → NULL; the numbers stay (a record). */
  async pseudonymise(ids: readonly string[], name: string, at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .update(holding)
      .set({ holderName: name, holderEmail: null, membershipId: null, erasedAt: at })
      .where(and(eq(holding.workspaceId, this.ws), inArray(holding.id, [...ids])))
      .returning({ id: holding.id });
    return rows.length;
  }

  async subjectHoldings(
    membershipId: string,
    emails: readonly string[],
    limit: number,
  ): Promise<DsarHoldingRow[]> {
    return this.tx
      .select({
        ...HOLDING_COLUMNS,
        className: securityClass.name,
        kind: securityClass.kind,
        asOf: snapshot.asOf,
        snapshotStatus: snapshot.status,
      })
      .from(holding)
      .innerJoin(securityClass, eq(securityClass.id, holding.classId))
      .innerJoin(snapshot, eq(snapshot.id, holding.snapshotId))
      .where(and(eq(holding.workspaceId, this.ws), this.subjectCondition(membershipId, emails)))
      .orderBy(desc(snapshot.asOf), asc(holding.id))
      .limit(limit);
  }

  // --- settings (core.module_enablement.config.settings) ------------------------------------

  async readConfig(): Promise<unknown> {
    const rows = await this.tx
      .select({ config: core.moduleEnablement.config })
      .from(core.moduleEnablement)
      .where(
        and(
          eq(core.moduleEnablement.workspaceId, this.ws),
          eq(core.moduleEnablement.module, "captable"),
        ),
      );
    return rows[0]?.config ?? {};
  }

  /**
   * Replaces only `config.settings`, atomically (`jsonb_set` in one UPDATE): neither the
   * enablement switch nor any other key of the row is read back and rewritten, so a concurrent
   * enable/disable cannot be undone by a settings save.
   */
  async writeSettings(settings: Record<string, unknown>): Promise<boolean> {
    const rows = await this.tx
      .update(core.moduleEnablement)
      .set({
        config: sql`jsonb_set(${core.moduleEnablement.config}, '{settings}', ${JSON.stringify(settings)}::jsonb, true)`,
      })
      .where(
        and(
          eq(core.moduleEnablement.workspaceId, this.ws),
          eq(core.moduleEnablement.module, "captable"),
        ),
      )
      .returning({ module: core.moduleEnablement.module });
    return rows.length > 0;
  }
}
