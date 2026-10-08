import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  type OpenAPIHono,
  ops as o,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { DeadLetterJob, JsonValue } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { type CheckResult, safeMessage, withTimeout } from "../readiness.js";
import type { ApiDeps } from "./deps.js";

/*
 * Jobs, dead letters and health (E2.7): `GET /ops/jobs`, dead-letter retry and discard, and
 * `GET /ops/health` — the plan's `/admin/health/deep`. Contracts: `@fundroom/contracts` `ops`.
 *
 * Four decisions, each load-bearing:
 *
 *  1. **A dead letter belongs to the workspace its payload names.** The queue is shared by every
 *     tenant, so the only ownership fact is the job's own `data.workspaceId` (every event job the
 *     outbox relay dispatches carries it). The listing is filtered by it *in SQL*
 *     (`DeadLetterQueue.list({ workspaceId })`), and retry/discard read the job first and answer
 *     404 unless it names this workspace — in both tenancy modes, because on a single-tenant
 *     install a job without a workspace is instance work, not the owner's. A job that is not
 *     this workspace's and a job that does not exist read the same.
 *  2. **The payload never leaves the server.** Payloads are personal data (emails, names,
 *     document titles). A row carries its top-level keys, the event topic, outbox id and
 *     subscriber when it is an event job, and the error *message* (never the stack) cut to 2000
 *     characters.
 *  3. **Instance facts only on a single-tenant install.** Queue depths and the adapter checks
 *     describe everybody's traffic on a multi-tenant host, so they are reported only when
 *     `TENANCY_MODE=single` (`scope: "instance"`); the multi-tenant operator has `/readyz`, the
 *     metrics endpoint and `fundroom jobs dlq`.
 *  4. **Domain certificates are read, never trusted, and never on demand.** The probe
 *     (`cert-probe.ts`) is handed only this workspace's verified domains and caches per hostname,
 *     so the page cannot be used to make this server handshake with arbitrary hosts or to hammer
 *     the workspace's own.
 *
 * Discarding is irreversible, hence step-up; a retry only re-runs work that already ran.
 *
 * `GET /ops/update` (E2.9) follows decision 3: the version this install runs is an instance fact,
 * so it is answered only on a single-tenant install. A multi-tenant host answers `disabled` /
 * `multi_tenant` without touching the checker — no tenant admin can make the host fetch anything.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 429, 500, 503);
const TAGS = ["ops"];
const ERROR_MAX = 2000;

/** Failures here mean the instance cannot serve; anything else only degrades a feature. */
const CRITICAL = new Set(["db", "migrations", "queue", "storage"]);
const EXTRA_PROBE_TTL_MS = 60_000;
const EXTRA_PROBE_FAILURE_TTL_MS = 10_000;
const EXTRA_PROBE_TIMEOUT_MS = 5_000;

type Vars = AppEnv["Variables"];
interface Signed {
  readonly tenant: NonNullable<Vars["tenant"]>;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!tenant || !workspace || !c.get("session")) throw new ApiError("unauthenticated");
  return { tenant, workspace };
}

/** The error message only: pg-boss stores `{ message, stack }`, and a stack is not for a browser. */
export function errorMessageOf(error: JsonValue): string {
  let message: string;
  if (typeof error === "string") message = error;
  else if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const m = error["message"];
    message = typeof m === "string" ? m : JSON.stringify(error);
  } else message = error === null ? "" : JSON.stringify(error);
  return message.length > ERROR_MAX ? message.slice(0, ERROR_MAX) : message;
}

