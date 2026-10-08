import {
  AUDIT_ACTION_RE,
  AUDIT_RESOURCE_KIND_RE,
  type AuditEventRow,
  type Database,
  isPlatformWorkspace,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type { AuditEventRecord, AuditOutcome, JsonObject } from "@fundroom/ports";
import type { AuditAction, AuditResourceKind } from "./actions.js";
import { normalizeIp, truncateIp } from "./ip.js";
import type { AuditDiff } from "./redact.js";
import { ensureAuditPartitions, insertAuditEvent, lockAuditChain } from "./repos/audit-repo.js";

/*
 * The recorder (ADR-0017). `record(tx, ctx, input)` writes one row in the caller's
 * transaction so a state change and its audit entry commit together; `recordDetached`
 * opens its own transaction for host-level flows that have no tenant transaction (session
 * revocation, platform events). The actor defaults to the context (membership + user of the
 * request) and can be overridden for "on behalf of" and system actions.
 *
 * Partition horizon: audit.ensure_partitions() is SECURITY DEFINER and idempotent; the
 * recorder calls it once per process per month boundary (and the maintenance job daily),
 * so a row can never fail for lack of a partition.
 */
export interface AuditInput {
  readonly action: AuditAction;
  readonly resourceKind: AuditResourceKind;
  readonly resourceId?: string | null | undefined;
  readonly subjectMembershipId?: string | null | undefined;
  readonly outcome?: AuditOutcome | undefined;
  /** Overrides; default from the context. */
  readonly actorKind?: AuditEventRecord["actorKind"] | undefined;
  readonly actorMembershipId?: string | null | undefined;
  readonly actorUserId?: string | null | undefined;
  readonly onBehalfOfMembershipId?: string | null | undefined;
  /** Full address; truncated to /24 or /48 unless the service is configured otherwise. */
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly diff?: AuditDiff | undefined;
  /** Ids, versions, counts, reasons. Never PII, never secrets. */
  readonly meta?: JsonObject | undefined;
  readonly occurredAt?: Date | undefined;
  /**
   * The API key the request authenticated with (E3.4): stored as `meta.apiKeyId`, next to the
   * key creator as the actor. Never the token or its hash.
   */
  readonly apiKeyId?: string | undefined;
}

const API_KEY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The `meta` an event is stored with: `input.meta` plus `apiKeyId` when a key made the request. */
export function auditMeta(input: Pick<AuditInput, "meta" | "apiKeyId">): JsonObject {
  const meta = input.meta ?? {};
  return input.apiKeyId === undefined ? meta : { ...meta, apiKeyId: input.apiKeyId };
}

export interface AuditServiceOptions {
  readonly db: Database;
  /** Keep full IPs (design/02 says truncate; a workspace may need full for security). Default true. */
  readonly truncateIp?: boolean;
  /** Months of partitions to keep ahead. Default 3. */
  readonly partitionMonthsAhead?: number;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  /**
   * Called inside the same transaction after the row is written; the composition root
   * publishes `audit.recorded` here when external sinks are configured.
   */
  readonly onRecorded?: (tx: Tx, ctx: TenantContext, record: AuditEventRecord) => Promise<void>;
}

export interface AuditRecorder {
  record(tx: Tx, ctx: TenantContext, input: AuditInput): Promise<AuditEventRecord>;
  /** Own transaction; for flows without a tenant transaction (host-level, platform). */
  recordDetached(ctx: TenantContext, input: AuditInput): Promise<AuditEventRecord>;
}

export interface AuditService extends AuditRecorder {
  /** Creates missing partitions through `monthsAhead`; returns how many were created. */
  ensurePartitions(monthsAhead?: number): Promise<number>;
}

export function toAuditRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    seq: Number(row.seq),
    occurredAt: row.occurredAt,
    actorKind: row.actorKind as AuditEventRecord["actorKind"],
    actorMembershipId: row.actorMembershipId,
    actorUserId: row.actorUserId,
    onBehalfOfMembershipId: row.onBehalfOfMembershipId,
    action: row.action,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    subjectMembershipId: row.subjectMembershipId,
    outcome: row.outcome,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    sessionId: row.sessionId,
    diff: (row.diff as JsonObject | null) ?? null,
    meta: (row.meta as JsonObject) ?? {},
    prevHash: row.prevHash ? Buffer.from(row.prevHash).toString("hex") : null,
    hash: Buffer.from(row.hash).toString("hex"),
  };
}

export class AuditInputError extends Error {
  override readonly name = "AuditInputError";
}

/**
 * Thrown by `record` when the context is a staff member viewing the portal as an investor
 * (E2.7): nothing may be written as the investor, and an audit row is a write. Duck-typed to
 * the API error envelope (`code` + `status`), so an unsuppressed call surfaces as 403
 * `view_as_read_only` rather than a 500. The view-as start/end rows themselves are recorded
 * with the staff member's own context.
 */
