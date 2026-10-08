import { randomBytes } from "node:crypto";
import {
  AnchorError,
  type AnchorReceipt,
  type AnchorVerification,
  type AuditAnchorPort,
  type OutboundFetch,
} from "@fundroom/ports";
import { displayUrl, postCapped } from "./http.js";
import {
  buildTimeStampRequest,
  nonceFrom,
  nonceHexOf,
  parseTimeStampResponse,
  TokenError,
  verifyTimeStampToken,
} from "./tsp.js";

/*
 * RFC 3161 anchor (E3.13, ADR-0061). `anchor(root)` sends a SHA-256 TimeStampReq (random nonce,
 * certReq TRUE) to the operator's TSAs in order and keeps the first token that verifies against
 * the pinned certificates with the nonce we sent. The receipt carries the token's DER, so
 * `verify` (and `verifyRfc3161Receipt`) re-checks it offline: no network, ever.
 */

export const RFC3161_ANCHOR_KIND = "rfc3161";
/** A token with a certificate chain is a few KiB; anything near this is not a TSA answer. */
export const RFC3161_MAX_RESPONSE_BYTES = 256 * 1024;
export const RFC3161_PROOF_VERSION = 1;

export interface Rfc3161AnchorOptions {
  /** TSA endpoints, tried in order (AUDIT_ANCHOR_TSA_URLS). */
  readonly urls: readonly string[];
  /** Pinned TSA certificates / roots (PEM blocks of AUDIT_ANCHOR_TSA_CERTS). */
  readonly trustedPems: readonly string[];
  /** The guarded outbound client's fetch (no redirects, size cap). */
  readonly http: OutboundFetch;
  /** Per-request timeout (AUDIT_ANCHOR_TIMEOUT_MS). */
  readonly timeoutMs: number;
  readonly now?: (() => Date) | undefined;
  /** Test seam for the nonce bytes. */
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined;
}

/**
 * `receipt.proof` of an `rfc3161` receipt. `token` is the base64 DER timeStampToken (a CMS
 * ContentInfo) — `openssl ts -verify -digest <hex> -in <(base64 -d) -token_in -CAfile …` checks it
 * too. The other fields are informational copies of what the token says.
 */
export interface Rfc3161Proof {
  readonly v: number;
  readonly token: string;
  readonly tsaUrl: string;
  readonly serial: string;
  readonly policy: string;
  readonly nonce: string | null;
  readonly hashAlgorithm: "sha256";
}

function failed(detail: string): AnchorVerification {
  return { status: "failed", detail };
}

/**
 * Offline verification of an `rfc3161` receipt over `digest` against pinned TSA certificates
 * (`trusted.pems`; PEM bundles allowed). `verified` needs the token valid AND chained to a pinned
 * certificate; a valid token from an unpinned signer (or with nothing pinned) is
 * `unverified_origin`. Never throws, never touches the network. Typed as `AuditAnchorPort["verify"]`
 * so the export-bundle verifier can take it as is.
 */
export const verifyRfc3161Receipt: AuditAnchorPort["verify"] = async (digest, receipt, trusted) =>
  verifyReceiptSync(digest, receipt, trusted?.pems ?? []);

function verifyReceiptSync(
  digest: Uint8Array,
  receipt: AnchorReceipt,
  pinnedPems: readonly string[],
): AnchorVerification {
  if (receipt.kind !== RFC3161_ANCHOR_KIND) return failed(`not an ${RFC3161_ANCHOR_KIND} receipt`);
  const token = (receipt.proof as Record<string, unknown> | undefined)?.["token"];
  if (typeof token !== "string" || token === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    return failed("the receipt carries no base64 token");
  }
  const result = verifyTimeStampToken(
    digest,
    new Uint8Array(Buffer.from(token, "base64")),
    pinnedPems,
  );
  if (result.status === "failed") return failed(result.detail);
  const genTime = result.facts?.genTime;
  if (genTime && Date.parse(receipt.anchoredAt) !== genTime.getTime()) {
    return failed("the receipt's anchoredAt does not match the token's genTime");
  }
  if (result.status === "unverified_origin") {
    return { status: "unverified_origin", detail: result.detail };
  }
  return result.detail === undefined
    ? { status: "verified", anchoredAt: result.anchoredAt, timeTrusted: true }
    : {
        status: "verified",
        anchoredAt: result.anchoredAt,
        timeTrusted: true,
        detail: result.detail,
      };
}