/** A dead letter as the page may see it: never the payload (decision 2). */
export function deadLetterItem(job: DeadLetterJob) {
  const data = job.data;
  const str = (v: JsonValue | undefined) =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  const topic = str(data["topic"]);
  const eventId = str(data["outboxId"]) ?? str(data["eventId"]);
  const subscriber = str(data["subscriber"]);
  return {
    id: job.id,
    sourceQueue: job.sourceQueue,
    failedAt: job.failedAt.toISOString(),
    retries: job.retries,
    error: errorMessageOf(job.error),
    dataKeys: Object.keys(data).sort(),
    ...(topic === undefined ? {} : { topic }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(subscriber === undefined ? {} : { subscriber }),
  };
}

const READINESS_NAMES: Readonly<Record<CheckResult["name"], string>> = {
  database: "db",
  migrations: "migrations",
  storage: "storage",
  mail: "mail",
  render: "render",
  queue: "queue",
  authzEngine: "authz_engine",
};

type HealthCheck = {
  name: string;
  status: "ok" | "degraded" | "down" | "skipped";
  detail: string | null;
  latencyMs: number | null;
};

/*
 * The noop scanner always answers "clean", so probing it would report a healthy scanner that
 * scans nothing (E2.10 F-11). Surface it as skipped, with the reason, on the health screen.
 */
export const NOOP_SCANNER_CHECK: HealthCheck = {
  name: "avscan",
  status: "skipped",
  detail:
    "AV_DRIVER=noop: uploads are not virus-scanned. Set AV_DRIVER=clamd; production refuses to start like this unless AV_ACCEPT_UNSCANNED=true.",
  latencyMs: null,
};

function statusFor(name: string, ok: "ok" | "fail" | "skipped"): HealthCheck["status"] {
  if (ok === "ok") return "ok";
  if (ok === "skipped") return "skipped";
  return CRITICAL.has(name) ? "down" : "degraded";
}

export function registerOpsAdminRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);

  // avscan and dns are not `/readyz` probes; cached here the same way readiness caches its slow ones.
  const extraCache = new Map<string, { check: HealthCheck; until: number }>();
  async function extraProbe(
    name: string,
    run: () => Promise<void>,
    driver: () => string,
  ): Promise<HealthCheck> {
    const hit = extraCache.get(name);
    if (hit !== undefined && hit.until > Date.now()) return hit.check;
    const started = performance.now();
    let check: HealthCheck;
    try {
      await withTimeout(run(), EXTRA_PROBE_TIMEOUT_MS, `${name} probe`);
      check = {
        name,
        status: "ok",
        detail: driver(),
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      check = {
        name,
        status: statusFor(name, "fail"),
        detail: safeMessage(error),
        latencyMs: Math.round(performance.now() - started),
      };
    }
    extraCache.set(name, {
      check,
      until: Date.now() + (check.status === "ok" ? EXTRA_PROBE_TTL_MS : EXTRA_PROBE_FAILURE_TTL_MS),
    });
    return check;
  }

  /** The job, when it exists and is this workspace's; otherwise the 404 either case gets. */
  async function ownDeadLetter(workspaceId: string, id: string): Promise<DeadLetterJob> {
    const job = await deps.jobs.deadLetters.get(id);
    if (job === null || job.data["workspaceId"] !== workspaceId) {
      throw new ApiError("not_found", "no such dead letter");
    }
    return job;
  }

  async function audit(
    c: Context<AppEnv>,
    s: Signed,
    action: "ops.dead_letter_retried" | "ops.dead_letter_discarded",
    job: DeadLetterJob,
  ): Promise<void> {
    const item = deadLetterItem(job);
    await deps.db.withTenant(s.tenant, (tx) =>
      deps.audit.record(tx, s.tenant, {
        action,
        resourceKind: "job",
        resourceId: job.id,
        requestId: requestIdOf(c),
        // Queue, topic and ids only; the payload and error text stay out of the chain.
        meta: {
          sourceQueue: item.sourceQueue,
          ...(item.topic === undefined ? {} : { topic: item.topic }),
          ...(item.eventId === undefined ? {} : { eventId: item.eventId }),
          ...(item.subscriber === undefined ? {} : { subscriber: item.subscriber }),
        },
      }),
    );
  }

  api.openapi(
    createRoute({
      method: "get",
      path: "/ops/jobs",
      tags: TAGS,
      summary: "Queue depths and this workspace's dead letters",
      description:
        'Dead letters are the jobs that exhausted their retries and whose payload names this workspace; the payload itself is never returned (`dataKeys` lists its keys). `queues` is filled only on a single-tenant install (`scope: "instance"`) — on a multi-tenant host queue depths are every customer\'s traffic.',
      security: sessionSecurity,
      "x-requires": "ops.read",
      middleware: [perm("ops.read")] as const,
      request: { query: o.OpsJobsQuery },
      responses: { 200: jsonResponse(o.OpsJobsSchema, "Jobs"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { limit } = c.req.valid("query");
      const single = deps.tenancy === "single";
      const filter = { workspaceId: s.workspace.id };
      const [count, items, queues] = await Promise.all([
        deps.jobs.deadLetters.count(filter),
        deps.jobs.deadLetters.list({ ...filter, limit }),
        single ? deps.jobs.stats() : Promise.resolve([]),
      ]);
      return c.json(
        {
          scope: single ? ("instance" as const) : ("workspace" as const),
          queues: queues.map((q) => ({
            name: q.name,
            queued: q.queued,
            active: q.active,
            failed: q.failed,
          })),
          deadLetters: { count, items: items.map(deadLetterItem) },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/ops/jobs/dead-letters/{id}/retry",
      tags: TAGS,
      summary: "Re-enqueue a dead letter on its source queue",
      description:
        "404 unless the dead letter exists and its payload names this workspace. Handlers are idempotent, so a retry of work that half-ran is safe.",
      security: sessionSecurity,
      "x-requires": "ops.manage",
      middleware: [perm("ops.manage")] as const,
      request: { params: o.DeadLetterIdParam },
      responses: { 204: { description: "Re-enqueued" }, ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const job = await ownDeadLetter(s.workspace.id, c.req.valid("param").id);
      if (!(await deps.jobs.deadLetters.retry(job.id))) {
        throw new ApiError("not_found", "no such dead letter");
      }
      await audit(c, s, "ops.dead_letter_retried", job);
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/ops/jobs/dead-letters/{id}",
      tags: TAGS,
      summary: "Discard a dead letter for good",
      description:
        "Irreversible, hence step-up. 404 unless the dead letter exists and its payload names this workspace.",
      security: sessionSecurity,
      "x-requires": "ops.manage+fresh",
      middleware: [perm("ops.manage", { fresh: true })] as const,
      request: { params: o.DeadLetterIdParam },
      responses: { 204: { description: "Discarded" }, ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const job = await ownDeadLetter(s.workspace.id, c.req.valid("param").id);
      if (!(await deps.jobs.deadLetters.discard(job.id))) {
        throw new ApiError("not_found", "no such dead letter");
      }
      await audit(c, s, "ops.dead_letter_discarded", job);
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/ops/health",
      tags: TAGS,
      summary: "Deep health: adapter checks and this workspace's domain certificates",
      description:
        "`checks` (database, migrations, queue, storage, mail, render, virus scanner, DNS resolver) are reported only on a single-tenant install; the slow probes are cached for a minute, as `/readyz` caches them. `domains` lists this workspace's custom domains; only verified ones (`dns_ok`, `active`) are contacted — a TLS handshake with SNI, 3-second timeout, results cached five minutes. An invalid certificate is still read, so its expiry can be shown, and reported as `invalid`.",
      security: sessionSecurity,
      "x-requires": "ops.read",
      middleware: [perm("ops.read")] as const,
      responses: { 200: jsonResponse(o.OpsHealthSchema, "Health"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const single = deps.tenancy === "single";
      const checksP: Promise<HealthCheck[]> = single
        ? (async () => {
            const [ready, avscan, dns] = await Promise.all([
              deps.readiness.run(),
              deps.scanner.driver === "noop"
                ? Promise.resolve(NOOP_SCANNER_CHECK)
                : extraProbe(
                    "avscan",
                    () => deps.scanner.healthCheck(),
                    () => deps.scanner.driver,
                  ),
              extraProbe(
                "dns",
                () => deps.dns.healthCheck(),
                () => deps.dns.driver,
              ),
            ]);
            return [
              ...ready.checks.map((r): HealthCheck => {
                const name = READINESS_NAMES[r.name] ?? r.name;
                return {
                  name,
                  status: statusFor(name, r.status),
                  detail: r.detail ?? null,
                  latencyMs: r.latencyMs ?? null,
                };
              }),
              avscan,
              dns,
            ];
          })()
        : Promise.resolve([]);
      const domainsP = (async () => {
        const rows = await deps.domains.list(s.tenant);
        const verified = rows
          .filter((d) => d.status === "dns_ok" || d.status === "active")
          .map((d) => d.hostname);
        const probed = new Map(
          (await deps.certProbe.probe(verified)).map((r) => [r.hostname, r] as const),
        );
        return rows.map((d) => {
          const r = verified.includes(d.hostname) ? probed.get(d.hostname) : undefined;
          return {
            hostname: d.hostname,
            status: d.status,
            certStatus: r?.status ?? ("not_checked" as const),
            certExpiresAt: r?.expiresAt?.toISOString() ?? null,
            certIssuer: r?.issuer ?? null,
            certError: r?.error ?? null,
            checkedAt: r?.checkedAt.toISOString() ?? null,
          };
        });
      })();
      const [checks, domains] = await Promise.all([checksP, domainsP]);
      return c.json(
        { scope: single ? ("instance" as const) : ("workspace" as const), checks, domains },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/ops/update",
      tags: TAGS,
      summary: "Whether a newer FundRoom release is available",
      description:
        "Compares the running version with the release index (`UPDATE_CHECK_URL`, a static file; the request carries no identifiers, query string or cookies). Fetched on demand and cached in-process: 12 hours after a success, 1 hour after a failure. Answered only on a single-tenant install; a multi-tenant host returns `disabled` with `reason: multi_tenant` and fetches nothing. `UPDATE_CHECK=false` returns `disabled` with `reason: opted_out`. Never updates anything.",
      security: sessionSecurity,
      "x-requires": "ops.read",
      middleware: [perm("ops.read")] as const,
      responses: { 200: jsonResponse(o.UpdateStatusSchema, "Update status"), ...ERRORS },
    }),
    async (c) => {
      signed(c);
      const checker = deps.updateChecker;
      if (deps.tenancy !== "single") {
        return c.json(
          {
            status: "disabled" as const,
            reason: "multi_tenant" as const,
            currentVersion: checker.currentVersion,
          },
          200,
        );
      }
      const status = await checker.check();
      return c.json(
        {
          status: status.status,
          currentVersion: status.currentVersion,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          ...(status.latestVersion === undefined ? {} : { latestVersion: status.latestVersion }),
          ...(status.checkedAt === undefined ? {} : { checkedAt: status.checkedAt }),
          ...(status.releaseUrl === undefined ? {} : { releaseUrl: status.releaseUrl }),
          ...(status.securityReleases === undefined
            ? {}
            : { securityReleases: [...status.securityReleases] }),
        },
        200,
      );
    },
  );
}
