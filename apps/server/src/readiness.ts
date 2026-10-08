import { timingSafeEqual } from "node:crypto";
import {
  coreMigrationSource,
  type Database,
  type MigrationSource,
  migrationStatus,
} from "@fundroom/db";
import { edgeForwardedOf } from "@fundroom/http";
import type {
  DocumentRenderPort,
  JobQueuePort,
  MailerPort,
  ObjectStoragePort,
} from "@fundroom/ports";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/*
 * `/readyz` (§9.4 step 4, design/07 §5): database ping, migrations current, storage
 * reachable, mail reachable, queue reachable, renderer able to find a font. Storage, mail and
 * render are probed at most once a
 * minute and a success is remembered ("passed once") so a transient SMTP hiccup does not
 * take the node out of rotation; the database and the queue are checked every time.
 * Returns 503 while draining so the load balancer stops sending traffic before the
 * listener closes.
 */
export type CheckName =
  | "database"
  | "migrations"
  | "storage"
  | "mail"
  | "queue"
  | "render"
  | "authzEngine";
export interface CheckResult {
  readonly name: CheckName;
  readonly status: "ok" | "fail" | "skipped";
  readonly detail?: string;
  readonly checkedAt: string;
  readonly latencyMs?: number;
}

export interface ReadinessOptions {
  readonly db: Database;
  readonly storage: ObjectStoragePort;
  readonly mailer: MailerPort;
  readonly queue: JobQueuePort;
  /**
   * Probed because the renderer can fail in a way nothing else notices (E2.4). Its watermark
   * path rasterises text through librsvg, which needs a font on the host; the runtime image is
   * distroless, so a build that drops the font layer renders every glyph as an empty box and
   * says nothing. Page renditions keep being produced, keep being cached, and keep looking
   * watermarked. `healthCheck()` compares each probe glyph against a code point no font can
   * have, and a guard nothing calls is not a guard.
   *
   * Reporting it here is the *second* line, not the only one: nothing in the shipped
   * deployment polls `/readyz`, so the load-bearing call is `assertBootInvariants` below,
   * which refuses to let the process listen at all. See its comment.
   */
  readonly renderer: DocumentRenderPort;
  readonly migrationSources: readonly MigrationSource[];
  /**
   * E3.13: the external relationship engine (AUTHZ_ENGINE=openfga), if any. In `enforce` mode it
   * is a gate — every external check depends on it and fails closed without it — probed on every
   * run like the database; in `shadow` mode it is reported but never makes the node unready.
   */
  readonly authzEngine?:
    | {
        readonly driver: string;
        readonly mode: "shadow" | "enforce";
        healthCheck(): Promise<void>;
      }
    | null
    | undefined;
  /** Cache TTL for the slow probes. Default 60 s. */
  readonly probeTtlMs?: number | undefined;
  /**
   * Ceiling on every individual probe. Default 5 s.
   *
   * Not optional in practice: without it a dependency that *hangs* rather than fails — a socket
   * to a black-holed host, a WASM init that never settles — hangs `/readyz`, and the connection
   * with it, for as long as the prober is willing to wait. A probe that never answers is the
   * one case a readiness endpoint exists to report, so a timeout is a `fail` with a detail
   * saying so, not a pending promise. The underlying call is abandoned, not cancelled (none of
   * the ports takes an `AbortSignal`); it is left to settle into a promise nothing awaits.
   */
  readonly probeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface Readiness {
  run(): Promise<{ ready: boolean; checks: CheckResult[] }>;
  setDraining(): void;
  readonly draining: boolean;
  /** The setup wizard's deeper probe succeeded: prime the cache and remember it (§9.4 step 4). */
  markPassed(name: "storage" | "mail", detail?: string): void;
  /** Whether `name` has passed at least once in this process (cache or wizard). */
  passed(name: "storage" | "mail"): boolean;
}

/**
 * What an unauthenticated `/readyz` caller sees (E2.10 F-31): the overall status and each
 * check's name and verdict — enough for a load balancer, an uptime monitor and an operator's
 * first glance — but no `detail` (driver errors, host names), latencies or timestamps. The full
 * body goes to loopback callers (not behind TRUST_PROXY) and to a bearer of METRICS_TOKEN; see
 * `app.ts`.
 */
export function publicReadinessBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { status, version, checks } = body as {
    status?: unknown;
    version?: unknown;
    checks?: unknown;
  };
  return {
    status,
    version,
    checks: Array.isArray(checks)
      ? checks.map((c) => {
          const { name, status: s } = (c ?? {}) as { name?: unknown; status?: unknown };
          return { name, status: s };
        })
      : [],
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * May this caller see `/readyz` in full? A bearer of METRICS_TOKEN, or a loopback socket (the
 * container's own probes, `curl` on the host) — but only when no proxy can be in front: with
 * TRUST_PROXY=true a reverse proxy on the same host (nginx/Caddy → 127.0.0.1:3000) or a mesh
 * sidecar (Istio/Linkerd) makes every internet request arrive from loopback (review R2-04). A
 * request carrying forwarding headers is never treated as local either.
 */
function readinessDetailAllowed(
  c: Context,
  metricsToken: string | undefined,
  trustProxy: boolean,
): boolean {
  const forwarded =
    c.req.header("x-forwarded-for") !== undefined ||
    c.req.header("forwarded") !== undefined ||
    edgeForwardedOf(c) !== undefined;
  if (!trustProxy && !forwarded) {
    try {
      if (isLoopbackAddress(getConnInfo(c).remote.address)) return true;
    } catch {
      // no socket (app.request in tests): fall through to the token
    }
  }
  const header = c.req.header("authorization");
  if (metricsToken === undefined || header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(metricsToken);
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface ReadinessDetailGuardOptions {
  /** TRUST_PROXY: a proxy may sit in front, so a loopback peer proves nothing. */
  readonly trustProxy?: boolean;
}

/**
 * Wraps `GET /readyz` (mounted ahead of the ops routes in `app.ts`) and rewrites its JSON body to
 * `publicReadinessBody` unless `readinessDetailAllowed`. The status code is untouched, so load
 * balancers and probes see exactly what they saw before.
 */
export function readinessDetailGuard(
  metricsToken: string | undefined,
  options: ReadinessDetailGuardOptions = {},
): MiddlewareHandler {
  const trustProxy = options.trustProxy ?? false;
  return async (c, next) => {
    await next();
    if (readinessDetailAllowed(c, metricsToken, trustProxy)) return;
    if (!(c.res.headers.get("content-type") ?? "").includes("application/json")) return;
    const body: unknown = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    if (body === undefined) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(publicReadinessBody(body)), {
      status: c.res.status,
      headers,
    });
  };
}

export function safeMessage(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  // Never leak a connection string or credentials from a driver error.
  return m.replace(/\/\/[^@\s]+@/gu, "//***@").slice(0, 200);
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Resolves with `promise`, or rejects when `ms` elapses first. `Promise.race` keeps a reaction
 * attached to `promise`, so a rejection arriving after the timeout is still observed and never
 * surfaces as an unhandled rejection; the timer is cleared either way and is unref'd so a
 * pending probe cannot hold the process open during shutdown.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Boot-time assertion for the one readiness property that is **static for the life of the
 * image**: the renderer can find a font (E2.4 §12 C1, finding 5).
 *
 * It is checked here, once, rather than only reported by `/readyz`, because of where the
 * probes are actually consumed. The container `HEALTHCHECK` and Caddy's upstream health check
 * both poll `/healthz` — liveness — and neither may be repointed at `/readyz` without turning
 * a recoverable Postgres, SMTP or S3 outage into a container restart storm or an empty
 * upstream pool. So a fontless image would answer 200 to every gate it is actually asked,
 * stay in rotation, and go on compositing blank watermarks: exactly the pre-fix state, which
 * is the state this whole layer exists to end. A font cannot appear or disappear while the
 * process runs — the files are baked into the image and the root filesystem is read-only — so
 * the honest place to check it is once, before the listener opens, where the failure is a
 * non-zero exit with the reason on stderr and a container an operator can see restarting.
 * `/readyz` keeps reporting it as well, for the operator who is already looking there.
 */
export async function assertBootInvariants(options: {
  readonly renderer: DocumentRenderPort;
  readonly timeoutMs?: number | undefined;
}): Promise<void> {
  await withTimeout(
    options.renderer.healthCheck(),
    options.timeoutMs ?? 15_000,
    "renderer boot check",
  );
}

export function createReadiness(options: ReadinessOptions): Readiness {
  const now = options.now ?? (() => new Date());
  const ttl = options.probeTtlMs ?? 60_000;
  const probeTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const cache = new Map<CheckName, { result: CheckResult; until: number }>();
  const passedOnce = new Set<CheckName>();
  let draining = false;

  async function timed(
    name: CheckName,
    fn: () => Promise<string | undefined>,
  ): Promise<CheckResult> {
    const started = performance.now();
    const at = now().toISOString();
    try {
      const detail = await withTimeout(fn(), probeTimeout, `${name} probe`);
      return {
        name,
        status: "ok",
        ...(detail === undefined ? {} : { detail }),
        checkedAt: at,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        name,
        status: "fail",
        detail: safeMessage(error),
        checkedAt: at,
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }

  async function cached(
    name: CheckName,
    fn: () => Promise<string | undefined>,
  ): Promise<CheckResult> {
    const hit = cache.get(name);
    const t = now().getTime();
    if (hit !== undefined && hit.until > t) return hit.result;
    const result = await timed(name, fn);
    if (result.status === "ok") passedOnce.add(name);
    // Failures are retried sooner so recovery is noticed quickly.
    cache.set(name, { result, until: t + (result.status === "ok" ? ttl : Math.min(ttl, 10_000)) });
    return result;
  }

  return {
    get draining() {
      return draining;
    },
    setDraining() {
      draining = true;
    },
    markPassed(name, detail) {
      passedOnce.add(name);
      cache.set(name, {
        result: {
          name,
          status: "ok",
          ...(detail === undefined ? {} : { detail }),
          checkedAt: now().toISOString(),
        },
        until: now().getTime() + ttl,
      });
    },
    passed(name) {
      return passedOnce.has(name);
    },
    async run() {
      const checks: CheckResult[] = [];
      checks.push(
        await timed("database", async () => {
          if (!(await options.db.ping())) throw new Error("ping failed");
          return undefined;
        }),
      );
      const dbOk = checks[0]?.status === "ok";
      checks.push(
        dbOk
          ? await cached("migrations", async () => {
              const plan = await migrationStatus(options.db.pool, [
                coreMigrationSource,
                ...options.migrationSources,
              ]);
              if (plan.problems.length > 0)
                throw new Error(
                  `journal problems: ${plan.problems.map((p) => `${p.module}/${p.name}`).join(", ")}`,
                );
              if (plan.steps.length > 0)
                throw new Error(`${plan.steps.length} pending migration(s)`);
              return `${plan.appliedCount} applied`;
            })
          : {
              name: "migrations",
              status: "skipped",
              detail: "database down",
              checkedAt: now().toISOString(),
            },
      );
      checks.push(
        await cached("storage", async () => {
          await options.storage.healthCheck();
          return options.storage.driver;
        }),
      );
      checks.push(
        await cached("mail", async () => {
          await options.mailer.healthCheck();
          return options.mailer.driver;
        }),
      );
      checks.push(
        await cached("render", async () => {
          await options.renderer.healthCheck();
          return options.renderer.driver;
        }),
      );
      checks.push(
        dbOk
          ? await timed("queue", async () => {
              const stats = await options.queue.stats();
              return `${stats.length} queue(s)`;
            })
          : {
              name: "queue",
              status: "skipped",
              detail: "database down",
              checkedAt: now().toISOString(),
            },
      );
      const engine = options.authzEngine;
      if (engine !== undefined && engine !== null) {
        const probe = async () => {
          await engine.healthCheck();
          return `${engine.driver} (${engine.mode})`;
        };
        checks.push(
          engine.mode === "enforce"
            ? await timed("authzEngine", probe)
            : await cached("authzEngine", probe),
        );
      }
      // Shadow mode reports the engine but never gates on it.
      const gating = checks.filter(
        (c) => c.name !== "authzEngine" || options.authzEngine?.mode === "enforce",
      );
      return { ready: !draining && gating.every((c) => c.status === "ok"), checks };
    },
  };
}
