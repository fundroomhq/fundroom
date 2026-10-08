import { describe, expect, it } from "vitest";
import { BLOB_VALUE_RE, checkImportedKey, collectUuids, scrubForeign } from "./import-guards.js";

/* The pure refusal rules of the importer (E2.8 fix C, item 1). */

const NEW_WS = "0190f1a0-0000-7000-8000-00000000aaaa";
const NEW_ROW = "0190f1a0-0000-7000-8000-00000000bbbb";
const VICTIM = "0190f1a0-0000-7000-8000-00000000cccc";
const SHA = "ab".repeat(32);
const isNew = (id: string) => id === NEW_ROW;

describe("checkImportedKey", () => {
  it("accepts the engine's own key shapes for the new workspace", () => {
    expect(checkImportedKey(`ws/${NEW_WS}/blobs/${SHA}`, NEW_WS, isNew)).toBeNull();
    expect(checkImportedKey(`round/verification/${NEW_WS}/${NEW_ROW}`, NEW_WS, isNew)).toBeNull();
    expect(
      checkImportedKey(`ws/${NEW_WS}/quarantine/not-exported-${NEW_ROW}`, NEW_WS, isNew),
    ).toBeNull();
    // A hyphenless id that this import minted is fine too.
    expect(
      checkImportedKey(`ws/${NEW_WS}/r/${NEW_ROW.replaceAll("-", "")}`, NEW_WS, isNew),
    ).toBeNull();
  });

  it("refuses another workspace's prefix, traversal, absolute paths and foreign ids", () => {
    expect(checkImportedKey(`ws/${VICTIM}/quarantine/x`, NEW_WS, isNew)).toMatch(
      /another workspace's prefix/u,
    );
    expect(checkImportedKey(`ws/${VICTIM}/blobs/${NEW_WS}/${SHA}`, NEW_WS, isNew)).toMatch(
      /another workspace's prefix/u,
    );
    expect(checkImportedKey(`ws/${NEW_WS}/../${VICTIM}/x`, NEW_WS, isNew)).toMatch(
      /plain segments/u,
    );
    expect(checkImportedKey(`/ws/${NEW_WS}/x`, NEW_WS, isNew)).toMatch(/plain segments/u);
    expect(checkImportedKey(`ws/${NEW_WS}\\..\\x`, NEW_WS, isNew)).toMatch(/plain segments/u);
    expect(checkImportedKey(`round/verification/${VICTIM}/${NEW_ROW}`, NEW_WS, isNew)).toMatch(
      /does not name the new workspace/u,
    );
    expect(checkImportedKey(`round/${NEW_WS}/${VICTIM}`, NEW_WS, isNew)).toMatch(
      new RegExp(`names ${VICTIM}`, "u"),
    );
    expect(
      checkImportedKey(`round/${NEW_WS}/${VICTIM.replaceAll("-", "")}`, NEW_WS, isNew),
    ).toMatch(/neither the new workspace nor a row of this import/u);
    expect(checkImportedKey("", NEW_WS, isNew)).toMatch(/empty/u);
    expect(checkImportedKey(`ws/${NEW_WS}/${"x".repeat(1100)}`, NEW_WS, isNew)).toMatch(
      /too long/u,
    );
  });

  it("blob values are exactly blob:<64 lower-case hex>", () => {
    expect(BLOB_VALUE_RE.test(`blob:${SHA}`)).toBe(true);
    for (const v of [`blob:${SHA.toUpperCase()}`, `blob:${SHA}x`, `ws/${VICTIM}/x`, "blob:", SHA])
      expect(BLOB_VALUE_RE.test(v)).toBe(false);
  });
});

describe("collectUuids / scrubForeign", () => {
  it("collects uuid values and keys at any depth, and only whole-string uuids", () => {
    const into = new Set<string>();
    collectUuids(
      { a: VICTIM.toUpperCase(), b: [NEW_ROW, { [NEW_WS]: 1 }], c: `x-${VICTIM}`, d: 7 },
      into,
    );
    expect([...into].sort()).toEqual([NEW_WS, NEW_ROW, VICTIM].sort());
  });

  it("nulls strings, drops array elements and object keys that are foreign, and counts them", () => {
    const foreign = new Map([[VICTIM, "core.group"]]);
    const { value, cleared } = scrubForeign(
      {
        groupId: VICTIM,
        groups: [NEW_ROW, VICTIM.toUpperCase()],
        byId: { [VICTIM]: true, [NEW_ROW]: false },
        keep: `note about ${VICTIM}`,
      },
      foreign,
    );
    expect(value).toEqual({
      groupId: null,
      groups: [NEW_ROW],
      byId: { [NEW_ROW]: false },
      keep: `note about ${VICTIM}`,
    });
    expect(cleared).toBe(3);
    expect(scrubForeign(VICTIM, foreign)).toEqual({ value: null, cleared: 1 });
    expect(scrubForeign([1, "a"], foreign)).toEqual({ value: [1, "a"], cleared: 0 });
  });
});
