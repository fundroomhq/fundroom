import { createECDH, createPrivateKey, hkdfSync, type KeyObject } from "node:crypto";
import type { KeyRingEntry } from "@fundroom/config";

/*
 * The ECDSA P-256 key the Rekor anchor signs batch roots with (E3.13, ADR-0061). Derived from a
 * key-ring entry like the export-signing and checkpoint keys, so it needs no storage and rotates
 * with the ring; the public half goes into every Rekor entry and therefore into every proof.
 *
 * HKDF-SHA256(entry key, salt empty, info `ANCHOR_KEY_PURPOSE`) yields 48 bytes (128 bits more
 * than the order, so the reduction bias is < 2^-128); the scalar is `(v mod (n − 1)) + 1`, which
 * is always in [1, n − 1]. The public point comes from the scalar, and the key is built via JWK.
 */
export const ANCHOR_KEY_PURPOSE = "seed-host/audit/anchor-ecdsa-p256/v1";

/** The order of the P-256 group. */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The scalar for one entry, 32 bytes big-endian, in [1, n − 1]. Exposed for tests. */
export function anchorSigningScalar(entry: Pick<KeyRingEntry, "key">): Uint8Array {
  const okm = Buffer.from(hkdfSync("sha256", entry.key, new Uint8Array(0), ANCHOR_KEY_PURPOSE, 48));
  const v = BigInt(`0x${okm.toString("hex")}`);
  const d = (v % (P256_N - 1n)) + 1n;
  return new Uint8Array(Buffer.from(d.toString(16).padStart(64, "0"), "hex"));
}

/** The P-256 signing key for one key-ring entry. Deterministic. */
export function deriveAnchorSigningKey(entry: Pick<KeyRingEntry, "key">): KeyObject {
  const d = anchorSigningScalar(entry);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey(); // 0x04 || x || y
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64url(d),
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: "jwk",
  });
}
