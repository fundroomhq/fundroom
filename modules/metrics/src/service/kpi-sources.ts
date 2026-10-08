import { randomUUID } from "node:crypto";
import { pgErrorCode, type TenantContext, type Tx } from "@fundroom/db";
import type { IntegrationConnectionSummary, ModuleServices } from "@fundroom/module-kit";
import type { KpiReadValue, KpiSourceMetric } from "@fundroom/ports";
import { parseFixed } from "../decimal.js";
import { type Actor, MetricsError } from "../errors.js";
import { KPI_PROVIDERS, type KpiProvider, type SyncStatus } from "../model.js";
import { formatPeriodKey, parsePeriodKey, periodFor, periodSeries } from "../period.js";
import {
  DefinitionRepo,
  type DefinitionRow,
  SheetConnectionRepo,
  SourceBindingRepo,
  type SourceBindingRow,
} from "../repos/metrics-repo.js";
import { announcePointsChanged, applyCells, type CellWrite } from "./points.js";

/*
 * KPI sources (E3.6 §5, ADR-0054): a monthly metric bound to one series of a connected
 * accounting or billing system — QuickBooks Online, Xero, Stripe — and pulled nightly.
 *
 * The shape is the Google Sheets sync's (`sheets.ts`), deliberately, because the rules that
 * make that one safe are the same rules here:
 *
 *  1. **tx1** loads the bindings, their definitions and each provider's connection summary;
 *  2. the vendor read — `services.integrations.readKpi` — runs **outside any transaction**. It
 *     opens its own short transactions (token refresh, health), and a 15-second remote call
 *     must not hold a pool connection or a row lock while the vendor decides whether to answer;
 *  3. **tx2** re-locks the bindings (a per-workspace advisory lock, then the rows `FOR UPDATE`),
 *     drops any that were deleted, disabled or re-pointed while the read was in flight, writes
 *     through `applyCells` with `reviewPolicy: "when_manual"` — a number a person typed is never
 *     silently replaced; the new revision lands flagged `needs_review` — announces the points,
 *     records each binding's health and writes the audit row.
 *
 * One read per provider, not per binding: QuickBooks' P&L report answers revenue, expenses and
 * net income in one call, and the vendors' rate limits are per connection. The window is the
 * trailing 24 months on a provider's first successful sync (any of its bindings has never
 * succeeded) and the trailing 3 months after that, both through the current month — three,
 * because books are closed late and last month's revenue is routinely restated this month.
 *
 * A failed read records `status='failed'`, `last_error`, `consecutive_failures++`, an audit row
 * and a warn log on every binding of that provider — and sends **no mail**, the Sheets rule.
 * The connection's own health (degraded, reauth_required) is the kernel's, and the kernel's
 * `integration.connection_unhealthy` event is what alerts a human.
 */

/** Months read on a provider's first successful sync, current month included. */
export const KPI_BACKFILL_MONTHS = 24;
/** Months read on every later sync, current month included. */
export const KPI_TRAILING_MONTHS = 3;

/** What `GET /metrics/sources` says about one provider. Never a credential. */
export interface KpiProviderView {
  readonly provider: KpiProvider;
  readonly connected: boolean;
  readonly status: IntegrationConnectionSummary["status"] | null;
  readonly accountLabel: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastError: string | null;
  readonly metrics: readonly KpiSourceMetric[];
}

export interface KpiSourcesView {
  readonly providers: readonly KpiProviderView[];
  readonly bindings: readonly SourceBindingRow[];
}

export interface PutBindingInput {
  readonly provider: KpiProvider;
  readonly sourceMetric: string;
  readonly enabled?: boolean | undefined;
}

export interface KpiProviderSyncOutcome {
  readonly provider: KpiProvider;
  /** `failed` when the read itself failed; a binding can still fail on its own (currency). */
  readonly status: Extract<SyncStatus, "ok" | "failed">;
  readonly error: string | null;
  /** Months read, e.g. `2024-10`…`2026-09`; `null` when nothing was read. */
  readonly fromMonth: string | null;
  readonly toMonth: string | null;
  readonly bindings: number;
  readonly failedBindings: number;
  /** Bindings not read because the job's time budget ran out ("deferred to next sync"). */
  readonly deferredBindings: number;
  readonly written: number;
  readonly unchanged: number;
  readonly restated: number;
  readonly needsReview: number;
  /** Values the vendor sent that could not be used (outside the window, unreadable). */
  readonly skipped: number;
}

export interface KpiSyncOutcome {
  readonly providers: readonly KpiProviderSyncOutcome[];
  readonly written: number;
  readonly unchanged: number;
  readonly restated: number;
  readonly needsReview: number;
}

