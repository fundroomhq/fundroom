import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeKeyRing, keyRingFromSingleKey, parseKeyRing } from "./key-ring.js";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(48).toString("base64url");
const kHex = randomBytes(32).toString("hex");

describe("parseKeyRing", () => {
  it("parses newest-first entries in base64, base64url, and hex", () => {
    const r = parseKeyRing(` v3:${kHex} , v2:${k2},v1:${k1}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ring.current.id).toBe("v3");
    expect(r.ring.entries.map((e) => e.id)).toEqual(["v3", "v2", "v1"]);
    expect(r.ring.get("v1")?.key).toEqual(Uint8Array.from(Buffer.from(k1, "base64")));
    expect(r.ring.get("v2")?.key.byteLength).toBe(48);
    expect(r.ring.get("nope")).toBeUndefined();
    expect(r.ring.current.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/u);
  });

  it("rejects short keys, bad encodings, bad ids, and duplicates — all at once", () => {
    const short = randomBytes(16).toString("base64");
    const r = parseKeyRing(`v2:${short},v1:${k1},v1:${k1},bad id:${k1},v9:!!!,v10`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.issues.map((i) => i.message);
    expect(messages).toContainEqual(expect.stringMatching(/"v2" is 16 bytes; need at least 32/u));
    expect(messages).toContainEqual('duplicate key id "v1".');
    expect(messages).toContainEqual(expect.stringMatching(/key id "bad id" must match/u));
    expect(messages).toContainEqual('key "v9" is not valid base64 or hex.');
    expect(messages).toContainEqual("entry 6 must look like id:base64key.");
    for (const i of r.issues) expect(i.key).toBe("SECRET_KEY_RING");
  });

  it("rejects an empty ring", () => {
    const r = parseKeyRing(" , ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]?.message).toBe("is empty.");
  });

  it("never echoes key material in issues or descriptions", () => {
    const r = parseKeyRing(`v1:${k1}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const described = describeKeyRing(r.ring);
    expect(described).toMatch(/^v1 \(sha256:[0-9a-f]{12}\)$/u);
    expect(described).not.toContain(k1.slice(0, 8));
  });
});

describe("keyRingFromSingleKey", () => {
  it("wraps FUNDROOM_SECRET_KEY as v1", () => {
    const r = keyRingFromSingleKey(k1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ring.current.id).toBe("v1");
    expect(r.ring.entries).toHaveLength(1);
  });

  it("attributes errors to FUNDROOM_SECRET_KEY with a plain message", () => {
    const r = keyRingFromSingleKey("too-short");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      {
        key: "FUNDROOM_SECRET_KEY",
        message: "is not valid base64 or hex.",
        example: "$(openssl rand -base64 32)",
      },
    ]);
  });
});
