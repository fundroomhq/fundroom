# @fundroom/storage-fs

`ObjectStoragePort` over a local directory plus a tus
resumable-upload server for app-proxied uploads. The default for
`STORAGE_DRIVER=fs`: no object store to run, at the cost of a single-node ceiling (no CDN,
no presigned URLs — documents stream through the app, which the design wants anyway).

```ts
import { createFsStorage, createTusUploadServer } from "@fundroom/storage-fs";

const storage = createFsStorage({ root: config.raw.STORAGE_FS_PATH, log });
await storage.put(quarantineKey(ws, uploadId), body, { contentLength, sha256, contentType });
const read = await storage.get(blobKey(ws, sha256), { range: { start: 0, end: 65535 } });
```

Layout under `root`: `objects/<key>` (bytes), `meta/<key>.json` (content type, user metadata,
size, sha256, etag, last-modified), `tmp/` (in-flight writes). Every write streams into a
temp file with the digest computed on the way, is fsync'ed, renamed into place, and only then
gets its sidecar — a reader never sees a partial object, and a `sha256`/`contentLength`
mismatch leaves nothing behind. Keys are validated by the port and re-checked against the
root after path resolution. `etag` is the content sha256. `list` walks the tree under the
prefix in key order with the last key as cursor. `presignGet` and `multipart.*` reject with
`unsupported`; `capabilities.tus` is true instead.

## tus uploads

```ts
const tus = createTusUploadServer({
  storage,
  stagingDir: `${root}/staging`,
  path: "/api/v1/uploads/tus",
  maxSize: config.raw.UPLOAD_MAX_BYTES,
  resolveUpload: async (request, uploadId) => {
    const row = await uploads.findPending(uploadId, sessionOf(request)); // E1.3
    return row ? { key: quarantineKey(row.workspaceId, row.id), maxSize: row.declaredSize } : undefined;
  },
  onUploadFinish: async ({ uploadId, key, stat }) => uploads.markStaged(uploadId, stat),
});
app.all("/api/v1/uploads/tus/*", (c) => tus.handle(c.req.raw));
```

The app names the upload: `POST /uploads` issues the id, the tus client sends it back in
`Upload-Metadata: upload <base64 id>`, and every request is resolved through `resolveUpload`
(unknown → 404, over the ceiling → 413). The destination key never comes from the client.
When the last byte lands, the staged file is streamed into `storage.put(key)` and removed;
`cleanupExpired()` drops abandoned uploads (schedule it from a job).
