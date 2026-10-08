import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import {
  type OutboundFetch,
  OutboundHttpError,
  type SpreadsheetCredential,
  type SpreadsheetFailure,
  type SpreadsheetPort,
  type SpreadsheetReadResult,
} from "@fundroom/ports";

/*
 * Google Sheets v4, read-only, as a **service account** (E2.4 §8).
 *
 * Why there is no OAuth here at all: the authorization-code flow needs a registered client with
 * a redirect URI, and a self-hoster has nobody to register one with. A service account needs no
 * registration and no consent screen — the admin pastes the JSON Google already generated for
 * them, we show them `client_email`, and they share the sheet with that address exactly as they
 * would with a colleague. Sharing *is* the grant, which also means revoking is un-sharing, in a
 * UI the founder already knows.
 *
 * Why there is no `googleapis` SDK: this is two HTTP calls. The SDK brings a transitive
 * dependency tree, an auth library with its own metadata-server probes (a deliberate SSRF-shaped
 * behaviour we spend a whole package refusing), and a global `fetch`. Both calls here go through
 * the injected SSRF-guarded `OutboundFetch`, which is the only way anything in this repo reaches
 * the internet.
 *
 * Nothing in this file logs the private key, the assertion, the access token, a URL carrying a
 * token, or a single cell of the sheet. Failures carry ids, counts and HTTP statuses.
 */

/** The narrowest scope that can read a range. Not `drive`, not `spreadsheets` (which can write). */
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_SHEETS_API_BASE = "https://sheets.googleapis.com";

/** Matches the token budget the composition root gives this adapter (E2.4 §8). */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The assertion's own lifetime. Google caps it at one hour and rejects anything longer. */
const ASSERTION_TTL_SECONDS = 3600;
/** Spend a cached token only while a whole request still fits inside its remaining life. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** One workspace has one connection (§3.6), so this is already small; bound it anyway. */
const TOKEN_CACHE_MAX = 64;
/**
 * What to assume when the token endpoint's `expires_in` is missing or unusable.
 *
 * Five minutes, and specifically **not zero**. A zero-lifetime entry can never be spent — it is
 * already inside the skew the moment it is written — so the cache silently stops being a cache:
 * every read re-signs an assertion and posts it, doubling the request count and spending the
 * token endpoint's own quota, while dead entries pile up against `TOKEN_CACHE_MAX`. Neither
 * symptom is visible from a green test suite. Five minutes is long enough that a sweep over
 * many workspaces authenticates once, short enough that we re-authenticate well inside any
 * lifetime Google plausibly meant.
 */
const FALLBACK_TOKEN_LIFETIME_SECONDS = 300;

