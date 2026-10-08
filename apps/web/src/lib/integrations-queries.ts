import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Integrations hub (E3.6, ADR-0054). Kernel routes behind `integrations.read` /
 * `integrations.manage`; connecting, choosing a Xero organisation, rotating a booking webhook
 * secret and disconnecting also need a fresh session, which `useGuardedMutation` turns into a
 * step-up and back.
 *
 * Credentials are write-only: no response carries a token or key. A booking provider's webhook
 * signing secret is on the wire exactly once — in the connect or rotate response that minted
 * it — so, like an API key's token, it lives in component state only (never this cache).
 *
 * OAuth providers connect through a top-level navigation: `POST …/oauth/begin` returns a
 * single-use start URL, the SPA does `window.location.assign(startUrl)`, and the server's
 * callback lands back on `/admin/integrations?integration=<p>&result=connected|error&reason=…`.
 */
export type IntegrationProviderInfo = FundRoomSchemas["IntegrationProviderInfo"];
export type IntegrationProvider = IntegrationProviderInfo["provider"];
export type IntegrationCredentialField = IntegrationProviderInfo["credentialFields"][number];
export type IntegrationCapability = IntegrationProviderInfo["capabilities"][number];
export type IntegrationConnection = FundRoomSchemas["IntegrationConnection"];
export type IntegrationStatus = IntegrationConnection["status"];
export type BookingLink = FundRoomSchemas["BookingLink"];
export type BookingLinkAudience = BookingLink["audience"];
export type BookingProvider = BookingLink["provider"];
export type BookingLinkPublic = FundRoomSchemas["BookingLinkPublic"];
export type IntegrationBooking = FundRoomSchemas["IntegrationBooking"];
export type IntegrationBookingPage = FundRoomSchemas["IntegrationBookingPage"];

export const INTEGRATIONS_KEY = ["integrations"] as const;

/** Where an operator registers the OAuth apps (`INTEGRATIONS_<P>_CLIENT_ID/_SECRET`). */
export const OPERATOR_DOCS_URL =
  "https://github.com/fundroomhq/fundroom/blob/main/docs/integrations/README.md";

/** Links on a workspace; the server enforces the same cap (409 `booking_link_limit`). */
export const MAX_BOOKING_LINKS = 10;

export const BOOKING_PROVIDERS: readonly BookingProvider[] = ["calcom", "calendly"];

export const integrationProvidersQuery = queryOptions({
  queryKey: [...INTEGRATIONS_KEY, "providers"],
  queryFn: () => call(api().GET("/integrations/providers")),
  staleTime: 5 * 60_000,
});

export const integrationConnectionsQuery = queryOptions({
  queryKey: [...INTEGRATIONS_KEY, "connections"],
  queryFn: () => call(api().GET("/integrations/connections")),
});

export const bookingLinksQuery = queryOptions({
  queryKey: [...INTEGRATIONS_KEY, "booking-links"],
  queryFn: () => call(api().GET("/integrations/booking-links")),
});

/** The portal's "Book time" card: what this member may see (audience-filtered by the server). */
export const myBookingLinksQuery = queryOptions({
  queryKey: [...INTEGRATIONS_KEY, "me", "booking-links"],
  queryFn: () => call(api().GET("/integrations/me/booking-links")),
});

