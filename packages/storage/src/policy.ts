/*
 * Upload and delivery constants shared by the upload API (E1.3) and the adapters
 * (EXECUTION_PLAN §8, design/07 §6.4, ADR-0015).
 */

/** Multipart part size. S3 requires ≥ 5 MiB for every part but the last; 8 MiB keeps part counts low. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** S3 caps a multipart upload at 10 000 parts. */
export const MULTIPART_MAX_PARTS = 10_000;

/** How long presigned part / tus upload URLs stay valid (design/07 §6.4: 15 min). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Presigned GET for document delivery is capped at 60 s (ADR-0015). */
export const PRESIGNED_GET_MAX_SECONDS = 60;

/** Number of parts a multipart upload of `size` bytes needs at `partBytes` per part (≥ 1). */
export function partCountFor(size: number, partBytes: number = MULTIPART_PART_BYTES): number {
  if (!Number.isFinite(size) || size < 0)
    throw new RangeError("size must be a non-negative number");
  if (!Number.isInteger(partBytes) || partBytes <= 0) {
    throw new RangeError("partBytes must be a positive integer");
  }
  const parts = Math.max(1, Math.ceil(size / partBytes));
  if (parts > MULTIPART_MAX_PARTS) {
    throw new RangeError(
      `${size} bytes needs ${parts} parts of ${partBytes}; the multipart limit is ${MULTIPART_MAX_PARTS}`,
    );
  }
  return parts;
}
