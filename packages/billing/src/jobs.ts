import { setWorkspaceHold } from "@fundroom/control-plane";
import type { Tx } from "@fundroom/db";
import type { BillingPort, JobDefinition, JsonObject } from "@fundroom/ports";
import { BILLING_CANCEL_JOB, type BillingCancelReason } from "./cancel.js";
import { decideGrace, GOOD_STATUSES, GRACE_STATUSES, storageGb } from "./effects.js";
import {
  deleteBillingEventsBefore,
  findSubscription,
  findWorkspace,
  listExpiredLocalTrials,
  listGraceExpired,
  listRecovered,
  listUsageToReport,
  lockSubscription,
  type Page,
  updateSubscription,
} from "./repos/billing-repo.js";
import { auditOnWorkspace, type BillingServiceDeps } from "./service.js";

/*
 * Billing jobs (E3.10, ADR-0058; owner: agent B): `billing.enforce` (hourly: grace expired →
 * suspend `billing`), `billing.report-usage` (`45 0 * * *`: yesterday's seats and storage as
 * Stripe meter events) and `billing.retention` (`core.billing_event` older than 90 days).
 *
 * `billing.enforce`, one short host transaction per workspace (never one long one: each takes the
 * workspace row and its audit chain), in three passes:
 *
 *  1. local trials that ended with no provider subscription behind them → `incomplete`, grace
 *     from now (mail: past due);
 *  2. grace passed on past_due / unpaid / canceled / incomplete / paused → `setWorkspaceHold
 *     (billing, on)` (mail: suspended, unless an operator or sanctions suspension outranks it).
 *     The flag is billing's own: it never touches an operator or sanctions suspension or a
 *     sanctions review hold;
 *  3. good standing again but still flagged for billing (a webhook's unsuspend failed, or the
 *     subscription was fixed while the event was in flight) → clear the `billing` flag.
 *
 * Each pass pages through its listing (keyset on the workspace id, one short host transaction per
 * page — no fixed cap a backlog could starve) and re-reads each row under `FOR UPDATE`,
 * re-checking the condition before acting, so a webhook that lands between the listing and the
 * action wins. Pass 1 skips deleted workspaces; pass 2 lists only workspaces without the
 * `billing` flag that are not merely held for sanctions review (a new workspace in review is not
 * live, so its grace is not enforced until it is), so nothing is listed again hour after hour. A workspace that fails is logged
 * and skipped; the next hour tries again.
 *
 * `billing.report-usage`: `staff_seats` and `storage_bytes` (whole GB, rounded up) of yesterday's
 * `core.tenant_usage_daily` row for every Stripe subscription that still bills — only for the
 * meters one of that subscription's metered prices bills on (`BillingPort.meteredEvents`; the
 * plan's `billing_metered_price_refs` are added to its checkout) — as meter events
 * with identifier `<workspace>:<day>:<meter>` — Stripe dedupes an identifier for at least 24 h
 * and the same identifier is the `Idempotency-Key`, so a retried job re-sends harmlessly. The
 * event's timestamp is the last second of that day (Stripe accepts up to 35 days back). A
 * retryable provider failure fails the job (pg-boss retries it); the meters only bill when the
 * plan's Stripe price is metered on them (docs).
 */

/**
 * The default Stripe meter event names usage is reported under (not per plan). The server passes
 * the operator's `BILLING_METER_SEATS_EVENT` / `BILLING_METER_STORAGE_EVENT` as `deps.meters`
 * (A-2: renamed from `seedhost_*`, before any live subscription existed).
 */
export const BILLING_METERS = {
  staffSeats: "fundroom_staff_seats",
  storageGb: "fundroom_storage_gb",
} as const;

/** What one `billing.cancel` run did. */
export type BillingCancelOutcome =
  /** The provider subscription is canceled now (by us, or it already was). */
  | "canceled"
  /** Nothing to cancel: no Stripe subscription, or it is canceled on record. */
  | "none"
  /** No longer due: the workspace was restored, or the sanctions suspension lifted. */
  | "moot";

