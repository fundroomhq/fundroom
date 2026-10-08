/**
 * Reading numbers out of a spreadsheet a founder already keeps (E2.4 §8, design/06 §7
 * "Google Sheets sync"). The default adapter `@fundroom/sheets-google` talks to the Sheets
 * v4 REST API as a **service account**: the admin pastes a service-account JSON, we store the
 * private key envelope-encrypted and show them the account's email so they can share the sheet
 * with it. There is no OAuth dance, no redirect URI and no refresh token, because a self-hoster
 * has nowhere to register an OAuth client.
 *
 * The port is deliberately one read-only method. A KPI sync pulls a rectangle of cells once a
 * night; it does not write, it does not enumerate a Drive, and it never needs a token that could
 * do either. The adapter asks for `spreadsheets.readonly` and nothing else.
 */

/**
 * One cell, as the API rendered it (`FORMATTED_VALUE`). A number is a *string* here for the
 * same reason `numeric` is a string out of `pg` (E2.4 §5): the value is parsed into fixed-point
 * BigInt by the caller, and a `Number()` on the way past would round it first.
 */
export interface SpreadsheetCell {
  readonly value: string;
}

/** A rectangle of cells, row-major, oldest-first in whatever order the sheet holds them. */
export interface SpreadsheetRange {
  /** Short rows are not padded: the remote API omits trailing empty cells. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * The two fields of a Google service-account JSON we accept. Everything else in that file
 * (`project_id`, `private_key_id`, `token_uri`, …) is ignored on purpose: it is operator-pasted
 * free-form input, and a `token_uri` we honoured would be an SSRF vector with a signed assertion
 * attached to it.
 */
export interface SpreadsheetCredential {
  readonly clientEmail: string;
  /** PKCS#8 PEM. Never logged, never put in an error message, never returned in a `detail`. */
  readonly privateKeyPem: string;
}

/**
 * Why a read produced no range. Every one of these is recorded against the connection row and
 * shown to an admin, so the set is chosen for what it tells *them* to do next.
 *
 * `unauthorized` is the common case and the actionable one: the service account cannot see the
 * sheet, because nobody has shared it with that address yet. An adapter's `detail` must say so.
 */
export type SpreadsheetFailure =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "too_large"
  | "transport"
  | "malformed";

/**
 * What `read` answers. Named so a caller can hold one without restating the union; the method
 * below still spells it out, because the shape is what E2.4 §8 froze.
 */
export type SpreadsheetReadResult =
  | { ok: true; range: SpreadsheetRange }
  | { ok: false; reason: SpreadsheetFailure; detail?: string };

export interface SpreadsheetPort {
  readonly driver: string;
  /** Never throws for a remote-side problem: a refusal is a typed failure the sweep can record. */
  read(
    credential: SpreadsheetCredential,
    spreadsheetId: string,
    range: string,
  ): Promise<
    | { ok: true; range: SpreadsheetRange }
    | { ok: false; reason: SpreadsheetFailure; detail?: string }
  >;
  healthCheck(): Promise<void>;
}
