#!/usr/bin/env node
/*
 * SOC 2 CC8.1 change-management evidence (E2.10; docs/compliance/soc2-evidence.md).
 *
 * For every pull request merged into the base branch in a period, collects: author, merger,
 * the latest review state of every reviewer (who approved), whether it touched a path CODEOWNERS
 * routes to @fundroomhq/security (and so needs two approvals), the conclusion of the required
 * "CI OK" check on its head commit, and the changeset files it added. Writes a JSON bundle (the
 * evidence) and a Markdown summary (for the auditor) with every exception listed first:
 *
 *   - merged without an approving review (by someone other than the author);
 *   - security-sensitive and merged with fewer than two approvals;
 *   - the CI gate missing or not `success` on the merged head;
 *   - touched a published package (packages/, apps/, modules/, plugins/) without a changeset
 *     (informational: docs-only and internal changes legitimately have none).
 *
 *   node scripts/evidence/change-management.mjs --since 2026-07-01 --until 2026-09-30 \
 *     [--repo seed-host/seed-host] [--base main] [--out evidence/] [--ci-check "CI OK"]
 *
 * Needs the GitHub CLI (`gh`) authenticated with read access to the repository (in Actions:
 * GH_TOKEN=${{ github.token }} with `pull-requests: read`, `checks: read`, `contents: read`).
 * No dependencies: `gh api` does the HTTP. Exit 0 = bundle written (exceptions are evidence,
 * not a failure); 1 = gh failed; 2 = usage. `--fail-on-exceptions` exits 3 when any exception
 * other than a missing changeset was found.
 *
 * The pure parts (argument parsing, CODEOWNERS matching, review folding, classification,
 * Markdown) are exported and unit-tested in change-management.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const USAGE = `usage: node scripts/evidence/change-management.mjs --since <YYYY-MM-DD> [--until <YYYY-MM-DD>]
       [--repo <owner/name>] [--base <branch>] [--out <dir>] [--ci-check <name>]
       [--codeowners <path>] [--fail-on-exceptions]`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Parses argv; returns `{ error }` on bad input. `--until` is inclusive (end of that day, UTC). */
export function parseArgs(argv, today = new Date()) {
  const opts = {
    since: undefined,
    until: today.toISOString().slice(0, 10),
    repo: undefined,
    base: "main",
    out: "evidence",
    ciCheck: "CI OK",
    codeowners: ".github/CODEOWNERS",
    failOnExceptions: false,
  };
  const keys = {
    "--since": "since",
    "--until": "until",
    "--repo": "repo",
    "--base": "base",
    "--out": "out",
    "--ci-check": "ciCheck",
    "--codeowners": "codeowners",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fail-on-exceptions") {
      opts.failOnExceptions = true;
      continue;
    }
    const key = keys[a];
    const value = argv[i + 1];
    if (key === undefined || value === undefined || value.startsWith("--")) {
      return { error: `unexpected argument ${a}` };
    }
    opts[key] = value;
    i += 1;
  }
  if (opts.since === undefined || !DATE_RE.test(opts.since)) {
    return { error: "--since YYYY-MM-DD is required" };
  }
  if (!DATE_RE.test(opts.until)) return { error: "--until must be YYYY-MM-DD" };
  if (opts.since > opts.until) return { error: "--since is after --until" };
  if (opts.repo !== undefined && !REPO_RE.test(opts.repo)) {
    return { error: "--repo must be owner/name" };
  }
  return { opts };
}

/** `[{ pattern, owners }]` in file order (GitHub applies the LAST matching rule). */
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/u, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    rules.push({ pattern, owners });
  }
  return rules;
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Converts a CODEOWNERS pattern to a RegExp over a repo-relative path (no leading slash).
 * Supports what this repo uses and gitignore's basics: a leading `/` anchors to the root, a
 * trailing `/` matches everything under the directory, `*` is one path segment's worth, `**`
 * any depth, and an unanchored pattern without a slash matches at any depth.
 */
export function codeownersPatternToRegExp(pattern) {
  if (pattern === "*") return /^.*$/u;
  const anchored = pattern.startsWith("/");
  let p = anchored ? pattern.slice(1) : pattern;
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const body = p
    .split("**")
    .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
    .join(".*");
  const prefix = anchored || p.includes("/") ? "^" : "^(?:.*/)?";
  // Every literal piece went through escapeRe; only `[^/]*`, `.*` and the anchors are pattern.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`${prefix}${body}${dir ? "/.*" : "(?:/.*)?"}$`, "u");
}

