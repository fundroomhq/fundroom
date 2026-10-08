import { hkdfSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createManualAccreditationProvider } from "@fundroom/accred-manual";
import { parallelMarketsAdapter } from "@fundroom/accred-parallel-markets";
import { verifyInvestorAdapter } from "@fundroom/accred-verifyinvestor";
import { type AccreditationKernel, createAccreditationService } from "@fundroom/accreditation";
import type { AiKernel } from "@fundroom/ai";
import { type ApiKeyService, createApiKeyService } from "@fundroom/api-keys";
import {
  type AuditService,
  createAnchorJob,
  createAuditMaintenanceJob,
  createAuditService,
  createCheckpointJob,
  findEventById,
  toAuditRecord,
} from "@fundroom/audit";
import {
  type AuthzService,
  apiKeyScopes,
  createAuthzService,
  loadAuthzMatrix,
  PrincipalRepo,
  type RelationshipEngineHandle,
} from "@fundroom/authz";
import { createClamdScanner } from "@fundroom/avscan-clamd";
import { createNoopScanner } from "@fundroom/avscan-noop";
import { createSlackChat } from "@fundroom/chat-slack";
import {
  createAcceptanceService,
  createLegalPort,
  createRelationshipService,
  permits,
  prelockIdentityErasure,
} from "@fundroom/compliance";
import { type AppConfig, ownCellOrigin } from "@fundroom/config";
import { ensureOwnCell, liveWorkspacesOnCell, repairWorkspaceEntry } from "@fundroom/control-plane";
import { createCryptoJobs, createEnvelopeService, type EnvelopeService } from "@fundroom/crypto";
import {
  type CustomDomainLookup,
  type CustomDomainService,
  createCustomDomainLookup,
  createCustomDomainService,
  createDomainJobs,
} from "@fundroom/custom-domains";
import {
  createDatabase,
  createWorkspaceResolver,
  type Database,
  findWorkspaceById,
  isPlatformWorkspace,
  systemContext,
  type TenantContext,
  type WorkspaceResolver,
} from "@fundroom/db";
import {
  createLocalDirectory,
  createSharedDirectory,
  isSharedDirectory,
} from "@fundroom/directory";
import { createDohResolver } from "@fundroom/dns-doh";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { createCaddyAskProvider } from "@fundroom/domain-caddy-ask";
import { createCloudflareSaasProvider } from "@fundroom/domain-cloudflare-saas";
import { createManualProvider } from "@fundroom/domain-manual";
import { createPostmarkMailer } from "@fundroom/email-postmark";
import { createResendMailer } from "@fundroom/email-resend";
import { createSesMailer } from "@fundroom/email-ses";
import { createSmtpMailer } from "@fundroom/email-smtp";
import { createESignService, type ESignKernel } from "@fundroom/esign";
import { documensoAdapter } from "@fundroom/esign-documenso";
import { docusealAdapter } from "@fundroom/esign-docuseal";
import { docusignAdapter } from "@fundroom/esign-docusign";
import { dropboxSignAdapter } from "@fundroom/esign-dropbox-sign";
import {
  createEventMaintenanceJobs,
  createOutboxRelay,
  createSubscriptionRegistry,
  type OutboxRelay,
  prepareEventQueues,
  publish,
  registerEventWorkers,
  registerJobs,
  type SubscriptionRegistry,
} from "@fundroom/events";
import {
  type AccessRequestService,
  type AuthService,
  createAccessRequestJobs,
  createAccessRequestService,
  createAccessReviewJobs,
  createAuthService,
  createHandoffService,
  createIdentityJobs,
  createPostgresRateLimiter,
  type HandoffService,
  type IdentityDeps,
} from "@fundroom/identity";
import { createCalcomAdapter } from "@fundroom/integration-calcom";
import { createCalendlyAdapter } from "@fundroom/integration-calendly";
import { createQuickbooksAdapter } from "@fundroom/integration-quickbooks";
import { createSlackAdapter } from "@fundroom/integration-slack";
import { createStripeAdapter } from "@fundroom/integration-stripe";
import { createXeroAdapter } from "@fundroom/integration-xero";
import { createIntegrationsService, type IntegrationsKernel } from "@fundroom/integrations";
import { createLocalKms } from "@fundroom/kms-local";
import { createLogMailer, createTemplatedMailer, type EmailBrand } from "@fundroom/mail";
import {
  type AiServices,
  createEnablementCache,
  createModuleRegistry,
  type EnablementCache,
  loadWorkspaceModules,
  type ModuleManifest,
  type ModuleRegistry,
  type ModuleServices,
  type SearchIndexService,
} from "@fundroom/module-kit";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import { createPortabilityJobs } from "@fundroom/portability";
import type {
  AccreditationAdapterDefinition,
  AccreditationVendorDriver,
  AccreditationVerificationPort,
  AuditAnchorPort,
  AuditSinkPort,
  ChatWebhookPort,
  CustomDomainProviderPort,
  DirectoryPort,
  DnsResolverPort,
  DocumentRenderPort,
  ESignAdapterDefinition,
  ESignDriver,
  IntegrationAdapter,
  IntegrationAdapterFactory,
  IntegrationProvider,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  KmsPort,
  MailerPort,
  ModelPort,
  ObjectStoragePort,
  OutboundEmail,
  RateLimiterPort,
  SpreadsheetPort,
  VirusScanPort,
} from "@fundroom/ports";
import { createPgBossQueue, grantLockTimeoutWithin } from "@fundroom/queue-pgboss";
import { createPdfiumRenderer } from "@fundroom/render-pdfium";
import { createScimService, type ScimService } from "@fundroom/scim";
import { createSearchIndex, createSearchJobs } from "@fundroom/search";
import { createShareLinkAccess, createShareLinkService } from "@fundroom/share-links";
import { createGoogleSheetsAdapter, createNoopSpreadsheets } from "@fundroom/sheets-google";
import { createSsoService, type SsoService } from "@fundroom/sso";
import { createFsStorage } from "@fundroom/storage-fs";
import { createS3Storage } from "@fundroom/storage-s3";
import { createUpdateChecker, type UpdateChecker } from "@fundroom/update-check";
import {
  createWebhookService,
  WEBHOOK_FANOUT_SUBSCRIPTION,
  WEBHOOK_HTTP_TIMEOUT_MS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_USER_AGENT,
  WEBHOOK_WORKER_CONCURRENCY,
  type WebhookService,
} from "@fundroom/webhooks";
import { createAiModel, createAiWiring } from "./ai/wiring.js";
import { withApiKeyAudit } from "./api-key-context.js";
import { type AuditAnchoring, createAuditAnchoring } from "./audit-anchoring.js";
import { createAuthzEngineWiring } from "./authz-engine-wiring.js";
import { createBillingWiring } from "./control-plane/billing-wiring.js";
import { createCentralAuthWiring } from "./control-plane/central-auth-wiring.js";
import type {
  BillingKernel,
  CentralAuthKernel,
  ControlPlaneKernel,
  SanctionsKernel,
} from "./control-plane/kernel.js";
import { createOperatorsWiring } from "./control-plane/operators-wiring.js";
import { createSanctionsWiring } from "./control-plane/sanctions-wiring.js";
import type { ControlPlaneWiringDeps } from "./control-plane/types.js";
import { createUsageWiring } from "./control-plane/usage-wiring.js";
import { createEntitlements } from "./entitlements.js";
import { type Log, type Logger, logHook } from "./logger.js";
import { createMailFeedback, type MailFeedback } from "./mail/feedback.js";
import { createMailJobs } from "./mail/jobs.js";
import { createKernelMailer } from "./mail/kernel-mailer.js";
import { countSecurityEvent } from "./middleware/security-events.js";
import { baseUrlIsMount, canonicalBaseOf, isMountOrigin } from "./path-mount.js";
import {
  createDirectoryJobs,
  directoryOwnerKeys,
  publishDirectoryCells,
} from "./residency/directory-jobs.js";
import { type ResidencyKernel, residencyFactsOf } from "./residency/kernel.js";
import { createMoveJobs } from "./residency/move-jobs.js";
import { INVITE_DAILY_CAP } from "./routes/access.js";
import {
  type AccreditationCallbackIngest,
  accreditationCallbackUrl,
} from "./routes/accreditation-callback.js";
import { emailBrandOf } from "./routes/branding.js";
import { moduleServicesOf, proxyTrustOf, workspaceUrl } from "./routes/deps.js";
import { type ESignCallbackIngest, esignCallbackUrl } from "./routes/esign-callback.js";
import { createSetupGate, type SetupGate } from "./setup/gate.js";
import {
  disabledSetupToken,
  removeSetupTokenFile,
  resolveSetupToken,
  type SetupToken,
} from "./setup/token.js";
import { canonicalHostOf } from "./tenancy.js";
import { SERVER_VERSION } from "./version.js";
import { createWorkspacePurgeJob } from "./workspace/lifecycle.js";

/*
 * The composition root (§5.2 "wired in apps/server/src/container.ts from env; no DI
 * framework"). Adapters are chosen from config; every kernel service is built once with its
 * `log` hook bound to a pino child. `start()` opens the queue, registers jobs and (on the
 * api role) starts the outbox relay; `stop()` drains in reverse. Nothing here talks to the
 * database until `start()`.
 */
export interface ContainerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Compiled-in module manifests (Phase 1 fills this). */
  readonly modules?: readonly ModuleManifest[] | undefined;
  /** Additional audit destinations; empty by default (Postgres is the record). */
  readonly auditSinks?: readonly AuditSinkPort[] | undefined;
  /** Test seam: replace the mailer (memory mailer in integration tests). */
  readonly mailer?: MailerPort | undefined;
  /**
   * Test seam: replace the DNS resolver. Integration tests have no zone to publish to, and the
   * real resolver deliberately talks to 1.1.1.1 — which a test must never do.
   */
  readonly dns?: DnsResolverPort | undefined;
  /**
   * Test seam: replace the spreadsheet port. The real adapter talks to Google, which a test must
   * never do, and the integration harness has no service account to sign with.
   */
  readonly spreadsheets?: SpreadsheetPort | undefined;
  /**
   * Test seam: replace the accreditation verifier. The shipped driver needs no network, but a
   * test that wants a verification to come back `verified` has no other way to say so.
   */
  readonly accreditation?: AccreditationVerificationPort | undefined;
  /**
   * Test seam (E3.11): replace the cell directory (e.g. a shared directory over a test database
   * with a fixed cell id). Default: `shared` when DIRECTORY_DATABASE_URL is set, else `local`.
   */
  readonly directory?: DirectoryPort | undefined;
  /**
   * Test seam: replace the chat webhook adapter (E2.6). The real one posts to `hooks.slack.com`,
   * which a test must never do.
   */
  readonly chat?: ChatWebhookPort | undefined;
  /**
   * Test seam (E3.5): replace e-sign vendor adapters by driver — typically
   * `createMemoryESignAdapter()` from `@fundroom/esign/testing`, or a fake-server-backed real
   * adapter. Drivers not named keep the shipped adapter. A test must never reach a real vendor.
   */
  readonly esignAdapters?: Partial<Record<ESignDriver, ESignAdapterDefinition>> | undefined;
  /**
   * Test seam (E3.6): replace integration adapter factories by provider — typically a real adapter
   * pointed at a local fake server via its `apiBaseUrl`/`authBaseUrl` overrides (the only place
   * those overrides may come from). Providers not named keep the shipped adapter. A test must
   * never reach a real vendor.
   */
  readonly integrationAdapters?:
    | Partial<Record<IntegrationProvider, IntegrationAdapterFactory>>
    | undefined;
  /** Test seam (E3.6): replace the whole integrations kernel. */
  readonly integrations?: IntegrationsKernel | undefined;
  /**
   * Test seam (E3.7): replace accreditation vendor adapters by driver — typically
   * `createMemoryAccreditationAdapter()` from `@fundroom/accreditation/testing`. Drivers not named
   * keep the shipped adapter. A test must never reach a real vendor.
   */
  readonly accreditationAdapters?:
    | Partial<Record<AccreditationVendorDriver, AccreditationAdapterDefinition>>
    | undefined;
  /**
   * Test seam (E3.7): a vendor's API base URL (a local fake server), passed to the adapter as
   * `deps.apiBaseUrl` — the only place that override may come from.
   */
  readonly accreditationApiBaseUrls?:
    | Partial<Record<AccreditationVendorDriver, string>>
    | undefined;
  /**
   * Test seam (E3.12): the AI model port (typically `createFakeModel()` from
   * `@fundroom/ai/testing`). Set = AI is available with this port's `info`, whatever AI_PROVIDER
   * says. A test must never reach a real model provider.
   */
  readonly aiModel?: ModelPort | undefined;
  /**
   * Test seam (E3.13): the audit anchor drivers (typically `createFakeAnchor()` from
   * `@fundroom/audit/testing`, or the real adapters pointed at local stubs). Set = anchoring is on
   * with exactly these drivers, whatever AUDIT_ANCHOR_DRIVERS says. A test must never reach a real
   * TSA or Rekor.
   */
  readonly auditAnchorDrivers?: readonly AuditAnchorPort[] | undefined;
  readonly now?: (() => Date) | undefined;
}

