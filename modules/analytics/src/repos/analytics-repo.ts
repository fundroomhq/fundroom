import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import {
  type AnalyticsSettings,
  parseWorkspaceSettings,
  type WorkspaceSettings,
} from "@fundroom/domain";
import { sql } from "drizzle-orm";
import {
  type EventType,
  event,
  hotLeadAlert,
  pageOpen,
  pageRollup,
  type ResourceKind,
  type UaFamily,
  viewerResourceRollup,
  viewSession,
} from "../schema/analytics.js";

/*
 * Repositories over `analytics.*` (design/06 §3: the only place drizzle/SQL is touched in this
 * module). Everything runs inside the caller's tenant transaction; RLS admits staff and
 * system actors only, so routes serving investors (heartbeat, close) run as `system`.
 * Timestamps that feed keyset cursors travel as microsecond ISO text (`ISO_US`) so a
 * JavaScript `Date` (millisecond precision) never re-reads or skips a row.
 */
const ISO_US = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);
const isoUs = (col: ReturnType<typeof sql.raw>) =>
  sql`to_char(${col} AT TIME ZONE 'UTC', ${ISO_US})`;

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;

/*
 * `tx.execute()` bypasses drizzle's column mapping, and its raw query config hands
 * timestamptz/timestamp/date back as Postgres text ("2026-09-12 10:15:30.123456+00").
 * Every row this file returns with a `Date` in its type therefore goes through here, so
 * nothing downstream (`toISOString()`, day bucketing, min/max) sees a string.
 */
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/** The workspace's settings, read inside the tenant transaction (event handlers have no `Database`). */
export async function readWorkspaceSettingsIn(
  tx: Tx,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const rows = rowsOf<{ settings: unknown }>(
    await tx.execute(sql`SELECT settings FROM core.workspace WHERE id = ${workspaceId}::uuid`),
  );
  return parseWorkspaceSettings(rows[0]?.settings);
}

/** The workspace's analytics settings, read inside the tenant transaction. */
export async function readAnalyticsSettings(
  tx: Tx,
  workspaceId: string,
): Promise<AnalyticsSettings> {
  return (await readWorkspaceSettingsIn(tx, workspaceId)).analytics;
}

/**
 * The per-workspace analytics write lock (E2.6): a transaction-scoped advisory lock that the
 * DSAR erasure, the rollup walk and both page_open flushes take first. The rollup reads a batch
 * of events and then upserts per-member rollups; an erasure committing between the two would be
 * undone by the upsert. Serialised on this lock, whichever runs second sees the other's result
 * (READ COMMITTED: every statement after the lock takes a fresh snapshot). A key rather than a
 * row lock, because the rollup cursor row does not exist before a workspace's first pass.
 */
export async function lockWorkspaceAnalytics(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`analytics.rollup:${workspaceId}`}::text, 0))`,
  );
}

/** The SQL twin of `isUnscoredLink`, for reads over rows stored before the ingest filter. */
const UNSCORED_LINK_SQL = sql.raw(
  `(type = 'email_clicked' AND lower(coalesce(props->>'link', '')) ~ '^([a-z][a-z0-9+.-]*://[^/]*)?/+(unsubscribe(/|$)|api(/|$))')`,
);

// --- view sessions ------------------------------------------------------------------------------
export interface SessionFacts {
  readonly membershipId: string;
  readonly sessionKey: Uint8Array;
  readonly ipHash?: Uint8Array | null | undefined;
  readonly uaFamily?: UaFamily | null | undefined;
  readonly embed?: boolean | undefined;
}

export class ViewSessionRepo extends TenantRepo<typeof viewSession> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(viewSession, ctx, tx);
  }

  /** Creates or touches the session row; returns its id. */
  async upsert(facts: SessionFacts): Promise<string> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        INSERT INTO analytics.view_session (workspace_id, membership_id, session_key, ip_hash, ua_family, embed)
        VALUES (${this.ctx.workspaceId}::uuid, ${facts.membershipId}::uuid, ${Buffer.from(facts.sessionKey)}::bytea,
                ${facts.ipHash ? Buffer.from(facts.ipHash) : null}::bytea, ${facts.uaFamily ?? null}::text, ${facts.embed ?? false}::boolean)
        ON CONFLICT (workspace_id, session_key) DO UPDATE SET
          last_seen_at = now(),
          ip_hash = COALESCE(EXCLUDED.ip_hash, view_session.ip_hash),
          ua_family = COALESCE(EXCLUDED.ua_family, view_session.ua_family),
          embed = view_session.embed OR EXCLUDED.embed
        RETURNING id`),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("analytics.view_session upsert returned no row");
    return id;
  }

  async findIdByKey(sessionKey: Uint8Array): Promise<string | undefined> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        SELECT id FROM analytics.view_session
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND session_key = ${Buffer.from(sessionKey)}::bytea`),
    );
    return rows[0]?.id;
  }

  async deleteForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.view_session
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  /** Retention: sessions (and their salted IP hashes) last seen before the retention cutoff. */
  async deleteExpired(retentionMonths: number, now: Date): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.view_session
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND last_seen_at < ${retentionCutoff(retentionMonths, now)}`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}