/** Retention of `core.billing_event`. */
export const BILLING_EVENT_RETENTION_DAYS = 90;

export const BILLING_ENFORCE_CRON = "20 * * * *";
export const BILLING_REPORT_USAGE_CRON = "45 0 * * *";
export const BILLING_RETENTION_CRON = "50 3 * * *";

const DAY_MS = 86_400_000;
const USAGE_PAGE = 100;
/** Workspaces per enforcement listing page (keyset on the workspace id). */
export const ENFORCE_PAGE = 200;

export interface EnforceSummary {
  readonly trialsEnded: number;
  readonly suspended: number;
  readonly unsuspended: number;
  readonly failed: number;
}

export interface BillingJobs {
  readonly definitions: readonly JobDefinition<JsonObject>[];
  /** `pageSize`: the listing page (tests; default `ENFORCE_PAGE`). */
  enforce(options?: { readonly pageSize?: number | undefined }): Promise<EnforceSummary>;
  /** `day` (`YYYY-MM-DD`, UTC) defaults to yesterday. Returns the meter events sent. */
  reportUsage(day?: string): Promise<number>;
  retention(): Promise<number>;
  /** The `billing.cancel` job's body (idempotent; throws so the queue retries). */
  cancel(
    workspaceId: string,
    reason: BillingCancelReason,
    subscriptionId?: string | undefined,
  ): Promise<BillingCancelOutcome>;
}

/** The UTC day before `now`, `YYYY-MM-DD`. */
export function yesterdayOf(now: Date): string {
  return new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
}

