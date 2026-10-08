# Runbook: external audit anchoring

Every workspace's audit log is a hash chain, and a daily job signs each chain's head with a key derived from
the master key ring. That stops anyone who has the database *but not the key* from
rewriting history. It does not stop someone who has both: the operator. External anchoring closes that gap.
Once a day the install hands a fingerprint of every new checkpoint to parties it does not control: an
RFC 3161 time-stamping authority, which signs **when** it saw it, and optionally the Sigstore Rekor
transparency log, which publishes **that** it saw it. From then on, an anchored checkpoint can be shown to
have existed by that time, to anyone, without trusting the install.

This runbook is for whoever runs the install: choosing anchors, pinning their certificates and keys, what
leaves the host, checking that it works, Rekor shard rotation, failures, and how a third party verifies a
proof with nothing but the CLI.

Reference material: `packages/audit` (`merkle.ts`, `anchor.ts`, `anchor-proof.ts`, `bundle.ts`), `packages/adapters/anchor-rfc3161`,
`packages/adapters/anchor-rekor`.

## The model

- **Checkpoints, batched.** The `audit.checkpoint` job (02:10 UTC) signs the head of every chain that moved,
  the platform chain included. The `audit.anchor` job (02:40 UTC) takes every checkpoint without an anchor
  (skipping, and logging as `audit.anchor_checkpoint_skipped`, any whose signature does not verify, so a
  forged checkpoint is never anchored), builds a Merkle tree over them (RFC 6962: leaf = SHA-256 of `0x00`
  and the checkpoint's canonical JSON; node = SHA-256 of `0x01`, left, right), and sends **only the 32-byte
  root** to each configured anchor. Each checkpoint gets a row with its inclusion path; each anchor's answer
  is stored as a receipt on the batch, **only if it verifies** against your pins. A batch holds up to 10 000
  checkpoints and a run makes up to 20 batches, so the first run after turning anchoring on catches up in one
  go on all but the largest installs.
- **RFC 3161 gives time; Rekor gives presence.** A time-stamp token is signed by the TSA over the root *and*
  its clock (`genTime`): that is the only **trusted time** the product counts. A Rekor v2 entry proves the
  root is in a public, append-only, witnessed log, but Rekor v2 asserts no time (the time stored with the
  receipt is your own clock at submission). A checkpoint anchored by Rekor alone is reported **present in
  log, no trusted time**, never `verified`. Use RFC 3161 for time evidence; add Rekor for public presence.
- **Off by default.** With `AUDIT_ANCHOR_DRIVERS` empty the job is not registered, nothing is sent anywhere,
  and verification never reports `anchor_missing`.
- **Verification is offline.** A receipt carries everything needed to check it (the TSA's signed token with
  its certificates; the Rekor entry with its inclusion proof and the log's signed checkpoint). Neither
  `fundroom audit verify` nor a third party contacts the anchor.

What an anchor proves: **this checkpoint existed no later than the anchor's trusted time**. Together with the
chain, every event up to that checkpoint existed then, unchanged. What it does not prove: anything about
events after the last anchored checkpoint (up to a day's worth), that every event that should have been logged
was logged, or who wrote an event. A checkpoint anchored more than 8 days after its head event (history that
existed before anchoring was turned on, or a long outage) is **anchored late**: it proves the checkpoint
existed from the anchor's time on, not since when it claims.

## What leaves the host

| Anchor | Sent | To |
|---|---|---|
| `rfc3161` | a standard `TimeStampReq`: the 32-byte root (as a SHA-256 message imprint), a random nonce, and "include your certificate". Nothing else | the TSA URLs in order, until one answers with a token that verifies |
| `rekor` | a `hashedrekord` entry: SHA-256 of the root, an ECDSA P-256 signature over the root, and the matching public key. **The entry is public and permanent**: anyone can read it | the configured Rekor shard |

No workspace id, name, slug, event or tenant data is sent. The Rekor public key is the install's *anchor
signing key*, derived from the master key ring (HKDF purpose `seed-host/audit/anchor-ecdsa-p256/v1`); it
links the install's entries to each other (one a day) but carries no name. A TSA learns your IP address and
the time.

**What tenants can see of each other.** A workspace's proof holds its own checkpoint, sibling *hashes* and the
root: no other workspace's id, sequence number or content. It does include the tree size and the leaf's
position, which is the number of checkpoints anchored that night: roughly how many workspaces (and the
platform chain) had audit activity that day. Staff of any workspace can see that number for every batch.
This is accepted as a property of the design; it reveals install activity, not tenants.

## What has to be true first

- **A worker running** for the daily job ([queue-backlog.md](queue-backlog.md)), and the worker able to reach
  the anchors over HTTPS. Calls go through a dedicated guarded outbound client: no redirects, a 1 MiB cap (the
  adapters cap TSA answers at 256 KiB), only the configured TSA and Rekor hosts may be private addresses.
- **Checkpoints being written**: `fundroom audit checkpoint` works and the `audit.checkpoint` job runs.
- **The CLI.** As in the other runbooks, `docker compose run --rm app <command>`; below, `fundroom`.

## Choose anchors

| Driver | What it gives | Depends on | Recommendation |
|---|---|---|---|
| `rfc3161` | A signed time-stamp from a TSA you name: **trusted time**, verifiable offline against the TSA's certificate | The TSA staying honest and its key uncompromised; you pin its certificate | **Start here, with two TSAs.** The job tries them in order and keeps the first that verifies, so one TSA's outage or certificate trouble does not leave a day without a time-stamp |
| `rekor` | An entry in Sigstore's public, append-only, witnessed transparency log: **presence**, publicly auditable, no time | The public Sigstore service (99.5 % availability target, no published terms or rate limits; treat it as best effort); you pin the shard's log key and origin | Optional addition for public evidence. One entry a day is a modest use of a public good |
| both | A time from a TSA and a public log entry: both must be wrong for a backdated history to pass | — | The strongest option |

TSAs checked on 2026-10-01 (each answered `Granted`, and each signer certificate has the critical
timeStamping-only extended key usage the adapter requires):

| TSA | URL | Pin |
|---|---|---|
| Sigstore | `https://timestamp.sigstore.dev/api/v1/timestamp` | its self-signed root `sigstore-tsa-selfsigned` (valid to 2035) |
| FreeTSA | `https://freetsa.org/tsr` | its root `Free TSA / Root CA` (valid to 2041); it signed with one certificate until March 2026 and with a new one (valid to 2040) since, both under that root |
| DigiCert | `http://timestamp.digicert.com` | DigiCert's time-stamping root. **HTTP only**, which is refused in `prod` and `staging` unless the host is operator-run; usable in other environments |

You can also run your own TSA (Sigstore's `timestamp-authority` is Apache-2.0). An operator-run TSA on a
private address is accepted over plain HTTP; it proves less, since you control it.

## Configure

```
# .env
AUDIT_ANCHOR_DRIVERS=rfc3161,rekor
AUDIT_ANCHOR_TSA_URLS=https://timestamp.sigstore.dev/api/v1/timestamp,https://freetsa.org/tsr
AUDIT_ANCHOR_TSA_CERTS_FILE=/run/secrets/tsa-certs.pem
AUDIT_ANCHOR_REKOR_URL=https://log2025-1.rekor.sigstore.dev
AUDIT_ANCHOR_REKOR_LOG_KEY_FILE=/run/secrets/rekor.pub
AUDIT_ANCHOR_REKOR_ORIGIN=log2025-1.rekor.sigstore.dev
#AUDIT_ANCHOR_TIMEOUT_MS=15000
```

The two `_FILE` variables point at PEM files you mount (they are not secret; the `*_FILE` convention is how a
multi-line value gets in). The reference Compose file passes them through; mount the files with a
`compose.override.yaml` on `app` and `worker`. Helm takes the same keys (see `values.yaml`).

Config refuses:

- a driver listed twice; TSA URLs or a Rekor URL without their driver;
- `rfc3161` without at least one URL and one `CERTIFICATE` block; `rekor` without a URL and at least one
  `PUBLIC KEY` block;
- a PEM block that does not parse, and a Rekor log key that is not Ed25519, ECDSA or RSA (the message names the
  block);
- a URL with a user name or password, a query or a fragment; plain `http:` in `prod`/`staging` for a host that
  is not operator-run;
- `AUDIT_ANCHOR_REKOR_LOG_KEY` holding **more than one key** without `AUDIT_ANCHOR_REKOR_ORIGIN`, or set
  **without the rekor driver** without it (see [Rekor shard rotation](#rekor-shard-rotation)).

Pins may stay configured with the driver off (*verification-only pins*): `AUDIT_ANCHOR_TSA_CERTS` and
`AUDIT_ANCHOR_REKOR_LOG_KEY` (with `AUDIT_ANCHOR_REKOR_ORIGIN`) keep verifying stored receipts after you stop
anchoring with that driver.

### Pin the TSA certificates

The bundle is the set of certificates a time-stamp's signer must be, or chain to. **Pin the TSA's root**, not
only its current signing certificate, so a routine re-issue under the same root (FreeTSA did one in 2026)
does not break anchoring. Fetch them, look at them, and keep a copy with your install records:

```
# Sigstore TSA: its chain (signing certificate + self-signed root)
curl -sf https://timestamp.sigstore.dev/api/v1/timestamp/certchain -o sigstore-tsa-chain.pem

# FreeTSA: the root, and both signing certificates (for reference)
curl -sf https://freetsa.org/files/cacert.pem -o freetsa-root.pem
curl -sf https://freetsa.org/files/tsa.crt -o freetsa-tsa-2026.pem
curl -sf https://freetsa.org/files/tsa.crt_expired -o freetsa-tsa-2016.pem

# Inspect before trusting: subject, issuer, validity, fingerprint
for f in sigstore-tsa-chain.pem freetsa-root.pem; do
  openssl x509 -in "$f" -noout -subject -issuer -dates -fingerprint -sha256
done

cat sigstore-tsa-chain.pem freetsa-root.pem > tsa-certs.pem
```

(`openssl x509` prints only the first certificate of a file; the Sigstore chain's second one is the root.)
Compare the fingerprints with what the TSA publishes through a second channel (its website; for Sigstore, the
`timestampAuthorities` entry of `trusted_root.json` below) before you rely on them. `fundroom doctor` prints
the SHA-256 fingerprint prefix of every pinned certificate in its `auditAnchoring` row.

### Pin the Rekor log key and origin

Sigstore publishes its logs' keys in `trusted_root.json`, distributed through its TUF repository. This fetches
the current file and extracts the key of the `log2025-1` shard:

```
TUF=https://tuf-repo-cdn.sigstore.dev
SNAP=$(curl -sf $TUF/timestamp.json | jq -r '.signed.meta["snapshot.json"].version')
TARGETS=$(curl -sf $TUF/$SNAP.snapshot.json | jq -r '.signed.meta["targets.json"].version')
HASH=$(curl -sf $TUF/$TARGETS.targets.json | jq -r '.signed.targets["trusted_root.json"].hashes.sha256')
curl -sf $TUF/targets/$HASH.trusted_root.json -o trusted_root.json
shasum -a 256 trusted_root.json            # must equal $HASH

jq -r '.tlogs[] | select(.baseUrl == "https://log2025-1.rekor.sigstore.dev") | .publicKey.rawBytes' \
  trusted_root.json | { echo "-----BEGIN PUBLIC KEY-----"; fold -w 64; echo "-----END PUBLIC KEY-----"; } \
  > rekor.pub
```

On 2026-10-01 that produced `MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=` (Ed25519, valid
from 2025-09-23). These `curl` calls trust HTTPS, not the TUF signatures; for a stronger check compare the key
with the copy in the `sigstore/root-signing` repository, or fetch `trusted_root.json` with a TUF client
(`cosign`, `sigstore-go`).

The **origin** is the first line of the log's signed checkpoint (`curl -s
https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint | head -1` prints `log2025-1.rekor.sigstore.dev`).
Every checkpoint must carry it, at anchor time and at verify time. It defaults to the URL's host, and `fundroom
doctor` warns until you set `AUDIT_ANCHOR_REKOR_ORIGIN` explicitly; set it, so a rotation cannot silently
drop it.

Then restart (`docker compose up -d`) and check:

```
fundroom doctor 2>&1 | grep auditAnchoring
#   auditAnchoring  rfc3161 (TSAs timestamp.sigstore.dev, freetsa.org; 3 pinned certificates (sha256 …)),
#                   rekor (log2025-1.rekor.sigstore.dev; origins log2025-1.rekor.sigstore.dev;
#                   1 pinned public key (sha256 …)), timeout 15000 ms
```

## Run it and check it

- **Daily:** the `audit.anchor` job at 02:40 UTC, 30 minutes after `audit.checkpoint`.
- **Now:** `fundroom audit checkpoint`, then `fundroom audit anchor`. It prints the batches, the number of
  checkpoints and, per batch and anchor, `ok` or `FAILED (<code>)`. Exit 0 when every anchor succeeded (or
  there was nothing to do), 1 when an anchor failed (later runs retry it) or a checkpoint could not be
  recorded (`SKIPPED …` with the ids; see the log), 2 when anchoring is off.
- **The platform audit chain** records each batch attempted as `audit.anchored` (batch id, leaf count, the
  anchors that succeeded, and the failures with their codes). The tenant chains record nothing: the anchor
  rows are their record.
- **`fundroom audit verify`** checks, for every anchored checkpoint, that its leaf recomputes from the
  checkpoint row, that the checkpoint's event id and head time match the actual head row, that the path leads
  to the batch root (and the batch's leaf count equals the tree size), and that each receipt verifies offline
  against the pinned certificates, keys and origins. Each workspace gets a line:
  `anchors: N anchored, V verified (trusted time), L late, P present in log without trusted time,
  U unverified origin, F failed, M missing`. Problem codes:

  | Code | Means | Fails `verify`? |
  |---|---|---|
  | `anchor_path_invalid` | the stored path does not lead to the root, or the leaf count differs: an anchor row was altered | yes |
  | `anchor_receipt_failed` | a receipt does not verify (signature, imprint, inclusion, a pinned key's bad signature) | yes |
  | `anchor_inconsistent` | the checkpoint's head event is dated more than 5 minutes **after** its trusted anchor time: impossible for a genuine checkpoint | yes |
  | `anchor_missing` | a checkpoint older than 8 days with no receipt while anchoring is configured | yes |
  | `anchor_late` | the earliest trusted time is more than 8 days after the checkpoint's head (or creation) | no: listed as a warning. History that existed when anchoring was first turned on is late by construction |

- **In the product:** **Audit log → External anchors** lists the workspace's checkpoints with a state:
  **Anchored** (at least one receipt), **Pending** (batched, no receipt yet, still inside the retry window, or
  not yet batched) or **Failed** (no receipt and the retry window is over, or the checkpoint failed its own
  checks), the receipts, and a **Proof** download (`audit.export`: owner, legal). Rekor receipts are worded
  as presence. The verify card shows the same summary as the CLI (`GET /api/v1/audit/verify`, at most 6 per
  member per minute).

## Verify a proof as a third party

This is what a counterparty, an auditor or an expert does **without access to the install**. A workspace owner
or legal member downloads the proof from **Audit log → External anchors → Proof**
(`GET /api/v1/audit/anchors/{checkpointId}/proof`, saved as `audit-anchor-proof-<seq>.json`). It holds:

```
{ "checkpoint": { "workspace_id", "seq", "hash", "event_id", "head_occurred_at", "previous_checkpoint_id" },
  "leafHash", "leafIndex", "path": [hex…], "treeSize", "root",
  "receipts": [ { "kind", "reference", "anchoredAt", "proof": { … } } ] }
```

For an RFC 3161 receipt, `proof` holds `token` (the base64 DER time-stamp token), `tsaUrl`, `serial`,
`policy`, `nonce`; for Rekor, `logUrl`, `origin` (informational) and the full log `entry` as returned.

The verifier needs the image (the `fundroom-audit` package CLI has no anchor commands) and the pins they
choose to trust, obtained **independently** with the commands above, never from the party handing over the
proof:

```
docker run --rm -v "$PWD:/in:ro" ghcr.io/fundroomhq/fundroom:<version> \
  audit verify-anchor /in/proof.json --anchor-cert /in/tsa-certs.pem \
  --anchor-cert /in/rekor.pub --rekor-origin log2025-1.rekor.sigstore.dev
```

`--anchor-cert` takes a file (every PEM block in it: TSA certificates, Rekor log keys) or a literal PEM, and is
repeatable; `--rekor-origin` is repeatable. It recomputes the leaf from the checkpoint and the root from the
path, then checks each receipt:

- **RFC 3161:** the imprint is the root; the CMS signature over the signed attributes is valid; the signing
  certificate attribute matches the signer; the signer has the critical, timeStamping-only extended key usage
  and was valid at `genTime`; the signer is a pinned certificate or chains to one; the stored time equals
  `genTime`.
- **Rekor:** the entry's digest is SHA-256 of the root and its signature verifies with the public key in the
  entry; the entry is included at its index under the log checkpoint (RFC 9162); the checkpoint carries a
  pinned origin and is signed by a pinned log key (witness co-signatures are ignored).

Output, one line per receipt (`existed by <time> (rfc3161 signed time)` or `present in log, no trusted time`),
then a verdict:

| Verdict | Exit | Means |
|---|---|---|
| `OK anchored` | 0 | a receipt verified against a pinned TSA with a time on time: the checkpoint existed by that time |
| `ANCHORED LATE` | 3 | trusted time more than 8 days after the checkpoint: it existed from then on, not when it claims |
| `PRESENT IN LOG, NO TRUSTED TIME` | 3 | only Rekor verified: the root is in the public log; no time evidence |
| `UNVERIFIED ORIGIN` | 3 | the path holds, but no receipt verified against the pins given (none given, or a different signer or origin) |
| `FAIL` | 1 | a path, receipt or consistency check failed |
| — | 2 | usage error, unreadable file |

Independent cross-check of the time-stamp with OpenSSL, no FundRoom code involved:

```
jq -r '.receipts[] | select(.kind == "rfc3161") | .proof.token' proof.json | base64 -d > token.der
openssl ts -verify -token_in -in token.der -digest "$(jq -r .root proof.json)" -CAfile tsa-certs.pem
openssl ts -reply -token_in -in token.der -text      # genTime, serial, policy, TSA name
```

(`-CAfile` needs the chain up to a self-signed root; pin roots, as above.)

**The whole log at once.** A workspace's signed audit export carries the same facts for every checkpoint in its
range: a bundle with anchored checkpoints is **version 2** (adds `anchors.json`); a range with no anchored
checkpoint still produces **version 1**, as before. Every checkpoint in a bundle must be bound to an exported
row (same sequence number, hash, event id and head time), or the bundle fails.

```
fundroom audit verify-export audit-export.zip --public-key <b64> \
  --anchor-cert tsa-certs.pem --anchor-cert rekor.pub --rekor-origin log2025-1.rekor.sigstore.dev \
  --require-anchors
```

It checks the chain, the export signature and every anchor, and says how far an on-time trusted time-stamp
covers the rows: `anchored through seq N at <time>`, then `seq N+1..M: not yet anchored`. A failing anchor
fails the bundle (exit 1); weaker anchors (unpinned, presence-only, late) leave the chain verified.
`--require-anchors` exits 3 unless at least one checkpoint inside the range has an on-time trusted
time-stamp against a pinned certificate, and no in-range anchor is late; a version-1 bundle always gives 3.

## Rekor shard rotation

Rekor v2 writes to a *shard* (`log2025-1` today); Sigstore starts a new one roughly every six months and
announces it by adding it to `signing_config` and its key to `trusted_root.json` (both in the TUF repository
above). A frozen shard stops accepting entries but stays readable, and its entries stay valid forever. There is
deliberately no default URL.

When a new shard appears:

1. Fetch `trusted_root.json` again (above), extract the new shard's key, and check `signing_config_rekor_v2`
   lists the new URL with a `validFor.start` that has begun.
2. Put the **new key first** and keep the old one after it in the key file:
   `cat rekor-<new>.pub rekor-log2025-1.pub > rekor.pub`.
3. List both origins, **new first**:
   `AUDIT_ANCHOR_REKOR_ORIGIN=<new origin>,log2025-1.rekor.sigstore.dev`. Config refuses several keys without
   this list, because without the old origin every old receipt would quietly become `unverified origin`.
4. Set `AUDIT_ANCHOR_REKOR_URL` to the new shard and restart. New entries go to the new shard (their
   checkpoints must carry the first origin); old receipts keep verifying against the old key and origin.
   Origins are one set for all pinned keys, not paired per key.
5. Archive every key and origin you have used, with their dates, next to the TSA pins, and give them to anyone
   verifying old proofs (`--anchor-cert`, `--rekor-origin`).

If you miss the switch, the old shard starts refusing writes: the `rekor` anchor fails (`rejected`) and is
retried for 7 days per batch; the TSA anchor keeps working.

**Turning Rekor off** but keeping its receipts verifiable: remove `rekor` from `AUDIT_ANCHOR_DRIVERS` and
`AUDIT_ANCHOR_REKOR_URL`, keep `AUDIT_ANCHOR_REKOR_LOG_KEY` and set `AUDIT_ANCHOR_REKOR_ORIGIN` (required then).
The same goes for TSA certificates you no longer anchor with.

## When anchoring fails

A failed anchor never blocks anything else: requests, the audit log and checkpoints go on. Failures show in
the worker log (`audit.anchor_driver_failed` with `errorCode`), in the `audit.anchored` platform audit row's
`failures`, and in `fundroom audit anchor`'s output.

| Code | Means | Fix |
|---|---|---|
| `unreachable` | no connection, DNS or TLS failure, an HTTP 5xx or 429, or the outbound guard refused the host | check egress from the worker to the anchor's host |
| `timeout` | no answer within `AUDIT_ANCHOR_TIMEOUT_MS` (Rekor v2 holds the request until its next checkpoint is published, a few seconds) | raise it (up to 120 000) if the anchor is merely slow |
| `rejected` | the anchor refused: an HTTP 4xx, a redirect (never followed), a TSA status other than granted, a frozen Rekor shard | read the log detail; check the URL is the final one; for Rekor, check for a shard rotation |
| `invalid_response` | an answer that does not parse, is over the size cap, or is "granted" without a token | an anchor fault or a proxy in the way; if it persists, take that anchor out |
| `verification_failed` | the answer parsed but does not verify against your pins (signer not pinned, wrong EKU, wrong imprint or nonce, unpinned Rekor origin or key). Nothing is stored, and the next TSA URL is tried | **do not unpin to make it pass.** The TSA re-issued its certificate under a root you have not pinned, Rekor rotated, or something is intercepting the call: check the anchor's announcements, re-pin from an independent source |

When every TSA URL fails, the code is the last one's and the message lists them all.

**Retries.** A batch is built once; each anchor that failed is retried on the following runs for the same
batch for 7 days (by the database clock), and a receipt is stored as soon as one verifies. A batch with no
receipt after 7 days is kept but never retried; its checkpoints show **Failed** on the card and
`anchor_missing` in `fundroom audit verify` once they are 8 days old. They are not re-anchored, but a *later*
anchored checkpoint covers the whole chain before it (the chain links them), so a gap costs precision of time,
not coverage.

**A checkpoint that cannot be recorded** in a batch (a database refusal) is left out of every tree for the run,
the batch is rebuilt without it, and `fundroom audit anchor` lists it as `SKIPPED` and exits 1. A checkpoint
whose own signature fails is never anchored and shows **Failed**. Both need investigating: see
[incident-response.md](incident-response.md).

**A TSA or log you no longer trust** (key compromise announced, misbehaviour): remove it from the drivers and
URLs but keep its pins (verification-only) for old receipts. Whether a receipt from a since-compromised TSA
still counts is a judgement for whoever relies on it (a compromise after the time-stamp does not invalidate it
by itself; that is why two TSAs are better). Receipts stored before the adapter began requiring a critical
timeStamping EKU would now verify as failed if their TSA lacked it; every TSA listed above complies.

**Turn it off:** empty `AUDIT_ANCHOR_DRIVERS` and restart. The job is no longer registered, stored anchors stay
(keep their pins configured to keep verifying them), and `anchor_missing` is no longer reported.

## Plans (managed host)

With `CONTROL_PLANE=on`, `anchoring` is a plan feature, but it gates only the **proof
download**. Every live workspace is anchored by the daily job and verified by `fundroom audit verify` and
`GET /api/v1/audit/verify` exactly as above, whatever its plan. For a workspace whose plan does not include
`anchoring`:

- `GET /api/v1/audit/anchors/{checkpointId}/proof` (**Proof** on the card) answers **`402 plan_limit`**
  `{ limit: "feature", feature: "anchoring" }`, after its own permission check (`audit.export`);
- **Audit log → External anchors** still lists the checkpoints, their state and receipts. The list
  (`GET /api/v1/audit/anchors`) carries `planAllows: false`, and the card disables **Proof** with "Your audit
  log is still anchored. Downloading proofs needs a plan that includes External audit anchoring.";
- once the plan includes `anchoring`, every past proof downloads at once. Nothing has to be re-anchored.

Why not skip those workspaces in the job? A run is one Merkle batch for the whole install, so leaving a
workspace out saves nothing, and excusing its unanchored checkpoints in verification would give someone with
database access a way to make a deleted anchor look like a plan choice.

## Keys

The anchor signing key (Rekor) is derived from the **current** master key-ring entry. Rotating the ring
([rotate-keys.md](rotate-keys.md)) changes the public key in new Rekor entries; verification uses the key
inside each entry, so old entries keep verifying. Removing an old ring entry does **not** affect anchor
verification (receipts verify with public material only), but it makes the HMAC signatures of checkpoints
signed under that entry unverifiable; their anchors still prove those checkpoints' hashes existed by the
anchored time.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `AUDIT_ANCHOR_DRIVERS` | empty (off) | csv of `rfc3161`, `rekor`, each at most once |
| `AUDIT_ANCHOR_TSA_URLS` | unset | required with `rfc3161`; csv, tried in order; `https:` in `prod`/`staging` unless operator-run; no user info, query or fragment |
| `AUDIT_ANCHOR_TSA_CERTS` (`_FILE`) | unset | required with `rfc3161`: PEM bundle, at least one `CERTIFICATE`; allowed alone as verification-only pins |
| `AUDIT_ANCHOR_REKOR_URL` | unset | required with `rekor`: the current shard; no default because shards rotate |
| `AUDIT_ANCHOR_REKOR_LOG_KEY` (`_FILE`) | unset | required with `rekor`: one or more `PUBLIC KEY` blocks (Ed25519, ECDSA or RSA), current shard first; allowed without the driver as verification-only pins |
| `AUDIT_ANCHOR_REKOR_ORIGIN` | the URL's host | csv of checkpoint origins, current first; **required** with more than one log key or with log keys but no rekor driver; doctor warns while it is defaulted |
| `AUDIT_ANCHOR_TIMEOUT_MS` | `15000` | 1 000–120 000, per anchor call |
