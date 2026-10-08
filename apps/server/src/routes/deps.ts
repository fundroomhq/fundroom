import type { AccreditationKernel } from "@fundroom/accreditation";
import type { AiKernel } from "@fundroom/ai";
import type { ApiKeyService } from "@fundroom/api-keys";
import type { AuditService } from "@fundroom/audit";
import type { AuthzService } from "@fundroom/authz";
import { createLegalPort, isComplianceError } from "@fundroom/compliance";
import type { KeyRing, TenancyMode } from "@fundroom/config";
import { ApiError } from "@fundroom/contracts";
import type { EnvelopeService } from "@fundroom/crypto";
import type { CustomDomainLookup, CustomDomainService } from "@fundroom/custom-domains";
import type {
  Database,
  Membership,
  ResolvedWorkspace,
  TenantContext,
  WorkspaceResolver,
} from "@fundroom/db";
import type { ESignKernel } from "@fundroom/esign";
import { deriveForensicPatternKey } from "@fundroom/forensic";
import {
  cloudflareClientIp,
  type EdgeForwardingOptions,
  edgeForwardedOf,
  forwardedClientIp,
  normalizeIp,
  ONE_PROXY,
  type ProxyTrust,
} from "@fundroom/http";
import type {
  AccessRequestService,
  AuthService,
  HandoffService,
  IdentityDeps,
} from "@fundroom/identity";
import type { IntegrationsKernel } from "@fundroom/integrations";
import {
  type AiServices,
  type EnablementCache,
  type ModuleEnv,
  type ModuleRegistry,
  type ModuleServices,
  registryViewOf,
  type SearchIndexService,
} from "@fundroom/module-kit";
import type {
  AuditAnchorPort,
  ChatWebhookPort,
  DirectoryPort,
  DnsResolverPort,
  DocumentRenderPort,
  EntitlementsPort,
  JobQueuePort,
  MailerPort,
  ObjectStoragePort,
  OutboundHttpPort,
  RateLimiterPort,
  RequestFacts,
  SpreadsheetPort,
  VirusScanPort,
} from "@fundroom/ports";
import type { ScimService } from "@fundroom/scim";
import { createShareLinkProtection } from "@fundroom/share-links";
import type { SsoService } from "@fundroom/sso";
import type { UpdateChecker } from "@fundroom/update-check";
import type { WebhookService } from "@fundroom/webhooks";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { CertProbe } from "../cert-probe.js";
import type {
  BillingKernel,
  CentralAuthKernel,
  ControlPlaneKernel,
  SanctionsKernel,
} from "../control-plane/kernel.js";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import type { MailFeedback } from "../mail/feedback.js";
import type { AcceptanceGate } from "../middleware/authz.js";
import { requireMember, requirePermission } from "../middleware/authz.js";
import type { Readiness } from "../readiness.js";
import type { ResidencyKernel } from "../residency/kernel.js";
import type { SetupGate } from "../setup/gate.js";
import type { SetupToken } from "../setup/token.js";

/**
 * What route handlers need. Read only inside handlers, never at registration time, so
 * `generateOpenApiDocument()` can register every route against a throwing stub.
 */
