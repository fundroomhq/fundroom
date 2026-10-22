import type { ScanInput, ScanResult, VirusScanPort } from "@fundroom/ports";
import {
  type Counter,
  type Histogram,
  metrics,
  type ObservableGauge,
  type ObservableResult,
} from "@opentelemetry/api";
import type { Log } from "./logger.js";
import { countSecurityEvent } from "./middleware/security-events.js";

/*
 * Virus-scan signals (E-UP-25). Every scan, whoever runs it (data-room ingest, e-sign artifact
 * collection, round evidence), is counted and timed here, so a scanner that fails, slows down or
 * starts flagging files shows on the dashboards rather than only in a blob row.
 *
 * Two gauges answer the questions nothing else does: is clamd answering (`fundroom.avscan.up`)
 * and how old are its signatures (`fundroom.avscan.signature_age_seconds`, from `VERSION`), so
 * failing signature updates finally page someone. They exist only with `AV_DRIVER=clamd` (the
 * noop scanner has neither), are refreshed by an unref'd timer, and their callbacks read the
 * cache: a metrics scrape never touches the scanner. `/platform/health` reads the same cache.
 */

export const AVSCAN_METER = "fundroom.avscan";
const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** The cached scanner probe: `skipped` for the noop scanner, which has nothing to probe. */
export interface AvscanHealth {
  readonly status: "ok" | "fail" | "skipped";
  readonly driver: string;
  readonly detail?: string | undefined;
  /** When the probe last ran; undefined before the first one finished. */
  readonly checkedAt?: Date | undefined;
  readonly signatureDate?: Date | undefined;
}