/** `metrics.source_binding.last_error` is CHECKed at 1 000 characters. */
const trimError = (text: string): string =>
  text.length > 1000 ? `${text.slice(0, 997)}...` : text;

export const NOT_CONNECTED = "not connected";
/**
 * One (workspace, provider)'s KPI sync job, enqueued by the nightly fan-out and by sync-now.
 * Per provider so a slow vendor (a Stripe backfill can take many minutes) never starves another.
 */
export const JOB_KPI_SYNC_PROVIDER = "metrics.kpi_sync_provider";
/**
 * The one dedupe key of a (workspace, provider) KPI job — nightly and sync-now alike. The queue
 * is `stately`, so at most one is queued and one running per key: two reads of one provider for
 * one workspace never overlap.
 */
export const kpiSyncKey = (workspaceId: string, provider: KpiProvider): string =>
  `metrics.kpi_sync:${workspaceId}:${provider}`;
/** No new vendor read starts after this long in one job (its expiry is 30 minutes). */
export const KPI_READ_BUDGET_MS = 20 * 60_000;
/** `last_error` of a binding whose read was not attempted in time; status is left alone. */
export const DEFERRED = "deferred to next sync";

/** `history_note` when a series' 24-month backfill was too large and 3 months were read. */
export const HISTORY_TOO_LARGE = "history too large to backfill: synced the trailing 3 months only";
/** Recorded when a concurrent write to the same cell won (`point_revision_unique`). */
export const CONFLICT_RETRY =
  "conflict with a concurrent write to the same month; retried next sync";

/** `error.reason` of the 409 when a metric would be fed by both a KPI binding and the Sheet. */
export const SOURCE_OVERLAP = "source_overlap";

/** The definition keys (lower-cased) a stored Sheets mapping writes. */
export function sheetMappingKeys(mapping: unknown): Set<string> {
  const columns = (mapping as { columns?: unknown } | null)?.columns;
  const keys = new Set<string>();
  if (!Array.isArray(columns)) return keys;
  for (const c of columns) {
    const key = (c as { key?: unknown } | null)?.key;
    if (typeof key === "string") keys.add(key.toLowerCase());
  }
  return keys;
}

/** A bindable definition: monthly, and typed in rather than computed. */
export function bindable(d: Pick<DefinitionRow, "periodKind" | "formula">): boolean {
  return d.periodKind === "month" && d.formula === null;
}

/** A source metric's unit must match the definition's: revenue is money, customers a count. */
function unitMismatch(d: Pick<DefinitionRow, "unit">, m: KpiSourceMetric): string | undefined {
  if (m.unit === "currency" && d.unit !== "currency") {
    return `\`${m.key}\` is an amount of money, so it can only feed a currency metric`;
  }
  if (m.unit === "count" && d.unit !== "count") {
    return `\`${m.key}\` is a count, so it can only feed a count metric`;
  }
  return undefined;
}

const actorFields = (actor: Actor | undefined) =>
  actor === undefined
    ? { actorKind: "system" as const, actorMembershipId: null }
    : {
        actorMembershipId: actor.membershipId,
        ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
        ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
      };

interface Planned {
  readonly binding: SourceBindingRow;
  readonly cells: CellWrite[];
  readonly skipped: number;
  /** A binding-level problem: nothing is written for it and it records `failed`. */
  readonly error: string | null;
}

/**
 * Turns one provider's read into cells, binding by binding. Pure, so the rules — the window,
 * `historical: false`, the currency check — are unit-testable without a database.
 */
