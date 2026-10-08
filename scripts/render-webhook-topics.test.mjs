// node --test scripts/render-webhook-topics.test.mjs   (after `pnpm build`: the renderer reads dist/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BEGIN_MARK,
  DOC,
  END_MARK,
  loadTopicEntries,
  renderDoc,
  renderTopicsBlock,
  replaceBlock,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
} from "./render-webhook-topics.mjs";

/** @param {Partial<import("./render-webhook-topics.mjs").TopicEntry>} over */
const entry = (over) => ({
  topic: "x.y",
  moduleId: "m",
  description: "Something happened.",
  fields: ["id"],
  schemaVersion: 1,
  personLevel: false,
  ...over,
});

test("renders one row per topic, grouped by module then topic, cells escaped", () => {
  const block = renderTopicsBlock([
    entry({ topic: "b.two", moduleId: "zeta" }),
    entry({
      topic: "a.one",
      moduleId: "zeta",
      description: "Line one\n  line | two",
      personLevel: true,
    }),
    entry({ topic: "c.three", moduleId: "alpha", fields: ["aId", "bIds"] }),
  ]);
  const rows = block.split("\n");
  assert.equal(rows.length, 5);
  assert.match(rows[0] ?? "", /^\| Topic \| Module \|/u);
  assert.equal(rows[2], "| `c.three` | `alpha` | Something happened. | `aId`, `bIds` | no |");
  assert.equal(rows[3], "| `a.one` | `zeta` | Line one line \\| two | `id` | yes |");
  assert.match(rows[4] ?? "", /^\| `b\.two` \| `zeta` /u);
});

test("replaces only what sits between the markers and is idempotent", () => {
  const doc = `# T\n\nbefore\n${BEGIN_MARK}\nold\n${END_MARK}\nafter\n`;
  const once = replaceBlock(doc, "NEW");
  assert.equal(once, `# T\n\nbefore\n${BEGIN_MARK}\nNEW\n${END_MARK}\nafter\n`);
  assert.equal(replaceBlock(once, "NEW"), once);
  assert.throws(() => replaceBlock("# no markers\n", "NEW"), /markers/u);
});

test("the built registry offers every topic once, each in the event catalogue", async () => {
  const entries = await loadTopicEntries();
  const topics = entries.map((e) => e.topic);
  assert.equal(new Set(topics).size, topics.length);
  assert.ok(topics.length > 0);
  assert.ok(!topics.includes("webhook.ping"), "webhook.ping is never subscribable");
  for (const e of entries) {
    assert.ok(e.description.length > 0, `${e.topic} has a description`);
    assert.ok(e.fields.length > 0, `${e.topic} has payload fields`);
    assert.ok(!e.fields.some((f) => /session/iu.test(f)), `${e.topic} shows no session identifier`);
  }
  // The consent-gated topics are flagged (and only those).
  assert.deepEqual(
    entries
      .filter((e) => e.personLevel)
      .map((e) => e.topic)
      .sort(),
    ["document.downloaded", "document.viewed", "update.viewed"],
  );
});

test("docs/api/webhooks.md is current (run `node scripts/render-webhook-topics.mjs`)", async () => {
  assert.equal(readFileSync(DOC, "utf8"), await renderDoc());
});