/** Newest first, keyset-paged; the cursor is opaque. */
export function integrationBookingsQuery(limit = 25) {
  return infiniteQueryOptions({
    queryKey: [...INTEGRATIONS_KEY, "bookings", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/integrations/bookings", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: IntegrationBookingPage) => last.nextCursor ?? undefined,
  });
}

// --- the OAuth round trip ---------------------------------------------------------------------

/** Test seam: the top-level navigation to the server's OAuth start URL. */
export const oauthNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** Where the callback sends the admin back to (the begin body's `returnPath`). */
export const OAUTH_RETURN_PATH = "/admin/integrations";

/** Display names for the provider ids the callback may put in the query (never echoed raw). */
const PROVIDER_NAMES: Readonly<Record<IntegrationProvider, string>> = {
  quickbooks: "QuickBooks Online",
  xero: "Xero",
  stripe: "Stripe",
  slack: "Slack",
  calendly: "Calendly",
  calcom: "Cal.com",
};

export function knownProvider(id: unknown): IntegrationProvider | undefined {
  return typeof id === "string" && Object.hasOwn(PROVIDER_NAMES, id)
    ? (id as IntegrationProvider)
    : undefined;
}

export function providerName(provider: IntegrationProvider): string {
  return PROVIDER_NAMES[provider];
}

/** A pending OAuth grant waiting for the initiating admin's confirmation (FIX1, R1-H1). */
export interface PendingGrant {
  readonly provider: IntegrationProvider;
  readonly token: string;
}

/**
 * What the callback's landing URL asks the page to show. The callback no longer connects
 * anything: success arrives as `result=pending` plus a `#pending=<token>` fragment, and only
 * `POST …/oauth/complete` (by the admin who started it) creates the connection. So there is no
 * "connected" landing any more — a crafted `?result=connected` shows nothing (review L3).
 *
 *  - `error`: the vendor round trip failed (`reason` picks the sentence);
 *  - `pending`: a known provider and a well-formed token — ask the admin to confirm;
 *  - `invalid`: `result=pending` without a usable token or with an unknown provider.
 */
export type OAuthLanding =
  | {
      readonly kind: "error";
      readonly provider: IntegrationProvider | undefined;
      readonly reason: string | undefined;
    }
  | { readonly kind: "pending"; readonly grant: PendingGrant }
  | { readonly kind: "invalid"; readonly provider: IntegrationProvider | undefined };

const PENDING_TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/u;

/** `?integration=&result=&reason=` + `#pending=` as the callback leaves them. */
export function oauthLandingOf(
  search: Record<string, unknown>,
  hash: string,
): OAuthLanding | undefined {
  const provider = knownProvider(search["integration"]);
  const result = search["result"];
  if (result === "error") {
    const reason = search["reason"];
    return {
      kind: "error",
      provider,
      reason: typeof reason === "string" && reason !== "" ? reason.slice(0, 64) : undefined,
    };
  }
  if (result !== "pending") return undefined;
  const token = new URLSearchParams(hash.replace(/^#/u, "")).get("pending");
  if (provider === undefined || token === null || !PENDING_TOKEN_RE.test(token)) {
    return { kind: "invalid", provider };
  }
  return { kind: "pending", grant: { provider, token } };
}

/*
 * The confirm needs a fresh session, and a step-up leaves the page. So the grant is parked in
 * this tab's sessionStorage just before the confirm is sent, and picked up again when the admin
 * comes back. It is cleared after use (success, refusal, cancel) and ignored after 10 minutes —
 * the server's own pending lifetime. Storage can be missing or throw (private mode, blocked
 * site data): then the admin simply starts again.
 */
const PENDING_KEY = "seed-host.integrations.pending";
const PENDING_TTL_MS = 10 * 60_000;

export function parkPendingGrant(grant: PendingGrant, now = Date.now()): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...grant, savedAt: now }));
  } catch {
    // Unavailable storage: the step-up round trip loses the grant; the admin starts again.
  }
}

export function clearPendingGrant(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function parkedPendingGrant(now = Date.now()): PendingGrant | undefined {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; token?: unknown; savedAt?: unknown };
    const provider = knownProvider(parsed.provider);
    const fresh =
      typeof parsed.savedAt === "number" &&
      now - parsed.savedAt >= 0 &&
      now - parsed.savedAt < PENDING_TTL_MS;
    if (
      provider !== undefined &&
      typeof parsed.token === "string" &&
      PENDING_TOKEN_RE.test(parsed.token) &&
      fresh
    ) {
      return { provider, token: parsed.token };
    }
  } catch {
    // Corrupt entry: dropped below.
  }
  clearPendingGrant();
  return undefined;
}

/** Why the vendor round trip failed, in words. Unknown codes read as the generic failure. */
export function oauthReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "denied":
      return m.integrations_return_reason_denied();
    case "expired":
      return m.integrations_return_reason_expired();
    case "browser_mismatch":
      return m.integrations_return_reason_browser_mismatch();
    case "exchange_failed":
      return m.integrations_return_reason_exchange_failed();
    case "verify_failed":
      return m.integrations_return_reason_verify_failed();
    case "not_available":
      return m.integrations_return_reason_not_available();
    case "invalid_request":
      return m.integrations_return_reason_invalid_request();
    default:
      return m.integrations_return_reason_other();
  }
}

// --- labels -----------------------------------------------------------------------------------

export function statusLabel(status: IntegrationStatus): string {
  switch (status) {
    case "active":
      return m.integrations_status_active();
    case "degraded":
      return m.integrations_status_degraded();
    case "reauth_required":
      return m.integrations_status_reauth_required();
  }
}

