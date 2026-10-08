import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  IntegrationCredentialField,
  IntegrationFailure,
  IntegrationProvider,
} from "@fundroom/ports";
import { IntegrationError } from "./errors.js";
import { type BookingLinkAudience, DEFAULT_RETURN_PATH } from "./types.js";

/*
 * Pure rules of the integrations kernel (no I/O), unit-tested in `policy.test.ts`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

/** 32 random bytes, base64url (43 characters): tickets, OAuth state, nonces, webhook secrets. */
export function mintSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** RFC 7636 S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time equality of two sha256 digests (false for anything not 32 bytes each). */
export function sameDigest(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (a === null || a === undefined || a.byteLength !== 32 || b.byteLength !== 32) return false;
  return timingSafeEqual(a, b);
}

/** Base64url of 16–200 characters: the shape of every token we mint (never trusted beyond). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/u;

export function looksLikeToken(value: string | undefined): value is string {
  return value !== undefined && TOKEN_RE.test(value);
}

const RETURN_PATH_RE = /^\/admin\/[A-Za-z0-9/_-]*$/u;

/** Where an OAuth result may land: an `/admin/…` path of ours, else the integrations page. */
export function checkReturnPath(path: string | undefined): string {
  if (path === undefined || path.length > 300 || !RETURN_PATH_RE.test(path) || path.includes("//"))
    return DEFAULT_RETURN_PATH;
  return path;
}

/** `?integration=<p>&result=<r>[&reason=<code>]` appended to a return path. */
export function resultQuery(
  provider: IntegrationProvider | null,
  result: "connected" | "pending" | "error",
  reason?: string,
): string {
  const q = new URLSearchParams();
  if (provider !== null) q.set("integration", provider);
  q.set("result", result);
  if (reason !== undefined) q.set("reason", reason);
  return q.toString();
}

// --- booking links -----------------------------------------------------------------------------

export const BOOKING_LINK_MAX = 10;

/**
 * A booking link URL: `https:` on exactly one of the provider's hosts, no userinfo, no port, no
 * fragment tricks. Returns the normalised href. Throws 422 `booking_link_invalid_url` with a
 * `reason` otherwise.
 */
export function checkBookingLinkUrl(raw: string, hosts: readonly string[]): string {
  const refuse = (reason: string): never => {
    throw new IntegrationError(
      "booking_link_invalid_url",
      `the booking link must be an https URL on ${hosts.join(" or ") || "the provider's site"}`,
      { reason, allowedHosts: [...hosts] },
    );
  };
  const text = raw.trim();
  if (text.length < 9 || text.length > 500) refuse("length");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse("not_a_url");
  }
  if (url.protocol !== "https:") refuse("not_https");
  if (url.username !== "" || url.password !== "") refuse("userinfo");
  if (url.port !== "") refuse("port");
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => h.toLowerCase() === host)) refuse("host_not_allowed");
  const href = url.href;
  if (href.length > 500) refuse("length");
  return href;
}

/** Does a link's audience admit a member in `groupIds`? Staff are handled by the caller. */
export function audienceAdmits(
  audience: BookingLinkAudience,
  groupIds: ReadonlySet<string>,
): boolean {
  if (audience.kind === "all") return true;
  if (audience.kind === "groups") return audience.groupIds.some((g) => groupIds.has(g));
  return false;
}

/** Lenient read of a stored audience: anything unreadable admits nobody (never everybody). */
export function parseAudience(raw: unknown): BookingLinkAudience {
  if (raw !== null && typeof raw === "object") {
    const r = raw as { kind?: unknown; groupIds?: unknown };
    if (r.kind === "all") return { kind: "all" };
    if (r.kind === "groups" && Array.isArray(r.groupIds)) {
      const ids = r.groupIds.filter((g): g is string => typeof g === "string" && isUuid(g));
      return { kind: "groups", groupIds: ids };
    }
  }
  return { kind: "groups", groupIds: [] };
}

// --- recorded bookings -------------------------------------------------------------------------

export type BookingStatus = "booked" | "cancelled" | "rescheduled";

const STATUS_RANK: Record<BookingStatus, number> = { booked: 0, rescheduled: 1, cancelled: 2 };

