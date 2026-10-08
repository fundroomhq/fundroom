import type {
  ESignCredentialField,
  ESignEnvelopeStatus,
  ESignProviderError,
  ESignSignerStatus,
} from "@fundroom/ports";
import { ESignError } from "./errors.js";
import type { Assess, ESignEnvelopeRowStatus } from "./types.js";

/*
 * Pure rules of the e-sign service (E3.5, ADR-0053): status lattice, sync backoff, credential
 * hints, base-URL policy, callback URL, cursors. No I/O here, so every rule is unit-tested.
 */

export const TERMINAL_STATUSES: ReadonlySet<ESignEnvelopeRowStatus> = new Set([
  "completed",
  "declined",
  "voided",
  "expired",
]);

/** An envelope the signer may still act on (a vendor envelope exists and is not finished). */
export const OPEN_STATUSES: ReadonlySet<ESignEnvelopeRowStatus> = new Set(["sent", "delivered"]);

export function isTerminal(status: ESignEnvelopeRowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isOpen(status: ESignEnvelopeRowStatus): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * An envelope that may still be live at the vendor: open, or `error` with a vendor ref (a failed
 * pull is not terminal — E3.5 fixes A10/A13). What erasure withdraws and what the connection
 * guards count.
 */
export function isLiveAtVendor(row: {
  readonly status: ESignEnvelopeRowStatus;
  readonly providerRef: string | null;
}): boolean {
  return isOpen(row.status) || (row.status === "error" && row.providerRef !== null);
}

const RANK: Readonly<Record<ESignEnvelopeRowStatus, number>> = {
  draft: 0,
  error: 0,
  sent: 1,
  delivered: 2,
  completed: 3,
  declined: 3,
  voided: 3,
  expired: 3,
};

/**
 * The row status after the vendor answered `vendor`. Monotonic: a terminal row never moves (the
 * DB trigger enforces the same), a vendor terminal answer always wins over an open row, and
 * `sent`/`delivered` only move forward (a vendor answering `sent` after we saw `delivered` is a
 * stale read, not a regression). An `error` row (a failed pull) recovers to whatever the vendor
 * now says.
 */
export function nextEnvelopeStatus(
  current: ESignEnvelopeRowStatus,
  vendor: ESignEnvelopeStatus,
): ESignEnvelopeRowStatus {
  if (isTerminal(current)) return current;
  if (RANK[vendor] >= 3) return vendor;
  if (current === "error" || current === "draft") return vendor;
  return RANK[vendor] > RANK[current] ? vendor : current;
}

const SIGNER_RANK: Readonly<Record<ESignSignerStatus, number>> = {
  pending: 0,
  viewed: 1,
  signed: 2,
  declined: 2,
};

/** Signer status only moves forward; a finished signer (signed/declined) stays finished. */
export function nextSignerStatus(
  current: ESignSignerStatus | null,
  vendor: ESignSignerStatus | undefined,
): ESignSignerStatus | null {
  if (vendor === undefined) return current;
  if (current === null) return vendor;
  if (SIGNER_RANK[current] >= 2) return current;
  return SIGNER_RANK[vendor] > SIGNER_RANK[current] ? vendor : current;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 5 m → 15 m → 1 h → 6 h → 24 h (then 24 h): contract §4 `esign.sync`. */
export const SYNC_BACKOFF_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY];

/** An open envelope older than this (from `sent_at`) is marked `expired` and no longer pulled. */
export const SYNC_MAX_AGE_MS = 60 * DAY;

/** A `draft` older than this was orphaned between the vendor call and tx2 (the sweep resolves it). */
export const STALE_DRAFT_MS = 15 * MINUTE;

/** A completed envelope whose artifacts are not collected yet is retried at this pace. */
export const COLLECT_RETRY_MS = 15 * MINUTE;

/** The delay before the next pull after `attempts` pulls that changed nothing (0-based). */
export function syncDelayMs(attempts: number): number {
  const i = Math.max(0, Math.min(Math.floor(attempts), SYNC_BACKOFF_MS.length - 1));
  return SYNC_BACKOFF_MS[i] ?? DAY;
}

export function nextSyncAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + syncDelayMs(attempts));
}

/**
 * After the sync window closes, how long a FAILING pull keeps being retried before the envelope is
 * expired anyway (R3C): an envelope we could not see is not known to be over at the vendor, so it
 * is not given up on (and left signable there) at the first failed pull.
 */
export const SYNC_GRACE_MS = 3 * DAY;

