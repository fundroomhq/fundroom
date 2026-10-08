import { describe, expect, it } from "vitest";
import { dataRoomModule } from "../index.js";
import { childPath } from "../model.js";
import { VEILED, veilOf } from "./access.js";
import {
  ensureVaultFolder,
  JOB_VAULT,
  VAULT_MAX_SEGMENTS,
  type VaultFolder,
  type VaultFolderOps,
  vaultFolderOf,
  vaultPathSegments,
  vaultTitles,
} from "./vault.js";

describe("vaultPathSegments", () => {
  it("splits the hint on slashes, trims, collapses whitespace and drops empty segments", () => {
    expect(vaultPathSegments("Signed documents/Seed round")).toEqual([
      "Signed documents",
      "Seed round",
    ]);
    expect(vaultPathSegments("  /Signed   documents//NDAs/ ")).toEqual([
      "Signed documents",
      "NDAs",
    ]);
    expect(vaultPathSegments("a\u0000b/\tc\n")).toEqual(["a b", "c"]);
  });

  it("answers no segments for a missing or blank hint (the job then skips)", () => {
    expect(vaultPathSegments(null)).toEqual([]);
    expect(vaultPathSegments(undefined)).toEqual([]);
    expect(vaultPathSegments(" / // ")).toEqual([]);
  });

  it("bounds each name to the folder column and the depth", () => {
    const long = "x".repeat(250);
    expect(vaultPathSegments(long)[0]).toHaveLength(200);
    const deep = Array.from({ length: 20 }, (_, i) => `f${i}`).join("/");
    expect(vaultPathSegments(deep)).toHaveLength(VAULT_MAX_SEGMENTS);
  });
});

describe("vaultTitles", () => {
  it("suffixes the envelope title and derives safe PDF file names", () => {
    expect(vaultTitles("SAFE — Jane Investor")).toEqual({
      signed: "SAFE — Jane Investor — signed",
      certificate: "SAFE — Jane Investor — certificate",
      signedFile: "SAFE — Jane Investor (signed).pdf",
      certificateFile: "SAFE — Jane Investor (certificate).pdf",
    });
    expect(vaultTitles('a/b\\c:"d"').signedFile).toBe("a_b_c__d_ (signed).pdf");
  });

  it("keeps titles within the 300-character column and falls back on a blank title", () => {
    const t = vaultTitles("y".repeat(400));
    expect(t.signed).toHaveLength(300);
    expect(t.signed.endsWith(" — signed")).toBe(true);
    expect(t.certificate).toHaveLength(300);
    expect(t.signedFile.length).toBeLessThanOrEqual(255);
    expect(vaultTitles("  \n ").signed).toBe("Signed document — signed");
  });
});

describe("vaultFolderOf", () => {
  it("reads the envelope's vault folder hint, or null", () => {
    expect(vaultFolderOf({ vaultFolder: null })).toBeNull();
    expect(vaultFolderOf({ vaultFolder: "Signed documents/NDAs" })).toBe("Signed documents/NDAs");
  });
});

