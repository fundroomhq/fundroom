import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AnchorError,
  type AnchorErrorCode,
  type AnchorReceipt,
  type AnchorVerification,
  type AuditAnchorPort,
} from "@fundroom/ports";

/*
 * An in-memory `AuditAnchorPort` for kernel tests (E3.13). It "anchors" by MACing the digest with
 * a per-instance signer secret, so a receipt is offline-verifiable, a tampered digest or proof
 * fails, and a verifier that pins a different signer gets `unverified_origin` — the same three
 * outcomes the real adapters produce, without a network.
 *
 *   proof = { digest: hex, signer: string, mac: hex(HMAC-SHA256(secret(signer), digest)) }
 *
 * `trusted.pems` (when given) lists the signer names a verifier pins; with none given, the
 * instance's own signer is trusted (like an adapter verifying with its configured pins).
 */
export interface FakeAnchorOptions {
  /** Driver kind (default `fake`). */
  readonly kind?: string;
  /** Signer name embedded in every receipt (default `<kind>-signer`). */
  readonly signer?: string;
  readonly now?: () => Date;
  /** `timeTrusted` on verified results (default true, like RFC 3161; false = Rekor-like presence only). */
  readonly timeTrusted?: boolean;
}

export interface FakeAnchor extends AuditAnchorPort {
  /** Digests anchored successfully, in order (hex). */
  readonly anchored: string[];
  /** Every `anchor()` call, successful or not. */
  calls(): number;
  /** Make the next `n` calls (default: every call until `failNext(0)`) throw `AnchorError(code)`. */
  failNext(n: number, code?: AnchorErrorCode): void;
  /** Make every call throw until cleared with `null`. */
  setFailing(code: AnchorErrorCode | null): void;
  /** Delay every `anchor()` by `ms` (concurrency tests). */
  setDelay(ms: number): void;
}

const SECRET_PREFIX = "seed-host/test/fake-anchor/";

function macOf(signer: string, digest: Uint8Array): string {
  return createHmac("sha256", `${SECRET_PREFIX}${signer}`).update(digest).digest("hex");
}

export function createFakeAnchor(options: FakeAnchorOptions = {}): FakeAnchor {
  const kind = options.kind ?? "fake";
  const signer = options.signer ?? `${kind}-signer`;
  const now = options.now ?? (() => new Date());
  const anchored: string[] = [];
  let calls = 0;
  let failRemaining = 0;
  let failCode: AnchorErrorCode = "unreachable";
  let failing: AnchorErrorCode | null = null;
  let delayMs = 0;
  let serial = 0;

  return {
    kind,
    anchored,
    calls: () => calls,
    failNext(n, code = "unreachable") {
      failRemaining = n;
      failCode = code;
    },
    setFailing(code) {
      failing = code;
    },
    setDelay(ms) {
      delayMs = ms;
    },
    async anchor(digest: Uint8Array): Promise<AnchorReceipt> {
      calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (failing !== null) throw new AnchorError(failing, `${kind}: failing (${failing})`);
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new AnchorError(failCode, `${kind}: injected failure (${failCode})`);
      }
      if (digest.length !== 32)
        throw new AnchorError("rejected", `${kind}: digest must be 32 bytes`);
      const hex = Buffer.from(digest).toString("hex");
      anchored.push(hex);
      serial += 1;
      return {
        kind,
        reference: `fake://${kind}/${serial}`,
        anchoredAt: now().toISOString(),
        proof: { digest: hex, signer, mac: macOf(signer, digest) },
      };
    },
    async verify(digest, receipt, trusted): Promise<AnchorVerification> {
      const p = receipt.proof;
      if (receipt.kind !== kind) return { status: "failed", detail: `not a ${kind} receipt` };
      if (typeof p["digest"] !== "string" || typeof p["signer"] !== "string") {
        return { status: "failed", detail: "malformed proof" };
      }
      if (p["digest"] !== Buffer.from(digest).toString("hex")) {
        return { status: "failed", detail: "digest differs from the anchored one" };
      }
      const expected = Buffer.from(macOf(p["signer"], digest), "hex");
      const got = Buffer.from(typeof p["mac"] === "string" ? p["mac"] : "", "hex");
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return { status: "failed", detail: "signature does not verify" };
      }
      const pins = trusted?.pems ?? [signer];
      if (!pins.includes(p["signer"])) {
        return { status: "unverified_origin", detail: `signer ${p["signer"]} is not pinned` };
      }
      return {
        status: "verified",
        anchoredAt: receipt.anchoredAt,
        timeTrusted: options.timeTrusted ?? true,
      };
    },
  };
}
