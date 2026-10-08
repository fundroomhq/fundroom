import type { OutboundFetch } from "./http.js";
import type { Jurisdiction } from "./residency.js";

/**
 * Sanctions screening of tenant companies (EXECUTION_PLAN §15 E3.10, ADR-0058). Adapters:
 * `@fundroom/sanctions-ofac` (downloads the US SDN + consolidated lists, matches locally) and
 * `@fundroom/sanctions-opensanctions` (a yente server or the hosted API). The kernel service
 * `@fundroom/sanctions` owns `core.sanctions_screening` and the hold/suspend decisions; an
 * adapter only answers "does this name match a listed party".
 *
 * Screening is network-bound: never call an adapter while holding a database transaction.
 */
export interface SanctionsSubject {
  readonly name: string;
  /** ISO 3166-1 alpha-2; informative only (a country never clears a name match). */
  readonly country: string | null;
  readonly kind: "organization" | "person";
}

export interface SanctionsMatch {
  readonly listEntryId: string;
  readonly name: string;
  /** 0..1 */
  readonly score: number;
  readonly programs: readonly string[];
  readonly source: string;
}

export interface SanctionsResult {
  readonly outcome: "clear" | "potential_match";
  /** The list snapshot + matcher version (`ofac:<sha256-12>:jw1`). */
  readonly listVersion: string;
  readonly matches: readonly SanctionsMatch[];
}

export interface SanctionsSubProcessor {
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
  readonly url: string;
  /** E3.11: machine jurisdiction for out-of-region flags (`@fundroom/compliance` normalises). */
  readonly jurisdiction?: Jurisdiction | "varies" | undefined;
}

export interface SanctionsScreeningPort {
  readonly driver: "ofac" | "opensanctions";
  readonly meta: {
    readonly subProcessor: SanctionsSubProcessor | null;
    /** Human names of the lists screened against (`OFAC SDN`, `OFAC Consolidated`, …). */
    readonly lists: readonly string[];
  };
  screen(
    subject: SanctionsSubject,
    opts: { threshold: number; signal?: AbortSignal | undefined },
  ): Promise<SanctionsResult>;
  /** Current list version (for re-screen on change); may download/refresh. */
  listVersion(opts?: { signal?: AbortSignal | undefined }): Promise<string>;
}

/** What the composition root hands a sanctions adapter factory. */
export interface SanctionsAdapterDeps {
  /** A guarded outbound fetch; the adapter decides its own redirect policy (see ADR-0058). */
  readonly fetch: OutboundFetch;
  /** `SANCTIONS_OFAC_URL` or `SANCTIONS_OPENSANCTIONS_URL`. */
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /** `DATA_DIR/sanctions/`: the downloaded list cache (ofac). */
  readonly cacheDir: string;
  readonly now: () => Date;
}

/** The list could not be fetched or the provider did not answer; the service fails closed. */
export class SanctionsProviderError extends Error {
  override readonly name = "SanctionsProviderError";
}
