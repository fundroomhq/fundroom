/*
 * The release workflow's publisher, bundled with its dependencies into dist/release-index.mjs
 * (`pnpm build`) so the job holding the R2 keys runs it with Node alone: no install, no
 * node_modules. Usage: `index-publisher.ts` USAGE; docs/runbooks/releasing.md, "Release index".
 */
import { main } from "./index-publisher.js";

process.exitCode = await main(process.argv.slice(2), process.env);