/** An in-memory folder tree with the ops the service binds to a transaction. */
function fakeTree(existing: { parent: string; name: string; staffOnly?: boolean }[] = []) {
  const root: VaultFolder = { id: "root", path: "r", name: "Data room", staffOnly: false };
  const byId = new Map<string, VaultFolder & { parentId: string | null }>([
    ["root", { ...root, parentId: null }],
  ]);
  let n = 0;
  const log: string[] = [];
  const add = (parent: VaultFolder, name: string, staffOnly: boolean) => {
    n += 1;
    const id = `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;
    const f = { id, path: childPath(parent.path, id), name, staffOnly, parentId: parent.id };
    byId.set(id, f);
    return f;
  };
  for (const e of existing) {
    const parent = [...byId.values()].find((f) => f.name === e.parent) ?? root;
    add(parent, e.name, e.staffOnly ?? false);
  }
  const ops: VaultFolderOps = {
    async child(parent, name) {
      return [...byId.values()].find(
        (f) => f.parentId === parent.id && f.name.toLowerCase() === name.toLowerCase(),
      );
    },
    async create(parent, name, staffOnly) {
      log.push(`create ${name}${staffOnly ? " staff-only" : ""}`);
      return add(parent, name, staffOnly);
    },
    async flagStaffOnly(folder) {
      log.push(`flag ${folder.name}`);
      const f = { ...(byId.get(folder.id) as VaultFolder & { parentId: string }), staffOnly: true };
      byId.set(folder.id, f);
      return f;
    },
  };
  return { root, ops, log, byId };
}

describe("ensureVaultFolder", () => {
  it("creates a missing path with the first new folder staff-only (its subtree is veiled)", async () => {
    const t = fakeTree();
    const out = await ensureVaultFolder(t.ops, t.root, ["Signed documents", "Seed round"]);
    expect(t.log).toEqual(["create Signed documents staff-only", "create Seed round"]);
    expect(out.created.map((f) => f.name)).toEqual(["Signed documents", "Seed round"]);
    expect(out.flagged).toBeUndefined();
    expect(out.leaf.name).toBe("Seed round");
    expect(
      veilOf(out.created.filter((f) => f.staffOnly).map((f) => f.path)).covers(out.leaf.path),
    ).toBe(true);
  });

  it("reuses existing folders by case-insensitive name and adds only what is missing", async () => {
    const t = fakeTree([{ parent: "Data room", name: "Signed Documents", staffOnly: true }]);
    const out = await ensureVaultFolder(t.ops, t.root, ["signed documents", "NDAs"]);
    // Already covered by the staff-only parent: the new child needs no flag of its own.
    expect(t.log).toEqual(["create NDAs"]);
    expect(out.created).toHaveLength(1);
  });

  it("creates the new segment staff-only under an existing ordinary folder, leaving that one alone", async () => {
    const t = fakeTree([{ parent: "Data room", name: "Signed documents" }]);
    const out = await ensureVaultFolder(t.ops, t.root, ["Signed documents", "Seed round"]);
    expect(t.log).toEqual(["create Seed round staff-only"]);
    expect(out.flagged).toBeUndefined();
    expect([...t.byId.values()].find((f) => f.name === "Signed documents")?.staffOnly).toBe(false);
  });

  it("fails closed when the whole path exists and nothing on it is staff-only: flags the leaf", async () => {
    const t = fakeTree([
      { parent: "Data room", name: "Signed documents" },
      { parent: "Signed documents", name: "NDAs" },
    ]);
    const out = await ensureVaultFolder(t.ops, t.root, ["Signed documents", "NDAs"]);
    expect(t.log).toEqual(["flag NDAs"]);
    expect(out.created).toEqual([]);
    expect(out.flagged?.name).toBe("NDAs");
    expect(out.leaf.staffOnly).toBe(true);
  });

  it("refuses an empty path", async () => {
    const t = fakeTree();
    await expect(ensureVaultFolder(t.ops, t.root, [])).rejects.toThrow(/no path segments/u);
  });
});

describe("the staff-only veil", () => {
  it("covers the staff-only folder and everything below it, nothing beside it", () => {
    const veil = veilOf(["r.aa", "r.bb.cc"]);
    expect(veil.covers("r.aa")).toBe(true);
    expect(veil.covers("r.aa.dd.ee")).toBe(true);
    expect(veil.covers("r.bb.cc.x")).toBe(true);
    expect(veil.covers("r.bb")).toBe(false);
    expect(veil.covers("r.aab")).toBe(false);
    expect(veil.covers("r")).toBe(false);
    expect(veilOf([]).covers("r.aa")).toBe(false);
  });

  it("answers a veiled node exactly like no grant (a 404, never a 403 that confirms it exists)", () => {
    expect(VEILED).toEqual({
      allowed: false,
      capabilities: [],
      pendingGates: [],
      reason: "no_grant",
    });
    expect(Object.isFrozen(VEILED)).toBe(true);
  });
});

describe("manifest wiring (E3.5)", () => {
  it("handles esign.envelope_completed and emits document.vaulted", () => {
    expect(dataRoomModule.events?.handles?.["esign.envelope_completed"]).toBeTypeOf("function");
    expect(dataRoomModule.events?.emits).toContain("document.vaulted");
    expect(JOB_VAULT).toBe("data-room.vault");
  });
});
