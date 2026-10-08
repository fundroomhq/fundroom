import { analyticsModule } from "@fundroom/module-analytics";
import { captableModule } from "@fundroom/module-captable";
import { contentModule } from "@fundroom/module-content";
import { crmModule } from "@fundroom/module-crm";
import { dataRoomModule } from "@fundroom/module-data-room";
import { defineModule, type ModuleManifest } from "@fundroom/module-kit";
import { metricsModule } from "@fundroom/module-metrics";
import { notifyModule } from "@fundroom/module-notify";
import { roundModule } from "@fundroom/module-round";
import { updatesModule } from "@fundroom/module-updates";

/**
 * Compiled-in modules (ADR-0007). `MODULES` in the environment narrows the set at boot.
 *
 * `access` is kernel-owned (E1.1): its routes live in `src/routes/access.ts` because they
 * need the identity service, the authz engine and the queue, which `ModuleManifest.routes`
 * cannot receive yet; the manifest carries what the registry needs (permissions for the RBAC
 * catalogue, admin nav slots) and is `required`, so no workspace can switch it off and other
 * modules may `dependsOn: ["access"]`.
 *
 * `content` (E1.2) is the first module package (`modules/content`): its own schema and
 * migrations, routes mounted from the manifest through `ModuleServices` (ADR-0033). It is
 * `required` too: the overview page is the investor landing page (§12 lists it under Kernel).
 */
export const accessModule: ModuleManifest = defineModule({
  id: "access",
  version: "0.1.0",
  required: true,
  permissions: [
    "access.read",
    "access.manage",
    "access.manage_staff",
    "access.transfer",
    "access.settings",
    // E2.7: owner-only, on top of step-up and a typed confirmation (authz-matrix.yaml).
    "access.delete_workspace",
  ],
  slots: {
    "admin.nav": [
      { id: "access-people", label: "People", to: "/admin/people", order: 20, icon: "people" },
      { id: "access-groups", label: "Groups", to: "/admin/groups", order: 21, icon: "access" },
      // E3.1: the approval queue for public access requests. Shares 22 with "Legal & offering"
      // (ties sort by label). Nav items carry no permission; the page's API answers 404 to a
      // caller without `access.read`.
      {
        id: "access-requests",
        label: "Requests",
        to: "/admin/access-requests",
        order: 22,
        icon: "requests",
      },
      // E2.7. 22–26 are taken by the workspace-shaped screens (legal … share links); the
      // periodic review of who holds access takes the next free number rather than renumbering.
      {
        id: "access-review",
        label: "Access review",
        to: "/admin/access-review",
        order: 27,
        icon: "review",
      },
      // E2.7: the settings hub lists every manifest's `admin.settings` entries and the danger
      // zone. Last, like a settings entry in any admin nav.
      { id: "settings", label: "Settings", to: "/admin/settings", order: 90, icon: "settings" },
    ],
    "admin.settings": [
      {
        id: "access-settings",
        label: "Access & sign-in",
        to: "/admin/settings/access",
        order: 10,
        icon: "access",
      },
      // Mail delivery (E2.6) has no manifest of its own: its kernel routes sit behind
      // `access.settings`, so its settings entry rides on the manifest that owns that permission.
      { id: "mail", label: "Mail delivery", to: "/admin/mail", order: 15, icon: "mail" },
    ],
  },
  // E3.4: kernel topics a workspace may subscribe outbound webhooks to.
  webhooks: ["access_request.submitted", "membership.created", "membership.revoked"],
});

/**
 * `compliance` (E1.6, ADR-0037) is kernel-owned for the same reason `access` is, only more
 * bluntly: the offering status is a column on `core.workspace`, the relationship facts are
 * columns on `core.membership`, and an acceptance is a `core.attestation` row. A module package
 * that reached into `core.*` for those would break the rule that makes modules safe to reason
 * about (principle 4), so the routes live in `src/routes/compliance.ts` and the manifest carries
 * only what the registry needs — the permissions for the RBAC catalogue and the admin nav slot.
 * It is `required`: a workspace that could switch off its own privacy notice and its own offering
 * mode would be a compliance control with an off switch, which is no control at all.
 */
