import { isApiError } from "@fundroom/contracts";
import type { Database } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { createLocalDirectory } from "./local.js";

describe("local directory (E3.11)", () => {
  const dir = createLocalDirectory({ db: {} as Database });

  it("claims always succeed and lookups find nothing", async () => {
    expect(dir.mode).toBe("local");
    expect(await dir.claimSlug({ workspaceId: "w", slug: "acme", cellId: "default" })).toBe(
      "claimed",
    );
    expect(await dir.renameSlug({ workspaceId: "w", to: "acme-2" })).toBe("renamed");
    expect(await dir.claimHost({ hostname: "ir.acme.com", workspaceId: "w" })).toBe("claimed");
    expect(await dir.lookupSlug("acme")).toBeNull();
    expect(await dir.lookupHost("ir.acme.com")).toBeNull();
    expect(await dir.lookupWorkspace("w")).toBeNull();
  });

  it("moves are unavailable", async () => {
    await expect(dir.moves.get("m")).rejects.toSatisfy((e) => isApiError(e, "move_unavailable"));
  });
});
