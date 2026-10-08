import { type Database, systemContext } from "@fundroom/db";
import type { CustomDomainProviderPort, JobDefinition, JsonObject } from "@fundroom/ports";
import {
  isHostnameHeld,
  listDomainsForSweep,
  lockHostname,
  type SweepRow,
} from "../repos/domains-repo.js";
import { VERIFY_DEADLINE_MS } from "../state.js";
import {
  type CustomDomainService,
  JOB_PROVIDER_RELEASE,
  type ProviderReleaseJob,
} from "./domains.js";

/*
 * The two sweeps (E2.1 §1.10).
 *
 *  - `domains.verify`   every 5 minutes (design/01: "poll every 5 min"). Moves `pending` rows to
 *    `dns_ok` when DNS proves out and gives up at `VERIFY_DEADLINE_MS`, with backoff so a zone
 *    that will never be fixed is not queried 864 times a day.
 *  - `domains.reverify` weekly, Monday 04:40 UTC. Re-checks the verified rows; the demotion after
 *    `REVERIFY_GRACE` failures is what keeps one bad DoH answer from taking a working portal
 *    offline.
 *
 * Both cron expressions are fixed by the contract: every nearby slot is taken (`50 3 * * 0` is
 * data-room's, `10 2 * * *` is the audit checkpoint's), so they are not free to move.
 *
 * Shape, following `modules/updates/src/jobs.ts` and `packages/audit/src/checkpoint.ts`:
 * **the candidate read is one query in HOST context** — the sweep spans workspaces and the
 * table's fence admits the `host` actor kind for exactly this — and each row is then acted on in
 * *tenant* context (`systemContext(workspaceId)`), because the write and its audit row have to
 * commit together inside the workspace's own fence. `data.workspaceId` narrows the sweep to one
 * workspace (the repo convention).
 *
 * The state machine, the deadline and the grace all live in `state.ts`; these jobs decide only
 * *which rows to look at and when*, and `service.check()` does the rest, so "Verify now" and a
 * poll cannot reach different conclusions.
 */

export const JOB_VERIFY = "domains.verify";
export const JOB_REVERIFY = "domains.reverify";

/** First retry after 5 minutes, i.e. the next tick. */
export const VERIFY_BACKOFF_BASE_MS = 5 * 60_000;
/** Ceiling, so a row still gets ~12 attempts a day right up to the 72 h deadline. */
export const VERIFY_BACKOFF_MAX_MS = 2 * 3600_000;

/** How many rows one tick will look at. Generous: a workspace has one or two. */
const DEFAULT_BATCH = 500;

/**
 * Exponential backoff on consecutive failures: 5 min, 10, 20, 40, 80, then capped at 2 h. DNS
 * that is wrong now is usually wrong for hours (a TTL, a support ticket, a registrar), and a
 * fixed 5-minute poll for 72 h is 864 queries against somebody else's nameservers per domain.
 */
export function verifyBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  const grown = VERIFY_BACKOFF_BASE_MS * 2 ** Math.min(n, 20);
  return Math.min(grown, VERIFY_BACKOFF_MAX_MS);
}

/**
 * Whether the 5-minute sweep should resolve this row now.
 *
 * A row past `VERIFY_DEADLINE_MS` is always due even when its backoff says otherwise: the sweep
 * is the only thing that can move it to `failed`, and a row that stopped being checked would sit
 * `pending` forever.
 */
export function isDueForVerify(
  row: Pick<SweepRow, "consecutiveFailures" | "firstAttemptAt" | "lastCheckedAt">,
  now: Date,
): boolean {
  if (row.lastCheckedAt === null) return true;
  if (now.getTime() - row.firstAttemptAt.getTime() >= VERIFY_DEADLINE_MS) return true;
  return now.getTime() - row.lastCheckedAt.getTime() >= verifyBackoffMs(row.consecutiveFailures);
}

/**
 * E3.10: how often a `dns_ok` row is polled for its provider's verdict (`cloudflare-saas`).
 * Cloudflare validates most hostnames within minutes of the CNAME landing and then backs off over
 * seven days, so: every tick for the first hour, every 15 minutes for the first day, hourly after
 * that. At one call per due row per tick this keeps a few hundred pending hostnames far inside
 * Cloudflare's 1 200 requests / 5 minutes.
 */
export function providerPollIntervalMs(sinceDnsOkMs: number): number {
  if (sinceDnsOkMs < 3600_000) return VERIFY_BACKOFF_BASE_MS;
  if (sinceDnsOkMs < 24 * 3600_000) return 15 * 60_000;
  return 3600_000;
}

