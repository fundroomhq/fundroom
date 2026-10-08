import { createRekorAnchor, verifyRekorReceipt } from "@fundroom/anchor-rekor";
import { createRfc3161Anchor, verifyRfc3161Receipt } from "@fundroom/anchor-rfc3161";
import { type AnchorVerifier, deriveAnchorSigningKey } from "@fundroom/audit";
import { type AppConfig, pemBlocks } from "@fundroom/config";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { AuditAnchorPort, OutboundFetch } from "@fundroom/ports";
import { SERVER_VERSION } from "./version.js";

/*
 * External audit anchoring wiring (E3.13, ADR-0061; contract §2). Off unless AUDIT_ANCHOR_DRIVERS
 * names a driver: then `rfc3161` → `@fundroom/anchor-rfc3161` over AUDIT_ANCHOR_TSA_URLS pinned to
 * AUDIT_ANCHOR_TSA_CERTS, and `rekor` → `@fundroom/anchor-rekor` at AUDIT_ANCHOR_REKOR_URL pinned to
 * AUDIT_ANCHOR_REKOR_LOG_KEY, signing with the key-ring-derived P-256 key
 * (`deriveAnchorSigningKey(ring.current)`).
 *
 * Their own guarded outbound client: the endpoints are operator-configured (never a tenant's), so
 * exactly those hosts may be private (an in-house TSA or a private Rekor); no redirects; small
 * responses (a timestamp token or a log entry). `/readyz` is unaffected — anchoring is async.
 */
const ANCHOR_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface AuditAnchoring {
  /** Empty = anchoring is off: no job, routes report `configured: []`. */
  readonly drivers: readonly AuditAnchorPort[];
  /**
   * Offline verifiers by kind for STORED receipts, pinned to every configured TSA certificate and
   * Rekor log key — including verification-only pins whose driver is off (FIX1 A9), so receipts
   * survive a Rekor shard rotation or turning a driver off.
   */
  readonly verifiers: Readonly<Record<string, AnchorVerifier>>;
  readonly close: () => Promise<void>;
}

/** The adapters' offline verifiers, by driver kind (export bundles, `verify-anchor`). */
export function anchorVerifiers(): Record<string, AnchorVerifier> {
  return { rfc3161: verifyRfc3161Receipt, rekor: verifyRekorReceipt };
}

/** Verifiers whose default pins are the config's (all blocks); explicit `trusted.pems` win. */
export function pinnedAnchorVerifiers(
  raw: Pick<
    AppConfig["raw"],
    | "AUDIT_ANCHOR_TSA_CERTS"
    | "AUDIT_ANCHOR_REKOR_LOG_KEY"
    | "AUDIT_ANCHOR_REKOR_ORIGIN"
    | "AUDIT_ANCHOR_REKOR_URL"
  >,
): Record<string, AnchorVerifier> {
  const tsaPins = pemBlocks(raw.AUDIT_ANCHOR_TSA_CERTS ?? "", "CERTIFICATE");
  const rekorPins = pemBlocks(raw.AUDIT_ANCHOR_REKOR_LOG_KEY ?? "", "PUBLIC KEY");
  const origins = rekorOrigins(raw);
  const out: Record<string, AnchorVerifier> = {};
  if (tsaPins.length > 0)
    out["rfc3161"] = (d, r, t) => verifyRfc3161Receipt(d, r, { pems: t?.pems ?? tsaPins });
  if (rekorPins.length > 0)
    out["rekor"] = (d, r, t) =>
      verifyRekorReceipt(d, r, { pems: t?.pems ?? rekorPins, origins: t?.origins ?? origins });
  return out;
}

/**
 * Pinned Rekor checkpoint origins: AUDIT_ANCHOR_REKOR_ORIGIN (first = current shard), else the
 * hostname of AUDIT_ANCHOR_REKOR_URL (what rekor-tiles uses by default). Origins are a set across
 * all pinned log keys, not paired per key.
 */
export function rekorOrigins(
  raw: Pick<AppConfig["raw"], "AUDIT_ANCHOR_REKOR_ORIGIN" | "AUDIT_ANCHOR_REKOR_URL">,
): string[] {
  if (raw.AUDIT_ANCHOR_REKOR_ORIGIN && raw.AUDIT_ANCHOR_REKOR_ORIGIN.length > 0)
    return [...raw.AUDIT_ANCHOR_REKOR_ORIGIN];
  return raw.AUDIT_ANCHOR_REKOR_URL === undefined
    ? []
    : [hostOf(String(raw.AUDIT_ANCHOR_REKOR_URL))];
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createAuditAnchoring(options: {
  readonly config: Pick<AppConfig, "raw" | "keyRing">;
  /** Test seam (`ContainerOptions.auditAnchorDrivers`): replaces config-built drivers. */
  readonly drivers?: readonly AuditAnchorPort[] | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}): AuditAnchoring {
  const raw = options.config.raw;
  const verifiers = pinnedAnchorVerifiers(raw);
  if (options.drivers !== undefined) {
    return { drivers: options.drivers, verifiers, close: async () => {} };
  }
  const kinds = raw.AUDIT_ANCHOR_DRIVERS ?? [];
  if (kinds.length === 0) return { drivers: [], verifiers, close: async () => {} };
  const tsaUrls = (raw.AUDIT_ANCHOR_TSA_URLS ?? []).map(String);
  const rekorUrl =
    raw.AUDIT_ANCHOR_REKOR_URL === undefined ? undefined : String(raw.AUDIT_ANCHOR_REKOR_URL);
  const hosts = [
    ...(kinds.includes("rfc3161") ? tsaUrls.map(hostOf) : []),
    ...(kinds.includes("rekor") && rekorUrl ? [hostOf(rekorUrl)] : []),
  ];
  const outbound: OutboundHttp = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: hosts,
    userAgent: `FundRoom/${SERVER_VERSION} (+audit-anchor)`,
    timeoutMs: raw.AUDIT_ANCHOR_TIMEOUT_MS,
    maxResponseBytes: ANCHOR_MAX_RESPONSE_BYTES,
    maxConcurrentLookups: 4,
    maxRedirects: 0,
    log: options.log,
  });
  const http = outbound.fetch as OutboundFetch;
  const drivers: AuditAnchorPort[] = [];
  for (const kind of kinds) {
    if (kind === "rfc3161") {
      drivers.push(
        createRfc3161Anchor({
          urls: tsaUrls,
          trustedPems: pemBlocks(raw.AUDIT_ANCHOR_TSA_CERTS ?? "", "CERTIFICATE"),
          http,
          timeoutMs: raw.AUDIT_ANCHOR_TIMEOUT_MS,
        }),
      );
    } else if (kind === "rekor" && rekorUrl) {
      drivers.push(
        createRekorAnchor({
          url: rekorUrl,
          // Every pinned log key (the first is the current shard's); B3 binds the origin.
          logPublicKeyPem: pemBlocks(raw.AUDIT_ANCHOR_REKOR_LOG_KEY ?? "", "PUBLIC KEY"),
          origin: rekorOrigins(raw),
          signingKey: deriveAnchorSigningKey(options.config.keyRing.current),
          http,
          timeoutMs: raw.AUDIT_ANCHOR_TIMEOUT_MS,
        }),
      );
    }
  }
  return { drivers, verifiers, close: () => outbound.close() };
}