export const complianceModule: ModuleManifest = defineModule({
  id: "compliance",
  version: "0.1.0",
  required: true,
  permissions: ["compliance.read", "compliance.manage", "compliance.offering"],
  slots: {
    "admin.nav": [
      {
        id: "compliance-legal",
        label: "Legal & offering",
        to: "/admin/legal",
        // Beside People and Groups (20, 21): the three screens an admin uses to answer "who is
        // in this room, and on what terms".
        order: 22,
        icon: "legal",
      },
    ],
    "admin.settings": [
      { id: "compliance-legal", label: "Legal", to: "/admin/legal", order: 20, icon: "legal" },
    ],
  },
});

/**
 * `branding` (E1.7, EXECUTION_PLAN §12 "branding basics") is kernel-owned for the third time
 * and the same reason: every fact it owns is the `branding` block of `core.workspace.settings`,
 * and a module package that reached into `core.*` would break the boundary that makes modules
 * safe to reason about. The handlers live in `src/routes/branding.ts`; the manifest carries
 * only what the registry needs — the two permissions and the admin nav slot.
 *
 * It is `required` because the portal cannot render without a brand: the theme tokens, the
 * email header and the logo route are read on every page and every send, and a workspace that
 * could switch them off would be switching off its own chrome.
 */
export const brandingModule: ModuleManifest = defineModule({
  id: "branding",
  version: "0.1.0",
  required: true,
  permissions: ["branding.read", "branding.manage"],
  slots: {
    "admin.nav": [
      {
        id: "branding",
        label: "Branding",
        to: "/admin/branding",
        // After Legal & offering (22): the workspace-shaped settings screens sit together,
        // below the three "who is in this room" screens.
        order: 23,
        icon: "branding",
      },
    ],
    "admin.settings": [
      { id: "branding", label: "Branding", to: "/admin/branding", order: 30, icon: "branding" },
    ],
  },
});

/**
 * `domains` (E2.1, EXECUTION_PLAN §9.2, ADR-0039) is kernel-owned for the fourth time, and for a
 * blunter reason than the three above it. The other three own facts that live in `core.*`; this
 * one owns the *routing decision itself*. The hostname → workspace lookup runs inside the tenant
 * classifier, before there is a tenant context or a module-enablement row to read, so a module
 * package owning `core.custom_domain` would mean the kernel querying a module's table on every
 * single request. The handlers live in `src/routes/domains.ts`; the manifest carries only what
 * the registry needs — the two permissions and the admin nav slot.
 *
 * It is `required`, and here that is not a convenience: a feature must not be able to switch off
 * its own routing. A workspace that disabled `domains` would keep its verified hostname in the
 * table (the classifier does not consult enablement, and must not — it runs before it), so the
 * portal would go on answering there while the screen that could remove the domain had vanished.
 * The only coherent state is the one where the routing and the screen that governs it are both
 * always present.
 */
export const domainsModule: ModuleManifest = defineModule({
  id: "domains",
  version: "0.1.0",
  required: true,
  permissions: ["domains.read", "domains.manage"],
  slots: {
    "admin.nav": [
      {
        id: "domains",
        label: "Domains",
        to: "/admin/domains",
        // After Branding (23): with the other workspace-shaped settings screens, because a
        // custom domain is the same kind of decision — what this portal looks and sounds like
        // to an investor — rather than a question about who is in the room.
        order: 24,
        icon: "domain",
      },
    ],
    "admin.settings": [
      { id: "domains", label: "Domains", to: "/admin/domains", order: 31, icon: "domain" },
    ],
  },
});

/**
 * `embed` (E2.2, EXECUTION_PLAN §9.3, design/08 §1c/§6, ADR-0008/0009/0040) is kernel-owned for
 * the fifth time, and on domains' reasoning rather than branding's. The allow-list it governs
 * becomes a response *header* — `frame-ancestors`, resolved by the security-headers middleware
 * before the handler runs and before module enablement is consulted. A module that owned it
 * could be switched off, and a switched-off framing control does not fail closed: the embed
 * document would keep rendering in an iframe with the allow-list gone. A security header must
 * not belong to something that has an off switch, which is why this manifest is `required` and
 * the handlers live in `src/routes/embed.ts`.
 */
