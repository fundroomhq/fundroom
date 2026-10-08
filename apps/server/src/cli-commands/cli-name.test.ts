import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_NAME, LEGACY_CLI_NAME, LEGACY_CLI_NOTE, legacyCliNote } from "./cli-name.js";

describe("CLI name (A-2)", () => {
  it("prints the rename note only when invoked as `seedhost`", () => {
    expect(legacyCliNote("/usr/local/bin/seedhost")).toBe(LEGACY_CLI_NOTE);
    expect(legacyCliNote("/opt/fundroom/bin/seedhost.js")).toBe(LEGACY_CLI_NOTE);
    expect(legacyCliNote("/usr/local/bin/fundroom")).toBeUndefined();
    expect(legacyCliNote("/app/dist/cli.js")).toBeUndefined();
    expect(legacyCliNote(undefined)).toBeUndefined();
    expect(LEGACY_CLI_NOTE).toBe(
      "`seedhost` is now `fundroom`; the old name is removed in the next minor release.",
    );
  });

  it("ships both bin names, pointing at the same file", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string> };
    expect(pkg.bin[CLI_NAME]).toBe("./dist/cli.js");
    expect(pkg.bin[LEGACY_CLI_NAME]).toBe(pkg.bin[CLI_NAME]);
  });
});