export function createRfc3161Anchor(options: Rfc3161AnchorOptions): AuditAnchorPort {
  if (options.urls.length === 0) throw new Error("anchor-rfc3161: at least one TSA URL is needed");
  const random = options.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));

  async function anchorWith(url: string, digest: Uint8Array): Promise<AnchorReceipt> {
    const what = `TSA ${displayUrl(url)}`;
    const nonce = nonceFrom(random(8));
    const answer = await postCapped({
      http: options.http,
      url,
      body: buildTimeStampRequest(digest, nonce),
      headers: {
        "content-type": "application/timestamp-query",
        accept: "application/timestamp-reply",
      },
      timeoutMs: options.timeoutMs,
      maxBytes: RFC3161_MAX_RESPONSE_BYTES,
      what,
    });
    let parsed: ReturnType<typeof parseTimeStampResponse>;
    try {
      parsed = parseTimeStampResponse(answer.bytes);
    } catch (error) {
      throw new AnchorError(
        "invalid_response",
        `${what}: ${error instanceof TokenError ? error.message : "unparseable answer"}`,
      );
    }
    if (parsed.status !== 0 && parsed.status !== 1) {
      throw new AnchorError(
        "rejected",
        `${what}: refused the request (PKIStatus ${parsed.status})`,
      );
    }
    if (parsed.token === null) {
      throw new AnchorError("invalid_response", `${what}: granted without a token`);
    }
    const checked = verifyTimeStampToken(digest, parsed.token, options.trustedPems);
    if (checked.status !== "verified" || !checked.facts) {
      throw new AnchorError(
        "verification_failed",
        `${what}: ${checked.status === "verified" ? "no token facts" : checked.detail}`,
      );
    }
    if (checked.facts.nonceHex !== nonceHexOf(nonce)) {
      throw new AnchorError("verification_failed", `${what}: the token's nonce does not match`);
    }
    const proof: Rfc3161Proof = {
      v: RFC3161_PROOF_VERSION,
      token: Buffer.from(parsed.token).toString("base64"),
      tsaUrl: displayUrl(url),
      serial: checked.facts.serialHex,
      policy: checked.facts.policy,
      nonce: checked.facts.nonceHex,
      hashAlgorithm: "sha256",
    };
    return {
      kind: RFC3161_ANCHOR_KIND,
      reference: `${displayUrl(url)} serial ${checked.facts.serialHex}`,
      anchoredAt: checked.facts.genTime.toISOString(),
      proof: { ...proof },
    };
  }

  return {
    kind: RFC3161_ANCHOR_KIND,
    async anchor(digest: Uint8Array): Promise<AnchorReceipt> {
      if (digest.byteLength !== 32) {
        throw new AnchorError("rejected", "the anchored digest must be 32 bytes (SHA-256)");
      }
      const failures: AnchorError[] = [];
      for (const url of options.urls) {
        try {
          return await anchorWith(url, digest);
        } catch (error) {
          failures.push(
            error instanceof AnchorError
              ? error
              : new AnchorError("invalid_response", `TSA ${displayUrl(url)}: unexpected failure`, {
                  cause: error,
                }),
          );
        }
      }
      const last = failures[failures.length - 1] as AnchorError;
      if (failures.length === 1) throw last;
      throw new AnchorError(
        last.code,
        `every TSA failed: ${failures.map((f) => f.message).join("; ")}`,
        { cause: last },
      );
    },
    async verify(digest, receipt, trusted) {
      return verifyRfc3161Receipt(digest, receipt, { pems: trusted?.pems ?? options.trustedPems });
    },
  };
}

export { buildTimeStampRequest, parseTimeStampResponse, verifyTimeStampToken } from "./tsp.js";
