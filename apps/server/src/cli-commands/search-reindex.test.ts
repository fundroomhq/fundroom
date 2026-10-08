import { describe, expect, it } from "vitest";
import { parseSearchReindexArgs, SEARCH_USAGE } from "./search-reindex.js";

describe("fundroom search reindex: arguments", () => {
  it("accepts the subcommand alone or with --workspace / --module in any order", () => {
    expect(parseSearchReindexArgs(["reindex"])).toEqual({
      workspace: undefined,
      module: undefined,
    });
    expect(parseSearchReindexArgs(["reindex", "--workspace", "acme"])).toEqual({
      workspace: "acme",
      module: undefined,
    });
    expect(
      parseSearchReindexArgs(["reindex", "--module", "data-room", "--workspace", "acme"]),
    ).toEqual({ workspace: "acme", module: "data-room" });
  });

  it("refuses anything else (usage, exit 2)", () => {
    for (const argv of [
      [],
      ["rebuild"],
      ["reindex", "--workspace"],
      ["reindex", "--workspace", "--module", "x"],
      ["reindex", "--workspace", "a", "--workspace", "b"],
      ["reindex", "--all"],
      ["reindex", "acme"],
    ]) {
      expect(parseSearchReindexArgs(argv), argv.join(" ")).toBeUndefined();
    }
    expect(SEARCH_USAGE).toContain("fundroom search reindex");
  });
});
