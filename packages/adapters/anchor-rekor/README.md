# @fundroom/anchor-rekor

`AuditAnchorPort` over a Sigstore Rekor v2 transparency log: the daily Merkle root of the
audit checkpoints is logged as a `hashedrekord` entry, and the full entry with its inclusion proof and signed
checkpoint is kept for offline verification. Rekor v2 signs **no time**: a receipt proves the root is
**present** in a public append-only log, not when it got there. Runtime dependency `@fundroom/ports` only.
Operations: [`docs/runbooks/audit-anchoring.md`](../../../docs/runbooks/audit-anchoring.md).

Exports `createRekorAnchor({ url, logPublicKeyPem, origin?, signingKey, http, timeoutMs, now? })`,
`verifyRekorReceipt` (typed `AuditAnchorPort["verify"]`; offline, never throws), `REKOR_ANCHOR_KIND`
(`"rekor"`), `REKOR_PROOF_VERSION`, `REKOR_MAX_RESPONSE_BYTES` (1 MiB), `REKOR_KEY_DETAILS`
(`PKIX_ECDSA_P256_SHA_256`), the types `RekorAnchorOptions` and `RekorProof`, the RFC 6962 helpers
(`leafHash`, `nodeHash`, `merkleRoot`, `inclusionPath`, `verifyInclusion`) and the C2SP signed-note helpers.
`./testing` exports `startStubRekor({ logKey?: "ed25519" | "ecdsa" })` → `{ url, logPublicKeyPem,
otherLogPublicKeyPem, control.mode, entries(), close() }`: a local Rekor v2 that keeps a real tree and
publishes signed notes (with a witness co-signature); its origin is `127.0.0.1`.

- **Entry.** The anchored *artifact* is the 32-byte root. `POST {url}/api/v2/log/entries` with
  `hashedRekordRequestV002 { digest: base64 SHA-256(root), signature: { content: ECDSA P-256 signature over
  the root (crypto.sign("sha256", root, key)), verifier: { publicKey: { rawBytes: DER SPKI }, keyDetails:
  PKIX_ECDSA_P256_SHA_256 } } }`. Pure Ed25519 is not accepted by Rekor for hashedrekord. The signing key is
  derived from the master key ring by `deriveAnchorSigningKey` in `@fundroom/audit` (HKDF purpose
  `seed-host/audit/anchor-ecdsa-p256/v1`). The request blocks until the log publishes a checkpoint that
  includes the entry (a few seconds); `redirect: "manual"`, own deadline, 1 MiB cap.
- **Receipt.** `kind: "rekor"`, `reference: "<url> logIndex N"`, `anchoredAt` = our clock at submission
  (`integratedTime` is always 0 in v2), `proof: { v: 1, logUrl, origin, entry: <TransparencyLogEntry as
  returned> }`. `origin` and `logUrl` are informational; verification never trusts them.
- **Verification** (`verify` and `verifyRekorReceipt`): the canonicalised body is a hashedrekord whose digest
  is SHA-256 of the digest given and whose signature verifies over it with the public key **in the body** (not
  pinned to our key, so entries from rotated ring entries keep verifying); the RFC 9162 inclusion of
  SHA-256(0x00 ‖ canonicalizedBody) at the entry's top-level `logIndex` against the checkpoint's size and root;
  the checkpoint is a C2SP signed note whose origin is **pinned** and which carries a valid signature by a
  **pinned** log key. Key ids follow rekor-tiles: Ed25519 SHA-256(name ‖ `\n` ‖ 0x01 ‖ raw)[:4], ECDSA
  SHA-256(DER SPKI)[:4]; RSA is supported. Unknown keys (witnesses) are ignored; a line claiming a pinned key
  id with a bad signature → `failed`; no pinned signature or an unpinned origin → `unverified_origin`.
  Verified results carry `timeTrusted: false` and the detail "present in the log …; no trusted time".
- **Pins.** `logPublicKeyPem` is one PEM, a bundle or a list (any pinned key verifies; no usable Ed25519,
  ECDSA or RSA key → the factory throws). `origin` is one or several origins: the **first** is the current
  shard's, which every checkpoint must carry at anchor time and in `healthCheck`; **all** are accepted by
  `verify` (default: the URL's hostname). Origins are one set shared by all pinned keys, not paired per key.
  The port's `verify` uses `trusted.pems` / `trusted.origins` when given, else the configured ones; the
  standalone `verifyRekorReceipt` uses only what it is given (no origins → `unverified_origin`).
- **Health.** `healthCheck()` fetches `GET {url}/api/v2/checkpoint` and verifies it against the pins and the
  current origin.
- **Errors** (`AnchorError`): as in `@fundroom/anchor-rfc3161` (`unreachable`, `timeout`, `rejected` for 3xx
  and 4xx, `invalid_response` for non-JSON or oversize answers, `verification_failed` for entry or checkpoint
  checks).

**Rekor in 2026.** The public v2 shard is `https://log2025-1.rekor.sigstore.dev` (origin
`log2025-1.rekor.sigstore.dev`, Ed25519 log key in Sigstore's `trusted_root.json`, valid from 2025-09-23).
Shards rotate roughly every six months and are announced through Sigstore's TUF `signing_config`; there is no
default URL. Sigstore targets 99.5 % availability and publishes no terms, rate limits or retention promise:
treat it as best effort. A live test runs with `FUNDROOM_TEST_LIVE_ANCHOR=1` (log2025-1 accepted an entry in
about 4.8 s on 2026-10-01 and it verified offline against the TUF-pinned key).
`describeAuditAnchorPortContract` runs against stub logs with Ed25519 and ECDSA keys, and each verification
rule is mutation-checked.