/**
 * Whether a verified event updates an existing booking row. Vendors deliver at least once and not
 * in order, and a booking event carries no sequence number: a status only moves forward
 * (booked → rescheduled → cancelled), so a late `booked` never resurrects a cancelled meeting.
 * The same status again applies (a reschedule moves the times) but only if something changed.
 */
export function bookingUpdate(
  current: {
    readonly status: BookingStatus;
    readonly startsAt: Date;
    readonly endsAt: Date | null;
    readonly inviteeName: string | null;
    readonly eventName: string | null;
  },
  next: {
    readonly status: BookingStatus;
    readonly startsAt: Date;
    readonly endsAt: Date | null;
    readonly inviteeName: string | null;
    readonly eventName: string | null;
  },
): boolean {
  const a = STATUS_RANK[current.status];
  const b = STATUS_RANK[next.status];
  if (b < a) return false;
  if (b > a) return true;
  return (
    current.startsAt.getTime() !== next.startsAt.getTime() ||
    (current.endsAt?.getTime() ?? null) !== (next.endsAt?.getTime() ?? null) ||
    current.inviteeName !== next.inviteeName ||
    current.eventName !== next.eventName
  );
}

/** Truncates to `max` characters (code points), `null` for blank. */
export function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  if (t === "") return null;
  return [...t].slice(0, max).join("");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeInviteeEmail(email: string): string | undefined {
  const e = email.trim().toLowerCase();
  if (e.length === 0 || e.length > 320 || !EMAIL_RE.test(e)) return undefined;
  return e;
}

