#!/usr/bin/env node
/*
 * Write a GET-only copy of the live OpenAPI document for an AUTHENTICATED ZAP API import
 * (`.github/workflows/zap.yml`). Plain node (>= 20), no dependencies.
 *
 *   node e2e/security/openapi-get.mjs --url http://localhost:3400 \
 *     --server http://localhost:3000/api/v1 --out .zap/reports/openapi-get.json
 *
 * Why GET-only: ZAP's OpenAPI importer *sends* one request per operation, with example values.
 * Anonymous, that is harmless (unsafe methods without a session are refused or public), but with
 * an owner's cookie it would call DELETE /auth/totp, POST /auth/logout-everywhere and every other
 * write in the contract — the scan would end the session it depends on and vandalise the seeded
 * workspace. GETs are safe by contract, so the authenticated passes import only those.
 *
 * `servers` is rewritten to --server because the document says `/api/v1` (relative) and the
 * scanner reaches the app on a different origin than the runner does.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: process.env.ZAP_APP_URL ?? "http://localhost:3400" },
    server: { type: "string", default: "http://localhost:3000/api/v1" },
    out: { type: "string", default: ".zap/reports/openapi-get.json" },
  },
});

const res = await fetch(`${opt.url.replace(/\/+$/u, "")}/api/v1/openapi.json`);
if (!res.ok) {
  process.stderr.write(`openapi.json: HTTP ${res.status}\n`);
  process.exit(1);
}
const doc = await res.json();
let kept = 0;
let dropped = 0;
const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
const paths = {};
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  const next = {};
  for (const [key, value] of Object.entries(item)) {
    const method = key.toLowerCase();
    if (!METHODS.has(method)) {
      next[key] = value; // path-level `parameters`, summary, …
    } else if (method === "get") {
      next[key] = value;
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  if ("get" in next) paths[path] = next;
}
doc.paths = paths;
doc.servers = [{ url: opt.server }];
writeFileSync(opt.out, `${JSON.stringify(doc, null, 2)}\n`);
process.stderr.write(
  `[openapi-get] kept ${kept} GET operations, dropped ${dropped} others → ${opt.out}\n`,
);
