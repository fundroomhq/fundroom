#!/usr/bin/env node
/**
 * No tracked file may name the `.com` domain that shares FundRoom's name. It is not FundRoom's:
 * someone else holds it, so a security contact, a release-index URL or a link there sends
 * reporters, installs and readers to a stranger. FundRoom's domain is `fundroom.io`.
 *
 * Matches the name and any subdomain or address on it, case-insensitively; a longer label such as
 * `fundroom-staging.com` or a Helm define named `<chart>.component…` is not a match. The
 * domain is assembled at runtime so that this file and its test do not trip the check (or a plain
 * `git grep` for it).
 *
 * Scans `git ls-files` (text files only). Usage: node scripts/check-foreign-domain.mjs [root].
 * Exit 1 on findings.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FOREIGN_DOMAIN = ["fundroom", "com"].join(".");

/** The domain, not preceded by a label character or followed by one (a longer name). */
export const FOREIGN_DOMAIN_RE = new RegExp(
  `(?<![a-z0-9-])${FOREIGN_DOMAIN.replace(".", "\\.")}(?![a-z0-9-])`,
  "giu",
);

/** 1-based line numbers of every match in `text`. */
export function findForeignDomain(text) {
  const lines = [];
  for (const m of text.matchAll(FOREIGN_DOMAIN_RE)) {
    lines.push(text.slice(0, m.index).split("\n").length);
  }
  return lines;
}

function main(root) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  let count = 0;
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (buf.includes(0)) continue; // binary
    for (const line of findForeignDomain(buf.toString("utf8"))) {
      count++;
      console.error(
        `${file}:${line}: names ${FOREIGN_DOMAIN}, which is not FundRoom's (use fundroom.io)`,
      );
    }
  }
  if (count > 0) {
    console.error(`foreign domain: ${count} reference(s)`);
    process.exitCode = 1;
  } else {
    console.error("foreign domain: OK");
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/u, ""))) {
  main(process.argv[2] ?? process.cwd());
}