export function encodeBookingCursor(row: { startsAt: Date; id: string }): string {
  return Buffer.from(`${row.startsAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeBookingCursor(cursor: string): { startsAt: Date; id: string } | undefined {
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const [at, id] = text.split("|");
  if (at === undefined || id === undefined || !isUuid(id)) return undefined;
  const startsAt = new Date(at);
  if (Number.isNaN(startsAt.getTime())) return undefined;
  return { startsAt, id };
}

// --- credentials ---------------------------------------------------------------------------------

/**
 * The pasted credentials of a secret provider, checked against its `credentialFields`: unknown
 * keys refused, required keys present, values trimmed. `accessToken` is the first `secret` field
 * (Stripe `restrictedKey`, Calendly `personalAccessToken`) or "" when the provider needs none
 * (Cal.com).
 */
export function checkSecretCredentials(
  fields: readonly IntegrationCredentialField[],
  input: Readonly<Record<string, string>>,
): { credentials: Record<string, string>; accessToken: string } {
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new IntegrationError("validation_failed", `unknown credential field ${key}`, {
        reason: "unknown_field",
        field: key,
      });
    }
  }
  const credentials: Record<string, string> = {};
  for (const f of fields) {
    const v = (input[f.key] ?? "").trim();
    if (v === "") {
      if (f.required) {
        throw new IntegrationError("validation_failed", `${f.label} is required`, {
          reason: "field_required",
          field: f.key,
        });
      }
      continue;
    }
    if (v.length > 4000) {
      throw new IntegrationError("validation_failed", `${f.label} is too long`, {
        reason: "field_too_long",
        field: f.key,
      });
    }
    credentials[f.key] = v;
  }
  const secretField = fields.find((f) => f.kind === "secret" && credentials[f.key] !== undefined);
  return {
    credentials,
    accessToken: secretField === undefined ? "" : (credentials[secretField.key] ?? ""),
  };
}

/**
 * Stripe: only a restricted key (`rk_live_…` / `rk_test_…`) — least privilege. A full secret key
 * (`sk_…`) is refused with 422 `integration_secret_key_refused`; the environment follows the prefix.
 */
export function stripeKeyEnvironment(key: string): "production" | "sandbox" {
  if (/^sk_/u.test(key)) {
    throw new IntegrationError(
      "integration_secret_key_refused",
      "paste a restricted key (rk_…) with read-only permissions, never the secret key",
      { reason: "secret_key" },
    );
  }
  if (key.startsWith("rk_live_")) return "production";
  if (key.startsWith("rk_test_")) return "sandbox";
  throw new IntegrationError(
    "integration_credentials_rejected",
    "a Stripe restricted key starts with rk_live_ or rk_test_",
    { reason: "malformed" },
  );
}

// --- health --------------------------------------------------------------------------------------

export const DEGRADED_AFTER_FAILURES = 3;

/** A short, vendor-neutral `last_error` (never a vendor's text or a credential). */
export function failureText(
  reason: IntegrationFailure | "refresh_failed" | "webhook_subscription_lost",
): string {
  switch (reason) {
    case "webhook_subscription_lost":
      return "webhook_subscription_lost: the provider refused a new webhook subscription after the old one was removed; bookings are not being recorded — rotate the webhook secret again or reconnect";
    case "unauthorized":
      return "unauthorized: the provider refused the connection's credentials; reconnect";
    case "forbidden":
      return "forbidden: the connection lacks a permission this feature needs";
    case "not_found":
      return "not_found: the provider could not find what was asked for";
    case "rate_limited":
      return "rate_limited: the provider asked us to slow down";
    case "too_large":
      return "too_large: the provider's answer was too large";
    case "transport":
      return "transport: the provider could not be reached";
    case "malformed":
      return "malformed: the provider's answer could not be read";
    case "unavailable":
      return "unavailable: the provider is not available";
    case "refresh_failed":
      return "refresh_failed: the access token could not be renewed";
  }
}

export type HealthOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "reauth" }
  | { readonly kind: "failure"; readonly reason: IntegrationFailure | "refresh_failed" }
  /** Degraded at once, whatever the count (a lost booking webhook subscription). */
  | { readonly kind: "degrade"; readonly reason: "webhook_subscription_lost" }
  | { readonly kind: "neutral" };

/** Which outcome a vendor answer means for the connection's health. */
export function healthOf(
  result:
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: IntegrationFailure; readonly detail?: string },
): HealthOutcome {
  if (result.ok) return { kind: "success" };
  // Our own cancellation (a job's expiry, fix round 3) says nothing about the vendor.
  if (result.detail === "aborted") return { kind: "neutral" };
  if (result.reason === "unauthorized") return { kind: "reauth" };
  // A missing channel / record is about the request, not the connection.
  if (result.reason === "not_found") return { kind: "neutral" };
  return { kind: "failure", reason: result.reason };
}

export type ConnectionStatus = "active" | "degraded" | "reauth_required";

/** The connection's next health columns, and whether its status changed. */
export function nextHealth(
  current: { readonly status: ConnectionStatus; readonly consecutiveFailures: number },
  outcome: HealthOutcome,
): {
  status: ConnectionStatus;
  consecutiveFailures: number;
  lastError: string | null | undefined;
  success: boolean;
  failure: boolean;
} {
  switch (outcome.kind) {
    case "success":
      return {
        status: "active",
        consecutiveFailures: 0,
        lastError: null,
        success: true,
        failure: false,
      };
    case "reauth":
      return {
        status: "reauth_required",
        consecutiveFailures: current.consecutiveFailures + 1,
        lastError: failureText("unauthorized"),
        success: false,
        failure: true,
      };
    case "failure": {
      const n = current.consecutiveFailures + 1;
      return {
        // A token the vendor refused stays refused until a reconnect; a transient failure does
        // not lift it.
        status:
          current.status === "reauth_required"
            ? "reauth_required"
            : n >= DEGRADED_AFTER_FAILURES
              ? "degraded"
              : current.status,
        consecutiveFailures: n,
        lastError: failureText(outcome.reason),
        success: false,
        failure: true,
      };
    }
    case "degrade":
      return {
        status: current.status === "reauth_required" ? "reauth_required" : "degraded",
        consecutiveFailures: current.consecutiveFailures + 1,
        lastError: failureText(outcome.reason),
        success: false,
        failure: true,
      };
    case "neutral":
      return {
        status: current.status,
        consecutiveFailures: current.consecutiveFailures,
        lastError: undefined,
        success: false,
        failure: false,
      };
  }
}

/** Xero organisations from `OAuthTokenSet.extra.accounts` (JSON `[{id,name}]`), at most 50. */
export function parseAccounts(raw: string | undefined): { id: string; name: string }[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: { id: string; name: string }[] = [];
    for (const a of parsed) {
      if (a === null || typeof a !== "object") continue;
      const { id, name } = a as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || id === "" || id.length > 300) continue;
      out.push({ id, name: typeof name === "string" ? name.slice(0, 200) : id });
      if (out.length >= 50) break;
    }
    return out;
  } catch {
    return [];
  }
}
