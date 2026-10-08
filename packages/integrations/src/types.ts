import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import type { core, Database, Membership, TenantContext } from "@fundroom/db";
import type {
  IntegrationBookingView,
  IntegrationConnectionSummary,
  IntegrationServices,
} from "@fundroom/module-kit";
import type {
  IntegrationAdapter,
  IntegrationAuthKind,
  IntegrationCapability,
  IntegrationCredentialField,
  IntegrationProvider,
  IntegrationProviderMeta,
  JobDefinition,
  JsonObject,
  KpiSourceMetric,
  OAuthClient,
} from "@fundroom/ports";

export type { IntegrationBookingView, IntegrationConnectionSummary, IntegrationServices };

/** Workspace key purpose (ADR-0016) for every sealed integrations column. */
export const INTEGRATION_KEY_PURPOSE = "integration-credentials";

export const INTEGRATION_JOBS = {
  health: "integrations.health",
  retention: "integrations.retention",
  oauthStateSweep: "integrations.oauth-state-sweep",
} as const;

export const INTEGRATION_CRONS = {
  health: "15 5 * * *",
  retention: "25 5 * * *",
  oauthStateSweep: "50 * * * *",
} as const;

/** The ops paths (under BASE_PATH). The callback is the one redirect URI registered per vendor. */
export const OAUTH_START_PATH = "/oauth/integrations/start";
export const OAUTH_CALLBACK_PATH = "/oauth/integrations/callback";
export const BOOKING_WEBHOOK_PATH_PREFIX = "/webhooks/integrations/";
/** Where OAuth results land by default (and every expired/unknown state). */
export const DEFAULT_RETURN_PATH = "/admin/integrations";

export type BookingLinkAudience = core.BookingLinkAudience;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface IntegrationsServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly crypto: Pick<EnvelopeService, "currentKey" | "keyById" | "keysFor">;
  /**
   * Every adapter by provider, already built on the integrations' guarded outbound client
   * (`container.integrationsOutbound`: no redirects, 15 s, 2 MiB). A provider with no adapter is
   * not offered.
   */
  readonly adapters: Readonly<Partial<Record<IntegrationProvider, IntegrationAdapter>>>;
  /** Deployment-level OAuth clients from env; a provider without one is `available: false`. */
  readonly oauthClients: Readonly<Partial<Record<IntegrationProvider, OAuthClient>>>;
  /**
   * The install's public root for the ops routes: `BASE_URL` origin + `BASE_PATH`, no trailing
   * slash (`https://investors.example.com`). The OAuth redirect URI and booking webhook URLs are
   * built on it.
   */
  readonly publicBaseUrl: string;
  /** A workspace's own origin + `path` (custom domain / tenant host / base URL), absolute. */
  readonly workspaceUrl: (
    workspace: { readonly slug: string; readonly primaryHost: string | null },
    path: string,
  ) => string;
  /**
   * The authz check the confirm step re-runs for the initiator (`authz.hasPermission`): a member
   * demoted mid-handshake cannot finish it.
   */
  readonly hasPermission?: ((membership: Membership, permission: string) => boolean) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
  /** Test seams for the refresh lease (defaults: 30 s lease, losers wait up to 5 s, poll 250 ms). */
  readonly refreshLeaseMs?: number | undefined;
  readonly refreshWaitMs?: number | undefined;
  readonly refreshPollMs?: number | undefined;
}