export function createBillingJobs(deps: BillingServiceDeps): BillingJobs {
  const log = deps.log ?? (() => {});
  const invalidate = deps.invalidate ?? (() => {});
  const meterNames = deps.meters ?? BILLING_METERS;

  async function notify(
    kind: "past_due" | "suspended",
    workspaceId: string,
    graceUntil: Date | null,
  ): Promise<void> {
    if (deps.notify === undefined) return;
    try {
      await deps.notify({ kind, workspaceId, graceUntil });
    } catch (error) {
      log("billing.notify_failed", {
        level: "warn",
        kind,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function failed(pass: string, workspaceId: string, error: unknown): void {
    log("billing.enforce_failed", {
      level: "error",
      pass,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Every id a listing yields, one keyset page (one short host transaction) at a time. */
  async function* pages(
    list: (tx: Tx, page: Page) => Promise<string[]>,
    limit: number,
  ): AsyncGenerator<string> {
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const ids: string[] = await deps.db.withHost((tx) => list(tx, { after: cursor, limit }));
      yield* ids;
      if (ids.length < limit) return;
      after = ids[ids.length - 1] ?? null;
    }
  }

  async function endTrials(now: Date, limit: number): Promise<[number, number]> {
    let done = 0;
    let errors = 0;
    for await (const workspaceId of pages(
      (tx, page) => listExpiredLocalTrials(tx, now, page),
      limit,
    )) {
      try {
        const graceUntil = await deps.db.withHost(async (tx) => {
          const row = await lockSubscription(tx, workspaceId);
          if (
            row === undefined ||
            row.status !== "trialing" ||
            row.providerSubscriptionId !== null ||
            row.trialEnd === null ||
            row.trialEnd.getTime() >= now.getTime()
          ) {
            return null;
          }
          const until = new Date(now.getTime() + deps.graceDays * DAY_MS);
          await updateSubscription(tx, workspaceId, { status: "incomplete", graceUntil: until });
          await auditOnWorkspace(tx, deps.audit, workspaceId, {
            action: "subscription.update",
            resourceKind: "subscription",
            resourceId: workspaceId,
            actorKind: "system",
            actorMembershipId: null,
            actorUserId: null,
            meta: {
              provider: row.provider,
              from: "trialing",
              to: "incomplete",
              reason: "trial_ended",
            },
          });
          return until;
        });
        if (graceUntil !== null) {
          done += 1;
          await notify("past_due", workspaceId, graceUntil);
        }
      } catch (error) {
        errors += 1;
        failed("trial", workspaceId, error);
      }
    }
    return [done, errors];
  }

  async function suspendDue(now: Date, limit: number): Promise<[number, number]> {
    let done = 0;
    let errors = 0;
    for await (const workspaceId of pages(
      (tx, page) => listGraceExpired(tx, now, GRACE_STATUSES, page),
      limit,
    )) {
      try {
        const change = await deps.db.withHost(async (tx) => {
          const row = await lockSubscription(tx, workspaceId);
          if (
            row === undefined ||
            row.graceUntil === null ||
            row.graceUntil.getTime() >= now.getTime() ||
            !GRACE_STATUSES.includes(row.status)
          ) {
            return undefined;
          }
          return setWorkspaceHold(
            tx,
            {
              workspaceId,
              hold: "billing",
              on: true,
              actor: { kind: "system", source: "billing" },
              meta: { subscriptionStatus: row.status },
            },
            { audit: deps.audit, invalidate, now: deps.now },
          );
        });
        if (change?.changed) {
          change.afterCommit();
          done += 1;
          // Mail only when billing is what the owners now see (not under an operator or sanctions
          // suspension, which outrank it and say nothing about billing).
          if (change.after.reason === "billing") await notify("suspended", workspaceId, null);
        }
      } catch (error) {
        errors += 1;
        failed("suspend", workspaceId, error);
      }
    }
    return [done, errors];
  }

  async function unsuspendRecovered(limit: number): Promise<[number, number]> {
    let done = 0;
    let errors = 0;
    for await (const workspaceId of pages(
      (tx, page) => listRecovered(tx, GOOD_STATUSES, page),
      limit,
    )) {
      try {
        const change = await deps.db.withHost(async (tx) => {
          const row = await lockSubscription(tx, workspaceId);
          if (row === undefined || !GOOD_STATUSES.includes(row.status)) return undefined;
          return setWorkspaceHold(
            tx,
            {
              workspaceId,
              hold: "billing",
              on: false,
              actor: { kind: "system", source: "billing" },
              meta: { subscriptionStatus: row.status },
            },
            { audit: deps.audit, invalidate, now: deps.now },
          );
        });
        if (change?.changed) {
          change.afterCommit();
          done += 1;
        }
      } catch (error) {
        errors += 1;
        failed("unsuspend", workspaceId, error);
      }
    }
    return [done, errors];
  }

  async function enforce(
    options: { readonly pageSize?: number | undefined } = {},
  ): Promise<EnforceSummary> {
    const limit = options.pageSize ?? ENFORCE_PAGE;
    if (deps.port === null) return { trialsEnded: 0, suspended: 0, unsuspended: 0, failed: 0 };
    const now = deps.now();
    const [trialsEnded, e1] = await endTrials(now, limit);
    const [suspended, e2] = await suspendDue(now, limit);
    const [unsuspended, e3] = await unsuspendRecovered(limit);
    const summary = { trialsEnded, suspended, unsuspended, failed: e1 + e2 + e3 };
    if (trialsEnded + suspended + unsuspended + summary.failed > 0) {
      log("billing.enforced", summary);
    }
    return summary;
  }

  async function reportUsage(day?: string): Promise<number> {
    const port = deps.port;
    if (port === null || port.driver !== "stripe") return 0;
    const target = day ?? yesterdayOf(deps.now());
    const timestamp = new Date(`${target}T23:59:59Z`);
    let after: string | null = null;
    let sent = 0;
    let retryable: unknown;
    for (;;) {
      const page = await deps.db.withHost((tx) => listUsageToReport(tx, target, after, USAGE_PAGE));
      for (const row of page) {
        // Only the meters a price on THIS subscription bills on (the plan may have none, or the
        // subscription may predate a metered price): an event for a meter nobody is charged on is
        // noise at best and an error at worst.
        let billed: ReadonlySet<string>;
        try {
          billed = new Set(await (port.meteredEvents?.(row.subscriptionRef) ?? []));
        } catch (error) {
          log("billing.usage_report_failed", {
            level: "warn",
            workspaceId: row.workspaceId,
            meter: null,
            error: error instanceof Error ? error.message : String(error),
          });
          if ((error as { retryable?: unknown }).retryable === true) retryable = error;
          continue;
        }
        // A-2: a meter whose event name is neither configured name is billed on but never fed —
        // typically a Stripe meter still named `seedhost_staff_seats` / `seedhost_storage_gb`
        // after the defaults became `fundroom_*`. Say so instead of dropping the usage silently.
        for (const event of billed) {
          if (event !== meterNames.staffSeats && event !== meterNames.storageGb) {
            log("billing.usage_meter_unknown", {
              level: "warn",
              workspaceId: row.workspaceId,
              meter: event,
              configured: [meterNames.staffSeats, meterNames.storageGb],
              hint: "set BILLING_METER_SEATS_EVENT / BILLING_METER_STORAGE_EVENT to the event names of your Stripe meters",
            });
          }
        }
        const meters = (
          [
            [meterNames.staffSeats, row.staffSeats],
            [meterNames.storageGb, storageGb(row.storageBytes)],
          ] as [string, number][]
        ).filter(([meter]) => billed.has(meter));
        for (const [meter, value] of meters) {
          try {
            await port.reportUsage({
              customerRef: row.customerRef,
              meter,
              value,
              timestamp,
              identifier: `${row.workspaceId}:${target}:${meter}`,
            });
            sent += 1;
          } catch (error) {
            log("billing.usage_report_failed", {
              level: "warn",
              workspaceId: row.workspaceId,
              meter,
              error: error instanceof Error ? error.message : String(error),
            });
            if ((error as { retryable?: unknown }).retryable === true) retryable = error;
          }
        }
      }
      if (page.length < USAGE_PAGE) break;
      after = page[page.length - 1]?.workspaceId ?? null;
    }
    // Idempotent identifiers make the whole-job retry safe.
    if (retryable !== undefined) throw retryable;
    return sent;
  }

  /*
   * `billing.cancel`: re-checked at run time (a workspace restored, or a sanctions suspension
   * lifted, before the job ran is left alone), then the provider is asked — a subscription the
   * provider already shows as canceled is done, and a failed cancel is re-read before it counts
   * as failed (Stripe refuses to cancel a canceled subscription). A failure throws: the queue
   * retries with backoff and then dead-letters (visible in the ops console). The record is set
   * `canceled` here, because the provider's own webhook is dropped for a deleted workspace.
   */
  /** Cancels one provider subscription (a subscription already canceled there is done). */
  async function cancelAtProvider(port: BillingPort, subscriptionId: string): Promise<void> {
    let fact = await port.getSubscription(subscriptionId);
    if (fact.status === "canceled") return;
    try {
      await port.cancel(subscriptionId);
    } catch (error) {
      fact = await port.getSubscription(subscriptionId);
      if (fact.status !== "canceled") throw error;
    }
  }

  async function cancel(
    workspaceId: string,
    reason: BillingCancelReason,
    subscriptionId?: string | undefined,
  ): Promise<BillingCancelOutcome> {
    const port = deps.port;
    if (port === null || port.driver !== "stripe") return "none";
    const facts = await deps.db.withHost(async (tx) => ({
      row: await findSubscription(tx, workspaceId),
      ws: await findWorkspace(tx, workspaceId),
    }));
    const { row, ws } = facts;
    const stored =
      row !== undefined &&
      row.provider === "stripe" &&
      row.providerSubscriptionId !== null &&
      row.status !== "canceled"
        ? row.providerSubscriptionId
        : null;
    // The job may name a subscription the row does not hold (FR4-1): a checkout completed after
    // the delete, or a second subscription on our customer. It is ours only if it is on the
    // customer we stored for this workspace — checked on the provider's own answer.
    let named: string | null = null;
    if (subscriptionId !== undefined && subscriptionId !== stored) {
      const fact = await port.getSubscription(subscriptionId);
      if (
        row?.providerCustomerId !== null &&
        row?.providerCustomerId !== undefined &&
        fact.providerCustomerId === row.providerCustomerId
      ) {
        named = fact.status === "canceled" ? null : subscriptionId;
      } else {
        log("billing.cancel_refused", {
          level: "warn",
          workspaceId,
          reason: "not_our_customer",
        });
      }
    }
    if (stored === null && named === null) return "none";
    // Due while EITHER cause holds, whichever one queued the job (RR2-6): a workspace deleted
    // and sanctioned is canceled even if the delete's job was restored away first.
    const stillDue = ws === undefined || ws.deletedAt !== null || ws.holds.includes("sanctions");
    if (!stillDue) return "moot";
    if (named !== null) await cancelAtProvider(port, named);
    if (stored === null) {
      log("billing.subscription_canceled", { workspaceId, reason, stored: false });
      return "canceled";
    }
    await cancelAtProvider(port, stored);
    await deps.db.withHost(async (tx) => {
      const locked = await lockSubscription(tx, workspaceId);
      if (locked?.providerSubscriptionId !== stored || locked.status === "canceled") return;
      // The grace a cancellation gets anywhere else (RR1-M3): from the paid-up period's end. A
      // workspace restored (or released) later is suspended once it runs out — never left
      // running for free on a subscription nobody pays.
      const grace = decideGrace({
        graceUntil: locked.graceUntil,
        status: "canceled",
        currentPeriodEnd: locked.currentPeriodEnd,
        now: deps.now(),
        graceDays: deps.graceDays,
      });
      await updateSubscription(tx, workspaceId, {
        status: "canceled",
        cancelAtPeriodEnd: false,
        graceUntil: grace.graceUntil,
      });
      if (ws === undefined) return;
      await auditOnWorkspace(tx, deps.audit, workspaceId, {
        action: "subscription.update",
        resourceKind: "subscription",
        resourceId: workspaceId,
        actorKind: "system",
        actorMembershipId: null,
        actorUserId: null,
        meta: { provider: "stripe", from: locked.status, to: "canceled", reason },
      });
    });
    log("billing.subscription_canceled", { workspaceId, reason, stored: true });
    return "canceled";
  }

  async function retention(): Promise<number> {
    const before = new Date(deps.now().getTime() - BILLING_EVENT_RETENTION_DAYS * DAY_MS);
    return deps.db.withHost((tx) => deleteBillingEventsBefore(tx, before));
  }

  const definitions: JobDefinition<JsonObject>[] =
    deps.port === null
      ? []
      : [
          {
            name: "billing.enforce",
            cron: BILLING_ENFORCE_CRON,
            queue: { policy: "singleton", retryLimit: 0 },
            handler: async () => {
              await enforce();
            },
          },
          {
            name: "billing.report-usage",
            cron: BILLING_REPORT_USAGE_CRON,
            queue: { policy: "singleton", retryLimit: 5, retryDelaySeconds: 300 },
            handler: async () => {
              await reportUsage();
            },
          },
          {
            name: "billing.retention",
            cron: BILLING_RETENTION_CRON,
            queue: { policy: "singleton" },
            handler: async () => {
              await retention();
            },
          },
          {
            name: BILLING_CANCEL_JOB,
            queue: {
              policy: "short",
              retryLimit: 10,
              retryDelaySeconds: 60,
              retryBackoff: true,
              expireInSeconds: 300,
            },
            handler: async (job) => {
              const workspaceId = job.data["workspaceId"];
              const reason = job.data["reason"];
              const subscriptionId = job.data["subscriptionId"];
              if (typeof workspaceId !== "string") return;
              await cancel(
                workspaceId,
                reason === "sanctions" ? "sanctions" : "deleted",
                typeof subscriptionId === "string" ? subscriptionId : undefined,
              );
            },
          },
        ];

  return { definitions, enforce, reportUsage, retention, cancel };
}
