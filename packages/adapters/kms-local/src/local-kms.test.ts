import { randomBytes } from "node:crypto";
import { type KeyRing, parseKeyRing } from "@fundroom/config";
import { KmsError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createLocalKms, parseLocalKeyRef } from "./local-kms.js";

function ring(spec: string): KeyRing {
  const r = parseKeyRing(spec);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join("; "));
  return r.ring;
}

const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");
const WS_A = "0192a1b2-0000-7000-8000-000000000001";
const WS_B = "0192a1b2-0000-7000-8000-000000000002";

async function expectKmsError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e) => e instanceof KmsError && e.code === code);
}

describe("createLocalKms", () => {
  it("generates a 32-byte key that differs per call and round-trips", async () => {
    const kms = createLocalKms({ keyRing: ring(`v1:${K1}`) });
    const a = await kms.generateDataKey({ workspaceId: WS_A });
    const b = await kms.generateDataKey({ workspaceId: WS_A });
    expect(a.plaintext).toHaveLength(32);
    expect(Buffer.from(a.plaintext).equals(Buffer.from(b.plaintext))).toBe(false);
    expect(a.keyRef).toBe("local:v1");
    expect(kms.currentKeyRef).toBe("local:v1");
    expect(kms.driver).toBe("local");
    const back = await kms.unwrapDataKey(a.wrapped, a.keyRef, { workspaceId: WS_A });
    expect(Buffer.from(back).equals(Buffer.from(a.plaintext))).toBe(true);
    expect(a.wrapped[0]).toBe(1);
    expect(a.wrapped).toHaveLength(1 + 12 + 32 + 16);
  });

  it("binds the wrap to the workspace and purpose", async () => {
    const kms = createLocalKms({ keyRing: ring(`v1:${K1}`) });
    const a = await kms.generateDataKey({ workspaceId: WS_A });
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped, a.keyRef, { workspaceId: WS_B }),
      "unwrap_failed",
    );
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped, a.keyRef, { workspaceId: WS_A, purpose: "other" }),
      "unwrap_failed",
    );
    const p = await kms.generateDataKey({ workspaceId: WS_A, purpose: "export" });
    await expect(
      kms.unwrapDataKey(p.wrapped, p.keyRef, { workspaceId: WS_A, purpose: "export" }),
    ).resolves.toHaveLength(32);
  });

  it("rejects tampered bytes, wrong length and unknown refs", async () => {
    const kms = createLocalKms({ keyRing: ring(`v1:${K1}`) });
    const a = await kms.generateDataKey({ workspaceId: WS_A });
    for (const i of [0, 1, 20, 50, a.wrapped.length - 1]) {
      const bad = Uint8Array.from(a.wrapped);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      await expectKmsError(
        kms.unwrapDataKey(bad, a.keyRef, { workspaceId: WS_A }),
        "unwrap_failed",
      );
    }
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped.subarray(0, 40), a.keyRef, { workspaceId: WS_A }),
      "unwrap_failed",
    );
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped, "local:v9", { workspaceId: WS_A }),
      "unknown_key",
    );
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped, "aws:arn", { workspaceId: WS_A }),
      "unknown_key",
    );
    await expectKmsError(
      kms.unwrapDataKey(a.wrapped, "local:", { workspaceId: WS_A }),
      "unknown_key",
    );
    expect(parseLocalKeyRef("local:v2")).toBe("v2");
    expect(parseLocalKeyRef("vault:abc")).toBeUndefined();
  });

  it("survives ring rotation: old wraps unwrap, new wraps use the new key", async () => {
    const old = createLocalKms({ keyRing: ring(`v1:${K1}`) });
    const a = await old.generateDataKey({ workspaceId: WS_A });

    const rotated = createLocalKms({ keyRing: ring(`v2:${K2},v1:${K1}`) });
    expect(rotated.currentKeyRef).toBe("local:v2");
    expect(rotated.needsRewrap("local:v1")).toBe(true);
    expect(rotated.needsRewrap("local:v2")).toBe(false);
    const back = await rotated.unwrapDataKey(a.wrapped, a.keyRef, { workspaceId: WS_A });
    expect(Buffer.from(back).equals(Buffer.from(a.plaintext))).toBe(true);

    const b = await rotated.generateDataKey({ workspaceId: WS_A });
    expect(b.keyRef).toBe("local:v2");
    // Rewrap: same plaintext, new KEK.
    const re = await rotated.wrapDataKey(a.plaintext, { workspaceId: WS_A });
    expect(re.keyRef).toBe("local:v2");
    expect(Buffer.from(re.wrapped).equals(Buffer.from(a.wrapped))).toBe(false);
    const again = await rotated.unwrapDataKey(re.wrapped, re.keyRef, { workspaceId: WS_A });
    expect(Buffer.from(again).equals(Buffer.from(a.plaintext))).toBe(true);
    await expectKmsError(rotated.wrapDataKey(new Uint8Array(16), { workspaceId: WS_A }), "backend");
    // The pre-rotation ring cannot unwrap what v2 produced.
    await expectKmsError(
      old.unwrapDataKey(b.wrapped, b.keyRef, { workspaceId: WS_A }),
      "unknown_key",
    );
    // A ring that dropped v1 cannot unwrap the old wrap either: rewrap before dropping keys.
    const dropped = createLocalKms({ keyRing: ring(`v2:${K2}`) });
    await expectKmsError(
      dropped.unwrapDataKey(a.wrapped, a.keyRef, { workspaceId: WS_A }),
      "unknown_key",
    );
    await expect(dropped.healthCheck()).resolves.toBeUndefined();
  });
});