export interface GoogleSheetsOptions {
  /** Must be the SSRF-guarded fetch, built for this adapter's budget. Never global `fetch`. */
  readonly fetch: OutboundFetch;
  /** Test seam only. Defaults to Google's; it is also what the assertion's `aud` claims. */
  readonly tokenEndpoint?: string | undefined;
  /** Test seam only. Defaults to `https://sheets.googleapis.com`. */
  readonly apiBaseUrl?: string | undefined;
  /** Adapter-side body cap, belt to the guard's braces. Default 2 MiB. */
  readonly maxResponseBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/*
 * A spreadsheet id and a range arrive from an admin and are interpolated into a URL. Neither is
 * checked by anything downstream, so they are checked here: Google's own id alphabet, and A1
 * notation as the API documents it. A refusal is better than a request built out of whatever the
 * admin pasted — including something with a `/` or a `..` in it, which would address a different
 * API method entirely.
 */
const SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{20,100}$/u;
const A1_REF = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}|\$?[A-Za-z]{1,3}|\$?\d{1,7}`;
const A1_BODY_RE = new RegExp(`^(?:${A1_REF})(?::(?:${A1_REF}))?$`, "u");
const SHEET_NAME_RE = /^[A-Za-z0-9_. -]{1,100}$/u;
/**
 * A "name" made only of dots, dashes and whitespace is not a sheet name, and `..` is a path
 * segment. The alphabet above admits `.`, because `Q1.2026` is a sheet somebody really has —
 * but it also admitted `..`, and `new URL` then normalises `/values/..` clean away, so the
 * bearer token went to `spreadsheets.get` instead of `values.get`. That is precisely the
 * "addresses a different API method entirely" the comment above claims is refused; it was not.
 * `"  "`, `"-"` and `". . . ."` went the same way, each of them a request built out of nothing.
 * Excluded here rather than by tightening the alphabet, so a quoted `'売上'` stays legal: a
 * non-ASCII sheet name is ordinary, a name with no substance to it is not.
 */
const BLANK_NAME_RE = /^[.\s-]*$/u;
const QUOTED_RANGE_RE = /^'((?:[^'\n]|'')*)'(!(.*))?$/u;
const RANGE_MAX_LENGTH = 200;
const EMAIL_RE =
  /^[^\s@,;<>"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

type Failure = { ok: false; reason: SpreadsheetFailure; detail?: string };

/** `exactOptionalPropertyTypes` forbids `detail: undefined`, so build the object both ways. */
function fail(reason: SpreadsheetFailure, detail?: string): Failure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** A bare sheet name: the ASCII alphabet above, and at least one character of substance. */
function isSheetName(name: string): boolean {
  return SHEET_NAME_RE.test(name) && !BLANK_NAME_RE.test(name);
}

/** A `'quoted'` sheet name: any alphabet Sheets allows, but still not made of nothing. */
function isQuotedSheetName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && !BLANK_NAME_RE.test(name);
}

/** A1 notation: an optional sheet name (bare or `'quoted'`), an optional `!`, an optional range. */
export function isValidRange(range: string): boolean {
  if (range.length === 0 || range.length > RANGE_MAX_LENGTH) return false;
  if (range.startsWith("'")) {
    const match = QUOTED_RANGE_RE.exec(range);
    if (match === null) return false;
    if (!isQuotedSheetName(match[1] ?? "")) return false;
    // `'Sheet'` alone is the whole sheet; `'Sheet'!` with nothing after it is not a range.
    if (match[2] === undefined) return true;
    return A1_BODY_RE.test(match[3] ?? "");
  }
  const bang = range.indexOf("!");
  if (bang < 0) return A1_BODY_RE.test(range) || isSheetName(range);
  return isSheetName(range.slice(0, bang)) && A1_BODY_RE.test(range.slice(bang + 1));
}

export function isValidSpreadsheetId(id: string): boolean {
  return SPREADSHEET_ID_RE.test(id);
}

/**
 * The service-account JSON, parsed defensively (E2.4 §8 security note).
 *
 * The file is operator-pasted free-form input, so only two keys are read and both are validated:
 * `client_email` must look like an address (it is shown to the admin and stored in
 * `metrics.sheet_connection.service_account_email`), and `private_key` must be a PEM that
 * `crypto.createPrivateKey` accepts.
 *
 * **`token_uri` is ignored deliberately, and must stay ignored.** Google's own file carries it
 * and the JWT-bearer spec says the assertion is posted to the endpoint the credential names, so
 * "we should honour `token_uri`, it is in the spec" is a change somebody will propose. The attack
 * it enables: the JSON is pasted by a workspace admin, and this adapter signs an RS256 assertion
 * over whatever `aud` that field supplies and POSTs it there. An admin who pastes a file naming
 * their own host therefore makes the server mint a signed credential and deliver it to them —
 * and aims an authenticated outbound request at a host of their choosing. The token endpoint is
 * a constant in this file for that reason, and the guard is the second lock, not the first.
 *
 * Never throws, and its failure detail never quotes the input back.
 */
export function parseServiceAccountJson(
  raw: string,
): { ok: true; credential: SpreadsheetCredential } | Failure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail("malformed", "the service-account credential is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("malformed", "the service-account credential is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record["client_email"];
  const privateKeyPem = record["private_key"];
  if (typeof clientEmail !== "string" || !EMAIL_RE.test(clientEmail)) {
    return fail("malformed", "the service-account credential has no valid `client_email`");
  }
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    return fail("malformed", "the service-account credential has no `private_key`");
  }
  if (loadKey(privateKeyPem) === undefined) {
    return fail("malformed", "the service-account `private_key` is not a PEM key we can read");
  }
  return { ok: true, credential: { clientEmail, privateKeyPem } };
}

/** `undefined` rather than a throw: a malformed key is a typed failure, never an exception. */
function loadKey(pem: string): KeyObject | undefined {
  try {
    return createPrivateKey(pem);
  } catch {
    return undefined;
  }
}

function base64url(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

/** RS256 over `base64url(header).base64url(claims)`, per RFC 7515 §5 and RFC 7523 §2.1. */
function signAssertion(
  key: KeyObject,
  clientEmail: string,
  audience: string,
  issuedAt: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: SHEETS_READONLY_SCOPE,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_TTL_SECONDS,
    }),
  );
  const input = `${header}.${claims}`;
  return `${input}.${base64url(createSign("RSA-SHA256").update(input).sign(key))}`;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * The cache key for one credential's access token, and the reason it is a digest.
 *
 * It was `client_email + scope`. The cache is per adapter instance and the composition root
 * builds **one instance per process**, shared by every tenant — so the key has to identify the
 * credential, and `client_email` does not. Two halves broke on that:
 *
 *  - **cross-tenant.** `parseServiceAccountJson` checks only that the PEM is readable, never
 *    that the key belongs to the address beside it (nothing can check that locally; only
 *    Google can). Workspace B's admin pastes a JSON carrying workspace A's `client_email` with
 *    a key they generated themselves. B's assertion would be refused — but B never signs one,
 *    because A's token is already in the cache under that address, and B reads A's sheet on it;
 *  - **rotation.** Re-pasting a fresh key after revoking a compromised one changes nothing the
 *    old key was spending: the cached token stays spendable for up to 59 more minutes.
 *
 * Both close on the private key being part of the identity. The digest is over length-prefixed
 * fields so no concatenation of one can be mistaken for another, and it is a hash rather than
 * the key itself so a heap dump or an accidental `console.log` of the map's keys carries no
 * PEM. The workspace id is deliberately **not** here: `SpreadsheetPort.read` takes a credential
 * and not a tenant, which is the right shape for a port that knows nothing about tenancy, and
 * the key material already separates every workspace that has its own service account.
 */
function tokenCacheKey(credential: SpreadsheetCredential, scope: string): string {
  const digest = createHash("sha256");
  for (const field of [credential.clientEmail, credential.privateKeyPem, scope]) {
    digest.update(`${field.length}:`);
    digest.update(field, "utf8");
  }
  return digest.digest("base64url");
}

/**
 * `expires_in` as a usable lifetime in seconds.
 *
 * RFC 6749 §5.1 calls it a number and does not forbid a JSON string, and `expires_in: "3600"`
 * is a legal body a proxy or a future endpoint can hand back. Read literally it was neither a
 * number nor positive, so the lifetime fell to `0` and the cache quietly stopped caching.
 */
function tokenLifetimeSeconds(raw: unknown): number {
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d{1,10}$/u.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_TOKEN_LIFETIME_SECONDS;
  // Google mints one-hour tokens; a longer claim buys nothing and would pin a stale token in
  // process memory for as long as the process lives.
  return Math.min(Math.floor(seconds), ASSERTION_TTL_SECONDS);
}

/** Only the response status ever reaches a log line; the bodies here carry the credential. */
function tokenFailure(status: number): Failure {
  if (status === 400 || status === 401 || status === 403) {
    return fail(
      "unauthorized",
      `google refused the service-account assertion at the token endpoint (HTTP ${status}); the key may be revoked, disabled, or belong to a project with the Sheets API turned off`,
    );
  }
  if (status === 429 || status === 503) {
    return fail("rate_limited", `the token endpoint is rate limiting us (HTTP ${status})`);
  }
  return fail("transport", `the token endpoint answered HTTP ${status}`);
}

function valuesFailure(status: number, clientEmail: string, refreshed = false): Failure {
  if (status === 401 || status === 403) {
    const after = refreshed ? ", and again on a freshly minted one" : "";
    return fail(
      "unauthorized",
      `google refused the read at the values endpoint (HTTP ${status})${after}; share the spreadsheet with ${clientEmail} (Viewer is enough) — an access token was obtained, so the credential itself is good`,
    );
  }
  if (status === 404) {
    return fail("not_found", "no spreadsheet with that id (HTTP 404)");
  }
  if (status === 429 || status === 503) {
    return fail("rate_limited", `google is rate limiting this project (HTTP ${status})`);
  }
  if (status === 400) {
    return fail("malformed", "google could not parse the range (HTTP 400)");
  }
  return fail("transport", `the values endpoint answered HTTP ${status}`);
}

/** An `OutboundHttpError` is the guard speaking, and `response_too_large` is the one we name. */
function transportFailure(error: unknown, where: string): Failure {
  const guarded =
    error instanceof OutboundHttpError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "OutboundHttpError");
  if (guarded) {
    const code = (error as OutboundHttpError).code;
    if (code === "response_too_large") {
      return fail("too_large", `the ${where} response exceeded the outbound size cap`);
    }
    return fail("transport", `the ${where} request was refused by the outbound guard (${code})`);
  }
  return fail("transport", `the ${where} request failed`);
}

/**
 * A JSON number as plain decimal text, never exponent notation.
 *
 * `UNFORMATTED_VALUE` hands numeric cells back as JSON numbers, and `String()` writes
 * `1e+21` / `1.5e-7` at the ends of the range. The metrics module's rule is that a value
 * travels as a decimal string and `parseFixed` is the only door — and `parseFixed` refuses
 * exponents on purpose (a `numeric(20,6)` never emits one). So the one place a number becomes
 * text is here, and it expands the exponent rather than handing on a spelling the parser will
 * silently drop. The `parseInt` is over the *exponent*, which is a small integer; no arithmetic
 * anywhere here touches the value itself.
 */
function plainDecimal(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/iu.exec(text);
  if (match === null) return text;
  const digits = `${match[2] ?? ""}${match[3] ?? ""}`;
  const pointAt = (match[2] ?? "").length + Number.parseInt(match[4] ?? "0", 10);
  const sign = match[1] ?? "";
  if (pointAt <= 0) return `${sign}0.${"0".repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${"0".repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/** Cells arrive as scalars; a number or a boolean is coerced rather than refused. */
function cellsOf(row: unknown): readonly string[] | undefined {
  if (!Array.isArray(row)) return undefined;
  const cells: string[] = [];
  for (const cell of row as readonly unknown[]) {
    if (typeof cell === "string") cells.push(cell);
    else if (typeof cell === "number") cells.push(plainDecimal(cell));
    else if (typeof cell === "boolean") cells.push(String(cell));
    else if (cell === null || cell === undefined) cells.push("");
    else return undefined;
  }
  return cells;
}

export function createGoogleSheetsAdapter(options: GoogleSheetsOptions): SpreadsheetPort {
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
  const apiBaseUrl = options.apiBaseUrl ?? GOOGLE_SHEETS_API_BASE;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  /*
   * In-process, per-container access tokens keyed by a digest of the whole credential (E2.4 §8). Google
   * mints a one-hour token and rate-limits the *token* endpoint separately from the data one, so
   * a sweep over many periods that re-signed an assertion per read would spend its quota on
   * authentication. See `tokenCacheKey`, and do not reduce that key to the address again.
   * Not keyed by spreadsheet: the token is the account's, not the sheet's.
   */
  const tokens = new Map<string, CachedToken>();

  async function accessToken(
    credential: SpreadsheetCredential,
    mint: { readonly fresh?: boolean } = {},
  ): Promise<{ ok: true; token: string } | Failure> {
    const cacheKey = tokenCacheKey(credential, SHEETS_READONLY_SCOPE);
    const nowMs = now().getTime();
    // A 401 from the values endpoint retries on a token minted now, never on the stale one.
    if (mint.fresh === true) tokens.delete(cacheKey);
    const cached = tokens.get(cacheKey);
    if (cached !== undefined && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > nowMs) {
      return { ok: true, token: cached.token };
    }

    const key = loadKey(credential.privateKeyPem);
    if (key === undefined) {
      return fail(
        "malformed",
        "the stored service-account private key is not a PEM key we can read",
      );
    }

    let response: Response;
    try {
      response = await options.fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signAssertion(
            key,
            credential.clientEmail,
            tokenEndpoint,
            Math.floor(nowMs / 1000),
          ),
        }).toString(),
      });
    } catch (error) {
      log("sheets.google.token_unreachable", { level: "warn" });
      return transportFailure(error, "token");
    }

    if (!response.ok) {
      // The body of a token error can echo the assertion back; only the status is logged.
      log("sheets.google.token_rejected", { level: "warn", status: response.status });
      response.body?.cancel().catch(() => {});
      return tokenFailure(response.status);
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      return fail("malformed", "the token endpoint did not answer with JSON");
    }
    const body = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      return fail("malformed", "the token endpoint answered without an access token");
    }
    const lifetimeSeconds = tokenLifetimeSeconds(body.expires_in);
    if (tokens.size >= TOKEN_CACHE_MAX) tokens.clear();
    tokens.set(cacheKey, {
      token: body.access_token,
      expiresAtMs: nowMs + lifetimeSeconds * 1000,
    });
    return { ok: true, token: body.access_token };
  }

  return {
    driver: "sheets-google",

    async read(credential, spreadsheetId, range) {
      if (!isValidSpreadsheetId(spreadsheetId)) {
        return fail(
          "malformed",
          "the spreadsheet id is not in Google's id alphabet (20-100 of A-Z a-z 0-9 _ -); paste the id out of the sheet's URL, not the whole URL",
        );
      }
      if (!isValidRange(range)) {
        return fail(
          "malformed",
          "the range is not A1 notation (`Sheet1!A1:D100`, `'My Sheet'!A:D`, or a bare sheet name)",
        );
      }

      const url = new URL(
        `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        apiBaseUrl,
      );
      /*
       * The second lock on the range, and the one that cannot be argued with: whatever the
       * validator let through, the URL `new URL` actually built must still address
       * `values.get` on this spreadsheet. A `..` inside the range normalised the `values`
       * segment away and sent the bearer token to `spreadsheets.get` instead — the validator
       * now refuses that spelling, and this refuses the class.
       */
      const expectedPrefix = `/v4/spreadsheets/${spreadsheetId}/values/`;
      if (
        !url.pathname.startsWith(expectedPrefix) ||
        url.pathname.length === expectedPrefix.length
      ) {
        return fail("malformed", "the range does not address a cell range on that spreadsheet");
      }
      url.searchParams.set("majorDimension", "ROWS");
      /*
       * `UNFORMATTED_VALUE`, emphatically not `FORMATTED_VALUE`, which is the cell **as
       * displayed**. A founder who formats their MRR column as currency — the common case, and
       * the one a finance lead will always do — has Google hand back `"$12,400"`, and
       * `parseFixed` takes plain decimals only, so every cell was dropped and the connection
       * still reported `ok`. Unformatted, the same cell is the JSON number `12400`.
       *
       * `dateTimeRenderOption` has to come with it. Its default is `SERIAL_NUMBER`, which
       * under `UNFORMATTED_VALUE` would turn a period column formatted as a date into `46023`
       * and break the *other* half of the sheet while fixing this one.
       */
      url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
      url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

      /*
       * One retry, and only on a 401.
       *
       * A cached token can be repudiated before it expires — the service-account key is
       * rotated or disabled mid-flight, or Google decides it is done with it — and the cached
       * entry then buys nothing but a guaranteed failure until it ages out, up to an hour of
       * nightly syncs failing on a credential that is perfectly good. So a 401 drops the entry,
       * mints a fresh token and tries the read once more. Strictly once: `attempt` is the loop
       * bound, so a values endpoint that answers 401 to everything costs two requests, not a
       * spin. A 403 is *not* retried — that is "the sheet is not shared with this account",
       * which no new token can fix.
       */
      let response: Response | undefined;
      let failure: Failure | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await accessToken(credential, attempt === 0 ? {} : { fresh: true });
        if (!token.ok) return token;

        let current: Response;
        try {
          current = await options.fetch(url, {
            method: "GET",
            headers: { authorization: `Bearer ${token.token}`, accept: "application/json" },
          });
        } catch (error) {
          log("sheets.google.values_unreachable", { level: "warn" });
          return transportFailure(error, "values");
        }

        if (current.ok) {
          response = current;
          break;
        }
        log("sheets.google.values_rejected", {
          level: "warn",
          status: current.status,
          attempt: attempt + 1,
        });
        current.body?.cancel().catch(() => {});
        failure = valuesFailure(current.status, credential.clientEmail, attempt > 0);
        if (current.status !== 401) break;
      }
      if (response === undefined) {
        return failure ?? fail("transport", "the values endpoint answered no usable response");
      }

      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.body?.cancel().catch(() => {});
        return fail("too_large", `the range is ${declared} bytes, over the ${maxBytes} byte cap`);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return transportFailure(error, "values");
      }
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        return fail("too_large", `the range exceeds the ${maxBytes} byte cap`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return fail("malformed", "the values endpoint did not answer with JSON");
      }
      if (typeof payload !== "object" || payload === null) {
        return fail("malformed", "the values endpoint did not answer with a JSON object");
      }
      /*
       * An **empty range is a successful read of zero rows, not a failure**, and telling that
       * apart from a shapeless body is the whole point of these two checks. Do not collapse them.
       *
       * Google omits `values` entirely when the requested range holds nothing — a 200 carrying
       * `{range, majorDimension}` and no more. That is exactly what a founder's sheet looks like
       * on the day they connect it and before they type a number into it. Reporting `malformed`
       * there would tell them their sheet is broken when it is merely blank, park the connection
       * in a failure state, and climb `consecutive_failures` every night: the first thing a new
       * connection would do is raise an alarm about a fault that does not exist.
       *
       * So a body that is recognisably a Sheets values response (it carries `range`) and has no
       * `values` is an empty rectangle. A body carrying neither key is not a values response at
       * all — a proxy's error page, an API change — and stays `malformed`. The failure is silent
       * by construction if these are merged, which is why the distinction is spelled out here.
       */
      const object = payload as { values?: unknown; range?: unknown };
      const values = object.values;
      if (values === undefined && typeof object.range === "string") {
        log("sheets.google.read", { rows: 0 });
        return { ok: true, range: { rows: [] } } satisfies SpreadsheetReadResult;
      }
      if (!Array.isArray(values)) {
        return fail("malformed", "the values response carried no `values` array");
      }
      const rows: (readonly string[])[] = [];
      for (const row of values as readonly unknown[]) {
        const cells = cellsOf(row);
        if (cells === undefined) {
          return fail("malformed", "the values response carried a cell that is not a scalar");
        }
        rows.push(cells);
      }
      // Counts, never contents.
      log("sheets.google.read", { rows: rows.length });
      return { ok: true, range: { rows } } satisfies SpreadsheetReadResult;
    },

    /**
     * Configuration only. `/readyz` must not turn red because Google is having an afternoon:
     * nothing on a request path talks to Sheets — the sync is a nightly cron — and an
     * unauthenticated probe of the token endpoint is a 400 by design, so it would assert
     * nothing anyway. What this does catch is an operator who overrode an endpoint with
     * something that is not an https URL.
     */
    async healthCheck() {
      for (const [name, endpoint] of [
        ["token endpoint", tokenEndpoint],
        ["api base", apiBaseUrl],
      ] as const) {
        let parsed: URL;
        try {
          parsed = new URL(endpoint);
        } catch {
          throw new Error(`sheets-google: ${name} is not an absolute URL`);
        }
        // Plaintext is tolerated on loopback only — the test seam, and an operator's local
        // proxy. Anywhere else it would put a bearer token on the wire in the clear.
        const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
          throw new Error(`sheets-google: ${name} must be https`);
        }
      }
    },
  };
}
