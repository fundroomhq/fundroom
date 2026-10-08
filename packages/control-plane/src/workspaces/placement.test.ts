import { describe, expect, it } from "vitest";
import {
  isPlacementError,
  newWorkspaceId,
  type PlacementDirectory,
  withSlugClaim,
} from "./placement.js";

/** A recording directory: `claim` is what `claimSlug` answers (or throws). */
function fakeDirectory(claim: "claimed" | "taken" | Error) {
  const calls: string[] = [];
  const directory: PlacementDirectory = {
    mode: "shared",
    async claimSlug(input) {
      calls.push(`claim ${input.slug} ${input.cellId} ${input.workspaceId}`);
      if (claim instanceof Error) throw claim;
      return claim;
    },
    async activate(id) {
      calls.push(`activate ${id}`);
    },
    async release(id) {
      calls.push(`release ${id}`);
    },
    async lookupSlug() {
      return null;
    },
  };
  return { directory, calls };
}

describe("newWorkspaceId", () => {
  it("is a time-ordered UUIDv7", () => {
    const a = newWorkspaceId(1_700_000_000_000);
    const b = newWorkspaceId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(a < b).toBe(true);
    expect(a.slice(0, 13)).toBe("018bcfe5-6800");
  });
});

describe("withSlugClaim", () => {
  it("claims before creating (same id), then activates after", async () => {
    const { directory, calls } = fakeDirectory("claimed");
    const created: string[] = [];
    const out = await withSlugClaim(directory, { slug: " Acme ", cellId: "eu-1" }, async (id) => {
      calls.push(`create ${id}`);
      created.push(id);
      return "ok";
    });
    expect(out).toBe("ok");
    const id = created[0] as string;
    expect(calls).toEqual([`claim acme eu-1 ${id}`, `create ${id}`, `activate ${id}`]);
  });

  it("a taken slug creates nothing and is slug_taken without naming the holder", async () => {
    const { directory, calls } = fakeDirectory("taken");
    let ran = false;
    const error = await withSlugClaim(directory, { slug: "acme", cellId: "eu-1" }, async () => {
      ran = true;
    }).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(isPlacementError(error) && error.reason).toBe("slug_taken");
    expect((error as Error).message).toBe('the address "acme" is taken');
    expect(calls).toHaveLength(1);
  });

  it("an unreachable directory creates nothing (directory_unavailable)", async () => {
    const { directory } = fakeDirectory(new Error("ECONNREFUSED 10.0.0.9"));
    let ran = false;
    const error = await withSlugClaim(directory, { slug: "acme", cellId: "eu-1" }, async () => {
      ran = true;
    }).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(isPlacementError(error) && error.reason).toBe("directory_unavailable");
    expect((error as Error).message).not.toContain("10.0.0.9");
  });

  it("releases the claim when the creation fails, and rethrows its error", async () => {
    const { directory, calls } = fakeDirectory("claimed");
    const boom = new Error("unique violation");
    const error = await withSlugClaim(
      directory,
      { slug: "acme", cellId: "eu-1", workspaceId: "w-1" },
      async () => {
        throw boom;
      },
    ).catch((e: unknown) => e);
    expect(error).toBe(boom);
    expect(calls).toEqual(["claim acme eu-1 w-1", "release w-1"]);
  });

  it("a failed activation after the commit is logged, not thrown (the sweep repairs it)", async () => {
    const { directory } = fakeDirectory("claimed");
    const logged: string[] = [];
    const flaky: PlacementDirectory = {
      ...directory,
      async activate() {
        throw new Error("timeout");
      },
    };
    const out = await withSlugClaim(
      flaky,
      { slug: "acme", cellId: "eu-1", log: (event) => logged.push(event) },
      async () => 42,
    );
    expect(out).toBe(42);
    expect(logged).toEqual(["directory.activate_failed"]);
  });

  it("without a directory it just creates, with a fresh id", async () => {
    const id = await withSlugClaim(undefined, { slug: "acme", cellId: "x" }, async (i) => i);
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
