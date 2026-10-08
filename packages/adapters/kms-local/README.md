# @fundroom/kms-local

`KmsPort` over the config key ring. The default for every
install: no external KMS, the key-encryption key is derived from `FUNDROOM_SECRET_KEY` /
`SECRET_KEY_RING`.

```ts
import { createLocalKms } from "@fundroom/kms-local";

const kms = createLocalKms({ keyRing: config.keyRing });
const { plaintext, wrapped, keyRef } = await kms.generateDataKey({ workspaceId });
// store `wrapped` + `keyRef` (core.workspace_key); use `plaintext` in memory only
const dek = await kms.unwrapDataKey(wrapped, keyRef, { workspaceId });
```

- KEK per ring entry = HKDF-SHA256(entry key, info `seed-host/kms/kek/v1`); a leaked derived
  KEK does not reveal the ring key or the identity kernel's sub-keys.
- Wrap = AES-256-GCM, `0x01 | iv(12) | ct(32) | tag(16)`, AAD = workspace id + purpose. A
  wrapped key moved to another workspace's row fails to unwrap (`unwrap_failed`; tamper,
  wrong workspace and wrong purpose are indistinguishable by design).
- `keyRef` is `local:<ring id>`. After `SECRET_KEY_RING=v2:…,v1:…`, `needsRewrap("local:v1")`
  is true and the daily `crypto.rewrap` job (`@fundroom/crypto`) moves every workspace key
  to `v2`; only then may `v1` be dropped from the ring. A ring without the referenced id
  fails with `unknown_key`.
- AWS KMS / GCP KMS / Vault Transit adapters implement the same port with their own
  `keyRef` prefixes; the per-tenant KEK ("crypto-shred one workspace by destroying its KEK")
  is the planned managed-host upgrade.