/** What `ModuleServices` is built from; the composition root has it before any route exists. */
export interface ModuleServiceDeps {
  readonly db: Database;
  readonly registry: ModuleRegistry;
  readonly enablement: EnablementCache;
  readonly baseUrl: URL;
  readonly tenancy: TenancyMode;
  /** BASE_PATH: a custom domain's URLs hang off it (see `workspaceUrl`). */
  readonly basePath?: string | undefined;
  /**
   * TRUST_PROXY (+ TRUST_PROXY_HOPS / CLIENT_IP_HEADER, E2.10 F-07). `false`: no proxy is
   * trusted. `true`: one appending proxy. A `ProxyTrust`: as configured.
   */
  readonly trustProxy: boolean | ProxyTrust;
  readonly log: Log;
  readonly resolver: WorkspaceResolver;
  readonly mailer: MailerPort;
  readonly storage: ObjectStoragePort;
  readonly audit: AuditService;
  readonly rateLimiter: RateLimiterPort;
  readonly authz: AuthzService;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  // --- data room (E1.3) ---
  readonly crypto: EnvelopeService;
  readonly scanner: VirusScanPort;
  readonly renderer: DocumentRenderPort;
  readonly limits: ModuleServices["limits"];
  // --- custom / sending domains (E2.1) ---
  /** The shared DoH resolver; see `ModuleServices.dns`. */
  readonly dns: DnsResolverPort;
  // --- KPIs (E2.4) ---
  /** Read-only spreadsheet access; see `ModuleServices.spreadsheets`. */
  readonly spreadsheets: SpreadsheetPort;
  // --- round, interest and accreditation (E2.5) ---
  /**
   * Accreditation providers (E2.5 `ACCREDITATION_DRIVER`, E3.7 vendor connections): the kernel
   * `@fundroom/accreditation` service — `ModuleServices.accreditation` plus the connection and
   * callback operations only kernel routes use.
   */
  readonly accreditation: AccreditationKernel;
  // --- analytics & notifications (E2.6) ---
  /** Slack incoming webhooks behind their own guarded agent; see `ModuleServices.chat`. */
  readonly chat: ChatWebhookPort;
  // --- search (E2.8) ---
  /** The workspace search index modules write through; see `ModuleServices.search`. */
  readonly search: SearchIndexService;
  // --- e-signature (E3.5) ---
  /**
   * The kernel e-sign service (E3.5): `ModuleServices.esign` plus the connection, register,
   * NDA-ceremony and callback operations only kernel routes use.
   */
  readonly esign: ESignKernel;
  // --- integrations hub (E3.6) ---
  /**
   * The kernel integrations service (E3.6): `ModuleServices.integrations` (its `services`) plus
   * the connection, OAuth, booking-link and webhook operations only kernel routes use.
   */
  readonly integrations: IntegrationsKernel;
  // --- managed-host control plane (E3.10) ---
  /** Plan limits; see `ModuleServices.quota` (the pass-through until a plan is set). */
  readonly quota: ModuleServices["quota"];
  /**
   * Plan entitlements (A-3, ADR-0063): `of(workspace)` / `assertFeature` for kernel routes (use
   * `requireFeature` from `middleware/entitlements.ts` for an unconditional gate); the same object
   * is `ModuleServices.entitlements`. Enforced only while CONTROL_PLANE=on, for workspaces with a plan.
   */
  readonly entitlements: EntitlementsPort;
  // --- AI assist (E3.12) ---
  /** The kernel AI service modules start requests through; see `ModuleServices.ai`. */
  readonly ai: AiServices;
  // --- evidence (E3.13) ---
  /**
   * The config key ring. Modules never receive it: `ModuleServices.forensicKeys` hands out only
   * the HKDF-derived forensic pattern keys (see `forensicKeysOf`).
   */
  readonly keyRing: KeyRing;
}

