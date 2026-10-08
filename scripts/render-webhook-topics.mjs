#!/usr/bin/env node
// Renders the webhook topic table in docs/api/webhooks.md from the code (E3.4):
// the topics every compiled-in manifest offers (`ModuleManifest.webhooks`, through the module
// registry), their descriptions and payload fields (`EVENT_CATALOGUE`), and whether a topic is
// person-level (`PERSON_LEVEL_WEBHOOK_TOPICS`).
//
//   node scripts/render-webhook-topics.mjs           # rewrite the generated block
//   node scripts/render-webhook-topics.mjs --check   # exit 1 when the committed block is stale
//
// Imports from dist, like render-authz-matrix.mjs: run `pnpm build` (or `pnpm typecheck`) first.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DOC = fileURLToPath(new URL("../docs/api/webhooks.md", import.meta.url));
export const BEGIN_MARK =
  "<!-- BEGIN GENERATED: webhook topics (node scripts/render-webhook-topics.mjs) -->";
export const END_MARK = "<!-- END GENERATED: webhook topics -->";

/**
 * @typedef {object} TopicEntry
 * @property {string} topic
 * @property {string} moduleId
 * @property {string} description
 * @property {readonly string[]} fields  top-level keys of the event payload (`data`)
 * @property {number} schemaVersion
 * @property {boolean} personLevel
 */

/** @param {string} text */
const cell = (text) => text.replace(/\s+/gu, " ").replace(/\|/gu, "\\|").trim();

/**
 * The markdown between the markers: one table, grouped by module, topics sorted by name.
 * @param {readonly TopicEntry[]} entries
 */
export function renderTopicsBlock(entries) {
  const sorted = [...entries].sort(
    (a, b) => a.moduleId.localeCompare(b.moduleId) || a.topic.localeCompare(b.topic),
  );
  const lines = [
    "| Topic | Module | When | `data` fields | Person-level |",
    "|---|---|---|---|---|",
  ];
  for (const e of sorted) {
    const fields = e.fields.map((f) => `\`${f}\``).join(", ");
    lines.push(
      `| \`${e.topic}\` | \`${e.moduleId}\` | ${cell(e.description)} | ${fields} | ${e.personLevel ? "yes" : "no"} |`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {string} doc current document text
 * @param {string} block generated markdown
 */
export function replaceBlock(doc, block) {
  const start = doc.indexOf(BEGIN_MARK);
  const end = doc.indexOf(END_MARK);
  if (start < 0 || end < start) {
    throw new Error("docs/api/webhooks.md is missing the generated-block markers");
  }
  return `${doc.slice(0, start + BEGIN_MARK.length)}\n${block}\n${doc.slice(end)}`;
}

/**
 * Fallback for the outbound projection of `data` while `@fundroom/webhooks` does not export
 * `projectWebhookData`: session identifiers never go to a third party.
 */
export const DEFAULT_STRIPPED_FIELDS = Object.freeze(["sessionId", "userId"]);

/**
 * Top-level payload keys of a catalogue entry (zod object schemas expose `.shape`).
 * @param {unknown} schema
 * @returns {string[]}
 */
function payloadFields(schema) {
  const shape = /** @type {{ shape?: Record<string, unknown> }} */ (schema).shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

/** @returns {Promise<TopicEntry[]>} the topics a workspace can subscribe to, from the built code */
export async function loadTopicEntries() {
  const [{ createModuleRegistry }, { EVENT_CATALOGUE }, webhookTypes, server] = await Promise.all([
    import("../packages/module-kit/dist/index.js"),
    import("../packages/domain/dist/index.js"),
    import("../packages/webhooks/dist/index.js"),
    import("../apps/server/dist/modules.js"),
  ]);
  const { PERSON_LEVEL_WEBHOOK_TOPICS } = webhookTypes;
  // The fields a receiver actually gets: run the real outbound projection over the keys, so the
  // table can never list a field the server withholds.
  /** @type {(fields: string[]) => string[]} */
  const delivered =
    typeof webhookTypes.projectWebhookData === "function"
      ? (fields) =>
          Object.keys(
            webhookTypes.projectWebhookData(Object.fromEntries(fields.map((f) => [f, null]))),
          )
      : (fields) => fields.filter((f) => !DEFAULT_STRIPPED_FIELDS.includes(f));
  const registry = createModuleRegistry(server.COMPILED_IN_MODULES);
  /** @type {Record<string, { description: string; payload: unknown; schemaVersion: number }>} */
  const catalogue = EVENT_CATALOGUE;
  return registry.webhookTopics().map((/** @type {{ topic: string; moduleId: string }} */ t) => {
    const def = catalogue[t.topic];
    if (!def) throw new Error(`webhook topic ${t.topic} is not in EVENT_CATALOGUE`);
    return {
      topic: t.topic,
      moduleId: t.moduleId,
      description: def.description,
      fields: delivered(payloadFields(def.payload)),
      schemaVersion: def.schemaVersion,
      personLevel: PERSON_LEVEL_WEBHOOK_TOPICS.includes(t.topic),
    };
  });
}

/** @returns {Promise<string>} the full expected document */
export async function renderDoc() {
  return replaceBlock(readFileSync(DOC, "utf8"), renderTopicsBlock(await loadTopicEntries()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = await renderDoc();
  if (process.argv.includes("--check")) {
    if (readFileSync(DOC, "utf8") !== expected) {
      console.error(
        "docs/api/webhooks.md topic table is stale: run `node scripts/render-webhook-topics.mjs` and commit the result.",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(DOC, expected);
    process.stdout.write(`wrote ${DOC}\n`);
  }
}
