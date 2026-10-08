import type { Server as HttpServer } from "node:http";
import { type AppConfig, configWarnings } from "@fundroom/config";
import { coreMigrationSource, createDatabase, runMigrations } from "@fundroom/db";
import type { ModuleManifest } from "@fundroom/module-kit";
import type {
  AccreditationVerificationPort,
  AuditSinkPort,
  ChatWebhookPort,
  DnsResolverPort,
  MailerPort,
  SpreadsheetPort,
} from "@fundroom/ports";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type Container, type ContainerOptions, createContainer } from "./container.js";
import { createLogger, type Logger, logHook } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { canonicalBaseOf } from "./path-mount.js";
import { assertBootInvariants, createReadiness, type Readiness, safeMessage } from "./readiness.js";
import { checkDataRegion } from "./residency/boot.js";
import { migrateDirectoryDatabase } from "./residency/directory-jobs.js";
import type { AccreditationCallbackBudget } from "./routes/accreditation-callback.js";
import type { ESignCallbackBudget } from "./routes/esign-callback.js";
import type { IntegrationWebhookBudget } from "./routes/integrations-webhook.js";
import { setupTokenBanner } from "./setup/token.js";
import { waitForDatabase } from "./setup/wait-db.js";
import { startTelemetry, type Telemetry } from "./telemetry.js";
import { SERVER_VERSION } from "./version.js";

/*
 * Process lifecycle (design/07 §6.2): migrate (when MIGRATE_ON_START), start the container,
 * listen; on SIGTERM flip readiness to 503, stop accepting, drain requests within the
 * shutdown budget, stop the queue gracefully, close pools.
 */
export interface StartOptions {
  readonly config: AppConfig;
  readonly logger?: Logger | undefined;
  readonly modules?: readonly ModuleManifest[] | undefined;
  readonly auditSinks?: readonly AuditSinkPort[] | undefined;
  readonly mailer?: MailerPort | undefined;
  /** Test seam: replace the DNS resolver, so no test reaches a real DoH endpoint. */
  readonly dns?: DnsResolverPort | undefined;
  /** Test seam for the Google Sheets adapter, mirroring `dns` (E2.4). */
  readonly spreadsheets?: SpreadsheetPort | undefined;
  /** Test seam for the accreditation verifier, mirroring `spreadsheets` (E2.5). */
  readonly accreditation?: AccreditationVerificationPort | undefined;
  /** Test seam for the chat webhook adapter, so no test posts to Slack (E2.6). */
  readonly chat?: ChatWebhookPort | undefined;
  /** Test seam (E3.5): e-sign vendor adapters by driver (see `ContainerOptions.esignAdapters`). */
  readonly esignAdapters?: ContainerOptions["esignAdapters"];
  /** Test seam (E3.6): integration adapter factories by provider (see `ContainerOptions.integrationAdapters`). */
  readonly integrationAdapters?: ContainerOptions["integrationAdapters"];
  /** Test seam (E3.7): accreditation vendor adapters by driver (see `ContainerOptions.accreditationAdapters`). */
  readonly accreditationAdapters?: ContainerOptions["accreditationAdapters"];
  /** Test seam (E3.7): vendor API base URLs by driver (see `ContainerOptions.accreditationApiBaseUrls`). */
  readonly accreditationApiBaseUrls?: ContainerOptions["accreditationApiBaseUrls"];
  /** Test seam (E3.12): the AI model port (see `ContainerOptions.aiModel`). */
  readonly aiModel?: ContainerOptions["aiModel"];
  /** Test seam (E3.13): the audit anchor drivers (see `ContainerOptions.auditAnchorDrivers`). */
  readonly auditAnchorDrivers?: ContainerOptions["auditAnchorDrivers"];
  /** Test seam (E3.7): the accreditation callback route's budgets (`routes/accreditation-callback.ts`). */
  readonly accreditationCallbackBudget?: AccreditationCallbackBudget | undefined;
  /** Test seam (E3.5): the vendor callback route's per-minute budgets (`routes/esign-callback.ts`). */
  readonly esignCallbackBudget?: ESignCallbackBudget | undefined;
  /** Test seam (E3.6): the booking webhook route's per-minute budgets (`routes/integrations-webhook.ts`). */
  readonly integrationWebhookBudget?: IntegrationWebhookBudget | undefined;
  /** Test seam: the container's clock (rate limits, sessions, jobs). Defaults to wall time. */
  readonly now?: (() => Date) | undefined;
  /** Bind here instead of config `HOST`/`PORT` (tests pass 0 for an ephemeral port). */
  readonly listen?: { readonly host?: string; readonly port?: number } | undefined;
  /** Skip `serve()` and only build the app (tests call `app.request`). */
  readonly listenEnabled?: boolean | undefined;
  readonly migrate?: boolean | undefined;
  /** Print the setup-token banner when setup is required (off in tests). Default true. */
  readonly announceSetup?: boolean | undefined;
}

