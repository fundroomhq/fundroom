/**
 * Minimal, bounded extraction of one text field from a `multipart/form-data` body — enough for
 * Dropbox Sign callbacks, which POST the event as a form field named `json`. Deliberately strict:
 * the boundary must come from the Content-Type header (RFC 2046: 1–70 chars), the body must carry
 * the closing delimiter (a truncated body is refused), the field must be found by its
 * Content-Disposition name, and the body size is capped before any work is done.
 * Returns undefined for anything else; never throws.
 */

export const MAX_MULTIPART_BYTES = 1024 * 1024;

const BOUNDARY_RE = /;\s*boundary=(?:"([^"\r\n]{1,70})"|([^\s;"]{1,70}))/i;

export function multipartField(
  contentType: string | null,
  body: Uint8Array,
  field: string,
): string | undefined {
  try {
    if (!contentType || !/^\s*multipart\/form-data\s*;/i.test(contentType)) return undefined;
    if (body.byteLength === 0 || body.byteLength > MAX_MULTIPART_BYTES) return undefined;
    const m = BOUNDARY_RE.exec(contentType);
    const boundary = m?.[1] ?? m?.[2];
    if (!boundary) return undefined;
    // latin1 maps bytes 1:1 onto code units, so string offsets are byte offsets.
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const text = buf.toString("latin1");
    const delimiter = `--${boundary}`;
    const close = `\r\n${delimiter}--`;
    if (!text.startsWith(delimiter) && !text.includes(`\r\n${delimiter}`)) return undefined;
    if (!text.includes(close)) return undefined;

    let pos = text.indexOf(delimiter);
    for (let parts = 0; pos >= 0 && parts < 64; parts++) {
      const afterDelim = pos + delimiter.length;
      if (text.startsWith("--", afterDelim)) return undefined; // closing delimiter reached
      const headerStart = text.indexOf("\r\n", afterDelim);
      if (headerStart < 0) return undefined;
      const headerEnd = text.indexOf("\r\n\r\n", headerStart);
      if (headerEnd < 0) return undefined;
      const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
      if (next < 0) return undefined;
      const headers = text.slice(headerStart + 2, headerEnd);
      const disposition = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(headers)?.[1] ?? "";
      const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
      if (name === field) return buf.subarray(headerEnd + 4, next).toString("utf8");
      pos = next + 2;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
