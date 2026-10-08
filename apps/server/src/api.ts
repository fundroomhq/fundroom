import {
  ApiError,
  buildOpenApiDocument,
  createApi,
  type OpenAPIHono,
  type OpenApiDocument,
} from "@fundroom/contracts";
import type { ModuleRegistry, ModuleRouter } from "@fundroom/module-kit";
import { isDisabledForOffering } from "@fundroom/module-kit";
import type { AppEnv } from "./env.js";
import { type AcceptanceGate, createAcceptanceGate } from "./middleware/authz.js";
import { documentReadOnlyRefusals, markModuleMount } from "./module-read-only.js";
import { canonicalBaseOf } from "./path-mount.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerAccessAdminRoutes } from "./routes/access-admin.js";
import { registerAccessRequestRoutes } from "./routes/access-requests.js";
import { registerAccreditationRoutes } from "./routes/accreditation.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuditAnchorRoutes } from "./routes/audit-anchors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerBrandingRoutes } from "./routes/branding.js";
import { registerComplianceRoutes } from "./routes/compliance.js";
import { registerDelegateRoutes } from "./routes/delegates.js";
import { type ApiDeps, moduleServicesOf, stubDeps } from "./routes/deps.js";
import { registerDomainsRoutes } from "./routes/domains.js";
import { registerEmbedRoutes } from "./routes/embed.js";
import { registerESignRoutes } from "./routes/esign.js";
import { registerI18nRoutes } from "./routes/i18n.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerKernelRoutes } from "./routes/kernel.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerMailRoutes } from "./routes/mail.js";
import { registerOpsAdminRoutes } from "./routes/ops-admin.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerPlatformMoveRoutes } from "./routes/platform-moves.js";
import { registerPlatformPlanRoutes } from "./routes/platform-plans.js";
import { registerPlatformSanctionsRoutes } from "./routes/platform-sanctions.js";
import { registerPortabilityRoutes } from "./routes/portability.js";
import { registerResidencyRoutes } from "./routes/residency.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerSignupRoutes } from "./routes/signup.js";
import { registerSignupRegionRoutes } from "./routes/signup-regions.js";
import { registerSsoRoutes } from "./routes/sso.js";
import { registerSsoAuthRoutes } from "./routes/sso-flow.js";
import { registerViewAsRoutes } from "./routes/view-as.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { SERVER_VERSION } from "./version.js";

/*
 * `/api/v1` (ADR-0002). Kernel routes first, then every compiled-in module under
 * `/api/v1/<module>` behind an enablement guard: a disabled module's routes are 404 for that
 * workspace (`module_disabled`), and a module route never runs without a workspace.
 */
