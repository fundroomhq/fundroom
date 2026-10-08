import type { ExportManifest } from "./format.js";
import type { PlannedTable } from "./plan.js";

/** `README.md` inside the zip: what it is, what is (not) in it, and how to check it by hand. */
export function readmeText(
  manifest: Omit<ExportManifest, "files">,
  plan: readonly PlannedTable[],
): string {
  const skipped = manifest.tables.filter((t) => t.skipped !== undefined);
  const notes = plan
    .filter((p) => p.kernel !== undefined)
    .map((p) => `- \`${p.name}\` — ${p.kernel?.note ?? ""}`)
    .join("\n");
  return `# FundRoom workspace export

Workspace: ${manifest.source.name} (\`${manifest.source.slug}\`, \`${manifest.source.workspaceId}\`)
Exported: ${manifest.exportedAt} by FundRoom ${manifest.source.instanceVersion}
Format: \`${manifest.format}\` version ${manifest.version}
Signed with key \`${manifest.signature.keyId}\` (Ed25519, public key \`${manifest.signature.publicKey}\`).

That key is what the file says about itself. Compare it with the key the source instance
publishes at \`GET /api/v1/portability/export-key\` (Admin → Settings → Export workspace) and
record it when you download the export: the file proves its origin only against a key obtained
independently of it.

## Layout

- \`manifest.json\` — what the export claims: source, module versions and migrations, every table
  with its row count, and the sha256 of every other file.
- \`manifest.sig\` — base64 Ed25519 signature over the exact bytes of \`manifest.json\`.
- \`tables/<schema>.<table>.jsonl\` — one JSON object per row, the database's own column names.
  Generated columns are left out; numeric and bigint values are strings; \`bytea\` is \`\\x…\` hex.
  A file column holds \`blob:<sha256>\`, and \`$blobs\` in the same row names the original object.
- \`audit/events.jsonl\` — the source's hash-chained audit trail (\`{seq, canonical, hash}\`), with
  \`audit/checkpoints.json\`. It is evidence of the source; an import archives it and starts a new
  chain with a \`workspace.imported\` event that cites this file's head hash.
- \`blobs/<sha256>\` — every file the workspace holds (documents, logo, certificates), decrypted,
  named by the sha256 of its bytes.

${manifest.tables.length} tables (${skipped.length} not carried), ${manifest.blobs.count} files
(${manifest.blobs.bytes} bytes), ${manifest.audit.rows} audit events.

## What the kernel tables carry

${notes}

## Checking it

    fundroom workspace verify-export <this.zip> --public-key <base64 key>

Exit 0: verified and signed by a key you trusted; 1: it failed; 3 (\`UNVERIFIED ORIGIN\`):
internally consistent but checked only against its own embedded key.

By hand: \`sha256sum\` of every file must equal \`files\` in manifest.json, and

    (printf '\\x30\\x2a\\x30\\x05\\x06\\x03\\x2b\\x65\\x70\\x03\\x21\\x00'; \\
      echo '<base64 public key>' | base64 -d) | openssl pkey -pubin -inform DER -out pub.pem
    base64 -d manifest.sig > manifest.sig.bin
    openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in manifest.json -sigfile manifest.sig.bin

## Importing it

    fundroom workspace import <this.zip> --slug <new-slug> --public-key <base64 key>

creates a NEW workspace (every id is new), matches members to existing accounts by email, and
re-encrypts every file under the new workspace's keys. Custom domains, share-link tokens,
integration secrets, passkeys and MFA do not travel: see the FundRoom portability README.
`;
}