export const embedModule: ModuleManifest = defineModule({
  id: "embed",
  version: "0.1.0",
  required: true,
  permissions: ["embed.read", "embed.manage"],
  slots: {
    "admin.nav": [
      {
        id: "embed",
        label: "Embed",
        to: "/admin/embed",
        // After Domains (24). The two answer the same question from opposite ends — where this
        // portal lives, and whose page it may live inside — so they sit next to each other.
        order: 25,
        icon: "embed",
      },
    ],
    "admin.settings": [
      { id: "embed", label: "Embed", to: "/admin/embed", order: 32, icon: "embed" },
    ],
  },
});

/**
 * Offering statuses in which share links are switched **off entirely** — not merely hidden.
 *
 * `permits(status).shareLinks` is already false for both (`packages/compliance`), and plan §11
 * says the same thing from the other end: a workspace with no offering, or one that is only
 * informational, has nothing to share links *to*. Exported because two things must agree on the
 * list — the manifest below, which is what the bootstrap and the admin nav read, and
 * `requireOffering` in `routes/links.ts`, which is what actually closes the door — and a
 * `shareLinksModule.test.ts` assertion pins that they do.
 */
export const SHARE_LINKS_DISABLED_WHEN = ["none", "informational"] as const;

/**
 * `share-links` (E2.3, EXECUTION_PLAN §9.3, design/05 §5, ADR-0041) is kernel-owned for the
 * sixth time, and on the sharpest reason of the six: **a share link mints a membership.**
 * `core.share_link` and `core.share_link_visit` are kernel tables, the visit row is the edge
 * `PrincipalRepo` walks to emit a `link` subject, and redemption runs inside identity's
 * `establishMembership` — the one code path that creates a `core.membership`, applies groups and
 * grants and bumps `acl_version`. A module package owning any of that would be a module writing
 * rows the kernel's own row security reads on every request. The handlers live in
 * `src/routes/links.ts`; the manifest carries the permissions and the nav slot.
 *
 * It is `required` for the reason every kernel manifest is: the routes are mounted above the
 * per-module enablement middleware and cannot be switched off by an enablement row, so claiming
 * otherwise would be a lie in the bootstrap.
 *
 * `offeringStatusRules.disabledWhen` is the compliance switch, and this is the first manifest in
 * the product to declare it. It does two things, in two places, off one list:
 *
 *  - `isDisabledForOffering` reports the module **off** in the bootstrap and drops its `slots`,
 *    so a `none` or `informational` workspace's admin nav has no "Share links" item at all. (It
 *    used to short-circuit to `false` for any `required` manifest, which made this declaration
 *    inert and left the nav offering a screen the routes 404'd — work package H, defect 2.)
 *  - `requireOffering` in `routes/links.ts` answers 404 on the routes themselves. That guard is
 *    still needed and always will be: kernel routes are mounted directly on the API app, above
 *    `api.ts`'s per-module enablement middleware, which only wraps routes a module package mounts.
 *
 * `required` is unchanged in meaning: no `core.module_enablement` row can switch this off. What
 * it does not mean is "exempt from a compliance switch".
 */
export const shareLinksModule: ModuleManifest = defineModule({
  id: "share-links",
  version: "0.1.0",
  required: true,
  permissions: ["share-links.read", "share-links.manage"],
  slots: {
    "admin.nav": [
      {
        id: "share-links",
        label: "Share links",
        to: "/admin/share-links",
        // After Embed (25). 25 is already double-booked by `embed` and `updates`; that collision
        // predates this epic and is recorded in the E2.3 contract for a later one, so nothing is
        // renumbered here and share links take the next free number.
        order: 26,
        icon: "link",
      },
    ],
  },
  offeringStatusRules: { disabledWhen: [...SHARE_LINKS_DISABLED_WHEN] },
});

/**
 * `audit` (E2.7, EXECUTION_PLAN §15 "audit log UI + signed export") is kernel-owned for the
 * seventh time. Every fact it shows is an `audit.event` row written by the kernel's own
 * recorder inside the transaction of the change it records; a module package owning the screen
 * would own the evidence of what every other module did. The handlers live in
 * `src/routes/audit.ts`; the manifest carries the two permissions and the admin nav slot.
 *
 * It is `required`: an audit log a workspace could switch off is not an audit log.
 * `audit.export` is narrower than `audit.read` — an export is a signed, portable copy of the
 * whole trail, the thing a regulator or a court asks for, so it goes to owner and legal only.
 */
