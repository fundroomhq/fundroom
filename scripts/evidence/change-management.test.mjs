import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  approversOf,
  changesetFiles,
  classifyPr,
  codeownersPatternToRegExp,
  isSecuritySensitive,
  ownersOf,
  parseArgs,
  parseCodeowners,
  renderMarkdown,
  summarize,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
} from "./change-management.mjs";

const TODAY = new Date("2026-09-23T12:00:00Z");

test("parseArgs: --since is required, --until defaults to today, dates are checked", () => {
  assert.equal(parseArgs([], TODAY).error, "--since YYYY-MM-DD is required");
  const { opts } = parseArgs(["--since", "2026-07-01"], TODAY);
  assert.equal(opts.until, "2026-09-23");
  assert.equal(opts.base, "main");
  assert.equal(opts.ciCheck, "CI OK");
  assert.match(
    parseArgs(["--since", "2026-07-01", "--until", "2026-06-01"], TODAY).error,
    /after/u,
  );
  assert.match(parseArgs(["--since", "07/01/2026"], TODAY).error, /required/u);
  assert.match(parseArgs(["--since", "2026-07-01", "--repo", "nope"], TODAY).error, /owner\/name/u);
  assert.match(parseArgs(["--since", "2026-07-01", "--bogus", "x"], TODAY).error, /unexpected/u);
  assert.equal(
    parseArgs(["--since", "2026-07-01", "--fail-on-exceptions"], TODAY).opts.failOnExceptions,
    true,
  );
});

test("CODEOWNERS patterns: anchored dirs, globs, last match wins", () => {
  const rules = parseCodeowners(`
# comment
*                         @org/core
/packages/identity/       @org/security @org/core   # trailing comment
/modules/*/migrations/    @org/security
/apps/server/src/routes/auth*.ts @org/security
/docs/                    @org/core
`);
  assert.equal(rules.length, 5);
  assert.deepEqual(ownersOf("README.md", rules), ["@org/core"]);
  assert.deepEqual(ownersOf("packages/identity/src/x.ts", rules), ["@org/security", "@org/core"]);
  assert.deepEqual(ownersOf("packages/identityx/src/x.ts", rules), ["@org/core"]);
  assert.deepEqual(ownersOf("modules/crm/migrations/0001_crm.sql", rules), ["@org/security"]);
  assert.deepEqual(ownersOf("modules/crm/src/migrations.ts", rules), ["@org/core"]);
  assert.deepEqual(ownersOf("apps/server/src/routes/auth.ts", rules), ["@org/security"]);
  assert.deepEqual(ownersOf("apps/server/src/routes/authz.ts", rules), ["@org/security"]);
  assert.deepEqual(ownersOf("apps/server/src/routes/ops.ts", rules), ["@org/core"]);
  assert.equal(codeownersPatternToRegExp("*.md").test("docs/a/b.md"), true);
  assert.equal(codeownersPatternToRegExp("/docs/**/x.md").test("docs/a/b/x.md"), true);
  assert.equal(
    isSecuritySensitive(["docs/a.md", "modules/crm/migrations/1.sql"], rules, "@org/security"),
    true,
  );
  assert.equal(isSecuritySensitive(["docs/a.md"], rules, "@org/security"), false);
});

