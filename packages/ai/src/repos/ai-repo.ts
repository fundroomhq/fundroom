import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, count, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";

const { aiRequest, aiUsageMonthly, membership, workspace } = core;

export type AiRequestRow = typeof aiRequest.$inferSelect;
type Feature = AiRequestRow["feature"];
type TerminalStatus = "done" | "failed" | "refused";

const LIVE = ["queued", "running"] as const;

/**
 * What occupies an in-flight slot (and a budget reservation): queued or running rows, and
 * CANCELLED rows whose job was already running and has not settled yet (`started_at` set,
 * `finished_at` null) — a cancel or delete does not stop a model call that is under way, so the
 * slot is freed only when the job settles (fix R1-H1).
 */
const inFlightSql = sql`(${aiRequest.status} IN ('queued', 'running') OR (${aiRequest.status} = 'cancelled' AND ${aiRequest.startedAt} IS NOT NULL AND ${aiRequest.finishedAt} IS NULL))`;

/** `error_code` of a running request its requester discarded: deleted once the job settles. */
export const DISCARDED = "discarded";
/**
 * `error_code` of a running request discarded by someone else's action (a document binned or
 * purged, a question erased — RR3-L9): readable by its requester as `cancelled` until the job
 * settles, then deleted like a discarded one.
 */
export const SOURCES_CHANGED = "sources_changed";
const SETTLE_DELETES = [DISCARDED, SOURCES_CHANGED];

/*
 * `core.ai_request` + `core.ai_usage_monthly` (0025). The only place `@fundroom/ai` touches
 * drizzle.
 *
 * Lock order (global E3.12 rule): `ai_request` rows are always locked AFTER the workspace row
 * when a transaction takes both. Start: advisory lock → (new row) → workspace row → chain →
 * outbox. Settings: workspace row → request rows (cancel) → chain. Erasure / purge: their entity
 * rows → workspace row → request rows. The job, the requester's delete and the sweeps lock
 * request rows only (then, in a separate transaction, the usage row) — never the workspace row
 * (a usage insert's foreign key takes only KEY SHARE, which does not conflict with the NO KEY
 * UPDATE every workspace-row writer takes). Sweeps claim rows FOR UPDATE SKIP LOCKED by id.
 */
