import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import type { Database, MembershipKind, TenantContext, Tx } from "@fundroom/db";
import type {
  ESignConnectionSummary,
  ESignEnvelopeRowStatus,
  ESignEnvelopeView,
  ESignPurpose,
  ESignServices,
} from "@fundroom/module-kit";
import type {
  ESignAdapterDefinition,
  ESignCredentialField,
  ESignDriver,
  ESignVendorMeta,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  ObjectStoragePort,
  OutboundFetch,
  VirusScanPort,
} from "@fundroom/ports";

export type {
  ESignConnectionSummary,
  ESignEnvelopeRowStatus,
  ESignEnvelopeView,
  ESignPurpose,
  ESignServices,
};

/** Workspace key purposes (ADR-0016): sealed connection columns, and artifact objects. */
export const ESIGN_KEY_PURPOSES = {
  credentials: "esign-credentials",
  artifact: "esign-artifact",
} as const;

export const ESIGN_JOBS = {
  sync: "esign.sync",
  collect: "esign.collect",
  syncDue: "esign.sync-due",
  void: "esign.void",
} as const;

/** `esign.sync-due` runs every five minutes. */
export const ESIGN_SYNC_DUE_CRON = "*/5 * * * *";

/** At most this many rows are claimed per workspace per sweep turn. */
export const ESIGN_SWEEP_BATCH = 100;

export const NDA_VAULT_FOLDER = "Signed documents/NDAs";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/**
 * What the collect job needs of the click-wrap acceptance service to record an e-signed NDA
 * (`@fundroom/compliance` `createAcceptanceService(...)` satisfies it structurally — this package
 * does not import compliance, which imports this one for erasure). With `method: "esign"` the
 * compliance service records the acceptance with our `evidenceRef` and issues no click-wrap
 * certificate (the vendor's signed PDF + certificate are the evidence).
 */
export interface ESignAcceptances {
  accept(
    ctx: TenantContext,
    tx: Tx,
    input: {
      readonly membershipId: string;
      readonly documentId: string;
      readonly versionNo: number;
      readonly evidence: { readonly evidenceRef: string; readonly method: "esign" };
    },
  ): Promise<{ readonly recorded: boolean }>;
  /**
   * The ONE "is this document pending for this member" predicate (E3.5 fixes A7/B3), shared with
   * `GET /compliance/gates`: the member must still accept it — it is in their `pendingFor` set, or
   * a live `nda` policy gate that applies to them names it and they do not hold its current stamp.
   */
  isPendingFor(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
    documentId: string,
  ): Promise<boolean>;
}

export interface ESignLegal {
  isErased(tx: Tx, ctx: TenantContext, membershipId: string): Promise<boolean>;
}

