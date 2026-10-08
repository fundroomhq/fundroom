# @fundroom/anchor-rfc3161

`AuditAnchorPort` over RFC 3161 time-stamping authorities: the daily Merkle root of the
audit checkpoints is time-stamped by a TSA, and the token is verified offline against operator-pinned
certificates. This is the anchor that gives **trusted time**. Runtime dependencies `@fundroom/ports`,
`pkijs` and `asn1js` (BSD-3, parsing only; signatures are checked with `node:crypto`). Operations:
[`docs/runbooks/audit-anchoring.md`](../../../docs/runbooks/audit-anchoring.md).

Exports `createRfc3161Anchor({ urls, trustedPems, http, timeoutMs, now?, randomBytes? })`,
`verifyRfc3161Receipt` (typed `AuditAnchorPort["verify"]`; offline, never throws), `RFC3161_ANCHOR_KIND`
(`"rfc3161"`), `RFC3161_MAX_RESPONSE_BYTES`, `RFC3161_PROOF_VERSION`, the types `Rfc3161AnchorOptions` and
`Rfc3161Proof`, and the pure pieces (`buildTimeStampRequest`, `parseTimeStampResponse`,
`verifyTimeStampToken`). `./testing` exports `startStubTsa({ chain?, eku? })` → `{ url, trustedPem,
signerPem, control.mode, requests(), close() }`: a local TSA that issues real tokens (OpenSSL 3 `ts -verify`
accepts them), with modes for failures.

- **Request.** A hand-built DER `TimeStampReq`: version 1, SHA-256 message imprint of the 32-byte root, a
  random 8-byte nonce, `certReq: true`. `POST` with `Content-Type: application/timestamp-query`,
  `redirect: "manual"`, its own `AbortSignal.timeout(timeoutMs)` and a 256 KiB response cap on top of the
  guarded client's. The URLs are tried in order; the first token that **verifies against the pins** is
  returned (an unpinned or otherwise unverifiable token is `verification_failed` and the next URL is tried).
- **Receipt.** `kind: "rfc3161"`, `reference: "<url> serial <hex>"`, `anchoredAt` = the token's `genTime`,
  `proof: { v: 1, token: <base64 DER ContentInfo>, tsaUrl, serial, policy, nonce, hashAlgorithm: "sha256" }`.
- **Verification** (`verify` and `verifyRfc3161Receipt`): status granted (0 or 1) with a token; the imprint is
  SHA-256 over the digest given; the nonce matches (at anchor time); the CMS signature over the original
  signed-attributes bytes is valid and their message digest matches the TSTInfo; an ESS signing-certificate
  (v1 or v2) attribute names the signer certificate; the signer's extended key usage is exactly
  id-kp-timeStamping and critical (RFC 3161 §2.3); the signer is valid at `genTime`; the signer **is** a
  pinned certificate or chains to one (issuer check, signature, CA flag, validity at `genTime`); the receipt's
  `anchoredAt` equals `genTime`. Valid but not chained to a pin (or nothing pinned) → `unverified_origin`.
  Verified results carry `timeTrusted: true`. The port's `verify` uses the configured pins unless `trusted.pems`
  is given.
- **Errors** (`AnchorError`): connection failure, HTTP 5xx or 429, a guard refusal → `unreachable`; the
  deadline → `timeout`; a 3xx, HTTP 4xx, PKIStatus ≥ 2 or a digest that is not 32 bytes → `rejected`; an
  oversize, non-DER or tokenless answer → `invalid_response`; any token check → `verification_failed`. When
  every URL fails, the code is the last one's and the message lists them all.

**Live check (2026-10-01).** `https://timestamp.sigstore.dev/api/v1/timestamp` and `https://freetsa.org/tsr`
issued tokens that verified against their pinned roots; Sigstore's, FreeTSA's and DigiCert's signer
certificates all carry the critical timeStamping-only EKU. A live test runs with
`FUNDROOM_TEST_LIVE_ANCHOR=1` (skipped by default). `describeAuditAnchorPortContract` from
`@fundroom/audit/testing` runs against the stub TSA, and each verification rule is mutation-checked.