export interface ApiDeps extends ModuleServiceDeps {
  /** AI assist (E3.12): settings, status and the caller's requests (`routes/ai.ts`). */
  readonly aiKernel: AiKernel;
  /** External audit anchoring (E3.13): the configured drivers; empty = off (`routes/audit-anchors.ts`). */
  readonly auditAnchoring: {
    readonly drivers: readonly AuditAnchorPort[];
    /** Offline verifiers by kind over every pinned cert / log key (incl. verification-only pins). */
    readonly verifiers: Readonly<Record<string, AuditAnchorPort["verify"]>>;
  };
  /**
   * The managed-host control plane (E3.10, ADR-0058): operators, workspaces, cells, signup (A) and
   * plans, usage, quotas (M). Kernel-only: status, cell and plan are read during tenant resolution.
   */
  readonly controlPlane: ControlPlaneKernel;
  /** Subscriptions and the provider webhook (E3.10). */
  readonly billing: BillingKernel;
  /** Sanctions screening (E3.10); operator routes only — tenants never see it. */
  readonly sanctions: SanctionsKernel;
  /** The cell directory (E3.11): `local` or `shared` (DIRECTORY_DATABASE_URL). */
  readonly directory: DirectoryPort;
  /** The deployment's operator-declared residency facts (E3.11). */
  readonly residency: ResidencyKernel;
  /** The central auth origin (E3.10, CENTRAL_AUTH). */
  readonly centralAuth: CentralAuthKernel;
  /**
   * `PLATFORM_OPERATOR_CIDRS` (E3.10): where operator sessions may come from; empty = anywhere.
   * Read by `requirePlatformOperator()` and the operator-session mint.
   */
  readonly platformOperatorCidrs: readonly string[];
  readonly auth: AuthService;
  /**
   * Staff SSO (E3.8, ADR-0056). Kernel-only: enforcement is read during tenant resolution and the
   * login flow runs before module enablement is knowable.
   */
  readonly sso: SsoService;
  /** SCIM 2.0 provisioning's admin side (E3.8): tokens, users, group → role mapping. */
  readonly scim: ScimService;
  /** Access requests & the approval queue (E3.1). Kernel-only: `core.access_request`. */
  readonly accessRequests: AccessRequestService;
  /**
   * Workspace API keys (E3.4). Kernel-only: the bearer lookup runs during tenant resolution, so
   * nothing a module could switch off may decide who a caller is.
   */
  readonly apiKeys: ApiKeyService;
  /**
   * Outbound webhooks (E3.4-B). Kernel-only: delivery needs the guarded outbound agent, and the
   * fan-out listens to every module's topics.
   */
  readonly webhooks: WebhookService;
  /**
   * The identity wiring `completeLogin` needs. Kernel-only: `POST /embed/handoff` (E2.2) is the
   * one route that mints a session outside `routes/auth.ts`, because a host-signed assertion is
   * a credential like any other and minting must stay in the single login path that establishes
   * membership, audits `auth.login` and applies the session policy.
   */
  readonly identityDeps: IdentityDeps;
  /** Host-identity handoff verification (E2.2 §6). Pure; it mints nothing and reads nothing. */
  readonly handoff: HandoffService;
  /**
   * The SSRF-guarded outbound fetch (E1.7 logo import). Kernel-only on purpose: it is not on
   * `ModuleServices`, because handing every module a fetch that reaches the internet is a
   * decision ADR-0033 has not made, and the one kernel caller can have it directly.
   */
  readonly outbound: OutboundHttpPort;
  /**
   * Custom portal domains (E2.1). Kernel-only, like `outbound`: the service reads and writes
   * `core.custom_domain`, and the hostname → workspace answer it produces is consumed by the
   * tenant classifier and the `ask` endpoint rather than by any module.
   */
  readonly domains: CustomDomainService;
  /**
   * The hostname → workspace cache behind the classifier and `ask`. Kernel-only for the same
   * reason as `domains`, and present here for exactly one caller: a route that soft-deletes a
   * workspace has to drop the cached hostname entry, or a closed portal keeps routing (and keeps
   * `ask` answering 200) for up to the 60-second TTL — E2.1 M9.
   */
  readonly domainLookup: CustomDomainLookup;
  /** `CUSTOM_DOMAIN_CNAME_TARGET`, or the canonical host; what the admin screen tells them to CNAME. */
  readonly customDomainCnameTarget: string;
  /**
   * Mail delivery feedback (E2.6): the suppression list and the webhook ingest behind
   * `/api/v1/mail/*`. Kernel-only — modules see its effect (`MailSuppressedError`,
   * `mail.delivery_recorded`), never the service.
   */
  readonly mailFeedback: MailFeedback;
  /**
   * The config key ring (E2.7). Kernel-only: the audit routes derive the Ed25519 export-signing
   * key from `ring.current` and publish every entry's public half, and verify checkpoints with
   * the same ring the checkpoint job signs with. Never handed to a module — a module holding the
   * ring could sign an export of another module's trail, or decrypt what the local KMS wraps.
   */
  readonly keyRing: KeyRing;
  /**
   * The job queue's read-and-repair side (E2.7 jobs/DLQ page). Kernel-only, and narrower than
   * `queue`: `stats` for the instance view (single-tenant mode only) and `deadLetters` for
   * listing, retrying and discarding the workspace's own dead letters. Modules enqueue through
   * `queue`; none of them may see or re-run another tenant's failed work.
   */
  readonly jobs: Pick<JobQueuePort, "deadLetters" | "stats">;
  /**
   * The TLS certificate reader behind `GET /ops/health`'s domain rows (E2.7). Kernel-only and
   * built once per process, because its five-minute per-hostname cache is what stops the health
   * page from becoming a way to hammer a host with handshakes. The route hands it only the
   * workspace's own verified (`dns_ok` / `active`) custom domains; the probe adds the outbound
   * SSRF policy on top, so a verified name repointed at a private address is still refused.
   */
  readonly certProbe: CertProbe;
  /**
   * The release-index check behind `GET /ops/update` (E2.9). Kernel-only and one per process:
   * its in-process cache (12 h / 1 h) and single-flight are what keep an admin page from
   * becoming a request per view to the release CDN. The route answers from it only on a
   * single-tenant install.
   */
  readonly updateChecker: UpdateChecker;
  readonly basePath: string;
  readonly passkeyRpId: string;
  readonly passwordEnabled: boolean;
  readonly magicLinkEnabled: boolean;
  /** `I18N_PSEUDO_LOCALE` (E2.8): offer the `en-XA` pseudo-locale; reported in the bootstrap. */
  readonly i18nPseudoLocale: boolean;
  // --- first-run setup (E0.8) ---
  readonly setup: SetupDeps;
  /**
   * `run` is read by `GET /ops/health` (E2.7) on a single-tenant install, so the deep health
   * page and `/readyz` report the same probes with the same caching and the same timeouts.
   */
  readonly readiness: Pick<Readiness, "markPassed" | "passed" | "run">;
}

