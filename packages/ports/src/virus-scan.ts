/**
 * Virus scanning (EXECUTION_PLAN §5.2 `VirusScanPort`, §8, design/06 §4 "scan state
 * machine"). The ingest job streams every upload through the scanner before the bytes are
 * promoted from the quarantine prefix. Default adapter `@fundroom/avscan-noop` answers
 * `skipped` (the workspace decides whether unscanned blobs are servable); `@fundroom/avscan-clamd`
 * talks INSTREAM to a clamd container.
 */
export type ScanVerdict = "clean" | "infected" | "error" | "skipped";

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** Engine identifier recorded on the blob row (`noop`, `clamd 1.4.x`). */
  readonly engine: string;
  /** Signature name for `infected`, error text for `error`. */
  readonly detail?: string | undefined;
}

export interface ScanInput {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  /** Byte length when known (lets an adapter refuse over-limit streams up front). */
  readonly size?: number | undefined;
}

export interface VirusScanPort {
  readonly driver: string;
  /** Never throws for a scan problem: `error` is a verdict, so the job can retry or park the blob. */
  scan(input: ScanInput): Promise<ScanResult>;
  /** Cheap probe for `/readyz` (PING for clamd; no-op for noop). */
  healthCheck(): Promise<void>;
}