/** The shipped e-sign vendor adapters (E3.5, ADR-0053), by driver. */
export const ESIGN_ADAPTERS: Readonly<Record<ESignDriver, ESignAdapterDefinition>> = {
  documenso: documensoAdapter,
  docuseal: docusealAdapter,
  docusign: docusignAdapter,
  "dropbox-sign": dropboxSignAdapter,
};

/** The shipped accreditation vendor adapters (E3.7, ADR-0055), by driver. */
export const ACCREDITATION_ADAPTERS: Readonly<
  Record<AccreditationVendorDriver, AccreditationAdapterDefinition>
> = {
  verifyinvestor: verifyInvestorAdapter,
  "parallel-markets": parallelMarketsAdapter,
};

/** Accreditation outbound client budget (E3.7 contract §3): per vendor call, redirects refused. */
export const ACCREDITATION_HTTP_TIMEOUT_MS = 15_000;
/** Response ceiling per accreditation vendor call: a 10 MiB certificate plus headroom. */
export const ACCREDITATION_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** SSO outbound client budget (E3.8): OIDC discovery/JWKS and SAML metadata, redirects refused. */
export const SSO_HTTP_TIMEOUT_MS = 5_000;
/** Response ceiling per SSO fetch (a discovery document, a JWKS or an IdP metadata file). */
export const SSO_MAX_RESPONSE_BYTES = 1024 * 1024;

/** E-sign outbound client budget (E3.5 contract §2): per vendor call, redirects refused. */
export const ESIGN_HTTP_TIMEOUT_MS = 15_000;
/** Headroom over ESIGN_MAX_ARTIFACT_BYTES for a JSON envelope around a download. */
export const ESIGN_RESPONSE_HEADROOM_BYTES = 64 * 1024;
/** The shipped integration adapters (E3.6, ADR-0054), by provider. */
export const INTEGRATION_ADAPTERS: Readonly<
  Record<IntegrationProvider, IntegrationAdapterFactory>
> = {
  quickbooks: createQuickbooksAdapter,
  xero: createXeroAdapter,
  stripe: createStripeAdapter,
  slack: createSlackAdapter,
  calendly: createCalendlyAdapter,
  calcom: createCalcomAdapter,
};

/** Per-call budget of the integrations' outbound client (E3.6 §3). */
export const INTEGRATIONS_HTTP_TIMEOUT_MS = 15_000;
/** Response ceiling per integrations vendor call (E3.6 §1: 2 MiB). */
export const INTEGRATIONS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly log: Log;
  readonly db: Database;
  readonly resolver: WorkspaceResolver;
  readonly kms: KmsPort;
  readonly envelope: EnvelopeService;
  readonly storage: ObjectStoragePort;
  /** Virus scanner and document renderer behind their ports (E1.3). */
  readonly scanner: VirusScanPort;
  readonly renderer: DocumentRenderPort;
  readonly mailer: MailerPort;
  readonly outbound: OutboundHttp;
  /** DNS for domain verification (E2.1): DoH to public IP-literal endpoints, quorum of two. */
  readonly dns: DnsResolverPort;
  /** Read-only spreadsheet access for the KPI sync (E2.4): `SPREADSHEET_DRIVER`. */
  readonly spreadsheets: SpreadsheetPort;
  /**
   * Accredited-investor verification providers (E2.5 `ACCREDITATION_DRIVER`, E3.7 vendor
   * connections): what modules see as `ModuleServices.accreditation`.
   */
  readonly accreditation: AccreditationKernel;
  /** The accreditation callback route's ingest (`routes/accreditation-callback.ts`). */
  readonly accreditationCallbacks: AccreditationCallbackIngest;
  /**
   * The accreditation vendors' own guarded outbound client (E3.7 §3): no redirects, 15 s, 12 MiB,
   * private hosts only through ACCREDITATION_ALLOW_PRIVATE_HOSTS.
   */
  readonly accreditationOutbound: OutboundHttp;
  /**
   * Staff SSO (E3.8, ADR-0056): the per-workspace OIDC/SAML connection, verified domains and the
   * login flow (`@fundroom/sso`).
   */
  readonly sso: SsoService;
  /** SCIM 2.0 provisioning (E3.8, ADR-0056): tokens, the protocol surface, group → role mapping. */
  readonly scim: ScimService;
  /**
   * The SSO client's own guarded outbound client (E3.8): no redirects, 5 s, 1 MiB, private hosts
   * only through SSO_ALLOW_PRIVATE_HOSTS.
   */
  readonly ssoOutbound: OutboundHttp;
  /** Chat webhooks for staff alerts (E2.6): Slack incoming webhooks, host-pinned. */
  readonly chat: ChatWebhookPort;
  /** The release-index check behind `GET /ops/update` (E2.9); never fetches when `UPDATE_CHECK=false`. */
  readonly updateChecker: UpdateChecker;
  /** Workspace search index (E2.8): `services.search` for every module. */
  readonly search: SearchIndexService;
  /** Mail delivery feedback (E2.6): suppression list, sent-message index, webhook ingest. */
  readonly mailFeedback: MailFeedback;
  /**
   * The hostname customers CNAME at. `CUSTOM_DOMAIN_CNAME_TARGET` when the operator set one,
   * else the canonical host: a self-hoster's edge is their own host. Resolved here rather than
   * in the config schema, which has no business deriving a host from BASE_URL.
   */
  readonly customDomainCnameTarget: string;
  /** Custom portal domains (E2.1): the admin operations behind `/api/v1/domains`. */
  readonly customDomains: CustomDomainService;
  /**
   * Hostname → workspace, for the tenant classifier and Caddy's `ask`. Host context, 60 s TTL,
   * bounded cache; the service invalidates it on every state change.
   */
  readonly customDomainLookup: CustomDomainLookup;
  readonly rateLimiter: RateLimiterPort;
  readonly audit: AuditService;
  readonly auth: AuthService;
  /** Access requests & the approval queue (E3.1): the public form's flow and the admin queue. */
  readonly accessRequests: AccessRequestService;
  /** Workspace API keys (E3.4): the bearer lookup, key lifecycle and the hourly creator sweep. */
  readonly apiKeys: ApiKeyService;
  /** Outbound webhooks (E3.4-B): endpoints, the `webhooks.fanout` subscriber, delivery jobs. */
  readonly webhooks: WebhookService;
  /**
   * E-signature (E3.5): the kernel service behind `ModuleServices.esign` and the `/esign` routes.
   * (Foundation wires an unconfigured stub; the real service replaces it.)
   */
  readonly esign: ESignKernel;
  /** The vendor callback route's ingest (`routes/esign-callback.ts`). */
  readonly esignCallbacks: ESignCallbackIngest;
  /** E-sign vendor adapters by driver: the shipped ones overlaid with `options.esignAdapters`. */
  readonly esignAdapters: Readonly<Record<ESignDriver, ESignAdapterDefinition>>;
  /**
   * The e-sign vendors' own guarded outbound client (E3.5 §2): no redirects, 15 s, artifact-sized
   * responses, private hosts only through ESIGN_ALLOW_PRIVATE_HOSTS.
   */
  readonly esignOutbound: OutboundHttp;
  /**
   * Integrations hub (E3.6): the kernel service behind `ModuleServices.integrations`, the
   * `/integrations` routes, the OAuth ops routes and the booking webhook.
   */
  readonly integrations: IntegrationsKernel;
  /**
   * The integrations' own guarded outbound client (E3.6 §3): no redirects, 15 s, 2 MiB, private
   * hosts only through INTEGRATIONS_ALLOW_PRIVATE_HOSTS.
   */
  readonly integrationsOutbound: OutboundHttp;
  /** AI assist (E3.12): the kernel service behind `ModuleServices.ai`. */
  readonly ai: AiServices;
  /** AI assist (E3.12): the whole kernel (settings, status, requests, jobs) for `routes/ai.ts`. */
  readonly aiKernel: AiKernel;
  /** External audit anchoring (E3.13, ADR-0061): the configured drivers; empty = off. */
  readonly auditAnchoring: AuditAnchoring;
  /** AI assist (E3.12): the configured model, or null when AI is unavailable on this install. */
  readonly aiModel: ModelPort | null;
  /** Authorization (E1.1): RBAC matrix + grants/gates over `effective_access`. */
  readonly authz: AuthzService;
  /** E3.13: the external relationship engine around `authz` (AUTHZ_ENGINE=openfga), else null. */
  readonly authzEngine: RelationshipEngineHandle | null;
  /**
   * The managed-host control plane (E3.10, ADR-0058): operators/workspaces/cells/signup (A) and
   * plans/usage/quotas (M). Inert unless CONTROL_PLANE=on. Plain mutable objects: tests assign
   * fakes onto them.
   */
  readonly controlPlane: ControlPlaneKernel;
  /** Subscriptions and the provider webhook (E3.10, `@fundroom/billing`). */
  readonly billing: BillingKernel;
  /** Sanctions screening of tenant companies (E3.10, `@fundroom/sanctions`). */
  readonly sanctions: SanctionsKernel;
  /**
   * The cell directory (E3.11, ADR-0059, `@fundroom/directory`): `local` without
   * DIRECTORY_DATABASE_URL (this database decides alone), `shared` with it (global slug/hostname
   * uniqueness, cross-cell routing, moves).
   */
  readonly directory: DirectoryPort;
  /** The deployment's operator-declared residency facts (E3.11: DATA_REGION*, BACKUP_LOCATION). */
  readonly residency: ResidencyKernel;
  /** The central auth origin (E3.10, CENTRAL_AUTH). */
  readonly centralAuth: CentralAuthKernel;
  /** The identity wiring, for host-level provisioning (`seed-demo`, host admin). */
  readonly identityDeps: IdentityDeps;
  /** Host-identity handoff verification (E2.2 §6): pure, stateless, no clock and no database. */
  readonly handoff: HandoffService;
  readonly queue: JobQueuePort;
  readonly subscriptions: SubscriptionRegistry;
  readonly relay: OutboxRelay;
  readonly registry: ModuleRegistry;
  readonly enablement: EnablementCache;
  /** The `ModuleServices` seam (ADR-0033) as jobs and raw routes receive it. */
  readonly moduleServices: ModuleServices;
  readonly jobs: readonly JobDefinition<JsonObject>[];
  readonly canonicalHost: string;
  readonly allowedOrigins: readonly string[];
  /** First-run state (E0.8): true until the first workspace exists. */
  readonly setupGate: SetupGate;
  /** The setup token (ADR-0018); resolved lazily so tests without a data dir never write files. */
  readonly setupToken: SetupToken;
  /**
   * The **concrete** host origins a workspace has allow-listed (E2.2), for the SSR page config
   * the postMessage bridge reads (`WebConfig.embedOrigins`).
   *
   * Not the same list as `frame-ancestors`, and deliberately so: that one is a CSP source list
   * carrying `'self'` and, when the preview toggle is on, wildcard patterns, none of which is a
   * legal `postMessage` target. `app.ts` derives the header straight from the resolved
   * workspace's settings — no query — and this exists for the one caller that has an id and not
   * a row.
   */
  embedOrigins(workspaceId: string): Promise<readonly string[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly started: boolean;
}