/** The owners of `path` under GitHub's last-match-wins rule, or `[]`. */
export function ownersOf(path, rules) {
  let owners = [];
  for (const rule of rules) {
    if (codeownersPatternToRegExp(rule.pattern).test(path)) owners = rule.owners;
  }
  return owners;
}

/** True when any file is owned by the security team (two approvals required). */
export function isSecuritySensitive(files, rules, team = "@fundroomhq/security") {
  return files.some((f) => ownersOf(f, rules).includes(team));
}

/**
 * Folds GitHub review events to each reviewer's latest decisive state (APPROVED,
 * CHANGES_REQUESTED or DISMISSED; COMMENTED never overrides a decision) and returns the logins
 * whose latest state is APPROVED, excluding the author.
 */
export function approversOf(reviews, author) {
  const latest = new Map();
  const ordered = [...reviews].sort((a, b) =>
    String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")),
  );
  for (const r of ordered) {
    const login = r.user?.login;
    if (!login || login === author) continue;
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    latest.set(login, r.state);
  }
  return [...latest.entries()]
    .filter(([, state]) => state === "APPROVED")
    .map(([login]) => login)
    .sort();
}

/** Changeset files a PR added (`.changeset/*.md`, not the README). */
export function changesetFiles(files) {
  return files.filter(
    (f) => /^\.changeset\/[^/]+\.md$/u.test(f) && f.toLowerCase() !== ".changeset/readme.md",
  );
}

const PUBLISHED_RE = /^(packages|apps|modules|plugins)\//u;

/** The evidence record for one merged PR, with its exceptions. */
export function classifyPr({ pr, reviews, files, ciConclusion, rules }) {
  const author = pr.user?.login ?? null;
  const approvers = approversOf(reviews, author);
  const securitySensitive = isSecuritySensitive(files, rules);
  const changesets = changesetFiles(files);
  const exceptions = [];
  if (approvers.length === 0) exceptions.push("no_approval");
  if (securitySensitive && approvers.length < 2) exceptions.push("security_needs_two_approvals");
  if (ciConclusion !== "success") exceptions.push("ci_not_green");
  const informational = [];
  if (changesets.length === 0 && files.some((f) => PUBLISHED_RE.test(f))) {
    informational.push("no_changeset");
  }
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author,
    mergedBy: pr.merged_by?.login ?? null,
    mergedAt: pr.merged_at,
    headSha: pr.head?.sha ?? null,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    approvers,
    securitySensitive,
    ciCheckConclusion: ciConclusion,
    changesets,
    filesChanged: files.length,
    exceptions,
    informational,
  };
}

export function summarize(records) {
  const count = (pred) => records.filter(pred).length;
  return {
    pullRequests: records.length,
    approved: count((r) => r.approvers.length > 0),
    securitySensitive: count((r) => r.securitySensitive),
    securityWithTwoApprovals: count((r) => r.securitySensitive && r.approvers.length >= 2),
    ciGreen: count((r) => r.ciCheckConclusion === "success"),
    withChangeset: count((r) => r.changesets.length > 0),
    withExceptions: count((r) => r.exceptions.length > 0),
  };
}

const EXCEPTION_TEXT = {
  no_approval: "merged without an approving review",
  security_needs_two_approvals: "security-sensitive, fewer than two approvals",
  ci_not_green: "CI gate missing or not green",
};

function cell(s) {
  return String(s ?? "")
    .replace(/\|/gu, "\\|")
    .replace(/\s+/gu, " ");
}

