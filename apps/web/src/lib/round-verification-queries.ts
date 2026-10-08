import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, apiBase, call, isApiError } from "./api.js";

/*
 * The investor's own accreditation verification (E3.7, ADR-0055): `GET` / `POST
 * /round/current/verification`.
 *
 * The server decides everything the card shows — which provider, how the investor continues
 * (`handoff`), whether a renewal may start (`canRenew`). The browser's only judgement is how
 * often to ask again while a verification is pending, and that is `verificationPollInterval`.
 */

export type MyVerification = FundRoomSchemas["MyVerification"];
/* The handoff and the start body are inlined in the generated schema, so they are derived. */
export type MyVerificationHandoff = NonNullable<MyVerification["handoff"]>;
export interface StartVerificationBody {
  readonly subject: "individual" | "entity";
}

export const MY_VERIFICATION_KEY = ["round", "current", "verification"] as const;

/** A vendor start that ran out of retries (contract §5): the row stays pending, nobody polls. */
export const VENDOR_START_FAILED = "start_failed";

/** Fast polling while a vendor start is being set up (handoff still `null`). */
export const STARTING_POLL_MS = 5_000;
export const STARTING_POLL_MAX_MS = 20_000;
/** Give up the fast polling after this long; the investor can reload later. */
export const STARTING_WINDOW_MS = 2 * 60_000;
/** A vendor flow waits on the investor and the vendor: minutes, not seconds. */
export const VENDOR_PENDING_POLL_MS = 30_000;
/** Manual review waits on a person at the company. */
export const MANUAL_PENDING_POLL_MS = 60_000;

/**
 * A start with no handoff this long after the row was created is stuck, not slow: round's sweep
 * re-runs such starts, so the card says "still being set up" and polls slowly instead of spinning.
 */
export const STUCK_START_AFTER_MS = 15 * 60_000;

/**
 * Why round stopped working a vendor row for good (`vendor_error`): the member left or was
 * erased, or the row came from a workspace import. Nothing for the investor to retry.
 */
export const TERMINAL_VENDOR_ERRORS = ["member_inactive", "imported", "member_erased"] as const;

/**
 * A renewal the vendor answered with the investor's existing (not a newer) accreditation. Not an
 * end: round keeps polling while the investor completes the renewal with the vendor.
 */
export const RENEWAL_NOT_RECERTIFIED = "renewal_not_recertified";

export function vendorErrorOf(v: MyVerification | null | undefined): string | null {
  return v?.vendorError ?? null;
}

export function isVendorEnded(v: MyVerification | null | undefined): boolean {
  const e = vendorErrorOf(v);
  return e !== null && (TERMINAL_VENDOR_ERRORS as readonly string[]).includes(e);
}

/** A starting row older than `STUCK_START_AFTER_MS` (by its own `createdAt`). */
export function isStuckStarting(v: MyVerification | null | undefined, nowMs: number): boolean {
  if (!isStarting(v) || v == null) return false;
  const created = Date.parse(v.createdAt);
  return Number.isFinite(created) && nowMs - created >= STUCK_START_AFTER_MS;
}

/** Pending, vendor start still running (no handoff yet, and it has not failed). */
export function isStarting(v: MyVerification | null | undefined): boolean {
  return (
    v != null &&
    v.status === "pending" &&
    v.handoff === null &&
    v.provider !== "manual" &&
    v.vendorStatus !== VENDOR_START_FAILED &&
    !isVendorEnded(v)
  );
}

/**
 * How long until the next `GET`, or `false` to stop. Starting: 5 s, backing off ×1.5 to 20 s,
 * for at most two minutes after the card first saw it starting; a start stuck for 15 minutes
 * (by `createdAt`) gets the slow poll. Other pending rows: a slow poll. Decided, failed, ended
 * or absent rows: none. (Hidden tabs never poll — TanStack Query pauses
 * `refetchInterval` in the background unless told otherwise.)
 */
export function verificationPollInterval(
  v: MyVerification | null | undefined,
  startingSinceMs: number | null,
  nowMs: number,
): number | false {
  if (v == null || v.status !== "pending") return false;
  if (v.vendorStatus === VENDOR_START_FAILED && v.handoff === null) return false;
  if (isVendorEnded(v)) return false;
  if (isStuckStarting(v, nowMs)) return VENDOR_PENDING_POLL_MS;
  if (isStarting(v)) {
    const since = startingSinceMs ?? nowMs;
    const elapsed = nowMs - since;
    if (elapsed >= STARTING_WINDOW_MS) return false;
    const steps = Math.floor(elapsed / 30_000);
    return Math.min(STARTING_POLL_MS * 1.5 ** steps, STARTING_POLL_MAX_MS);
  }
  return v.provider === "manual" ? MANUAL_PENDING_POLL_MS : VENDOR_PENDING_POLL_MS;
}

export const myVerificationQuery = queryOptions({
  queryKey: MY_VERIFICATION_KEY,
  queryFn: () => call(api().GET("/round/current/verification")),
});

export function startVerification(body: StartVerificationBody): Promise<MyVerification> {
  return call(api().POST("/round/current/verification", { body }));
}

/**
 * The pending row a 409 `verification_pending` carries (`details.verification`), so the card
 * can show it instead of an error. Flattened onto `error` in practice; a nested `details` too.
 */
export function pendingVerificationOf(error: unknown): MyVerification | undefined {
  if (!isApiError(error) || error.status !== 409) return undefined;
  const flat = error.body.error as Record<string, unknown>;
  const details = flat["details"] as Record<string, unknown> | undefined;
  const reason = flat["reason"] ?? details?.["reason"];
  if (reason !== "verification_pending") return undefined;
  const row = flat["verification"] ?? details?.["verification"];
  return typeof row === "object" && row !== null && "id" in row
    ? (row as MyVerification)
    : undefined;
}

/**
 * Where a `widget`/`redirect` handoff goes. The widget URL is the server's own handoff page
 * (a path); a redirect is an absolute https vendor URL. Anything else is not followed.
 */
export function handoffHref(url: string): string | undefined {
  if (url.startsWith("/") && !url.startsWith("//")) return `${apiBase()}${url}`;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
