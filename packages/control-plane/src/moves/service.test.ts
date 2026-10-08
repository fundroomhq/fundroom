import type { Database } from "@fundroom/db";
import type { DirectoryCell, DirectoryMove, DirectoryPort } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  carriedHolds,
  type MoveDeps,
  MoveError,
  moveView,
  requestMove,
  targetRefusal,
} from "./service.js";

const NOW = new Date("2026-09-29T12:00:00Z");

function cell(over: Partial<DirectoryCell> = {}): DirectoryCell {
  return {
    id: "us-1",
    region: "us",
    regionLabel: "United States",
    jurisdiction: "us",
    publicOrigin: "https://us.example.test",
    status: "active",
    exportPublicKey: "k",
    heartbeatAt: new Date(NOW.getTime() - 60_000),
    local: false,
    ...over,
  };
}

describe("targetRefusal", () => {
  it("accepts an active, remote, recently heard-from cell", () => {
    expect(targetRefusal(cell(), NOW)).toBeNull();
  });
  it("refuses unknown, local, inactive and silent cells", () => {
    expect(targetRefusal(undefined, NOW)).toBe("target_unknown");
    expect(targetRefusal(cell({ local: true }), NOW)).toBe("target_local");
    expect(targetRefusal(cell({ status: "draining" }), NOW)).toBe("target_inactive");
    expect(targetRefusal(cell({ heartbeatAt: null }), NOW)).toBe("target_stale");
    expect(targetRefusal(cell({ heartbeatAt: new Date(NOW.getTime() - 16 * 60_000) }), NOW)).toBe(
      "target_stale",
    );
  });
});

describe("carriedHolds", () => {
  it("carries every hold but relocation, deduplicated and sorted", () => {
    expect(carriedHolds(["relocation", "sanctions", "billing", "billing", "bogus"])).toEqual([
      "billing",
      "sanctions",
    ]);
  });
});

describe("moveView", () => {
  it("never exposes the bundle, the carried facts or the lease", () => {
    const move: DirectoryMove = {
      id: "0190f000-0000-7000-8000-000000000001",
      entryId: "0190f000-0000-7000-8000-000000000002",
      sourceWorkspaceId: "0190f000-0000-7000-8000-000000000003",
      slug: "acme",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      state: "exported",
      bundle: {
        url: "https://s3.example.test/x?X-Amz-Signature=secret",
        sha256: "a".repeat(64),
        bytes: 10,
        expiresAt: NOW.toISOString(),
        signerKeyFingerprint: "k1",
      },
      carried: {
        planId: "pro",
        legalName: "Acme Ltd",
        country: "DE",
        holds: [],
        transferKey: "c2VjcmV0",
      },
      targetWorkspaceId: null,
      leaseOwner: "eu-1:x",
      leaseExpiresAt: NOW,
      error: null,
      requestedBy: "op:u",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const view = moveView(move, [cell(), cell({ id: "eu-1", region: "eu", local: true })]);
    expect(view).toEqual({
      id: move.id,
      workspaceId: move.sourceWorkspaceId,
      slug: "acme",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      sourceRegion: "eu",
      targetRegion: "us",
      state: "exported",
      error: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Acme Ltd");
    expect(text).not.toContain("c2VjcmV0");
  });
});

describe("requestMove refusals before any database work", () => {
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error("the database must not be touched");
      },
    },
  ) as Database;
  const base = {
    db: unused,
    audit: { record: async () => undefined } as unknown as MoveDeps["audit"],
    cellId: "eu-1",
    invalidate: () => {},
    now: () => NOW,
  };
  const input = {
    workspaceId: "0190f000-0000-7000-8000-000000000003",
    targetCellId: "us-1",
    confirmSlug: "acme",
    actor: { kind: "system", source: "cli" } as const,
    requestedBy: "cli:t",
  };

  it("local mode → move_unavailable no_directory", async () => {
    const directory = { mode: "local" } as unknown as DirectoryPort;
    const error = await requestMove({ ...base, directory }, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MoveError);
    expect(error).toMatchObject({ code: "move_unavailable", reason: "no_directory" });
  });

  it("an object store that cannot presign → move_unavailable storage", async () => {
    const directory = { mode: "shared" } as unknown as DirectoryPort;
    const error = await requestMove({ ...base, directory, canPresign: false }, input).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "move_unavailable", reason: "storage" });
  });
});
