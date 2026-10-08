import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import type {
  Database,
  Membership,
  OfferingStatus,
  ResolvedWorkspace,
  TenantContext,
  Tx,
} from "@fundroom/db";
import { ALL_ENTITLEMENTS, type EventTopic, isEventTopic } from "@fundroom/domain";
import type { EventHandler } from "@fundroom/events";
import type {
  AccreditationDriver,
  AccreditationEvidence,
  AccreditationVendorCheck,
  AccreditationVendorDriver,
  AccreditationVendorStartInput,
  AccreditationVendorStartResult,
  ApiKeyPrincipal,
  AuthenticatedSession,
  AuthzPort,
  ChatChannelRef,
  ChatWebhookPort,
  DnsResolverPort,
  DocumentRenderPort,
  EntitlementsPort,
  ESignDocumentSource,
  ESignDriver,
  ESignSignerStatus,
  ESignVendorMeta,
  IntegrationProvider,
  IntegrationResult,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  KpiReadRequest,
  KpiReadValue,
  KpiSourceMetric,
  MailerPort,
  ModelJsonSchema,
  ObjectStoragePort,
  RateLimiterPort,
  RequestFacts,
  SpreadsheetPort,
  VirusScanPort,
} from "@fundroom/ports";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { z } from "zod";

/*
 * Module manifests (EXECUTION_PLAN §5.3, ADR-0007). A module is a workspace package whose
 * default export is `defineModule({...})`. Everything a module contributes is declared here
 * and wired by the registry + composition root: nothing is discovered at runtime.
 */

export const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/u;
export const PERMISSION_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/u;
export const FLAG_RE = PERMISSION_RE;
export const PG_SCHEMA_RE = /^[a-z_][a-z0-9_]*$/u;

/** Log hook shared with the kernel packages: never emails, tokens or document names. */
export type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/**
 * Variables every module route can read. The kernel middleware sets them before a module
 * handler runs; a route under `/api/v1/<module>` never sees a request for a workspace that
 * has the module disabled (the registry mounts a 404 guard in front).
 */
export interface ModuleVariables {
  requestId: string;
  log: Log;
  /** Resolved workspace; absent on host-level routes (setup, multi-tenant login). */
  workspace?: ResolvedWorkspace;
  /** Tenant context for `db.withTenant()`; present whenever `membership` is. */
  tenant?: TenantContext;
  session?: AuthenticatedSession;
  /**
   * Set when the request authenticated with a workspace API key (E3.4) and carries no session:
   * `membership`/`tenant` are then the key creator's. Only routes whose matrix row is
   * `apiKey: true` admit it.
   */
  apiKey?: ApiKeyPrincipal;
  /** The caller's membership in `workspace`, when signed in and a member. */
  membership?: Membership;
  /** True on the `/embed/*` route tree (partitioned cookies, ADR-0009). */
  embed: boolean;
  /**
   * Set while a staff session views this workspace as an investor (E2.7). `membership` and
   * `tenant` are then the investor's (`tenant.viewAs` is set too). Routes must not record the
   * investor's side effects (engagement, exposure, view audits) and must refuse downloads and
   * exports with `view_as_read_only`; mutating methods never reach a route.
   */
  viewAs?: ViewAsVariable;
}

export interface ViewAsVariable {
  readonly staffMembershipId: string;
  readonly staffUserId: string;
  /** The external membership being viewed as (= `membership.id`). */
  readonly membershipId: string;
  readonly startedAt: Date;
  readonly until: Date;
}

export type ModuleEnv = { Variables: ModuleVariables };

export type ModuleRouter = OpenAPIHono<ModuleEnv>;

/**
 * A plain Hono app for protocol endpoints that are not part of the OpenAPI contract and must
 * bypass the JSON body limit (tus upload PATCHes, streamed downloads). Mounted at
 * `/api/v1/<module>` in front of the OpenAPI routes, behind the same session, CSRF and
 * enablement middleware.
 */
export type ModuleRawRouter = Hono<ModuleEnv>;

/**
 * Route guards the kernel owns (§6.2 MFA policy, ADR-0032 §7): modules mount them instead of
 * re-implementing the session → member → auth level → permission chain.
 */
export interface ModuleGuards {
  /**
   * A live *staff* membership holding `permission`; `fresh` adds the 10-minute step-up check.
   * `apiKey` marks the route key-callable (its matrix row says `apiKey: true`, E3.4); without it
   * a key-only request is refused with 401 `api_key_not_allowed`.
   */
  requirePermission(
    permission: string,
    extra?: { readonly fresh?: boolean | undefined; readonly apiKey?: boolean | undefined },
  ): MiddlewareHandler<ModuleEnv>;
  /** Signed in, live member (staff or external), strong enough session. */
  requireMember(): MiddlewareHandler<ModuleEnv>;
}

/** A block hydrator together with the module that provides it (enablement is per workspace). */
export interface RegisteredHydrator {
  readonly module: string;
  readonly hydrator: BlockHydrator;
}

/** The slice of the registry a module may look at (structural: `ModuleRegistry` satisfies it). */
export interface ModuleRegistryView {
  readonly ids: readonly string[];
  has(id: string): boolean;
  readonly permissions: ReadonlyMap<string, string>;
  readonly blockHydrators: ReadonlyMap<string, RegisteredHydrator>;
  /**
   * AI context providers by key (E3.12), resolved lazily from each manifest's
   * `aiContextProviders(services)` on first read. Check the provider module's enablement.
   */
  readonly aiContextProviders: ReadonlyMap<string, RegisteredAiContextProvider>;
}

/** Per-workspace enablement as modules see it (`EnablementCache` satisfies it). */
export interface EnablementView {
  /** Pass `tx` whenever the caller already holds a transaction (see `EnablementCache.get`). */
  get(
    db: Database,
    ctx: TenantContext,
    tx?: Tx | undefined,
  ): Promise<{
    readonly enabled: ReadonlySet<string>;
    readonly flags: ReadonlyMap<string, boolean>;
  }>;
  invalidate(workspaceId: string): void;
}

/**
 * What a module's routes, jobs and hydrators receive from the composition root (ADR-0033):
 * the kernel services behind their ports, never another module. Read every property lazily
 * inside handlers: `generateOpenApiDocument()` registers routes against a throwing stub.
 */
/** A published version of a tenant legal text, resolved for rendering (E1.6). */
export interface ResolvedDisclaimer {
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
  readonly versionNo: number;
  /** The Markdown body exactly as published. */
  readonly body: string;
  /** Hex sha256 of `body`: the evidence that a reader was shown this text and no other. */
  readonly bodySha256: string;
  readonly effectiveAt: Date;
}

export interface LegalServices {
  /**
   * The workspace's current disclaimer for `slug`, or the one named by
   * `legal.defaultDisclaimerSlug` when `slug` is omitted. `undefined` when there is none: a
   * workspace that has not written a disclaimer is not an error, it just has nothing to show.
   */
  resolveDisclaimer(
    tx: Tx,
    ctx: TenantContext,
    slug?: string | undefined,
  ): Promise<ResolvedDisclaimer | undefined>;
  /**
   * The stamp for the disclaimer in force right now. It is a *string* (`<slug>:v<n>`), not a
   * foreign key: the snapshot must stay readable after the document is deleted, and an auditor
   * reading the row six years later should not need a join to understand it.
   */
  stampFor(tx: Tx, ctx: TenantContext, slug?: string | undefined): Promise<string | undefined>;
  /**
   * Whether an optional tracking purpose is permitted for this member right now (R13). The
   * answer folds the workspace's `legal.consentMode`, the member's newest `consent_event` and
   * the request's Global Privacy Control signal; GPC always means no. `modules/analytics` asks
   * this before recording anything beyond strictly-necessary access facts — consent is a
   * kernel fact about a person, not something an analytics module should decide for itself.
   */
  /**
   * The member's own stored answer for a purpose: `true` granted, `false` withdrawn, `null`
   * never asked. Unlike `allowsPurpose` this reports the fact without folding in the workspace
   * mode or GPC — it is what the portal shows the person when it explains their choice.
   */
  consentFor(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
    purpose: "analytics_engagement" | "email_tracking",
  ): Promise<boolean | null>;
  allowsPurpose(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
    purpose: "analytics_engagement" | "email_tracking",
    signals?: { readonly gpc?: boolean | undefined } | undefined,
  ): Promise<boolean>;

