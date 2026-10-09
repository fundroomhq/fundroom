// node --test scripts/release/check-changesets.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import { changesetPackages, coreGroup, findProblems, readChangesets } from "./check-changesets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CORE = ["@fundroom/server", "@fundroom/web", "@fundroom/config"];

test("reads the package names from the front matter", () => {
  assert.deepEqual(
    changesetPackages(
      "---\n\"@fundroom/server\": minor\n'@fundroom/web': patch\nplain: major\n---\n\nText: with a colon\n",
    ),
    ["@fundroom/server", "@fundroom/web", "plain"],
  );
  assert.deepEqual(changesetPackages("---\n---\n\nEmpty changeset.\n"), []);
  assert.throws(() => changesetPackages("no front matter"));
  assert.throws(() => changesetPackages('---\n"@fundroom/server": huge\n---\n'));
});

test("a changeset naming only packages outside the fixed group fails; core or empty passes", () => {
  const problems = findProblems(
    {
      "embed.md": '---\n"@fundroom/embed": minor\n---\n\nx\n',
      "module.md":
        '---\n"@fundroom/module-data-room": patch\n"@fundroom/compliance": minor\n---\n\nx\n',
      "mixed.md": '---\n"@fundroom/embed": minor\n"@fundroom/server": patch\n---\n\nx\n',
      "core.md": '---\n"@fundroom/web": patch\n---\n\nx\n',
      "empty.md": "---\n---\n\nx\n",
      "broken.md": "nothing\n",
    },
    CORE,
  );
  assert.deepEqual(
    problems.map((p) => p.file),
    ["embed.md", "module.md", "broken.md"],
  );
});

test("comments are ignored and a core entry bumped `none` does not count", () => {
  assert.deepEqual(
    changesetPackages(
      '---\n# a comment line\n"@fundroom/server": patch # trailing comment\n  # indented comment\n---\n',
    ),
    ["@fundroom/server"],
  );
  const problems = findProblems(
    {
      "commented.md": '---\n# only a comment\n"@fundroom/web": minor # why\n---\n\nx\n',
      "none.md": '---\n"@fundroom/server": none\n"@fundroom/embed": minor\n---\n\nx\n',
      "comment-only.md": "---\n# nothing here\n---\n\nx\n",
    },
    CORE,
  );
  assert.deepEqual(
    problems.map((p) => p.file),
    ["none.md"],
  );
});

test("the repository's own changesets all bump the core", () => {
  const dir = join(here, "..", "..", ".changeset");
  assert.deepEqual(findProblems(readChangesets(dir), coreGroup(dir)), []);
});

test("pre mode: only pending changesets are read, never the consumed ones in .changeset/pre/", () => {
  // Changesets v3 moves a changeset consumed by a prerelease version into .changeset/pre/ and
  // keeps the mode in .changeset/pre.json. Those were checked when they landed.
  const dir = mkdtempSync(join(tmpdir(), "check-changesets-"));
  try {
    mkdirSync(join(dir, "pre"));
    writeFileSync(join(dir, "pre.json"), '{ "mode": "pre", "tag": "rc" }\n');
    writeFileSync(join(dir, "README.md"), "# Changesets\n");
    writeFileSync(join(dir, "pending.md"), '---\n"@fundroom/server": patch\n---\n\nx\n');
    writeFileSync(join(dir, "pre", "consumed.md"), '---\n"@fundroom/embed": patch\n---\n\nx\n');
    assert.deepEqual(Object.keys(readChangesets(dir)), ["pending.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