export interface AvscanSignalsOptions {
  readonly log?: Log | undefined;
  /** Register the gauges and probe on `start()`. The container sets it for clamd only. */
  readonly probe?: boolean | undefined;
  /** Default 60 s. */
  readonly refreshMs?: number | undefined;
  /** Default 5 s. */
  readonly probeTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface AvscanSignals {
  /** The scanner to hand out: same port, every scan counted and timed. */
  readonly scanner: VirusScanPort;
  /** The last probe result (no I/O). */
  health(): AvscanHealth;
  /** Probes now and updates the cache (also what the timer runs). Never throws. */
  refresh(): Promise<AvscanHealth>;
  /** Probes now and then every `refreshMs` (unref'd); no-op without `probe` or once stopped. */
  start(): void;
  /** Stops the refresh timer and the gauges. Idempotent. */
  stop(): void;
}

/** Same rule as the security-event labels: short snake/kebab tokens, anything else `other`. */
function label(value: string | undefined): string {
  if (value === undefined) return "none";
  return /^[a-z][a-z0-9_.-]{0,47}$/u.test(value) ? value : "other";
}

interface Instruments {
  readonly scans: Counter;
  readonly duration: Histogram;
  readonly errors: Counter;
}

let instruments: Instruments | undefined;
/** Lazily, so they bind to the meter provider the process installed before the first scan. */
function instrumentsOf(): Instruments {
  if (instruments !== undefined) return instruments;
  const meter = metrics.getMeter(AVSCAN_METER);
  instruments = {
    scans: meter.createCounter("fundroom.avscan.scans", {
      description: "Virus scans by verdict and by who asked (data-room, esign, round)",
    }),
    duration: meter.createHistogram("fundroom.avscan.duration", {
      unit: "s",
      description: "Virus scan duration by verdict and source",
      advice: {
        explicitBucketBoundaries: [
          0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1500,
        ],
      },
    }),
    errors: meter.createCounter("fundroom.avscan.errors", {
      description:
        "Scans that ended in error, by reason: too_large, partial (final) or unavailable, timeout (retried)",
    }),
  };
  return instruments;
}

/** Health of the instrumented scanners by the scanner object handed out (for `/platform/health`). */
const registry = new WeakMap<VirusScanPort, () => AvscanHealth>();

/** The cached probe for a scanner built by {@link instrumentScanner}; null for any other. */
export function avscanHealthOf(scanner: VirusScanPort): AvscanHealth | null {
  return registry.get(scanner)?.() ?? null;
}

function withTimeout<T>(run: () => Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function instrumentScanner(
  inner: VirusScanPort,
  options: AvscanSignalsOptions = {},
): AvscanSignals {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probing = options.probe === true;
  let cached: AvscanHealth = probing
    ? { status: "fail", driver: inner.driver, detail: "not probed yet" }
    : { status: "skipped", driver: inner.driver };

  const scanner: VirusScanPort = {
    driver: inner.driver,
    maxScanBytes: inner.maxScanBytes,
    healthCheck: () => inner.healthCheck(),
    info: () => inner.info(),
    async scan(input: ScanInput): Promise<ScanResult> {
      const started = process.hrtime.bigint();
      const source = label(input.source);
      let result: ScanResult;
      try {
        result = await inner.scan(input);
      } catch (error) {
        // The port says a scan problem is a verdict, never a throw; count one anyway.
        instrumentsOf().errors.add(1, { kind: "unknown", source });
        throw error;
      }
      const verdict = label(result.verdict);
      const m = instrumentsOf();
      m.scans.add(1, { verdict, source });
      m.duration.record(Number(process.hrtime.bigint() - started) / 1e9, { verdict, source });
      if (result.verdict === "error") {
        m.errors.add(1, { kind: label(result.reason ?? "unknown"), source });
      } else if (result.verdict === "infected") {
        countSecurityEvent("avscan_infected", source);
      }
      return result;
    },
  };

  let gauges: { up: ObservableGauge; age: ObservableGauge } | undefined;
  const attrs = { driver: label(inner.driver) };
  const observeUp = (r: ObservableResult) => {
    if (cached.checkedAt !== undefined) r.observe(cached.status === "ok" ? 1 : 0, attrs);
  };
  const observeAge = (r: ObservableResult) => {
    const date = cached.signatureDate;
    if (date !== undefined) r.observe(Math.max(0, (now() - date.getTime()) / 1000), attrs);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<AvscanHealth> | undefined;

  async function probeOnce(): Promise<AvscanHealth> {
    const checkedAt = new Date(now());
    try {
      await withTimeout(() => inner.healthCheck(), probeTimeoutMs, "avscan probe");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (cached.status !== "fail" || cached.checkedAt === undefined) {
        log("avscan.probe_failed", { level: "warn", driver: inner.driver, error: detail });
      }
      // Keep the last known signature date: the age gauge goes on ageing while clamd is down.
      return {
        status: "fail",
        driver: inner.driver,
        detail,
        checkedAt,
        signatureDate: cached.signatureDate,
      };
    }
    const info = await withTimeout(() => inner.info(), probeTimeoutMs, "avscan info").catch(
      () => null,
    );
    if (cached.status === "fail" && cached.checkedAt !== undefined) {
      log("avscan.probe_recovered", { driver: inner.driver });
    }
    return {
      status: "ok",
      driver: inner.driver,
      checkedAt,
      signatureDate: info?.signatureDate ?? cached.signatureDate,
      detail: info?.version !== undefined ? `ClamAV ${info.version}` : undefined,
    };
  }

  async function refresh(): Promise<AvscanHealth> {
    if (!probing) return cached;
    inFlight ??= probeOnce()
      .catch(
        (error: unknown): AvscanHealth => ({
          status: "fail",
          driver: inner.driver,
          detail: String(error),
          checkedAt: new Date(now()),
        }),
      )
      .then((h) => {
        cached = h;
        return h;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  if (probing) {
    const meter = metrics.getMeter(AVSCAN_METER);
    gauges = {
      up: meter.createObservableGauge("fundroom.avscan.up", {
        description: "1 when the virus scanner answered its last probe (clamd PING), 0 when not",
      }),
      age: meter.createObservableGauge("fundroom.avscan.signature_age_seconds", {
        description:
          "Age of the scanner's signature database (clamd VERSION); stale means updates are failing",
      }),
    };
    gauges.up.addCallback(observeUp);
    gauges.age.addCallback(observeAge);
  }

  registry.set(scanner, () => cached);

  return {
    scanner,
    health: () => cached,
    refresh,
    start() {
      if (!probing || gauges === undefined || timer !== undefined) return;
      void refresh();
      timer = setInterval(() => void refresh(), options.refreshMs ?? DEFAULT_REFRESH_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      gauges?.up.removeCallback(observeUp);
      gauges?.age.removeCallback(observeAge);
      gauges = undefined;
    },
  };
}
