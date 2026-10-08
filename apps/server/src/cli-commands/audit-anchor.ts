import { readFileSync } from "node:fs";
import {
  type AnchorVerifier,
  anchorPending,
  anchorProofExitCode,
  formatAnchorProofVerification,
  verifyAnchorProof,
} from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import type { Database } from "@fundroom/db";
import type { AuditAnchorPort } from "@fundroom/ports";
import { anchorVerifiers, createAuditAnchoring } from "../audit-anchoring.js";

/*
 * `fundroom audit anchor` and `fundroom audit verify-anchor` (E3.13, ADR-0061).
 *
 *   fundroom audit anchor
 *       Runs one anchoring pass now (what the daily `audit.anchor` job does): batches every
 *       checkpoint without an anchor and anchors the root with every configured driver, retrying
 *       drivers that failed for batches of the last 7 days. Exit 0 all drivers succeeded (or
 *       nothing to do), 1 a driver failed (the next run retries) or a checkpoint could not be
 *       recorded in a batch (skipped), 2 anchoring is not configured.
 *
 *   fundroom audit verify-anchor <proof.json> [--anchor-cert <pem file>]...
 *       Offline (no database, no config): checks a proof from
 *       `GET /api/v1/audit/anchors/{checkpointId}/proof`. Exit 0 verified against a pinned signer,
 *       1 failed, 2 usage, 3 the path holds but no receipt verified against a pinned signer
 *       (UNVERIFIED ORIGIN: pass the TSA certificate / Rekor log public key with --anchor-cert).
 *
 * The `fundroom-audit` package CLI has neither: building drivers needs the adapters and the
 * guarded outbound client, and `@fundroom/audit` imports no adapter (verifiers are injected).
 */
export const AUDIT_ANCHOR_USAGE = "usage: fundroom audit anchor";
export const AUDIT_VERIFY_ANCHOR_USAGE =
  "usage: fundroom audit verify-anchor <proof.json> [--anchor-cert <pem file>]... [--rekor-origin <origin>]...";

/** Every PEM block (certificates, public keys) in the `--anchor-cert` files or literals. */
export function anchorCertsFrom(argv: readonly string[]): string[] | { error: string } {
  const pems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--anchor-cert") continue;
    const value = argv[i + 1];
    if (value === undefined) return { error: "--anchor-cert needs a PEM file" };
    let text: string;
    try {
      text = value.startsWith("-----BEGIN ") ? value : readFileSync(value, "utf8");
    } catch (error) {
      return {
        error: `cannot read ${value}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const blocks = text.match(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/gu) ?? [];
    if (blocks.length === 0) return { error: `${value} holds no PEM block` };
    pems.push(...blocks);
  }
  return pems;
}

/** Every value of a repeatable `--flag <value>`. */
export function flagValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => {
    const next = argv[i + 1];
    return a === name && next !== undefined ? [next] : [];
  });
}

/** The first argument that is neither a flag nor a flag's value. */
export function positional(argv: readonly string[], valued: readonly string[]): string | undefined {
  return argv.find((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));
}

export async function runAuditAnchor(
  cfg: Pick<AppConfig, "raw" | "keyRing">,
  db: Database,
  options: { readonly drivers?: readonly AuditAnchorPort[]; readonly now?: () => Date } = {},
): Promise<number> {
  const anchoring = createAuditAnchoring({ config: cfg, drivers: options.drivers });
  try {
    if (anchoring.drivers.length === 0) {
      console.error("audit anchoring is off: AUDIT_ANCHOR_DRIVERS is empty");
      return 2;
    }
    const r = await anchorPending({
      db,
      drivers: anchoring.drivers,
      keyRing: cfg.keyRing,
      now: options.now,
      log: (e, f) => console.error(e, JSON.stringify(f ?? {})),
    });
    if (r.batchIds.length === 0) console.error("no new checkpoints to anchor");
    else
      console.error(
        `${r.batchIds.length} batch(es), ${r.leaves} checkpoint(s): ${r.batchIds.join(", ")}`,
      );
    if (r.skipped > 0) {
      console.error(
        `SKIPPED ${r.skipped} checkpoint(s) whose anchor row could not be written (left out of every tree; see the log): ${r.skippedCheckpointIds.join(", ")}`,
      );
    }
    for (const a of r.receipts) {
      console.error(`  ${a.batchId} ${a.kind.padEnd(8)} ${a.ok ? "ok" : `FAILED (${a.code})`}`);
    }
    return r.skipped === 0 && r.receipts.every((a) => a.ok) ? 0 : 1;
  } finally {
    await anchoring.close();
  }
}

export async function runAuditVerifyAnchor(
  argv: readonly string[],
  verifiers: Readonly<Record<string, AnchorVerifier>> = anchorVerifiers(),
): Promise<number> {
  const file = positional(argv, ["--anchor-cert", "--rekor-origin"]);
  if (!file) {
    console.error(AUDIT_VERIFY_ANCHOR_USAGE);
    return 2;
  }
  const pems = anchorCertsFrom(argv);
  if (!Array.isArray(pems)) {
    console.error(pems.error);
    return 2;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const v = await verifyAnchorProof(doc, {
    verifiers,
    trustedPems: pems,
    trustedOrigins: flagValues(argv, "--rekor-origin"),
  });
  console.error(formatAnchorProofVerification(v));
  return anchorProofExitCode(v);
}