export class AiRequestRepo extends TenantRepo<typeof aiRequest> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(aiRequest, ctx, tx);
  }

  /** Serialises starts per workspace (in-flight cap, budget, reuse). */
  async lockStart(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai.start:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async byId(id: string): Promise<AiRequestRow | undefined> {
    return this.findById(id);
  }

  /** The caller's own request by id (`requested_by` = membership), else undefined. */
  async ownedBy(id: string, membershipId: string): Promise<AiRequestRow | undefined> {
    const rows = await this.tx
      .select()
      .from(aiRequest)
      .where(this.scope(and(eq(aiRequest.id, id), eq(aiRequest.requestedBy, membershipId))))
      .limit(1);
    return rows[0];
  }

  /** The requester's queued/running request for (feature, subject) with EQUAL params (R3-L7). */
  async reusable(
    feature: Feature,
    subjectId: string | null,
    membershipId: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<AiRequestRow | undefined> {
    const rows = await this.tx
      .select()
      .from(aiRequest)
      .where(
        this.scope(
          and(
            eq(aiRequest.feature, feature),
            subjectId === null ? isNull(aiRequest.subjectId) : eq(aiRequest.subjectId, subjectId),
            eq(aiRequest.requestedBy, membershipId),
            inArray(aiRequest.status, [...LIVE]),
            sql`${aiRequest.params} = ${JSON.stringify(params)}::jsonb`,
          ),
        ),
      )
      .orderBy(aiRequest.createdAt)
      .limit(1);
    return rows[0];
  }

  async countInFlight(): Promise<number> {
    const rows = await this.tx
      .select({ n: count() })
      .from(aiRequest)
      .where(this.scope(inFlightSql));
    return Number(rows[0]?.n ?? 0);
  }

  async insert(values: {
    readonly feature: Feature;
    readonly subjectId: string | null;
    readonly requestedBy: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly provider: string;
    readonly model: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<AiRequestRow> {
    return this.insertOne({ ...values, status: "queued" });
  }

  /** queued → running; undefined when the row is gone or no longer queued. */
  async claim(id: string, at: Date): Promise<AiRequestRow | undefined> {
    const rows = await this.tx
      .update(aiRequest)
      .set({ status: "running", startedAt: at })
      .where(this.scope(and(eq(aiRequest.id, id), eq(aiRequest.status, "queued"))))
      .returning();
    return rows[0];
  }

  async isRunning(id: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: aiRequest.id })
      .from(aiRequest)
      .where(this.scope(and(eq(aiRequest.id, id), eq(aiRequest.status, "running"))))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The job settles its request. running → terminal; when the request was cancelled or discarded
   * meanwhile the result is DROPPED (a late writer never resurrects or overwrites it): the row only
   * gets `finished_at` (freeing its slot), and a discarded one is deleted. `written` = result kept.
   */
  /**
   * Locks the request for its job's settle: true while the job still owns it (running, or
   * cancelled while running and not settled). False once the sweep failed it `stale` (and charged
   * it) or it is gone — the job then charges nothing (RR3-L7).
   */
  async lockForSettle(id: string): Promise<boolean> {
    const rows = await this.tx
      .select({
        status: aiRequest.status,
        startedAt: aiRequest.startedAt,
        finishedAt: aiRequest.finishedAt,
      })
      .from(aiRequest)
      .where(this.scope(eq(aiRequest.id, id)))
      .for("update");
    const r = rows[0];
    return (
      r !== undefined &&
      (r.status === "running" ||
        (r.status === "cancelled" && r.startedAt !== null && r.finishedAt === null))
    );
  }

  async settle(
    id: string,
    outcome: {
      readonly status: TerminalStatus;
      readonly result: Readonly<Record<string, unknown>> | null;
      readonly errorCode: string | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
    },
    at: Date,
  ): Promise<"written" | "dropped"> {
    const rows = await this.tx
      .update(aiRequest)
      .set({
        status: outcome.status,
        result: outcome.result,
        resultSchemaVersion: outcome.result === null ? null : 1,
        errorCode: outcome.errorCode,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        finishedAt: at,
      })
      .where(this.scope(and(eq(aiRequest.id, id), eq(aiRequest.status, "running"))))
      .returning({ id: aiRequest.id });
    if (rows.length > 0) return "written";
    await this.settleCancelled([id], at);
    return "dropped";
  }

  /** Cancelled-while-running rows → `finished_at` set; discarded ones deleted. */
  private async settleCancelled(ids: readonly string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const settled = await this.tx
      .update(aiRequest)
      .set({ finishedAt: at })
      .where(
        this.scope(
          and(
            inArray(aiRequest.id, [...ids]),
            eq(aiRequest.status, "cancelled"),
            isNull(aiRequest.finishedAt),
          ),
        ),
      )
      .returning({ id: aiRequest.id, errorCode: aiRequest.errorCode });
    const discarded = settled
      .filter((r) => r.errorCode !== null && SETTLE_DELETES.includes(r.errorCode))
      .map((r) => r.id);
    if (discarded.length > 0) {
      await this.tx.delete(aiRequest).where(this.scope(inArray(aiRequest.id, discarded)));
    }
    return settled.length;
  }

  /**
   * In-flight requests of these features → cancelled (result null). A queued one is finished at
   * once (its job will not claim it); a running one keeps its slot until its job settles.
   */
  async cancelInFlight(features: readonly Feature[], at: Date): Promise<number> {
    if (features.length === 0) return 0;
    const rows = await this.tx
      .update(aiRequest)
      .set({
        status: "cancelled",
        result: null,
        resultSchemaVersion: null,
        finishedAt: sql`CASE WHEN ${aiRequest.status} = 'queued' THEN ${at.toISOString()}::timestamptz ELSE NULL END`,
      })
      .where(
        this.scope(
          and(inArray(aiRequest.feature, [...features]), inArray(aiRequest.status, [...LIVE])),
        ),
      )
      .returning({ id: aiRequest.id });
    return rows.length;
  }

  /**
   * Every discard path (the requester's delete, subject / citing / member deletes — fix RR1-M1).
   * Rows are locked first (by id; a concurrent claim is waited for), then re-read: a request whose
   * job already started and has not settled (running, or cancelled while running) is marked
   * cancelled + `discarded` with its params and result cleared at once — it keeps its in-flight
   * slot and budget reservation until the job settles, and the settle deletes it. Everything else
   * (queued and never claimed, or settled) is deleted now. Returns how many were affected.
   */
  async discardWhere(
    where: SQL,
    at: Date,
    code: typeof DISCARDED | typeof SOURCES_CHANGED = DISCARDED,
  ): Promise<number> {
    const locked = await this.tx
      .select({ id: aiRequest.id })
      .from(aiRequest)
      .where(this.scope(where))
      .orderBy(aiRequest.id)
      .for("update");
    if (locked.length === 0) return 0;
    const ids = locked.map((r) => r.id);
    // A fresh statement: sees what a claim that we waited for committed.
    const rows = await this.tx
      .select({
        id: aiRequest.id,
        status: aiRequest.status,
        startedAt: aiRequest.startedAt,
        finishedAt: aiRequest.finishedAt,
      })
      .from(aiRequest)
      .where(this.scope(inArray(aiRequest.id, ids)));
    const running = rows
      .filter(
        (r) =>
          r.status === "running" ||
          (r.status === "cancelled" && r.startedAt !== null && r.finishedAt === null),
      )
      .map((r) => r.id);
    const gone = rows.map((r) => r.id).filter((id) => !running.includes(id));
    if (running.length > 0) {
      await this.tx
        .update(aiRequest)
        .set({
          status: "cancelled",
          errorCode: code,
          result: null,
          resultSchemaVersion: null,
          params: {},
          updatedAt: at,
        })
        .where(this.scope(inArray(aiRequest.id, running)));
    }
    if (gone.length > 0) {
      await this.tx.delete(aiRequest).where(this.scope(inArray(aiRequest.id, gone)));
    }
    return rows.length;
  }

  /** The requester discards one request (see `discardWhere`). */
  async discard(id: string, at: Date): Promise<void> {
    await this.discardWhere(eq(aiRequest.id, id), at);
  }

  async deleteForSubject(feature: Feature, subjectId: string, at: Date): Promise<number> {
    return this.discardWhere(
      and(eq(aiRequest.feature, feature), eq(aiRequest.subjectId, subjectId)) as SQL,
      at,
      SOURCES_CHANGED,
    );
  }

  /**
   * A document is binned or purged: `qa_answer` requests whose stored result cites it, AND every
   * in-flight `qa_answer` request of the workspace — a running suggestion may be about to cite it
   * (RR1-M2; conservative: bin/purge is rare and at most four requests are in flight).
   */
  async deleteCiting(documentId: string, at: Date): Promise<number> {
    const probe = JSON.stringify([{ documentId }]);
    return this.discardWhere(
      sql`${aiRequest.feature} = 'qa_answer' AND (${aiRequest.result} -> 'citations' @> ${probe}::jsonb OR ${inFlightSql})`,
      at,
      SOURCES_CHANGED,
    );
  }

  /** Member erasure: the member's requests (running ones are emptied now, deleted at settle). */
  async deleteRequestedBy(membershipId: string, at: Date): Promise<number> {
    return this.discardWhere(eq(aiRequest.requestedBy, membershipId), at);
  }

  /** Ids matching `where`, row-locked, skipping rows another transaction holds (sweeps, R1-L6). */
  private async claimIds(where: SQL): Promise<string[]> {
    const rows = await this.tx
      .select({ id: aiRequest.id })
      .from(aiRequest)
      .where(this.scope(where))
      .orderBy(aiRequest.id)
      .for("update", { skipLocked: true });
    return rows.map((r) => r.id);
  }

  /** Expired rows that no longer hold an in-flight slot → deleted. */
  async deleteExpired(at: Date): Promise<number> {
    const ids = await this.claimIds(
      sql`${aiRequest.expiresAt} < ${at.toISOString()}::timestamptz AND NOT ${inFlightSql}`,
    );
    if (ids.length === 0) return 0;
    await this.tx.delete(aiRequest).where(this.scope(inArray(aiRequest.id, ids)));
    return ids.length;
  }

  /**
   * Stale (R1-L1): running rows by `started_at` (the job has outlived its expiry), queued rows by
   * `created_at` → failed `stale`; cancelled rows whose job never settled → settled.
   */
  async failStale(
    limits: { readonly runningBefore: Date; readonly queuedBefore: Date },
    at: Date,
  ): Promise<{ readonly stale: number; readonly crashed: number }> {
    const running = limits.runningBefore.toISOString();
    const queued = limits.queuedBefore.toISOString();
    const ids = await this.claimIds(
      sql`((${aiRequest.status} = 'running' AND ${aiRequest.startedAt} < ${running}::timestamptz) OR (${aiRequest.status} = 'queued' AND ${aiRequest.createdAt} < ${queued}::timestamptz))`,
    );
    let crashed = 0;
    if (ids.length > 0) {
      const failedRows = await this.tx
        .update(aiRequest)
        .set({ status: "failed", errorCode: "stale", finishedAt: at })
        .where(this.scope(inArray(aiRequest.id, ids)))
        .returning({ startedAt: aiRequest.startedAt });
      // Started and never settled: the process died mid-call (RR1-L4) — the caller charges them.
      crashed = failedRows.filter((r) => r.startedAt !== null).length;
    }
    const orphans = await this.claimIds(
      sql`${aiRequest.status} = 'cancelled' AND ${aiRequest.finishedAt} IS NULL AND ${aiRequest.startedAt} < ${running}::timestamptz`,
    );
    crashed += await this.settleCancelled(orphans, at);
    return { stale: ids.length + orphans.length, crashed };
  }
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
}

/** `month` is the first day of the UTC month, `YYYY-MM-01`. */
export async function readUsage(tx: Tx, ctx: TenantContext, month: string): Promise<AiUsage> {
  const rows = await tx
    .select({
      inputTokens: aiUsageMonthly.inputTokens,
      outputTokens: aiUsageMonthly.outputTokens,
      requests: aiUsageMonthly.requests,
    })
    .from(aiUsageMonthly)
    .where(and(eq(aiUsageMonthly.workspaceId, ctx.workspaceId), eq(aiUsageMonthly.month, month)))
    .limit(1);
  const r = rows[0];
  return {
    inputTokens: Number(r?.inputTokens ?? 0),
    outputTokens: Number(r?.outputTokens ?? 0),
    requests: Number(r?.requests ?? 0),
  };
}

export async function addUsage(
  tx: Tx,
  ctx: TenantContext,
  month: string,
  delta: AiUsage,
): Promise<void> {
  await tx
    .insert(aiUsageMonthly)
    .values({ workspaceId: ctx.workspaceId, month, ...delta })
    .onConflictDoUpdate({
      target: [aiUsageMonthly.workspaceId, aiUsageMonthly.month],
      set: {
        inputTokens: sql`${aiUsageMonthly.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${aiUsageMonthly.outputTokens} + excluded.output_tokens`,
        requests: sql`${aiUsageMonthly.requests} + excluded.requests`,
      },
    });
}

/** The raw `workspace.settings` jsonb as this transaction sees it (never the resolver cache). */
export async function readWorkspaceSettings(tx: Tx, workspaceId: string): Promise<unknown> {
  const rows = await tx
    .select({ settings: workspace.settings })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0]?.settings;
}

export interface MemberFacts {
  readonly id: string;
  readonly userId: string;
  readonly kind: "staff" | "external";
  readonly role: string;
  readonly status: string;
  readonly expiresAt: Date | null;
}

export async function memberFacts(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<MemberFacts | undefined> {
  const rows = await tx
    .select({
      id: membership.id,
      userId: membership.userId,
      kind: membership.kind,
      role: membership.role,
      status: membership.status,
      expiresAt: membership.expiresAt,
    })
    .from(membership)
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)))
    .limit(1);
  const r = rows[0];
  return r === undefined ? undefined : { ...r, kind: r.kind as MemberFacts["kind"] };
}
