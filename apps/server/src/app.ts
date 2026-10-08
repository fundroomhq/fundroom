import { hstsIncludeSubDomains, metricsEnabled } from "@fundroom/config";
import { ApiError } from "@fundroom/contracts";
import { embedFrameAncestors, parseWorkspaceSettings } from "@fundroom/domain";
import { securityHeaders } from "@fundroom/http";
import { CAPTABLE_IMPORT_BODY_LIMIT_BYTES } from "@fundroom/module-captable";
import { QA_IMPORT_BODY_LIMIT_BYTES } from "@fundroom/module-data-room";
import type { ModuleRawRouter } from "@fundroom/module-kit";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createApiApp } from "./api.js";
import { createCertProbe } from "./cert-probe.js";
import type { Container } from "./container.js";
import { edgeForwardingMiddleware } from "./edge.js";
import type { AppEnv } from "./env.js";
import { logHook } from "./logger.js";
import { sessionResolution } from "./middleware/auth.js";
import { type AcceptanceGate, createAcceptanceGate } from "./middleware/authz.js";
import { apiCors } from "./middleware/cors.js";
import {
  apiErrorHandler,
  apiNotFound,
  normalizeError,
  pageErrorResponse,
} from "./middleware/errors.js";
import { gpcConsent } from "./middleware/gpc.js";
import { requestId } from "./middleware/request-id.js";
import { requestLog } from "./middleware/request-log.js";
import { tenantResolution } from "./middleware/tenant.js";
import { workspaceStatusGuard } from "./middleware/workspace-status.js";
import { markModuleMount } from "./module-read-only.js";
import { pathMountResolution, varyByMount } from "./path-mount.js";
import { type Readiness, readinessDetailGuard } from "./readiness.js";
import {
  type AccreditationCallbackBudget,
  accreditationCallbackRoutes,
} from "./routes/accreditation-callback.js";
import { billingWebhookRoutes } from "./routes/billing-webhook.js";
import { centralAuthRoutes } from "./routes/central-auth.js";
import { clientIp, proxyTrustOf, withModuleGuards } from "./routes/deps.js";
import { createEmbedOriginAudit, registerEmbedPublicRoutes } from "./routes/embed.js";
import { type ESignCallbackBudget, esignCallbackRoutes } from "./routes/esign-callback.js";
import { bindingCookieSecure, integrationOAuthRoutes } from "./routes/integrations-oauth.js";
import {
  type IntegrationWebhookBudget,
  integrationWebhookRoutes,
} from "./routes/integrations-webhook.js";
import { mailWebhookRoutes } from "./routes/mail-webhook.js";
import { opsRoutes } from "./routes/ops.js";
import { scimRoutes } from "./routes/scim.js";
import { ssoOpsRoutes } from "./routes/sso-flow.js";
import { createHttpMetrics, inboundTracing, type Telemetry } from "./telemetry.js";
import { canonicalHostOf } from "./tenancy.js";
import { SERVER_VERSION } from "./version.js";
import { type AuthMethod, loadWebDist, mountWeb } from "./web.js";

/** One Hono app with every module's `rawRoutes` under `/<module>`; undefined when none. */
function createModuleRawMount(
  container: Container,
  log: ReturnType<typeof logHook>,
  gate: AcceptanceGate,
): Hono<AppEnv> | undefined {
  const modules = container.registry.modules.filter((m) => m.rawRoutes !== undefined);
  if (modules.length === 0) return undefined;
  // Raw routes mount `services.guards` like OpenAPI routes do (E3.2 SWEEP-1/2), with the same
  // acceptance gate as the API app, so an acceptance clears both mounts at once.
  const services = withModuleGuards(container.moduleServices, () => container.authz, gate);
  const mount = new Hono<AppEnv>({ strict: false });
  mount.onError(apiErrorHandler(log));
  for (const m of modules) {
    const sub = new Hono<AppEnv>({ strict: false });
    sub.use("*", async (c, next) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const tenant = c.get("tenant") ?? { workspaceId: workspace.id, actorKind: "system" as const };
      const enabled = await container.enablement.get(container.db, tenant);
      if (!enabled.enabled.has(m.id))
        throw new ApiError("module_disabled", `${m.id} is not enabled here`);
      // A-3: the same read-only mark as the OpenAPI mount (`api.ts`); the raw routes mount the
      // same permission guard, which refuses.
      markModuleMount(c, m, container.moduleServices.entitlements.of(workspace));
      await next();
    });
    m.rawRoutes?.(sub as unknown as ModuleRawRouter, services);
    mount.route(`/${m.id}`, sub);
  }
  return mount;
}