export class AuditViewAsReadOnlyError extends Error {
  override readonly name = "AuditViewAsReadOnlyError";
  readonly code = "view_as_read_only";
  readonly status = 403;
  readonly details: Record<string, unknown>;
  constructor(action: string) {
    super("this is a read-only view as an investor");
    this.details = { action };
  }
}

export function createAuditService(options: AuditServiceOptions): AuditService {
  const { db } = options;
  const truncate = options.truncateIp ?? true;
  const monthsAhead = options.partitionMonthsAhead ?? 3;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  /** Months (YYYY-MM-01) this process has confirmed to have a partition. */
  const known = new Set<string>();
  /** The standing window [current month, current + monthsAhead] was confirmed for this month. */
  let standingFor = "";

  function monthKey(d: Date, plusMonths = 0): string {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + plusMonths, 1))
      .toISOString()
      .slice(0, 10);
  }

  async function ensureHorizon(tx: Tx, occurredAt: Date): Promise<void> {
    const current = monthKey(now());
    if (standingFor !== current) {
      // From the recorder's own month, not the database's: `known` below is keyed on `now()`, so
      // a clock behind the database's (a test clock, or skew across a month boundary) must not
      // mark a month known that was never created.
      const created = await ensureAuditPartitions(tx, monthsAhead, current);
      for (let i = 0; i <= monthsAhead; i++) known.add(monthKey(now(), i));
      standingFor = current;
      if (created > 0) log("audit.partitions_created", { created });
    }
    // A backdated or far-future event outside the standing window: create just its month.
    const month = monthKey(occurredAt);
    if (!known.has(month)) {
      await ensureAuditPartitions(tx, 0, month);
      known.add(month);
    }
  }

  function validate(input: AuditInput): void {
    if (!AUDIT_ACTION_RE.test(input.action)) {
      throw new AuditInputError(`action ${JSON.stringify(input.action)} must be resource.verb`);
    }
    if (!AUDIT_RESOURCE_KIND_RE.test(input.resourceKind)) {
      throw new AuditInputError(`resourceKind ${JSON.stringify(input.resourceKind)} invalid`);
    }
    if (input.apiKeyId !== undefined && !API_KEY_ID_RE.test(input.apiKeyId)) {
      throw new AuditInputError("apiKeyId must be a key id");
    }
  }

  async function record(tx: Tx, ctx: TenantContext, input: AuditInput): Promise<AuditEventRecord> {
    if (ctx.viewAs !== undefined) throw new AuditViewAsReadOnlyError(input.action);
    validate(input);
    const occurredAt = input.occurredAt ?? now();
    // Workspace row, then chain (the global lock order), before anything else this insert takes;
    // the partition lock `ensureHorizon` may take (24301, 2) comes after both.
    await lockAuditChain(tx, ctx.workspaceId);
    await ensureHorizon(tx, occurredAt);
    const rawIp = input.ip ? (truncate ? truncateIp(input.ip) : normalizeIp(input.ip)) : undefined;
    const actorKind =
      input.actorKind ?? (isPlatformWorkspace(ctx.workspaceId) ? "host" : ctx.actorKind);
    const row = await insertAuditEvent(tx, {
      workspaceId: ctx.workspaceId,
      occurredAt,
      actorKind,
      actorMembershipId:
        input.actorMembershipId === undefined
          ? (ctx.membershipId ?? null)
          : input.actorMembershipId,
      actorUserId: input.actorUserId === undefined ? (ctx.userId ?? null) : input.actorUserId,
      onBehalfOfMembershipId: input.onBehalfOfMembershipId ?? null,
      action: input.action,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId ?? null,
      subjectMembershipId: input.subjectMembershipId ?? null,
      outcome: input.outcome ?? "success",
      ip: rawIp ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
      requestId: input.requestId ?? null,
      sessionId: input.sessionId ?? null,
      diff: input.diff ?? null,
      meta: auditMeta(input),
    });
    const rec = toAuditRecord(row);
    if (options.onRecorded) await options.onRecorded(tx, ctx, rec);
    return rec;
  }

  return {
    record,
    recordDetached(ctx, input) {
      // Refuse before opening a (read-only) transaction.
      if (ctx.viewAs !== undefined) {
        return Promise.reject(new AuditViewAsReadOnlyError(input.action));
      }
      return db.withTenant(ctx, (tx) => record(tx, ctx, input));
    },
    async ensurePartitions(ahead = monthsAhead) {
      const created = await db.withHost((tx) => ensureAuditPartitions(tx, ahead));
      for (let i = 0; i <= ahead; i++) known.add(monthKey(now(), i));
      return created;
    },
  };
}
