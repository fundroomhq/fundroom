#!/usr/bin/env node
/*
 * i18n gate (E2.8, "i18n coverage of investor UI"). Five rules, each an error:
 *
 *  1. parity   every catalogue's `en-XA.json` has exactly the keys of its `en.json` and is what
 *              `scripts/i18n-pseudo.mjs` would generate from it (no drift, no hand edits);
 *  2. unused   every key in `apps/web/messages/en.json` is referenced as `m.key(` somewhere in
 *              `apps/web/src` (dead keys are deleted, not translated forever);
 *  3. jsx      no user-visible English in JSX under `apps/web/src` and `packages/ui/src`:
 *              JSX text containing a letter, a literal a child expression renders (`{"Save"}`,
 *              `{c ? "Yes" : "No"}`, `{c && "Saved"}`, `` {`Hi ${x}`} ``, `{x ?? "None"}`), and the
 *              same in `aria-label`, `placeholder`, `title`, `alt` and `label` attributes.
 *              Parsed with the TypeScript compiler, so comments, class names and code are not
 *              mistaken for copy. Tests, stories and generated files are skipped.
 *  4. plurals  no "fake plural" in either `en.json` ("{count} file(s)"): count-driven wording is a
 *              plural variant (inlang `match` / server `{ one, other }`), selected by Intl.PluralRules;
 *  5. allowlist every entry in `scripts/i18n-allowlist.json` still matches something (a stale
 *              exemption is how a rule silently stops applying).
 *
 * Justified exceptions live in `scripts/i18n-allowlist.json`, each with a reason:
 *   { "unusedKeys": { "<key>": "<why>" },
 *     "jsx": [ { "file": "<repo-relative path>", "text": "<exact literal>", "reason": "<why>" } ] }
 *
 *   node scripts/check-i18n.mjs     (CI: `pnpm lint:i18n`)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node (CI runs this file directly).
import { CATALOGUES, pseudoCatalogue } from "./i18n-pseudo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHECKED_ATTRIBUTES = new Set(["aria-label", "placeholder", "title", "alt", "label"]);
const LETTER = /\p{L}/u;

/** `apps/web/src/a/b.tsx` style paths, whatever the OS separator. */
const rel = (abs) => relative(root, abs).split(sep).join("/");

// --- 1. parity ---------------------------------------------------------------------------------

/** Parity + drift problems for one catalogue pair (objects already parsed). */
export function parityProblems(name, en, pseudo, pseudoText) {
  const problems = [];
  const a = new Set(Object.keys(en));
  const b = new Set(Object.keys(pseudo));
  for (const k of a) if (!b.has(k)) problems.push(`${name}: en-XA is missing "${k}"`);
  for (const k of b) if (!a.has(k)) problems.push(`${name}: en-XA has "${k}", which en does not`);
  if (problems.length === 0 && pseudoText !== pseudoCatalogue(en)) {
    problems.push(`${name}: en-XA.json is stale — run \`node scripts/i18n-pseudo.mjs\``);
  }
  return problems;
}

// --- 2. unused keys ----------------------------------------------------------------------------

/** Every `m.key` / `m["key"]` reference in a source text. */
export function referencedKeys(source) {
  const out = new Set();
  for (const match of source.matchAll(/\bm\.([A-Za-z_$][\w$]*)/gu)) out.add(match[1]);
  for (const match of source.matchAll(/\bm\[\s*["'`]([\w$]+)["'`]\s*\]/gu)) out.add(match[1]);
  return out;
}

export function unusedKeys(catalogue, referenced, allow = {}) {
  return Object.keys(catalogue)
    .filter((k) => k !== "$schema" && !referenced.has(k) && !Object.hasOwn(allow, k))
    .sort();
}

// --- 4. fake plurals ----------------------------------------------------------------------------

const FAKE_PLURAL = /\p{L}\((?:s|es)\)/u;

/** Keys whose (string or variant) text contains a "(s)"-style fake plural. */
export function fakePlurals(catalogue) {
  const texts = (v) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap((e) => Object.values(e?.match ?? {}))
        : v !== null && typeof v === "object"
          ? Object.values(v)
          : [];
  return Object.entries(catalogue)
    .filter(
      ([k, v]) =>
        k !== "$schema" && texts(v).some((t) => typeof t === "string" && FAKE_PLURAL.test(t)),
    )
    .map(([k]) => k)
    .sort();
}

// --- 3. JSX literals ---------------------------------------------------------------------------

/**
 * The literals an expression can *render*, as `{ node, text }`: a string or template literal
 * itself, either branch of a conditional (`c ? "Yes" : "No"`), the right side of `&&` (`c &&
 * "Saved"`), both sides of `||` / `??` (fallback copy) and of a `+` concatenation, through
 * parentheses and `as` / `satisfies` / `!`. Not the condition, and not call arguments: `m.x()`,
 * `cn("…")` and `fmt(x, "…")` are code, not copy. A template literal is reported with its
 * substitutions as `${…}` and counts as copy when its *static* parts contain a letter.
 */
export function renderedLiterals(expr) {
  const out = [];
  const visit = (e) => {
    if (e === undefined) return;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      if (LETTER.test(e.text)) out.push({ node: e, text: e.text });
    } else if (ts.isTemplateExpression(e)) {
      const statics = [e.head.text, ...e.templateSpans.map((span) => span.literal.text)];
      if (statics.some((t) => LETTER.test(t))) {
        const text = e.head.text + e.templateSpans.map((s) => `\${…}${s.literal.text}`).join("");
        out.push({ node: e, text });
      }
    } else if (ts.isConditionalExpression(e)) {
      visit(e.whenTrue);
      visit(e.whenFalse);
    } else if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) visit(e.right);
      else if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        visit(e.left);
        visit(e.right);
      }
    } else if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      visit(e.expression);
    }
  };
  visit(expr);
  return out;
}

