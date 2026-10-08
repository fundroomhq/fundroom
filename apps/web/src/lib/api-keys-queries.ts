import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * API keys (E3.4, ADR-0052). Kernel routes behind `api-keys.read` / `api-keys.manage`; every
 * write also needs a fresh session, which `useGuardedMutation` turns into a step-up and back.
 *
 * The token is on the wire exactly once — in the create or rotate response — and the server keeps
 * only its sha256. Nothing here caches it: the screen holds it in component state until dismissed,
 * and a step-up round trip (a full page load) loses it by design.
 */
export type ApiKey = FundRoomSchemas["ApiKey"];
export type ApiKeyList = FundRoomSchemas["ApiKeyList"];
export type ApiKeyScope = FundRoomSchemas["ApiKeyScopes"]["scopes"][number];
export type CreatedApiKey = FundRoomSchemas["CreatedApiKey"];
export type RotatedApiKey = FundRoomSchemas["RotatedApiKey"];
export type ApiKeyStatus = ApiKey["status"];

export const API_KEYS_KEY = ["api-keys"] as const;

/** Newest first. The cursor is opaque: it is handed back exactly as received. */
export function apiKeysQuery(limit = 100) {
  return infiniteQueryOptions({
    queryKey: [...API_KEYS_KEY, "list", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/api-keys", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: ApiKeyList) => last.nextCursor ?? undefined,
  });
}

export const apiKeyScopesQuery = queryOptions({
  queryKey: [...API_KEYS_KEY, "scopes"],
  queryFn: () => call(api().GET("/api-keys/scopes")),
});

/** Rotation grace windows offered in the picker, in hours (the server allows 0..168). */
export const API_KEY_GRACE_HOURS = [0, 1, 24, 72, 168] as const;
export const API_KEY_DEFAULT_GRACE_HOURS = 24;

export function graceLabel(hours: number): string {
  switch (hours) {
    case 0:
      return m.apikeys_grace_0();
    case 1:
      return m.apikeys_grace_1();
    case 24:
      return m.apikeys_grace_24();
    case 72:
      return m.apikeys_grace_72();
    case 168:
      return m.apikeys_grace_168();
    default:
      return String(hours);
  }
}

export function apiKeyStatusLabel(status: ApiKeyStatus): string {
  switch (status) {
    case "live":
      return m.apikeys_status_live();
    case "expired":
      return m.apikeys_status_expired();
    case "revoked":
      return m.apikeys_status_revoked();
  }
}

export function apiKeyStatusVariant(status: ApiKeyStatus): "success" | "outline" | "destructive" {
  return status === "live" ? "success" : status === "revoked" ? "destructive" : "outline";
}

export function revokedReasonLabel(reason: NonNullable<ApiKey["revokedReason"]>): string {
  switch (reason) {
    case "revoked":
      return m.apikeys_reason_revoked();
    case "rotated":
      return m.apikeys_reason_rotated();
    case "creator_inactive":
      return m.apikeys_reason_creator_inactive();
    case "erased":
      return m.apikeys_reason_erased();
  }
}

/** Scopes grouped by the module prefix of the permission name (`metrics.read` → `metrics`). */
export function groupScopes(
  scopes: readonly ApiKeyScope[],
): readonly { group: string; scopes: readonly ApiKeyScope[] }[] {
  const groups = new Map<string, ApiKeyScope[]>();
  for (const scope of scopes) {
    const group = scope.id.split(".", 1)[0] ?? scope.id;
    const list = groups.get(group) ?? [];
    list.push(scope);
    groups.set(group, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({ group, scopes: list }));
}

function reasonOf(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const value = error.body.error["reason"];
  return typeof value === "string" ? value : undefined;
}

/** One sentence per refusal the key routes give; anything else falls back to the generic copy. */
export function describeApiKeyError(error: unknown): string {
  switch (reasonOf(error)) {
    case "too_many_keys":
      return m.apikeys_error_too_many_keys();
    case "scope_not_held":
      return m.apikeys_error_scope_not_held();
    case "scope_not_offered":
      return m.apikeys_error_scope_not_offered();
    default:
      return describeError(error).body;
  }
}
