/**
 * Third-party integrations (E3.6, ADR-0054). One adapter package per vendor:
 * `@fundroom/integration-quickbooks`, `-xero`, `-stripe` (KPI sources), `-slack` (chat app),
 * `-calendly`, `-calcom` (booking). The kernel service `@fundroom/integrations` owns connections,
 * OAuth state, token refresh, health and booking ingest; adapters are stateless translators.
 *
 * Security rules every adapter follows:
 * - adapters use only `deps.fetch` (the guarded outbound client, no redirects) and never build their own;
 * - tokens are decrypted by the kernel only and passed in per call; they never appear in an error
 *   message, a `detail`, or a log line;
 * - a booking webhook is verified in constant time before anything in it is trusted.
 */

import type { OutboundFetch } from "./http.js";
import type { Jurisdiction } from "./residency.js";

export const INTEGRATION_PROVIDERS = [
  "quickbooks",
  "xero",
  "stripe",
  "slack",
  "calendly",
  "calcom",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationCapability = "kpi" | "chat" | "booking";
export type IntegrationAuthKind = "oauth2" | "secret";

export interface IntegrationCredentialField {
  key: string;
  label: string;
  kind: "text" | "secret";
  required: boolean;
  help?: string;
}

export interface IntegrationProviderMeta {
  provider: IntegrationProvider;
  displayName: string;
  capabilities: readonly IntegrationCapability[];
  auth: IntegrationAuthKind;
  /** oauth2 only */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    revokeUrl?: string;
    scopes: readonly string[];
    pkce: boolean;
    scopeSeparator: " " | ",";
  };
  /** secret only — form fields (web generates the form, like esign) */
  credentialFields?: readonly IntegrationCredentialField[];
  /** plain-language list shown before connecting: what we read, what we never do */
  scopeExplanation: readonly string[];
  subProcessor: {
    name: string;
    purpose: string;
    region: string;
    dpaUrl: string;
    /** E3.11: machine jurisdiction for out-of-region flags (`@fundroom/compliance` normalises). */
    jurisdiction?: Jurisdiction | "varies" | undefined;
  };
}

/** Everything an adapter needs to call the vendor. Tokens are decrypted by the kernel only. */
export interface IntegrationAuth {
  /** oauth2 access token or the pasted secret */
  accessToken: string;
  /** QBO realmId, Xero tenantId, Slack team id, Calendly user uri, … */
  externalAccountId: string | null;
  environment: "production" | "sandbox";
}

export type IntegrationFailure =
  /** 401 / invalid token → kernel marks reauth_required */
  | "unauthorized"
  /** missing scope */
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "too_large"
  | "transport"
  | "malformed"
  | "unavailable";
export type IntegrationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: IntegrationFailure; detail?: string };

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  externalAccountId: string | null;
  extra?: Record<string, string>;
}

// KPI
export interface KpiSourceMetric {
  key: string;
  label: string;
  kind: "flow" | "stock";
  unit: "currency" | "count";
  historical: boolean;
}
export interface KpiReadRequest {
  metrics: readonly string[];
  /** YYYY-MM */
  fromMonth: string;
  /** YYYY-MM */
  toMonth: string;
  /**
   * E3.6 fix round 3: cancels the read (a job's expiry). Adapters pass it to every fetch and
   * check it between pages, answering `{ok:false, reason:"unavailable", detail:"aborted"}`.
   */
  signal?: AbortSignal;
}
export interface KpiSeries {
  metric: string;
  /** `value` is a plain decimal string in major units, no exponent. */
  points: readonly { month: string; value: string }[];
}
export interface KpiReadValue {
  currency: string | null;
  series: readonly KpiSeries[];
}

// Chat (Slack app)
export interface ChatChannelRef {
  id: string;
  name: string;
  isPrivate: boolean;
}

// Booking
export interface BookingEvent {
  /** vendor event uid (dedupe key with provider) */
  externalId: string;
  status: "booked" | "cancelled" | "rescheduled";
  startsAt: Date;
  endsAt: Date | null;
  inviteeEmail: string;
  inviteeName: string | null;
  eventName: string | null;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  environment: "production" | "sandbox";
}

export interface IntegrationAdapter {
  readonly meta: IntegrationProviderMeta;
  /** oauth2: exchange/refresh. The kernel passes client credentials from env. */
  exchangeCode?(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
    query: Record<string, string>;
    client: OAuthClient;
  }): Promise<IntegrationResult<OAuthTokenSet>>;
  refresh?(input: {
    refreshToken: string;
    client: OAuthClient;
  }): Promise<IntegrationResult<OAuthTokenSet>>;
  /** best effort, never throws */
  revoke?(input: { token: string; client: OAuthClient | null }): Promise<void>;
  /** Cheap authenticated call: who am I / which account. Returns a display label for the account. */
  verify(
    auth: IntegrationAuth,
  ): Promise<IntegrationResult<{ accountLabel: string; externalAccountId: string | null }>>;
  kpi?: {
    metrics: readonly KpiSourceMetric[];
    read(auth: IntegrationAuth, req: KpiReadRequest): Promise<IntegrationResult<KpiReadValue>>;
  };
  chat?: {
    listChannels(auth: IntegrationAuth): Promise<IntegrationResult<readonly ChatChannelRef[]>>;
    post(
      auth: IntegrationAuth,
      channelId: string,
      message: { text: string; blocks?: unknown[] },
    ): Promise<IntegrationResult<void>>;
  };
  booking?: {
    /** Verify authenticity in constant time and parse. Never trusts anything before verification. */
    parseWebhook(input: {
      headers: Record<string, string>;
      rawBody: Uint8Array;
      secret: string;
      now: Date;
    }): IntegrationResult<readonly BookingEvent[]>;
    /** Calendly: create the webhook subscription via API with our signing key. Cal.com: undefined (manual). */
    subscribe?(
      auth: IntegrationAuth,
      input: { callbackUrl: string; signingKey: string },
    ): Promise<IntegrationResult<{ subscriptionId: string }>>;
    unsubscribe?(auth: IntegrationAuth, subscriptionId: string): Promise<void>;
    /**
     * Calendly (E3.6 fix round 2): the ids of OUR subscriptions whose callback URL is
     * `callbackUrl` — for recovering from a lost subscription id (the vendor refuses a second
     * subscription for the same URL).
     */
    listSubscriptions?(
      auth: IntegrationAuth,
      callbackUrl: string,
    ): Promise<IntegrationResult<readonly string[]>>;
    /** Host allow-list for booking links, e.g. ["calendly.com"] or ["cal.com","app.cal.com"] */
    linkHosts: readonly string[];
  };
}

export interface IntegrationAdapterDeps {
  fetch: OutboundFetch;
  now: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}
export type IntegrationAdapterFactory = (deps: IntegrationAdapterDeps) => IntegrationAdapter;