export interface RunningServer {
  readonly container: Container;
  readonly readiness: Readiness;
  readonly telemetry: Telemetry;
  readonly app: ReturnType<typeof createApp>;
  readonly server: HttpServer | undefined;
  readonly port: number | undefined;
  stop(): Promise<void>;
}

export async function migrate(
  config: AppConfig,
  logger: Logger,
  modules: readonly ModuleManifest[],
  options: { readonly directory?: "best-effort" | "required" | undefined } = {},
): Promise<void> {
  const { createModuleRegistry } = await import("@fundroom/module-kit");
  const registry = createModuleRegistry(modules, { only: config.modules });
  const log = logHook(logger, "migrate");
  if (config.raw.DATABASE_WAIT_TIMEOUT_MS > 0) {
    await waitForDatabase({
      connectionString: config.raw.DATABASE_URL,
      timeoutMs: config.raw.DATABASE_WAIT_TIMEOUT_MS,
      log,
    });
  }
  // The runner needs the raw pool (table-owner connection); nothing else in the server does.
  const db = createDatabase({ connectionString: config.raw.DATABASE_URL, poolMax: 2 });
  try {
    const result = await runMigrations(db.pool, {
      sources: [coreMigrationSource, ...registry.migrationSources],
      log: (line) => log("migrate.progress", { line }),
    });
    log("migrate.done", {
      applied: result.applied.map((a) => `${a.module}/${a.name}`),
      fencedTables: result.fencedTables,
    });
  } finally {
    await db.close();
  }
  // E3.11: the shared cell directory has its own database and its own migration source. Every
  // cell runs it (the runner's advisory lock and journal live in the directory database, so
  // concurrent cells serialise and apply each file once). At boot an UNREACHABLE directory is
  // skipped with a loud error (R2-2: a directory outage must not stop a cell from serving its own
  // tenants — nor a deploy's `fundroom migrate` hook); `fundroom directory migrate` is the strict one.
  const directoryUrl = config.raw.DIRECTORY_DATABASE_URL;
  if (directoryUrl !== undefined) {
    await migrateDirectoryDatabase({
      url: directoryUrl,
      mode: options.directory ?? "best-effort",
      log,
    });
  }
}

/*
 * E-UP-10: a start that fails must reject with nothing left running, so `fundroom serve` exits
 * non-zero and the platform restarts it. Once the container exists its pools are open and, after
 * `container.start()` began, pg-boss's timers and workers run too; the OTel SDK runs from the
 * first line. Any of those left behind keeps the event loop alive, and "refuses to start" becomes
 * "hangs having printed an error": no health check passes and no restart fires.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const started: StartedSoFar = {};
  try {
    return await startServerSteps(options, started);
  } catch (error) {
    await releaseAfterFailedStart(started, error);
    throw error;
  }
}

/** What a start has opened so far, for `releaseAfterFailedStart` to undo. */
interface StartedSoFar {
  telemetry?: Telemetry;
  container?: Container;
  server?: HttpServer;
  log?: ReturnType<typeof logHook>;
  budgetMs?: number;
}