/** Whether the verify sweep should ask the provider about this `dns_ok` row now (E3.10). */
export function isDueForProviderPoll(
  row: Pick<SweepRow, "dnsOkAt" | "lastCheckedAt">,
  now: Date,
): boolean {
  if (row.lastCheckedAt === null || row.dnsOkAt === null) return true;
  const interval = providerPollIntervalMs(now.getTime() - row.dnsOkAt.getTime());
  // A minute of slack so a 5-minute cron that fires a few seconds early does not skip a tick.
  return now.getTime() - row.lastCheckedAt.getTime() >= interval - 60_000;
}

export interface DomainJobsOptions {
  readonly db: Pick<Database, "withHost">;
  /** `pollsProvider` (E3.10) adds `dns_ok` rows to the verify sweep. */
  readonly service: Pick<CustomDomainService, "check"> &
    Partial<Pick<CustomDomainService, "pollsProvider">>;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /** Rows per tick. Default 500. */
  readonly batch?: number | undefined;
  /**
   * The provider, for `domains.provider-release` (E3.10 FR1). Absent: the job is not defined (the
   * service then has no queue either and tells the provider directly).
   */
  readonly provider?: Pick<CustomDomainProviderPort, "deactivate" | "admit"> | undefined;
  /**
   * Test seam / alternative store. Defaults to the **host-context** query in the repo — the one
   * that spans workspaces. An override must keep that property; running the candidate read in
   * tenant context returns zero rows for every workspace but one.
   */
  readonly candidates?:
    | ((input: {
        readonly statuses: readonly SweepRow["status"][];
        readonly limit: number;
        readonly workspaceId?: string | undefined;
      }) => Promise<SweepRow[]>)
    | undefined;
}

interface SweepResult {
  readonly looked: number;
  readonly checked: number;
}