/**
 * The per-workspace retention cutoff, the row-level twin of `analytics.expired_partitions`: a
 * month's partition is dropped once its upper bound is older than `retention_months` before the
 * start of the current month, i.e. exactly the rows older than `retention + 1` months before it.
 * Deleting on the same boundary keeps a workspace's own trim and the shared partition drop from
 * disagreeing about which month a row belongs to.
 */
function retentionCutoff(retentionMonths: number, now: Date) {
  return sql`(date_trunc('month', ${now}::timestamptz) - make_interval(months => ${retentionMonths + 1}::int))`;
}

// --- events -------------------------------------------------------------------------------------
export interface NewEvent {
  readonly viewSessionId: string | null;
  readonly membershipId: string;
  readonly type: EventType;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly versionId: string | null;
  readonly props?: Record<string, unknown> | undefined;
  /** Outbox row id of the source event; a redelivery with the same id never writes twice. */
  readonly outboxId?: number | undefined;
  /** When the fact happened (the outbox row's `created_at`); `now()` only when unknown. */
  readonly occurredAt?: Date | undefined;
}

export interface EventRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly type: EventType;
  readonly membershipId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly versionId: string | null;
  readonly pageNo: number | null;
  readonly durationMs: number | null;
}

export interface TimelineRow extends EventRow {
  /** Microsecond ISO text: the keyset cursor. */
  readonly occurredAtText: string;
  readonly props: Record<string, unknown>;
}

export interface CursorRow extends EventRow {
  readonly occurredAtText: string;
}

const EVENT_COLUMNS = sql.raw(
  `id, occurred_at AS "occurredAt", type, membership_id AS "membershipId", resource_kind AS "resourceKind",
   resource_id AS "resourceId", version_id AS "versionId", page_no AS "pageNo", duration_ms AS "durationMs"`,
);