export function planKpiCells(input: {
  readonly bindings: readonly SourceBindingRow[];
  readonly definitions: ReadonlyMap<string, DefinitionRow>;
  readonly catalogue: readonly KpiSourceMetric[];
  readonly value: KpiReadValue;
  readonly fromMonth: string;
  readonly toMonth: string;
  readonly currentMonth: string;
}): Planned[] {
  const byMetric = new Map(input.value.series.map((s) => [s.metric, s]));
  const catalogue = new Map(input.catalogue.map((m) => [m.key, m]));
  return input.bindings.map((binding): Planned => {
    const fail = (error: string): Planned => ({ binding, cells: [], skipped: 0, error });
    const definition = input.definitions.get(binding.definitionId);
    if (definition === undefined) return fail("the metric no longer exists");
    if (!bindable(definition)) {
      return fail("only a monthly metric that is not a formula can be fed by an integration");
    }
    const meta = catalogue.get(binding.sourceMetric);
    if (meta === undefined) {
      return fail(`${binding.provider} no longer offers \`${binding.sourceMetric}\``);
    }
    const mismatch = unitMismatch(definition, meta);
    if (mismatch !== undefined) return fail(mismatch);
    const reported = input.value.currency?.toUpperCase() ?? null;
    if (meta.unit === "currency" && reported !== null && reported !== definition.currency) {
      return fail(
        `${binding.provider} reports ${reported}, but \`${definition.key}\` is kept in ${definition.currency ?? "no currency"}; nothing was converted or written`,
      );
    }
    const series = byMetric.get(binding.sourceMetric);
    if (series === undefined) {
      return fail(`${binding.provider} returned no \`${binding.sourceMetric}\` series`);
    }
    const cells: CellWrite[] = [];
    let skipped = 0;
    for (const point of series.points) {
      // `historical: false` (Stripe MRR, active subscriptions): the vendor only knows *now*, so
      // a value it sent for another month would be today's figure written into the past.
      const inWindow = meta.historical
        ? point.month >= input.fromMonth && point.month <= input.toMonth
        : point.month === input.currentMonth;
      const period = inWindow ? parsePeriodKey("month", point.month) : undefined;
      const value = parseFixed(point.value);
      if (period === undefined || value === undefined) {
        skipped += 1;
        continue;
      }
      cells.push({ definitionId: definition.id, period, value, decimals: definition.decimals });
    }
    return { binding, cells, skipped, error: null };
  });
}

