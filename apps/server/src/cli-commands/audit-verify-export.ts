import { readFileSync } from "node:fs";
import {
  type AnchorVerifier,
  exportPublicKeys,
  exportVerificationExitCode,
  formatExportVerification,
  verifyExportBundleAnchored,
} from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import { anchorVerifiers } from "../audit-anchoring.js";
import { anchorCertsFrom, flagValues, positional } from "./audit-anchor.js";

export const AUDIT_VERIFY_EXPORT_USAGE =
  "usage: fundroom audit verify-export <bundle.zip> [--public-key <base64>]... [--anchor-cert <pem file>]... [--rekor-origin <origin>]... [--require-anchors]";

/*
 * fundroom audit verify-export <bundle.zip> [--public-key <base64>]...
 *
 * Offline: needs no database. The signature is pinned to the `--public-key`s given (repeatable,
 * for rotated keys); with none, and a config whose key ring is loadable, to that ring's export
 * keys; with neither, only to the key embedded in the bundle — which proves integrity, not origin,
 * and the output says "UNVERIFIED ORIGIN". Exit 0 verified and trusted, 1 failed, 2 usage,
 * 3 intact but unpinned (UNVERIFIED ORIGIN).
 *
 * The config's ring holds only the keys it holds *today*: a bundle signed by a key since removed
 * from the ring fails here (NOT trusted) — verify it with the `--public-key` recorded when it was
 * exported (it is in the manifest and was on GET /api/v1/audit/export-key at the time).
 *
 * E3.13 (bundle version 2): every anchor in anchors.json is checked offline — the inclusion path
 * from the exported checkpoint to the anchored root, and each receipt with the adapters' verifiers
 * (`--anchor-cert <pem file>` pins TSA certificates / Rekor log keys; repeatable). A failing anchor
 * fails the bundle (exit 1); weaker anchors (unpinned, Rekor-only presence, late) leave it
 * verified. The output says how far an on-time trusted time-stamp covers the rows ("anchored
 * through seq N at T", then "seq N+1..M: not yet anchored"); `--require-anchors` exits 3 unless
 * such coverage exists (so also for a version-1 bundle or one without checkpoints in range).
 */
export async function runAuditVerifyExport(
  argv: readonly string[],
  cfg?: Pick<AppConfig, "keyRing">,
  verifiers: Readonly<Record<string, AnchorVerifier>> = anchorVerifiers(),
): Promise<number> {
  const file = positional(argv, ["--public-key", "--anchor-cert", "--rekor-origin"]);
  if (!file) {
    console.error(AUDIT_VERIFY_EXPORT_USAGE);
    return 2;
  }
  const pems = anchorCertsFrom(argv);
  if (!Array.isArray(pems)) {
    console.error(pems.error);
    return 2;
  }
  const requireAnchors = argv.includes("--require-anchors");
  const given = argv.flatMap((a, i) => {
    const next = argv[i + 1];
    return a === "--public-key" && next !== undefined ? [next] : [];
  });
  const trusted =
    given.length > 0
      ? given
      : cfg
        ? exportPublicKeys(cfg.keyRing).map((k) => k.publicKey)
        : undefined;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const result = await verifyExportBundleAnchored(bytes, {
    trustedPublicKeys: trusted,
    anchorVerifiers: verifiers,
    trustedAnchorPems: pems,
    trustedAnchorOrigins: flagValues(argv, "--rekor-origin"),
  });
  console.error(formatExportVerification(result));
  const code = exportVerificationExitCode(result, { requireAnchors });
  if (requireAnchors && code === 3 && result.ok && result.trusted === true) {
    console.error(
      "--require-anchors: no on-time trusted time-stamp (RFC 3161 against a pinned --anchor-cert) covers the exported rows",
    );
  }
  return code;
}
