import type { AppConfig } from "@fundroom/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWorkspaceExport,
  runWorkspaceImport,
  runWorkspaceVerifyExport,
  WORKSPACE_PORTABILITY_USAGE,
  workspaceUsageLine,
} from "./workspace-portability.js";
import { WORKSPACE_USAGE } from "./workspace-restore.js";

/* The usage text of `fundroom workspace export | import | verify-export` (no config needed). */

afterEach(() => {
  vi.restoreAllMocks();
});

async function usageOf(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const code = await run();
  return { code, text: lines.join("\n") };
}

describe("fundroom workspace usage", () => {
  it("prints one well-formed usage line per subcommand when arguments are missing (exit 2)", async () => {
    const cfg = {} as AppConfig; // never touched: the usage check comes first
    expect(await usageOf(() => runWorkspaceExport([], cfg))).toEqual({
      code: 2,
      text: "usage: fundroom workspace export <slug|id> --out <file.zip> [--include-raw-analytics]",
    });
    const imp = await usageOf(() => runWorkspaceImport(["x.zip"], cfg));
    expect(imp.code).toBe(2);
    expect(imp.text).toMatch(/^usage: fundroom workspace import <file\.zip> --slug <new-slug> /u);
    expect(await usageOf(() => runWorkspaceVerifyExport([]))).toEqual({
      code: 2,
      text: "usage: fundroom workspace verify-export <file.zip> [--public-key <base64>]...",
    });
  });

  it("never prints a double space, and the combined usage lists every subcommand indented", () => {
    for (const i of [0, 1, 2] as const) {
      expect(workspaceUsageLine(i)).not.toMatch(/ {2}/u);
      expect(workspaceUsageLine(i)).toMatch(/^usage: fundroom workspace [a-z-]+ /u);
    }
    for (const line of WORKSPACE_PORTABILITY_USAGE.split("\n")) expect(line).toMatch(/^ {2}\S/u);
    expect(WORKSPACE_USAGE.split("\n").map((l) => l.trim().split(" ")[0])).toEqual([
      "usage:",
      "restore",
      "export",
      "import",
      "verify-export",
      "move",
    ]);
  });
});