export function createKpiSourcesService(services: ModuleServices) {
  const { db } = services;

  function window(now: Date, months: number) {
    const periods = periodSeries("month", now, months);
    const first = periods[0] ?? periodFor("month", now);
    return {
      fromMonth: formatPeriodKey(first),
      toMonth: formatPeriodKey(periodFor("month", now)),
    };
  }

  /** Records `error` on every named binding and audits one failed sync for the provider. */
  async function recordProviderFailure(
    ctx: TenantContext,
    provider: KpiProvider,
    connectionId: string | null,
    bindings: readonly SourceBindingRow[],
    error: string,
    actor: Actor | undefined,
  ): Promise<void> {
    const message = trimError(error);
    await db.withTenant(ctx, async (tx) => {
      const repo = new SourceBindingRepo(ctx, tx);
      for (const b of bindings) {
        await repo.recordSync(b.id, b, { status: "failed", error: message });
      }
      await services.audit.record(tx, ctx, {
        action: "metrics.kpi_sync_failed",
        resourceKind: "integration_connection",
        resourceId: connectionId,
        outcome: "failure",
        ...actorFields(actor),
        meta: { provider, bindings: bindings.length, error: message },
      });
    });
    services.log("metrics.kpi_sync_failed", {
      level: "warn",
      workspaceId: ctx.workspaceId,
      provider,
      error: message,
    });
  }

  /** One vendor read and its write: the established bindings (3 months) or the new ones (24). */
  interface ReadGroup {
    readonly bindings: readonly SourceBindingRow[];
    readonly backfill: boolean;
  }

  type GroupOutcome = Omit<KpiProviderSyncOutcome, "provider">;

  const failedGroup = (
    group: ReadGroup,
    error: string,
    fromMonth: string | null,
    toMonth: string | null,
  ): GroupOutcome => ({
    status: "failed",
    error,
    fromMonth,
    toMonth,
    bindings: group.bindings.length,
    failedBindings: group.bindings.length,
    deferredBindings: 0,
    written: 0,
    unchanged: 0,
    restated: 0,
    needsReview: 0,
    skipped: 0,
  });

  const readError = (read: { reason: string; detail?: string | undefined }): string =>
    read.reason === "not_connected"
      ? NOT_CONNECTED
      : `${read.reason}${read.detail === undefined ? "" : `: ${read.detail}`}`;

  /**
   * Refusals a per-series retry cannot fix (a refused credential) or would make worse (a
   * throttled or unavailable vendor): the provider fails once for this sync.
   */
  const NO_FAN_OUT = new Set([
    "unauthorized",
    "forbidden",
    "not_connected",
    "rate_limited",
    "unavailable",
  ]);

  interface Budget {
    readonly signal: AbortSignal | undefined;
    /** Epoch ms after which no new vendor read starts. */
    readonly cutoff: number;
    readonly clock: () => number;
  }

  interface GroupRead {
    readonly currency: string | null;
    readonly series: KpiReadValue["series"][number][];
    /** Series whose 24-month backfill was too large and were read for 3 months instead. */
    readonly truncated: Set<string>;
    /** Series that could not be read, with why. */
    readonly failed: Map<string, string>;
    /** Series not attempted: the time budget ran out or the job is stopping. */
    readonly deferred: Set<string>;
  }

  /**
   * Reads a group's series with one combined read, then by the refusal:
   *  - `too_large` on a 24-month backfill: straight to the trailing 3 months for the whole
   *    group (noted in `history_note`) — no per-series 24-month re-reads, which is what made a
   *    Stripe fallback take most of an hour;
   *  - a refused credential, `rate_limited` or `unavailable`: every series fails **once** — no
   *    fan-out, so one burst of 429s cannot degrade the connection within a single sync;
   *  - an aborted read (`detail: "aborted"`, or the job's signal): deferred, not failed;
   *  - anything else (`malformed`, `not_found`, `transport`, …): each series is re-read alone,
   *    and a series that still fails does not discard the ones already read.
   * Once the 20-minute cutoff passes no new read starts; what is left — including a skipped
   * 3-month retry — is deferred to the next sync, never failed.
   */
  async function readGroup(
    ctx: TenantContext,
    provider: KpiProvider,
    metrics: readonly string[],
    windows: {
      due: { fromMonth: string; toMonth: string };
      short: { fromMonth: string; toMonth: string };
    },
    backfill: boolean,
    budget: Budget,
  ): Promise<GroupRead> {
    const out: GroupRead = {
      currency: null,
      series: [],
      truncated: new Set(),
      failed: new Map(),
      deferred: new Set(),
    };
    let currency: string | null = null;
    const outOfTime = () => budget.signal?.aborted === true || budget.clock() >= budget.cutoff;
    const read = (m: readonly string[], w: { fromMonth: string; toMonth: string }) =>
      services.integrations.readKpi(ctx, provider, {
        metrics: m,
        ...w,
        ...(budget.signal === undefined ? {} : { signal: budget.signal }),
      });
    const take = (value: KpiReadValue) => {
      currency ??= value.currency;
      out.series.push(...value.series);
    };
    const aborted = (r: { reason: string; detail?: string | undefined }) =>
      r.detail === "aborted" || budget.signal?.aborted === true;
    const defer = (ms: readonly string[]) => {
      for (const m of ms) out.deferred.add(m);
    };
    const fail = (ms: readonly string[], error: string) => {
      for (const m of ms) out.failed.set(m, error);
    };
    type Refused = { ok: false; reason: string; detail?: string | undefined };

    if (outOfTime()) {
      defer(metrics);
      return out;
    }
    let combined = await read(metrics, windows.due);
    if (!combined.ok && combined.reason === "too_large" && backfill) {
      if (outOfTime()) {
        defer(metrics);
        return out;
      }
      combined = await read(metrics, windows.short);
      if (combined.ok) for (const m of metrics) out.truncated.add(m);
    }
    if (combined.ok) {
      take(combined.value);
      return { ...out, currency };
    }
    const first = combined as Refused;
    if (aborted(first)) {
      defer(metrics);
      return out;
    }
    if (NO_FAN_OUT.has(first.reason) || metrics.length === 1) {
      fail(metrics, readError(first));
      return out;
    }
    for (const [i, metric] of metrics.entries()) {
      if (outOfTime()) {
        defer(metrics.slice(i));
        break;
      }
      const one = await read([metric], windows.due);
      if (one.ok) {
        take(one.value);
        continue;
      }
      const refused = one as Refused;
      if (aborted(refused)) {
        defer(metrics.slice(i));
        break;
      }
      out.failed.set(metric, readError(refused));
      if (NO_FAN_OUT.has(refused.reason)) {
        // The credential went bad, or the vendor is throttling: every remaining series would be
        // refused the same way, and asking again only makes it worse.
        fail(metrics.slice(i + 1), readError(refused));
        break;
      }
    }
    return { ...out, currency };
  }

  async function syncGroup(
    ctx: TenantContext,
    provider: KpiProvider,
    connectionId: string,
    group: ReadGroup,
    actor: Actor | undefined,
    budget: Budget,
  ): Promise<GroupOutcome> {
    const now = services.now();
    const short = window(now, KPI_TRAILING_MONTHS);
    const due = group.backfill ? window(now, KPI_BACKFILL_MONTHS) : short;
    const { fromMonth, toMonth } = due;
    // Series deferred last time go first, so a run cut short by the budget does not starve them.
    const wasDeferred = new Set(
      group.bindings.filter((b) => b.lastError === DEFERRED).map((b) => b.sourceMetric),
    );
    const metrics = [...new Set(group.bindings.map((b) => b.sourceMetric))]
      .sort()
      .sort((a, b) => Number(wasDeferred.has(b)) - Number(wasDeferred.has(a)));
    // Outside any transaction: `readKpi` opens its own, and the vendor call must not hold ours.
    const read = await readGroup(ctx, provider, metrics, { due, short }, group.backfill, budget);
    if (read.series.length === 0 && read.deferred.size === 0 && read.failed.size > 0) {
      // Nothing was read at all: one failure, recorded on every binding of the group.
      const error = [...read.failed.values()][0] ?? "unavailable";
      await recordProviderFailure(ctx, provider, connectionId, group.bindings, error, actor);
      return failedGroup(group, error, fromMonth, toMonth);
    }
    try {
      return await writeGroup(ctx, provider, connectionId, group.bindings, read, {
        syncId: randomUUID(),
        fromMonth,
        toMonth,
        backfill: group.backfill,
        actor,
      });
    } catch (error) {
      /*
       * Two refusals are this sync failing, recorded like any other — never a 500 and never a
       * sweep-stopping exception: `applyCells` refusing a batch it cannot store (a value past
       * numeric(20, 6)), and `point_revision_unique` when a grid save or a Sheets sync wrote
       * the same cell concurrently (they do not take this sync's lock). Anything else is a bug.
       */
      const message =
        error instanceof MetricsError
          ? error.message
          : pgErrorCode(error) === "23505" || pgErrorCode(error) === "23P01"
            ? CONFLICT_RETRY
            : undefined;
      if (message === undefined) throw error;
      await recordProviderFailure(ctx, provider, connectionId, group.bindings, message, actor);
      return failedGroup(group, message, fromMonth, toMonth);
    }
  }

  async function writeGroup(
    ctx: TenantContext,
    provider: KpiProvider,
    connectionId: string,
    bindings: readonly SourceBindingRow[],
    read: GroupRead,
    run: {
      syncId: string;
      fromMonth: string;
      toMonth: string;
      backfill: boolean;
      actor: Actor | undefined;
    },
  ): Promise<GroupOutcome> {
    const { syncId, fromMonth, toMonth, backfill, actor } = run;
    const value: KpiReadValue = { currency: read.currency, series: read.series };
    return db.withTenant(ctx, async (tx) => {
      const repo = new SourceBindingRepo(ctx, tx);
      /*
       * Re-read under lock. A binding the admin deleted, switched off or re-pointed while the
       * vendor answered writes nothing and records nothing — its new configuration has not been
       * read yet, and the next sync will. The definitions are re-read under the same lock (held
       * FOR SHARE), so the unit, currency and decimals the cells are checked and quantised
       * against are the ones committed now, not the ones seen before the vendor call.
       */
      const locked = new Map(
        (await repo.lockForSync(bindings.map((b) => b.id))).map((b) => [b.id, b]),
      );
      const current = bindings.filter((b) => {
        const held = locked.get(b.id);
        if (held === undefined) return false;
        return held.enabled && held.provider === b.provider && held.sourceMetric === b.sourceMetric;
      });
      const readable = current.filter(
        (b) => !read.failed.has(b.sourceMetric) && !read.deferred.has(b.sourceMetric),
      );
      const definitions = new Map(
        (await new DefinitionRepo(ctx, tx).byIds(readable.map((b) => b.definitionId))).map((d) => [
          d.id,
          d,
        ]),
      );
      const planned = planKpiCells({
        bindings: readable,
        definitions,
        catalogue: services.integrations.kpiMetrics(provider),
        value,
        fromMonth,
        toMonth,
        currentMonth: toMonth,
      });
      const writable = planned.filter((p) => p.error === null);
      const applied = await applyCells(
        tx,
        ctx,
        { audit: services.audit, now: services.now },
        {
          cells: writable.flatMap((p) => p.cells),
          sourceKind: provider,
          sourceRef: { provider, connectionId, syncId, currency: value.currency },
          ...(actor === undefined ? {} : { actor }),
          reviewPolicy: "when_manual",
        },
      );
      await announcePointsChanged(tx, ctx, applied.definitionIds);
      const errors: string[] = [];
      const notes: string[] = [];
      let deferredBindings = 0;
      for (const b of current) {
        const error = read.failed.get(b.sourceMetric);
        if (error !== undefined) {
          errors.push(error);
          await repo.recordSync(b.id, b, { status: "failed", error: trimError(error) });
        } else if (read.deferred.has(b.sourceMetric)) {
          // Not a failure: nothing was tried. Status and counters stay; the note says why.
          deferredBindings += 1;
          await repo.recordDeferred(b.id, b, DEFERRED);
        }
      }
      for (const p of planned) {
        if (p.error !== null) {
          errors.push(p.error);
          await repo.recordSync(p.binding.id, p.binding, {
            status: "failed",
            error: trimError(p.error),
          });
          continue;
        }
        const months = p.cells.map((c) => formatPeriodKey(c.period)).sort();
        const cut = backfill && read.truncated.has(p.binding.sourceMetric);
        if (cut) notes.push(p.binding.sourceMetric);
        await repo.recordSync(p.binding.id, p.binding, {
          status: "ok",
          error: null,
          ...(months[0] === undefined ? {} : { historyFrom: months[0] }),
          /*
           * The note is set by a truncated backfill and cleared only by a backfill that got the
           * whole window; an ordinary 3-month sync leaves it alone, so a short history stays
           * visible for as long as it is short.
           */
          ...(backfill ? { historyNote: cut ? HISTORY_TOO_LARGE : null } : {}),
        });
      }
      const failedBindings = errors.length;
      const skipped = planned.reduce((n, p) => n + p.skipped, 0);
      await services.audit.record(tx, ctx, {
        action: "metrics.kpi_synced",
        resourceKind: "integration_connection",
        resourceId: connectionId,
        ...actorFields(actor),
        meta: {
          provider,
          syncId,
          fromMonth,
          toMonth,
          bindings: current.length,
          failedBindings,
          deferredBindings,
          written: applied.written,
          restated: applied.restated,
          unchanged: applied.unchanged,
          needsReview: applied.needsReview,
          skipped,
          ...(notes.length === 0 ? {} : { truncated: notes }),
          ...(errors[0] === undefined ? {} : { error: trimError(errors[0]) }),
        },
      });
      if (failedBindings > 0) {
        services.log("metrics.kpi_binding_failed", {
          level: "warn",
          workspaceId: ctx.workspaceId,
          provider,
          failedBindings,
          error: errors[0],
        });
      }
      return {
        status: "ok" as const,
        error:
          errors[0] ??
          (deferredBindings > 0 ? DEFERRED : notes.length > 0 ? HISTORY_TOO_LARGE : null),
        fromMonth,
        toMonth,
        bindings: current.length,
        failedBindings,
        deferredBindings,
        written: applied.written,
        unchanged: applied.unchanged,
        restated: applied.restated,
        needsReview: applied.needsReview,
        skipped,
      };
    });
  }

  /**
   * Syncs one provider's enabled bindings in one workspace. Runs only in the job
   * `metrics.kpi_sync_provider` (one per workspace **and provider**, so a slow Stripe never
   * starves Xero). `signal` is the job's and is passed to every vendor read; no new read starts
   * once it fires or `budgetMs` (default 20 minutes, inside the job's 30-minute expiry) has
   * elapsed — what is left is recorded "deferred to next sync".
   */
  async function syncProvider(
    ctx: TenantContext,
    provider: KpiProvider,
    options: {
      readonly actor?: Actor | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly budgetMs?: number | undefined;
      /** Test seam: the clock the budget is measured on. */
      readonly clock?: (() => number) | undefined;
    } = {},
  ): Promise<KpiProviderSyncOutcome> {
    const clock = options.clock ?? Date.now;
    const budget: Budget = {
      signal: options.signal,
      cutoff: clock() + (options.budgetMs ?? KPI_READ_BUDGET_MS),
      clock,
    };
    const actor = options.actor;
    const loaded = await db.withTenant(ctx, async (tx) => {
      const bindings = (await new SourceBindingRepo(ctx, tx).list()).filter(
        (b) => b.enabled && b.provider === provider,
      );
      const connection =
        bindings.length === 0
          ? undefined
          : await services.integrations.connection(tx, ctx, provider);
      return { bindings, connection };
    });
    const { bindings, connection } = loaded;
    const empty: KpiProviderSyncOutcome = {
      provider,
      status: "ok",
      error: null,
      fromMonth: null,
      toMonth: null,
      bindings: 0,
      failedBindings: 0,
      deferredBindings: 0,
      written: 0,
      unchanged: 0,
      restated: 0,
      needsReview: 0,
      skipped: 0,
    };
    if (bindings.length === 0) return empty;
    if (connection === undefined) {
      await recordProviderFailure(ctx, provider, null, bindings, NOT_CONNECTED, actor);
      return {
        provider,
        ...failedGroup({ bindings, backfill: false }, NOT_CONNECTED, null, null),
      };
    }
    /*
     * The window is decided **per binding**: established bindings read the trailing 3 months,
     * new ones (never synced successfully) the trailing 24 — two reads when both exist. Keying
     * it on the provider would pull every working binding into a new binding's backfill, and a
     * backfill that fails would keep all of them there.
     */
    const groups: ReadGroup[] = [];
    const established = bindings.filter((b) => b.lastSuccessAt !== null);
    const fresh = bindings.filter((b) => b.lastSuccessAt === null);
    if (established.length > 0) groups.push({ bindings: established, backfill: false });
    if (fresh.length > 0) groups.push({ bindings: fresh, backfill: true });
    // A group holding bindings deferred last time runs first (stable otherwise).
    const hasDeferred = (g: ReadGroup) => g.bindings.some((b) => b.lastError === DEFERRED);
    groups.sort((a, b) => Number(hasDeferred(b)) - Number(hasDeferred(a)));

    const outcomes: GroupOutcome[] = [];
    for (const group of groups) {
      outcomes.push(await syncGroup(ctx, provider, connection.id, group, actor, budget));
    }
    const sum = (
      k:
        | "bindings"
        | "failedBindings"
        | "deferredBindings"
        | "written"
        | "unchanged"
        | "restated"
        | "needsReview"
        | "skipped",
    ) => outcomes.reduce((n, o) => n + o[k], 0);
    const froms = outcomes.flatMap((o) => (o.fromMonth === null ? [] : [o.fromMonth])).sort();
    const tos = outcomes.flatMap((o) => (o.toMonth === null ? [] : [o.toMonth])).sort();
    const allFailed = outcomes.length > 0 && outcomes.every((o) => o.status === "failed");
    return {
      provider,
      status: allFailed ? "failed" : "ok",
      error:
        outcomes.find((o) => o.status === "failed")?.error ??
        outcomes.find((o) => o.error !== null)?.error ??
        null,
      fromMonth: froms[0] ?? null,
      toMonth: tos[tos.length - 1] ?? null,
      bindings: sum("bindings"),
      failedBindings: sum("failedBindings"),
      deferredBindings: sum("deferredBindings"),
      written: sum("written"),
      unchanged: sum("unchanged"),
      restated: sum("restated"),
      needsReview: sum("needsReview"),
      skipped: sum("skipped"),
    };
  }

  /**
   * Every provider in turn — for tests and tools only; production runs `syncProvider` in its own
   * job per provider.
   */
  async function sync(
    ctx: TenantContext,
    actor?: Actor,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<KpiSyncOutcome> {
    const outcomes: KpiProviderSyncOutcome[] = [];
    for (const provider of await boundProviders(ctx)) {
      outcomes.push(await syncProvider(ctx, provider, { actor, signal: options.signal }));
    }
    const total = (k: "written" | "unchanged" | "restated" | "needsReview") =>
      outcomes.reduce((n, o) => n + o[k], 0);
    return {
      providers: outcomes,
      written: total("written"),
      unchanged: total("unchanged"),
      restated: total("restated"),
      needsReview: total("needsReview"),
    };
  }

  /** Providers with at least one enabled binding in the workspace. */
  async function boundProviders(ctx: TenantContext, tx?: Tx): Promise<KpiProvider[]> {
    const run = async (t: Tx) =>
      [
        ...new Set(
          (await new SourceBindingRepo(ctx, t).list())
            .filter((b) => b.enabled)
            .map((b) => b.provider),
        ),
      ].sort();
    return tx === undefined ? db.withTenant(ctx, run) : run(tx);
  }

  /**
   * `POST /sources/sync`: never reads inline — a Stripe backfill can take many minutes. Enqueues
   * one job per bound provider under the same keys the nightly fan-out uses, so a click while
   * a provider's sync is queued or running adds nothing and two reads never overlap.
   */
  async function requestSync(ctx: TenantContext, actor: Actor): Promise<KpiProvider[]> {
    return db.withTenant(ctx, async (tx) => {
      const providers = await boundProviders(ctx, tx);
      await services.audit.record(tx, ctx, {
        action: "metrics.kpi_sync_requested",
        resourceKind: "workspace",
        resourceId: ctx.workspaceId,
        ...actorFields(actor),
        ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        meta: { providers },
      });
      // In the audit row's transaction: a request that is recorded is a request that is queued.
      for (const provider of providers) {
        await services.queue.sendInTransaction(
          tx,
          JOB_KPI_SYNC_PROVIDER,
          { workspaceId: ctx.workspaceId, provider },
          { idempotencyKey: kpiSyncKey(ctx.workspaceId, provider) },
        );
      }
      return providers;
    });
  }

  return {
    async overview(ctx: TenantContext): Promise<KpiSourcesView> {
      return db.withTenant(ctx, async (tx) => {
        const bindings = await new SourceBindingRepo(ctx, tx).list();
        const providers: KpiProviderView[] = [];
        for (const provider of KPI_PROVIDERS) {
          const c = await services.integrations.connection(tx, ctx, provider);
          providers.push({
            provider,
            connected: c !== undefined,
            status: c?.status ?? null,
            accountLabel: c?.accountLabel ?? null,
            lastSuccessAt: c?.lastSuccessAt ?? null,
            lastError: c?.lastError ?? null,
            metrics: services.integrations.kpiMetrics(provider),
          });
        }
        return { providers, bindings };
      });
    },

    /**
     * Binds (or re-binds) a definition. A binding does not need a live connection — an admin
     * may set the mapping up before connecting — but it does need a series the provider offers
     * and a definition that can hold it: monthly, not a formula, and the same unit.
     */
    async putBinding(
      ctx: TenantContext,
      definitionId: string,
      input: PutBindingInput,
      actor: Actor,
    ): Promise<SourceBindingRow> {
      const meta = services.integrations
        .kpiMetrics(input.provider)
        .find((m) => m.key === input.sourceMetric);
      if (meta === undefined) {
        throw new MetricsError(
          "validation_failed",
          `${input.provider} offers no series called \`${input.sourceMetric}\``,
          { field: "sourceMetric", provider: input.provider },
        );
      }
      return db.withTenant(ctx, async (tx) => {
        const repo = new SourceBindingRepo(ctx, tx);
        await repo.lockSourceConfig();
        const definition = await new DefinitionRepo(ctx, tx).find(definitionId);
        if (definition === undefined) throw new MetricsError("not_found", "no such metric");
        if (!bindable(definition)) {
          throw new MetricsError(
            "binding_period_unsupported",
            "only a monthly metric that is not a formula can be fed by an integration",
            { periodKind: definition.periodKind, derived: definition.formula !== null },
          );
        }
        const mismatch = unitMismatch(definition, meta);
        if (mismatch !== undefined) {
          throw new MetricsError("validation_failed", mismatch, {
            field: "sourceMetric",
            unit: definition.unit,
          });
        }
        /*
         * One source per metric. The Sheets sync writes every definition its mapping names, so a
         * metric in both would be restated twice a night, each source undoing the other.
         */
        const sheet = await new SheetConnectionRepo(ctx, tx).find();
        if (
          sheet !== undefined &&
          sheetMappingKeys(sheet.mapping).has(definition.key.toLowerCase())
        ) {
          throw new MetricsError(
            "conflict",
            `\`${definition.key}\` is already fed by the Google Sheet; remove it from the sheet mapping first`,
            { reason: SOURCE_OVERLAP, key: definition.key, source: "sheets" },
          );
        }
        const before = await repo.findByDefinition(definitionId);
        const row = await repo.upsert({
          definitionId,
          provider: input.provider,
          sourceMetric: input.sourceMetric,
          enabled: input.enabled ?? before?.enabled ?? true,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "metrics.kpi_binding_set",
          resourceKind: "metric_definition",
          resourceId: definitionId,
          ...actorFields(actor),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            key: definition.key,
            bindingId: row.id,
            provider: row.provider,
            sourceMetric: row.sourceMetric,
            enabled: row.enabled,
            ...(before === undefined
              ? {}
              : { fromProvider: before.provider, fromSourceMetric: before.sourceMetric }),
          },
        });
        return row;
      });
    },

    async removeBinding(ctx: TenantContext, definitionId: string, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const removed = await new SourceBindingRepo(ctx, tx).remove(definitionId);
        if (removed === undefined) throw new MetricsError("not_found", "that metric is not bound");
        await services.audit.record(tx, ctx, {
          action: "metrics.kpi_binding_removed",
          resourceKind: "metric_definition",
          resourceId: definitionId,
          ...actorFields(actor),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            bindingId: removed.id,
            provider: removed.provider,
            sourceMetric: removed.sourceMetric,
          },
        });
      });
    },

    /** Whether the workspace has anything to sync — the sweep's cheap pre-check. */
    async hasEnabledBindings(ctx: TenantContext): Promise<boolean> {
      const rows = await db.withTenant(ctx, (tx) => new SourceBindingRepo(ctx, tx).list());
      return rows.some((b) => b.enabled);
    },

    sync,
    syncProvider,
    boundProviders,
    requestSync,
  };
}

export type KpiSourcesService = ReturnType<typeof createKpiSourcesService>;
