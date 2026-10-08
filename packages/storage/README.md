# @fundroom/storage

Kernel-side helpers for object storage.
No I/O lives here: the adapters `@fundroom/storage-fs` and `@fundroom/storage-s3` implement
`ObjectStoragePort` from `@fundroom/ports`; this package owns the key layout, upload policy
constants and the contract test suite every adapter must pass.

```ts
import { blobKey, quarantineKey, renditionKey, parseObjectKey } from "@fundroom/storage";

blobKey(ws, sha256);                  // ws/<ws>/blobs/<sha256>        content-addressed, per tenant
quarantineKey(ws, uploadId);          // ws/<ws>/quarantine/<uploadId>  awaiting scan/sanitise
renditionKey(ws, versionId, "page", 3); // ws/<ws>/renditions/<versionId>/page/3
parseObjectKey(key);                  // { kind: "blob" | "quarantine" | "rendition" | "other", … }
```

Keys never carry original filenames; every tenant's objects sit under `ws/<workspace_id>/` so
one prefix can be listed, reconciled, purged or crypto-shredded. Inputs are validated (UUIDs,
hex digests) and the result passes `assertObjectKey` before it leaves this module.

Policy constants: `MULTIPART_PART_BYTES` (8 MiB), `MULTIPART_MAX_PARTS` (10 000),
`UPLOAD_URL_TTL_SECONDS` (15 min), `PRESIGNED_GET_MAX_SECONDS` (60), `partCountFor(size)`.

## Contract suite

```ts
import { describeObjectStorageContract } from "@fundroom/storage/testing";

describeObjectStorageContract("fs", {
  create: async () => ({ storage: createFsStorage({ root }), cleanup: () => rm(root) }),
});
```

Covers put/head/get (bytes and streams, byte ranges), missing keys, invalid keys, idempotent
delete, `deleteMany`, `copy`, prefix listing with cursors, sha256 verification, a multi-MiB
stream, `healthCheck`, and — gated on `capabilities` — presigned GET and presigned multipart
uploads exercised through real `fetch` calls.
