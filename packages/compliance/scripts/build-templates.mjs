#!/usr/bin/env node
/*
 * Compiles `templates/*.md` into `src/generated/templates.ts`.
 *
 * The templates have to be readable at runtime from a distroless image that ships `dist/` and
 * nothing else, so they are compiled into a TypeScript module rather than read from disk. That
 * follows the repo's established "generated but committed" pattern (`packages/sdk/openapi.json`,
 * `docs/authz-matrix.md`): the artefact is in git so a reader can diff it, and a unit test
 * regenerates it in memory and fails if the two have drifted.
 *
 * Validation lives here rather than in the TypeScript source because this is the only place that
 * ever sees the Markdown: by the time anything imports the generated module, a malformed template
 * would already have been baked in. A template that breaks the contract fails the build loudly.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(here, "..", "templates");
export const OUTPUT_FILE = join(here, "..", "src", "generated", "templates.ts");

/**
 * The counsel-review banner, verbatim. Every template repeats it immediately after the
 * frontmatter; it is part of the contract, not decoration, and a template that has lost it is a
 * template somebody edited without reading `templates/README.md`.
 */
export const COUNSEL_BANNER = [
  "> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**",
  "> This document is an engineering starting point generated from public sources. It has not been",
  "> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it",
  "> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction",
  "> and delete this banner only after your lawyer has signed off.",
].join("\n");

/** Where a document surfaces (`templates/README.md`); wider than the database's audience enum. */
export const AUDIENCES = ["investor", "tenant-admin", "host", "public", "repo"];

/**
 * The merge-field contract from `templates/README.md`. Nothing outside this list is a merge
 * field; adding one means editing the README, this list and the context type in the same change.
 * `subProcessors`, `workspaceSubProcessors`, `retention`, `dataLocation` and `aiAssist` render as
 * blocks (tables, or a paragraph for `aiAssist`), everything else as a scalar.
 */
export const MERGE_FIELDS = [
  "company.name",
  "company.legalName",
  "company.jurisdiction",
  "company.address",
  "company.contactEmail",
  "company.dpoEmail",
  "portal.url",
  "portal.name",
  "workspace.dataRegion",
  "workspace.offeringStatus",
  "host.operator",
  "host.isManaged",
  "subProcessors",
  "workspaceSubProcessors",
  "retention",
  "dataLocation",
  "aiAssist",
  "effectiveDate",
  "version",
];

export const TABLE_FIELDS = [
  "subProcessors",
  "workspaceSubProcessors",
  "retention",
  "dataLocation",
  "aiAssist",
];

const REQUIRED_KEYS = [
  "id",
  "version",
  "title",
  "audience",
  "jurisdiction",
  "requiresAcceptance",
  "mergeFields",
];

class TemplateError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.name = "TemplateError";
  }
}

/**
 * A deliberately tiny YAML reader: the frontmatter contract is seven scalar-or-flow-sequence
 * keys, so a real parser would be a dependency bought for nothing. Anything it cannot read is an
 * error rather than a guess, which is the behaviour we want from a build step.
 */