export class EventRepo extends TenantRepo<typeof event> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(event, ctx, tx);
  }

  /**
   * Inserts unless the same (session, type, resource, version) was recorded within a minute of
   * the same instant, or the same outbox row was already ingested (job retries). Returns
   * whether a row was written. The event is stamped with the *source* fact's time, so a late
   * or retried delivery lands where it belongs on the timeline rather than at `now()`.
   */
  async insertDeduped(e: NewEvent): Promise<boolean> {
    const ws = this.ctx.workspaceId;
    const props = JSON.stringify({
      ...(e.props ?? {}),
      ...(e.outboxId === undefined ? {} : { outboxId: e.outboxId }),
    });
    const outboxId = e.outboxId === undefined ? null : String(e.outboxId);
    const at = sql`coalesce(${e.occurredAt ?? null}::timestamptz, now())`;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        INSERT INTO analytics.event (workspace_id, occurred_at, view_session_id, membership_id, type, resource_kind, resource_id, version_id, props)
        SELECT ${ws}::uuid, ${at}, ${e.viewSessionId}::uuid, ${e.membershipId}::uuid, ${e.type}::text, ${e.resourceKind}::text,
               ${e.resourceId}::uuid, ${e.versionId}::uuid, ${props}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM analytics.event x
          WHERE x.workspace_id = ${ws}::uuid AND x.resource_id = ${e.resourceId}::uuid AND x.type = ${e.type}::text
            AND x.view_session_id IS NOT DISTINCT FROM ${e.viewSessionId}::uuid
            AND x.version_id IS NOT DISTINCT FROM ${e.versionId}::uuid
            AND (x.occurred_at BETWEEN ${at} - interval '60 seconds' AND ${at} + interval '60 seconds'
                 OR (${outboxId}::text IS NOT NULL AND x.props->>'outboxId' = ${outboxId}::text))
        )
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * Has this view session already been recorded as opening the resource? The heartbeat is the
   * one thing a member sends about themselves, so it is only honoured behind a fact the server
   * produced: the data-room route that emitted `document.viewed` did the authorisation, and a
   * beat for a resource with no such open is a claim with nothing behind it.
   */
  async hasOpen(viewSessionId: string, resourceKind: string, resourceId: string): Promise<boolean> {
    const rows = rowsOf<{ one: number }>(
      await this.tx.execute(sql`
        SELECT 1 AS one FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND view_session_id = ${viewSessionId}::uuid
          AND resource_kind = ${resourceKind}::text
          AND resource_id = ${resourceId}::uuid
          AND type IN ('document_viewed', 'update_viewed')
        LIMIT 1`),
    );
    return rows.length > 0;
  }

  async recent(limit: number): Promise<EventRow[]> {
    const rows = rowsOf<EventRow>(
      await this.tx.execute(sql`
        SELECT ${EVENT_COLUMNS} FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`),
    );
    return rows.map((r) => ({ ...r, occurredAt: asDate(r.occurredAt) }));
  }

  /** design/06 §6 drill-down: dwell per page for one viewer of one resource. */
  async pagesFor(
    resourceId: string,
    membershipId: string,
  ): Promise<{ pageNo: number; durationMs: number; views: number }[]> {
    return rowsOf<{ pageNo: number; durationMs: number; views: number }>(
      await this.tx.execute(sql`
        SELECT page_no AS "pageNo", sum(duration_ms)::int AS "durationMs", count(*)::int AS views
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_id = ${resourceId}::uuid
          AND membership_id = ${membershipId}::uuid AND type = 'page_viewed' AND page_no IS NOT NULL
        GROUP BY page_no ORDER BY page_no`),
    );
  }

  /**
   * Keyset page of one member's events, newest first, strictly after the `(before, beforeId)`
   * cursor in `(occurred_at DESC, id DESC)` order. The id is part of the cursor because it is
   * part of the sort: one close beacon flushes several pages at the same microsecond, and a
   * timestamp-only cursor would step over the rest of such a tie and silently lose events.
   */
  async timeline(
    membershipId: string,
    before: string | null,
    beforeId: string | null,
    limit: number,
  ): Promise<TimelineRow[]> {
    const rows = rowsOf<TimelineRow>(
      await this.tx.execute(sql`
        SELECT ${EVENT_COLUMNS}, props, ${isoUs(sql.raw("occurred_at"))} AS "occurredAtText"
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid
          AND (
            ${before}::timestamptz IS NULL
            OR occurred_at < ${before}::timestamptz
            OR (${beforeId}::uuid IS NOT NULL
                AND occurred_at = ${before}::timestamptz AND id < ${beforeId}::uuid)
          )
        ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`),
    );
    return rows.map((r) => ({ ...r, occurredAt: asDate(r.occurredAt) }));
  }

  /** Distinct members who opened something since `from` (views only, not dwell rows). */
  async uniqueViewersSince(from: Date): Promise<number> {
    const rows = rowsOf<{ n: number }>(
      await this.tx.execute(sql`
        SELECT count(DISTINCT membership_id)::int AS n FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND occurred_at >= ${from}::timestamptz
          AND type IN ('document_viewed', 'update_viewed')`),
    );
    return rows[0]?.n ?? 0;
  }

  async uniqueViewersByResource(
    resourceIds: readonly string[],
    from: Date,
  ): Promise<Map<string, number>> {
    if (resourceIds.length === 0) return new Map();
    const rows = rowsOf<{ resourceId: string; n: number }>(
      await this.tx.execute(sql`
        SELECT resource_id AS "resourceId", count(DISTINCT membership_id)::int AS n FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_id = ANY(${sql.param([...resourceIds])}::uuid[])
          AND occurred_at >= ${from}::timestamptz AND type IN ('document_viewed', 'update_viewed')
        GROUP BY resource_id`),
    );
    return new Map(rows.map((r) => [r.resourceId, r.n]));
  }

  /** Distinct viewers of a resource on a UTC day (recomputed by the rollup job). */
  async uniqueViewersOn(day: string, resourceId: string): Promise<number> {
    const rows = rowsOf<{ n: number }>(
      await this.tx.execute(sql`
        SELECT count(DISTINCT membership_id)::int AS n FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_id = ${resourceId}::uuid
          AND type IN ('document_viewed', 'update_viewed')
          AND occurred_at >= (${day}::date::timestamp AT TIME ZONE 'UTC')
          AND occurred_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'UTC')`),
    );
    return rows[0]?.n ?? 0;
  }

  /** Events after the rollup cursor, settled (older than `settleSeconds`), in `(occurred_at, id)` order. */
  async afterCursor(
    cursor: { occurredAt: string; eventId: string },
    settleSeconds: number,
    limit: number,
  ): Promise<CursorRow[]> {
    const rows = rowsOf<CursorRow>(
      await this.tx.execute(sql`
        SELECT ${EVENT_COLUMNS}, ${isoUs(sql.raw("occurred_at"))} AS "occurredAtText"
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND occurred_at < now() - make_interval(secs => ${settleSeconds})
          AND (occurred_at, id) > (${cursor.occurredAt}::timestamptz, ${cursor.eventId}::uuid)
        ORDER BY occurred_at, id LIMIT ${limit}`),
    );
    return rows.map((r) => ({ ...r, occurredAt: asDate(r.occurredAt) }));
  }

  async deleteForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.event
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  /**
   * An email open or click (E2.6). Idempotent on (message, type, the provider's own timestamp,
   * kept verbatim in `props.providerAt`): the kernel may publish the same webhook twice (the ESP
   * retries, the relay redelivers), and the advisory lock on the message ref serialises two
   * deliveries of one message racing each other. The dedupe key never involves the stored time:
   * that is the provider's time clamped to `receivedAt` (when the kernel recorded the webhook — a
   * skewed ESP clock must not write the future), a function of the fact alone, so a redelivered
   * future-dated event can never look new. A fact whose month has no partition — older than the
   * oldest partition, or absurdly far ahead — is skipped rather than failing the job forever.
   */
  async insertEmail(e: NewEmailEvent): Promise<boolean> {
    const ws = this.ctx.workspaceId;
    const providerAt = e.occurredAt.toISOString();
    const props = JSON.stringify({
      messageRef: e.messageRef,
      automated: e.automated,
      providerAt,
      ...(e.link === null ? {} : { link: e.link }),
    });
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`analytics.email:${e.messageRef}`}::text, 0))`,
    );
    const at = sql`least(${e.occurredAt}::timestamptz, ${e.receivedAt}::timestamptz)`;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        INSERT INTO analytics.event (workspace_id, occurred_at, view_session_id, membership_id, type, resource_kind, resource_id, version_id, props)
        SELECT ${ws}::uuid, ${at}, NULL, ${e.membershipId}::uuid, ${e.type}::text, 'post',
               ${e.resourceId}::uuid, NULL, ${props}::jsonb
        WHERE to_regclass('analytics.event_' || to_char(${at}, 'YYYYMM')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analytics.event x
            WHERE x.workspace_id = ${ws}::uuid AND x.resource_id = ${e.resourceId}::uuid
              AND x.type = ${e.type}::text
              AND x.props->>'messageRef' = ${e.messageRef}::text
              AND x.props->>'providerAt' = ${providerAt}::text
          )
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * The hot list's input: one signal per (member, type, UTC day, automated) since `from`, with
   * the latest instant in the bucket (decay is measured in days; "last activity" wants the
   * instant).
   */
  async signalsSince(from: Date): Promise<SignalRow[]> {
    const rows = rowsOf<SignalRow>(
      await this.tx.execute(sql`
        SELECT membership_id AS "membershipId", type, max(occurred_at) AS at, count(*)::int AS count,
               coalesce(sum(duration_ms), 0)::float8 AS "durationMs",
               coalesce((props->>'automated')::boolean, false) AS automated
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND occurred_at >= ${from}::timestamptz
          AND NOT ${UNSCORED_LINK_SQL}
        GROUP BY membership_id, type, date_trunc('day', occurred_at AT TIME ZONE 'UTC'),
                 coalesce((props->>'automated')::boolean, false)`),
    );
    return rows.map((r) => ({ ...r, at: asDate(r.at) }));
  }

  /** Opens and clicks on one update's emails, human and automated kept apart. */
  async emailStats(postId: string): Promise<EmailStatsRow> {
    const automated = sql.raw(`coalesce((props->>'automated')::boolean, false)`);
    const rows = rowsOf<EmailStatsRow>(
      await this.tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE type = 'email_opened' AND NOT ${automated})::int AS "humanOpens",
          count(DISTINCT membership_id) FILTER (WHERE type = 'email_opened' AND NOT ${automated})::int AS "uniqueHumanOpens",
          count(*) FILTER (WHERE type = 'email_opened' AND ${automated})::int AS "automatedOpens",
          count(DISTINCT membership_id) FILTER (WHERE type = 'email_opened' AND ${automated})::int AS "uniqueAutomatedOpens",
          count(*) FILTER (WHERE type = 'email_clicked' AND NOT ${automated})::int AS "humanClicks",
          count(DISTINCT membership_id) FILTER (WHERE type = 'email_clicked' AND NOT ${automated})::int AS "uniqueClickers",
          count(*) FILTER (WHERE type = 'email_clicked' AND ${automated})::int AS "automatedClicks",
          count(DISTINCT membership_id) FILTER (WHERE NOT ${automated})::int AS "uniqueEngaged"
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_id = ${postId}::uuid
          AND type IN ('email_opened', 'email_clicked')`),
    );
    return (
      rows[0] ?? {
        humanOpens: 0,
        uniqueHumanOpens: 0,
        automatedOpens: 0,
        uniqueAutomatedOpens: 0,
        humanClicks: 0,
        uniqueClickers: 0,
        automatedClicks: 0,
        uniqueEngaged: 0,
      }
    );
  }

  /** Clicks per followed link (origin + path), most-clicked first. */
  async emailLinks(postId: string, limit: number): Promise<EmailLinkRow[]> {
    const automated = sql.raw(`coalesce((props->>'automated')::boolean, false)`);
    return rowsOf<EmailLinkRow>(
      await this.tx.execute(sql`
        SELECT props->>'link' AS link,
               count(*) FILTER (WHERE NOT ${automated})::int AS clicks,
               count(DISTINCT membership_id) FILTER (WHERE NOT ${automated})::int AS "uniqueClickers",
               count(*) FILTER (WHERE ${automated})::int AS "automatedClicks"
        FROM analytics.event
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_id = ${postId}::uuid
          AND type = 'email_clicked'
        GROUP BY 1 ORDER BY 2 DESC, 4 DESC, 1 NULLS LAST LIMIT ${limit}`),
    );
  }

  /** Per-workspace retention (see `retentionCutoff`); returns the rows deleted. */
  async deleteExpired(retentionMonths: number, now: Date): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.event
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND occurred_at < ${retentionCutoff(retentionMonths, now)}`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}

export interface NewEmailEvent {
  readonly membershipId: string;
  readonly type: "email_opened" | "email_clicked";
  /** The update (`post`) the email carried. */
  readonly resourceId: string;
  /** `core.mail_message.id`. */
  readonly messageRef: string;
  readonly automated: boolean;
  readonly link: string | null;
  /** The provider's timestamp, as reported (part of the dedupe key). */
  readonly occurredAt: Date;
  /** When the kernel recorded the webhook (the outbox row's time): the clamp for `occurredAt`. */
  readonly receivedAt: Date;
}

export interface SignalRow {
  readonly membershipId: string;
  readonly type: EventType;
  readonly at: Date;
  readonly count: number;
  readonly durationMs: number;
  readonly automated: boolean;
}

export interface EmailStatsRow {
  readonly humanOpens: number;
  readonly uniqueHumanOpens: number;
  readonly automatedOpens: number;
  readonly uniqueAutomatedOpens: number;
  readonly humanClicks: number;
  readonly uniqueClickers: number;
  readonly automatedClicks: number;
  readonly uniqueEngaged: number;
}

export interface EmailLinkRow {
  readonly link: string | null;
  readonly clicks: number;
  readonly uniqueClickers: number;
  readonly automatedClicks: number;
}

// --- page_open (heartbeats) ---------------------------------------------------------------------
export interface Beat {
  readonly viewSessionId: string;
  readonly membershipId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly versionId: string | null;
  readonly pageNo: number;
  readonly ms: number;
}

export class PageOpenRepo extends TenantRepo<typeof pageOpen> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pageOpen, ctx, tx);
  }

  async beat(b: Beat): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO analytics.page_open (workspace_id, view_session_id, membership_id, resource_kind, resource_id, version_id, page_no, duration_ms)
      VALUES (${this.ctx.workspaceId}::uuid, ${b.viewSessionId}::uuid, ${b.membershipId}::uuid, ${b.resourceKind}::text,
              ${b.resourceId}::uuid, ${b.versionId}::uuid, ${b.pageNo}::int, ${b.ms}::int)
      ON CONFLICT (workspace_id, view_session_id, resource_id, page_no) DO UPDATE SET
        duration_ms = page_open.duration_ms + EXCLUDED.duration_ms,
        version_id = COALESCE(EXCLUDED.version_id, page_open.version_id),
        last_at = now()`);
  }

  private async flush(where: ReturnType<typeof sql>): Promise<number> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        WITH moved AS (
          DELETE FROM analytics.page_open
          WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND ${where}
          RETURNING *
        )
        INSERT INTO analytics.event (workspace_id, occurred_at, view_session_id, membership_id, type, resource_kind, resource_id, version_id, page_no, duration_ms, props)
        SELECT workspace_id, now(), view_session_id, membership_id, 'page_viewed', resource_kind, resource_id, version_id, page_no, duration_ms,
               jsonb_build_object('firstAt', ${isoUs(sql.raw("first_at"))}, 'lastAt', ${isoUs(sql.raw("last_at"))})
        FROM moved WHERE duration_ms > 0
        RETURNING id`),
    );
    return rows.length;
  }

  /** Page close: this session's dwell on one resource becomes `page_viewed` events. */
  flushSession(viewSessionId: string, resourceId: string): Promise<number> {
    return this.flush(
      sql`view_session_id = ${viewSessionId}::uuid AND resource_id = ${resourceId}::uuid`,
    );
  }

  /** Timeout: rows without a heartbeat since `before` (the tab was closed without a beacon). */
  flushIdle(before: Date): Promise<number> {
    return this.flush(sql`last_at < ${before}::timestamptz`);
  }

  /** Members with page_open rows quieter than `before` (the flush checks each for erasure first). */
  async membersIdleBefore(before: Date): Promise<string[]> {
    return rowsOf<{ membershipId: string }>(
      await this.tx.execute(sql`
        SELECT DISTINCT membership_id AS "membershipId" FROM analytics.page_open
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND last_at < ${before}::timestamptz`),
    ).map((r) => r.membershipId);
  }

  /** The member whose page_open rows a session holds for a resource (close beacon). */
  async membersOfSession(viewSessionId: string, resourceId: string): Promise<string[]> {
    return rowsOf<{ membershipId: string }>(
      await this.tx.execute(sql`
        SELECT DISTINCT membership_id AS "membershipId" FROM analytics.page_open
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND view_session_id = ${viewSessionId}::uuid
          AND resource_id = ${resourceId}::uuid`),
    ).map((r) => r.membershipId);
  }

  async deleteAll(): Promise<number> {
    const r = await this.tx.execute(
      sql`DELETE FROM analytics.page_open WHERE workspace_id = ${this.ctx.workspaceId}::uuid`,
    );
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  async deleteForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.page_open
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}

// --- rollups ------------------------------------------------------------------------------------
export interface ViewerDelta {
  readonly membershipId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly firstAt: Date;
  readonly lastAt: Date;
  readonly views: number;
  readonly downloads: number;
  readonly totalMs: number;
  readonly maxPageReached: number | null;
  readonly pagesSeen: readonly number[];
}

export interface DailyDelta {
  /** UTC `YYYY-MM-DD`. */
  readonly day: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly views: number;
  readonly downloads: number;
  readonly totalMs: number;
}

export interface ViewerRow {
  readonly membershipId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly firstAt: Date;
  readonly lastAt: Date;
  readonly views: number;
  readonly downloads: number;
  readonly totalMs: number;
  readonly maxPageReached: number | null;
  readonly pagesSeen: number[];
}

export interface Totals {
  readonly views: number;
  readonly downloads: number;
  readonly totalMs: number;
}

export interface TopResource extends Totals {
  readonly resourceId: string;
}

export class RollupRepo extends TenantRepo<typeof viewerResourceRollup> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(viewerResourceRollup, ctx, tx);
  }

  async readCursor(): Promise<{ occurredAt: string; eventId: string }> {
    const rows = rowsOf<{ occurredAt: string; eventId: string }>(
      await this.tx.execute(sql`
        SELECT ${isoUs(sql.raw("last_occurred_at"))} AS "occurredAt", last_event_id AS "eventId"
        FROM analytics.rollup_cursor WHERE workspace_id = ${this.ctx.workspaceId}::uuid`),
    );
    return (
      rows[0] ?? {
        occurredAt: "1970-01-01T00:00:00.000000Z",
        eventId: "00000000-0000-0000-0000-000000000000",
      }
    );
  }

  async writeCursor(cursor: { occurredAt: string; eventId: string }): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO analytics.rollup_cursor (workspace_id, last_occurred_at, last_event_id)
      VALUES (${this.ctx.workspaceId}::uuid, ${cursor.occurredAt}::timestamptz, ${cursor.eventId}::uuid)
      ON CONFLICT (workspace_id) DO UPDATE SET
        last_occurred_at = EXCLUDED.last_occurred_at, last_event_id = EXCLUDED.last_event_id`);
  }

  async applyViewer(d: ViewerDelta): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO analytics.viewer_resource_rollup AS r
        (workspace_id, membership_id, resource_kind, resource_id, first_at, last_at, views, downloads, total_ms, max_page_reached, pages_seen)
      VALUES (${this.ctx.workspaceId}::uuid, ${d.membershipId}::uuid, ${d.resourceKind}::text, ${d.resourceId}::uuid,
              ${d.firstAt}::timestamptz, ${d.lastAt}::timestamptz, ${d.views}::int, ${d.downloads}::int, ${d.totalMs}::bigint,
              ${d.maxPageReached}::int, ${sql.param([...d.pagesSeen])}::int[])
      ON CONFLICT (workspace_id, membership_id, resource_id) DO UPDATE SET
        first_at = LEAST(r.first_at, EXCLUDED.first_at),
        last_at = GREATEST(r.last_at, EXCLUDED.last_at),
        views = r.views + EXCLUDED.views,
        downloads = r.downloads + EXCLUDED.downloads,
        total_ms = r.total_ms + EXCLUDED.total_ms,
        max_page_reached = GREATEST(r.max_page_reached, EXCLUDED.max_page_reached),
        pages_seen = ARRAY(SELECT DISTINCT p FROM unnest(r.pages_seen || EXCLUDED.pages_seen) AS p ORDER BY p)`);
  }

  async applyDaily(d: DailyDelta): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO analytics.daily_resource_rollup AS r
        (workspace_id, day, resource_kind, resource_id, views, unique_viewers, total_ms, downloads)
      VALUES (${this.ctx.workspaceId}::uuid, ${d.day}::date, ${d.resourceKind}::text, ${d.resourceId}::uuid,
              ${d.views}::int, 0, ${d.totalMs}::bigint, ${d.downloads}::int)
      ON CONFLICT (workspace_id, day, resource_id) DO UPDATE SET
        views = r.views + EXCLUDED.views,
        total_ms = r.total_ms + EXCLUDED.total_ms,
        downloads = r.downloads + EXCLUDED.downloads`);
  }

  async setUniqueViewers(day: string, resourceId: string, n: number): Promise<void> {
    await this.tx.execute(sql`
      UPDATE analytics.daily_resource_rollup SET unique_viewers = ${n}::int
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND day = ${day}::date AND resource_id = ${resourceId}::uuid`);
  }

  async viewersFor(resourceKind: ResourceKind, resourceId: string): Promise<ViewerRow[]> {
    const rows = rowsOf<ViewerRow>(
      await this.tx.execute(sql`
        SELECT membership_id AS "membershipId", resource_kind AS "resourceKind", resource_id AS "resourceId",
               first_at AS "firstAt", last_at AS "lastAt", views, downloads, total_ms::float8 AS "totalMs",
               max_page_reached AS "maxPageReached", pages_seen AS "pagesSeen"
        FROM analytics.viewer_resource_rollup
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_kind = ${resourceKind}::text AND resource_id = ${resourceId}::uuid
        ORDER BY last_at DESC`),
    );
    return rows.map((r) => ({ ...r, firstAt: asDate(r.firstAt), lastAt: asDate(r.lastAt) }));
  }

  async totals(fromDay: string, toDay: string): Promise<Totals> {
    const rows = rowsOf<Totals>(
      await this.tx.execute(sql`
        SELECT coalesce(sum(views), 0)::int AS views, coalesce(sum(downloads), 0)::int AS downloads,
               coalesce(sum(total_ms), 0)::float8 AS "totalMs"
        FROM analytics.daily_resource_rollup
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND day >= ${fromDay}::date AND day <= ${toDay}::date`),
    );
    return rows[0] ?? { views: 0, downloads: 0, totalMs: 0 };
  }

  async top(
    resourceKind: ResourceKind,
    fromDay: string,
    toDay: string,
    limit: number,
  ): Promise<TopResource[]> {
    return rowsOf<TopResource>(
      await this.tx.execute(sql`
        SELECT resource_id AS "resourceId", sum(views)::int AS views, sum(downloads)::int AS downloads,
               sum(total_ms)::float8 AS "totalMs"
        FROM analytics.daily_resource_rollup
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_kind = ${resourceKind}::text
          AND day >= ${fromDay}::date AND day <= ${toDay}::date
        GROUP BY resource_id ORDER BY 2 DESC, 1 LIMIT ${limit}`),
    );
  }

  /**
   * Retention (E2.6): a per-member rollup whose last activity is older than the workspace's
   * retention names a person for longer than the raw events it was built from may exist.
   */
  async deleteViewerExpired(retentionMonths: number, now: Date): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.viewer_resource_rollup
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND last_at < ${retentionCutoff(retentionMonths, now)}`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  /** DSAR: the per-member rollups go; daily counts stay (no identity in them). */
  async deleteViewerForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.viewer_resource_rollup
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}

// --- page heatmap (E2.6) ---------------------------------------------------------------------------
export interface PageDelta {
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  /** Version id, or `NO_VERSION` (schema/analytics.ts). */
  readonly versionKey: string;
  readonly pageNo: number;
  readonly totalMs: number;
  readonly views: number;
  /** Members who read the page in this batch; only first-time readers raise `viewers`. */
  readonly membershipIds: readonly string[];
}

export interface HeatmapRow {
  readonly versionKey: string;
  readonly pageNo: number;
  readonly totalMs: number;
  readonly views: number;
  readonly viewers: number;
  readonly updatedAt: Date;
}

export class PageRollupRepo extends TenantRepo<typeof pageRollup> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pageRollup, ctx, tx);
  }

  /**
   * Adds one page's delta. The distinct-reader set (`page_viewer`) is written first; only the
   * rows it actually inserted raise `viewers`, so re-reading a page never double counts and a
   * DSAR erasure (which deletes that member's `page_viewer` rows) leaves the counts alone. A
   * re-read touches the reader row's `last_at`, which is what retention trims on.
   */
  async apply(d: PageDelta): Promise<void> {
    const ws = this.ctx.workspaceId;
    await this.tx.execute(sql`
      WITH touched AS (
        INSERT INTO analytics.page_viewer AS v (workspace_id, resource_id, version_key, page_no, membership_id)
        SELECT ${ws}::uuid, ${d.resourceId}::uuid, ${d.versionKey}::uuid, ${d.pageNo}::int, m
        FROM unnest(${sql.param([...d.membershipIds])}::uuid[]) AS m
        ON CONFLICT (workspace_id, resource_id, version_key, page_no, membership_id)
          DO UPDATE SET last_at = now()
        RETURNING (xmax = 0) AS inserted
      ),
      fresh AS (SELECT 1 FROM touched WHERE inserted)
      INSERT INTO analytics.page_rollup AS r
        (workspace_id, resource_kind, resource_id, version_key, page_no, total_ms, views, viewers)
      VALUES (${ws}::uuid, ${d.resourceKind}::text, ${d.resourceId}::uuid, ${d.versionKey}::uuid, ${d.pageNo}::int,
              ${d.totalMs}::bigint, ${d.views}::int, (SELECT count(*)::int FROM fresh))
      ON CONFLICT (workspace_id, resource_id, version_key, page_no) DO UPDATE SET
        total_ms = r.total_ms + EXCLUDED.total_ms,
        views = r.views + EXCLUDED.views,
        viewers = r.viewers + EXCLUDED.viewers,
        updated_at = now()`);
  }

  async heatmap(
    resourceKind: ResourceKind,
    resourceId: string,
    versionId: string | null,
  ): Promise<HeatmapRow[]> {
    const version = versionId === null ? sql`` : sql`AND version_key = ${versionId}::uuid`;
    const rows = rowsOf<HeatmapRow>(
      await this.tx.execute(sql`
        SELECT version_key AS "versionKey", page_no AS "pageNo", total_ms::float8 AS "totalMs",
               views, viewers, updated_at AS "updatedAt"
        FROM analytics.page_rollup
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND resource_kind = ${resourceKind}::text
          AND resource_id = ${resourceId}::uuid ${version}
        ORDER BY version_key, page_no`),
    );
    return rows.map((r) => ({ ...r, updatedAt: asDate(r.updatedAt) }));
  }

  /**
   * Retention (E2.6): reader rows not touched within the workspace's retention. The page counts
   * stay; a member who reads the page again afterwards counts as a new reader (README).
   */
  async deleteViewerExpired(retentionMonths: number, now: Date): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.page_viewer
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND last_at < ${retentionCutoff(retentionMonths, now)}`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  /** DSAR: the member leaves the distinct-reader set; the anonymous page counts stay. */
  async deleteViewerForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.page_viewer
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}