/*
 * The request pipeline (§3.3), in order:
 *   request id → edge forwarding (E-UP-7, when configured) → access log → metrics/spans → security headers (profile by tree)
 *   → tenant resolution → session + membership + CSRF → routes
 * Ops routes short-circuit after tenant classification (no session, no tenant).
 * `/api/v1` gets CORS, a JSON body limit and the error envelope; the `web` role serves the
 * built SPA (`src/web.ts`; a placeholder page when `WEB_DIST_PATH` is unset) for the
 * app/admin/embed trees.
 */
export interface AppOptions {
  readonly container: Container;
  readonly readiness: Readiness;
  readonly telemetry: Telemetry;
  readonly startedAt?: number | undefined;
  /** Test seam: the e-sign callback route's budgets (defaults in `routes/esign-callback.ts`). */
  readonly esignCallbackBudget?: ESignCallbackBudget | undefined;
  /** Test seam: the accreditation callback route's budgets (defaults in `routes/accreditation-callback.ts`). */
  readonly accreditationCallbackBudget?: AccreditationCallbackBudget | undefined;
  /** Test seam: the booking webhook route's budgets (defaults in `routes/integrations-webhook.ts`). */
  readonly integrationWebhookBudget?: IntegrationWebhookBudget | undefined;
}

export const API_BODY_LIMIT_BYTES = 1024 * 1024;
/** `POST …/api/v1/data-room/qa/import` (any mount prefix): `QA_IMPORT_BODY_LIMIT_BYTES` instead. */
const QA_IMPORT_PATH = /\/api\/v1\/data-room\/qa\/import\/?$/u;
/**
 * `POST …/api/v1/captable/import[/dry-run]` (any mount prefix): `CAPTABLE_IMPORT_BODY_LIMIT_BYTES`
 * — a cap-table CSV of up to 2 MiB as a JSON string (E3.6).
 */