test("the repository's own CODEOWNERS routes the security-sensitive paths to @fundroomhq/security", () => {
  const rules = parseCodeowners(
    readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8"),
  );
  for (const path of [
    "packages/db/migrations/core/0015_break_glass.sql",
    "packages/identity/src/index.ts",
    "packages/authz/matrix/authz-matrix.yaml",
    "packages/audit/src/actions.ts",
    "packages/crypto/src/index.ts",
    "apps/server/src/middleware/auth.ts",
    "apps/server/src/routes/auth.ts",
    "modules/crm/migrations/0001_crm.sql",
    "deploy/docker/Dockerfile",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(ownersOf(path, rules).includes("@fundroomhq/security"), path);
  }
  assert.deepEqual(ownersOf("apps/web/src/main.tsx", rules), ["@fundroomhq/core"]);
});

test("approversOf: latest decisive state per reviewer, author excluded, comments ignored", () => {
  const reviews = [
    { user: { login: "bo" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-01T10:00:00Z" },
    { user: { login: "bo" }, state: "APPROVED", submitted_at: "2026-09-01T12:00:00Z" },
    { user: { login: "bo" }, state: "COMMENTED", submitted_at: "2026-09-01T13:00:00Z" },
    { user: { login: "cy" }, state: "APPROVED", submitted_at: "2026-09-01T09:00:00Z" },
    { user: { login: "cy" }, state: "DISMISSED", submitted_at: "2026-09-01T11:00:00Z" },
    { user: { login: "al" }, state: "APPROVED", submitted_at: "2026-09-01T08:00:00Z" },
    { user: null, state: "APPROVED", submitted_at: "2026-09-01T08:00:00Z" },
  ];
  assert.deepEqual(approversOf(reviews, "al"), ["bo"]);
});

test("changesetFiles ignores the README and non-markdown", () => {
  assert.deepEqual(
    changesetFiles([
      ".changeset/brave-owl.md",
      ".changeset/README.md",
      ".changeset/config.json",
      "docs/x.md",
    ]),
    [".changeset/brave-owl.md"],
  );
});

const RULES = parseCodeowners("*  @fundroomhq/core\n/packages/identity/ @fundroomhq/security\n");
const PR = {
  number: 7,
  title: "Fix | pipes",
  html_url: "https://github.com/o/r/pull/7",
  user: { login: "al" },
  merged_by: { login: "bo" },
  merged_at: "2026-09-02T00:00:00Z",
  head: { sha: "abc" },
  merge_commit_sha: "def",
};

test("classifyPr and summarize flag every exception", () => {
  const ok = classifyPr({
    pr: PR,
    reviews: [
      { user: { login: "bo" }, state: "APPROVED", submitted_at: "1" },
      { user: { login: "cy" }, state: "APPROVED", submitted_at: "2" },
    ],
    files: ["packages/identity/src/a.ts", ".changeset/x.md"],
    ciConclusion: "success",
    rules: RULES,
  });
  assert.deepEqual(ok.exceptions, []);
  assert.equal(ok.securitySensitive, true);
  assert.deepEqual(ok.changesets, [".changeset/x.md"]);

  const bad = classifyPr({
    pr: { ...PR, number: 8 },
    reviews: [{ user: { login: "bo" }, state: "APPROVED", submitted_at: "1" }],
    files: ["packages/identity/src/a.ts"],
    ciConclusion: "failure",
    rules: RULES,
  });
  assert.deepEqual(bad.exceptions, ["security_needs_two_approvals", "ci_not_green"]);
  assert.deepEqual(bad.informational, ["no_changeset"]);

  const selfMerged = classifyPr({
    pr: { ...PR, number: 9 },
    reviews: [{ user: { login: "al" }, state: "APPROVED", submitted_at: "1" }],
    files: ["docs/a.md"],
    ciConclusion: null,
    rules: RULES,
  });
  assert.deepEqual(selfMerged.exceptions, ["no_approval", "ci_not_green"]);
  assert.deepEqual(selfMerged.informational, []);

  assert.deepEqual(summarize([ok, bad, selfMerged]), {
    pullRequests: 3,
    approved: 2,
    securitySensitive: 2,
    securityWithTwoApprovals: 1,
    ciGreen: 1,
    withChangeset: 1,
    withExceptions: 2,
  });
});

test("renderMarkdown lists exceptions first and escapes table cells", () => {
  const records = [
    classifyPr({
      pr: PR,
      reviews: [],
      files: ["docs/a.md"],
      ciConclusion: "success",
      rules: RULES,
    }),
  ];
  const md = renderMarkdown({
    repo: "o/r",
    base: "main",
    ciCheck: "CI OK",
    generatedAt: "2026-09-23T00:00:00Z",
    period: { since: "2026-09-01", until: "2026-09-30" },
    summary: summarize(records),
    pullRequests: records,
  });
  assert.match(md, /^# Change management evidence: o\/r \(main\)/u);
  assert.ok(md.indexOf("## Exceptions") < md.indexOf("## All merged pull requests"));
  assert.match(md, /merged without an approving review/u);
  assert.match(md, /Fix \\\| pipes/u);
  assert.match(md, /\| Pull requests merged \| 1 \|/u);
});