/** The auditor-facing Markdown summary of a bundle. */
export function renderMarkdown(bundle) {
  const s = bundle.summary;
  const lines = [
    `# Change management evidence: ${bundle.repo} (${bundle.base})`,
    "",
    `Period: ${bundle.period.since} to ${bundle.period.until} (UTC, inclusive). Generated ${bundle.generatedAt} by \`scripts/evidence/change-management.mjs\`; the JSON bundle next to this file is the evidence of record.`,
    "",
    "| Measure | Count |",
    "|---|---|",
    `| Pull requests merged | ${s.pullRequests} |`,
    `| With at least one approval (not the author) | ${s.approved} |`,
    `| Security-sensitive (CODEOWNERS \`@fundroomhq/security\`) | ${s.securitySensitive} |`,
    `| Security-sensitive with two or more approvals | ${s.securityWithTwoApprovals} |`,
    `| "${bundle.ciCheck}" green on the merged head | ${s.ciGreen} |`,
    `| With a changeset | ${s.withChangeset} |`,
    `| With exceptions | ${s.withExceptions} |`,
    "",
    "## Exceptions",
    "",
  ];
  const exceptional = bundle.pullRequests.filter((r) => r.exceptions.length > 0);
  if (exceptional.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| PR | Title | Merged by | Exceptions |", "|---|---|---|---|");
    for (const r of exceptional) {
      lines.push(
        `| [#${r.number}](${r.url}) | ${cell(r.title)} | ${cell(r.mergedBy)} | ${r.exceptions.map((e) => EXCEPTION_TEXT[e] ?? e).join("; ")} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## All merged pull requests",
    "",
    "| PR | Merged (UTC) | Author | Approvers | Security | CI | Changesets |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of bundle.pullRequests) {
    lines.push(
      `| [#${r.number}](${r.url}) | ${cell(r.mergedAt)} | ${cell(r.author)} | ${cell(r.approvers.join(", ") || "none")} | ${r.securitySensitive ? "yes" : "no"} | ${cell(r.ciCheckConclusion ?? "missing")} | ${r.changesets.length} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/* ---------------------------------------------------------------- I/O (not unit-tested) */

function gh(args) {
  const out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** Every page of a list endpoint (`per_page=100`), stopping early when `stop(page)` says so. */
function pages(path, stop = () => false) {
  const all = [];
  for (let page = 1; page <= 500; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = gh([`${path}${sep}per_page=100&page=${page}`]);
    const items = Array.isArray(batch) ? batch : (batch.check_runs ?? []);
    all.push(...items);
    if (items.length < 100 || stop(items)) break;
  }
  return all;
}

function defaultRepo() {
  const out = execFileSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    {
      encoding: "utf8",
    },
  );
  return out.trim();
}

function ciConclusionFor(repo, sha, name) {
  if (!sha) return null;
  const runs = pages(
    `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`,
  );
  // The newest run of the gate on that commit (a re-run supersedes an earlier failure).
  const latest = runs
    .filter((r) => r.name === name)
    .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0];
  return latest?.conclusion ?? null;
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.opts;
  const rules = parseCodeowners(readFileSync(resolve(root, o.codeowners), "utf8"));
  const since = new Date(`${o.since}T00:00:00Z`);
  const until = new Date(`${o.until}T23:59:59.999Z`);
  let repo;
  const records = [];
  try {
    repo = o.repo ?? defaultRepo();
    // Closed PRs against the base, most recently updated first; a PR merged in the period was
    // updated at or after its merge, so paging stops once a whole page predates the period.
    const closed = pages(
      `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(o.base)}&sort=updated&direction=desc`,
      (items) => items.every((p) => new Date(p.updated_at) < since),
    );
    const merged = closed.filter((p) => {
      if (!p.merged_at) return false;
      const at = new Date(p.merged_at);
      return at >= since && at <= until;
    });
    for (const p of merged) {
      const pr = gh([`repos/${repo}/pulls/${p.number}`]);
      const reviews = pages(`repos/${repo}/pulls/${p.number}/reviews`);
      const files = pages(`repos/${repo}/pulls/${p.number}/files`).map((f) => f.filename);
      const ciConclusion = ciConclusionFor(repo, pr.head?.sha, o.ciCheck);
      records.push(classifyPr({ pr, reviews, files, ciConclusion, rules }));
      console.error(`#${pr.number} ${records.at(-1).exceptions.join(",") || "ok"}`);
    }
  } catch (error) {
    console.error(`gh failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  records.sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  const bundle = {
    kind: "change-management",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo,
    base: o.base,
    ciCheck: o.ciCheck,
    period: { since: o.since, until: o.until },
    codeowners: { path: o.codeowners, rules: rules.length },
    summary: summarize(records),
    pullRequests: records,
  };
  const outDir = resolve(o.out);
  mkdirSync(outDir, { recursive: true });
  const stem = `change-management-${o.since}_${o.until}`;
  writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(outDir, `${stem}.md`), renderMarkdown(bundle));
  console.error(
    `wrote ${join(outDir, `${stem}.json`)} and .md: ${bundle.summary.pullRequests} PR(s), ${bundle.summary.withExceptions} with exceptions`,
  );
  return o.failOnExceptions && bundle.summary.withExceptions > 0 ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