/**
 * The custom-domain provider for the configured driver.
 *
 * Exported so the one rule in it is testable without a database (E2.1 M12): **`manual` gets the
 * CNAME target only when the operator explicitly configured one.** `CUSTOM_DOMAIN_CNAME_TARGET`
 * defaults to the canonical host, and passing that default through made
 * `createManualProvider`'s `target === ""` branch unreachable — so a `manual` install, where
 * FundRoom issues no certificate and routing is the operator's own business, always showed a
 * CNAME row pointing at FundRoom's own hostname. That is precisely the "tell the founder to
 * break a working setup" outcome the adapter omits the row to avoid. `caddy-ask` is the opposite
 * case: it *is* the edge, so the default is exactly right and the target is required.
 */
export function createDomainProvider(
  raw: Pick<AppConfig["raw"], "CUSTOM_DOMAIN_DRIVER" | "CUSTOM_DOMAIN_CNAME_TARGET"> &
    Partial<
      Pick<AppConfig["raw"], "CLOUDFLARE_API_BASE" | "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ZONE_ID">
    >,
  cnameTarget: string,
  /**
   * E3.10: the guarded client for `cloudflare-saas` (5 s, 1 MiB, no redirects), and the shared
   * rate limiter its install-wide call budget is kept in (FR1).
   */
  cloudflare?:
    | {
        readonly fetch: OutboundHttp["fetch"];
        readonly rateLimiter?: Pick<RateLimiterPort, "hit"> | undefined;
      }
    | undefined,
): CustomDomainProviderPort {
  if (raw.CUSTOM_DOMAIN_DRIVER === "cloudflare-saas") {
    // Config refuses the driver without a token and a zone; this refuses a composition root that
    // forgot the client rather than letting the adapter fetch through something unguarded.
    if (
      cloudflare === undefined ||
      raw.CLOUDFLARE_API_BASE === undefined ||
      raw.CLOUDFLARE_API_TOKEN === undefined ||
      raw.CLOUDFLARE_ZONE_ID === undefined
    ) {
      throw new Error(
        "CUSTOM_DOMAIN_DRIVER=cloudflare-saas needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID and a guarded client",
      );
    }
    return createCloudflareSaasProvider({
      fetch: cloudflare.fetch,
      apiBase: raw.CLOUDFLARE_API_BASE,
      apiToken: raw.CLOUDFLARE_API_TOKEN,
      zoneId: raw.CLOUDFLARE_ZONE_ID,
      cnameTarget,
      rateLimiter: cloudflare.rateLimiter,
    });
  }
  if (raw.CUSTOM_DOMAIN_DRIVER === "manual") {
    // `manual` declares `requires: { cname: false, txt: true }`, so verification is TXT-only and
    // any CNAME row is genuinely advisory — which is why showing one we invented is worse than
    // showing none.
    return createManualProvider(
      raw.CUSTOM_DOMAIN_CNAME_TARGET === undefined
        ? {}
        : { cnameTarget: raw.CUSTOM_DOMAIN_CNAME_TARGET },
    );
  }
  return createCaddyAskProvider({ cnameTarget });
}

/**
 * The accredited-investor verifier for the configured driver (E2.5 decision D6).
 *
 * Exported and a function rather than an inline `??` for the reason `createDomainProvider` is:
 * the rule inside it is worth a test that needs no database. There is one driver today and the
 * `default` branch is still spelled out, because the interesting case is the *next* one — a
 * vendor bureau — and the thing that must not happen when it arrives is an unknown id silently
 * resolving to `manual`. An install that asked for a bureau and quietly got a staff queue would
 * believe it was taking reasonable steps under Rule 506(c) while taking none; config refuses the
 * unknown id first, and this refuses it again rather than guessing.
 */
export function createAccreditationProvider(
  raw: Pick<AppConfig["raw"], "ACCREDITATION_DRIVER">,
  log: Log,
): AccreditationVerificationPort {
  switch (raw.ACCREDITATION_DRIVER) {
    case "manual":
      return createManualAccreditationProvider({ log });
    default: {
      const driver: never = raw.ACCREDITATION_DRIVER;
      throw new Error(`ACCREDITATION_DRIVER=${String(driver)} has no adapter`);
    }
  }
}

/**
 * The update check (E2.9, design/07 §4.4) and the outbound agent it owns, shared by the
 * container and `fundroom doctor`.
 *
 * Its own guarded agent, on the `dnsOutbound` reasoning with an index-sized budget: 5 s, 256 KiB
 * (the parser's own cap) and **no redirects**: the guard would follow an https → http hop, which
 * turns the https-only rule on `UPDATE_CHECK_URL` into a first-hop-only rule and lets an on-path
 * attacker forge a "security update" card. A moved index is a config change, not a 301. The user agent is `FundRoom/<version>` and nothing else about the
 * install is sent. **`UPDATE_CHECK=false` builds no agent at all** — an opted-out install must
 * not even hold a connection pool pointed at the release host.
 */
