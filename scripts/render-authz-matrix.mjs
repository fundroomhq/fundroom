#!/usr/bin/env node
// Renders docs/authz-matrix.md from packages/authz/matrix/authz-matrix.yaml.
// `pnpm --filter @fundroom/authz matrix:docs`; the authz unit tests fail when the file is stale.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Imported from dist so the script needs no workspace install step of its own (run `pnpm build` first).
import { renderAuthzMatrix } from "../packages/authz/dist/matrix.js";

const out = fileURLToPath(new URL("../docs/authz-matrix.md", import.meta.url));
writeFileSync(out, renderAuthzMatrix());
process.stdout.write(`wrote ${out}\n`);
