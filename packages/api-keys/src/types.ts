import type { ApiKeyRevokedReason } from "@fundroom/db";

/*
 * API key domain types (E3.4, ADR-0052). `ApiKeyRecord` is the row as this package sees it (no
 * token hash); `ApiKeyView` is what the routes return (`ApiKey` in the contract).
 */

export { API_KEY_REVOKED_REASONS, type ApiKeyRevokedReason } from "@fundroom/db";

export const API_KEY_STATUSES = ["live", "expired", "revoked"] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Live (unrevoked, unexpired) keys per workspace; one more → 409 `conflict` `too_many_keys`. */
export const MAX_LIVE_API_KEYS = 50;
export const API_KEY_NAME_MAX = 80;
export const API_KEY_NOTE_MAX = 500;
/** `expiresAt` must be in the future and at most this far ahead. */
export const API_KEY_MAX_LIFETIME_MS = 2 * 366 * 24 * 60 * 60 * 1000;
/** Rotation overlap: 0..168 hours, default 24 (0 revokes the old key at once, reason `rotated`). */
export const API_KEY_ROTATE_GRACE_MAX_HOURS = 168;
export const API_KEY_ROTATE_GRACE_DEFAULT_HOURS = 24;
/** Per-key budget: `deps.rateLimiter` key `api_key:<id>`. */
export const API_KEY_RATE_LIMIT = { limit: 600, windowMs: 60_000 } as const;
/** `last_used_at` is written at most once per this many seconds per key. */
export const API_KEY_LAST_USED_THROTTLE_SECONDS = 60;
/** Hourly sweep: revoke keys whose creator is no longer live. */
export const API_KEY_SWEEP_JOB = "api-keys.sweep";
export const API_KEY_SWEEP_CRON = "41 * * * *";

/** One `core.api_key` row, without the token hash. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly createdByMembershipId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: ApiKeyRevokedReason | null;
  readonly replacedById: string | null;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly note: string | null;
}

/** A record plus its creator's display name (list and detail). */
export interface ApiKeyWithCreator {
  readonly key: ApiKeyRecord;
  /** Null when the creator has no name on record. */
  readonly creatorDisplayName: string | null;
}

/** The contract's `ApiKey` (dates as ISO strings). */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly status: ApiKeyStatus;
  readonly createdAt: string;
  readonly createdBy: { readonly membershipId: string; readonly displayName: string | null };
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: ApiKeyRevokedReason | null;
  readonly replacedById: string | null;
  readonly lastUsedAt: string | null;
  readonly note: string | null;
}

/** Revoked wins over expired; a key is live until the instant it expires. */
export function apiKeyStatus(
  key: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">,
  now: Date,
): ApiKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return "expired";
  return "live";
}

export function toApiKeyView(
  key: ApiKeyRecord,
  creatorDisplayName: string | null,
  now: Date,
): ApiKeyView {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    status: apiKeyStatus(key, now),
    createdAt: key.createdAt.toISOString(),
    createdBy: { membershipId: key.createdByMembershipId, displayName: creatorDisplayName },
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    revokedReason: key.revokedReason,
    replacedById: key.replacedById,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    note: key.note,
  };
}