export interface SetupDeps {
  readonly gate: SetupGate;
  readonly token: SetupToken;
  readonly instanceName: string;
}

/**
 * The facts the evaluator's session-bound gates read, built in **one** place (contract §5.6).
 *
 * `min_auth_level` compares `facts.authLevel` and `ip_allowlist` compares `facts.ip`; both fail
 * *closed* when the field is absent (`settleGates` keeps the gate pending, so the grant does not
 * apply): a construction that forgets a fact silently locks members out rather than letting them
 * in, and is just as wrong. That is exactly the kind of object that must not have two hand-rolled constructions —
 * there were two, the kernel's access routes and the data room's, and a field added to
 * `RequestFacts` would have reached one of them.
 */
export function requestFactsOf(c: Context<AppEnv>, trustProxy: boolean | ProxyTrust): RequestFacts {
  const session = c.get("session");
  // An API key counts as auth level 2 (E3.4: it was minted on a fresh level-2 session).
  const authLevel = session?.authLevel ?? (c.get("apiKey") !== undefined ? 2 : undefined);
  return { authLevel, ip: clientIp(c, trustProxy) };
}

/**
 * Who is acting (E3.4-A): a signed-in member, or a workspace API key acting as its creator.
 *
 * For handlers that used to read `c.get("session")!.sessionId` and must now also serve a key
 * (routes whose matrix row is `apiKey: true`). `sessionId` is set for a session and `apiKeyId`
 * for a key, never both (a request carrying both is refused with 400 `ambiguous_credentials`).
 * Audit entries need nothing from this: every entry written while a key request runs gets
 * `meta.apiKeyId` from the request's async context (`api-key-context.ts`); pass `apiKeyId`
 * explicitly only to be explicit. Throws 401 when the guard did not admit anybody.
 */
