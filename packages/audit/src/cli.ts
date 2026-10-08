#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { KeyRing } from "@fundroom/config";
import {
  keyRingFromSingleKey,
  LEGACY_ENV_NAMES,
  legacyEnvWarning,
  parseKeyRing,
  resolveEnv,
} from "@fundroom/config";
import { createDatabase } from "@fundroom/db";
import {
  exportVerificationExitCode,
  formatExportVerification,
  verifyExportBundle,
} from "./bundle.js";
import { writeAllCheckpoints } from "./checkpoint.js";
import { formatVerification, verifyAllWorkspaces, verifyWorkspace } from "./verify.js";

/*
 * fundroom-audit verify [--workspace <uuid>] [--from <seq>]
 * fundroom-audit checkpoint
 * fundroom-audit verify-export <bundle.zip> [--public-key <base64>]...   (offline, no DB)
 *
 * Reads DATABASE_URL (or DATABASE_URL_FILE) and, for signature checks, SECRET_KEY_RING or
 * FUNDROOM_SECRET_KEY (or their _FILE forms; the old name SEEDHOST_SECRET_KEY is still read,
 * with a warning, exactly as the server's config loader does). Exit 1 when any chain or checkpoint fails.
 * verify-export exits 0 verified against a --public-key, 1 failed, 2 usage, and 3 when the
 * bundle is intact but no --public-key was given (UNVERIFIED ORIGIN: it only checked itself).
 * The product CLI (`fundroom audit …`, apps/server) wraps the same functions.
 * `seedhost-audit` (the pre-rename bin, ADR-0062) still points here for one minor release.
 */
const LEGACY_BIN = "seedhost-audit";
const LEGACY_BIN_NOTE =
  "`seedhost-audit` is now `fundroom-audit`; the old name is removed in the next minor release.";

/** One variable with the config loader's own rules: NAME / NAME_FILE / renamed-variable aliases. */
function envOrFile(name: string): string | undefined {
  const r = resolveEnv(process.env, [name], undefined, LEGACY_ENV_NAMES);
  if (r.issues.length > 0)
    throw new Error(r.issues.map((i) => `${i.key}: ${i.message}`).join("; "));
  for (const use of r.legacy) {
    const w = legacyEnvWarning(use);
    console.error(`warning: ${w.key}: ${w.message}`);
  }
  return r.values[name];
}

function keyRing(): KeyRing | undefined {
  const ring = envOrFile("SECRET_KEY_RING");
  const single = envOrFile("FUNDROOM_SECRET_KEY");
  const parsed = ring ? parseKeyRing(ring) : single ? keyRingFromSingleKey(single) : undefined;
  if (!parsed) return undefined;
  if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.key}: ${i.message}`).join("; "));
  return parsed.ring;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.error(
      "usage: fundroom-audit <verify|checkpoint> [--workspace <uuid>] [--from <seq>]\n       fundroom-audit verify-export <bundle.zip> [--public-key <base64>]",
    );
    return 0;
  }
  if (command === "verify-export") {
    // Offline: no DATABASE_URL, no key ring. `--public-key` may repeat (rotated keys).
    const file = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--public-key");
    if (!file) {
      console.error("usage: fundroom-audit verify-export <bundle.zip> [--public-key <base64>]");
      return 2;
    }
    const keys = rest.flatMap((a, i) =>
      a === "--public-key" && rest[i + 1] ? [rest[i + 1] as string] : [],
    );
    const result = verifyExportBundle(new Uint8Array(readFileSync(file)), {
      ...(keys.length > 0 ? { trustedPublicKeys: keys } : {}),
    });
    console.error(formatExportVerification(result));
    return exportVerificationExitCode(result);
  }
  const url = envOrFile("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createDatabase({ connectionString: url, poolMax: 2 });
  try {
    switch (command) {
      case "verify": {
        const ring = keyRing();
        if (!ring)
          console.error("note: no key ring in the environment; checkpoint signatures not checked");
        const ws = flag(rest, "--workspace");
        const from = flag(rest, "--from");
        const opts = { db, keyRing: ring, ...(from ? { fromSeq: Number(from) } : {}) };
        const results = ws ? [await verifyWorkspace(opts, ws)] : await verifyAllWorkspaces(opts);
        console.error(formatVerification(results));
        return results.every((r) => r.ok) ? 0 : 1;
      }
      case "checkpoint": {
        const ring = keyRing();
        if (!ring)
          throw new Error("SECRET_KEY_RING or FUNDROOM_SECRET_KEY is required to sign checkpoints");
        const results = await writeAllCheckpoints({
          db,
          keyRing: ring,
          log: (e, f) => console.error(e, f),
        });
        for (const r of results)
          console.error(`${r.status.padEnd(9)} ${r.workspaceId} seq ${r.seq}`);
        return 0;
      }
      default:
        console.error(`unknown command ${command}`);
        return 2;
    }
  } finally {
    await db.close();
  }
}

if (basename(process.argv[1] ?? "").replace(/\.(?:c|m)?js$/u, "") === LEGACY_BIN)
  console.error(LEGACY_BIN_NOTE);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
