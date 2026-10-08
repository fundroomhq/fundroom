/**
 * External audit anchoring port (EXECUTION_PLAN §15 E3.13, ADR-0061).
 *
 * The anchoring job batches every un-anchored audit checkpoint into an RFC 6962 Merkle tree and
 * hands only the 32-byte root to each configured driver. A driver returns a receipt that a third
 * party can verify OFFLINE against the digest — an RFC 3161 timestamp token (`rfc3161`) or a
 * Sigstore Rekor v2 transparency-log entry with its inclusion proof and signed checkpoint
 * (`rekor`). Adapters: `@fundroom/anchor-rfc3161`, `@fundroom/anchor-rekor`. Every outbound call
 * goes through the guarded outbound HTTP client; only the operator configures endpoints.
 */

/** What an anchor returned for one digest. Stored as `audit.anchor_receipt.receipt`. */
export interface AnchorReceipt {
  /** Driver id: `rfc3161` | `rekor`. */
  readonly kind: string;
  /** Human locator: the TSA URL + serial number, or the Rekor log URL + log index. */
  readonly reference: string;
  /**
   * ISO time asserted by the anchor: the TSA's genTime; for Rekor v2 (no integrated time) our
   * submission time.
   */
  readonly anchoredAt: string;
  /** Everything needed to verify offline (base64 DER token / Rekor entry + inclusion proof + checkpoint). */
  readonly proof: Record<string, unknown>;
}

export type AnchorVerification =
  | {
      readonly status: "verified";
      /**
       * The anchor's time. Trusted (signed by the anchor) only when `timeTrusted` is not false:
       * an RFC 3161 genTime is; a Rekor v2 receipt's `anchoredAt` is the SUBMITTER's clock, covered
       * by no signature (Rekor v2 has no integrated time).
       */
      readonly anchoredAt: string;
      /**
       * `false`: the receipt proves PRESENCE only (the digest is in a public append-only log), not
       * WHEN — never use `anchoredAt` as evidence of time. Absent or `true`: `anchoredAt` is
       * asserted by the verified anchor itself.
       */
      readonly timeTrusted?: boolean;
      readonly detail?: string;
    }
  /** The proof is consistent but its signer is not pinned / trusted. */
  | { readonly status: "unverified_origin"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string };

export interface AuditAnchorPort {
  readonly kind: string;
  /** Anchors a 32-byte SHA-256 Merkle root. Throws `AnchorError` on any failure. */
  anchor(digest: Uint8Array): Promise<AnchorReceipt>;
  /** Offline: no network. `trusted` = pinned TSA certificates / Rekor log public keys (PEM). */
  verify(
    digest: Uint8Array,
    receipt: AnchorReceipt,
    trusted?: {
      readonly pems?: readonly string[];
      /**
       * Pinned transparency-log origins (C2SP checkpoint origin lines) a receipt's checkpoint may
       * carry. Used by `rekor`; ignored by `rfc3161`. A receipt's own claim never counts.
       */
      readonly origins?: readonly string[];
    },
  ): Promise<AnchorVerification>;
  healthCheck?(): Promise<void>;
}

export const ANCHOR_ERROR_CODES = [
  "unreachable",
  "timeout",
  "rejected",
  "invalid_response",
  "verification_failed",
] as const;
export type AnchorErrorCode = (typeof ANCHOR_ERROR_CODES)[number];

/** A failed `anchor()` call. `code` is logged and recorded per driver; never the response body. */
export class AnchorError extends Error {
  override readonly name = "AnchorError";
  constructor(
    readonly code: AnchorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
