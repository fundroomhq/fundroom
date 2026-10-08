#!/usr/bin/env node
/*
 * The CI gate over ZAP's JSON reports (rule decisions in `.zap/rules.tsv`). Plain node, no deps.
 *
 *   node e2e/security/zap-gate.mjs --rules .zap/rules.tsv .zap/reports/*.json
 *
 * ZAP's own `-c rules.tsv` handling keys on the plugin id only, but one plugin raises several
 * different alerts (10055 "CSP" raises a Medium "Wildcard Directive" and a Low "Notices"; 90004
 * raises CORP, COEP and COOP), so "accept this one, fail the rest" cannot be said to ZAP. The scans
 * therefore run with `-I` (never fail on WARN) and this script decides:
 *
 *   1. A line for the alert's exact `alertRef` (e.g. `#@10055-4`, see rules.tsv's header) wins.
 *   2. Otherwise the plugin-id line (`10055`) applies — EXCEPT that a plugin-level IGNORE/WARN can
 *      never accept a Medium or High alert: accepting one has to name its exact alertRef, so a new
 *      Medium sub-alert of an already-listed plugin still fails.
 *   3. Unlisted: Medium/High → FAIL, Low/Informational → WARN.
 *
 * `<id>\tOUTOFSCOPE\t<url regex>` (ZAP's own syntax) drops the instances whose URL matches; the
 * reason goes on a comment line above it. Every other line must carry a reason in parentheses; a line without one is itself an error, because
 * an unexplained IGNORE is how accepted risk goes stale. Exit 1 on any FAIL, 2 on a bad rules file.
 * Writes a Markdown table to $GITHUB_STEP_SUMMARY when set.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opt, positionals: reports } = parseArgs({
  allowPositionals: true,
  options: { rules: { type: "string", default: ".zap/rules.tsv" } },
});

const LEVELS = new Set(["IGNORE", "INFO", "WARN", "FAIL"]);
const RISK = ["Informational", "Low", "Medium", "High"];

/** @type {Map<string, {level: string, reason: string}>} */
const rules = new Map();
/** @type {Map<string, RegExp[]>} alert/plugin id → URL patterns that are out of scope for it */
const outOfScope = new Map();
let bad = 0;
for (const [n, raw] of readFileSync(opt.rules, "utf8").split("\n").entries()) {
  // `#@<alertRef>\t…` is an alertRef-level decision hidden from ZAP, whose `-c` parser int()s ids.
  const line = raw.trimEnd().replace(/^#@/u, "");
  if (line === "" || line.startsWith("#")) continue;
  const [key, level, rest = ""] = line.split("\t");
  if (key && level === "OUTOFSCOPE" && rest.trim() !== "") {
    for (const id of key.split(",")) {
      outOfScope.set(id, [...(outOfScope.get(id) ?? []), new RegExp(rest.trim(), "u")]);
    }
    continue;
  }
  const reason = /^\((.+)\)$/u.exec(rest.trim())?.[1]?.trim();
  if (!key || !LEVELS.has(level ?? "") || !reason) {
    process.stderr.write(
      `${opt.rules}:${n + 1}: want "<id>\\t<IGNORE|INFO|WARN|FAIL>\\t(<reason>)"\n`,
    );
    bad += 1;
    continue;
  }
  rules.set(key, { level, reason });
}
if (bad > 0) process.exit(2);
if (reports.length === 0) {
  process.stderr.write("no reports given\n");
  process.exit(2);
}

function decide(alert) {
  const risk = Number(alert.riskcode);
  const exact = rules.get(String(alert.alertRef ?? alert.pluginid));
  if (exact) return { ...exact, via: String(alert.alertRef ?? alert.pluginid) };
  const plugin = rules.get(String(alert.pluginid));
  if (plugin) {
    if (risk >= 2 && plugin.level !== "FAIL") {
      return {
        level: "FAIL",
        reason: `${RISK[risk]} sub-alert not accepted by alertRef (plugin line says ${plugin.level})`,
        via: "policy",
      };
    }
    return { ...plugin, via: String(alert.pluginid) };
  }
  return risk >= 2
    ? { level: "FAIL", reason: `new ${RISK[risk]} alert, not triaged in rules.tsv`, via: "policy" }
    : { level: "WARN", reason: "new Low/Info alert, not triaged in rules.tsv", via: "policy" };
}

const rows = [];
let fails = 0;
for (const file of reports) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  for (const site of doc.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const patterns = [
        ...(outOfScope.get("*") ?? []),
        ...(outOfScope.get(String(alert.pluginid)) ?? []),
        ...(alert.alertRef ? (outOfScope.get(String(alert.alertRef)) ?? []) : []),
      ];
      if (patterns.length > 0) {
        alert.instances = (alert.instances ?? []).filter(
          (i) => !patterns.some((re) => re.test(i.uri ?? "")),
        );
        if (alert.instances.length === 0) continue;
        alert.count = alert.instances.length;
      }
      const d = decide(alert);
      if (d.level === "IGNORE") continue;
      if (d.level === "FAIL") fails += 1;
      const first = alert.instances?.[0];
      rows.push({
        report: file.split("/").pop(),
        level: d.level,
        ref: alert.alertRef ?? alert.pluginid,
        name: alert.name ?? alert.alert,
        risk: RISK[Number(alert.riskcode)] ?? alert.riskcode,
        count: alert.count ?? alert.instances?.length ?? 0,
        url: first ? `${first.method} ${first.uri}` : "",
        reason: d.reason,
      });
    }
  }
}

rows.sort((a, b) => (a.level === b.level ? 0 : a.level === "FAIL" ? -1 : 1));
for (const r of rows) {
  process.stdout.write(
    `${r.level.padEnd(4)} ${String(r.ref).padEnd(9)} ${r.risk.padEnd(13)} x${r.count}  ${r.name}  [${r.report}]\n` +
      `     ${r.url}\n     ${r.reason}\n`,
  );
}
process.stdout.write(
  `\n${fails} FAIL, ${rows.length - fails} WARN/INFO across ${reports.length} report(s)\n`,
);

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `### ZAP gate: ${fails === 0 ? "pass" : `${fails} FAIL`}`,
    "",
    "| Decision | Alert | Risk | Count | First URL | Report | Why |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.level} | ${r.ref} ${r.name} | ${r.risk} | ${r.count} | \`${r.url.slice(0, 90)}\` | ${r.report} | ${r.reason} |`,
    ),
    "",
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
process.exit(fails > 0 ? 1 : 0);
