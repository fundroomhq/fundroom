import { createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANCHOR_KEY_PURPOSE, anchorSigningScalar, deriveAnchorSigningKey } from "./anchor-key.js";

const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const entry = (fill: number) => ({ key: new Uint8Array(32).fill(fill) });

describe("deriveAnchorSigningKey (E3.13)", () => {
  it("is a P-256 key that signs and verifies", () => {
    const key = deriveAnchorSigningKey(entry(1));
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const msg = Buffer.from("merkle root");
    const sig = sign("sha256", msg, key);
    expect(verify("sha256", msg, createPublicKey(key), sig)).toBe(true);
  });

  it("is deterministic per entry and differs across entries", () => {
    const spki = (fill: number) =>
      createPublicKey(deriveAnchorSigningKey(entry(fill))).export({ format: "der", type: "spki" });
    expect(spki(1).equals(spki(1))).toBe(true);
    expect(spki(1).equals(spki(2))).toBe(false);
  });

  it("uses its own HKDF purpose and a scalar in [1, n-1]", () => {
    expect(ANCHOR_KEY_PURPOSE).toBe("seed-host/audit/anchor-ecdsa-p256/v1");
    for (let i = 0; i < 64; i++) {
      const d = BigInt(`0x${Buffer.from(anchorSigningScalar(entry(i))).toString("hex")}`);
      expect(d > 0n && d < N).toBe(true);
    }
    const jwk = deriveAnchorSigningKey(entry(3)).export({ format: "jwk" });
    expect(
      Buffer.from(jwk.d as string, "base64url").equals(Buffer.from(anchorSigningScalar(entry(3)))),
    ).toBe(true);
  });
});