async function sweep(
  options: DomainJobsOptions,
  input: {
    readonly statuses: readonly SweepRow["status"][];
    readonly workspaceId?: string | undefined;
    readonly due: (row: SweepRow, now: Date) => boolean;
    readonly event: string;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<SweepResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const at = now();
  const query = {
    statuses: input.statuses,
    limit: options.batch ?? DEFAULT_BATCH,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
  // HOST context: one query across every workspace's rows.
  const read =
    options.candidates ??
    ((q: typeof query) => options.db.withHost((tx) => listDomainsForSweep(tx, q)));
  const rows = await read(query);
  let checked = 0;
  for (const row of rows) {
    if (input.signal?.aborted === true) break;
    if (!input.due(row, at)) continue;
    // TENANT context, per row: the status change and its audit row commit together.
    try {
      await options.service.check(systemContext(row.workspaceId), row.id);
      checked++;
    } catch (error) {
      // One workspace's broken row must not stop the sweep.
      log(`${input.event}_failed`, {
        level: "warn",
        workspaceId: row.workspaceId,
        hostname: row.hostname,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log(input.event, { looked: rows.length, checked });
  return { looked: rows.length, checked };
}

/** Exposed for tests and for a one-off operator run. */
export async function runVerifySweep(
  options: DomainJobsOptions,
  input: { readonly workspaceId?: string | undefined; readonly signal?: AbortSignal } = {},
): Promise<SweepResult> {
  return sweep(options, {
    // `pending` only (E2.1 S2). `dns_ok` used to be swept here too, on the theory that a second
    // good DNS poll was how a domain reached `active` — but a DNS verdict is not evidence that a
    // certificate was ever issued, and `active` is what `primaryHost` (and therefore every
    // emailed link) keys off. The promotion now happens when a request is actually served on the
    // hostname, so this sweep has nothing to do with `dns_ok` rows: their DNS is already right,
    // and `domains.reverify` is what re-checks them. Not sweeping them also stops a verified
    // domain from being re-resolved against the customer's nameservers every five minutes
    // forever.
    //
    // E3.10 exception: with a provider that issues the certificate itself (`cloudflare-saas`),
    // `dns_ok → active` IS this sweep's write — the provider's `status()` is the evidence — so
    // `dns_ok` rows are polled too, on their own slower schedule (`isDueForProviderPoll`).
    statuses: options.service.pollsProvider === true ? ["pending", "dns_ok"] : ["pending"],
    due: (row, now) =>
      row.status === "dns_ok" ? isDueForProviderPoll(row, now) : isDueForVerify(row, now),
    event: "domains.verify_swept",
    ...input,
  });
}

/** Exposed for tests and for a one-off operator run. */
export async function runReverifySweep(
  options: DomainJobsOptions,
  input: { readonly workspaceId?: string | undefined; readonly signal?: AbortSignal } = {},
): Promise<SweepResult> {
  return sweep(options, {
    statuses: ["active", "dns_ok"],
    // Weekly, so there is nothing to back off from: every verified row is re-checked every run,
    // and `nextState` only demotes after REVERIFY_GRACE (currently 3) consecutive failures —
    // roughly three weeks of a hostname being wrong before a working portal is taken offline.
    due: () => true,
    event: "domains.reverify_swept",
    ...input,
  });
}

/**
 * `domains.provider-release` (E3.10 FR1): tells the provider a hostname is no longer ours to
 * serve, and throws until it confirms — the queue retries (backing off from a minute, ~3 days in
 * all) and then dead-letters it where an operator sees it. `deactivate` treats "already gone" as
 * done, so a retry after a success that timed out is harmless.
 *
 * Skipped when the hostname is verified (`dns_ok`/`active`) again by the time the job runs — on
 * this workspace's re-verified row, on the workspace it moved to, or on a soft-deleted workspace
 * that may still be restored: the provider holds ONE entry per hostname, which that row has just
 * re-registered (or adopted), and releasing it now would take the live registration down.
 *
 * FR3: the "still held?" read and the DELETE run under the per-hostname advisory lock
 * (`lockHostname`) that a registration also takes before it asks the provider to create — so a
 * re-verification cannot slip in between the read and the DELETE. The provider call is therefore
 * made inside the lock's transaction, so its budget is paid first (`admit`, outside the
 * transaction: the budget lives in the shared Postgres rate limiter, i.e. another connection) and
 * the DELETE itself goes out prepaid. A row with no stored `ref` (registered before refs existed)
 * must be searched for first, which costs an unknown number of calls, so that legacy case
 * releases without the lock, as before.
 */
export async function runProviderRelease(
  options: Pick<DomainJobsOptions, "db" | "log"> & {
    readonly provider: Pick<CustomDomainProviderPort, "deactivate" | "admit">;
  },
  job: ProviderReleaseJob,
): Promise<"released" | "in_use"> {
  const log = options.log ?? (() => {});
  const call = { workspaceId: job.workspaceId, priority: "background" as const };
  let outcome: "released" | "in_use";
  try {
    const ref = job.ref;
    if (ref !== undefined && ref !== "") {
      await options.provider.admit?.(call);
      outcome = await options.db.withHost(async (tx) => {
        await lockHostname(tx, job.hostname);
        if (await isHostnameHeld(tx, job.hostname)) return "in_use" as const;
        await options.provider.deactivate(job.hostname, ref, { ...call, admitted: true });
        return "released" as const;
      });
    } else {
      const held = await options.db.withHost((tx) => isHostnameHeld(tx, job.hostname));
      if (!held) await options.provider.deactivate(job.hostname, undefined, call);
      outcome = held ? "in_use" : "released";
    }
  } catch (error) {
    log("domains.provider_release_failed", {
      level: "warn",
      workspaceId: job.workspaceId,
      hostname: job.hostname,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (outcome === "in_use") {
    log("domains.provider_release_skipped", { hostname: job.hostname, domainId: job.domainId });
  } else {
    log("domains.provider_released", { workspaceId: job.workspaceId, hostname: job.hostname });
  }
  return outcome;
}

export function createDomainJobs(options: DomainJobsOptions): JobDefinition<JsonObject>[] {
  const provider = options.provider;
  const release: JobDefinition<JsonObject>[] =
    provider === undefined
      ? []
      : [
          {
            name: JOB_PROVIDER_RELEASE,
            // 12 retries backing off from a minute: about three days before it dead-letters.
            queue: {
              policy: "standard",
              retryLimit: 12,
              retryDelaySeconds: 60,
              retryBackoff: true,
              expireInSeconds: 5 * 60,
            },
            handler: async (job) => {
              await runProviderRelease(
                { db: options.db, log: options.log, provider },
                job.data as unknown as ProviderReleaseJob,
              );
            },
          },
        ];
  return [
    ...release,
    {
      name: JOB_VERIFY,
      cron: "*/5 * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 4 * 60 },
      handler: async (job) => {
        const only = (job.data as { workspaceId?: string }).workspaceId;
        await runVerifySweep(options, {
          ...(only === undefined ? {} : { workspaceId: only }),
          signal: job.signal,
        });
      },
    },
    {
      name: JOB_REVERIFY,
      // Weekly, Monday 04:40 UTC. Fixed by the contract; every nearby slot is taken.
      cron: "40 4 * * 1",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const only = (job.data as { workspaceId?: string }).workspaceId;
        await runReverifySweep(options, {
          ...(only === undefined ? {} : { workspaceId: only }),
          signal: job.signal,
        });
      },
    },
  ];
}
