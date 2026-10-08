import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import type { Database, TenantContext } from "@fundroom/db";
import type { AccreditationServices } from "@fundroom/module-kit";
import type {
  AccreditationAdapterDefinition,
  AccreditationCredentialField,
  AccreditationVendorDriver,
  AccreditationVendorMeta,
} from "@fundroom/ports";

/** Workspace key purpose (ADR-0016) of the sealed connection credentials. */
export const ACCREDITATION_KEY_PURPOSE = "accreditation-credentials";

/** The manual driver's label and needs (E2.5: the investor uploads, an admin decides). */
export const MANUAL_LABEL = "Manual review";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface AccreditationServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly crypto: Pick<EnvelopeService, "currentKey" | "keyById">;
  /**
   * The dedicated guarded client (`container.accreditationOutbound`): no redirects, 15 s, private
   * hosts only through ACCREDITATION_ALLOW_PRIVATE_HOSTS. The only client a vendor credential
   * ever rides on.
   */
  readonly fetch: typeof fetch;
  /** Every adapter by driver (`container.accreditationAdapters`). */
  readonly adapters: Readonly<
    Partial<Record<AccreditationVendorDriver, AccreditationAdapterDefinition>>
  >;
  /** Drivers offered to workspaces (`ACCREDITATION_DRIVERS`). Default: every adapter. */
  readonly drivers?: readonly AccreditationVendorDriver[] | undefined;
  /** Test seam only: per-driver vendor API base URL (`AccreditationAdapterDeps.apiBaseUrl`). */
  readonly apiBaseUrls?: Readonly<Partial<Record<AccreditationVendorDriver, string>>> | undefined;
  /** What the manual driver requires (the E2.5 port's `requires`). Default: both. */
  readonly manualRequires?:
    | { readonly evidenceUpload: boolean; readonly adminDecision: boolean }
    | undefined;
  /** The vendor callback URL for a connection id (canonical origin + BASE_PATH). */
  readonly callbackUrl: (connectionId: string) => string;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

/** Who asked, for the audit row. */
export interface AccreditationActor {
  readonly membershipId: string | null;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface AccreditationProviderInfo {
  readonly meta: AccreditationVendorMeta;
  readonly credentialFields: readonly AccreditationCredentialField[];
  /** In `ACCREDITATION_DRIVERS`. */
  readonly offered: boolean;
}

/** The contract's `AccreditationConnection` minus `handoffUrl` (the route adds the workspace URL). */
export interface AccreditationConnectionDetail {
  readonly id: string;
  readonly driver: AccreditationVendorDriver;
  readonly label: string;
  readonly environment: string;
  readonly credentialHints: Readonly<Record<string, string>>;
  readonly status: "active" | "error";
  readonly lastVerifiedAt: string | null;
  readonly lastError: string | null;
  readonly lastCallbackAt: string | null;
  readonly callbackUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveAccreditationConnectionInput {
  readonly driver: AccreditationVendorDriver;
  readonly credentials: Readonly<Record<string, string>>;
  /** Same-driver save: OPTIONAL secret keys whose stored value is forgotten. */
  readonly clearCredentials?: readonly string[] | undefined;
  /**
   * A-3 (ADR-0063): called when the save would CREATE a connection — none is live, or the vendor
   * changes — and throws to refuse it (the plan's 402). Re-keying the live connection of the same
   * vendor is maintenance and never calls it. Called once before the vendor is contacted and again
   * under the singleton lock (authoritative).
   */
  readonly assertMayConnect?: (() => void) | undefined;
}

export interface AccreditationCallbackOutcome {
  /** 401 = unknown/deleted connection, non-uuid id, or not authentic (one answer for all). */
  readonly status: 200 | 401 | 429;
  readonly driver?: AccreditationVendorDriver | undefined;
}

/** The kernel service: `ModuleServices.accreditation` plus what the kernel routes need. */
export interface AccreditationKernel extends AccreditationServices {
  providers(): AccreditationProviderInfo[];
  connection(ctx: TenantContext): Promise<AccreditationConnectionDetail | undefined>;
  saveConnection(
    ctx: TenantContext,
    input: SaveAccreditationConnectionInput,
    actor: AccreditationActor,
  ): Promise<AccreditationConnectionDetail>;
  verifyConnection(
    ctx: TenantContext,
    actor: AccreditationActor,
  ): Promise<AccreditationConnectionDetail>;
  deleteConnection(ctx: TenantContext, actor: AccreditationActor): Promise<void>;
  /**
   * The ops callback. Authenticates through the connection's adapter FIRST; `options.admit` is
   * called once, right after authentication and before any write — `false` → `{status: 429}`.
   * On an authentic, admitted callback: `last_callback_at` and one `accreditation.provider_updated`
   * outbox row (when it named refs), in one tenant transaction.
   */
  ingestCallback(
    connectionId: string,
    request: { readonly headers: Headers; readonly rawBody: Uint8Array },
    options?: { readonly admit?: (() => boolean) | undefined },
  ): Promise<AccreditationCallbackOutcome>;
}
