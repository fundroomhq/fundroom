import { parseKeyRing } from "@fundroom/config";
import { deriveForensicPatternKey } from "@fundroom/forensic";
import { describe, expect, it } from "vitest";
import { forensicKeysOf } from "./deps.js";

/* E3.13: `ModuleServices.forensicKeys` hands out derived pattern keys, never ring material. */
const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");

function ring(spec: string) {
  const r = parseKeyRing(spec);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
}

describe("forensicKeysOf", () => {
  it("keys new marks with the current entry and re-derives older ones", () => {
    const keys = forensicKeysOf(ring(`v2:${k2},v1:${k1}`));
    const current = keys.current();
    expect(current.keyId).toBe("v2");
    expect(Buffer.from(current.patternKey)).toEqual(
      Buffer.from(deriveForensicPatternKey(Buffer.alloc(32, 2))),
    );
    expect(Buffer.from(current.patternKey).equals(Buffer.alloc(32, 2))).toBe(false);
    expect(Buffer.from(keys.get("v1") as Uint8Array)).toEqual(
      Buffer.from(deriveForensicPatternKey(Buffer.alloc(32, 1))),
    );
  });

  it("an entry that left the ring yields undefined", () => {
    expect(forensicKeysOf(ring(`v2:${k2}`)).get("v1")).toBeUndefined();
  });
});