function parseFrontmatter(file, text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new TemplateError(file, `frontmatter line is not \`key: value\`: ${line}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) throw new TemplateError(file, `unterminated list for \`${key}\``);
      const inner = value.slice(1, -1).trim();
      out[key] =
        inner.length === 0
          ? []
          : inner.split(",").map((v) => v.trim().replace(/^["']|["']$/gu, ""));
    } else if (value === "true" || value === "false") {
      out[key] = value === "true";
    } else if (/^-?\d+$/u.test(value)) {
      out[key] = Number(value);
    } else {
      out[key] = value.replace(/^["']|["']$/gu, "");
    }
  }
  return out;
}

/** Parses and validates one template file. Throws on anything the contract forbids. */
export function parseTemplate(file, source) {
  const text = source.replace(/\r\n/gu, "\n");
  if (!text.startsWith("---\n")) throw new TemplateError(file, "missing YAML frontmatter");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new TemplateError(file, "unterminated YAML frontmatter");
  const meta = parseFrontmatter(file, text.slice(4, end));
  const body = text.slice(end + 5).replace(/^\n+/u, "");

  for (const key of REQUIRED_KEYS) {
    if (!(key in meta)) throw new TemplateError(file, `frontmatter is missing \`${key}\``);
  }
  const extra = Object.keys(meta).filter((k) => !REQUIRED_KEYS.includes(k));
  if (extra.length > 0) throw new TemplateError(file, `unknown frontmatter key(s): ${extra}`);

  if (typeof meta.id !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(meta.id)) {
    throw new TemplateError(file, `\`id\` must be kebab-case: ${meta.id}`);
  }
  if (typeof meta.version !== "number" || !Number.isInteger(meta.version) || meta.version < 1) {
    throw new TemplateError(file, "`version` must be an integer >= 1");
  }
  if (typeof meta.title !== "string" || meta.title.length === 0) {
    throw new TemplateError(file, "`title` must be a non-empty string");
  }
  if (!AUDIENCES.includes(meta.audience)) {
    throw new TemplateError(file, `\`audience\` must be one of ${AUDIENCES}: ${meta.audience}`);
  }
  if (!Array.isArray(meta.jurisdiction) || meta.jurisdiction.length === 0) {
    throw new TemplateError(file, "`jurisdiction` must be a non-empty list");
  }
  for (const j of meta.jurisdiction) {
    if (!/^[a-z]{2,6}$/u.test(j)) throw new TemplateError(file, `bad jurisdiction code: ${j}`);
  }
  if (typeof meta.requiresAcceptance !== "boolean") {
    throw new TemplateError(file, "`requiresAcceptance` must be true or false");
  }
  if (!Array.isArray(meta.mergeFields)) {
    throw new TemplateError(file, "`mergeFields` must be a list");
  }

  if (!body.startsWith(COUNSEL_BANNER)) {
    throw new TemplateError(file, "the counsel-review banner must follow the frontmatter verbatim");
  }

  // The README's rule: `mergeFields` lists exactly what the body uses, no more and no less.
  const used = [...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/gu)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((f) => !MERGE_FIELDS.includes(f));
  if (unknown.length > 0) {
    throw new TemplateError(file, `\`{{...}}\` field(s) outside the contract: ${unknown}`);
  }
  const declared = new Set(meta.mergeFields);
  for (const f of meta.mergeFields) {
    if (!MERGE_FIELDS.includes(f)) {
      throw new TemplateError(file, `declared field outside the contract: ${f}`);
    }
  }
  const undeclared = [...new Set(used)].filter((f) => !declared.has(f));
  if (undeclared.length > 0) {
    throw new TemplateError(file, `used but not declared in \`mergeFields\`: ${undeclared}`);
  }
  const unused = meta.mergeFields.filter((f) => !used.includes(f));
  if (unused.length > 0) {
    throw new TemplateError(file, `declared in \`mergeFields\` but never used: ${unused}`);
  }

  return {
    id: meta.id,
    version: meta.version,
    title: meta.title,
    audience: meta.audience,
    jurisdiction: meta.jurisdiction,
    requiresAcceptance: meta.requiresAcceptance,
    mergeFields: meta.mergeFields,
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

/** Every template in `dir`, keyed by id and ordered by id so the generated file is stable. */
export function loadTemplates(dir = TEMPLATE_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  const byId = new Map();
  for (const file of files) {
    const template = parseTemplate(file, readFileSync(join(dir, file), "utf8"));
    if (byId.has(template.id)) throw new TemplateError(file, `duplicate id \`${template.id}\``);
    byId.set(template.id, template);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const HEADER = `// GENERATED by scripts/build-templates.mjs from templates/*.md — do not edit by hand.
// Run \`pnpm --filter @fundroom/compliance codegen\` (or \`turbo run codegen\`) after editing a
// template; \`templates.test.ts\` fails the build if this file and the Markdown have drifted.
`;

/** The TypeScript source of the generated module, so the drift test can build it in memory. */
export function buildTemplatesModule(dir = TEMPLATE_DIR) {
  const templates = loadTemplates(dir);
  const entries = templates
    .map((t) => {
      const fields = t.mergeFields.map((f) => JSON.stringify(f)).join(", ");
      const jurisdictions = t.jurisdiction.map((j) => JSON.stringify(j)).join(", ");
      return `  ${JSON.stringify(t.id)}: {
    id: ${JSON.stringify(t.id)},
    version: ${t.version},
    title: ${JSON.stringify(t.title)},
    audience: ${JSON.stringify(t.audience)},
    jurisdiction: [${jurisdictions}],
    requiresAcceptance: ${t.requiresAcceptance},
    mergeFields: [${fields}],
    bodySha256: ${JSON.stringify(t.bodySha256)},
    body: ${JSON.stringify(t.body)},
  },`;
    })
    .join("\n");

  return `${HEADER}
import type { ShippedTemplate } from "../templates/contract.js";

export const TEMPLATE_IDS = [
${templates.map((t) => `  ${JSON.stringify(t.id)},`).join("\n")}
] as const;

/** The ids of the shipped library, so \`from: <templateId>\` is checked at compile time. */
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const TEMPLATES: Readonly<Record<TemplateId, ShippedTemplate>> = Object.freeze({
${entries}
}) as Readonly<Record<TemplateId, ShippedTemplate>>;
`;
}

function main() {
  const source = buildTemplatesModule();
  writeFileSync(OUTPUT_FILE, source, "utf8");
  process.stdout.write(`compliance: wrote ${OUTPUT_FILE}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