  /*
   * Accreditation (E2.5 decision D5). Every one of these exists so that a module writing a
   * 506(b)/506(c) interest form **never touches `core.attestation` itself**. Accredited status is
   * a kernel fact about a person: the policy-gate evaluator reads it, the compliance register
   * exports it, and it has to expire on the same clock whether it came from a questionnaire or
   * from a staff member reading a bank letter. A round module writing that row directly would
   * own an evidence record it does not own the lifecycle of — which is exactly the coupling
   * ADR-0033 forbids, and the reason `consentFor` above is here rather than in analytics.
   */

  /**
   * The member's live `accredited` attestation, as the gate would see it. `accredited: false`
   * when there is none, it expired or it was revoked — never a throw, because "is this person
   * accredited" is a question every offering-aware screen asks and none of them can act on an
   * exception. `stamp` is the click-wrap acceptance it came from, when it came from one.
   */
  accreditation(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
  ): Promise<{
    readonly accredited: boolean;
    readonly expiresAt?: Date | undefined;
    readonly method?: string | undefined;
    readonly stamp?: string | undefined;
  }>;

  /**
   * Records a self-certification against the workspace's current published `accreditation`
   * document, writing the two attestation rows E2.3 froze (the click-wrap record of agreeing to
   * *this text*, and the dated, expiring `accredited` fact) through the acceptance service — not
   * a second implementation of them.
   *
   * Throws when the workspace has published no such document: a self-certification with no text
   * behind it is evidence of nothing, and the caller must say so rather than record it anyway.
   *
   * `nonAccredited` is `true` when the answers named no category — a real answer, and the one the
   * 506(b) purchaser count acts on.
   */
  certifyAccreditation(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly membershipId: string;
      readonly answers: AccreditationAnswersInput;
      readonly evidence?:
        | { readonly uaFamily?: string | undefined; readonly ipHash?: Uint8Array | undefined }
        | undefined;
      readonly actor: {
        readonly membershipId: string;
        readonly requestId?: string | undefined;
        readonly sessionId?: string | undefined;
      };
    },
  ): Promise<{
    readonly stamp: string;
    readonly accredited: boolean;
    readonly expiresAt?: Date | undefined;
    readonly nonAccredited: boolean;
  }>;

  /**
   * Records an accreditation a *person* decided (E2.5 D6): a staff member read the evidence, or a
   * vendor bureau answered. One `accredited` row, `data.method` prefixed `verified:` so the
   * register can tell the two provenances apart at a glance, and `evidenceRef` naming what was
   * read — never the evidence itself.
   */
  recordVerifiedAccreditation(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly membershipId: string;
      readonly method: string;
      readonly evidenceRef: string;
      readonly expiresAt: Date;
      readonly questionnaireVersion?: number | undefined;
      /**
       * A staff member who decided, or (E3.7) the accreditation vendor that did: a provider actor
       * writes `data.decidedBy = null`, `data.provider = <driver>` and is audited as the system.
       */
      readonly actor:
        | {
            readonly membershipId: string;
            readonly requestId?: string | undefined;
            readonly sessionId?: string | undefined;
          }
        | { readonly provider: AccreditationVendorDriver };
    },
  ): Promise<{ readonly attestationId: string }>;

  /**
   * Stamps `core.membership.first_exposure_at` the first time this member is shown offering
   * material (E1.6/E2.5). Idempotent: only a null column is written, because the fact worth
   * keeping under 506(b) is when the relationship *predated* the offering, and a later view
   * overwriting it would destroy exactly that evidence. Never throws for an unknown membership.
   */
  noteExposure(tx: Tx, ctx: TenantContext, membershipId: string): Promise<void>;

  /*
   * Erasure (E2.6, design/04 §3.2 DSAR). The kernel owns the request — who asked, the statutory
   * clock, the legal hold that refuses it — and publishes `member.erasure_requested`. Each module
   * holding personal data about the member subscribes, erases or pseudonymises *its own* rows, and
   * reports back here, so the request row can say which modules have finished and which have not.
   */

  /**
   * Records that `module` finished its part of erasure request `requestId`. Idempotent per
   * (request, module): a redelivered event reports twice and the first report stands. `counts`
   * is what was removed or pseudonymised, by table, for the DSAR register — numbers only.
   * Never throws for an unknown request (the row may have been cancelled).
   */
  /**
   * Whether an erasure request exists for this member that is not cancelled (requested or
   * completed). A module that ingests facts about a person *after* the fact happened — a late
   * ESP open, a rollup batch read before the erase, an outbox event already in flight — checks
   * this and drops the fact, so an erasure is not quietly undone by the pipeline behind it.
   * `allowsPurpose` also answers false for such a member.
   */
  isErased(tx: Tx, ctx: TenantContext, membershipId: string): Promise<boolean>;

  completeErasureStep(
    tx: Tx,
    ctx: TenantContext,
    requestId: string,
    module: string,
    counts: Readonly<Record<string, number>>,
  ): Promise<void>;
}

/**
 * The accreditation provider a workspace's NEW verifications use (E3.7, ADR-0055): the vendor of its
 * live connection, or `manual` when it has none.
 */
export interface AccreditationEffectiveProvider {
  readonly driver: AccreditationDriver;
  readonly label: string;
  /**
   * What the flow above has to arrange before a decision can exist: `evidenceUpload` — offer the
   * investor a file upload; `adminDecision` — a human settles it (manual: both true; vendor: both
   * false).
   */
  readonly requires: { readonly evidenceUpload: boolean; readonly adminDecision: boolean };
  /** The live connection's id (vendor only). */
  readonly connectionId?: string | undefined;
}

/**
 * Accreditation verification providers (E2.5 D6, E3.7 ADR-0055). The kernel `@fundroom/accreditation`
 * service implements this; the round module (which owns the verification *record*) reaches the
 * workspace's vendor connection only through it. Vendor calls unseal the connection's credentials in
 * a short transaction of their own and then call the vendor with no transaction open.
 */