// --- hot-lead alerts (E2.6) -----------------------------------------------------------------------
export class HotLeadRepo extends TenantRepo<typeof hotLeadAlert> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(hotLeadAlert, ctx, tx);
  }

  /**
   * Claims the right to announce `membershipId` as a hot lead: true when there is no alert for
   * them yet, or the last one is older than the scoring window. One statement, so two rollup
   * passes racing each other cannot both win.
   */
  async claim(membershipId: string, score: number, windowDays: number): Promise<boolean> {
    const rows = rowsOf<{ one: number }>(
      await this.tx.execute(sql`
        INSERT INTO analytics.hot_lead_alert AS a (workspace_id, membership_id, alerted_at, score)
        VALUES (${this.ctx.workspaceId}::uuid, ${membershipId}::uuid, now(), ${score}::int)
        ON CONFLICT (workspace_id, membership_id) DO UPDATE SET alerted_at = now(), score = EXCLUDED.score
          WHERE a.alerted_at < now() - make_interval(days => ${windowDays}::int)
        RETURNING 1 AS one`),
    );
    return rows.length > 0;
  }

  /** Retention (E2.6): markers older than the workspace's retention. */
  async deleteExpired(retentionMonths: number, now: Date): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.hot_lead_alert
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND alerted_at < ${retentionCutoff(retentionMonths, now)}`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  async deleteForMembership(membershipId: string): Promise<number> {
    const r = await this.tx.execute(sql`
      DELETE FROM analytics.hot_lead_alert
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND membership_id = ${membershipId}::uuid`);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }
}
