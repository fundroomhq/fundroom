/*
 * How the database and SMTP drivers will read their connection URLs (E2.10 F-08/F-09, review R2-01).
 *
 * The transport rules in `crossFieldRules` must judge the URL the way the driver that uses it
 * does, not the way a generic URL parser does: otherwise a URL can satisfy the rule on paper while
 * the driver connects in the clear. Config cannot depend on the drivers, so these functions
 * reproduce the parts of their parsers that decide host and TLS, and `transport.test.ts` checks
 * them against the real `pg-connection-string` and `nodemailer` parsers.
 *
 * pg (`pg-connection-string`): `new URL(str, "postgres://base")`; query parameters are read in
 * order and the **last** occurrence wins; a `host` parameter replaces the URL's host; the fragment
 * is not part of the query.
 *
 * nodemailer (`shared.parseConnectionUrl`): legacy `url.parse(str, true)`; a repeated parameter
 * becomes an array (truthy); numeric strings become numbers (`""` → 0), `"true"`/`"false"`
 * become booleans; a parameter whose option the URL already set (`host`, `port`, `secure`, auth)
 * is ignored; any truthy `ignoreTLS` skips STARTTLS; `tls.*` goes to the TLS options.
 */

export interface PgTransport {
  /** The host pg connects to; `""` for a Unix socket path or no host; `undefined` if unparseable. */
  readonly host: string | undefined;
  /** The `sslmode` pg uses (the last one in the URL). */
  readonly sslmode: string | undefined;
}

/** pg-connection-string's reading of host and sslmode. */
export function pgTransportOf(url: string): PgTransport {
  let str = url;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/iu.test(str)) {
    str = encodeURI(str).replace(/%25(\d\d)/gu, "%$1");
  }
  let parsed: URL;
  let dummyHost = false;
  try {
    try {
      parsed = new URL(str, "postgres://base");
    } catch {
      parsed = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
      dummyHost = true;
    }
  } catch {
    return { host: undefined, sslmode: undefined };
  }
  const params = new Map<string, string>();
  for (const [k, v] of parsed.searchParams.entries()) params.set(k, v); // last wins
  const hostParam = params.get("host");
  let host: string | undefined;
  if (hostParam) {
    host = hostParam;
  } else {
    try {
      host = decodeURIComponent(dummyHost ? "" : parsed.hostname);
    } catch {
      host = undefined;
    }
  }
  // A socket directory (`?host=/run/postgresql`, or `%2Frun%2Fpostgresql` as the host) is local.
  if (host?.startsWith("/")) host = "";
  return { host, sslmode: params.get("sslmode") };
}

/** A nodemailer URL option value after its coercion; `undefined` when absent. */
type NmValue = string | number | boolean | string[] | undefined;

export interface SmtpTransport {
  /** The relay host nodemailer connects to (`""` when none); `undefined` if unparseable. */
  readonly host: string | undefined;
  /** Implicit TLS (`smtps://`). */
  readonly secure: boolean;
  /** nodemailer's view of the options it takes from the query. */
  readonly option: (name: string) => NmValue;
  /** Query parameter names that occur more than once (nodemailer turns them into arrays). */
  readonly repeated: readonly string[];
  /** The URL contains characters the WHATWG and legacy URL parsers disagree on. */
  readonly ambiguous: boolean;
}

function coerce(values: readonly string[]): NmValue {
  if (values.length > 1) return [...values];
  const v = values[0];
  if (v === undefined) return undefined;
  if (!Number.isNaN(Number(v))) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

/** nodemailer's reading of an `smtp://` / `smtps://` URL (host, TLS options). */
export function smtpTransportOf(url: string): SmtpTransport {
  // Backslashes, whitespace and control characters are read differently by `url.parse` (which
  // nodemailer uses) and WHATWG `URL` (which this check uses); a URL with them is refused.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  const ambiguous = /[\\\s\u0000-\u001f\u007f]/u.test(url);
  const secure = url.toLowerCase().startsWith("smtps:");
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const query = new Map<string, string[]>();
  for (const [k, v] of parsed?.searchParams.entries() ?? []) {
    query.set(k, [...(query.get(k) ?? []), v]);
  }
  const option = (name: string) => coerce(query.get(name) ?? []);
  let host: string | undefined;
  if (parsed === undefined) host = undefined;
  else if (parsed.hostname !== "") host = parsed.hostname;
  else {
    const h = option("host");
    host = h === undefined ? "" : typeof h === "string" ? h : undefined; // a list/number: unknown
  }
  const repeated = [...query].filter(([, v]) => v.length > 1).map(([k]) => k);
  return { host, secure, option, repeated, ambiguous };
}
