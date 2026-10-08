/*
 * `Content-Disposition: attachment` for a user-named file (ASVS V5.4.2, finding F-23).
 *
 * Two parameters, per RFC 6266 §4.3: `filename*=UTF-8''…` (RFC 8187) carries the real name and is
 * what every current browser uses; the quoted `filename="…"` is the fallback for the rest and
 * must be plain printable ASCII — a header value outside Latin-1 makes the Fetch `Headers`
 * constructor throw (a 500 for a document with a non-Latin name), and a backslash or quote
 * inside a quoted-string changes how the value is parsed.
 *
 * Both names lose what has no business in a file name on the recipient's disk: control
 * characters (CR/LF included), path separators, and the bidirectional overrides and isolates
 * that make `invoice<U+202E>fdp.exe` display as `invoiceexe.pdf`.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Bidi embeddings/overrides/isolates and marks (LRM, RLM, ALM). */
const BIDI_RE = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;
const SEPARATOR_RE = /[/\\]/gu;
const MAX_CHARS = 200;

/** The name as sent in `filename*`: well-formed Unicode without the characters above. */
export function safeFileName(name: string): string {
  const cleaned = name
    .toWellFormed()
    .replace(CONTROL_RE, "")
    .replace(BIDI_RE, "")
    .replace(SEPARATOR_RE, "_")
    .trim()
    .replace(/^\.+/u, "");
  const chars = Array.from(cleaned);
  const bounded = chars.length > MAX_CHARS ? chars.slice(chars.length - MAX_CHARS) : chars;
  return bounded.join("") || "download";
}

/** The quoted fallback: accents folded, then anything outside printable ASCII (and `"`, `\`, `%`) → `_`. */
export function asciiFileName(name: string): string {
  const folded = safeFileName(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]|["\\%]/gu, "_")
    .trim();
  return folded.replace(/^\.+/u, "") || "download";
}

/** RFC 8187 `value-chars`: `encodeURIComponent` leaves `'()*` and `!` alone; attr-char has no `'()*`. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentDisposition(fileName: string): string {
  const name = safeFileName(fileName);
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encodeRfc8187(name)}`;
}