export function createApiApp(
  deps: ApiDeps,
  registry: ModuleRegistry,
  // One gate per app: its cache is the point, so it is handed to everything that mounts
  // `requireMember` (the compliance routes that clear it also invalidate it). `createApp` passes
  // the one it also gives the module raw mount.
  gate: AcceptanceGate = createAcceptanceGate({ db: () => deps.db, audit: () => deps.audit }),
): OpenAPIHono<AppEnv> {
  const api = createApi<AppEnv>();
  registerKernelRoutes(api, deps, gate);
  registerAuthRoutes(api, deps);
  registerSetupRoutes(api, deps);
  registerAccessRoutes(api, deps, gate);
  registerDelegateRoutes(api, deps, gate);
  registerComplianceRoutes(api, deps, gate);
  registerBrandingRoutes(api, deps);
  registerDomainsRoutes(api, deps);
  registerEmbedRoutes(api, deps);
  registerMailRoutes(api, deps);
  // Admin surfaces (E2.7).
  registerAuditRoutes(api, deps);
  registerAuditAnchorRoutes(api, deps); // E3.13 (foundation stubs)
  registerAccessAdminRoutes(api, deps, gate);
  registerViewAsRoutes(api, deps);
  registerOpsAdminRoutes(api, deps);
  // Search, export, a11y, i18n (E2.8).
  registerSearchRoutes(api, deps, gate);
  registerPortabilityRoutes(api, deps);
  registerI18nRoutes(api, deps);
  // Inside the API app, like every other route file, so the three public link routes are reachable
  // at `/embed/<slug>/api/v1/links/...` too (contract §6): a partitioned cookie minted on a route
  // the framed SPA cannot call afterwards would be minted and immediately unusable.
  registerLinkRoutes(api, deps);
  // Access requests (E3.1): two public routes beside the link ones, four admin queue routes.
  registerAccessRequestRoutes(api, deps, gate);
  // API keys and outbound webhooks (E3.4).
  registerApiKeyRoutes(api, deps);
  registerWebhookRoutes(api, deps);
  // E-signature (E3.5).
  registerESignRoutes(api, deps);
  // Integrations hub (E3.6).
  registerIntegrationRoutes(api, deps, gate);
  // Accreditation vendor connections (E3.7).
  registerAccreditationRoutes(api, deps);
  // Staff SSO + SCIM admin (E3.8) and the SSO login flow's workspace-origin routes.
  registerSsoRoutes(api, deps);
  registerSsoAuthRoutes(api, deps);
  // Managed-host control plane (E3.10): the operator API, plans/usage, billing, sanctions review
  // and self-service signup. All inert (404) unless CONTROL_PLANE=on.
  registerPlatformRoutes(api, deps);
  registerPlatformPlanRoutes(api, deps);
  registerBillingRoutes(api, deps);
  registerPlatformSanctionsRoutes(api, deps);
  registerSignupRoutes(api, deps);
  // Per-tenant data residency (E3.11): the tenant's residency facts, operator moves between cells
  // and the signup region picker. Wired once here; each file has one owner.
  registerResidencyRoutes(api, deps);
  registerPlatformMoveRoutes(api, deps);
  registerSignupRegionRoutes(api, deps);
  // AI assist (E3.12): settings, status and the caller's own suggestions; modules start requests.
  registerAiRoutes(api, deps);

  const services = moduleServicesOf(deps, gate);
  for (const m of registry.modules) {
    if (m.routes === undefined) continue;
    const sub = createApi<AppEnv>();
    sub.use("*", async (c, next) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const tenant = c.get("tenant") ?? { workspaceId: workspace.id, actorKind: "system" as const };
      const modules = await deps.enablement.get(deps.db, tenant);
      if (!modules.enabled.has(m.id))
        throw new ApiError("module_disabled", `${m.id} is not enabled here`);
      // A compliance gate, not a preference: an `informational` workspace must not be able to
      // reach a module that only makes sense while securities are being offered (E1.6, R3).
      if (isDisabledForOffering(m, workspace.offeringStatus))
        throw new ApiError(
          "module_disabled",
          `${m.id} is unavailable while the offering status is ${workspace.offeringStatus}`,
        );
      // A-3: on but outside the plan → read-only for staff. Only marked here; the permission
      // guard refuses, after the caller's own authorization (`module-read-only.ts`).
      markModuleMount(c, m, deps.entitlements.of(workspace));
      await next();
    });
    // AppEnv's variables are a superset of ModuleEnv's; Hono's generics are invariant.
    m.routes(sub as unknown as ModuleRouter, services);
    // Before `api.route`, which copies the OpenAPI definitions: the 402 a read-only module answers.
    documentReadOnlyRefusals(sub, m);
    api.route(`/${m.id}`, sub);
  }

  // The document itself, served from the API so the SDK and tooling can fetch it.
  // `servers` is the absolute canonical API base (BASE_URL + /api/v1, E3.9 FR1 B6): the same body
  // for every request, whichever face it came through, so it stays publicly cacheable.
  let served: OpenApiDocument | undefined;
  api.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    served ??= generateOpenApiDocument(registry, `${canonicalBaseOf(deps.baseUrl)}/api/v1`);
    return c.json(served);
  });

  return api;
}

/** The contract, built against a throwing stub: registration must not touch live services. */
export function generateOpenApiDocument(
  registry: ModuleRegistry,
  /** `servers[0].url`; default `/api/v1` (the committed SDK document). */
  serverUrl?: string,
): OpenApiDocument {
  const api = createApiApp(stubDeps(), registry);
  return buildOpenApiDocument(api as never, {
    version: SERVER_VERSION,
    serverUrl,
    description:
      "Gated investor-relations portal API. Sessions are cookies; mutating requests pass an Origin/Sec-Fetch-Site check; errors share one envelope (`Error`).",
  });
}
