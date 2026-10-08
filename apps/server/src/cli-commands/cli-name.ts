import { basename } from "node:path";

/** The operator CLI's name (the `bin` in apps/server/package.json). */
export const CLI_NAME = "fundroom";

/**
 * The name the CLI had before the FundRoom rename (A-2, ADR-0062). package.json keeps it as a
 * second `bin` pointing at the same file for one minor release.
 */
export const LEGACY_CLI_NAME = "seedhost";

export const LEGACY_CLI_NOTE =
  "`seedhost` is now `fundroom`; the old name is removed in the next minor release.";

/**
 * The one-line stderr note for an invocation through the old bin name, or `undefined`.
 * `argv1` is `process.argv[1]`: a global npm install links the bin name to dist/cli.js and Node
 * keeps the link's path there, so its basename is the name the operator typed. (The image's
 * entrypoint runs dist/cli.js directly and never prints it.)
 */
export function legacyCliNote(argv1: string | undefined): string | undefined {
  if (argv1 === undefined) return undefined;
  const name = basename(argv1).replace(/\.(?:c|m)?js$/u, "");
  return name === LEGACY_CLI_NAME ? LEGACY_CLI_NOTE : undefined;
}