/** Who asked, for the audit row. */
export interface IntegrationActor {
  readonly membershipId: string | null;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface IntegrationProviderInfo {
  readonly provider: IntegrationProvider;
  readonly displayName: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly auth: IntegrationAuthKind;
  readonly available: boolean;
  readonly credentialFields: readonly IntegrationCredentialField[];
  readonly scopeExplanation: readonly string[];
  readonly kpiMetrics: readonly KpiSourceMetric[];
  readonly bookingLinkHosts: readonly string[];
  readonly subProcessor: IntegrationProviderMeta["subProcessor"];
}

export interface IntegrationAccountRef {
  readonly id: string;
  readonly name: string;
}

/** A connection as the admin screen sees it. Never a credential. */
export interface IntegrationConnectionView {
  readonly id: string;
  readonly provider: IntegrationProvider;
  readonly status: "active" | "degraded" | "reauth_required";
  readonly environment: "production" | "sandbox";
  readonly accountLabel: string | null;
  readonly externalAccountId: string | null;
  /** Xero: the organisations the grant covers. */
  readonly availableAccounts?: readonly IntegrationAccountRef[] | undefined;
  readonly scope: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly connectedAt: Date;
  /** Booking providers: where the vendor POSTs events. */
  readonly webhookUrl: string | null;
}

export type OAuthStartError = "expired" | "not_available";

export type BookingProvider = "calendly" | "calcom";

export interface BookingLinkView {
  readonly id: string;
  readonly provider: BookingProvider;
  readonly url: string;
  readonly label: string;
  readonly description: string | null;
  readonly audience: BookingLinkAudience;
  readonly position: number;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BookingLinkPublic {
  readonly id: string;
  readonly provider: BookingProvider;
  readonly url: string;
  readonly label: string;
  readonly description: string | null;
}

export interface BookingLinkInput {
  readonly provider?: BookingProvider | undefined;
  readonly url?: string | undefined;
  readonly label?: string | undefined;
  readonly description?: string | null | undefined;
  readonly audience?: BookingLinkAudience | undefined;
  readonly position?: number | undefined;
  readonly enabled?: boolean | undefined;
}

export interface IntegrationBookingRecord extends IntegrationBookingView {
  readonly receivedAt: Date;
  readonly updatedAt: Date;
}

/**
 * `unauthorized`: unknown/deleted connection or a bad signature (one answer, no oracle);
 * `throttled`: authentic but over the route's budget (answered 200, nothing recorded);
 * `ignored`: authentic but nothing to record (not a booking connection, disconnected meanwhile).
 */
export type BookingWebhookOutcome = "accepted" | "unauthorized" | "ignored" | "throttled";

/**
 * A-3 (ADR-0063): the plan's gate on CONNECTING a provider. Called only when the workspace has no
 * live connection of that provider, and throws to refuse (the plan's 402); reconnecting a provider
 * that is connected (re-keying, re-authorising) is maintenance and never calls it. The connect
 * paths call it once before anything reaches the vendor and again under the provider's singleton
 * lock (authoritative).
 */
export interface IntegrationConnectGate {
  readonly assertMayConnect?: (() => void) | undefined;
}

/** The kernel service: `ModuleServices.integrations` (`services`) plus the kernel routes' needs. */
export interface IntegrationsKernel {
  providers(): IntegrationProviderInfo[];
  list(ctx: TenantContext): Promise<IntegrationConnectionView[]>;
  connectWithSecret(
    ctx: TenantContext,
    provider: IntegrationProvider,
    input: IntegrationConnectGate & {
      readonly credentials: Readonly<Record<string, string>>;
      readonly environment?: "production" | "sandbox" | undefined;
    },
    actor: IntegrationActor,
  ): Promise<{ connection: IntegrationConnectionView; webhookSecret?: string }>;
  beginOAuth(
    ctx: TenantContext,
    provider: IntegrationProvider,
    input: IntegrationConnectGate & {
      readonly environment?: "production" | "sandbox" | undefined;
      readonly returnPath?: string | undefined;
    },
    actor: IntegrationActor,
  ): Promise<{ startUrl: string; expiresAt: Date }>;
  startOAuth(
    ticket: string,
  ): Promise<{ redirectTo: string; browserNonce: string } | { error: OAuthStartError }>;
  completeOAuth(
    query: Readonly<Record<string, string>>,
    browserNonce: string | undefined,
  ): Promise<{ redirectTo: string }>;
  /**
   * The confirm step (fix round 1): the initiator, signed in to the workspace, turns the pending
   * grant the callback stored into a connection. Every refusal is 404
   * `integration_oauth_pending_invalid`.
   */
  confirmOAuth(
    ctx: TenantContext,
    provider: IntegrationProvider,
    pendingToken: string,
    actor: IntegrationActor,
    gate?: IntegrationConnectGate,
  ): Promise<IntegrationConnectionView>;
  /** The URL an expired / unknown start or callback lands on (canonical host). */
  oauthErrorUrl(reason: string): string;
  verify(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<IntegrationConnectionView>;
  selectAccount(
    ctx: TenantContext,
    provider: IntegrationProvider,
    externalAccountId: string,
    actor: IntegrationActor,
  ): Promise<IntegrationConnectionView>;
  disconnect(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<void>;
  rotateWebhookSecret(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<{ connection: IntegrationConnectionView; webhookSecret: string }>;
  ingestBookingWebhook(
    connectionId: string,
    req: { readonly headers: Headers; readonly rawBody: Uint8Array },
    options?: { readonly admit?: (() => boolean) | undefined },
  ): Promise<BookingWebhookOutcome>;
  readonly bookingLinks: {
    list(ctx: TenantContext): Promise<BookingLinkView[]>;
    put(
      ctx: TenantContext,
      id: string | null,
      input: BookingLinkInput,
      actor: IntegrationActor,
    ): Promise<BookingLinkView>;
    remove(ctx: TenantContext, id: string, actor: IntegrationActor): Promise<void>;
    /** Enabled links this member may see (staff: all; external: audience-filtered). */
    forMember(ctx: TenantContext, membershipId: string): Promise<BookingLinkPublic[]>;
  };
  bookings(
    ctx: TenantContext,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<{ items: IntegrationBookingRecord[]; nextCursor: string | null }>;
  readonly services: IntegrationServices;
  readonly jobs: readonly JobDefinition<JsonObject>[];
}