/** The outbound guard's static check (`OutboundHttp.assess`). */
export type AssessVerdict =
  | { readonly ok: true; readonly url: URL; readonly exempt: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type Assess = (url: string | URL) => AssessVerdict;

export interface ESignOutbound {
  readonly fetch: OutboundFetch;
  readonly assess: Assess;
}

export interface ESignServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly crypto: Pick<EnvelopeService, "currentKey" | "keyById">;
  readonly storage: Pick<ObjectStoragePort, "put" | "get" | "delete">;
  readonly scanner: Pick<VirusScanPort, "scan">;
  /** The dedicated e-sign guarded client (`container.esignOutbound`): no redirects, 15 s. */
  readonly outbound: ESignOutbound;
  /** Every adapter by driver (`container.esignAdapters`). */
  readonly adapters: Readonly<Record<ESignDriver, ESignAdapterDefinition>>;
  /** Drivers offered to workspaces (`ESIGN_DRIVERS`). Default: every adapter. */
  readonly drivers?: readonly ESignDriver[] | undefined;
  readonly acceptances: ESignAcceptances;
  readonly legal: ESignLegal;
  /** The instance's canonical base URL; the vendor callback URL is built on its origin. */
  readonly baseUrl: URL;
  /**
   * The vendor callback URL for a connection, when the server mounts it somewhere `baseUrl`'s
   * origin alone does not say (BASE_PATH). Default: `<baseUrl origin>/webhooks/esign/<id>`.
   */
  readonly callbackUrl?: ((connectionId: string) => string) | undefined;
  /** `ESIGN_MAX_ARTIFACT_BYTES`: a signed artifact larger than this is refused. */
  readonly maxArtifactBytes: number;
  /** Counts a security event (server `countSecurityEvent`); summary only, never a name. */
  readonly securityEvent?:
    | ((event: "esign_artifact_infected", fields: Readonly<Record<string, unknown>>) => void)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

/** Who asked, for the audit row. */
export interface ESignActor {
  readonly membershipId: string | null;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface ESignDriverInfo {
  readonly meta: ESignVendorMeta;
  readonly credentialFields: readonly ESignCredentialField[];
}

export interface ESignConnectionDetail extends ESignConnectionSummary {
  readonly id: string;
  readonly callbackUrl: string;
  /** "ours": we minted the callback secret (rotatable); "vendor": it is one of the credentials. */
  readonly callbackSecretKind: "ours" | "vendor";
  readonly credentialHints: Readonly<Record<string, string>>;
  readonly lastVerifiedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveConnectionInput {
  readonly driver: ESignDriver;
  /**
   * A self-hosted vendor's address. Blank / omitted on a SAME-driver save keeps the stored address
   * (FX2A); a different typed address is a change (every secret re-entered, no open envelopes). To
   * move to the vendor's cloud, type the cloud URL. On a new or switched driver, blank = the cloud.
   */
  readonly baseUrl?: string | null | undefined;
  readonly credentials: Readonly<Record<string, string>>;
  /**
   * E3.5 fix A5: OPTIONAL credential keys whose stored value is removed (a blank field keeps it).
   * A required key → 400 `cannot_clear_required`; a key also given a value → 400 `clear_conflict`.
   */
  readonly clearCredentials?: readonly string[] | undefined;
  /**
   * A-3 (ADR-0063): called when the save would CREATE a connection — none is live, or the driver
   * changes — and throws to refuse it (the plan's 402). Re-keying the live connection of the same
   * driver is maintenance and never calls it: a leaked key must be rotatable after a downgrade.
   * Called once before the vendor is contacted and again under the singleton lock (authoritative).
   */
  readonly assertMayConnect?: (() => void) | undefined;
}

export interface EnvelopeListQuery {
  readonly status?: ESignEnvelopeRowStatus | undefined;
  readonly purpose?: ESignPurpose | undefined;
  readonly membershipId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface StartNdaInput {
  readonly membershipId: string;
  readonly documentId: string;
  readonly consentToElectronicRecords: boolean;
  readonly disclosureVersion: number;
  /** Where the vendor sends the signer back (the portal page that polls `ndaStatus`). */
  readonly returnUrl: string;
}

/**
 * `failed` (E3.5 fix A11): the current version's envelope completed at the vendor but its signed
 * copy could not be collected (too large, not a PDF, infected, …), so the gate cannot open from
 * it. A fresh `startNda` is allowed and supersedes it.
 */
export type NdaStatus = "none" | "open" | "completed" | "superseded" | "failed";

export interface CallbackOutcome {
  readonly status: 200 | 401 | 404 | 429;
  readonly driver?: ESignDriver | undefined;
}

/** The kernel service: `ModuleServices.esign` plus what the kernel routes and jobs need. */
export interface ESignKernel extends ESignServices {
  drivers(): ESignDriverInfo[];
  connectionDetail(ctx: TenantContext): Promise<ESignConnectionDetail | undefined>;
  saveConnection(
    ctx: TenantContext,
    input: SaveConnectionInput,
    actor: ESignActor,
  ): Promise<{ connection: ESignConnectionDetail; callbackSecret?: string }>;
  verifyConnection(ctx: TenantContext, actor: ESignActor): Promise<ESignConnectionDetail>;
  rotateCallbackSecret(
    ctx: TenantContext,
    actor: ESignActor,
  ): Promise<{ connection: ESignConnectionDetail; callbackSecret: string }>;
  deleteConnection(ctx: TenantContext, actor: ESignActor): Promise<void>;
  listEnvelopes(
    ctx: TenantContext,
    query: EnvelopeListQuery,
  ): Promise<{ items: ESignEnvelopeView[]; nextCursor: string | null }>;
  downloadArtifact(
    ctx: TenantContext,
    envelopeId: string,
    which: "signed" | "certificate",
    actor: ESignActor,
    options?: { readonly ownMembershipId?: string | undefined },
  ): Promise<{ bytes: Uint8Array; filename: string } | undefined>;
  requestSync(
    ctx: TenantContext,
    envelopeId: string,
    actor: ESignActor,
  ): Promise<ESignEnvelopeView>;
  startNda(
    ctx: TenantContext,
    input: StartNdaInput,
    actor: ESignActor,
  ): Promise<{ envelope: ESignEnvelopeView; signingUrl: string | null }>;
  ndaStatus(
    ctx: TenantContext,
    membershipId: string,
    documentId: string,
  ): Promise<{ status: NdaStatus; envelopeId: string | null }>;
  /**
   * `options.admit` is called once, right after the callback authenticated and before any
   * lookup or enqueue; `false` → `{status: 429}` (the route's post-auth budget).
   */
  ingestCallback(
    connectionId: string,
    request: { readonly headers: Headers; readonly body: Uint8Array },
    options?: { readonly admit?: (() => boolean) | undefined },
  ): Promise<CallbackOutcome>;
  /**
   * For the compliance route setting a document's ceremony to `esign`, inside ITS transaction and
   * before its first audit entry: takes the e-sign connection lock and refuses (409
   * `esign_not_configured`) without a live connection. Same as `assertESignConnected`.
   */
  assertCeremonyAllowed(tx: Tx, ctx: TenantContext): Promise<void>;
  onDocumentVaulted(
    tx: Tx,
    ctx: TenantContext,
    payload: {
      readonly documentId: string;
      readonly versionId: string;
      readonly envelopeId: string;
    },
  ): Promise<void>;
  /** DSAR: the member's signed artifacts, `esign/<envelopeId>-signed.pdf` → bytes. */
  subjectArtifacts(workspaceId: string, membershipId: string): Promise<Record<string, Uint8Array>>;
  readonly jobs: readonly JobDefinition<JsonObject>[];
}