export function createUpdateCheck(
  raw: Pick<
    AppConfig["raw"],
    | "UPDATE_CHECK"
    | "UPDATE_CHECK_URL"
    | "OUTBOUND_HTTP_ALLOW_PRIVATE"
    | "OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS"
  >,
  options: { readonly log: Log; readonly now?: (() => Date) | undefined },
): { readonly checker: UpdateChecker; close(): Promise<void> } {
  if (!raw.UPDATE_CHECK) {
    return {
      checker: createUpdateChecker({
        enabled: false,
        url: raw.UPDATE_CHECK_URL,
        currentVersion: SERVER_VERSION,
      }),
      close: async () => {},
    };
  }
  const outbound = createOutboundHttp({
    allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
    allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION}`,
    timeoutMs: 5_000,
    maxResponseBytes: 256 * 1024,
    maxRedirects: 0,
    log: options.log,
  });
  return {
    checker: createUpdateChecker({
      enabled: true,
      url: raw.UPDATE_CHECK_URL,
      currentVersion: SERVER_VERSION,
      http: outbound,
      clock: options.now,
      log: options.log,
    }),
    close: () => outbound.close(),
  };
}

export function createContainer(options: ContainerOptions): Container {
  const { config, logger } = options;
  const raw = config.raw;
  const log = logHook(logger, "server");
  const hook = (component: string) => logHook(logger, component);
  const now = options.now ?? (() => new Date());

  const idleError = (pool: string) => (error: Error) =>
    hook("db")("db.idle_connection_lost", {
      level: "warn",
      pool,
      code: (error as { code?: string }).code,
      error: error.message,
    });
  const activeError = (pool: string) => (error: Error) =>
    hook("db")("db.active_connection_lost", {
      level: "warn",
      pool,
      code: (error as { code?: string }).code,
      error: error.message,
    });
  /*
   * Fault bounds (E2.10, `faults.integration.test.ts`). The statement timeout is the server's;
   * these are the client's, for the failures the server cannot see — a path that stops
   * answering. Derived from DATABASE_STATEMENT_TIMEOUT_MS so one knob moves them together:
   * a query is abandoned (its connection destroyed) a grace period after the server would have
   * cancelled it, and getting a connection — a new one's handshake or a free one from an
   * exhausted pool — is bounded too. `DATABASE_STATEMENT_TIMEOUT_MS=0` turns all three off.
   */
  const statementMs = raw.DATABASE_STATEMENT_TIMEOUT_MS;
  const clientGraceMs = Math.min(5_000, Math.max(1_000, Math.floor(statementMs / 2)));
  const dbFaultBounds = {
    statementTimeoutMs: statementMs,
    clientTimeoutMs: statementMs > 0 ? statementMs + clientGraceMs : 0,
    clientTimeoutGraceMs: clientGraceMs,
    connectionTimeoutMs: statementMs > 0 ? Math.min(10_000, statementMs + clientGraceMs) : 0,
  };
  const db = createDatabase({
    connectionString: raw.DATABASE_URL,
    poolMax: raw.DATABASE_POOL_MAX,
    ...dbFaultBounds,
    onIdleError: idleError("main"),
    onActiveError: activeError("main"),
  });
  const resolver = createWorkspaceResolver(db, raw.TENANCY_MODE);
  // E3.11: the cell directory (built here: provisioning and custom domains claim through it).
  // Shared-mode migrations run at boot (server.ts), not here.
  const directory: DirectoryPort =
    options.directory ??
    (raw.DIRECTORY_DATABASE_URL === undefined
      ? createLocalDirectory({ db })
      : createSharedDirectory({
          url: raw.DIRECTORY_DATABASE_URL,
          poolMax: raw.DIRECTORY_DATABASE_POOL_MAX,
          db,
          cellId: raw.CELL_ID,
          ownerKeys: directoryOwnerKeys(config.keyRing),
          onError: (error) =>
            hook("directory")("directory.pool_error", { level: "warn", error: error.message }),
        }));

  // --- crypto ---------------------------------------------------------------------------------
  const kms = createLocalKms({ keyRing: config.keyRing });
  const envelope = createEnvelopeService({ db, kms, log: hook("crypto"), now });

  // --- storage --------------------------------------------------------------------------------
  let storage: ObjectStoragePort;
  if (raw.STORAGE_DRIVER === "s3") {
    storage = createS3Storage({
      bucket: raw.S3_BUCKET ?? "",
      region: raw.S3_REGION,
      endpoint: raw.S3_ENDPOINT,
      accessKeyId: raw.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY ?? "",
      forcePathStyle: raw.S3_FORCE_PATH_STYLE,
      log: hook("storage"),
    });
  } else {
    mkdirSync(raw.STORAGE_FS_PATH, { recursive: true });
    storage = createFsStorage({ root: raw.STORAGE_FS_PATH, log: hook("storage") });
  }

  // --- scanning + rendering (E1.3) -----------------------------------------------------------
  const scanner: VirusScanPort =
    raw.AV_DRIVER === "clamd"
      ? createClamdScanner({
          host: raw.CLAMD_HOST ?? "",
          port: raw.CLAMD_PORT,
          timeoutMs: raw.CLAMD_TIMEOUT_MS,
          log: hook("avscan"),
        })
      : createNoopScanner({ log: hook("avscan") });
  const renderer = createPdfiumRenderer({
    log: hook("render"),
    maxInputBytes: raw.RENDER_MAX_BYTES,
  });

  // --- mail -----------------------------------------------------------------------------------
  /*
   * ESP-native drivers (E2.6). Each gets its own guarded outbound instance, deliberately not the
   * general-purpose `outbound` one: the request carries the provider's API key, so it must never
   * follow a redirect (a redirect is the one way that key reaches a host the provider did not
   * name), and its budget (10 s, 1 MiB) is the provider API's, not the logo importer's. The same
   * instance fetches SES's SNS signing certificate and confirms SNS subscriptions — both pinned
   * to `sns.<region>.amazonaws.com` by the adapter. Built only when an ESP driver is selected.
   */
  let mailOutbound: OutboundHttp | undefined;
  const createEspMailer = (): MailerPort => {
    const guarded = createOutboundHttp({
      allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
      allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
      userAgent: `FundRoom/${SERVER_VERSION}`,
      timeoutMs: 10_000,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: 0,
      log: hook("mail"),
    });
    mailOutbound = guarded;
    const required = (key: string, value: string | undefined): string => {
      if (value === undefined) {
        throw new Error(`${key} is required for MAILER_DRIVER=${raw.MAILER_DRIVER}`);
      }
      return value;
    };
    const from = {
      address: required("MAIL_FROM", raw.MAIL_FROM),
      name: raw.MAIL_FROM_NAME,
    };
    const common = { from, fetch: guarded.fetch, log: hook("mail"), now };
    switch (raw.MAILER_DRIVER) {
      case "resend":
        return createResendMailer({
          ...common,
          apiKey: required("RESEND_API_KEY", raw.RESEND_API_KEY),
          webhookSecret: raw.RESEND_WEBHOOK_SECRET,
        });
      case "postmark":
        return createPostmarkMailer({
          ...common,
          serverToken: required("POSTMARK_SERVER_TOKEN", raw.POSTMARK_SERVER_TOKEN),
          broadcastStream: raw.POSTMARK_BROADCAST_STREAM,
          webhookBasicAuth:
            raw.POSTMARK_WEBHOOK_USER !== undefined && raw.POSTMARK_WEBHOOK_PASSWORD !== undefined
              ? { user: raw.POSTMARK_WEBHOOK_USER, password: raw.POSTMARK_WEBHOOK_PASSWORD }
              : undefined,
        });
      case "ses":
        return createSesMailer({
          ...common,
          region: required("AWS_REGION", raw.AWS_REGION),
          accessKeyId: required("AWS_ACCESS_KEY_ID", raw.AWS_ACCESS_KEY_ID),
          secretAccessKey: required("AWS_SECRET_ACCESS_KEY", raw.AWS_SECRET_ACCESS_KEY),
          sessionToken: raw.AWS_SESSION_TOKEN,
          configurationSet: raw.SES_CONFIGURATION_SET,
          allowedTopicArns: raw.SES_SNS_TOPIC_ARNS,
        });
      default:
        throw new Error(`MAILER_DRIVER=${raw.MAILER_DRIVER} has no ESP adapter`);
    }
  };
  let mailer: MailerPort;
  if (options.mailer) {
    mailer = options.mailer;
  } else if (raw.MAILER_DRIVER === "smtp" && raw.SMTP_URL !== undefined) {
    mailer = createSmtpMailer({
      url: raw.SMTP_URL,
      from: {
        address:
          raw.MAIL_FROM ?? `no-reply@${canonicalHostOf(config.baseUrl).replace(/:\d+$/u, "")}`,
        name: raw.MAIL_FROM_NAME,
      },
      log: hook("mail"),
      now,
    });
  } else if (raw.MAILER_DRIVER !== "smtp") {
    mailer = createEspMailer();
  } else if (config.appEnv === "dev" || config.appEnv === "test") {
    log("mail.log_mailer", {
      level: "warn",
      reason:
        "SMTP_URL is unset; emails (including sign-in codes) are written to the log. Dev/test only.",
    });
    mailer = createLogMailer({ log: hook("mail") });
  } else {
    throw new Error("SMTP_URL is required outside dev/test (config should have caught this)");
  }
  /*
   * Per-workspace email branding (E1.7).
   *
   * The resolver is async on purpose (and `TemplatedMailerOptions.brand` accepts that): a
   * synchronous one could only read an in-memory cache, so the first email after every restart
   * would go out unbranded while every later one looked right — the worst kind of bug, because
   * it is invisible in dev and intermittent in production. The cache below is a cost control,
   * not the source of truth: a minute of staleness after a brand change is fine, and a failure
   * to resolve falls back to the instance brand rather than holding up a sign-in code.
   */
  const brandDefault: EmailBrand = { productName: raw.INSTANCE_NAME };
  const brandUrls = {
    baseUrl: config.baseUrl,
    tenancy: raw.TENANCY_MODE,
    basePath: config.basePath,
  };
  const BRAND_TTL_MS = 60_000;
  /** Ceiling so a host with many workspaces cannot grow this map without bound. */
  const BRAND_CACHE_MAX = 1_000;
  const brandCache = new Map<string, { value: EmailBrand; until: number }>();
  const brandFor = async (message: OutboundEmail): Promise<EmailBrand> => {
    const id = message.workspaceId;
    // Instance-level mail (operator alerts, a sign-in to no workspace in particular) has none.
    if (id === undefined) return brandDefault;
    const t = now().getTime();
    const hit = brandCache.get(id);
    if (hit !== undefined && hit.until > t) return hit.value;
    const workspace = await findWorkspaceById(db, id);
    const value =
      workspace === undefined
        ? brandDefault
        : emailBrandOf(brandUrls, workspace, raw.INSTANCE_NAME);
    if (brandCache.size >= BRAND_CACHE_MAX) brandCache.clear();
    brandCache.set(id, { value, until: t + BRAND_TTL_MS });
    return value;
  };
  mailer = createTemplatedMailer(mailer, {
    brand: brandFor,
    defaultBrand: brandDefault,
    log: hook("mail"),
  });

  // --- outbound HTTP --------------------------------------------------------------------------
  const outbound = createOutboundHttp({
    allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
    allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION}`,
    log: hook("outbound"),
  });

  const canonicalHost = canonicalHostOf(config.baseUrl);

  // --- DNS over HTTPS (E2.1) ------------------------------------------------------------------
  // Its own guarded agent, deliberately not the general-purpose `outbound` one (contract §1.2):
  // a resolver's budget is a 2 s answer of at most 64 KiB and never a redirect, where the logo
  // importer's is 5 s and 1 MiB. Sharing the instance would lend a DNS lookup — which sits on the
  // verify job and on an admin clicking "Verify now" — the importer's patience.
  const dnsOutbound = createOutboundHttp({
    allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
    allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION}`,
    timeoutMs: 2_000,
    maxResponseBytes: 64 * 1024,
    maxRedirects: 0,
    log: hook("dns"),
  });
  const dns =
    options.dns ??
    createDohResolver({
      fetch: dnsOutbound.fetch,
      ...(raw.DOH_ENDPOINTS === undefined ? {} : { endpoints: raw.DOH_ENDPOINTS }),
      log: hook("dns"),
    });

  // --- spreadsheets (E2.4) --------------------------------------------------------------------
  /*
   * Its own guarded agent for the same reason `dnsOutbound` has one, with the opposite budget: a
   * sheet read is a slower, fatter call than a webhook (10 s, 2 MiB) and it must never follow a
   * redirect, because the request carries a bearer token and a redirect is the one way that token
   * reaches a host Google did not name. Sharing the general-purpose instance would either starve
   * the read at 5 s / 1 MiB or lend every webhook this one's patience.
   *
   * Built only for the real driver: `SPREADSHEET_DRIVER=noop` must leave no connection pool
   * behind, which is half of what an operator means by switching the integration off.
   */
  let sheetsOutbound: OutboundHttp | undefined;
  const createSpreadsheets = (): SpreadsheetPort => {
    if (raw.SPREADSHEET_DRIVER === "noop") return createNoopSpreadsheets();
    sheetsOutbound = createOutboundHttp({
      allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
      allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
      userAgent: `FundRoom/${SERVER_VERSION}`,
      timeoutMs: 10_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
      log: hook("sheets"),
    });
    return createGoogleSheetsAdapter({ fetch: sheetsOutbound.fetch, log: hook("sheets") });
  };
  const spreadsheets = options.spreadsheets ?? createSpreadsheets();

  // --- chat webhooks (E2.6) ------------------------------------------------------------------
  /*
   * Its own guarded agent, on the `dnsOutbound` reasoning with a chat-sized budget: a webhook post
   * answers in well under 5 s with a two-byte `ok`, and it must never follow a redirect — the URL
   * is a bearer credential an admin pasted, and a redirect is the one way a post (and its alert
   * text) reaches a host Slack did not name. The adapter pins `hooks.slack.com` as well.
   */
  let chatOutbound: OutboundHttp | undefined;
  const createChat = (): ChatWebhookPort => {
    chatOutbound = createOutboundHttp({
      allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
      allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
      userAgent: `FundRoom/${SERVER_VERSION}`,
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      maxRedirects: 0,
      log: hook("chat"),
    });
    return createSlackChat({ fetch: chatOutbound.fetch, now });
  };
  const chat = options.chat ?? createChat();

  // --- update check (E2.9) --------------------------------------------------------------------
  const updateCheck = createUpdateCheck(raw, { log: hook("update_check"), now });

  // --- accreditation verification (E2.5; the E3.7 vendor service is built after `audit`) -------
  const accreditationManual =
    options.accreditation ?? createAccreditationProvider(raw, hook("accreditation"));

  // --- audit + events -------------------------------------------------------------------------
  const sinks = options.auditSinks ?? [];
  // E3.4-A: every entry written while an API key request runs carries `meta.apiKeyId` (the
  // request's async context; see `api-key-context.ts`). A pass-through everywhere else.
  const audit = withApiKeyAudit(
    createAuditService({
      db,
      truncateIp: raw.AUDIT_IP_TRUNCATE,
      now,
      log: hook("audit"),
      ...(sinks.length > 0
        ? {
            onRecorded: async (tx, ctx, record) => {
              // Platform-chain rows live in a pseudo-workspace that has no core.workspace row, so
              // they cannot ride the outbox (FK + fence); sinks receive tenant chains only for now.
              if (isPlatformWorkspace(ctx.workspaceId)) return;
              await publish(tx, ctx, "audit.recorded", { eventId: record.id, seq: record.seq });
            },
          }
        : {}),
    }),
  );

  const modules = createModuleRegistry(options.modules ?? [], { only: config.modules });
  const subscriptions = createSubscriptionRegistry();
  for (const sub of modules.subscriptions) {
    // E3.4 fix round 1 (D1): a module's erasure handler may be the one whose report runs the
    // kernel's identity step, and some audit before they report — so the member's API key rows
    // are locked at the start of the transaction, before anything takes the audit chain.
    const handler: typeof sub.handler =
      sub.topic === "member.erasure_requested"
        ? async (event, sc) => {
            const { membershipId } = event.payload as { membershipId?: unknown };
            if (sc.ctx.actorKind !== "host" && typeof membershipId === "string")
              await prelockIdentityErasure(sc.ctx as TenantContext, sc.tx, membershipId);
            return sub.handler(event, sc);
          }
        : sub.handler;
    subscriptions.subscribe(sub.topic, sub.id, handler);
  }

  // --- authorization --------------------------------------------------------------------------
  // E3.13: AUTHZ_ENGINE=openfga wraps it (shadow/enforce); the queue is read lazily (built below).
  const authzWiring = createAuthzEngineWiring({
    raw,
    db,
    pg: createAuthzService({
      db,
      permissionCatalogue: () => modules.permissions.keys(),
      resourceKinds: modules.resourceKinds,
      now,
      log: hook("authz"),
    }),
    queue: () => queue,
    log: hook("authz"),
    now,
    resourceKinds: () => Object.keys(modules.resourceKinds),
  });
  const authz = authzWiring.authz;
  for (const sub of authz.subscriptions) subscriptions.subscribe(sub.topic, sub.id, sub.handler);
  if (sinks.length > 0) {
    subscriptions.subscribe("audit.recorded", "audit.sink_fanout", async (event, { tx, ctx }) => {
      if (ctx.actorKind === "host") return;
      const row = await findEventById(
        tx,
        (ctx as TenantContext).workspaceId,
        event.payload.eventId,
      );
      if (row === undefined) return;
      const record = toAuditRecord(row);
      for (const sink of sinks) await sink.deliver([record]);
    });
  }

  // --- share links (E2.3) ----------------------------------------------------------------------
  /*
   * One service, wired into two places that must not know about each other.
   *
   * `identityDeps.shareLinks` is the structural `ShareLinkAccess` seam (contract S2): identity
   * declares the two questions it needs answered — may this address in, and what did the link
   * promise — and `@fundroom/share-links` implements them. The dependency runs share-links →
   * identity (for `randomToken`, `sha256`, `hashCode`), never the other way, because the kernel's
   * login path must not depend on an epic's feature package. The compiler checks the two halves
   * match here, at the one place that imports both.
   *
   * The `document.viewed` subscription below is the other half, and it shares this instance.
   * `routes/links.ts` builds its own from `ApiDeps` rather than receiving this one — the service
   * holds no mutable state worth sharing now that "which sessions have been counted" is a row in
   * `core.share_link_view` rather than a set in a process.
   */
  const shareLinks = createShareLinkService({
    audit,
    keyRing: config.keyRing,
    // Contract S3/B10: a grant naming a resource kind no module registered can never be satisfied
    // by anybody, so it is refused at mint time rather than written as a grant that silently
    // grants nothing. Read lazily — `modules` is merged above, but keeping the thunk means a test
    // container that swaps the registry does not need this rebuilt.
    resourceKinds: () => Object.keys(modules.resourceKinds),
    now,
    log: hook("share-links"),
  });

  /*
   * A share link's view budget counts *distinct view sessions*, not requests (design/05 §4.4),
   * and it is driven off the outbox rather than from the data room.
   *
   * The data room already publishes `document.viewed` with `{ documentId, versionId,
   * membershipId, sessionId }` — it carries a session identity, which is the fact that makes this
   * possible — and a module has no business knowing that share links exist. Subscribing here
   * keeps the direction right: the module states what happened, the kernel decides what it costs.
   *
   * Two things are worth knowing about this handler:
   *
   *  - It needs the links the viewer was admitted through, and the event does not carry them.
   *    `PrincipalRepo.byId` is the only reader of that edge outside `@fundroom/share-links`'s own
   *    repository, and it lists the workspace's active principals to answer. That is a real cost
   *    per view event, off the request path but not free; the cheap fix is a
   *    `linksFor(membershipId)` statement in `ShareLinkRepo`, which that package owns.
   *  - A viewer holding two links spends a view on **both**, because nothing here can say which
   *    link granted the document (it may have come through a group the link applied). That
   *    over-counts, which reaches a budget sooner rather than later — the same direction every
   *    other approximation in this epic errs in.
   *
   * A view with no session is skipped: `noteView` dedupes on `(link, membership, session)` and a
   * null session cannot be deduped, so counting it would spend the whole budget on one reload.
   */
  subscriptions.subscribe(
    "document.viewed",
    "share-links.note-view",
    async (event, { tx, ctx }) => {
      if (ctx.actorKind === "host") return;
      const { membershipId, sessionId } = event.payload;
      if (typeof membershipId !== "string" || typeof sessionId !== "string") return;
      const tenant = ctx as TenantContext;
      const principal = await new PrincipalRepo(tenant, tx).byId(membershipId);
      for (const linkId of principal?.linkIds ?? []) {
        await shareLinks.noteView(tenant, tx, linkId, membershipId, sessionId);
      }
    },
  );

  // --- mail feedback (E2.6) ------------------------------------------------------------------
  /*
   * The outermost mail decorator, applied after the driver and the templating above and before
   * anything receives `mailer`: suppression is checked (broadcast/notification only) before a
   * template is rendered or a provider called, and every accepted message sent on behalf of a
   * workspace leaves a `core.mail_message` row for its webhooks to find. `allowsTracking` is the
   * same legal port modules get, so the consent fold is written once.
   */
  const legalForMail = createLegalPort({ db, audit, bookingSuppressionKeys: envelope });
  /*
   * The send path's own small pool: suppression lookups and `core.mail_message` writes run
   * inside senders that may hold a main-pool connection in their own transaction, so on the
   * main pool N concurrent senders could exhaust it and wait on each other forever. Rationale in
   * `mail/feedback.ts` ("The send path and the pool"). Costs `MAIL_SEND_POOL_MAX` extra
   * connections per process.
   */
  const MAIL_SEND_POOL_MAX = 4;
  const mailDb = createDatabase({
    connectionString: raw.DATABASE_URL,
    poolMax: MAIL_SEND_POOL_MAX,
    ...dbFaultBounds,
    onIdleError: idleError("mail"),
    onActiveError: activeError("mail"),
  });
  const mailFeedback = createMailFeedback({
    db,
    sendDb: mailDb,
    // E3.9 FR1 B8: when BASE_URL is a path mount its origin is the host site's, so only URLs
    // under BASE_URL are ours; otherwise the whole origin, as before.
    ownOrigins: (workspace) => {
      const own = workspaceUrl(
        config.baseUrl,
        raw.TENANCY_MODE,
        workspace,
        "/",
        config.basePath,
      ).origin;
      return [
        baseUrlIsMount(config.baseUrl, config.pathMounts)
          ? canonicalBaseOf(config.baseUrl)
          : config.baseUrl.origin,
        // The workspace's own host (custom domain / tenant subdomain), when it is another one.
        ...(own === config.baseUrl.origin ? [] : [own]),
      ];
    },
    envelope,
    audit,
    allowsTracking: (tx, ctx, membershipId) =>
      legalForMail.allowsPurpose(tx, ctx, membershipId, "email_tracking"),
    now,
    log: hook("mail"),
  });
  mailer = createKernelMailer(mailer, mailFeedback, hook("mail"));

  // --- identity -------------------------------------------------------------------------------
  // RATE_LIMIT_MULTIPLIER scales every ceiling at the one choke point every caller shares
  // (kernel routes, identity services, module services); config refuses ≠1 in prod.
  const rateLimiter = createPostgresRateLimiter(db, {
    now,
    multiplier: raw.RATE_LIMIT_MULTIPLIER,
  });
  const passkeyRpId = raw.PASSKEY_RP_ID ?? config.baseUrl.hostname;
  const identityDeps: IdentityDeps = {
    db,
    keyRing: config.keyRing,
    mailer,
    rateLimiter,
    audit,
    shareLinks: createShareLinkAccess(shareLinks),
    // E3.1: accepting an approved access request's invite records the relationship the approver
    // attested (audited as `membership.relationship_recorded`) in the acceptance transaction.
    relationships: createRelationshipService({ db, audit }),
    // E3.10: seat quotas, through the same forwarder as `ModuleServices.quota` (called only at
    // request time, after `controlPlane` below exists).
    quota: { check: (tx, input) => controlPlane.usage.quota.check(tx, input) },
    baseUrl: config.baseUrl,
    productName: raw.INSTANCE_NAME,
    now,
    log: hook("identity"),
  };
  const auth = createAuthService(identityDeps, {
    passkeys: {
      rpId: passkeyRpId,
      rpName: raw.PASSKEY_RP_NAME,
      origins: [config.baseUrl.origin],
    },
    password: {
      enabled: raw.AUTH_PASSWORD_ENABLED,
      breachCheck: {
        enabled: raw.AUTH_HIBP_CHECK,
        fetch: outbound.fetch,
        // F-21: open (default) accepts unchecked, closed refuses with breach_check_unavailable;
        // both audit the skip, and both count a security event here.
        failMode: raw.AUTH_HIBP_FAIL_MODE,
        onUnavailable: ({ failMode }) =>
          countSecurityEvent("breach_check_unavailable", "breach_check_unavailable", failMode),
      },
    },
    ...(raw.OIDC_ISSUER_URL !== undefined && raw.OIDC_CLIENT_ID !== undefined
      ? {
          oidc: {
            providers: {
              sso: {
                issuer: raw.OIDC_ISSUER_URL,
                clientId: raw.OIDC_CLIENT_ID,
                clientSecret: raw.OIDC_CLIENT_SECRET,
                trustEmail: raw.OIDC_TRUST_EMAIL,
                allowedDomains: raw.OIDC_ALLOWED_DOMAINS,
                trustMfa: raw.OIDC_TRUST_MFA,
                mfaAcrValues: raw.OIDC_MFA_ACR,
              },
            },
            fetch: outbound.fetch,
          },
        }
      : {}),
  });

  // --- custom portal domains (E2.1) -----------------------------------------------------------
  /*
   * The hostname a workspace's portal answers on. Four pieces, in dependency order:
   *
   *  - the **provider**, chosen from `CUSTOM_DOMAIN_DRIVER`. `caddy-ask` is the default and its
   *    `activate`/`deactivate` are no-ops, because the `ask` endpoint *is* the mechanism;
   *    `manual` verifies ownership and leaves TLS to the operator's own proxy.
   *  - the **lookup**, which answers `ask` and the tenant classifier out of a bounded 60-second
   *    cache in HOST context (there is no workspace yet — that is the question).
   *  - the **service**, which owns the admin operations in TENANT context and invalidates both
   *    caches after every commit. The `workspaces` cache matters as much as its own: the
   *    single-tenant resolver holds the whole `ResolvedWorkspace` for 30 s, and `primaryHost` now
   *    lives inside it, so a missed invalidate serves a stale origin (E2.1 §6.5).
   *  - the two **sweeps**, spread into `jobs` below.
   */
  const customDomainCnameTarget = raw.CUSTOM_DOMAIN_CNAME_TARGET ?? canonicalHost;
  /*
   * Cloudflare for SaaS (E3.10): its own guarded agent — 5 s and 1 MiB per call, no redirects (the
   * API never redirects, and a redirect is how a token-bearing request reaches a host nobody
   * named). Private hosts only from OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS (a local fake in tests).
   */
  const cloudflareOutbound =
    raw.CUSTOM_DOMAIN_DRIVER === "cloudflare-saas"
      ? createOutboundHttp({
          allowPrivate: false,
          allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
          userAgent: `FundRoom/${SERVER_VERSION} (+domains)`,
          timeoutMs: 5_000,
          maxResponseBytes: 1024 * 1024,
          maxConcurrentLookups: 4,
          maxRedirects: 0,
          log: hook("domains"),
        })
      : undefined;
  const domainProvider = createDomainProvider(
    raw,
    customDomainCnameTarget,
    cloudflareOutbound === undefined ? undefined : { fetch: cloudflareOutbound.fetch, rateLimiter },
  );
  /*
   * `dns_ok → active` (E2.1 S2). `active` is what `primaryHost` — and therefore every emailed
   * link, `canonicalOrigin` and `brandingLogoUrl` — keys off, so it has to mean "the edge is
   * serving on this hostname", not "DNS looked right twice". The only place that fact is
   * observable is the request path: the classifier routed a live request through the hostname, so
   * the TLS handshake completed and a certificate exists.
   *
   * Late-bound because the lookup and the service each need the other: the service invalidates
   * the lookup's cache, the lookup asks the service to promote. Fire-and-forget, throttled to
   * once per host per 60-second cache entry by the lookup itself, and a failure here can never
   * fail the request it rode in on.
   */
  let promoteServing: (workspaceId: string, id: string) => void = () => {};
  const customDomainLookup = createCustomDomainLookup({
    db,
    now,
    log: hook("domains"),
    onServed: (domain) => promoteServing(domain.workspaceId, domain.id),
  });
  const customDomains = createCustomDomainService({
    db,
    audit,
    // E3.10 `customDomains` quota; the forwarder is only called at request time.
    quota: { check: (tx, input) => controlPlane.usage.quota.check(tx, input) },
    // E3.10 FR1: provider releases go through the outbox (`domains.provider-release`). Late-bound
    // like the quota: the queue is built further down and only called at request/job time.
    queue: { sendInTransaction: (tx, name, data, o) => queue.sendInTransaction(tx, name, data, o) },
    resolver: dns,
    provider: domainProvider,
    // E3.11: verified hostnames are claimed across cells in the cell directory.
    directory,
    // E3.11 RR1-8: a claim refused for want of an entry repairs it once (what the sweep does).
    repairEntry: async (workspaceId) => {
      if (isSharedDirectory(directory)) await repairWorkspaceEntry(db, directory, workspaceId);
    },
    caches: {
      lookup: customDomainLookup,
      // The single-tenant `ResolvedWorkspace` cache, which now carries `primaryHost`.
      workspaces: { invalidate: () => resolver.invalidate() },
    },
    canonicalHost,
    cnameTarget: customDomainCnameTarget,
    // Optional override only (E2.1 S1). Unset — which is the normal case — the verifier resolves
    // the CNAME target's own A/AAAA through the same DoH resolvers and accepts an apex whose
    // addresses intersect, so apex domains work with no configuration and keep working when the
    // edge moves. The override exists for an edge on stable anycast addresses its own DNS does
    // not name; it is used *instead* of resolving the target.
    ...(raw.CUSTOM_DOMAIN_EDGE_ADDRESSES === undefined
      ? {}
      : { edgeAddresses: raw.CUSTOM_DOMAIN_EDGE_ADDRESSES }),
    // Its own sub-key, like every other secret-bearing operation in the kernel (HKDF-SHA256 with
    // a fixed purpose label): the challenge token is an HMAC an attacker can see the output of,
    // so it must not be computed under the ring key itself. Rotating the ring invalidates every
    // outstanding challenge, which is the honest consequence and costs one "Verify now" click.
    tokenKey: new Uint8Array(
      hkdfSync(
        "sha256",
        config.keyRing.current.key,
        new Uint8Array(0),
        "seed-host/custom-domains/challenge-token/v1",
        32,
      ),
    ),
    now,
    log: hook("domains"),
  });
  // Closes the loop opened above. `systemContext` because the promotion is not any admin's
  // action: the request that triggered it may have been an anonymous investor's first page load.
  promoteServing = (workspaceId, id) => {
    void customDomains.markServing(systemContext(workspaceId), id).catch((error: unknown) => {
      hook("domains")("domains.promote_failed", {
        level: "warn",
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // --- jobs -----------------------------------------------------------------------------------
  const queue = createPgBossQueue({
    pool: db.pool,
    pollIntervalMs: raw.JOBS_POLL_INTERVAL_MS,
    // Handlers run on this pool, so no queue runs more of them at once than it has connections
    // (WORKER_CONCURRENCY and a job's own `work.concurrency` are capped here).
    maxConcurrency: raw.DATABASE_POOL_MAX,
    // E-UP-10: the start-up grant is one query on `db.pool`, which the client abandons at
    // `clientTimeoutMs`; both of its lock waits must end first, so its lock-timeout error (which
    // names the lock) is what surfaces, not a bare client timeout.
    grantLockTimeoutMs: grantLockTimeoutWithin({
      clientTimeoutMs: dbFaultBounds.clientTimeoutMs,
      graceMs: dbFaultBounds.clientTimeoutGraceMs,
    }),
    log: hook("jobs"),
  });
  const relay = createOutboxRelay({
    db,
    queue,
    subscriptions,
    pollIntervalMs: raw.OUTBOX_POLL_INTERVAL_MS,
    now,
    log: hook("outbox"),
  });
  const enablement = createEnablementCache(modules);
  const search = createSearchIndex({ queue, now });
  // --- e-signature (E3.5) -----------------------------------------------------------------------
  /*
   * Its own guarded agent, on the webhooks reasoning: a self-hosted vendor's base URL is chosen by
   * a workspace admin, so the client never inherits the operator's OUTBOUND_HTTP_ALLOW_PRIVATE
   * [_HOSTS] — only ESIGN_ALLOW_PRIVATE_HOSTS — and follows no redirect (a redirect is how a
   * credential-bearing request reaches a host nobody named). Responses may be a signed PDF, so
   * the ceiling is the artifact limit plus headroom.
   */
  const esignOutbound = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: raw.ESIGN_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION} (+esign)`,
    timeoutMs: ESIGN_HTTP_TIMEOUT_MS,
    maxResponseBytes: raw.ESIGN_MAX_ARTIFACT_BYTES + ESIGN_RESPONSE_HEADROOM_BYTES,
    maxConcurrentLookups: WEBHOOK_WORKER_CONCURRENCY,
    maxRedirects: 0,
    log: hook("esign"),
  });
  const esignAdapters: Readonly<Record<ESignDriver, ESignAdapterDefinition>> = {
    ...ESIGN_ADAPTERS,
    ...options.esignAdapters,
  };
  /*
   * The kernel e-sign service (C1): connection, envelopes, the NDA ceremony, callback ingestion and
   * its jobs. Vendor calls go through `esignOutbound` only, and always outside a transaction. An
   * NDA envelope's completion records the acceptance through the same compliance service the
   * click-wrap routes use (method `esign`, no click-wrap certificate), and the late-writer check
   * is the legal port's `isErased`.
   */
  const esign: ESignKernel = createESignService({
    db,
    audit,
    queue,
    crypto: envelope,
    storage,
    scanner,
    outbound: esignOutbound,
    adapters: esignAdapters,
    drivers: raw.ESIGN_DRIVERS,
    acceptances: createAcceptanceService({ db, audit }),
    legal: legalForMail,
    baseUrl: config.baseUrl,
    // BASE_URL (its path included, E3.9 §2): the ops route is mounted under the base.
    callbackUrl: (connectionId) => esignCallbackUrl(config.baseUrl, connectionId),
    maxArtifactBytes: raw.ESIGN_MAX_ARTIFACT_BYTES,
    securityEvent: (event) => countSecurityEvent(event, event),
    now,
    log: hook("esign"),
  });
  // The vendor callback route's view of `ingestCallback`: an unknown connection is the same 401
  // as a bad signature (no oracle for which connection ids exist).
  const esignCallbacks: ESignCallbackIngest = async (connectionId, request, { admit }) => {
    const r = await esign.ingestCallback(connectionId, request, { admit });
    if (r.driver === undefined || (r.status !== 200 && r.status !== 429)) return { status: 401 };
    return { status: r.status, driver: r.driver };
  };
  // `document.vaulted` (data-room, E3.5 §7) → `vaulted_document_id` on the envelope, in the
  // relay's transaction (envelope row lock first).
  subscriptions.subscribe("document.vaulted", "esign.document-vaulted", async (event, sc) => {
    if (sc.ctx.actorKind === "host") return;
    await esign.onDocumentVaulted(sc.tx, sc.ctx as TenantContext, event.payload);
  });
  // --- accreditation vendors (E3.7) --------------------------------------------------------------
  /*
   * Its own guarded agent, on the esign reasoning: never inherits OUTBOUND_HTTP_ALLOW_PRIVATE
   * [_HOSTS] (only ACCREDITATION_ALLOW_PRIVATE_HOSTS, for tests and an operator's egress proxy),
   * follows no redirect (a redirect is how a credential-bearing request reaches a host nobody
   * named), 15 s per call, and a response ceiling sized for a certificate PDF.
   */
  const accreditationOutbound = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: raw.ACCREDITATION_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION} (+accreditation)`,
    timeoutMs: ACCREDITATION_HTTP_TIMEOUT_MS,
    maxResponseBytes: ACCREDITATION_MAX_RESPONSE_BYTES,
    maxConcurrentLookups: 8,
    maxRedirects: 0,
    log: hook("accreditation"),
  });
  const accreditationAdapters: Readonly<
    Partial<Record<AccreditationVendorDriver, AccreditationAdapterDefinition>>
  > = {
    ...ACCREDITATION_ADAPTERS,
    ...options.accreditationAdapters,
  };
  /*
   * The kernel accreditation service (E3.7, ADR-0055): the per-workspace vendor connection, what
   * modules see as `ModuleServices.accreditation` (manual when a workspace has no live connection)
   * and the callback wake-up. Vendor calls go through `accreditationOutbound` only, and always
   * outside a transaction.
   */
  const accreditation: AccreditationKernel = createAccreditationService({
    db,
    audit,
    crypto: envelope,
    fetch: accreditationOutbound.fetch as typeof fetch,
    adapters: accreditationAdapters,
    drivers: raw.ACCREDITATION_DRIVERS,
    apiBaseUrls: options.accreditationApiBaseUrls,
    manualRequires: accreditationManual.requires,
    // BASE_URL (its path included, E3.9 §2): the ops route is mounted under the base.
    callbackUrl: (connectionId) => accreditationCallbackUrl(config.baseUrl, connectionId),
    now,
    log: hook("accreditation"),
  });
  // The callback route's view of `ingestCallback`: an unknown connection is the same 401 as a bad
  // signature (no oracle for which connection ids exist).
  const accreditationCallbacks: AccreditationCallbackIngest = async (
    connectionId,
    request,
    { admit },
  ) => {
    const r = await accreditation.ingestCallback(connectionId, request, { admit });
    if (r.driver === undefined || (r.status !== 200 && r.status !== 429)) return { status: 401 };
    return { status: r.status, driver: r.driver };
  };
  // --- staff SSO + SCIM (E3.8, ADR-0056) ----------------------------------------------------------
  /*
   * Its own guarded agent, on the esign reasoning: never inherits OUTBOUND_HTTP_ALLOW_PRIVATE
   * [_HOSTS] (only SSO_ALLOW_PRIVATE_HOSTS, for tests and an IdP on the LAN), follows no redirect
   * (issuer and metadata URLs are tenant-chosen; a redirect is how a fetch reaches a host nobody
   * named), 5 s and 1 MiB per call — a discovery document, a JWKS or an IdP metadata file.
   */
  const ssoOutbound = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: raw.SSO_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION} (+sso)`,
    timeoutMs: SSO_HTTP_TIMEOUT_MS,
    maxResponseBytes: SSO_MAX_RESPONSE_BYTES,
    maxConcurrentLookups: 8,
    maxRedirects: 0,
    log: hook("sso"),
  });
  // E3.8 A owns: the SSO service construction below.
  const sso: SsoService = createSsoService({
    db,
    audit,
    crypto: envelope,
    dns,
    fetch: ssoOutbound.fetch as typeof fetch,
    protocols: raw.SSO_PROTOCOLS,
    baseUrl: config.baseUrl,
    basePath: config.basePath,
    // The same hosts the guarded agent admits may also speak plain http (a LAN IdP, tests).
    insecureHosts: raw.SSO_ALLOW_PRIVATE_HOSTS ?? [],
    // The login flow mints sessions through identity's single login path (`completeLogin`),
    // provisions JIT members through `provisionStaff`, and revokes a deleted connection's sessions.
    identity: { deps: identityDeps, sessions: auth.sessions, memberships: auth.memberships },
    resolver,
    canManage: (m) => authz.hasPermission(m, "sso.manage"),
    now,
    log: hook("sso"),
  });
  // E3.8 C owns: the SCIM service construction below. Memberships are identity's (B's
  // provisionStaff / suspend / unsuspend / update / revoke with the `scim:<tokenId>` system actor).
  const scim: ScimService = createScimService({
    db,
    audit,
    sso,
    memberships: auth.memberships,
    enabled: raw.SCIM_ENABLED,
    baseUrl: config.baseUrl,
    now,
    log: hook("scim"),
  });
  // --- integrations hub (E3.6) -------------------------------------------------------------------
  /*
   * Its own guarded agent, on the esign reasoning: never inherits OUTBOUND_HTTP_ALLOW_PRIVATE
   * [_HOSTS] (only INTEGRATIONS_ALLOW_PRIVATE_HOSTS, for tests), follows no redirect (a redirect is
   * how a token-bearing request reaches a host nobody named), 15 s and 2 MiB per call.
   */
  const integrationsOutbound = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: raw.INTEGRATIONS_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION} (+integrations)`,
    timeoutMs: INTEGRATIONS_HTTP_TIMEOUT_MS,
    maxResponseBytes: INTEGRATIONS_MAX_RESPONSE_BYTES,
    maxConcurrentLookups: 8,
    maxRedirects: 0,
    log: hook("integrations"),
  });
  /*
   * The kernel integrations hub (E3.6): connections, the OAuth handshake, token refresh, health,
   * booking links and the booking webhook. Adapters are built once on `integrationsOutbound` (the
   * only client that ever carries a vendor token); a test replaces a provider's factory through
   * `integrationAdapters`, the only place an adapter's base-URL override may come from. An OAuth
   * provider is offered only when the operator configured its client (both halves of the pair).
   */
  const integrationAdapterDeps = {
    fetch: integrationsOutbound.fetch,
    now,
    log: hook("integrations"),
  };
  const integrationFactories: Record<IntegrationProvider, IntegrationAdapterFactory> = {
    ...INTEGRATION_ADAPTERS,
    ...(options.integrationAdapters ?? {}),
  };
  const builtIntegrationAdapters: Partial<Record<IntegrationProvider, IntegrationAdapter>> = {};
  for (const [provider, factory] of Object.entries(integrationFactories) as [
    IntegrationProvider,
    IntegrationAdapterFactory,
  ][]) {
    builtIntegrationAdapters[provider] = factory(integrationAdapterDeps);
  }
  const oauthClient = (
    id: string | undefined,
    secret: string | undefined,
    environment: "production" | "sandbox" = "production",
  ) =>
    id === undefined || secret === undefined
      ? undefined
      : { clientId: id, clientSecret: secret, environment };
  const integrationOAuthClients = {
    quickbooks: oauthClient(
      raw.INTEGRATIONS_QUICKBOOKS_CLIENT_ID,
      raw.INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET,
      raw.INTEGRATIONS_QUICKBOOKS_ENVIRONMENT,
    ),
    xero: oauthClient(raw.INTEGRATIONS_XERO_CLIENT_ID, raw.INTEGRATIONS_XERO_CLIENT_SECRET),
    slack: oauthClient(raw.INTEGRATIONS_SLACK_CLIENT_ID, raw.INTEGRATIONS_SLACK_CLIENT_SECRET),
  };
  const integrations: IntegrationsKernel =
    options.integrations ??
    createIntegrationsService({
      db,
      audit,
      crypto: envelope,
      adapters: builtIntegrationAdapters,
      oauthClients: Object.fromEntries(
        Object.entries(integrationOAuthClients).filter(([, c]) => c !== undefined),
      ),
      // The OAuth confirm step re-checks the initiator's permission at confirmation time.
      hasPermission: (membership, permission) => authz.hasPermission(membership, permission),
      // BASE_URL, never the request (E3.9 §2); `workspaceUrl` paths are relative to it.
      publicBaseUrl: canonicalBaseOf(config.baseUrl),
      workspaceUrl: (workspace, path) =>
        workspaceUrl(config.baseUrl, raw.TENANCY_MODE, workspace, path, config.basePath).href,
      now,
      log: hook("integrations"),
    });
  // --- managed-host control plane (E3.10, ADR-0058) ----------------------------------------------
  /*
   * One factory per owning agent (`src/control-plane/*-wiring.ts`), all inert unless
   * CONTROL_PLANE=on (central auth: CENTRAL_AUTH=on). Built before `moduleServices` because
   * `ModuleServices.quota` forwards to the usage kernel's `quota`.
   */
  const controlPlaneDeps: ControlPlaneWiringDeps = {
    config,
    controlPlaneEnabled: raw.CONTROL_PLANE === "on",
    db,
    audit,
    queue,
    mailer,
    storage,
    envelope,
    rateLimiter,
    authz,
    auth,
    identityDeps,
    resolver,
    customDomains,
    customDomainLookup,
    directory,
    registry: modules,
    workspaceUrl: (workspace, path) =>
      workspaceUrl(config.baseUrl, raw.TENANCY_MODE, workspace, path, config.basePath),
    now,
    log: hook,
  };
  const billing = createBillingWiring(controlPlaneDeps);
  const sanctions = createSanctionsWiring(controlPlaneDeps);
  const controlPlane: ControlPlaneKernel = {
    enabled: raw.CONTROL_PLANE === "on",
    cellId: raw.CELL_ID,
    operators: createOperatorsWiring(controlPlaneDeps, {
      // Sanctions first: it holds the new workspace before billing opens a subscription for it.
      hooks: () => [sanctions.hooks, billing.hooks],
      // E3.11: the residency merge fields of the seeded legal documents (read at seed time).
      residency: () => ({ residency, billing, sanctions }),
    }),
    usage: createUsageWiring(controlPlaneDeps),
  };
  const centralAuth = createCentralAuthWiring(controlPlaneDeps);
  // E3.12: the AI provider is read lazily — `aiModel` (below) is built after these facts.
  const residency = residencyFactsOf(raw, () => aiModel?.info ?? null);
  /** Forwards to whatever `controlPlane.usage.quota` is now (M's service, or a test's fake). */
  const quota: ModuleServices["quota"] = {
    check: (tx, input) => controlPlane.usage.quota.check(tx, input),
  };
  // A-3 (ADR-0063): plan entitlements, enforced on the quotas' terms (CONTROL_PLANE=on + a plan).
  const entitlements = createEntitlements({ enforced: controlPlaneDeps.controlPlaneEnabled });
  // --- AI assist (E3.12, ADR-0060) ---------------------------------------------------------------
  /*
   * The model adapter for AI_PROVIDER on its own guarded client (`ai/wiring.ts`), or the test
   * seam's port; null = AI unavailable. The kernel resolves module AI tasks lazily against
   * `moduleServices` (built below, and carrying `ai`).
   */
  const aiModelWiring = createAiModel(raw, {
    override: options.aiModel,
    userAgent: `FundRoom/${SERVER_VERSION} (+ai)`,
    now,
    log: hook("ai"),
  });
  const aiModel: ModelPort | null = aiModelWiring.model;
  const aiKernel: AiKernel = createAiWiring({
    raw,
    model: aiModel,
    db,
    audit,
    queue,
    rateLimiter,
    registry: modules,
    moduleServices: () => moduleServices,
    isModuleEnabled: async (ctx, module) => (await enablement.get(db, ctx)).enabled.has(module),
    hasPermission: (membership, permission) => authz.hasPermission(membership, permission),
    invalidate: () => resolver.invalidate(),
    now,
    log: hook("ai"),
  });
  const ai: AiServices = aiKernel.services;
  // --- external audit anchoring (E3.13, ADR-0061) -----------------------------------------------
  const auditAnchoring = createAuditAnchoring({
    config,
    drivers: options.auditAnchorDrivers,
    log: hook("audit"),
  });
  const moduleServices = moduleServicesOf({
    db,
    registry: modules,
    enablement,
    baseUrl: config.baseUrl,
    basePath: config.basePath,
    tenancy: raw.TENANCY_MODE,
    trustProxy: proxyTrustOf(raw),
    log: hook("modules"),
    resolver,
    mailer,
    storage,
    audit,
    rateLimiter,
    authz,
    queue,
    crypto: envelope,
    scanner,
    renderer,
    dns,
    spreadsheets,
    accreditation,
    chat,
    search,
    esign,
    integrations,
    quota,
    entitlements,
    ai,
    keyRing: config.keyRing,
    limits: {
      uploadMaxBytes: raw.UPLOAD_MAX_BYTES,
      renderMaxBytes: raw.RENDER_MAX_BYTES,
      dataDir: raw.DATA_DIR,
    },
  });
  // E3.1: domain auto-approval only where the offering status permits it (never under 506(b)),
  // and an auto-approval spends the same daily invitation cap as POST /access/invites.
  const accessRequests = createAccessRequestService(identityDeps, {
    requestAutoApprove: (status) => permits(status).requestAutoApprove,
    inviteDailyCap: INVITE_DAILY_CAP,
  });
  // E3.4: workspace API keys. Scopes offered = the permissions some `apiKey: true` route requires.
  const authzMatrix = loadAuthzMatrix();
  const apiKeys = createApiKeyService({
    db,
    audit,
    hasPermission: (m, p) => authz.hasPermission(m, p),
    scopeCatalogue: () =>
      apiKeyScopes(authzMatrix).map((id) => ({
        id,
        description: authzMatrix.permissions.get(id)?.description ?? "",
      })),
    now,
    log: hook("api-keys"),
  });
  // --- outbound webhooks (E3.4-B) -------------------------------------------------------------
  /*
   * Its own guarded agent, on the `chatOutbound` reasoning with the contract's budget: 10 s, a
   * 64 KiB answer (only a 512-character excerpt is kept) and **no redirects** — the URL is a
   * credential-bearing address an admin pasted, and a redirect is the one way a signed payload
   * reaches a host they did not name. `assess` (the static policy) validates a URL at save time;
   * the service refuses plain http unless the host is exempt (`WEBHOOK_ALLOW_PRIVATE_HOSTS`).
   */
  const webhookOutbound = createOutboundHttp({
    // Its own allow-list (E3.4 fix H1): webhook URLs are tenant-chosen, so they never inherit
    // the operator's OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS] — only WEBHOOK_ALLOW_PRIVATE_HOSTS.
    allowPrivate: false,
    allowedPrivateHosts: raw.WEBHOOK_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: WEBHOOK_USER_AGENT,
    timeoutMs: WEBHOOK_HTTP_TIMEOUT_MS,
    maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    // A 2xx with a big body is still a delivery (fix D4): keep the status, cut the body.
    oversizeResponse: "truncate",
    // Tenant-chosen hostnames: a lookup that never answers keeps a libuv threadpool thread past
    // the deadline, so at most 4 in flight; one more fails fast as `dns_failed` (and retries).
    maxConcurrentLookups: WEBHOOK_WORKER_CONCURRENCY,
    maxRedirects: 0,
    log: hook("webhooks"),
  });
  const webhooks = createWebhookService({
    db,
    keys: envelope,
    audit,
    queue,
    http: webhookOutbound,
    topics: () => modules.webhookTopics(),
    // Fresh through the caller's tx, never the 15 s cache: a module switched off stops its
    // deliveries at once, and the outbox subscriber must not take a second connection.
    enabledModules: async (tx, ctx) => (await loadWorkspaceModules(db, ctx, modules, tx)).enabled,
    legal: legalForMail,
    now,
    log: hook("webhooks"),
  });
  for (const { topic } of modules.webhookTopics()) {
    subscriptions.subscribe(topic, WEBHOOK_FANOUT_SUBSCRIPTION, async (event, sc) => {
      await webhooks.fanOut(event, sc);
    });
  }
  const jobs: JobDefinition<JsonObject>[] = [
    // E3.10: the control plane's jobs (usage rollup, billing enforcement and reporting, sanctions
    // screening and list refresh); each kernel registers none while it is inert.
    ...controlPlane.operators.jobs,
    ...controlPlane.usage.jobs,
    ...billing.jobs,
    ...sanctions.jobs,
    ...centralAuth.jobs,
    // E3.4-B: `webhooks.deliver` (per fan-out/test/redeliver), `webhooks.deliver-due` (every
    // minute: retries and stale leases) and `webhooks.retention` (daily, 30 days, legal hold).
    ...webhooks.jobs(),
    ...createIdentityJobs({ db, sessions: auth.sessions, rateLimiter, now, log: hook("identity") }),
    // E3.1: `access-requests.sweep`, hourly — stale codes, expired queue rows, 90-day retention.
    ...(createAccessRequestJobs({ service: accessRequests, now }) as JobDefinition<JsonObject>[]),
    // E3.4: `api-keys.sweep`, hourly — revokes keys whose creator is no longer live.
    ...apiKeys.jobs,
    // E3.5: `esign.sync`, `esign.collect`, `esign.void` and the 5-minute `esign.sync-due` sweep.
    ...(esign.jobs as JobDefinition<JsonObject>[]),
    // E3.6: `integrations.health`, `integrations.retention`, `integrations.oauth-state-sweep`.
    ...(integrations.jobs as JobDefinition<JsonObject>[]),
    // E3.12: `ai.run` (one per request) and `ai.retention`, hourly — expired and stale requests.
    ...aiKernel.jobs,
    // E3.2: `access-review.overdue`, daily — audit + event (notify alerts) once per ISO week.
    ...(createAccessReviewJobs({
      deps: identityDeps,
      now,
      entitlements,
    }) as JobDefinition<JsonObject>[]),
    createCheckpointJob({ db, keyRing: config.keyRing, log: hook("audit") }),
    // E3.13: `audit.anchor` (02:40 UTC) only when at least one anchor driver is configured.
    ...(auditAnchoring.drivers.length > 0
      ? [
          createAnchorJob({
            db,
            drivers: auditAnchoring.drivers,
            keyRing: config.keyRing,
            audit,
            now,
            log: hook("audit"),
          }),
        ]
      : []),
    createAuditMaintenanceJob({
      db,
      audit,
      retentionMonths: raw.AUDIT_RETENTION_MONTHS,
      log: hook("audit"),
    }),
    ...createCryptoJobs({ db, envelope, log: hook("crypto") }),
    ...createEventMaintenanceJobs({ db, now, log: hook("events") }),
    ...authz.jobs,
    auth.inviteImports.job,
    ...createDomainJobs({
      db,
      service: customDomains,
      provider: domainProvider,
      now,
      log: hook("domains"),
    }),
    ...createMailJobs({ db, now, log: hook("mail") }),
    // E2.7: crypto-shreds deleted workspaces once their 30-day restore window has closed.
    createWorkspacePurgeJob({
      db,
      audit,
      invalidateKeys: (workspaceId) => envelope.invalidate(workspaceId),
      storage,
      directory,
      now,
      log: hook("workspace"),
    }),
    // E2.8: `search.reindex` (one module of one workspace, rebuilt in short paged transactions
    // under a per-module advisory lock; packages/search/README.md) and the
    // 10-minute `search.sweep` that enqueues stale or requested (workspace, module) pairs.
    ...createSearchJobs({
      db,
      modules: () => modules.modules,
      queue,
      now,
      log: hook("search"),
    }),
    // E2.8: `portability.export` (builds one workspace export zip) and the hourly
    // `portability.expire` (deletes files past their 7 days, fails exports a dead worker left).
    ...createPortabilityJobs({
      db,
      storage,
      envelope,
      keyRing: config.keyRing,
      modules: modules.modules,
      // Every compiled-in module, loaded or not: names the owner of a schema MODULES left out,
      // which the export records as omitted (and warns about) instead of dropping silently.
      compiledModules: options.modules ?? [],
      instanceVersion: SERVER_VERSION,
      audit,
      dataDir: raw.DATA_DIR,
      now,
      log: hook("portability"),
    }),
    // E3.11 (shared directory only): `directory.heartbeat` (5 min) + `directory.reconcile` (10 min).
    ...createDirectoryJobs({
      db,
      directory,
      keyRing: config.keyRing,
      directoryUrl: raw.DIRECTORY_DATABASE_URL,
      now,
      log: hook("directory"),
    }),
    // E3.11: moves between cells (`move.export|import|poll|retire`), only with the shared directory.
    ...createMoveJobs({
      config,
      db,
      audit,
      directory,
      storage,
      envelope,
      queue,
      resolver,
      registry: modules,
      moduleServices,
      customDomains,
      compiledModules: options.modules ?? [],
      now,
      log: hook("moves"),
    }),
    ...modules.resolveJobs(moduleServices),
  ];

  /*
   * The embed bridge origins, cached beside the email brand and on the same terms (E2.2).
   *
   * One SSR page load per embed document asks for this, and the answer changes only when an
   * admin edits the allow-list — which invalidates the workspace resolver, not this map, so the
   * TTL is what bounds the staleness. A minute of a stale *bridge* list is a minute in which a
   * just-added origin does not yet receive postMessages; the framing control itself
   * (`frame-ancestors`) is read from the resolved row and is never stale in that way.
   */
  const embedOriginCache = new Map<string, { value: readonly string[]; until: number }>();

  /*
   * E-UP-11: under the control plane the first-run wizard is off. Workspaces there come from
   * signup and the operator API, so the gate never reports "required" (not even before the first
   * workspace exists) and no setup token is generated, written or logged: a token printed to the
   * logs of a host anyone can reach would mint a workspace and its owner outside signup.
   */
  const firstRunOff = raw.CONTROL_PLANE === "on";
  const setupGate = createSetupGate({ db, disabled: firstRunOff });
  let setupToken: SetupToken | undefined;
  /*
   * CORS + CSRF static allow-list. BASE_URL's origin is the portal's own — unless it is a path
   * mount's (E3.9 FR1 B1): then it is the HOST site's, whose every script would otherwise get
   * credentialed API access on the portal origin. A mounted request already accepts the mount's
   * origin as its own (`selfOrigin` = public origin); a direct one must not.
   */
  const allowedOrigins = [
    ...(isMountOrigin(config.baseUrl.origin, config.pathMounts) ? [] : [config.baseUrl.origin]),
    ...(raw.CORS_ALLOWED_ORIGINS ?? []),
  ];

  let started = false;
  let stopping: Promise<void> | undefined;
  const isWorker = config.roles.has("worker");
  /*
   * E-UP-13: the install's own cell row. Without it, placement had nowhere to put a new
   * workspace but the seeded `default`, where the cell guard answers `421 wrong_cell` under the
   * control plane. Created when missing (audited `cell.add`, actor system/boot); an existing row
   * is compared and never rewritten — a difference is a warning, because the row may be an
   * operator's deliberate edit. Never fails the start: placement refuses on its own
   * (`OwnCellUnavailableError`) if the row is still missing, with the command that fixes it.
   */
  async function ensureOwnCellRow(): Promise<void> {
    const cellLog = hook("cells");
    try {
      const own = ownCellOrigin(config);
      const result = await ensureOwnCell(
        { db, audit },
        {
          id: raw.CELL_ID,
          region: raw.DATA_REGION,
          regionLabel: raw.DATA_REGION_LABEL,
          jurisdiction: raw.DATA_REGION_JURISDICTION,
          // BASE_URL's origin under the control plane; '' (this install) without one, where
          // nothing routes between cells, or when BASE_URL is a path mount's or not https.
          publicOrigin: own.origin,
        },
      );
      if (result.outcome === "placeholder") return;
      if (result.outcome === "created") {
        cellLog("cell.own_created", {
          cellId: result.row.id,
          region: result.row.region,
          publicOrigin: result.row.publicOrigin,
          originBasis: own.basis,
        });
        /*
         * Fix round 1 M2: the boot publish (`checkDataRegion`) ran before this row existed. A
         * claim would still work (the first claim publishes its own cell), but other cells (the
         * signup region picker, moves, routing) would not see this one until the next heartbeat
         * (5 min). Publish now; bounded and never throws (`publishDirectoryCells`).
         */
        if (isSharedDirectory(directory)) {
          await publishDirectoryCells({ db, directory, keyRing: config.keyRing, log: cellLog });
        }
      } else if (result.outcome === "differs") {
        cellLog("cell.own_differs", {
          level: "warn",
          cellId: raw.CELL_ID,
          message: `the core.cell row for CELL_ID=${raw.CELL_ID} differs from this deployment's configuration and was left as it is: ${result.differences.join("; ")}. If the configuration is right, correct the row with: fundroom cell set-origin ${raw.CELL_ID} <origin> (the region never changes; see the residency runbook).`,
        });
      } else if (result.outcome === "refused") {
        cellLog("cell.own_missing", {
          level: "error",
          cellId: raw.CELL_ID,
          message: `CELL_ID=${raw.CELL_ID} has no core.cell row and it could not be created: ${result.reason}. New workspaces cannot be placed until it exists.`,
        });
        return;
      }
      // Draining or closed is an operator's deliberate state: said once per start, not warned.
      if (result.row.status !== "active") {
        cellLog("cell.own_not_active", {
          level: "info",
          cellId: raw.CELL_ID,
          status: result.row.status,
          message: `CELL_ID=${raw.CELL_ID} is ${result.row.status}: no new workspace is placed on it (signups and the operator API refuse it).`,
        });
      }
      /*
       * Fix round 1 L1: live workspaces on the seeded `default` while this process serves another
       * cell. One database may legitimately host several cells served by different processes, so
       * this is a hint, not a diagnosis: they answer 421 wrong_cell only if no process serves
       * CELL_ID=default (the E-UP-13 symptom, from before the fix). Moving them is the operator's.
       */
      if (raw.CONTROL_PLANE === "on") {
        const onDefault = await liveWorkspacesOnCell(db, "default");
        if (onDefault > 0) {
          cellLog("cell.default_has_workspaces", {
            level: "warn",
            cellId: raw.CELL_ID,
            workspaces: onDefault,
            message: `${onDefault} workspace(s) are on cell default; if no process serves CELL_ID=default they answer 421 wrong_cell — move them to ${raw.CELL_ID} with Change cell on each console page, or PATCH /api/v1/platform/workspaces/{id} {"cellId":"${raw.CELL_ID}"}.`,
          });
        }
      }
    } catch (error) {
      cellLog("cell.own_missing", {
        level: "error",
        cellId: raw.CELL_ID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Fix round 1 L7: a token file left by a run before the control plane was on goes. */
  function removeStaleSetupToken(): void {
    if (!firstRunOff) return;
    if (removeSetupTokenFile(raw.DATA_DIR)) {
      hook("setup")("setup.token_removed", {
        message:
          "removed a leftover setup-token file: first-run setup is off under the control plane",
      });
    }
  }

  const isApi = config.roles.has("api");

  return {
    config,
    logger,
    log,
    db,
    resolver,
    kms,
    envelope,
    storage,
    scanner,
    renderer,
    mailer,
    outbound,
    dns,
    spreadsheets,
    accreditation,
    sso,
    scim,
    ssoOutbound,
    chat,
    updateChecker: updateCheck.checker,
    search,
    mailFeedback,
    customDomainCnameTarget,
    customDomains,
    customDomainLookup,
    rateLimiter,
    audit,
    auth,
    accessRequests,
    apiKeys,
    webhooks,
    esign,
    esignCallbacks,
    accreditationCallbacks,
    accreditationOutbound,
    esignAdapters,
    esignOutbound,
    integrations,
    integrationsOutbound,
    ai,
    aiKernel,
    auditAnchoring,
    aiModel,
    authz,
    authzEngine: authzWiring.engine,
    controlPlane,
    billing,
    sanctions,
    directory,
    residency,
    centralAuth,
    identityDeps,
    handoff: createHandoffService(),
    queue,
    subscriptions,
    relay,
    registry: modules,
    enablement,
    moduleServices,
    jobs,
    canonicalHost,
    allowedOrigins,
    setupGate,
    get setupToken() {
      setupToken ??= firstRunOff
        ? disabledSetupToken()
        : resolveSetupToken({ configured: raw.SETUP_TOKEN, dataDir: raw.DATA_DIR });
      return setupToken;
    },
    get started() {
      return started;
    },
    async embedOrigins(workspaceId: string) {
      const t = now().getTime();
      const hit = embedOriginCache.get(workspaceId);
      if (hit !== undefined && hit.until > t) return hit.value;
      const workspace = await findWorkspaceById(db, workspaceId);
      const value =
        workspace === undefined ? [] : parseWorkspaceSettings(workspace.settings).embed.origins;
      // Clear-on-full, the `BRAND_CACHE_MAX` pattern: bounded so a host with many workspaces
      // cannot grow this map without limit, and O(1) rather than LRU bookkeeping on a page load.
      if (embedOriginCache.size >= BRAND_CACHE_MAX) embedOriginCache.clear();
      embedOriginCache.set(workspaceId, { value, until: t + BRAND_TTL_MS });
      return value;
    },
    async start() {
      if (started) return;
      removeStaleSetupToken();
      await ensureOwnCellRow();
      await queue.start();
      await prepareEventQueues(queue, subscriptions);
      await registerJobs({ queue, definitions: jobs, worker: isWorker, log: hook("jobs") });
      if (isWorker) {
        await registerEventWorkers({
          db,
          queue,
          subscriptions,
          work: { concurrency: raw.WORKER_CONCURRENCY },
          log: hook("events"),
        });
      }
      // The relay runs next to the writers: on api nodes, or on a lone worker.
      if (isApi || !config.roles.has("api")) relay.start();
      started = true;
      log("container.started", {
        roles: [...config.roles],
        modules: modules.ids,
        jobs: jobs.map((j) => j.name),
      });
    },
    /*
     * Safe at any point, once (a second call answers the first's promise): before `start()`,
     * after a `start()` that threw part-way (E-UP-10), or after a full one. Everything below is
     * either opened by `createContainer` (pools, outbound agents, kernels, the authz/AI/anchoring
     * wirings, the update check) or a no-op until started (relay, queue), so the full sequence
     * always runs; one step failing is logged and does not skip the rest, and the first error is
     * re-thrown at the end.
     */
    stop() {
      stopping ??= (async () => {
        started = false;
        let firstError: unknown;
        const close = async (name: string, run: () => Promise<unknown>): Promise<void> => {
          try {
            await run();
          } catch (error) {
            firstError ??= error;
            log("container.stop_step_failed", {
              level: "error",
              step: name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };
        await close("relay", () => relay.stop());
        await close("queue", () => queue.stop({ timeoutMs: raw.SHUTDOWN_TIMEOUT_MS }));
        await close("outbound", () => outbound.close());
        await close("dnsOutbound", () => dnsOutbound.close());
        await close("sheetsOutbound", async () => sheetsOutbound?.close());
        await close("mailOutbound", async () => mailOutbound?.close());
        await close("chatOutbound", async () => chatOutbound?.close());
        await close("webhookOutbound", () => webhookOutbound.close());
        await close("esignOutbound", () => esignOutbound.close());
        await close("integrationsOutbound", () => integrationsOutbound.close());
        await close("accreditationOutbound", () => accreditationOutbound.close());
        await close("ssoOutbound", () => ssoOutbound.close());
        await close("aiModel", () => aiModelWiring.close());
        await close("auditAnchoring", () => auditAnchoring.close());
        await close("authz", () => authzWiring.close());
        await close("cloudflareOutbound", async () => cloudflareOutbound?.close());
        for (const [name, kernel] of [
          ["operators", controlPlane.operators],
          ["usage", controlPlane.usage],
          ["billing", billing],
          ["sanctions", sanctions],
          ["centralAuth", centralAuth],
        ] as const) {
          await close(name, () => kernel.close());
        }
        await close("updateCheck", () => updateCheck.close());
        await close("directory", () => directory.close());
        await close("mailDb", () => mailDb.close());
        await close("db", () => db.close());
        log("container.stopped");
        if (firstError !== undefined) throw firstError;
      })();
      return stopping;
    },
  };
}