const CAPTABLE_IMPORT_PATH = /\/api\/v1\/captable\/import(?:\/dry-run)?\/?$/u;

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { container } = options;
  const { config } = container;
  const raw = config.raw;
  const basePath = config.basePath;
  const log = logHook(container.logger, "http");
  /** TRUST_PROXY + TRUST_PROXY_HOPS + CLIENT_IP_HEADER (E2.10 F-07), for client-address lookups. */
  const proxyTrust = proxyTrustOf(raw);
  const app = new Hono<AppEnv>({ strict: false });
  const canonicalHost = canonicalHostOf(config.baseUrl);
  const passkeyRpId = raw.PASSKEY_RP_ID ?? config.baseUrl.hostname;
  const authMethods: AuthMethod[] = [
    "email_otp",
    ...(raw.AUTH_MAGIC_LINK_ENABLED ? (["magic_link"] as const) : []),
    "passkey",
    ...(raw.AUTH_PASSWORD_ENABLED ? (["password"] as const) : []),
    ...(container.auth.oidc ? (["oidc"] as const) : []),
  ];

  // --- observability ---------------------------------------------------------------------------
  app.use("*", requestId());
  // E-UP-7 (ADR-0064): an edge Worker's private host/IP headers, believed only with its shared
  // secret. First, so every reader of the host, scheme or client IP below sees the edge's facts.
  // Not registered at all when edge forwarding is not configured: nothing then reads the headers.
  const edge = edgeForwardingMiddleware(raw, log, proxyTrust);
  if (edge !== undefined) app.use("*", edge);
  app.use("*", async (c, next) => {
    c.set("log", log);
    c.set("embed", false);
    await next();
  });
  // Path-mount mode (E3.9): the request's public base + origin, before anything presents a URL.
  app.use(
    "*",
    pathMountResolution({
      mounts: config.pathMounts,
      basePath,
      trustProxy: raw.TRUST_PROXY,
      baseUrl: config.baseUrl,
      checkUnmountedOrigin: raw.TENANCY_MODE === "single",
      log,
    }),
  );
  // `Vary: Cookie, X-Forwarded-Prefix` on every private/no-store response; registered here, outside
  // the security headers, so it sees the final `Cache-Control` (their default included).
  app.use("*", varyByMount({ mountsConfigured: config.pathMounts.length > 0 }));
  // Route templates only, never raw paths: a raw path carries share-link and invite tokens and
  // makes one metric series per distinct URL (E2.10 F-01).
  app.use("*", requestLog(log, { basePath }));
  app.use("*", createHttpMetrics({ basePath }).middleware);
  if (options.telemetry.tracingEnabled) {
    app.use(
      "*",
      // E3.11 RR2-1: @hono/otel with URL redaction (request URLs carry share/invite tokens).
      inboundTracing({ serviceName: raw.OTEL_SERVICE_NAME, serviceVersion: SERVER_VERSION }),
    );
  }

  // --- tenant + headers ------------------------------------------------------------------------
  const secureHeaders = securityHeaders({
    profile: (c) => {
      const tree = (
        c as never as { get(k: "classification"): AppEnv["Variables"]["classification"] }
      ).get("classification")?.tree;
      switch (tree) {
        case "api":
        case "ops":
          return "api";
        case "admin":
          return "admin";
        case "embed":
          return "embed";
        // The embed loader (E2.2): `CORP: cross-origin` so a host page may fetch it, no CSP
        // because nothing renders, and no default `Cache-Control` so the handler's own
        // (rolling or immutable) value survives.
        case "asset":
          return "asset";
        default:
          return "app";
      }
    },
    /*
     * E2.2 decision 2: the allow-list lives in `core.workspace.settings.embed`, and this hook
     * runs on EVERY embed request — before the handler, so a failing lookup can never serve a
     * framed page without the header. `ResolvedWorkspace` already carries the whole `settings`
     * jsonb, so deriving it here costs no query and has no cache to invalidate; that is what a
     * table would have cost, and it is the lesson E1.7 recorded about synchronous resolvers
     * reading a cold cache.
     */
    frameAncestors: (c) => {
      const ws = (c as never as { get(k: "workspace"): AppEnv["Variables"]["workspace"] }).get(
        "workspace",
      );
      return ws === undefined ? [] : embedFrameAncestors(parseWorkspaceSettings(ws.settings).embed);
    },
    robots: raw.ROBOTS,
    hsts: {
      enabled: raw.HSTS,
      preload: raw.HSTS_PRELOAD,
      includeSubDomains: hstsIncludeSubDomains(raw),
      // Custom domains (maybe a customer's apex) get HSTS without includeSubDomains (R2-02).
      canonicalHost,
    },
    trustProxy: raw.TRUST_PROXY,
    // The request's public face (E3.9): absolute on a mounted request, so `Reporting-Endpoints`
    // names the mount origin (the host site's) rather than whatever Host the proxy sent.
    cspReportUri: (c) => {
      const mount = (c as never as { get(k: "pathMount"): AppEnv["Variables"]["pathMount"] }).get(
        "pathMount",
      );
      return mount === undefined
        ? `${basePath}/csp-report`
        : `${mount.origin}${mount.prefix}/csp-report`;
    },
    // E3.2: enforced on app/admin/embed documents unless CSP_TRUSTED_TYPES=report.
    trustedTypes: raw.CSP_TRUSTED_TYPES,
    // E3.9 FR1 B2: a mounted response carries no HSTS — the host site owns its transport policy.
    omitHsts: (c) =>
      (c as never as { get(k: "pathMount"): AppEnv["Variables"]["pathMount"] }).get("pathMount") !==
      undefined,
    // Matched against the INTERNAL path (`c.req.path`), which a mount never changes.
    popupAuthPaths: [`${basePath}/auth/popup`],
    // AppEnv's variables are a superset of the ones it sets; typed so the tenant wrapper below
    // can call it directly.
  }) as unknown as MiddlewareHandler<AppEnv>;
  const resolveTenant = tenantResolution({
    resolver: container.resolver,
    classify: {
      mode: raw.TENANCY_MODE,
      canonicalHost,
      basePath,
      // E3.10 FR1 (R1-L2): the canonical host is the operator console's origin; no `/w/<slug>`.
      ...(container.controlPlane.enabled
        ? { slugHostRedirect: { protocol: config.baseUrl.protocol } }
        : {}),
    },
    trustProxy: raw.TRUST_PROXY,
    // Verified custom domains (E2.1): an `unknown` host may still be a workspace's own.
    lookup: container.customDomainLookup,
    // E3.10: a workspace served by another cell is 421 `wrong_cell` (CONTROL_PLANE=on only).
    cell: { enabled: container.controlPlane.enabled, cellId: container.controlPlane.cellId },
    // E3.11: a local miss may be a workspace another cell serves (shared directory only).
    directory: container.directory,
    log: logHook(container.logger, "directory"),
  });
  /*
   * Tenant resolution runs first because the header profile (and an embed's frame-ancestors)
   * need its classification and workspace. Its own 404s (unknown host, `/w/<slug>` or
   * `/embed/<slug>` naming no workspace) short-circuit the chain, so they are answered here and
   * then passed through the same headers as every other response (E2.10 P2-04).
   */
  app.use("*", async (c, next) => {
    let resolved = false;
    const refusal = await resolveTenant(c, async () => {
      resolved = true;
    });
    if (resolved) return secureHeaders(c, next);
    await secureHeaders(c, async () => {
      if (refusal) c.res = refusal;
    });
    return c.res;
  });

  // --- ops (no session) ------------------------------------------------------------------------
  // `/readyz` is public; its check details (driver errors, hosts) are not (E2.10 F-31). Registered
  // ahead of the ops routes so it wraps the handler and rewrites the body on the way out.
  app.use(
    `${basePath}/readyz`,
    readinessDetailGuard(raw.METRICS_TOKEN, { trustProxy: raw.TRUST_PROXY }),
  );
  app.route(
    basePath || "/",
    opsRoutes({
      readiness: options.readiness,
      telemetry: options.telemetry,
      metricsEnabled: metricsEnabled(raw),
      metricsToken: raw.METRICS_TOKEN,
      tenancy: raw.TENANCY_MODE,
      features: container.registry.ids,
      authMethods,
      passkeyRpId,
      basePath,
      log,
      startedAt: options.startedAt ?? Date.now(),
      canonicalHost,
      // On-demand TLS for verified custom domains (E2.1 §1.11). The canonical host is still
      // answered by the string compare in front of this, so the common case costs nothing.
      issuable: (hostname) => container.customDomainLookup.issuable(hostname),
      securityTxt: {
        enabled: raw.SECURITY_TXT,
        contact: raw.SECURITY_TXT_CONTACT,
        policy: raw.SECURITY_TXT_POLICY,
        baseUrl: config.baseUrl,
        trustProxy: raw.TRUST_PROXY,
      },
    }),
  );

  // ESP delivery webhooks (E2.6): ops tree, no session. The workspace comes from the provider's
  // message id, looked up in host context; `mailer` is read per request so it is the decorated one.
  app.route(
    basePath || "/",
    mailWebhookRoutes({
      mailer: () => container.mailer,
      feedback: () => container.mailFeedback,
      log: logHook(container.logger, "mail"),
    }),
  );

  // E-sign vendor callbacks (E3.5): ops tree, no session. The workspace comes from the connection
  // row the path names; the service is read per request.
  app.route(
    basePath || "/",
    esignCallbackRoutes({
      ingest: () => container.esignCallbacks,
      log: logHook(container.logger, "esign"),
      budget: options.esignCallbackBudget,
    }),
  );

  // Accreditation vendor callbacks (E3.7): ops tree, no session. The workspace comes from the
  // connection row the path names; the service is read per request.
  app.route(
    basePath || "/",
    accreditationCallbackRoutes({
      ingest: () => container.accreditationCallbacks,
      log: logHook(container.logger, "accreditation"),
      budget: options.accreditationCallbackBudget,
    }),
  );

  // Integrations (E3.6): the OAuth handshake's start/callback (canonical host only — the handlers
  // step aside unless the classifier said `ops`) and the booking webhook. No session; the service
  // is read per request.
  app.route(
    basePath || "/",
    integrationOAuthRoutes({
      service: () => container.integrations,
      secure: bindingCookieSecure(config.baseUrl),
      log: logHook(container.logger, "integrations"),
    }),
  );
  app.route(
    basePath || "/",
    integrationWebhookRoutes({
      ingest: () => (connectionId, request, opts) =>
        container.integrations.ingestBookingWebhook(connectionId, request, opts),
      log: logHook(container.logger, "integrations"),
      budget: options.integrationWebhookBudget,
    }),
  );

  // Staff SSO (E3.8): the IdP-facing callback / ACS / SP metadata on the canonical host, and SCIM
  // 2.0 at /scim/v2. Ops tree, no session; the workspace comes from the connection row or the
  // bearer token, never the host. Services are read per request.
  app.route(
    basePath || "/",
    ssoOpsRoutes({
      sso: () => container.sso,
      log: logHook(container.logger, "sso"),
    }),
  );
  app.route(
    basePath || "/",
    scimRoutes({
      scim: () => container.scim,
      enabled: raw.SCIM_ENABLED,
      log: logHook(container.logger, "scim"),
    }),
  );

  // Billing provider webhook (E3.10): ops tree on the canonical host, no session; the workspace
  // comes from our stored subscription ids. The kernel is read per request.
  app.route(
    basePath || "/",
    billingWebhookRoutes({
      billing: () => container.billing,
      log: logHook(container.logger, "billing"),
    }),
  );

  // --- session + CSRF (everything below is tenant-aware) ---------------------------------------
  for (const m of sessionResolution({
    auth: container.auth,
    db: container.db,
    trustProxy: raw.TRUST_PROXY,
    allowedOrigins: container.allowedOrigins,
    // E3.4: `Authorization: Bearer frk_…` on the API tree (see `apiKeyResolution`).
    apiKeys: {
      service: () => container.apiKeys,
      rateLimiter: () => container.rateLimiter,
      clientIp: (c) => clientIp(c, proxyTrust),
    },
  })) {
    app.use("*", m);
  }
  // Global Privacy Control made durable for signed-in members (E2.6): see `./middleware/gpc.ts`.
  app.use(
    "*",
    gpcConsent({ db: container.db, audit: container.audit, log: logHook(container.logger, "gpc") }),
  );
  // E3.10: a suspended or held workspace serves sign-in, the bootstrap and (for billing holders)
  // billing only — see `./middleware/workspace-status.ts`.
  app.use(
    "*",
    workspaceStatusGuard({
      hasPermission: (m, permission) => container.authz.hasPermission(m, permission),
    }),
  );
  // Central auth (E3.10): app-tree redirects that need the tenant host's resolution (start,
  // finish) or the canonical session (authorize), so they sit after the session chain and ahead
  // of the SPA catch-all.
  app.route(
    basePath || "/",
    centralAuthRoutes({
      centralAuth: () => container.centralAuth,
      log: logHook(container.logger, "central-auth"),
    }),
  );

  // --- API -------------------------------------------------------------------------------------
  // One per app: its per-hostname cache is the health page's rate limit (see `cert-probe.ts`).
  const certProbe = createCertProbe({
    allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
  });
  // One legal-acceptance gate for the API app and the module raw mount (its cache is shared).
  const acceptanceGate = createAcceptanceGate({
    db: () => container.db,
    audit: () => container.audit,
  });
  const api = createApiApp(
    {
      auth: container.auth,
      accessRequests: container.accessRequests,
      apiKeys: container.apiKeys,
      webhooks: container.webhooks,
      identityDeps: container.identityDeps,
      handoff: container.handoff,
      db: container.db,
      registry: container.registry,
      enablement: container.enablement,
      basePath,
      baseUrl: config.baseUrl,
      trustProxy: proxyTrust,
      tenancy: raw.TENANCY_MODE,
      passkeyRpId,
      passwordEnabled: raw.AUTH_PASSWORD_ENABLED,
      magicLinkEnabled: raw.AUTH_MAGIC_LINK_ENABLED,
      i18nPseudoLocale: raw.I18N_PSEUDO_LOCALE,
      log: logHook(container.logger, "api"),
      setup: {
        gate: container.setupGate,
        token: container.setupToken,
        instanceName: raw.INSTANCE_NAME,
      },
      resolver: container.resolver,
      outbound: container.outbound,
      domains: container.customDomains,
      domainLookup: container.customDomainLookup,
      customDomainCnameTarget: container.customDomainCnameTarget,
      mailer: container.mailer,
      storage: container.storage,
      audit: container.audit,
      rateLimiter: container.rateLimiter,
      readiness: options.readiness,
      authz: container.authz,
      queue: container.queue,
      crypto: container.envelope,
      scanner: container.scanner,
      renderer: container.renderer,
      dns: container.dns,
      spreadsheets: container.spreadsheets,
      accreditation: container.accreditation,
      sso: container.sso,
      scim: container.scim,
      chat: container.chat,
      search: container.search,
      esign: container.esign,
      integrations: container.integrations,
      ai: container.ai,
      aiKernel: container.aiKernel,
      auditAnchoring: container.auditAnchoring,
      controlPlane: container.controlPlane,
      billing: container.billing,
      sanctions: container.sanctions,
      directory: container.directory,
      residency: container.residency,
      centralAuth: container.centralAuth,
      platformOperatorCidrs: raw.PLATFORM_OPERATOR_CIDRS ?? [],
      quota: container.moduleServices.quota,
      entitlements: container.moduleServices.entitlements,
      mailFeedback: container.mailFeedback,
      keyRing: config.keyRing,
      jobs: container.queue,
      certProbe,
      updateChecker: container.updateChecker,
      limits: {
        uploadMaxBytes: raw.UPLOAD_MAX_BYTES,
        renderMaxBytes: raw.RENDER_MAX_BYTES,
        dataDir: raw.DATA_DIR,
      },
    },
    container.registry,
    acceptanceGate,
  );
  api.onError(apiErrorHandler(log));
  api.notFound(apiNotFound());
  const apiMount = new Hono<AppEnv>({ strict: false });
  apiMount.use(
    "*",
    apiCors({
      staticOrigins: container.allowedOrigins,
      /*
       * A verified custom domain is the workspace's own origin (E2.1 decision 5), so a page
       * served from it calling `/api/v1` cross-origin must be allowed — otherwise the very
       * feature that makes the portal live on the customer's hostname would break every embed
       * and every fetch that names the canonical host. The workspace has already been resolved
       * by the tenant middleware, and `primaryHost` rides on that row, so this hook costs no
       * query; it is exactly what `CorsOptions.workspaceOrigins` was left unused for.
       *
       * CSRF needs no change: `selfOrigin` is derived per request from the Host header, so a
       * same-origin POST on a custom domain already passes.
       */
      workspaceOrigins: (c) => {
        const primaryHost = (
          c as unknown as { get(k: "workspace"): AppEnv["Variables"]["workspace"] }
        ).get("workspace")?.primaryHost;
        // The install's own scheme, not both: an https install must not name an http origin as
        // allowed, and a dev install on http would never see an https one.
        return primaryHost == null || primaryHost === ""
          ? []
          : [`${config.baseUrl.protocol}//${primaryHost}`];
      },
    }),
  );
  const defaultBodyLimit = bodyLimit({ maxSize: API_BODY_LIMIT_BYTES });
  const qaImportBodyLimit = bodyLimit({ maxSize: QA_IMPORT_BODY_LIMIT_BYTES });
  const captableImportBodyLimit = bodyLimit({ maxSize: CAPTABLE_IMPORT_BODY_LIMIT_BYTES });
  apiMount.use("*", (c, next) => {
    // The data-room Q&A import carries a CSV of up to 1 MiB as a JSON string (the cap-table
    // import one of up to 2 MiB); escaping can grow it past the default, so those routes get the
    // limit their documented CSV size needs.
    if (c.req.method === "POST" && QA_IMPORT_PATH.test(c.req.path))
      return qaImportBodyLimit(c, next);
    if (c.req.method === "POST" && CAPTABLE_IMPORT_PATH.test(c.req.path))
      return captableImportBodyLimit(c, next);
    return defaultBodyLimit(c, next);
  });
  // Module protocol endpoints (tus uploads, byte streams) sit in front of the JSON body limit
  // and CORS of the OpenAPI mount but behind the same session/CSRF chain; a module's raw
  // router is guarded by its enablement like its OpenAPI routes (ADR-0034).
  const rawMount = createModuleRawMount(container, log, acceptanceGate);
  // A slug prefix on the path (`/w/<slug>/api/v1/...`) was consumed by classification.
  //
  // `/embed/<slug>/api/v1/...` is the third mount and not a convenience (E2.2): the framed SPA
  // calls the API under its own prefix so the classifier can see that the request is in the embed
  // context, which is what makes `cookieModeFor` issue the `SameSite=None; Partitioned` session
  // cookie a third-party iframe can actually send back. See `tenancy.ts`.
  apiMount.route("/", api);
  for (const prefix of [
    `${basePath}/api/v1`,
    `${basePath}/w/:slug/api/v1`,
    `${basePath}/embed/:slug/api/v1`,
  ]) {
    if (rawMount !== undefined) app.route(prefix, rawMount);
    app.route(prefix, apiMount);
  }
  app.all(`${basePath}/api/*`, (c) =>
    pageErrorResponse(c, new ApiError("not_found", "unknown API version; use /api/v1")),
  );

  /*
   * --- embed (E2.2) -----------------------------------------------------------------------------
   * The loader, the SRI manifest and the public theme document, registered AHEAD of the SPA
   * catch-all below — which matches `${basePath}/*` and would otherwise answer an HTML document
   * to a `<script src>`. Not inside the `web` role: a host page fetches the loader from whatever
   * node serves it, and an api-only node must not 404 the script that loads the iframe.
   */
  registerEmbedPublicRoutes(app, { basePath });

  // --- web ---------------------------------------------------------------------------------------
  if (config.roles.has("web")) {
    const embedOriginAudit = createEmbedOriginAudit({
      audit: container.audit,
      log: logHook(container.logger, "embed"),
    });
    mountWeb(app, {
      dist: loadWebDist(raw.WEB_DIST_PATH),
      basePath,
      tenancy: raw.TENANCY_MODE,
      baseUrl: config.baseUrl,
      canonicalHost,
      instanceName: raw.INSTANCE_NAME,
      auth: { methods: authMethods, passkeyRpId },
      embedOrigins: (id) => container.embedOrigins(id),
      pathMounts: config.pathMounts,
      setupRequired: () => container.setupGate.required(),
      controlPlane: {
        enabled: container.controlPlane.enabled,
        centralAuth: container.centralAuth.enabled,
        signup: container.controlPlane.enabled && raw.SIGNUP_MODE === "open",
        billing: container.billing.enabled,
        signupTermsVersion: raw.SIGNUP_TERMS_VERSION,
      },
      ai: container.aiModel !== null,
      links: {
        terms: raw.TERMS_URL ?? null,
        privacy: raw.PRIVACY_URL ?? null,
        support: raw.SUPPORT_URL ?? null,
        status: raw.STATUS_URL ?? null,
      },
      onEmbedOriginRejected: (c, rejection) =>
        embedOriginAudit({
          ...rejection,
          requestId: c.get("requestId"),
          ip: clientIp(c, proxyTrust),
        }),
    });
  }

  app.notFound((c) => pageErrorResponse(c, new ApiError("not_found", "no such page")));
  app.onError((error, c) => {
    const api = normalizeError(error);
    if (api.status >= 500) {
      log("http.error", {
        level: "error",
        requestId: c.get("requestId"),
        path: c.req.path,
        error: String(error),
      });
    }
    return pageErrorResponse(c, api);
  });
  return app;
}
