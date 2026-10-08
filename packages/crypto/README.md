# @fundroom/crypto

Envelope encryption for objects in storage. Two layers:

1. **Per-workspace data keys** (`createEnvelopeService`) in `core.workspace_key`, wrapped by a
   `KmsPort` adapter (`@fundroom/kms-local` by default).
2. **Streaming AEAD** (`encryptStream` / `decryptStream`) that encrypts each object under a key
   derived from the workspace DEK, in authenticated 64 KiB chunks.

```ts
import { createEnvelopeService, encryptStream, decryptRange, ciphertextRangeFor, HEADER_BYTES } from "@fundroom/crypto";

const envelope = createEnvelopeService({ db, kms });

// write: the blob row records which key encrypted it
const { keyId, keyRef, key } = await envelope.currentKey(tx, ctx);
await storage.put(blobKey, encryptStream(key, plaintextStream));
// blob.encryption = { format: "she1", keyId, keyRef }

// read (viewer tile / download): any key the workspace ever had still decrypts
const dek = await envelope.keyById(tx, ctx, blob.encryption.keyId);
const header = await readBytes(storage.get(blobKey, { range: { start: 0, end: HEADER_BYTES - 1 } }));
const r = ciphertextRangeFor({ start, end });
const part = await storage.get(blobKey, { range: { start: r.start, end: r.end } });
const plaintextRange = decryptRange(dek.key, header, part.body, { start, end });
```

## Object format (`SHE1`)

```
┌──────┬────┬──────────┬──────────────────────┬──────────────────────┬     ┬──────────────────────┐
│ SHE1 │ 01 │ salt(16) │ ct_0 (64 KiB) tag_0  │ ct_1 (64 KiB) tag_1  │ ... │ ct_n (≤64 KiB) tag_n │
└──────┴────┴──────────┴──────────────────────┴──────────────────────┴     ┴──────────────────────┘
 header (21 bytes, AAD for every chunk)

object key = HKDF-SHA256(workspace DEK, salt, "seed-host/object-key/v1")
nonce_i    = counter_i (11 bytes big-endian) ‖ last_flag (0x01 only on the final chunk)
chunk_i    = AES-256-GCM(object key, nonce_i, plaintext[i·64Ki .. ], aad = header)
```

The construction is age's STREAM / Tink streaming AEAD. Consequences:

- Every emitted plaintext byte is authenticated; a decryptor needs 64 KiB of buffer, not the
  whole object.
- The counter defeats reordering and duplication; the last flag defeats truncation
  (`StreamAeadError.code = "truncated"`); a bit flip anywhere is `authentication_failed`.
- Byte ranges (PDF page tiles, video seeks) decrypt only the chunks they cover:
  `ciphertextRangeFor` says which stored bytes to fetch, `decryptRange` trims to the exact
  plaintext range. Partial reads pass `expectLast: false` and must supply the header.
- One random salt per object: the workspace DEK is never used directly, so nonce reuse across
  objects is impossible. `ciphertextLength` / `plaintextLength` are exact.
- An empty object is 37 bytes (header + one empty final chunk with its tag).

## Keys

- `currentKey(tx, ctx)` returns the workspace's active DEK, creating it on first use inside
  the caller's tenant transaction (a lost race on the partial unique index re-reads the
  winner). `keyById` returns any key the workspace ever had, active or retired.
- `rotate` retires the active key and creates a successor (`rotated_from_id`). Old blobs keep
  their `keyId` and keep decrypting; new writes use the new key. Re-encrypting old blobs is
  a data-room job, not this package's.
- `rewrap` (and the daily `crypto.rewrap` job, 03:20 UTC) moves every wrapped DEK whose
  `kms_key_ref` is stale to the current KEK. After `SECRET_KEY_RING=v2:…,v1:…` this is what
  lets the operator drop `v1` once the job has run.
- Plaintext DEKs live in a per-process cache keyed by `workspaceId:keyId` with a 10-minute
  TTL; `invalidate(workspaceId?)` and `stats()` exist for tests and the admin health page.
- The app role can `SELECT`/`INSERT`/`UPDATE` `core.workspace_key` but not `DELETE`
  (migration 0003). Keys are retired, never removed.

## Threat notes

| Leak | Consequence |
|---|---|
| Object storage bucket / backup | Useless: every object is `SHE1` under a per-object key; the DEK is not in the bucket. |
| Database dump | Wrapped DEKs only; the KEK lives in the key ring / KMS, never in Postgres. |
| One workspace's DEK | That workspace's objects. Nothing else: DEKs are per workspace and the wrap binds the workspace id. |
| Key ring (`kms-local`) | Everything, as with any single-KEK design. Per-tenant KEKs (true per-tenant crypto-shred) are a planned managed-host upgrade; the port already carries `keyRef` per row so that adapter drops in. |

Crypto-shredding a workspace = deleting the workspace row: `core.workspace_key` cascades, and
objects left in storage are unreadable. SSE-S3/SSE-KMS on the bucket remains belt and braces.