export const auditModule: ModuleManifest = defineModule({
  id: "audit",
  version: "0.1.0",
  required: true,
  permissions: ["audit.read", "audit.export"],
  slots: {
    "admin.nav": [
      { id: "audit-log", label: "Audit log", to: "/admin/audit", order: 40, icon: "audit" },
    ],
  },
});

/**
 * `ops` (E2.7: the jobs/DLQ page and `/admin/health/deep`, served as `/api/v1/ops/health`) is
 * kernel-owned because what it reports is the host's own machinery — the job queue, the
 * dead-letter queue, the adapters' health checks — none of which a module owns. Instance-wide
 * facts (queue depths, adapter checks) are only shown in single-tenant mode; in multi-tenant
 * mode a workspace sees only its own dead letters and its own domains. `required`: the page
 * that tells an admin their jobs are failing must not have an off switch.
 */
export const opsModule: ModuleManifest = defineModule({
  id: "ops",
  version: "0.1.0",
  required: true,
  permissions: ["ops.read", "ops.manage"],
  slots: {
    "admin.nav": [
      { id: "ops-jobs", label: "Jobs", to: "/admin/jobs", order: 41, icon: "jobs" },
      { id: "ops-health", label: "Health", to: "/admin/health", order: 42, icon: "health" },
    ],
  },
});

/**
 * `search` (E2.8, EXECUTION_PLAN §15 "Postgres FTS with ACL filtering and extracted text") is
 * kernel-owned: the index is `core.search_entry`, written by every module through
 * `ModuleServices.search` and filtered by RLS against core's grants and groups, and the query
 * path must drop hits from modules a workspace has switched off — a decision only the kernel can
 * make about all modules at once. The handler lives in `src/routes/search.ts`. No permission:
 * every member may search, and sees only what they could open. `required`: a module's search
 * provider must not depend on whether a workspace enabled a search module.
 */
export const searchModule: ModuleManifest = defineModule({
  id: "search",
  version: "0.1.0",
  required: true,
});

/**
 * `portability` (E2.8, EXECUTION_PLAN §15 "workspace export zip (manifest + JSONL + blobs) +
 * import") is kernel-owned: an export reads every table of every compiled-in module plus the
 * kernel's own `core.*` rows and the audit chain, which no module may do. Handlers live in
 * `src/routes/portability.ts`. `portability.export` is owner-only (authz-matrix.yaml): the whole
 * company's data leaving the instance in one file. `required`: the right to leave with your data
 * must not have an off switch.
 */
export const portabilityModule: ModuleManifest = defineModule({
  id: "portability",
  version: "0.1.0",
  required: true,
  permissions: ["portability.export"],
  slots: {
    "admin.settings": [
      {
        id: "workspace-export",
        label: "Export workspace",
        to: "/admin/settings/export",
        order: 80,
        icon: "export",
      },
    ],
  },
});

/**
 * `api-keys` (E3.4, ADR-0052) is kernel-owned for the reason E2.1 generalised: **anything read
 * during tenant resolution cannot be a module.** The bearer lookup runs right after the
 * workspace is resolved, before module enablement is knowable, and it decides who the caller is.
 * The handlers live in `src/routes/api-keys.ts`; the manifest carries the permissions and the
 * settings-hub entry. `required`: authentication must not have an off switch.
 */
export const apiKeysModule: ModuleManifest = defineModule({
  id: "api-keys",
  version: "0.1.0",
  required: true,
  permissions: ["api-keys.read", "api-keys.manage"],
  slots: {
    "admin.settings": [
      // Shares 32 with Embed; ties sort by label.
      { id: "api-keys", label: "API keys", to: "/admin/api-keys", order: 32, icon: "key" },
    ],
  },
});

/**
 * `webhooks` (E3.4, ADR-0052) is kernel-owned because delivery needs the guarded outbound HTTP
 * agent, which is kernel-only on purpose, and because it fans out events from every module
 * (topics are the manifests' `webhooks` lists, offered only while the declaring module is
 * enabled). The handlers live in `src/routes/webhooks.ts`. `required`: the routes are mounted
 * above the per-module enablement middleware.
 */
