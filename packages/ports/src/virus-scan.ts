/**
 * Virus scanning (EXECUTION_PLAN §5.2 `VirusScanPort`, §8, design/06 §4 "scan state
 * machine"). The ingest job streams every upload through the scanner before the bytes are
 * promoted from the quarantine prefix. Default adapter `@fundroom/avscan-noop` answers
 * `skipped` (the workspace decides whether unscanned blobs are servable); `@fundroom/avscan-clamd`
 * talks INSTREAM to a clamd container.
 */
export type ScanVerdict = "clean" | "infected" | "error" | "skipped";

/**
 * Why a scan ended in `error`:
 * - `too_large`: the input is bigger than the scanner will scan in full (refused up front, or
 *   the daemon answered with its stream size limit). Retrying cannot help.
 * - `partial`: the engine stopped at one of its own limits (clamd `Heuristics.Limits.Exceeded`),
 *   so the file could not be scanned in full. Not infected, never served. Retrying cannot help.
 * - `unavailable`: the scanner could not be reached or the connection broke. Retry.
 * - `timeout`: the scan deadline passed. Retry.
 */
export type ScanFailureReason = "too_large" | "partial" | "unavailable" | "timeout";

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** Engine identifier recorded on the blob row (`noop`, `clamd 1.4.x`). */
  readonly engine: string;
  /** Signature name for `infected`, error text for `error`. */
  readonly detail?: string | undefined;
  /** Set when verdict is `error`. */
  readonly reason?: ScanFailureReason | undefined;
  /**
   * Only meaningful for `error`: `false` means retrying cannot help (`too_large`, `partial`),
   * so callers record the failure as final; `true`/undefined means retry.
   */
  readonly retryable?: boolean | undefined;
}

export interface ScanInput {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  /** Byte length when known (lets an adapter refuse over-limit streams up front). */
  readonly size?: number | undefined;
  /** Who is scanning (`data-room`, `esign`, `round`): a bounded metrics label. */
  readonly source?: string | undefined;
  /**
   * Aborts the scan (the job is stopping or expired): the adapter ends the exchange at once and
   * answers `error` / `unavailable` (retryable).
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The longest a single scan may run. Jobs that scan (data-room ingest, e-sign collect) expire
 * after 30 minutes; 20 leaves room for the rest of the job (promotion, rendering) and for the
 * deadline to fire before pg-boss abandons the attempt. Adapters cap their deadline here.
 */
export const CLAMD_MAX_DEADLINE_MS = 20 * 60 * 1000;

/** Engine and signature database the scanner reports (clamd `VERSION`). */
export interface ScannerInfo {
  readonly engine: string;
  readonly version?: string;
  readonly signatureVersion?: string;
  readonly signatureDate?: Date;
}

export interface VirusScanPort {
  readonly driver: string;
  /** Never throws for a scan problem: `error` is a verdict, so the job can retry or park the blob. */
  scan(input: ScanInput): Promise<ScanResult>;
  /** Cheap probe for `/readyz` (PING for clamd; no-op for noop). */
  healthCheck(): Promise<void>;
  /** Engine and signature info; null for noop or on any failure. Never throws. */
  info(): Promise<ScannerInfo | null>;
  /** Upper bound of bytes this scanner will scan in full, or null when unknown/unbounded. */
  readonly maxScanBytes: number | null;
}