export function statusVariant(status: IntegrationStatus): "success" | "warning" | "destructive" {
  switch (status) {
    case "active":
      return "success";
    case "degraded":
      return "warning";
    case "reauth_required":
      return "destructive";
  }
}

export function capabilityLabel(capability: IntegrationCapability): string {
  switch (capability) {
    case "kpi":
      return m.integrations_capability_kpi();
    case "chat":
      return m.integrations_capability_chat();
    case "booking":
      return m.integrations_capability_booking();
  }
}

export function bookingProviderLabel(provider: BookingProvider): string {
  return provider === "calcom" ? m.booking_provider_calcom() : m.booking_provider_calendly();
}

export function bookingStatusLabel(status: IntegrationBooking["status"]): string {
  switch (status) {
    case "booked":
      return m.booking_status_booked();
    case "cancelled":
      return m.booking_status_cancelled();
    case "rescheduled":
      return m.booking_status_rescheduled();
  }
}

/** The credential field's label in the reader's language; unknown fields keep the adapter's. */
export function credentialFieldLabel(
  provider: IntegrationProvider,
  field: IntegrationCredentialField,
): string {
  switch (`${provider}.${field.key}`) {
    case "stripe.restrictedKey":
      return m.integrations_field_stripe_restricted_key();
    case "calendly.personalAccessToken":
      return m.integrations_field_calendly_token();
    default:
      return field.label;
  }
}

export function credentialFieldHelp(
  provider: IntegrationProvider,
  field: IntegrationCredentialField,
): string | undefined {
  switch (`${provider}.${field.key}`) {
    case "stripe.restrictedKey":
      return m.integrations_field_stripe_restricted_key_help();
    case "calendly.personalAccessToken":
      return m.integrations_field_calendly_token_help();
    default:
      return field.help;
  }
}

// --- errors -----------------------------------------------------------------------------------

function detailOf(error: unknown, key: string): string | undefined {
  if (!isApiError(error)) return undefined;
  const flat = error.body.error[key];
  if (typeof flat === "string") return flat;
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.[key];
  return typeof nested === "string" ? nested : undefined;
}

export function integrationErrorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.code : undefined;
}

/** A 422 on rotate whose subscribe retry failed after the old Calendly subscription was removed. */
export function subscriptionLost(error: unknown): boolean {
  if (!isApiError(error)) return false;
  const flat = error.body.error["subscriptionLost"];
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.[
    "subscriptionLost"
  ];
  return flat === true || nested === true;
}

/** Why rotating a booking webhook secret was refused, in words. */
export function describeRotateError(error: unknown, provider: string): string {
  if (
    integrationErrorCode(error) === "conflict" &&
    detailOf(error, "reason") === "rotation_in_progress"
  ) {
    return m.integrations_error_rotation_in_progress();
  }
  if (subscriptionLost(error)) return m.integrations_error_subscription_lost({ provider });
  return describeIntegrationError(error);
}

/** One sentence per refusal the integrations routes give; anything else is the generic copy. */
export function describeIntegrationError(error: unknown): string {
  switch (integrationErrorCode(error)) {
    case "integration_credentials_rejected":
      switch (detailOf(error, "reason")) {
        case "unauthorized":
          return m.integrations_error_rejected_unauthorized();
        case "forbidden":
          return m.integrations_error_rejected_forbidden();
        case "subscribe_failed":
          return m.integrations_error_rejected_subscribe_failed();
        case "transport":
        case "unavailable":
        case "rate_limited":
          return m.integrations_error_rejected_unreachable();
        default:
          return m.integrations_error_rejected_other();
      }
    case "integration_secret_key_refused":
      return m.integrations_error_secret_key_refused();
    case "integration_not_available":
      return m.integrations_error_not_available();
    case "integration_oauth_required":
      return m.integrations_error_oauth_required();
    case "integration_not_connected":
      return m.integrations_error_not_connected();
    case "integration_account_unknown":
      return m.integrations_error_account_unknown();
    case "integration_oauth_pending_invalid":
      return m.integrations_error_pending_invalid();
    case "booking_link_invalid_url":
      return m.booking_error_invalid_url();
    case "booking_link_limit":
      return m.booking_error_limit({ max: MAX_BOOKING_LINKS });
    default:
      return describeError(error).body;
  }
}