/**
 * User-visible literals in one TSX source: `{ line, text, kind }` for JSX text with a letter, a
 * literal a child expression renders (`{"Save"}`, `{c ? "Yes" : "No"}`, `{c && "Saved"}`,
 * `` {`Hello ${x}`} ``), and the same in one of `CHECKED_ATTRIBUTES`. Other attributes
 * (`className`, `key`, `id`, `data-*`, `type` …) are code, and strings without a letter
 * (`"—"`, `" · "`) are punctuation.
 */
export function jsxLiterals(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sf).replace(/\s+/gu, " ").trim();
      if (LETTER.test(text)) found.push({ line: lineOf(node), text, kind: "text" });
    } else if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const hit of renderedLiterals(node.expression)) {
        found.push({ line: lineOf(hit.node), text: hit.text, kind: "text" });
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (CHECKED_ATTRIBUTES.has(name) && init !== undefined) {
        const hits = ts.isStringLiteral(init)
          ? renderedLiterals(init)
          : ts.isJsxExpression(init)
            ? renderedLiterals(init.expression)
            : [];
        for (const hit of hits) found.push({ line: lineOf(hit.node), text: hit.text, kind: name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "paraglide", "test", "__snapshots__"]);
const SKIP_FILE = /\.(test|stories|gen)\.(ts|tsx)$|\.d\.ts$/u;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(abs, exts, out);
    } else if (exts.some((e) => name.endsWith(e)) && !SKIP_FILE.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

// --- run ---------------------------------------------------------------------------------------

export function check() {
  const allowlist = JSON.parse(readFileSync(join(root, "scripts/i18n-allowlist.json"), "utf8"));
  const errors = [];

  for (const c of CATALOGUES) {
    const en = JSON.parse(readFileSync(join(root, c.en), "utf8"));
    let pseudoText = "";
    let pseudo = {};
    try {
      pseudoText = readFileSync(join(root, c.pseudo), "utf8");
      pseudo = JSON.parse(pseudoText);
    } catch {
      errors.push(`${c.pseudo}: missing — run \`node scripts/i18n-pseudo.mjs\``);
      continue;
    }
    errors.push(...parityProblems(c.en, en, pseudo, pseudoText));
    for (const k of fakePlurals(en)) {
      errors.push(`${c.en}: "${k}" uses a "(s)" fake plural — make it a plural variant`);
    }
  }

  const webSources = walk(join(root, "apps/web/src"), [".ts", ".tsx"]);
  const referenced = new Set();
  for (const f of webSources)
    for (const k of referencedKeys(readFileSync(f, "utf8"))) referenced.add(k);
  const webEn = JSON.parse(readFileSync(join(root, "apps/web/messages/en.json"), "utf8"));
  const allowUnused = allowlist.unusedKeys ?? {};
  for (const k of unusedKeys(webEn, referenced, allowUnused)) {
    errors.push(
      `apps/web/messages/en.json: "${k}" is never used (m.${k}) — delete it or allowlist it`,
    );
  }
  for (const k of Object.keys(allowUnused)) {
    if (!Object.hasOwn(webEn, k))
      errors.push(`i18n-allowlist.json: unusedKeys."${k}" is not a key any more`);
  }

  const allowJsx = allowlist.jsx ?? [];
  const used = new Set();
  const tsxFiles = [
    ...walk(join(root, "apps/web/src"), [".tsx"]),
    ...walk(join(root, "packages/ui/src"), [".tsx"]),
  ];
  let literals = 0;
  for (const abs of tsxFiles) {
    const file = rel(abs);
    for (const hit of jsxLiterals(file, readFileSync(abs, "utf8"))) {
      const index = allowJsx.findIndex((a) => a.file === file && a.text === hit.text);
      if (index >= 0) {
        used.add(index);
        continue;
      }
      literals += 1;
      errors.push(
        `${file}:${hit.line}: ${hit.kind === "text" ? "JSX text" : `${hit.kind}=`} ${JSON.stringify(hit.text)} — use a message (m.*) or allowlist it`,
      );
    }
  }
  allowJsx.forEach((a, i) => {
    if (!used.has(i))
      errors.push(
        `i18n-allowlist.json: jsx entry ${JSON.stringify(a.text)} in ${a.file} matches nothing any more`,
      );
  });

  return {
    errors,
    stats: { webKeys: Object.keys(webEn).length - 1, tsxFiles: tsxFiles.length, literals },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, stats } = check();
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\ncheck-i18n: ${errors.length} problem(s)`);
    process.exit(1);
  }
  process.stdout.write(
    `check-i18n: ok (${stats.webKeys} web keys, ${stats.tsxFiles} TSX files scanned)` + "\n",
  );
}