export interface AccreditationServices {
  /** Provider new verifications use in this workspace (manual when no live connection). Reads inside `tx` when given. */
  effective(tx: Tx | undefined, ctx: TenantContext): Promise<AccreditationEffectiveProvider>;
  /**
   * MUST NOT be called inside a transaction. Throws `AccreditationProviderError` (code
   * `not_connected` when the workspace's live connection is not `driver`).
   */
  start(
    ctx: TenantContext,
    input: AccreditationVendorStartInput & { readonly driver: AccreditationVendorDriver },
  ): Promise<AccreditationVendorStartResult>;
  check(
    ctx: TenantContext,
    input: {
      readonly driver: AccreditationVendorDriver;
      readonly providerRef: string;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<AccreditationVendorCheck>;
  fetchEvidence(
    ctx: TenantContext,
    input: {
      readonly driver: AccreditationVendorDriver;
      readonly providerRef: string;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<AccreditationEvidence | null>;
  label(driver: AccreditationDriver): string;
}

/*
 * E-signature (E3.5, ADR-0053). The kernel `@fundroom/esign` service implements this; modules
 * (round closing, data-room vaulting) reach it only through `ModuleServices.esign`. Declared
 * structurally here, like `LegalServices`, so module-kit does not depend on the service package.
 */

/** `core.esign_envelope.status`: the vendor statuses plus our own `draft` and `error`. */
export type ESignEnvelopeRowStatus =
  | "draft"
  | "sent"
  | "delivered"
  | "completed"
  | "declined"
  | "voided"
  | "expired"
  | "error";

export type ESignPurpose = "nda" | "round_closing";

export interface ESignSubjectRef {
  readonly module: string;
  readonly kind: string;
  readonly id: string;
}

/** The workspace's e-sign connection, for UIs and modules. Never secrets. */
export interface ESignConnectionSummary {
  readonly driver: ESignDriver;
  readonly displayName: string;
  readonly status: "active" | "error";
  readonly supports: ESignVendorMeta["supports"];
  readonly baseUrlHost: string | null;
}

export interface ESignRequestInput {
  /** "nda" is started only by the kernel NDA route. */
  readonly purpose: "round_closing";
  readonly subject: ESignSubjectRef;
  readonly signer: {
    readonly name: string;
    readonly email: string;
    readonly membershipId?: string | undefined;
    /** Template role name (DocuSign, multi-role DocuSeal). Absent → the adapter default "Signer". */
    readonly role?: string | undefined;
  };
  readonly title: string;
  readonly message?: string | undefined;
  /** round uses `{kind:"template"}`. */
  readonly document: ESignDocumentSource;
  /** Data-room folder path hint for vaulting, e.g. `Signed documents/Seed round`. */
  readonly vaultFolder?: string | undefined;
  readonly embedded: boolean;
  readonly requestedByMembershipId: string;
}

export interface ESignEnvelopeView {
  readonly id: string;
  readonly purpose: ESignPurpose;
  readonly subject: ESignSubjectRef;
  readonly status: ESignEnvelopeRowStatus;
  readonly signerStatus: ESignSignerStatus | null;
  readonly signerName: string;
  readonly signerEmail: string;
  readonly membershipId: string | null;
  readonly title: string;
  readonly driver: ESignDriver;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly hasSigned: boolean;
  readonly hasCertificate: boolean;
  readonly vaultedDocumentId: string | null;
  /** Data-room folder path hint for vaulting; null when the envelope is not to be vaulted. */
  readonly vaultFolder: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

/** Exposed to modules as `ModuleServices.esign`. */
export interface ESignServices {
  /** Connection summary for UIs and modules. Never secrets. */
  connection(tx: Tx, ctx: TenantContext): Promise<ESignConnectionSummary | undefined>;
  /** Creates an envelope. Runs its own short transactions; MUST NOT be called inside a tx. */
  request(ctx: TenantContext, input: ESignRequestInput): Promise<ESignEnvelopeView>;
  get(tx: Tx, ctx: TenantContext, envelopeId: string): Promise<ESignEnvelopeView | undefined>;
  /** Signing URL for the signer; refuses unless membershipId matches the envelope's. undefined → vendor emails. */
  signingUrl(
    ctx: TenantContext,
    envelopeId: string,
    membershipId: string,
    returnUrl: string,
  ): Promise<string | undefined>;
  void(
    ctx: TenantContext,
    envelopeId: string,
    reason: string,
    actorMembershipId: string,
  ): Promise<ESignEnvelopeView>;
  /** Decrypted artifact bytes; undefined unless completed and collected. */
  readArtifact(
    ctx: TenantContext,
    envelopeId: string,
    which: "signed" | "certificate",
  ): Promise<Uint8Array | undefined>;
}

/**
 * Integrations hub (E3.6, ADR-0054). The kernel `@fundroom/integrations` service implements this;
 * modules (metrics KPI sync, notify Slack app channels, crm booking activity) reach connections
 * only through `ModuleServices.integrations`. Never exposes a credential.
 */
export interface IntegrationConnectionSummary {
  readonly id: string;
  readonly provider: IntegrationProvider;
  readonly status: "active" | "degraded" | "reauth_required";
  readonly accountLabel: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastError: string | null;
}

/** One recorded booking (`core.integration_booking`), as `crm` reads it. */
export interface IntegrationBookingView {
  readonly id: string;
  readonly provider: "calendly" | "calcom";
  readonly status: "booked" | "cancelled" | "rescheduled";
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly inviteeEmail: string;
  readonly inviteeName: string | null;
  readonly eventName: string | null;
  readonly membershipId: string | null;
}

/** A read that found no live connection for the provider. */
export type IntegrationNotConnected = { readonly ok: false; readonly reason: "not_connected" };

/** Exposed to modules as `ModuleServices.integrations`. */
export interface IntegrationServices {
  /** Summary for UIs/modules; undefined when not connected. Never secrets. */
  connection(
    tx: Tx,
    ctx: TenantContext,
    provider: IntegrationProvider,
  ): Promise<IntegrationConnectionSummary | undefined>;
  kpiMetrics(provider: IntegrationProvider): readonly KpiSourceMetric[];
  /**
   * Reads a monthly series. Opens its own short transactions; MUST NOT be called inside a tx.
   * Records health (success/failure) on the connection. Returns a typed refusal, never throws for
   * remote problems.
   */
  readKpi(
    ctx: TenantContext,
    provider: IntegrationProvider,
    req: KpiReadRequest,
  ): Promise<IntegrationResult<KpiReadValue> | IntegrationNotConnected>;
  /** Slack app channels the bot can post to. Own short transactions; not inside a tx. */
  slackChannels(
    ctx: TenantContext,
  ): Promise<IntegrationResult<readonly ChatChannelRef[]> | IntegrationNotConnected>;
  /** Posts through the Slack app. Own short transactions; not inside a tx. */
  slackPost(
    ctx: TenantContext,
    channelId: string,
    message: { text: string },
  ): Promise<IntegrationResult<void> | IntegrationNotConnected>;
  booking(
    tx: Tx,
    ctx: TenantContext,
    bookingId: string,
  ): Promise<IntegrationBookingView | undefined>;
}

/**
 * AI assist (E3.12, ADR-0060). The kernel `@fundroom/ai` owns provider selection, settings,
 * budgets, `core.ai_request` and the single `ai.run` job; a module owns its prompts. A module
 * registers **AI tasks** (`ModuleManifest.aiTasks`) and starts a request through
 * `ModuleServices.ai.start` from its own route. AI never writes tenant content: a task's result
 * is a suggestion that staff apply through the module's normal write paths.
 */
export const AI_FEATURES = ["update_draft", "qa_answer"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** What the kernel hands a task's `prepare`/`finish` (re-read from the request row). */
export interface AiTaskInput {
  readonly requestId: string;
  readonly workspaceId: string;
  /** The question id for `qa_answer`; null for `update_draft`. */
  readonly subjectId: string | null;
  /** Re-validated against the task's `paramsSchema` by the kernel before `prepare`. */
  readonly params: JsonObject;
  readonly requestedBy: { readonly membershipId: string };
  /** `AI_MAX_INPUT_CHARS`: `system.length + user.length` must not exceed it. */
  readonly maxInputChars: number;
}

/**
 * A prompt built from the module's own data. Untrusted text (document passages, investor
 * questions) goes inside delimiters in `user`, and `system` says it is data, never instructions.
 */
export interface AiPrompt {
  readonly kind: "prompt";
  readonly system: string;
  readonly user: string;
  readonly json: ModelJsonSchema;
  /** Capped by `AI_MAX_OUTPUT_TOKENS`. */
  readonly maxOutputTokens?: number | undefined;
  /** Handed back to `finish`; never stored. */
  readonly state?: unknown;
}

/** A task declines to run (or to produce a result); `code` matches `^[a-z_]{1,64}$`. */
export interface AiRefusal {
  readonly kind: "refused";
  /** e.g. `subject_gone`, `no_sources`, `erased`. Stored as `ai_request.error_code`. */
  readonly code: string;
}

export type AiTaskOutcome = { readonly kind: "result"; readonly result: JsonObject } | AiRefusal;

export interface AiTaskDefinition {
  readonly feature: AiFeature;
  /** Needed to start a request AND to read its result (e.g. `updates.manage`). */
  readonly permission: string;
  /** Validated by the module route before `start`; the kernel re-validates in the job. */
  readonly paramsSchema: z.ZodType<JsonObject>;
  /** Called OUTSIDE any transaction; does the module's own access checks. */
  prepare(ctx: TenantContext, input: AiTaskInput): Promise<AiPrompt | AiRefusal>;
  /**
   * Called OUTSIDE any transaction with the model's parsed JSON (fences and `<think>` stripped)
   * and its raw text. Validates and produces the stored result (contracts `AiResult`).
   */
  finish(
    ctx: TenantContext,
    input: AiTaskInput,
    prompt: AiPrompt,
    output: { readonly json: unknown; readonly text: string },
  ): Promise<AiTaskOutcome>;
}

/**
 * Context one module offers another module's AI task without either importing the other
 * (metrics' `kpis` for updates' `update_draft`). Called OUTSIDE any transaction; `null` = nothing
 * to offer (e.g. no definitions). Respects `maxChars`.
 */
export interface AiContextProvider {
  readonly key: string;
  provide(
    ctx: TenantContext,
    opts: { readonly maxChars: number },
  ): Promise<{ readonly text: string; readonly definitionIds: readonly string[] } | null>;
}

/** An AI task together with the module that registered it. */
export interface RegisteredAiTask {
  readonly module: string;
  readonly task: AiTaskDefinition;
}

/** An AI context provider together with the module that provides it (check its enablement). */
export interface RegisteredAiContextProvider {
  readonly module: string;
  readonly provider: AiContextProvider;
}

export const AI_START_ERROR_CODES = [
  "ai_unavailable",
  "ai_disabled",
  "ai_acknowledgement_required",
  "ai_rate_limited",
  "ai_busy",
  "ai_budget_exhausted",
] as const;
export type AiStartErrorCode = (typeof AI_START_ERROR_CODES)[number];

/** Why `AiServices.start` refused; routes map `code` to the API error of the same name. */
export class AiStartError extends Error {
  override readonly name = "AiStartError";
  constructor(
    readonly code: AiStartErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

/** Exposed to modules as `ModuleServices.ai`. */
export interface AiServices {
  /**
   * Starts (or reuses the caller's in-flight) request. Runs its own short transactions; MUST NOT
   * be called inside a tx. Throws `AiStartError`.
   */
  start(
    ctx: TenantContext,
    input: {
      readonly feature: AiFeature;
      readonly subjectId: string | null;
      readonly params: JsonObject;
      readonly actor: { readonly membershipId: string; readonly userId: string };
    },
  ): Promise<{ readonly requestId: string; readonly reused: boolean }>;
  /**
   * INSIDE the caller's transaction (erasure / purge hooks): deletes every request of `feature`
   * for `subjectId`. Returns the number deleted. Lock order: the caller's subject rows first.
   */
  discardForSubject(
    tx: Tx,
    ctx: TenantContext,
    feature: AiFeature,
    subjectId: string,
  ): Promise<number>;
  /**
   * INSIDE the caller's transaction (document bin / purge): deletes every `qa_answer` request
   * whose stored result cites `documentId`. Returns the number deleted. Lock order (E3.12 global
   * rule): request rows are locked AFTER the workspace row, so call it after the step that takes
   * the workspace row (audit / search).
   */
  discardCiting(tx: Tx, ctx: TenantContext, documentId: string): Promise<number>;
}

/**
 * Self-certification answers as they cross the seam: category **ids**, not a code enum
 * (design/04 §1.5). Declared structurally here rather than imported from `@fundroom/compliance`
 * because that package depends on this one; the implementation re-parses against
 * `AccreditationAnswersSchema`, which is the list of record.
 */
export interface AccreditationAnswersInput {
  readonly categories: readonly string[];
  /** Which regime's section of the questionnaire was completed (`us`, `uk`, …). */
  readonly section?: string | undefined;
  /** The sophistication statement 506(b) asks of a non-accredited purchaser. */
  readonly note?: string | undefined;
  readonly questionnaireVersion?: number | undefined;
}

export interface ModuleServices {
  readonly db: Database;
  readonly authz: AuthzPort & {
    hasPermission(
      membership: {
        readonly kind: "staff" | "external";
        readonly role: string;
        readonly status: string;
      },
      permission: string,
    ): boolean;
    /** `acl_version++` + `acl.changed` inside the caller's transaction (folder moves, E1.3). */
    bump(tx: Tx, ctx: TenantContext, cause: string): Promise<number>;
  };
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly storage: ObjectStoragePort;
  /** Per-workspace data keys for object encryption (ADR-0028). */
  readonly crypto: EnvelopeService;
  readonly scanner: VirusScanPort;
  readonly renderer: DocumentRenderPort;
  /**
   * DNS lookups for domain verification (E2.1 decision 2). The kernel hands every module the
   * same DoH resolver — public IP-literal endpoints, two of which must agree before a positive
   * answer — rather than letting a module reach for `node:dns`: a stale negative in the local
   * resolver's cache reads to a founder as "your DNS is wrong" when it is not, and a module
   * global cannot be injected per tenant or faked without mutating it.
   */
  readonly dns: DnsResolverPort;
  /**
   * Reading a range out of a spreadsheet the founder already keeps (E2.4 D7). A dedicated field
   * for the same reason `dns` is one, and the argument is worth repeating because the obvious
   * alternative looks cheaper: handing every module a general SSRF-guarded `fetch` would grant
   * every module the whole internet in order to give one of them a read-only view of one
   * spreadsheet. The narrow port also carries the budget with it — a sheet read is 10 s and
   * 2 MiB and never a redirect — and it can be faked in a test without a socket.
   */
  readonly spreadsheets: SpreadsheetPort;
  /**
   * Starting and polling an accredited-investor verification (E2.5 D6, `ACCREDITATION_DRIVER`).
   *
   * A port rather than a branch inside the round module because the alternative is the round
   * module knowing which bureau this install uses — and because the shipped driver, `manual`,
   * *has no remote side at all*: an admin reads the evidence and decides. `requires` is what the
   * flow above branches on, so adding a vendor adapter changes one env var and nothing else.
   * What the port deliberately does not own is the evidence blob: that is `storage` + `crypto` +
   * `scanner`, already on this interface, with a retention clock no vendor API models.
   */
  readonly accreditation: AccreditationServices;
  /**
   * Posting an alert to a team chat through an incoming webhook (E2.6, `@fundroom/chat-slack`).
   * A dedicated field for the reason `spreadsheets` is one: the adapter pins its destination host
   * and follows no redirect, so a module that can alert a channel does not thereby hold a general
   * outbound `fetch`.
   */
  readonly chat: ChatWebhookPort;
  /**
   * Workspace search index (E2.8, `@fundroom/search`). Modules keep their entries current at
   * write time on their own transaction; a full rebuild reads `ModuleManifest.search.entries`.
   */
  readonly search: SearchIndexService;
  /** Operator ceilings (`UPLOAD_MAX_BYTES`, `RENDER_MAX_BYTES`) and where staged uploads live. */
  readonly limits: {
    readonly uploadMaxBytes: number;
    readonly renderMaxBytes: number;
    readonly dataDir: string;
  };
  readonly mailer: MailerPort;
  readonly rateLimiter: RateLimiterPort;
  readonly registry: ModuleRegistryView;
  readonly enablement: EnablementView;
  /** Drops the cached `ResolvedWorkspace` after a settings write. */
  readonly workspaces: { invalidate(workspaceId?: string): void };
  /**
   * The kernel's legal-document library (E1.6). A module needs two things from it and must not
   * reach into `core.legal_document` to get them (principle 4): the current disclaimer to
   * render, and the stamp to write onto an immutable snapshot it is about to create
   * (`post_version.disclaimer_version`, `page_revision.disclaimer_version`).
   */
  readonly legal: LegalServices;
  /**
   * The kernel e-signature service (E3.5, ADR-0053): the workspace's vendor connection and its
   * envelopes. `request`/`void`/`signingUrl`/`readArtifact` make vendor or storage calls and run
   * their own short transactions — never call them while holding a transaction.
   */
  readonly esign: ESignServices;
  /**
   * The kernel integrations hub (E3.6, ADR-0054): third-party connections (KPI sources, the Slack
   * app, booking vendors). `readKpi`/`slackChannels`/`slackPost` make vendor calls and run their
   * own short transactions — never call them while holding a transaction.
   */
  readonly integrations: IntegrationServices;
  /**
   * The kernel AI assist service (E3.12, ADR-0060): start a request for one of this module's AI
   * tasks. `start` runs its own short transactions — never call it while holding a transaction;
   * `discardForSubject` is the exception (it runs inside the caller's).
   */
  readonly ai: AiServices;
  /**
   * Forensic watermark pattern keys (E3.13, ADR-0061), derived from the config key ring with
   * `deriveForensicPatternKey` (HKDF purpose `seed-host/forensic/pattern/v1`). `current()` keys
   * new marks; `get(keyId)` re-derives an older entry's key for detection — `undefined` once that
   * entry has left the ring (its marks can no longer be detected). Never the ring itself.
   */
  readonly forensicKeys: ForensicKeyServices;
  /** What share links force on their visitors' protection (E3.13). */
  readonly shareLinks: ShareLinkModuleServices;
  readonly guards: ModuleGuards;
  /**
   * Plan limits (E3.10, ADR-0058). `check` throws a 402 `plan_limit` (`PlanLimitError`-shaped:
   * `code`, `status`, `details.limit`, `details.max`) when adding `delta` of `kind` would exceed
   * the workspace's plan, and returns otherwise. A workspace without a plan (every self-hosted
   * one, and every workspace while CONTROL_PLANE=off) is unlimited, so this is a no-op there.
   * Call it inside the transaction that creates the thing it counts.
   */
  readonly quota: QuotaServices;
  /**
   * Plan entitlements (A-3, ADR-0063): which optional modules and features the workspace's plan
   * lets it turn on. Gate only the *turning on* (create, connect, a toggle's off→on transition) and
   * only after the route's own permission guard; disabling, deleting, rotating and reading are
   * never gated. `of(sg.workspace)` is pure; `forWorkspace(tx, id)` reads on the caller's
   * transaction. Everything is allowed unless CONTROL_PLANE=on and the workspace has a plan.
   * A module's own read-only state (on but outside the plan) is enforced by the kernel's
   * permission guard, not here.
   */
  readonly entitlements: EntitlementsPort;
  readonly baseUrl: URL;
  readonly tenancy: "single" | "multi";
  /**
   * Absolute URL of a path on a workspace's own origin: its verified custom domain when it has
   * one (E2.1 decision 5), else `https://<slug>.<canonical>/…` in multi-tenant mode, else the
   * base URL. Links in email (E1.4).
   *
   * Takes the workspace rather than its slug because `primaryHost` rides on the resolved row
   * that every request already has — never cold, which is what lets this stay synchronous.
   */
  workspaceUrl(workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">, path: string): URL;
  readonly trustProxy: boolean;
  readonly now: () => Date;
  readonly log: Log;
  /** Client IP for `RequestFacts` (first trusted `X-Forwarded-For` hop or the socket). */
  clientIp(c: Context<ModuleEnv>): string | undefined;
  /**
   * The request facts the evaluator's session-bound gates read (`min_auth_level`, `ip_allowlist`).
   *
   * It exists because `RequestFacts` was being built by hand in two places — the kernel's access
   * routes and the data room's — and two hand-rolled copies of a security-relevant object is the
   * next module's bug: a gate that silently sees `authLevel: undefined` fails *open* for
   * `min_auth_level`, and a missing `ip` does the same for `ip_allowlist`. One builder, and a
   * field added to `RequestFacts` reaches every caller at once (E2.3 contract §5.6).
   */
  requestFacts(c: Context<ModuleEnv>): RequestFacts;
}

/** `ModuleServices.forensicKeys` (E3.13). */
export interface ForensicKeyServices {
  current(): { readonly keyId: string; readonly patternKey: Uint8Array };
  get(keyId: string): Uint8Array | undefined;
}

/** `ModuleServices.shareLinks` (E3.13). Implemented by `@fundroom/share-links`. */
export interface ShareLinkModuleServices {
  /**
   * Whether `membershipId` is bound (a live share-link visit) to a link whose policy forces the
   * visible watermark. Only ever forces ON. Pass the caller's `tx` (fenced to `workspaceId`, any
   * actor kind) when holding one; without it the read takes its own short transaction.
   */
  forcedProtection(
    workspaceId: string,
    membershipId: string,
    tx?: Tx,
  ): Promise<{ readonly forceWatermark: boolean }>;
}

/** What a plan limits (E3.10); `emailsPerMonth` is reported only and has no check. */
export type QuotaKind = "staffSeats" | "investorSeats" | "storageBytes" | "customDomains";

export interface QuotaCheckInput {
  readonly workspaceId: string;
  readonly kind: QuotaKind;
  /** How many seats / domains / bytes the caller is about to add. */
  readonly delta: number;
}

/** `ModuleServices.quota` (E3.10). */
export interface QuotaServices {
  check(tx: Tx, input: QuotaCheckInput): Promise<void>;
}

/** The pass-through quota: every workspace is unlimited (self-host, CONTROL_PLANE=off). */
export const UNLIMITED_QUOTA: QuotaServices = Object.freeze({
  async check() {},
});

/**
 * The pass-through entitlements (A-3): every workspace may turn everything on. For tests and
 * tools that build `ModuleServices` by hand; the server's own (`createEntitlements`) is the same
 * thing while CONTROL_PLANE=off. Its asserts never throw: there is nothing to enforce.
 */
export const UNRESTRICTED_ENTITLEMENTS: EntitlementsPort = Object.freeze({
  of: () => ALL_ENTITLEMENTS,
  forWorkspace: async () => ALL_ENTITLEMENTS,
  assertFeature() {},
  assertModule() {},
});

/**
 * What a module contributes to a workspace's daily usage row (E3.10, `ModuleManifest.usage`).
 * Absent fields contribute nothing; several modules' answers are summed.
 */
export interface ModuleUsage {
  /** Bytes currently stored for the workspace (objects, renditions), as of the call. */
  readonly storageBytes?: number | undefined;
  /** Documents viewed on `day`. */
  readonly docsViewed?: number | undefined;
}

export interface ModuleUsageInput {
  readonly workspaceId: string;
  /** The UTC day being rolled up, `YYYY-MM-DD`. */
  readonly day: string;
}

/** Who a content block is being rendered for (after section visibility has been applied). */
export interface BlockViewer {
  readonly kind: "anonymous" | "external" | "staff";
  readonly membershipId?: string | undefined;
  readonly groupIds: readonly string[];
  /**
   * A delegate's scope (E3.2), `undefined`/`null` for everybody else. A hydrator for a module a
   * narrow scope does not admit (`@fundroom/domain` `delegationAdmitsModule`) returns nothing —
   * the second lock under RLS, and the only one for a system-context render such as an email.
   */
  readonly delegateScope?: "all" | "data_room" | "updates" | null | undefined;
}

export interface BlockHydrationContext {
  readonly tenant: TenantContext;
  readonly viewer: BlockViewer;
  readonly facts: RequestFacts;
  /**
   * Where the hydrated block is about to be rendered. `"web"` — the default, and what every
   * caller before E2.4 meant — is a page the viewer is looking at inside their own session.
   * `"email"` is a message that leaves the building.
   *
   * It exists because those two want different payloads, and the difference is not cosmetic.
   * A `metric_grid` rendered in an email has to carry a *capability URL* for its chart image,
   * because a mail client has no session; that URL is then valid for months, by design. The
   * same payload on the web would put a long-lived capability into an API response that a
   * session already protects — bytes that outlive the session they were issued under, for no
   * benefit, since the SPA draws the chart itself from geometry. So the hydrator mints one
   * only when asked for `"email"`.
   *
   * Optional, so every existing hydrator and every existing caller keeps its meaning.
   */
  readonly medium?: "web" | "email" | undefined;
  /**
   * The instant the rendering is *of*, so a retried render is byte-identical to the first.
   *
   * A hydrator that stamps `services.now()` is a function of the clock, not of the audience —
   * and a send is retried. `modules/updates` re-enqueues a stalled send (`retryLimit: 5`), so
   * a resumed send would hand two recipients **in the same audience** different bytes: two
   * `<img src>` capability URLs where decision D5 requires one, which partitions a recipient
   * list into retry cohorts and turns a shared URL back into something that identifies who
   * read when. The caller passes the send's own instant; a hydrator falls back to
   * `services.now()` when it is absent, which is every caller that has not opted in.
   */
  readonly asOf?: Date | undefined;
}

/**
 * Server-side hydration for content blocks that reference module data (`metric_grid`,
 * `document_list`): the content page stores ids only and asks the owning module for the
 * viewer-safe payload at render time, after visibility (design/06 §8). A module registers one
 * hydrator per block type it provides; a type nobody provides (or whose module is disabled
 * here) renders a fallback.
 */
export interface BlockHydrator {
  readonly type: string;
  hydrate(data: JsonObject, ctx: BlockHydrationContext): Promise<JsonObject>;
}

export interface NavSlotItem {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly order: number;
  readonly icon?: string | undefined;
}

/**
 * An entry of the `admin.settings` slot (E2.7): one workspace settings screen a manifest offers,
 * listed by the admin settings hub (`/admin/settings`) and linked from the modules page. Same
 * shape as a nav item; a separate name so the two slots can diverge without a rename.
 */
export type SettingsSlotItem = NavSlotItem;

/** Slot names with a known item shape. Any other slot stays `unknown[]` (see `slots`). */
export const ADMIN_NAV_SLOT = "admin.nav";
export const INVESTOR_NAV_SLOT = "investor.nav";
export const ADMIN_SETTINGS_SLOT = "admin.settings";

/**
 * The typed part of `ModuleManifest.slots`: the well-known slots and their item shapes, so a
 * manifest that puts a malformed item in one fails to compile instead of being dropped in
 * silence by the web shell's `isNavItem` filter. Other slots (`content.blocks`, …) remain
 * `readonly unknown[]` through the index signature.
 */
export interface KnownSlots {
  readonly [ADMIN_NAV_SLOT]?: readonly NavSlotItem[] | undefined;
  readonly [INVESTOR_NAV_SLOT]?: readonly NavSlotItem[] | undefined;
  readonly [ADMIN_SETTINGS_SLOT]?: readonly SettingsSlotItem[] | undefined;
}

export type ManifestSlots = Readonly<Record<string, readonly unknown[]>> & KnownSlots;

export interface FlagDefinition {
  readonly default: boolean;
  readonly description?: string | undefined;
}

export interface OfferingStatusRules {
  /** The module is hidden from investors (nav, bootstrap) when the workspace has one of these statuses. */
  readonly hiddenWhen?: readonly OfferingStatus[] | undefined;
  /**
   * The module is switched off entirely — for staff as well — when the workspace has one of
   * these statuses, and its routes answer 404 like any disabled module (E1.6, R3). `hiddenWhen`
   * is a nav decision; this is a compliance one: an `informational` workspace must not be able
   * to publish terms at all, not merely keep them off the investor's menu.
   *
   * **It applies to a `required` manifest too**: `required` governs whether a
   * `core.module_enablement` row may switch a module off — an administrator's preference — while
   * this governs whether the workspace's offering status permits it at all, which is a compliance
   * rule and not the administrator's to overrule. `isDisabledForOffering` used to short-circuit on
   * `required` and so made this field silently inert on every kernel manifest, which E2.3 found by
   * being the first to need it (ADR-0041).
   *
   * Dropping the module from the enabled set is not by itself enough for a kernel-owned feature,
   * because its routes are registered directly on the API app, above the per-module enablement
   * middleware. So the kernel route file enforces the same list itself (`requireOffering` in
   * `apps/server/src/middleware/authz.ts`); the two reading one exported constant is what keeps
   * them from drifting.
   */
  readonly disabledWhen?: readonly OfferingStatus[] | undefined;
}

/** What a module's DSAR exporter is given (E2.7, `ModuleManifest.dsar`). */
export interface DsarExportInput {
  /** The kernel's transaction: a `system` context of the subject's workspace, one per module. */
  readonly tx: Tx;
  readonly ctx: TenantContext;
  /** The data subject. */
  readonly membershipId: string;
  /**
   * What the modules this one declared in `ModuleDsar.after` exported for the same subject (by
   * module id; absent when that module is not compiled in or exported nothing). A module never
   * reads another's schema (ADR-0033); when the only link between its rows and the subject lives
   * in another module — a round commitment recorded against a CRM contact — it reads the ids from
   * that module's export instead, as it would from an event payload.
   */
  readonly related: Readonly<Record<string, JsonObject>>;
}

/**
 * A module's part of a subject access request (E2.7 DSAR, GDPR art. 15/20).
 *
 * `export` returns everything the module holds **about** the member, as plain JSON: it lands in
 * the export zip as `modules/<id>.json`. It must read only through the module's own repos, run
 * entirely on `input.tx` (never `services.db.withTenant` — the kernel holds that connection), and
 * leave out secrets (token hashes, encrypted envelopes, keys) and other people's personal data
 * (a staff member's note about the subject is the company's record, not the subject's; a module
 * decides and documents where that line falls for its own tables). The kernel calls every
 * compiled-in module's exporter — enabled for the workspace or not, as erasure does — each in its
 * own transaction, sequentially.
 */
export interface ModuleDsar {
  export(input: DsarExportInput): Promise<JsonObject>;
  /** Module ids whose export must run first and is handed over as `DsarExportInput.related`. */
  readonly after?: readonly string[] | undefined;
}

// ---------- Search (E2.8) ----------

/** Who may find a search entry. Enforced by RLS on `core.search_entry` (and `authz.check` for `resource`). */
export type SearchAcl =
  /** Any live member of the workspace. */
  | { readonly kind: "members" }
  /** Members of any of these groups. */
  | { readonly kind: "groups"; readonly groupIds: readonly string[] }
  /** Staff only. */
  | { readonly kind: "staff" }
  /** An authz grant on the resource (+ its gates at query time: a gated hit shows its title only). */
  | {
      readonly kind: "resource";
      readonly resourceKind: string;
      readonly resourceId: string;
      readonly path?: string | undefined;
    };

export interface SearchEntryInput {
  /** "document" | "page" | "post" | … */
  readonly kind: string;
  /** uuid of the entity the hit opens. */
  readonly refId: string;
  /** "" by default; e.g. a content section key. Hits are de-duplicated per (module, kind, refId). */
  readonly part?: string | undefined;
  readonly title: string;
  /** Plain text (strip markdown/HTML yourself); the engine truncates to 200 000 characters. */
  readonly body?: string | undefined;
  readonly acl: SearchAcl;
  /** SPA path, must start with "/" (e.g. "/data-room/documents/<id>", "/p/<slug>", "/updates/<id>"). */
  readonly href: string;
  readonly updatedAt: Date;
}

export interface SearchIndexService {
  /** Insert or replace entries (keyed by module, kind, refId, part) on the caller's tx. */
  upsert(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    entries: readonly SearchEntryInput[],
  ): Promise<void>;
  /** Replace every part of one ref atomically (delete all parts of (module, kind, refId), insert entries). */
  replace(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    kind: string,
    refId: string,
    entries: readonly SearchEntryInput[],
  ): Promise<void>;
  /** Remove one ref (all parts when `part` is undefined). */
  remove(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    ref: { readonly kind: string; readonly refId: string; readonly part?: string | undefined },
  ): Promise<void>;
  /**
   * Ask for a full rebuild of this module's entries for `ctx.workspaceId` (enqueues
   * `search.reindex` in-tx). Use for bulk changes that cannot be expressed as the targeted
   * updates below.
   */
  requestReindex(tx: Tx, ctx: TenantContext, module: string): Promise<void>;
  /**
   * Re-paths every `resource` entry of `module` whose ACL path is `from` or below it
   * (`acl_path <@ from`) to the same place under `to` (`to || subpath(acl_path, nlevel(from))`),
   * in one SQL statement on the caller's tx: no body is read or rewritten. For subtree moves — the
   * path changes in the same transaction as the move, so no entry is ever readable under a stale
   * path. Returns the number of entries changed. (E2.8 fix A, additive.)
   */
  moveAclPath(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    from: string,
    to: string,
  ): Promise<number>;
  /**
   * Empties the body of every part of the given refs (title, ACL and `updatedAt` untouched), on
   * the caller's tx: text that must stop being searchable now, without re-reading the source.
   * Returns the number of entries changed. (E2.8 fix A, additive.)
   */
  clearBodies(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    kind: string,
    refIds: readonly string[],
  ): Promise<number>;
}

/** One page of a paged full-rebuild provider (`ModuleSearch.page`). */
export interface SearchPage {
  readonly entries: readonly SearchEntryInput[];
  /** Opaque cursor of the next page, or null when this was the last one. */
  readonly next: string | null;
}

/**
 * A module's contribution to workspace search. `entries` yields EVERYTHING the module wants
 * indexed for `ctx.workspaceId` (used by full reindex); incremental changes go through
 * `services.search` at write time. Runs on `input.tx` only.
 */
export interface ModuleSearch {
  /** Bump to force a reindex of every workspace after deploy. */
  readonly version: number;
  entries(input: {
    readonly tx: Tx;
    readonly ctx: TenantContext;
  }): AsyncIterable<SearchEntryInput> | Promise<readonly SearchEntryInput[]>;
  /**
   * Optional paged form of `entries`, for modules with many or large entries (E2.8 fix A,
   * additive). When present the rebuild uses it INSTEAD of `entries`: each call runs in its own
   * short system-context transaction (`input.tx` — read through it only) and returns one bounded
   * page plus the cursor of the next (`null` = done; the first call gets `cursor: null`). A
   * rebuild then never holds a lock for longer than one page, so ordinary writes are not blocked
   * by it. Pages must together yield exactly what `entries` would; keyset cursors are expected
   * (rows may change between pages — a concurrent write indexes itself, see the README).
   */
  page?(input: {
    readonly tx: Tx;
    readonly ctx: TenantContext;
    readonly cursor: string | null;
  }): Promise<SearchPage>;
}

// ---------- Portability (E2.8 workspace export/import) ----------

export interface PortableBlob {
  /** Column holding the object storage key. */
  readonly keyColumn: string;
  /** jsonb SHE1 descriptor `{format:"she1",keyId,keyRef}`; absent => object stored plaintext. */
  readonly encryptionColumn?: string | undefined;
  /** Envelope purpose to re-encrypt under on import (required with `encryptionColumn`). */
  readonly purpose?: string | undefined;
  /** bytea sha256 of the plaintext, verified on export and import when present. */
  readonly sha256Column?: string | undefined;
  /** Missing object => keep the row and null the key column (else the export fails). */
  readonly optional?: boolean | undefined;
}

export interface PortableImportContext {
  /** The new workspace. */
  readonly workspaceId: string;
  readonly sourceWorkspaceId: string;
  readonly now: Date;
  /** Old uuid -> new uuid (identity if not an exported row id). */
  mapId(oldId: string): string;
  /** Remaps labels that are hyphenless uuids (data-room folder paths). */
  remapLtree(path: string): string;
  /** Remaps every uuid (hyphenated or not) inside an object key / free string. */
  remapKey(key: string): string;
}

export type PortableSkipReason =
  | "derived"
  | "transient"
  | "secret"
  | "keyed-hash"
  | "instance-local";

/** Export options a table can be conditional on (E2.8: `includeRawAnalytics`). */
export type PortableExportOption = "rawAnalytics";

export interface PortableTable {
  /** Unqualified; lives in `manifest.schema`. */
  readonly table: string;
  readonly mode: "rows" | "skip";
  /** Required when mode="skip": why it is not carried (documented in the export manifest). */
  readonly reason?: PortableSkipReason | undefined;
  /**
   * Columns dropped from the JSONL (secrets, keyed hashes). On import the DB default applies,
   * so they must be nullable or defaulted.
   */
  readonly omitColumns?: readonly string[] | undefined;
  readonly blobs?: readonly PortableBlob[] | undefined;
  /**
   * Export this table only when the named export option is on (`"rawAnalytics"` =
   * `includeRawAnalytics`); otherwise it is listed in the manifest as excluded and not written.
   */
  readonly includeWhen?: PortableExportOption | undefined;
  /** Optional per-row transform on export (after omitColumns). Return null to drop the row. */
  exportRow?(row: JsonObject): JsonObject | null;
  /** Optional per-row transform on import AFTER the engine's generic id remap. Return null to drop the row. */
  importRow?(row: JsonObject, ctx: PortableImportContext): JsonObject | null;
}

export interface ModulePortability {
  /** Format version of this module's section. */
  readonly version: number;
  /** EVERY table in `manifest.schema`, in FK dependency order (a test asserts none is missing). */
  readonly tables: readonly PortableTable[];
  /** Module ids whose tables must be imported first (cross-module FKs, e.g. crm before round). */
  readonly after?: readonly string[] | undefined;
  /**
   * Pre-import hook, on the import tx of the new workspace (system ctx), after core and the
   * `after` modules are inserted and before this module's first table (e.g. create partitions).
   * `rows` = source row count per table of this module (0/absent when skipped or excluded).
   */
  beforeImport?(input: {
    readonly tx: Tx;
    readonly ctx: TenantContext;
    readonly services: ModuleServices;
    readonly rows: Readonly<Record<string, number>>;
  }): Promise<void>;
  /**
   * Post-import hook, on a tx of the new workspace (system ctx). Enqueue re-derivation
   * (renditions, rollups) via `services.queue.sendInTransaction`.
   */
  afterImport?(input: {
    readonly tx: Tx;
    readonly ctx: TenantContext;
    readonly services: ModuleServices;
  }): Promise<void>;
}

export interface ModuleEvents {
  readonly emits?: readonly EventTopic[] | undefined;
  readonly handles?: Partial<Record<EventTopic, EventHandler>> | undefined;
}

/** How staff RBAC maps onto one of the module's resource kinds: capability → permission (ADR-0032). */
export interface ResourceKindPolicy {
  readonly staff: Partial<Readonly<Record<"view" | "download" | "comment" | "edit", string>>>;
}

export interface ModuleManifest {
  readonly id: string;
  /** SemVer; reported to the SPA. */
  readonly version: string;
  readonly dependsOn?: readonly string[] | undefined;
  /** Postgres schema the module owns (`dataroom.*`). Required when `migrations` is set. */
  readonly schema?: string | undefined;
  /** Directory of `NNNN_name.sql` files; journaled under the module id. */
  readonly migrations?: URL | string | undefined;
  /** `<id>.<verb>` capability strings; merged into the global catalogue. */
  readonly permissions?: readonly string[] | undefined;
  /** Mounted at `/api/v1/<id>`; `services` must be read inside handlers only. */
  readonly routes?: ((api: ModuleRouter, services: ModuleServices) => void) | undefined;
  /**
   * Non-OpenAPI endpoints mounted at `/api/v1/<id>` *before* the JSON body limit (tus
   * uploads, streamed bytes). Same session/CSRF/enablement chain; not in the contract, so
   * document them in the module README and keep them protocol-shaped.
   */
  readonly rawRoutes?: ((app: ModuleRawRouter, services: ModuleServices) => void) | undefined;
  /**
   * Job names must start with `<id>.`. A function receives `ModuleServices` (the composition
   * root builds it once the adapters exist) for jobs that need storage, crypto or the queue.
   */
  readonly jobs?:
    | readonly JobDefinition<JsonObject>[]
    | ((services: ModuleServices) => readonly JobDefinition<JsonObject>[])
    | undefined;
  readonly events?: ModuleEvents | undefined;
  /** Per-workspace settings (stored in `core.module_enablement.config`). */
  readonly settingsSchema?: z.ZodType | undefined;
  /** Flag keys must start with `<id>.`. */
  readonly flags?: Readonly<Record<string, FlagDefinition>> | undefined;
  /**
   * UI contribution points (`investor.nav`, `admin.nav`, `admin.settings`, `content.blocks`,
   * …). The bootstrap passes every slot through unchanged (`enablement.ts`), so a new slot needs
   * no server change — only a reader on the web side.
   */
  readonly slots?: ManifestSlots | undefined;
  readonly offeringStatusRules?: OfferingStatusRules | undefined;
  /**
   * Topics a workspace may subscribe outbound webhooks to (E3.4, ADR-0052). Each must be a
   * catalogue topic; a module package (one that owns a schema or declares `events.emits`) may
   * only offer topics it emits. Kernel manifests offer kernel topics (`access`:
   * `membership.created`, …). Offered to a workspace only while this module is enabled there.
   */
  readonly webhooks?: readonly string[] | undefined;
  /** Enabled for a workspace that has no `module_enablement` row. Default true. */
  readonly defaultEnabled?: boolean | undefined;
  /**
   * Kernel-owned: always enabled, an enablement row cannot switch it off (`access`). Other
   * modules may depend on it without a runtime enablement check.
   */
  readonly required?: boolean | undefined;
  /** Resource kinds this module owns, keyed by kind (`folder`, `document`, `post`), for `AuthzPort.check`. */
  readonly resourceKinds?: Readonly<Record<string, ResourceKindPolicy>> | undefined;
  /** Content block types this module hydrates (`content.blocks` slot names the same types). */
  readonly blockHydrators?: readonly BlockHydrator[] | undefined;
  /**
   * AI tasks this module offers (E3.12): at most one per feature across all modules. Built with
   * the module's services; called lazily (after the composition root exists), never at import.
   */
  readonly aiTasks?: ((services: ModuleServices) => readonly AiTaskDefinition[]) | undefined;
  /** Context this module offers other modules' AI tasks (E3.12), keyed globally by `key`. */
  readonly aiContextProviders?:
    | ((services: ModuleServices) => readonly AiContextProvider[])
    | undefined;
  /** Subject-access export (E2.7): what this module holds about one member; see `ModuleDsar`. */
  readonly dsar?: ModuleDsar | undefined;
  /** Workspace search (E2.8): what this module indexes; see `ModuleSearch`. */
  readonly search?: ModuleSearch | undefined;
  /** Workspace export/import (E2.8): how this module's tables travel; see `ModulePortability`. */
  readonly portability?: ModulePortability | undefined;
  /**
   * Usage metering (E3.10, the `control-plane.usage-rollup` job). Called once per workspace per
   * rollup with `tx` in that workspace's **system** context — whether or not the module is enabled
   * there (a disabled module's stored bytes still count). Read-only: count, never write.
   */
  readonly usage?: ((tx: Tx, input: ModuleUsageInput) => Promise<ModuleUsage>) | undefined;
}

export class ModuleManifestError extends Error {
  override readonly name = "ModuleManifestError";
}

/**
 * Thrown by a module's `afterImport` when the imported rows break an invariant the module relies
 * on (e.g. a data-room folder whose ltree path is not its parent's path plus its own id — ACL
 * paths are derived from it). The importer refuses the whole import with the message
 * (`PortabilityError` `invalid_input`); any other error is an import failure, not a refusal.
 */
export class PortableImportRefusal extends Error {
  override readonly name = "PortableImportRefusal";
}

/** Validates the manifest shape at import time so a broken module fails the build, not a request. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  const { id } = manifest;
  if (!MODULE_ID_RE.test(id))
    throw new ModuleManifestError(`module id ${JSON.stringify(id)} must be kebab-case`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new ModuleManifestError(
      `${id}: version ${JSON.stringify(manifest.version)} is not SemVer`,
    );
  }
  if (manifest.dependsOn?.includes(id)) throw new ModuleManifestError(`${id} depends on itself`);
  if (manifest.schema !== undefined && !PG_SCHEMA_RE.test(manifest.schema)) {
    throw new ModuleManifestError(
      `${id}: schema ${JSON.stringify(manifest.schema)} is not a valid identifier`,
    );
  }
  if (manifest.migrations !== undefined && manifest.schema === undefined) {
    throw new ModuleManifestError(
      `${id}: modules with migrations must declare the schema they own`,
    );
  }
  for (const p of manifest.permissions ?? []) {
    if (!PERMISSION_RE.test(p) || !p.startsWith(`${id}.`)) {
      throw new ModuleManifestError(
        `${id}: permission ${JSON.stringify(p)} must be "${id}.<verb>"`,
      );
    }
  }
  for (const job of Array.isArray(manifest.jobs) ? manifest.jobs : []) {
    if (!job.name.startsWith(`${id}.`)) {
      throw new ModuleManifestError(
        `${id}: job ${JSON.stringify(job.name)} must be "${id}.<verb>"`,
      );
    }
  }
  for (const key of Object.keys(manifest.flags ?? {})) {
    if (!FLAG_RE.test(key) || !key.startsWith(`${id}.`)) {
      throw new ModuleManifestError(`${id}: flag ${JSON.stringify(key)} must be "${id}.<name>"`);
    }
  }
  for (const [kind, policy] of Object.entries(manifest.resourceKinds ?? {})) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(kind)) {
      throw new ModuleManifestError(
        `${id}: resource kind ${JSON.stringify(kind)} is not kebab/snake case`,
      );
    }
    for (const perm of Object.values(policy.staff)) {
      if (perm !== undefined && !(manifest.permissions ?? []).includes(perm)) {
        throw new ModuleManifestError(
          `${id}: resource kind ${kind} names permission ${perm}, which the module does not declare`,
        );
      }
    }
  }
  const seenBlocks = new Set<string>();
  for (const h of manifest.blockHydrators ?? []) {
    if (!/^[a-z][a-z0-9_]*$/u.test(h.type)) {
      throw new ModuleManifestError(
        `${id}: block type ${JSON.stringify(h.type)} is not snake_case`,
      );
    }
    if (seenBlocks.has(h.type))
      throw new ModuleManifestError(`${id}: block hydrator ${h.type} declared twice`);
    seenBlocks.add(h.type);
  }
  if (manifest.search !== undefined) {
    if (!Number.isInteger(manifest.search.version) || manifest.search.version < 1) {
      throw new ModuleManifestError(`${id}: search.version must be a positive integer`);
    }
  }
  if (manifest.portability !== undefined) {
    const p = manifest.portability;
    if (!Number.isInteger(p.version) || p.version < 1) {
      throw new ModuleManifestError(`${id}: portability.version must be a positive integer`);
    }
    if (p.tables.length > 0 && manifest.schema === undefined) {
      throw new ModuleManifestError(`${id}: portability tables need the schema the module owns`);
    }
    if (p.after?.includes(id)) throw new ModuleManifestError(`${id}: portability after itself`);
    const seenTables = new Set<string>();
    for (const t of p.tables) {
      if (!PG_SCHEMA_RE.test(t.table)) {
        throw new ModuleManifestError(
          `${id}: portability table ${JSON.stringify(t.table)} is not a valid identifier`,
        );
      }
      if (seenTables.has(t.table)) {
        throw new ModuleManifestError(`${id}: portability table ${t.table} declared twice`);
      }
      seenTables.add(t.table);
      if (t.mode === "skip" && t.reason === undefined) {
        throw new ModuleManifestError(`${id}: skipped portability table ${t.table} needs a reason`);
      }
      if (t.mode === "skip" && t.includeWhen !== undefined) {
        throw new ModuleManifestError(
          `${id}: skipped portability table ${t.table} has includeWhen`,
        );
      }
      if (t.mode === "skip" && (t.blobs?.length ?? 0) > 0) {
        throw new ModuleManifestError(`${id}: skipped portability table ${t.table} declares blobs`);
      }
      for (const b of t.blobs ?? []) {
        if (b.encryptionColumn !== undefined && b.purpose === undefined) {
          throw new ModuleManifestError(
            `${id}: portability blob ${t.table}.${b.keyColumn} has an encryption column but no purpose`,
          );
        }
      }
    }
  }
  const seenWebhooks = new Set<string>();
  const emits = manifest.events?.emits;
  const mustEmit = manifest.schema !== undefined || emits !== undefined;
  for (const topic of manifest.webhooks ?? []) {
    if (!isEventTopic(topic)) {
      throw new ModuleManifestError(
        `${id}: webhook topic ${JSON.stringify(topic)} is not an event`,
      );
    }
    if (mustEmit && !(emits ?? []).includes(topic)) {
      throw new ModuleManifestError(
        `${id}: webhook topic ${topic} is not in the module's events.emits`,
      );
    }
    if (seenWebhooks.has(topic)) {
      throw new ModuleManifestError(`${id}: webhook topic ${topic} declared twice`);
    }
    seenWebhooks.add(topic);
  }
  if (manifest.required === true && manifest.defaultEnabled === false) {
    throw new ModuleManifestError(`${id}: a required module cannot default to disabled`);
  }
  return Object.freeze({ ...manifest });
}

/**
 * Whether `services` is the live composition root rather than the throwing stub
 * `generateOpenApiDocument()` registers routes against.
 *
 * It exists because a module that wants its services *outside* a handler — a block hydrator,
 * a job factory — has to capture them from the `routes` callback, and that callback runs twice
 * with different arguments. Once at boot with the real thing, and again, against the stub,
 * every time somebody fetches `GET /api/v1/openapi.json`, which is a live route. A module that
 * assigns unconditionally therefore has its captured services *replaced by the stub* the first
 * time anyone reads the contract, and stays broken for the life of the process: the hydrator
 * throws, `renderSections` reports `hydration_failed`, and an investor's page shows an
 * apology for a block that was working a minute ago. Nothing in the logs connects the two.
 *
 * E1.2's `content` module and E1.3's `data-room` both shipped with that bug; E2.4 found it.
 * The probe is a property read because the stub is a `Proxy` that throws on access — there is
 * no flag to test, and adding one would mean the stub could be forged by anything that set it.
 */
export function isLiveModuleServices(services: ModuleServices): boolean {
  try {
    void services.db;
    return true;
  } catch {
    return false;
  }
}

/** Handy for handlers: the tenant context or a 404-shaped failure the kernel renders. */
export function tenantOf(c: Context<ModuleEnv>): TenantContext {
  const tenant = c.get("tenant");
  if (tenant === undefined) throw new ModuleManifestError("route requires a tenant context");
  return tenant;
}