export interface Principal {
  readonly workspace: ResolvedWorkspace;
  readonly tenant: TenantContext;
  readonly membership: Membership;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export function principalOf(c: Context<AppEnv>): Principal {
  const workspace = c.get("workspace");
  const tenant = c.get("tenant");
  const membership = c.get("membership");
  const session = c.get("session");
  const apiKey = c.get("apiKey");
  if (
    workspace === undefined ||
    tenant === undefined ||
    membership === undefined ||
    (session === undefined && apiKey === undefined)
  )
    throw new ApiError("unauthenticated", "sign in to continue");
  return session !== undefined
    ? { workspace, tenant, membership, sessionId: session.sessionId }
    : { workspace, tenant, membership, apiKeyId: apiKey?.id };
}

/** `TRUST_PROXY` + its two refinements as the one value the request helpers take. */
export function proxyTrustOf(raw: {
  readonly TRUST_PROXY: boolean;
  readonly TRUST_PROXY_HOPS: number;
  readonly CLIENT_IP_HEADER?: string | undefined;
  readonly CLOUDFLARE_TRUSTED_PROXY?: "off" | "on" | undefined;
}): false | ProxyTrust {
  if (!raw.TRUST_PROXY) return false;
  // E3.10: layered on the proxy trust, never instead of it — without TRUST_PROXY there is no
  // `ProxyTrust` to carry it (and `fundroom doctor` says so).
  const cloudflare = raw.CLOUDFLARE_TRUSTED_PROXY === "on" ? { cloudflare: true } : {};
  return raw.CLIENT_IP_HEADER === undefined
    ? { hops: raw.TRUST_PROXY_HOPS, ...cloudflare }
    : { hops: raw.TRUST_PROXY_HOPS, clientIpHeader: raw.CLIENT_IP_HEADER, ...cloudflare };
}

/**
 * The edge-forwarding settings (E-UP-7, ADR-0064), or undefined when edge forwarding is not
 * configured (config allows FORWARDED_HOST_HEADER and EDGE_SHARED_SECRET only together).
 */
export function edgeForwardingOptionsOf(raw: {
  readonly FORWARDED_HOST_HEADER?: string | undefined;
  readonly FORWARDED_CLIENT_IP_HEADER?: string | undefined;
  readonly EDGE_SHARED_SECRET?: string | undefined;
  readonly EDGE_SHARED_SECRET_PREVIOUS?: string | undefined;
}): EdgeForwardingOptions | undefined {
  if (raw.FORWARDED_HOST_HEADER === undefined || raw.EDGE_SHARED_SECRET === undefined) {
    return undefined;
  }
  return {
    hostHeader: raw.FORWARDED_HOST_HEADER,
    clientIpHeader: raw.FORWARDED_CLIENT_IP_HEADER,
    secret: raw.EDGE_SHARED_SECRET,
    previousSecret: raw.EDGE_SHARED_SECRET_PREVIOUS,
  };
}

/**
 * Client IP (E2.10 F-07). Behind a trusted proxy: the platform's client-address header when one
 * is configured, else the `X-Forwarded-For` entry `hops` places from the right — never the
 * leftmost entry, which the client writes. Otherwise, or when the headers name no address, the
 * socket address. An edge-forwarded request (E-UP-7) answers the edge's visitor address first.
 */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean | ProxyTrust): string | undefined {
  // E-UP-7: an edge-forwarded request (the edge Worker's secret matched) names its visitor in
  // FORWARDED_CLIENT_IP_HEADER; without a valid one there, the ordinary derivation below.
  const edgeIp = edgeForwardedOf(c)?.clientIp;
  if (edgeIp !== undefined) return edgeIp;
  const peer = proxiedPeer(c, trustProxy);
  // E3.10 CLOUDFLARE_TRUSTED_PROXY: `CF-Connecting-IP` only when the address that connected
  // (as established above) is Cloudflare's; a client-sent header from anywhere else is ignored.
  if (typeof trustProxy === "object" && trustProxy.cloudflare === true) {
    return cloudflareClientIp(peer, (name) => c.req.header(name));
  }
  return peer;
}

/** The address that connected, as far as the trusted proxy chain (or the socket) says. */
function proxiedPeer(c: Context<AppEnv>, trustProxy: boolean | ProxyTrust): string | undefined {
  if (trustProxy !== false) {
    const trust = trustProxy === true ? ONE_PROXY : trustProxy;
    const forwarded = forwardedClientIp((name) => c.req.header(name), trust);
    if (forwarded !== undefined) return forwarded;
  }
  try {
    return normalizeIp(getConnInfo(c).remote.address ?? undefined);
  } catch {
    return undefined;
  }
}

/**
 * `ModuleServices.legal`, with the one compliance code that has no API vocabulary translated.
 *
 * `certifyAccreditation` refuses when the workspace has published no `accreditation` document
 * (E2.5 D5). The module calling it has no business knowing `@fundroom/compliance`'s error
 * vocabulary — and the wrong translation is the expensive one here: a bare rethrow surfaces as a
 * 500, and `not_found` would tell an investor their own submission had vanished when nothing of
 * theirs is missing. `accreditation_unavailable` (409) says what is true: the company has not
 * finished publishing the text, and the fix is an admin's.
 *
 * No certificate issuer is wired at this seam, and that is deliberate rather than an omission:
 * `CertificateFacts.workspace.host` is a *per-request* tenancy fact (the origin this request
 * actually resolved on — see `routes/compliance.ts`), and `ModuleServices` is built once per
 * process. With no issuer `issueCertificate` no-ops and the acceptance behaves exactly as it did
 * before E2.3 — both attestation rows, the audit row, the ACL bump, a null `evidence_ref`.
 */
function legalPort(deps: ModuleServiceDeps): ModuleServices["legal"] {
  const port = createLegalPort({
    db: deps.db,
    audit: deps.audit,
    bookingSuppressionKeys: deps.crypto,
  });
  return {
    ...port,
    async certifyAccreditation(tx, ctx, input) {
      try {
        return await port.certifyAccreditation(tx, ctx, input);
      } catch (error) {
        if (isComplianceError(error) && error.code === "accreditation_document_missing") {
          throw new ApiError("accreditation_unavailable", error.message, error.details);
        }
        throw error;
      }
    },
  };
}