/** Within the grace, a failed pull is retried at least this often (the normal backoff, capped). */
export const SYNC_GRACE_MAX_DELAY_MS = 6 * HOUR;

/** Whether the grace for failing pulls after the sync window has run out too. */
export function syncGraceOver(sentAt: Date | null, createdAt: Date, now: Date): boolean {
  const from = sentAt ?? createdAt;
  return now.getTime() - from.getTime() >= SYNC_MAX_AGE_MS + SYNC_GRACE_MS;
}

/** Whether an open envelope sent at `sentAt` has outlived the sync window at `now`. */
export function syncWindowOver(sentAt: Date | null, createdAt: Date, now: Date): boolean {
  const from = sentAt ?? createdAt;
  return now.getTime() - from.getTime() >= SYNC_MAX_AGE_MS;
}

// --- credentials ------------------------------------------------------------------------------

const MASK = "••••";

/**
 * What the connection screen may show of a credential after it is saved. Secrets and PEM keys:
 * the mask plus the last four characters, and only when the value is long enough (≥ 16) that four
 * characters say nothing useful about the rest; a shorter secret shows the mask alone. Plain text
 * and select fields are not secret (an account id, an environment) and show their value, capped.
 */
export function credentialHint(field: Pick<ESignCredentialField, "kind">, value: string): string {
  const v = value.trim();
  if (field.kind === "secret" || field.kind === "pem") {
    if (field.kind === "pem") {
      const body = v.replace(/-----[^-]+-----/gu, "").replace(/\s+/gu, "");
      return body.length >= 16 ? `PEM ${MASK}${body.slice(-4)}` : `PEM ${MASK}`;
    }
    return v.length >= 16 ? `${MASK}${v.slice(-4)}` : MASK;
  }
  return v.length > 64 ? `${v.slice(0, 61)}…` : v;
}

export function credentialHints(
  fields: readonly ESignCredentialField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v !== undefined && v !== "") out[f.key] = credentialHint(f, v);
  }
  return out;
}

const MAX_CREDENTIAL_LENGTH = 16 * 1024;

/**
 * Validates the credential form against the adapter's fields: unknown keys refused, required
 * ones present, selects within their options, lengths bounded. `previous` (the stored values of
 * the SAME driver at the SAME base URL) fills a secret/pem field left blank, so an admin can
 * change one field without re-typing every secret. `clear` (E3.5 fix A5) names OPTIONAL fields
 * whose stored value is dropped — the only way to remove a secret a blank field would keep.
 */
export function checkCredentials(
  fields: readonly ESignCredentialField[],
  input: Readonly<Record<string, string>>,
  previous?: Readonly<Record<string, string>>,
  clear: readonly string[] = [],
): Record<string, string> {
  const known = new Map(fields.map((f) => [f.key, f]));
  const unknown = [...Object.keys(input), ...clear].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ESignError("validation_failed", "unknown credential field", {
      reason: "unknown_field",
      fields: [...new Set(unknown)],
    });
  }
  const cleared = new Set(clear);
  for (const key of cleared) {
    const f = known.get(key);
    if (f?.required === true) {
      throw new ESignError("validation_failed", `${f.label} is required and cannot be cleared`, {
        reason: "cannot_clear_required",
        field: key,
      });
    }
    const given = input[key];
    if (typeof given === "string" && given.trim() !== "") {
      throw new ESignError("validation_failed", `${f?.label ?? key} is both set and cleared`, {
        reason: "clear_conflict",
        field: key,
      });
    }
  }
  const out: Record<string, string> = {};
  for (const f of fields) {
    const raw = input[f.key];
    let v = typeof raw === "string" ? raw.trim() : "";
    if (v === "" && (f.kind === "secret" || f.kind === "pem") && !cleared.has(f.key)) {
      v = previous?.[f.key] ?? "";
    }
    if (v === "") {
      if (f.required) {
        throw new ESignError("validation_failed", `${f.label} is required`, {
          reason: "missing_field",
          field: f.key,
        });
      }
      continue;
    }
    if (v.length > MAX_CREDENTIAL_LENGTH) {
      throw new ESignError("validation_failed", `${f.label} is too long`, {
        reason: "field_too_long",
        field: f.key,
      });
    }
    if (f.kind === "select" && f.options !== undefined && !f.options.includes(v)) {
      throw new ESignError("validation_failed", `${f.label} must be one of its options`, {
        reason: "invalid_option",
        field: f.key,
      });
    }
    out[f.key] = v;
  }
  return out;
}