async function startServerSteps(
  options: StartOptions,
  started: StartedSoFar,
): Promise<RunningServer> {
  const { config } = options;
  const raw = config.raw;
  const logger =
    options.logger ??
    createLogger({ level: raw.LOG_LEVEL, service: raw.OTEL_SERVICE_NAME, version: SERVER_VERSION });
  const log = logHook(logger, "server");
  started.log = log;
  started.budgetMs = raw.SHUTDOWN_TIMEOUT_MS;
  const modules = options.modules ?? COMPILED_IN_MODULES;

  const telemetry = startTelemetry({
    serviceName: raw.OTEL_SERVICE_NAME,
    serviceVersion: SERVER_VERSION,
    otlpEndpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  started.telemetry = telemetry;

  // Configurations that load but silently break something outside the app (`fundroom doctor`
  // prints the same list). They are warnings, not `crossFieldRules` errors, because each one
  // is a supported deployment whose other half lives in a file the app does not read — and a
  // warning nobody sees at boot is the trap these exist to close.
  for (const warning of configWarnings(config)) {
    log("config.warning", { level: "warn", key: warning.key, message: warning.message });
  }

  if (options.migrate ?? raw.MIGRATE_ON_START) await migrate(config, logger, modules);

  const container = createContainer({
    config,
    logger,
    modules,
    auditSinks: options.auditSinks,
    mailer: options.mailer,
    dns: options.dns,
    spreadsheets: options.spreadsheets,
    accreditation: options.accreditation,
    chat: options.chat,
    esignAdapters: options.esignAdapters,
    integrationAdapters: options.integrationAdapters,
    accreditationAdapters: options.accreditationAdapters,
    accreditationApiBaseUrls: options.accreditationApiBaseUrls,
    aiModel: options.aiModel,
    auditAnchorDrivers: options.auditAnchorDrivers,
    now: options.now,
  });
  started.container = container;
  const readiness = createReadiness({
    db: container.db,
    storage: container.storage,
    mailer: container.mailer,
    queue: container.queue,
    renderer: container.renderer,
    migrationSources: container.registry.migrationSources,
    authzEngine: container.authzEngine,
  });
  /*
   * Refuse to start rather than start broken (E2.4 finding 5). The renderer's font guard is the
   * only readiness check whose subject is fixed when the image is built, and the deployment
   * polls `/healthz`, never `/readyz` — so reporting it there alone would let a fontless image
   * serve blank data-room watermarks indefinitely with every health gate green. Thrown before
   * the queue starts and before the listener opens; `fundroom serve` exits non-zero and the
   * container restarts in a loop an operator can see, with the cause on stderr.
   */
  try {
    await assertBootInvariants({ renderer: container.renderer });
    // E3.11: placeholder cells adopt DATA_REGION; a contradicting region refuses prod-like boots.
    await checkDataRegion({ ...container, raw, log, keyRing: config.keyRing });
  } catch (error) {
    // The pools are already open; `startServer` releases them (and the rest) on the way out.
    log("server.boot_check_failed", { level: "error", error: safeMessage(error) });
    throw error;
  }
  const startedAt = Date.now();
  await container.start();
  const app = createApp({
    container,
    readiness,
    telemetry,
    startedAt,
    esignCallbackBudget: options.esignCallbackBudget,
    accreditationCallbackBudget: options.accreditationCallbackBudget,
    integrationWebhookBudget: options.integrationWebhookBudget,
  });

  if ((options.announceSetup ?? true) && (await container.setupGate.required())) {
    const token = container.setupToken;
    log("setup.required", { level: "warn", tokenSource: token.source, path: token.path });
    // The token goes to stderr as plain text, not through pino: log shippers redact `token`
    // fields, and the operator needs to read it.
    process.stderr.write(setupTokenBanner(token, `${canonicalBaseOf(config.baseUrl)}/setup`));
  }

  let server: HttpServer | undefined;
  let port: number | undefined;
  if (options.listenEnabled ?? true) {
    const host = options.listen?.host ?? raw.HOST;
    const wantPort = options.listen?.port ?? raw.PORT;
    // A bind failure (EADDRINUSE, EACCES) arrives as the server's 'error' event; without a
    // listener it is an uncaught exception that skips every cleanup.
    server = await new Promise<HttpServer>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: host, port: wantPort }, (info) => {
        port = info.port;
        s.off("error", reject);
        resolve(s as HttpServer);
      });
      started.server = s as HttpServer;
      s.once("error", reject);
    });
    log("server.listening", {
      host,
      port,
      baseUrl: config.baseUrl.href,
      roles: [...config.roles],
      version: SERVER_VERSION,
    });
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      readiness.setDraining();
      log("server.draining", { budgetMs: raw.SHUTDOWN_TIMEOUT_MS });
      if (server) {
        const s = server;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            s.closeAllConnections();
            resolve();
          }, raw.SHUTDOWN_TIMEOUT_MS);
          s.close(() => {
            clearTimeout(timer);
            resolve();
          });
          s.closeIdleConnections();
        });
      }
      await container.stop();
      await telemetry.shutdown();
      log("server.stopped");
    })();
    return stopping;
  };

  return {
    container,
    readiness,
    telemetry,
    app,
    get server() {
      return server;
    },
    get port() {
      return port;
    },
    stop,
  };
}

