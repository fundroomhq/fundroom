# @fundroom/storage-s3

`ObjectStoragePort` over the AWS SDK v3. One adapter for
S3, Cloudflare R2, Backblaze B2, Garage and SeaweedFS; `STORAGE_DRIVER=s3` with
`S3_BUCKET`, `S3_REGION` or `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_FORCE_PATH_STYLE`.

```ts
import { createS3Storage } from "@fundroom/storage-s3";

const storage = createS3Storage({
  bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, keyPrefix: "fundroom/",
});

// Browser upload: presigned multipart to a quarantine key.
const upload = await storage.multipart.create(quarantineKey(ws, uploadId), { contentType });
const url = await storage.multipart.presignPart(upload, 1, { expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
await storage.multipart.complete(upload, [{ partNumber: 1, etag }]);

// Large media only: presigned GET, capped at 60 s.
await storage.presignGet(key, { expiresInSeconds: 60, responseContentDisposition: "attachment" });
```

- The client runs with `requestChecksumCalculation: WHEN_REQUIRED` /
  `responseChecksumValidation: WHEN_REQUIRED`: the SDK's newer default of CRC32 trailers on
  every request is rejected by most S3-compatibles.
- A caller-supplied `sha256` is sent as `ChecksumSHA256` (verified in flight by AWS S3),
  recomputed by the adapter while the body streams (SeaweedFS ignores the header; a mismatch
  deletes the just-written object), and stored as user metadata `sha256` so `head` returns
  it on every backend.
- Streaming bodies need `contentLength` (S3 requires it); `Uint8Array` bodies do not.
- `copy` HEADs the source first so a missing source is `not_found` on every backend;
  `deleteMany` batches by 1000; `list` uses ListObjectsV2 continuation tokens as cursors.
- Errors: 404s become `undefined`; digest failures `checksum_mismatch`; anything else
  `StorageError("backend")` with the SDK error as `cause`.

Integration tests run the port contract against SeaweedFS (`chrislusf/seaweedfs`, the
Compose stack's object store). Set `FUNDROOM_TEST_S3_IMAGE` to try another image.
