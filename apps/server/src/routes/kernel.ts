import {
  ApiError,
  branding as b,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel as k,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { systemContext } from "@fundroom/db";
import { type Entitlements, parseWorkspaceSettings } from "@fundroom/domain";
import { boundWorkspaceOf } from "@fundroom/identity";
import type { ModuleManifest } from "@fundroom/module-kit";
import {
  buildBootstrap,
  ModuleEnablementRepo,
  moduleReadOnly,
  permissionsFor,
} from "@fundroom/module-kit";
import { z } from "@hono/zod-openapi";
import type { AppEnv } from "../env.js";
import { requireSession } from "../middleware/auth.js";
import { type AcceptanceGate, requireOwnerOrAdmin } from "../middleware/authz.js";
import { requireWorkspace } from "../middleware/tenant.js";
import { workspaceStatusView } from "../middleware/workspace-status.js";
import { pendingBody, pendingESignVendor } from "./compliance.js";
import type { ApiDeps } from "./deps.js";
import { membershipBody, sessionBody } from "./serialize.js";
import { appliedViewAs } from "./view-as.js";

const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
/** `PATCH /modules/{id}`: turning on a module the plan does not include is 402 (A-3). */
const ERRORS_PLAN = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);

/** Workspace-level kernel routes: the SPA bootstrap, `/me`, invite landing. */
export function registerKernelRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  /** Signed-out callers and a workspace-less origin never see the card; one cheap read otherwise. */
  const bookingLinksAvailable = async (
    workspace: AppEnv["Variables"]["workspace"],
    membership: AppEnv["Variables"]["membership"],
  ): Promise<boolean> => {
    if (workspace === undefined || membership === undefined) return false;
    const links = await deps.integrations.bookingLinks.forMember(
      systemContext(workspace.id),
      membership.id,
    );
    return links.length > 0;
  };

  api.openapi(
    createRoute({
      method: "get",
      path: "/modules",
      "x-requires": "public",
      tags: ["kernel"],
      summary: "SPA bootstrap: enabled modules, slots, flags and the caller's permissions",
      description:
        "Works signed out (public shape, no permissions). Without a workspace (multi-tenant host origin, or before setup) `workspace` is null and no module is enabled. `pendingAcceptances` carries the legal documents an external member must accept before anything else is served; it is empty for staff and signed-out callers.",
      responses: { 200: jsonResponse(k.ModulesBootstrapSchema, "Bootstrap"), ...ERRORS },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      const tenant = c.get("tenant");
      const modules =
        workspace === undefined
          ? undefined
          : await deps.enablement.get(
              deps.db,
              tenant ?? { workspaceId: workspace.id, actorKind: "system" },
            );
      const membership = c.get("membership");
      // Filled here rather than in `buildBootstrap`: `@fundroom/module-kit` is the module seam
      // and must not learn what a legal document is (ADR-0033, principle 4). The gate has this
      // answer cached already, so the interstitial costs the bootstrap nothing extra.
      const pendingAcceptances = await gate.pending(c);
      // Only an `esign` document costs a read (the vendor the member will sign with).
      const esignVendor =
        workspace === undefined
          ? null
          : await pendingESignVendor(
              deps.esign,
              deps.db,
              systemContext(workspace.id),
              pendingAcceptances,
            );
      return c.json(
        {
          // `permissionsFor` narrows the catalogue to the modules **enablement** leaves on;
          // `buildBootstrap` narrows what it is handed by the offering status, so one response
          // cannot report a module off and hand out its permissions in the same breath.
          ...buildBootstrap({
            registry: deps.registry,
            workspace,
            modules,
            membership,
            permissions: permissionsFor(
              membership,
              deps.registry,
              modules?.enabled ?? new Set(),
              deps.authz,
            ),
            // A-3: `modules[].readOnly` and the `entitlements` block — `buildBootstrap` emits both
            // for staff only, so the plan is never disclosed to an investor.
            entitlements: workspace === undefined ? undefined : deps.entitlements.of(workspace),
          }),
          pseudoLocale: deps.i18nPseudoLocale,
          pendingAcceptances: pendingAcceptances.map((p) => pendingBody(p, esignVendor)),
          // View as investor (E2.7): everything above is then the investor's; the SPA shows the
          // banner from this.
          viewAs: await appliedViewAs(c, deps.db),
          // E3.1: the sign-in page's "Request access" link. Read from the resolved workspace row
          // (already in hand), never from a module: tenant-resolution facts cannot be modules.
          requestAccessEnabled:
            workspace !== undefined &&
            parseWorkspaceSettings(workspace.settings).access.requests.enabled,
          // E3.6: the portal's "Book time" card — at least one enabled booking link this member
          // may see (staff: any; external/delegate: audience-filtered). Kernel, not a module.
          bookingLinksAvailable: await bookingLinksAvailable(workspace, membership),
          // E3.8: a staff member held out by enforced SSO (see `ssoBlocks`); the SPA sends them
          // to their IdP (or, for an owner, offers the step-up break-glass).
          ssoRequired: c.get("ssoRequired") !== undefined,
          ssoBreakGlass: c.get("ssoRequired")?.breakGlass === true,
          // E3.10: suspended / held for review (null when active). Staff see why; everybody
          // else only that the portal is unavailable.
          workspaceStatus: workspaceStatusView(
            workspace,
            membership?.kind === "staff" && c.get("viewAs") === undefined,
          ),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/me",
      "x-requires": "session",
      tags: ["account"],
      summary: "The signed-in user's session, membership here and workspaces",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      responses: { 200: jsonResponse(k.MeSchema, "Me"), ...ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const m = c.get("membership");
      // E3.8 (fix round 1, L1): a session one workspace's IdP minted serves that workspace only,
      // so it does not learn which other workspaces (and roles) the person holds either. E3.10:
      // the same for a session a central-auth handoff minted.
      const bound = boundWorkspaceOf(s);
      const workspaces = (await deps.auth.listMemberships(s.userId)).filter(
        (w) => bound === undefined || w.workspaceId === bound,
      );
      return c.json(
        {
          session: sessionBody(s),
          membership: membershipBody(
            m ? { id: m.id, kind: m.kind, role: m.role, status: m.status } : undefined,
          ),
          workspaces: workspaces.map((w) => ({
            workspaceId: w.workspaceId,
            membershipId: w.id,
            kind: w.kind,
            role: w.role,
            status: w.status,
          })),
          viewAs: await appliedViewAs(c, deps.db),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/invites/{token}",
      "x-requires": "public",
      tags: ["auth"],
      summary: "Invite landing: what the page may show before the invitee signs in",
      middleware: [requireWorkspace()] as const,
      request: { params: k.TokenParam },
      responses: {
        200: jsonResponse(k.InviteLandingSchema, "Never consumes the invite"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const ws = c.get("workspace");
      if (ws === undefined) throw new ApiError("setup_required");
      const r = await deps.auth.invites.resolve(ws.id, c.req.valid("param").token);
      return c.json(
        {
          valid: r.valid,
          ...(r.emailHint === undefined ? {} : { emailHint: r.emailHint }),
          ...(r.kind === undefined ? {} : { kind: r.kind }),
          ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt.toISOString() }),
        },
        200,
      );
    },
  );

  /*
   * Module enablement (E1.7, §5.3). Two routes: read the whole list, flip one module.
   *
   * `owner-or-admin` rather than a new permission, because enablement is not a per-module
   * capability — it is a decision about the shape of the whole workspace, and a role that may
   * manage a module's content has no business deciding whether the module exists here.
   *
   * The refusals are the interesting part. `required` modules (access, compliance, branding,
   * content) cannot be switched off: a kernel surface with an off switch is not a kernel
   * surface. A module another enabled module `dependsOn` cannot be switched off either, and a
   * module whose own dependency is off cannot be switched on — `loadWorkspaceModules` already
   * drops such a module from the enabled set silently, and a row that says `enabled: true`
   * while the module answers 404 is the worst of both answers.
   *
   * A-3 (ADR-0063) adds the plan: an optional module the workspace's plan does not include cannot
   * be switched on (402, `lockedReason: "plan"` while it is off), and one that is already on stays
   * on, read-only for staff — it can still be switched off, which is why it is not locked.
   */
  const lockOf = (
    m: ModuleManifest,
    enabled: ReadonlySet<string>,
    planAllows: boolean,
  ): { locked: boolean; lockedReason: "required" | "dependency" | "plan" | null } => {
    if (m.required === true) return { locked: true, lockedReason: "required" };
    if (!enabled.has(m.id) && !planAllows) return { locked: true, lockedReason: "plan" };
    const dependents = deps.registry.modules.filter(
      (other) => enabled.has(other.id) && (other.dependsOn ?? []).includes(m.id),
    );
    return dependents.length > 0
      ? { locked: true, lockedReason: "dependency" }
      : { locked: false, lockedReason: null };
  };

  /** A required module is never on a plan's list and always allowed. */
  const planAllowsOf = (m: ModuleManifest, e: Entitlements) =>
    m.required === true || e.allowsModule(m.id);

  const enablementBody = (m: ModuleManifest, enabled: ReadonlySet<string>, e: Entitlements) => {
    const planAllows = planAllowsOf(m, e);
    return {
      id: m.id,
      enabled: enabled.has(m.id),
      ...lockOf(m, enabled, planAllows),
      dependsOn: [...(m.dependsOn ?? [])],
      planAllows,
      readOnly: moduleReadOnly(e, m, enabled.has(m.id)),
    };
  };

  /** The resolved workspace's entitlements; the guards before every caller resolved it. */
  const entitlementsHere = (workspace: AppEnv["Variables"]["workspace"]) => {
    if (workspace === undefined) throw new ApiError("setup_required");
    return deps.entitlements.of(workspace);
  };

  api.openapi(
    createRoute({
      method: "get",
      path: "/modules/enablement",
      "x-requires": "owner-or-admin",
      tags: ["kernel"],
      summary: "Every compiled-in module, whether it is on here, and whether it can be turned off",
      description:
        'The wizard\'s modules checklist and the admin modules page read this. `locked` with `lockedReason: "required"` is a kernel surface; `"dependency"` means another enabled module needs it; `"plan"` means it is off and the workspace\'s plan does not include it. `readOnly`: on but outside the plan, so staff writes answer 402 `plan_limit` (it can still be switched off).',
      security: sessionSecurity,
      middleware: [requireOwnerOrAdmin()] as const,
      responses: { 200: jsonResponse(b.ModuleEnablementListSchema, "Modules"), ...ERRORS },
    }),
    async (c) => {
      const tenant = c.get("tenant") as NonNullable<AppEnv["Variables"]["tenant"]>;
      const { enabled } = await deps.enablement.get(deps.db, tenant);
      const e = entitlementsHere(c.get("workspace"));
      return c.json(
        { modules: deps.registry.modules.map((m) => enablementBody(m, enabled, e)) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/modules/{id}",
      "x-requires": "owner-or-admin",
      tags: ["kernel"],
      summary: "Turn a module on or off for this workspace",
      description:
        'Answers 409 `conflict` for a change that would leave the workspace inconsistent: disabling a `required` module, disabling one another enabled module depends on, or enabling one whose own dependency is off. Answers 402 `plan_limit` (`limit: "module"`) for enabling an optional module that is off and that the workspace\'s plan does not include; turning a module off, or on when it already is, is never refused for the plan.',
      security: sessionSecurity,
      middleware: [requireOwnerOrAdmin()] as const,
      request: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: jsonBody(b.ModuleEnablementPatchBody),
      },
      responses: { 200: jsonResponse(b.ModuleEnablementSchema, "Module"), ...ERRORS_PLAN },
    }),
    async (c) => {
      const tenant = c.get("tenant") as NonNullable<AppEnv["Variables"]["tenant"]>;
      const { id } = c.req.valid("param");
      const { enabled: wanted } = c.req.valid("json");
      const manifest = deps.registry.modules.find((m) => m.id === id);
      if (manifest === undefined) throw new ApiError("not_found", `no module ${id} is compiled in`);
      const e = entitlementsHere(c.get("workspace"));
      const before = await deps.enablement.get(deps.db, tenant);
      /*
       * A-3: a plan gates turning a module on. Off is always allowed (a downgraded module may be
       * switched off; turning it back on is then refused), and so is "on" for a module that
       * already is (R2 L4: nothing turns on). "Already on" is decided by the write itself, in
       * this transaction (ROUND-2 decision 15): never from the per-process cache, which another
       * instance's (or a concurrent request's) switch-off does not reach. Refused before the
       * consistency checks: those run after it in the same transaction, which a 409 rolls back.
       */
      const outsidePlan = wanted && manifest.required !== true && !e.allowsModule(id);

      await deps.db.withTenant(tenant, async (tx) => {
        const repo = new ModuleEnablementRepo(tenant, tx);
        if (outsidePlan && !(await repo.keepOnIfOn(id, manifest.defaultEnabled ?? true)))
          deps.entitlements.assertModule(e, id);

        if (!wanted) {
          if (manifest.required === true)
            throw new ApiError("conflict", `${id} is required and cannot be turned off`, {
              reason: "required",
            });
          const dependents = deps.registry.modules
            .filter((m) => before.enabled.has(m.id) && (m.dependsOn ?? []).includes(id))
            .map((m) => m.id);
          if (dependents.length > 0) {
            throw new ApiError("conflict", `${dependents.join(", ")} depends on ${id}`, {
              reason: "dependency",
              dependents,
            });
          }
        } else {
          const missing = (manifest.dependsOn ?? []).filter((dep) => !before.enabled.has(dep));
          if (missing.length > 0) {
            throw new ApiError("conflict", `${id} needs ${missing.join(", ")} enabled first`, {
              reason: "dependency",
              missing,
            });
          }
        }

        // What the workspace had chosen, read in this transaction (not the cache): a row, else the
        // manifest's default; a required module is always on. Outside the plan the conditional
        // write above has already proved it was on.
        const was =
          outsidePlan ||
          manifest.required === true ||
          ((await repo.get(id))?.enabled ?? manifest.defaultEnabled ?? true);
        if (!outsidePlan) await repo.set(id, wanted);
        // A request that changes nothing (an already-on enable, an already-off disable) is not an
        // enablement change, and the audit trail does not say it was (decision 21).
        if (was === wanted) return;
        await deps.audit.record(tx, tenant, {
          action: "module.enablement_changed",
          resourceKind: "module",
          // `audit.event.resource_id` is a uuid column and a module id is a slug, so the
          // module rides in `meta` and the row is keyed by kind alone.
          resourceId: null,
          requestId: requestIdOf(c),
          diff: { before: { enabled: was }, after: { enabled: wanted } },
          meta: { module: id },
        });
      });
      // The 404 guard in front of every module route reads this cache on every request.
      deps.enablement.invalidate(tenant.workspaceId);
      const after = await deps.enablement.get(deps.db, tenant);
      return c.json(enablementBody(manifest, after.enabled, e), 200);
    },
  );
}