/**
 * E3.5 fix A4: the secret/pem fields a save must re-type because the base URL changed — every one
 * that has a stored value, was left blank, and is not being cleared. Stored secrets are never
 * sent to a host the admin did not type them for.
 */
export function secretsToReenter(
  fields: readonly ESignCredentialField[],
  input: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>> | undefined,
  clear: readonly string[] = [],
): string[] {
  if (previous === undefined) return [];
  const cleared = new Set(clear);
  return fields
    .filter(
      (f) =>
        (f.kind === "secret" || f.kind === "pem") &&
        (previous[f.key] ?? "") !== "" &&
        (input[f.key] ?? "").trim() === "" &&
        !cleared.has(f.key),
    )
    .map((f) => f.key);
}

// --- base URL ---------------------------------------------------------------------------------

/**
 * A self-hosted vendor's base URL: absolute, no credentials, no query or fragment, allowed by the
 * guard, and https — unless the host is one the operator allow-listed (`ESIGN_ALLOW_PRIVATE_HOSTS`,
 * a LAN Documenso), which the guard reports as `exempt`. Returns the normalised URL (trailing
 * slash removed) that is sealed and handed to the adapter. Checked at save time and again before
 * every vendor call (`assertBaseUrl`), since the allow-list can change under a stored URL.
 */
export function checkBaseUrl(raw: string, assess: Assess): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ESignError("validation_failed", "the base URL is not an absolute URL", {
      reason: "invalid_base_url",
      field: "baseUrl",
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new ESignError("validation_failed", "the base URL must not carry credentials", {
      reason: "invalid_base_url",
      field: "baseUrl",
    });
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ESignError("validation_failed", "the base URL must not have a query or fragment", {
      reason: "invalid_base_url",
      field: "baseUrl",
    });
  }
  const verdict = assess(url);
  if (!verdict.ok) {
    throw new ESignError(
      "validation_failed",
      "that base URL points somewhere this install does not connect to",
      { reason: "base_url_not_allowed", field: "baseUrl", rule: verdict.code },
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && verdict.exempt)) {
    throw new ESignError("validation_failed", "the base URL must use https", {
      reason: "https_required",
      field: "baseUrl",
    });
  }
  const s = url.toString();
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Hostname for display (`base_url_host`). */
export function baseUrlHost(normalised: string): string {
  return new URL(normalised).host.slice(0, 300);
}

// --- callbacks ---------------------------------------------------------------------------------

export const ESIGN_CALLBACK_PATH_PREFIX = "/webhooks/esign/";

/** What the admin pastes into the vendor's webhook settings: `<origin>/webhooks/esign/<id>`. */
export function esignCallbackUrl(baseUrl: URL, connectionId: string): string {
  return new URL(`${ESIGN_CALLBACK_PATH_PREFIX}${connectionId}`, baseUrl.origin).toString();
}

// --- misc -------------------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface EnvelopeCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Keyset cursor over (created_at desc, id desc): base64url of `<iso>|<id>`. */
export function encodeEnvelopeCursor(c: EnvelopeCursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, "utf8").toString("base64url");
}

export function decodeEnvelopeCursor(raw: string): EnvelopeCursor | undefined {
  if (raw.length === 0 || raw.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(raw)) return undefined;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [iso, id, extra] = text.split("|");
  if (iso === undefined || id === undefined || extra !== undefined || !isUuid(id)) return undefined;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return undefined;
  return encodeEnvelopeCursor({ createdAt, id }) === raw ? { createdAt, id } : undefined;
}

/**
 * A short, secret-free description of a vendor failure for `error_detail` / `last_error`. The
 * adapter's message never carries a credential (port rule), but it is still capped and stripped
 * of anything that looks like a URL query.
 */
export function providerDetail(error: ESignProviderError): string {
  const msg = error.message.replace(/\?[^\s]*/gu, "?…").replace(/\s+/gu, " ");
  return `${error.code}${error.status === undefined ? "" : ` (${error.status})`}: ${msg}`.slice(
    0,
    500,
  );
}

/** Does the byte string start with the `%PDF-` magic? (Strict: no leading bytes tolerated.) */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/** Pseudonym for an erased signer, keyed on the envelope row id (never on the old value). */
export function pseudonymousSigner(envelopeId: string): { name: string; email: string } {
  return { name: "Erased signer", email: `erased+${envelopeId}@erased.invalid` };
}

export function signerKeyFor(order: number): string {
  return `s${order}`;
}
