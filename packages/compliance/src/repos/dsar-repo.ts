import { lockAuditChain } from "@fundroom/audit";
import {
  core,
  type DsarKind,
  type DsarRequest,
  type DsarStatus,
  type DsarStep,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, desc, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { prelockErasureSubject } from "./identity-erasure-repo.js";

const { dsarRequest, dsarStep } = core;

/*
 * Tenant-context repositories over `core.dsar_request` / `core.dsar_step` (migration
 * `core/0011_dsar.sql`, E2.6 decision 5). Query builder only: the raw path returns `timestamptz`
 * as text, and every timestamp here is a statutory one.
 */

export interface DsarKey {
  readonly requestedAt: Date;
  readonly id: string;
}

export class DsarRequestRepo extends TenantRepo<typeof dsarRequest> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(dsarRequest, ctx, tx);
  }

  async byId(id: string): Promise<DsarRequest | undefined> {
    return this.findById(id);
  }

  /**
   * The row, locked for the rest of the transaction. Step reports take this lock so two modules
   * finishing at the same instant cannot both see "one still missing" and neither complete it.
   *
   * The workspace's audit-chain lock (`lockAuditChain`: the workspace row, then the chain — the
   * global order, E3.5 LX) is taken **before** the request row. Every holder of this row lock
   * goes on to audit (`dsar.erasure_step_completed`, `…_completed`, `…_cancelled`), and module
   * erasure handlers may audit before they report (analytics `analytics.anonymised`, crm
   * `crm.contact_erased`) — so without it one report held the request row and waited for the
   * chain while another held the chain and waited for the request row: a 40P01 between two
   * `member.erasure_requested` subscribers. One order for everyone: workspace row, chain, then
   * request row. Both are held to commit by the first audit insert anyway, so this serialises
   * nothing that was not already serialised.
   */
  async lockById(id: string): Promise<DsarRequest | undefined> {
    // E3.4 fix round 1 (D1), E3.5, R3B: an erasure holder may go on to run the identity step,
    // which writes rows (API keys, envelopes, owner and member rows, group rows, invites,
    // grants, access requests and challenges) that their own paths lock BEFORE the workspace row
    // and the chain — so they are locked here first (`prelockErasureSubject`, one fixed order).
    // `membership_id` never changes, so the unlocked read is enough.
    const peek = await this.findById(id);
    if (peek?.kind === "erasure") await prelockErasureSubject(this.ctx, this.tx, peek.membershipId);
    await lockAuditChain(this.tx, this.ctx.workspaceId);
    const rows = await this.tx
      .select()
      .from(dsarRequest)
      .where(this.scope(eq(dsarRequest.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * The member's open request of `kind`, if any (at most one per member and kind:
   * `dsar_request_open_idx`, widened to include `kind` by 0012).
   */
  async openFor(
    membershipId: string,
    kind: DsarKind = "erasure",
  ): Promise<DsarRequest | undefined> {
    const rows = await this.tx
      .select()
      .from(dsarRequest)
      .where(
        this.scope(
          and(
            eq(dsarRequest.membershipId, membershipId),
            eq(dsarRequest.kind, kind),
            eq(dsarRequest.status, "requested"),
          ),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Whether the member has an **erasure** request that is not cancelled (`requested` or
   * `completed`) — the `LegalServices.isErased` fact. An access or rectification request (E2.7)
   * says nothing about erasure and must not make a member read as erased. Readable only by
   * staff/system actors (RLS), like every row here.
   */
  async hasLiveFor(membershipId: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: dsarRequest.id })
      .from(dsarRequest)
      .where(
        this.scope(
          and(
            eq(dsarRequest.membershipId, membershipId),
            eq(dsarRequest.kind, "erasure"),
            inArray(dsarRequest.status, ["requested", "completed"]),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * `hasLiveFor` for a caller whose own actor cannot read `core.dsar_request` (an external
   * member's transaction, `LegalServices.isErased`): the transaction-local `app.actor_kind` is
   * switched to `system` for this one read and restored straight after, on the caller's
   * connection — never a second pool connection while the caller holds one. The workspace fence
   * (`app.workspace_id`) is untouched. `set_config` is not a write, so a read-only (view-as)
   * transaction may do this too.
   */
  async hasLiveForInOwnTx(membershipId: string): Promise<boolean> {
    const saved = await this.tx.execute(
      sql`SELECT current_setting('app.actor_kind', true) AS v, set_config('app.actor_kind', 'system', true)`,
    );
    const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
    // No `finally`: on an error the transaction is aborted and rolling back reverts the setting.
    const hit = await this.hasLiveFor(membershipId);
    await this.tx.execute(sql`SELECT set_config('app.actor_kind', ${previous}, true)`);
    return hit;
  }

  async create(values: {
    readonly kind?: DsarKind | undefined;
    readonly membershipId: string;
    readonly requestedBy: string | null;
    readonly requestedAt: Date;
    readonly dueAt: Date;
    readonly expectedModules: readonly string[];
    readonly note: string | null;
  }): Promise<DsarRequest> {
    return this.insertOne({
      kind: values.kind ?? "erasure",
      membershipId: values.membershipId,
      requestedBy: values.requestedBy,
      requestedAt: values.requestedAt,
      dueAt: values.dueAt,
      expectedModules: [...values.expectedModules],
      note: values.note,
    });
  }

  /** Newest first, keyset on `(requested_at, id)`; `limit + 1` rows so the caller knows if more exist. */
  async page(options: {
    readonly after?: DsarKey | undefined;
    readonly status?: DsarStatus | undefined;
    readonly kind?: DsarKind | undefined;
    readonly membershipId?: string | undefined;
    readonly limit: number;
  }): Promise<DsarRequest[]> {
    const where: SQL[] = [];
    if (options.kind !== undefined) where.push(eq(dsarRequest.kind, options.kind));
    if (options.status !== undefined) where.push(eq(dsarRequest.status, options.status));
    if (options.membershipId !== undefined)
      where.push(eq(dsarRequest.membershipId, options.membershipId));
    if (options.after !== undefined) {
      const { requestedAt, id } = options.after;
      const before = or(
        lt(dsarRequest.requestedAt, requestedAt),
        and(eq(dsarRequest.requestedAt, requestedAt), lt(dsarRequest.id, id)),
      );
      if (before !== undefined) where.push(before);
    }
    return this.tx
      .select()
      .from(dsarRequest)
      .where(this.scope(where.length === 0 ? undefined : and(...where)))
      .orderBy(desc(dsarRequest.requestedAt), desc(dsarRequest.id))
      .limit(options.limit + 1);
  }

  /**
   * The one transition to `completed`. `completionNote` and `exportSha256` (E2.7) may only be
   * written here — 0012's trigger refuses them on any other update.
   */
  async markCompleted(
    id: string,
    at: Date,
    facts: {
      readonly completionNote?: string | null | undefined;
      readonly exportSha256?: string | null | undefined;
    } = {},
  ): Promise<DsarRequest | undefined> {
    const rows = await this.tx
      .update(dsarRequest)
      .set({
        status: "completed",
        completedAt: at,
        ...(facts.completionNote == null ? {} : { completionNote: facts.completionNote }),
        ...(facts.exportSha256 == null ? {} : { exportSha256: facts.exportSha256 }),
      })
      .where(this.scope(and(eq(dsarRequest.id, id), eq(dsarRequest.status, "requested"))))
      .returning();
    return rows[0];
  }

  async markCancelled(id: string, at: Date, by: string | null): Promise<DsarRequest | undefined> {
    const rows = await this.tx
      .update(dsarRequest)
      .set({ status: "cancelled", cancelledAt: at, cancelledBy: by })
      .where(this.scope(and(eq(dsarRequest.id, id), eq(dsarRequest.status, "requested"))))
      .returning();
    return rows[0];
  }
}

export class DsarStepRepo extends TenantRepo<typeof dsarStep> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(dsarStep, ctx, tx);
  }

  /** Inserts the step unless one exists; `undefined` means it had already been reported. */
  async record(values: {
    readonly requestId: string;
    readonly module: string;
    readonly completedAt: Date;
    readonly counts: Readonly<Record<string, number>>;
  }): Promise<DsarStep | undefined> {
    const rows = await this.tx
      .insert(dsarStep)
      .values({
        requestId: values.requestId,
        workspaceId: this.ctx.workspaceId,
        module: values.module,
        completedAt: values.completedAt,
        counts: { ...values.counts },
      })
      .onConflictDoNothing({ target: [dsarStep.requestId, dsarStep.module] })
      .returning();
    return rows[0];
  }

  async forRequests(requestIds: readonly string[]): Promise<DsarStep[]> {
    if (requestIds.length === 0) return [];
    return this.tx
      .select()
      .from(dsarStep)
      .where(this.scope(inArray(dsarStep.requestId, [...requestIds])))
      .orderBy(dsarStep.completedAt, dsarStep.module);
  }
}