export const webhooksModule: ModuleManifest = defineModule({
  id: "webhooks",
  version: "0.1.0",
  required: true,
  permissions: ["webhooks.read", "webhooks.manage"],
  slots: {
    "admin.settings": [
      { id: "webhooks", label: "Webhooks", to: "/admin/webhooks", order: 33, icon: "webhook" },
    ],
  },
});

/**
 * `esign` (E3.5, ADR-0053) is kernel-owned because an e-sign NDA ceremony closes the NDA gate that
 * `requireMember` enforces before module enablement is knowable (the E2.1 rule, ADR-0041/0032),
 * and because two modules (round closing, data-room vaulting) reach it through
 * `ModuleServices.esign`. The vendor connection's credentials need the kernel-only guarded
 * outbound client. The handlers live in `src/routes/esign.ts` (and the vendor callback in the ops
 * tree); the service is `@fundroom/esign`. `required`: an NDA gate must not have an off switch.
 * Settings order 34 (after Webhooks 33; the Embed/API-keys tie at 32 is left as it is).
 */
export const esignModule: ModuleManifest = defineModule({
  id: "esign",
  version: "0.1.0",
  required: true,
  permissions: ["esign.read", "esign.manage"],
  slots: {
    "admin.settings": [
      { id: "esign", label: "E-signature", to: "/admin/esign", order: 34, icon: "signature" },
    ],
  },
  // Ids-only, not person-level (the signer's membership id is a reference, not engagement).
  webhooks: ["esign.envelope_changed", "esign.envelope_completed"],
});

/**
 * `integrations` (E3.6, ADR-0054) is kernel-owned: the connections hold vendor credentials that
 * need the kernel-only guarded outbound client and the workspace key, the OAuth handshake and the
 * booking webhook run in the ops tree (no tenant, no session), and three modules (metrics, notify,
 * crm) reach it through `ModuleServices.integrations`. The handlers live in
 * `src/routes/integrations*.ts`; the service is `@fundroom/integrations`. `required`: turning the
 * hub off would strand live vendor tokens with nobody able to disconnect them.
 * Settings order 35 (after E-signature 34).
 */
export const integrationsModule: ModuleManifest = defineModule({
  id: "integrations",
  version: "0.1.0",
  required: true,
  permissions: ["integrations.read", "integrations.manage"],
  slots: {
    "admin.settings": [
      {
        id: "integrations",
        label: "Integrations",
        to: "/admin/integrations",
        order: 35,
        icon: "plug",
      },
    ],
  },
  // Ids-only (connection / booking ids, provider, status); no invitee email or account label.
  webhooks: ["integration.connection_unhealthy", "integration.booking_recorded"],
});

/**
 * `accreditation` (E3.7, ADR-0055) is kernel-owned for e-sign's reasons: a vendor account belongs to
 * the issuer, its credentials are sealed under the workspace key and reached through the kernel-only
 * guarded outbound client, and the vendor callback is an ops route that must find the connection
 * before it knows the tenant. The verification *record* stays in `round` (`round.verification`),
 * which reaches the connection through `ModuleServices.accreditation`. The handlers live in
 * `src/routes/accreditation*.ts`; the service is `@fundroom/accreditation`. `required`: turning it
 * off would strand live vendor credentials with nobody able to disconnect them. Not offered as
 * webhooks (`accreditation.provider_updated` is an internal wake-up). Settings order 36 (after
 * Integrations 35).
 */
export const accreditationModule: ModuleManifest = defineModule({
  id: "accreditation",
  version: "0.1.0",
  required: true,
  permissions: ["accreditation.read", "accreditation.manage"],
  slots: {
    "admin.settings": [
      {
        id: "accreditation",
        label: "Accreditation",
        to: "/admin/accreditation",
        order: 36,
        icon: "review",
      },
    ],
  },
});

