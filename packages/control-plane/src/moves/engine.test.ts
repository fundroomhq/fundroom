import type { DirectoryCell, DirectoryMove } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { copyDiscardable, publishedKeyFor } from "./engine.js";

const WS = "0190f000-0000-7000-8000-00000000000a";
const OTHER = "0190f000-0000-7000-8000-00000000000b";

function move(state: DirectoryMove["state"], targetWorkspaceId: string | null): DirectoryMove {
  const at = new Date();
  return {
    id: "0190f000-0000-7000-8000-000000000001",
    entryId: "0190f000-0000-7000-8000-000000000002",
    sourceWorkspaceId: "0190f000-0000-7000-8000-000000000003",
    slug: "acme",
    sourceCellId: "eu-1",
    targetCellId: "us-1",
    state,
    bundle: null,
    carried: null,
    targetWorkspaceId,
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    requestedBy: "op:x",
    createdAt: at,
    updatedAt: at,
  };
}

describe("copyDiscardable (R1-1)", () => {
  it("discards only copies the directory disowns", () => {
    expect(copyDiscardable(null, WS)).toBe(true);
    expect(copyDiscardable(move("failed", WS), WS)).toBe(true);
    expect(copyDiscardable(move("cancelled", null), WS)).toBe(true);
    expect(copyDiscardable(move("imported", OTHER), WS)).toBe(true);
    // Never the adopted copy, never one a live move may still adopt.
    for (const state of ["importing", "imported", "switched", "retired"] as const) {
      expect(copyDiscardable(move(state, WS), WS)).toBe(false);
    }
    expect(copyDiscardable(move("importing", null), WS)).toBe(false);
  });
});

describe("publishedKeyFor (R1-6)", () => {
  const cell = (over: Partial<DirectoryCell> & Record<string, unknown>) =>
    ({
      id: "eu-1",
      region: "eu",
      regionLabel: "",
      jurisdiction: "eu",
      publicOrigin: "",
      status: "active",
      exportPublicKey: "current",
      heartbeatAt: null,
      local: false,
      ...over,
    }) as DirectoryCell;
  it("picks the published key matching the bundle's key id, else the current one", () => {
    const ring = [
      { keyId: "k2", publicKey: "current" },
      { keyId: "k1", publicKey: "older" },
    ];
    expect(publishedKeyFor(cell({ exportPublicKeys: ring }), "k1")).toBe("older");
    expect(publishedKeyFor(cell({ exportPublicKeys: ring }), "k9")).toBeNull();
    expect(publishedKeyFor(cell({}), "k1")).toBe("current");
    expect(publishedKeyFor(cell({ exportPublicKey: null }), "k1")).toBeNull();
  });
});