/**
 * The kernel guard chain as module middleware (`ModuleServices.guards`).
 *
 * Every module's member routes are behind the E1.6 acceptance gate: an investor who owes an
 * acceptance reaches the data room, the updates archive and the analytics beacon only after they
 * have clicked through. The worker's copy of `ModuleServices` has no gate — it serves no requests,
 * so there is nothing to hold up. The HTTP app passes its one gate to both the OpenAPI module
 * mount and the raw mount (`withModuleGuards`), so an acceptance clears both at once.
 */
export function moduleGuardsOf(
  authz: () => AuthzService,
  gate?: AcceptanceGate,
): ModuleServices["guards"] {
  return {
    requirePermission: (permission, extra) =>
      // AppEnv's variables are a superset of ModuleEnv's; Hono's generics are invariant.
      requirePermission({ authz }, permission, extra) as unknown as MiddlewareHandler<ModuleEnv>,
    requireMember: () =>
      requireMember(gate === undefined ? {} : { gate }) as unknown as MiddlewareHandler<ModuleEnv>,
  };
}

/**
 * `services` with its `guards` swapped for ones that run `gate` (E3.2 SWEEP-1/2): the container's
 * `ModuleServices` is built without an acceptance gate (the worker shares it), while the raw module
 * routes serve requests and must enforce the same chain as the OpenAPI mount.
 */
export function withModuleGuards(
  services: ModuleServices,
  authz: () => AuthzService,
  gate: AcceptanceGate,
): ModuleServices {
  const guards = moduleGuardsOf(authz, gate);
  return new Proxy(services, {
    get: (target, prop) => (prop === "guards" ? guards : Reflect.get(target, prop)),
  });
}

/**
 * The `ModuleServices` seam (ADR-0033): what a module's routes receive. Every property is
 * resolved through `deps` on access, so building this against the throwing stub is free and
 * a module that reads a service at registration time fails the OpenAPI generation test.
 */
export function moduleServicesOf(deps: ModuleServiceDeps, gate?: AcceptanceGate): ModuleServices {
  const guards = moduleGuardsOf(() => deps.authz, gate);
  let registryView: ModuleServices["registry"] | undefined;
  let forensicKeys: ModuleServices["forensicKeys"] | undefined;
  let shareLinks: ModuleServices["shareLinks"] | undefined;
  const lazy: { [K in keyof ModuleServices]: () => ModuleServices[K] } = {
    db: () => deps.db,
    authz: () => deps.authz,
    audit: () => deps.audit,
    queue: () => deps.queue,
    storage: () => deps.storage,
    crypto: () => deps.crypto,
    scanner: () => deps.scanner,
    renderer: () => deps.renderer,
    dns: () => deps.dns,
    spreadsheets: () => deps.spreadsheets,
    accreditation: () => deps.accreditation,
    chat: () => deps.chat,
    search: () => deps.search,
    esign: () => deps.esign,
    integrations: () => deps.integrations.services,
    quota: () => deps.quota,
    entitlements: () => deps.entitlements,
    ai: () => deps.ai,
    forensicKeys: () => {
      forensicKeys ??= forensicKeysOf(deps.keyRing);
      return forensicKeys;
    },
    shareLinks: () => {
      shareLinks ??= createShareLinkProtection(deps.db);
      return shareLinks;
    },
    limits: () => deps.limits,
    mailer: () => deps.mailer,
    rateLimiter: () => deps.rateLimiter,
    // Built on first read (so a registration-time read still fails against `stubDeps()`); the
    // view resolves AI context providers from these same services on first use (E3.12).
    registry: () => {
      registryView ??= registryViewOf(deps.registry, () => services);
      return registryView;
    },
    enablement: () => deps.enablement,
    // The legal port is stateless (every method takes the caller's `(tx, ctx)`), so it is
    // constructed on access like every other dep rather than held on the container: a route
    // that reached for it at registration time must still fail against `stubDeps()`.
    legal: () => legalPort(deps),
    workspaces: () => ({ invalidate: () => deps.resolver.invalidate() }),
    guards: () => guards,
    baseUrl: () => deps.baseUrl,
    tenancy: () => deps.tenancy,
    workspaceUrl:
      () => (workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">, path: string) =>
        workspaceUrl(deps.baseUrl, deps.tenancy, workspace, path, deps.basePath),
    trustProxy: () => deps.trustProxy !== false,
    now: () => () => new Date(),
    log: () => deps.log,
    clientIp: () => (c: Context<ModuleEnv>) =>
      clientIp(c as unknown as Context<AppEnv>, deps.trustProxy),
    requestFacts: () => (c: Context<ModuleEnv>) =>
      requestFactsOf(c as unknown as Context<AppEnv>, deps.trustProxy),
  };
  const services = new Proxy({} as ModuleServices, {
    get(_target, prop) {
      const thunk = lazy[prop as keyof ModuleServices];
      return thunk === undefined ? undefined : thunk();
    },
    has(_target, prop) {
      return prop in lazy;
    },
  });
  return services;
}

/**
 * `ModuleServices.forensicKeys` (E3.13): the forensic pattern key of each key-ring entry, derived
 * once per entry. An entry that left the ring yields `undefined` (its marks are undetectable).
 */
export function forensicKeysOf(ring: KeyRing): ModuleServices["forensicKeys"] {
  const cache = new Map<string, Uint8Array>();
  const keyOf = (id: string): Uint8Array | undefined => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const entry = ring.get(id);
    if (entry === undefined) return undefined;
    const key = deriveForensicPatternKey(entry.key);
    cache.set(id, key);
    return key;
  };
  return {
    current: () => ({
      keyId: ring.current.id,
      patternKey: keyOf(ring.current.id) as Uint8Array,
    }),
    get: keyOf,
  };
}

