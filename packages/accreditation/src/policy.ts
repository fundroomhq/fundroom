import {
  ACCREDITATION_CALLBACK_PATH_PREFIX,
  type AccreditationCredentialField,
  AccreditationProviderError,
} from "@fundroom/ports";
import { AccreditationError } from "./errors.js";

/*
 * The accreditation service's pure rules (E3.7, ADR-0055): what a credential form may contain,
 * what the connection screen may show of a stored credential, how a vendor failure is worded for
 * `last_error`, and how a callback's refs are bounded. No I/O; unit-tested in `policy.test.ts`.
 */

// --- credentials ------------------------------------------------------------------------------

const MASK = "••••";
/** Longest value one credential field may hold (the contract caps the body at 20 000). */
export const MAX_CREDENTIAL_LENGTH = 16 * 1024;

/**
 * What the connection screen may show of a saved credential. Secrets: the mask plus the last four
 * characters, and only when the value is long enough (≥ 16) that four characters say nothing
 * useful about the rest; a shorter secret shows the mask alone. Text and select fields are not
 * secret (a client id, an environment) and show their value, capped.
 */
export function credentialHint(
  field: Pick<AccreditationCredentialField, "kind">,
  value: string,
): string {
  const v = value.trim();
  if (field.kind === "secret") return v.length >= 16 ? `${MASK}${v.slice(-4)}` : MASK;
  return v.length > 64 ? `${v.slice(0, 61)}…` : v;
}

export function credentialHints(
  fields: readonly AccreditationCredentialField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v !== undefined && v !== "") out[f.key] = credentialHint(f, v);
  }
  return out;
}

/**
 * Validates the credential form against the adapter's fields: unknown keys refused (400), required
 * ones present, selects within their options, lengths bounded (422
 * `accreditation_credentials_invalid` naming the field). `previous` — the stored values of the SAME
 * live driver — fills a secret field left blank or omitted (the form never shows a secret, so it
 * cannot be pre-filled) and a plain field OMITTED from the body (an admin changing one field
 * need not re-send the rest); a plain field sent as `""` is removed. `clear` names OPTIONAL fields
 * whose stored value is dropped (the only way to remove a secret a blank field would keep).
 */
export function checkCredentials(
  fields: readonly AccreditationCredentialField[],
  input: Readonly<Record<string, string>>,
  previous?: Readonly<Record<string, string>>,
  clear: readonly string[] = [],
): Record<string, string> {
  const known = new Map(fields.map((f) => [f.key, f]));
  const unknown = [...Object.keys(input), ...clear].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new AccreditationError("validation_failed", "unknown credential field", {
      reason: "unknown_field",
      fields: [...new Set(unknown)],
    });
  }
  const cleared = new Set(clear);
  for (const key of cleared) {
    const f = known.get(key);
    if (f?.required === true) {
      throw new AccreditationError(
        "validation_failed",
        `${f.label} is required and cannot be cleared`,
        { reason: "cannot_clear_required", field: key },
      );
    }
    const given = input[key];
    if (typeof given === "string" && given.trim() !== "") {
      throw new AccreditationError(
        "validation_failed",
        `${f?.label ?? key} is both set and cleared`,
        {
          reason: "clear_conflict",
          field: key,
        },
      );
    }
  }
  const out: Record<string, string> = {};
  for (const f of fields) {
    const raw = input[f.key];
    let v = typeof raw === "string" ? raw.trim() : "";
    const keep = f.kind === "secret" || !Object.hasOwn(input, f.key);
    if (v === "" && keep && !cleared.has(f.key)) v = previous?.[f.key] ?? "";
    if (v === "") {
      if (f.required) {
        throw new AccreditationError(
          "accreditation_credentials_invalid",
          `${f.label} is required`,
          {
            reason: "missing_field",
            fields: [f.key],
          },
        );
      }
      continue;
    }
    if (v.length > MAX_CREDENTIAL_LENGTH) {
      throw new AccreditationError("accreditation_credentials_invalid", `${f.label} is too long`, {
        reason: "field_too_long",
        fields: [f.key],
      });
    }
    if (f.kind === "select" && f.options !== undefined && !f.options.includes(v)) {
      throw new AccreditationError(
        "accreditation_credentials_invalid",
        `${f.label} must be one of its options`,
        { reason: "invalid_option", fields: [f.key] },
      );
    }
    out[f.key] = v;
  }
  return out;
}

/** The vendor environment the credentials belong to (`environment` field; 1..50 chars). */
export function environmentOf(credentials: Readonly<Record<string, string>>): string {
  const env = (credentials["environment"] ?? "").trim();
  return env === "" ? "production" : env.slice(0, 50);
}

// --- vendor failures --------------------------------------------------------------------------

/** Anything a vendor call threw, as an `AccreditationProviderError` (guard/network errors are transient). */
export function asProviderError(error: unknown): AccreditationProviderError {
  if (error instanceof AccreditationProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AccreditationProviderError(
    `vendor call failed: ${message}`.slice(0, 300),
    "unavailable",
    true,
  );
}

/**
 * Whether a failed credential check means "these credentials are wrong" (the admin must fix them;
 * 422 on save, `status = error` on verify) rather than "the vendor could not be asked" (502, and
 * nothing about the stored connection changes).
 */
export function isCredentialFailure(error: AccreditationProviderError): boolean {
  return (
    error.code === "unauthorized" || error.code === "invalid_request" || error.code === "not_found"
  );
}

/**
 * A short, secret-free description of a vendor failure for `last_error`. The adapter's message
 * never carries a credential (port rule), but it is still capped and stripped of anything that
 * looks like a URL query.
 */
export function providerDetail(error: AccreditationProviderError): string {
  const msg = error.message.replace(/\?[^\s]*/gu, "?…").replace(/\s+/gu, " ");
  return `${error.code}${error.status === undefined ? "" : ` (${error.status})`}: ${msg}`.slice(
    0,
    500,
  );
}

// --- callbacks --------------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** At most this many refs ride on one `accreditation.provider_updated` event. */
export const MAX_CALLBACK_REFS = 20;
export const MAX_REF_LENGTH = 200;

/**
 * An authentic callback's refs, bounded for the outbox schema: strings of 1..200 characters,
 * de-duplicated, the first 20. The adapter already bounds them; this is the kernel's own backstop,
 * because the outbox payload is strict and a refused publish would fail the callback.
 */
export function boundRefs(refs: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (typeof r !== "string" || r.length === 0 || r.length > MAX_REF_LENGTH || seen.has(r)) {
      continue;
    }
    seen.add(r);
    out.push(r);
    if (out.length >= MAX_CALLBACK_REFS) break;
  }
  return out;
}

/** `https://…/webhooks/accreditation/<id>` on the canonical origin (no BASE_PATH). */
export function accreditationCallbackUrl(baseUrl: URL, connectionId: string): string {
  return new URL(`${ACCREDITATION_CALLBACK_PATH_PREFIX}${connectionId}`, baseUrl.origin).toString();
}
