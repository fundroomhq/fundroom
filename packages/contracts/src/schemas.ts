import { z } from "@hono/zod-openapi";

/** Shared field vocabulary. Modules reuse these so the generated client sees one type per concept. */

export const UuidSchema = z.uuid().openapi({
  example: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  description: "UUID (v7 for rows this server created)",
});

/**
 * The addresses the API takes: zod's practical subset of RFC 5322 for the local part, capped at 64
 * octets (RFC 5321 §4.5.3.1.1), and a domain of well-formed DNS labels — no leading or trailing
 * hyphen, at most 63 each, 253 in all — under an alphabetic TLD. zod's own default would take
 * `a@b-.com` and a 65-character local part, which no mail server delivers to.
 *
 * `format: email` alone promises RFC 5322 in full (`a|b@example.com` included), so the document
 * states the pattern too: a client — or a contract fuzzer — generating addresses from the schema
 * produces only ones the server accepts.
 */
export const EMAIL_PATTERN =
  /^(?=[^@]{1,64}@)(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?=[^@]{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;

export const EmailSchema = z
  .email({ pattern: EMAIL_PATTERN })
  .max(320)
  .openapi({ example: "ada@example.com", pattern: EMAIL_PATTERN.source });

/**
 * The characters `String.prototype.trim()` strips: ECMAScript WhiteSpace and LineTerminator
 * (tab, LF, VT, FF, CR, space, NBSP, U+FEFF, the `Zs` separators, LS, PS).
 *
 * Spelled out instead of `\s`. In JavaScript `\s` is exactly this set, but a `pattern` in the
 * document is also evaluated by engines whose `\s` differs: Python's, for one, matches U+001C to
 * U+001F and U+0085 (which `trim()` keeps) and does not match U+FEFF (which `trim()` strips), so
 * a generator reading `\S` there would produce a lone U+FEFF that the server trims to nothing.
 */
export const TRIMMED_CHARACTERS =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

/**
 * Holds for a string exactly when `trim()` leaves at least `min` characters of it: two
 * characters `trim()` keeps, `min - 1` apart (one such character for `min` 1). Unanchored, as
 * a JSON Schema `pattern` is. Counts code points, as zod's length checks and JSON Schema's
 * `minLength` do.
 */
export function nonBlankPattern(min = 1): RegExp {
  const kept = `[^${TRIMMED_CHARACTERS}]`;
  // Built only from the constant character class and an integer; no input reaches it.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(min <= 1 ? kept : `${kept}[\\s\\S]{${min - 2},}${kept}`, "u");
}

/**
 * Free text the server trims before it checks the length: `"  "` is as empty as `""`.
 *
 * The length checks apply to the trimmed value, but the document can only state `minLength`
 * of the value as sent, which a string of spaces satisfies. With `min` above zero the schema
 * also carries {@link nonBlankPattern}, so the document says what the trimmed `min` means and a
 * client (or a contract fuzzer) generating from it never produces a blank value the server
 * refuses. The pattern cannot fail where `min` passes; `min` aborts, so a blank value is refused
 * with the same single "too small" issue as before.
 */
export function trimmedText(options: { readonly min?: number; readonly max: number }) {
  const { min = 0, max } = options;
  const text = z.string().trim();
  if (min <= 0) return text.max(max);
  return text.min(min, { abort: true }).max(max).regex(nonBlankPattern(min));
}

/** Workspace slug: DNS label (`core.workspace.slug` CHECK). */
/**
 * Path segments reserved under `/embed/`, and therefore unavailable as workspace slugs (E2.2,
 * ADR-0040 decision 9). `${basePath}/embed/v1/embed.js` serves the loader, so a workspace slugged
 * `v1` would have an embed URL the classifier cannot route — the collision is decided in favour of
 * the loader, because one workspace's name is negotiable and the published snippet URL is not.
 * Refusing the slug at creation is the honest half of that: a workspace that could be created and
 * then could never be embedded is worse than a name the founder has to change once.
 */
export const RESERVED_SLUG_RE = /^(?:v\d+|\d+\.\d+\.\d+)$/u;

export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, "lower-case DNS label")
  .refine((v) => !RESERVED_SLUG_RE.test(v), {
    message: "version-shaped slugs are reserved for the embed loader",
  })
  // The document states the label rule and the reservation as one pattern (a DNS label cannot
  // contain the dots of the `x.y.z` form, so `v<digits>` is the only reserved shape it can take).
  .openapi({ example: "acme", pattern: "^(?!v[0-9]+$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" });

export const TimestampSchema = z.iso.datetime({ offset: true }).openapi({
  example: "2026-09-11T10:15:30.000Z",
  description: "RFC 3339 timestamp, UTC",
});

export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

export const RequestIdHeaderSchema = z.object({
  "x-request-id": z
    .string()
    .max(128)
    .optional()
    .openapi({ description: "Client-supplied request id; echoed back when it is well-formed" }),
});

export function paginationQuery(maxLimit = 100) {
  return z.object({
    cursor: z
      .string()
      .max(512)
      .optional()
      .openapi({ description: "Opaque cursor from a previous page" }),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(Math.min(50, maxLimit)),
  });
}

export function page<T extends z.ZodType>(item: T, name?: string) {
  const schema = z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  });
  return name === undefined ? schema : schema.openapi(name);
}

export function isoDate(d: Date): string {
  return d.toISOString();
}