/**
 * Undoes a start that threw part-way (E-UP-10), within one overall budget and without letting
 * a cleanup error mask the start error.
 */
async function releaseAfterFailedStart(o: StartedSoFar, cause: unknown): Promise<void> {
  const log = o.log ?? (() => {});
  // One budget for the whole release, not one per step: a platform that waits
  // SHUTDOWN_TIMEOUT_MS for a stop waits no longer for a failed start.
  const budgetMs = o.budgetMs ?? 25_000;
  // The OTel SDK goes last and gets its own slice, so a slow container stop cannot eat it all.
  const telemetrySliceMs = Math.min(2_000, Math.floor(budgetMs / 4));
  const deadline = Date.now() + budgetMs;
  log("server.start_failed", { level: "error", error: safeMessage(cause) });
  const step = async (
    name: string,
    run: () => Promise<unknown>,
    reserveMs = telemetrySliceMs,
  ): Promise<void> => {
    const remainingMs = deadline - reserveMs - Date.now();
    if (remainingMs <= 0) {
      log("server.start_cleanup_timeout", { level: "error", step: name, budgetMs, skipped: true });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log("server.start_cleanup_timeout", { level: "error", step: name, budgetMs });
        resolve();
      }, remainingMs);
      timer.unref();
    });
    await Promise.race([
      run().catch((error: unknown) =>
        log("server.start_cleanup_failed", {
          level: "error",
          step: name,
          error: safeMessage(error),
        }),
      ),
      expired,
    ]);
    clearTimeout(timer);
  };
  const { container, server, telemetry } = o;
  if (server?.listening) {
    await step(
      "listener",
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
  }
  // `container.stop()` is safe after a partial start: relay, then queue, then everything else.
  if (container !== undefined) await step("container", () => container.stop());
  if (telemetry !== undefined) await step("telemetry", () => telemetry.shutdown(), 0);
}

/** Wires SIGTERM/SIGINT to a graceful stop; resolves when the process should exit. */
export function installSignalHandlers(running: RunningServer, logger: Logger): Promise<void> {
  const log = logHook(logger, "server");
  return new Promise((resolve) => {
    let called = false;
    const onSignal = (signal: string) => {
      if (called) return;
      called = true;
      log("server.signal", { signal });
      running.stop().then(resolve, (error: unknown) => {
        log("server.stop_failed", { level: "error", error: String(error) });
        resolve();
      });
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  });
}
