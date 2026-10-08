import { describe, expect, it, vi } from "vitest";
import type { Database } from "./database.js";
import { createWorkspaceResolver, deleteWorkspace, type ResolvedWorkspace } from "./workspace.js";

/*
 * Resolver behaviour over a fake Database: single mode caches the sole workspace,
 * multi mode resolves only by slug. The real queries are covered by the integration suite.
 */
function fakeDb(rows: ResolvedWorkspace[]): { db: Database; calls: () => number } {
  let calls = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => rows }),
          limit: async () => rows,
        }),
      }),
    }),
  };
  const db = {
    withHost: async (fn: (t: unknown, c: unknown) => Promise<unknown>) => {
      calls++;
      return fn(tx, { actorKind: "host" });
    },
  } as unknown as Database;
  return { db, calls: () => calls };
}

const acme: ResolvedWorkspace = {
  id: "01920000-0000-7000-8000-000000000001",
  slug: "acme",
  name: "Acme",
  offeringStatus: "none",
  settings: {},
  settingsSchemaVersion: 1,
  aclVersion: 0,
  defaultLocale: "en",
  ssoEnforced: false,
  ssoConnectionId: null,
  ssoConnectionVersion: null,
  cellId: "default",
  dataRegion: null,
  status: "active",
  suspendedReason: null,
  planId: null,
  primaryHost: null,
  planLimits: null,
};

describe("createWorkspaceResolver", () => {
  it("single mode returns the sole workspace regardless of slug and caches it", async () => {
    const { db, calls } = fakeDb([acme]);
    let now = 1_000;
    const r = createWorkspaceResolver(db, "single", { cacheMs: 100, now: () => now });
    expect(await r.resolve("whatever")).toEqual(acme);
    expect(await r.resolve()).toEqual(acme);
    expect(calls()).toBe(1);
    now += 101;
    await r.resolve();
    expect(calls()).toBe(2);
  });

  it("single mode returns undefined before setup and does not cache the miss", async () => {
    const { db, calls } = fakeDb([]);
    const r = createWorkspaceResolver(db, "single");
    expect(await r.resolve()).toBeUndefined();
    expect(await r.resolve()).toBeUndefined();
    expect(calls()).toBe(2);
  });

  it("single mode throws when more than one workspace exists", async () => {
    const { db } = fakeDb([
      acme,
      { ...acme, id: "01920000-0000-7000-8000-000000000002", slug: "b" },
    ]);
    await expect(createWorkspaceResolver(db, "single").resolve()).rejects.toThrow(
      /TENANCY_MODE=multi/u,
    );
  });

  it("multi mode needs a slug", async () => {
    const { db, calls } = fakeDb([acme]);
    const r = createWorkspaceResolver(db, "multi");
    expect(await r.resolve()).toBeUndefined();
    expect(calls()).toBe(0);
    expect(await r.resolve("ACME")).toEqual(acme);
    expect(await r.resolve("  ")).toBeUndefined();
    vi.restoreAllMocks();
  });
});

/*
 * A soft delete drops both caches (E2.1 M9).
 *
 * `core.custom_domain` rows are *not* deleted with the workspace — the retention window keeps
 * them — and `findIssuableByHostname` excludes a deleted workspace only on a fresh read. So the
 * one thing that can still route a closed portal, and still have `ask` answer 200 so a
 * certificate is minted for it, is a cached entry. The contract listed three transitions that
 * invalidate (activate / demote / remove); this is the fourth nobody listed.
 */
describe("deleteWorkspace", () => {
  function deletingDb(affected: number): Database {
    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => Array.from({ length: affected }, () => ({ id: acme.id })),
          }),
        }),
      }),
    };
    return {
      withHost: async (fn: (t: unknown, c: unknown) => Promise<unknown>) =>
        fn(tx, { actorKind: "host" }),
    } as unknown as Database;
  }

  it("invalidates the hostname lookup and the workspace resolver", async () => {
    const lookup = vi.fn();
    const workspaces = vi.fn();
    expect(
      await deleteWorkspace(deletingDb(1), acme.id, {
        lookup: { invalidate: lookup },
        workspaces: { invalidate: workspaces },
      }),
    ).toBe(true);
    // No hostname argument: a workspace may hold several and this path knows none of them.
    expect(lookup).toHaveBeenCalledWith();
    expect(workspaces).toHaveBeenCalledTimes(1);
  });

  it("invalidates nothing when the workspace was already gone", async () => {
    const lookup = vi.fn();
    const workspaces = vi.fn();
    expect(
      await deleteWorkspace(deletingDb(0), acme.id, {
        lookup: { invalidate: lookup },
        workspaces: { invalidate: workspaces },
      }),
    ).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(workspaces).not.toHaveBeenCalled();
  });
});