/**
 * `sso` (E3.8, ADR-0056) is kernel-owned: SSO enforcement is read on every staff request during
 * tenant resolution (`core.workspace.sso_enforced`), and the login flow and SCIM run before module
 * enablement is knowable — anything read during tenant resolution cannot be a module. The handlers
 * live in `src/routes/sso*.ts` and `src/routes/scim.ts`; the services are `@fundroom/sso` and
 * `@fundroom/scim`. `required`: turning it off would strand an enforced workspace's staff and a
 * live SCIM token. Not offered as webhooks. Settings order 37 (after Accreditation 36).
 */
export const ssoModule: ModuleManifest = defineModule({
  id: "sso",
  version: "0.1.0",
  required: true,
  permissions: ["sso.read", "sso.manage"],
  slots: {
    "admin.settings": [
      {
        id: "sso",
        label: "Single sign-on",
        to: "/admin/sso",
        order: 37,
        icon: "sso",
      },
    ],
  },
});

/**
 * `billing` (E3.10, ADR-0058) is kernel-owned: the plan and the subscription are read during
 * tenant resolution (quotas, the suspension guard) and `core.subscription` is written by the
 * provider webhook before any workspace is known. The handlers live in `src/routes/billing*.ts`;
 * the service is `@fundroom/billing`. `required`, and inert unless CONTROL_PLANE=on with a
 * BILLING_DRIVER: its routes answer 404 then, and the web hides the settings entry
 * (`WebConfig.billing`). Settings order 38 (after Single sign-on 37).
 */
export const billingModule: ModuleManifest = defineModule({
  id: "billing",
  version: "0.1.0",
  required: true,
  permissions: ["billing.read", "billing.manage"],
  slots: {
    "admin.settings": [
      {
        id: "billing",
        label: "Billing",
        to: "/admin/billing",
        order: 38,
        icon: "billing",
      },
    ],
  },
});

/**
 * `residency` (E3.11, ADR-0059) is kernel-owned: a workspace's data region derives from its cell
 * (`core.workspace.data_region`), and the relocation hold and cross-cell routing are read during
 * tenant resolution — anything read during tenant resolution cannot be a module. The handler
 * lives in `src/routes/residency.ts` (read-only facts, `compliance.read`); the facts come from
 * `@fundroom/compliance` and the container's `residency`. `required`: the tenant must always be
 * able to see where its data lives. Settings order 39 (after Billing 38).
 */
export const residencyModule: ModuleManifest = defineModule({
  id: "residency",
  version: "0.1.0",
  required: true,
  slots: {
    "admin.settings": [
      {
        id: "residency",
        label: "Data residency",
        to: "/admin/settings/residency",
        order: 39,
        icon: "residency",
      },
    ],
  },
});

/**
 * `ai` (E3.12, ADR-0060) is kernel-owned: the operator's model provider, the per-workspace switch
 * and acknowledgement (`settings.ai`), budgets and `core.ai_request` are kernel facts, and the
 * two tasks belong to modules (`updates`, `data-room`) that register them through
 * `ModuleManifest.aiTasks`. The handlers live in `src/routes/ai.ts`; the kernel is
 * `@fundroom/ai`. `required`, and inert while AI_PROVIDER=none: every route then answers 409
 * `ai_unavailable` (GET /ai/status 200 with `available: false`) and the web hides the settings
 * entry (`WebConfig.ai`). Not offered as webhooks. Settings order 40 (after Data residency 39).
 */
export const aiModule: ModuleManifest = defineModule({
  id: "ai",
  version: "0.1.0",
  required: true,
  permissions: ["ai.read", "ai.manage"],
  slots: {
    "admin.settings": [
      {
        id: "ai",
        label: "AI assist",
        to: "/admin/settings/ai",
        order: 40,
        icon: "sparkles",
      },
    ],
  },
});

export const COMPILED_IN_MODULES: readonly ModuleManifest[] = [
  accessModule,
  complianceModule,
  brandingModule,
  domainsModule,
  embedModule,
  shareLinksModule,
  auditModule,
  opsModule,
  searchModule,
  portabilityModule,
  apiKeysModule,
  webhooksModule,
  esignModule,
  integrationsModule,
  accreditationModule,
  ssoModule,
  billingModule,
  residencyModule,
  aiModule,
  contentModule,
  dataRoomModule,
  updatesModule,
  analyticsModule,
  notifyModule,
  metricsModule,
  crmModule,
  roundModule,
  captableModule,
];