/**
 * A workspace's own origin: its `active` custom domain when it has one, else
 * `https://<slug>.<canonical host>/<path>` in multi-tenant mode, else the base URL.
 *
 * The custom domain wins in *both* tenancy modes (E2.1 decision 5) — a single-tenant install
 * that has verified a domain must mint its email links there too, not on BASE_URL. Assigning
 * `url.host` a bare hostname leaves an existing port in place, so a dev install on
 * `localhost:3000` keeps its port exactly as the multi-tenant branch does.
 *
 * `path` is relative to BASE_URL — which already carries the base path — so callers pass
 * `/s/<token>`, never `${basePath}/s/<token>` (that doubled the prefix; E3.9).
 */
export function workspaceUrl(
  baseUrl: URL,
  tenancy: TenancyMode,
  workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
  path: string,
  /**
   * BASE_PATH (E3.9 FR1 B7). A custom domain serves the app directly, under BASE_PATH — not
   * under BASE_URL's path, which may be a host site's mount prefix. Omitted: BASE_URL's path.
   */
  basePath?: string,
): URL {
  const url = new URL(
    path.replace(/^\//u, ""),
    baseUrl.href.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`,
  );
  if (workspace.primaryHost) {
    url.host = workspace.primaryHost;
    if (basePath !== undefined)
      return new URL(`${basePath}/${path.replace(/^\//u, "")}`, url.origin);
  } else if (tenancy === "multi") url.host = `${workspace.slug}.${baseUrl.host}`;
  return url;
}

/**
 * The absolute, unauthenticated URL of a workspace's logo (`GET /branding/logo`, E1.7).
 *
 * It lives beside `workspaceUrl` rather than in the branding route because three callers need
 * it — the API body, the SSR page config and the email brand resolver — and an email whose
 * `<img src>` disagreed with the route that serves it would be a broken logo in every inbox.
 *
 * The digest rides along as `?v=`: the route ignores it, but a mail client that cached the old
 * bytes under the old URL will not keep showing them, and mail clients cache far longer than
 * they are told to.
 */
export function brandingLogoUrl(
  parts: { readonly baseUrl: URL; readonly tenancy: TenancyMode; readonly basePath?: string },
  workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
  logo: { readonly sha256: string },
): string {
  // Relative to BASE_URL, which already carries the base path (E3.9: no double prefix).
  const url = workspaceUrl(
    parts.baseUrl,
    parts.tenancy,
    workspace,
    "/api/v1/branding/logo",
    parts.basePath,
  );
  url.searchParams.set("v", logo.sha256.slice(0, 16));
  return url.href;
}

/** A stub whose every property access throws: proves routes read deps lazily. */
export function stubDeps(): ApiDeps {
  return new Proxy({} as ApiDeps, {
    get(_target, prop) {
      throw new Error(`route touched deps.${String(prop)} at registration time`);
    },
  });
}
