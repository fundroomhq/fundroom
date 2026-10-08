import type {
  Database,
  Membership,
  OfferingStatus,
  ResolvedWorkspace,
  TenantContext,
  Tx,
} from "@fundroom/db";
import { type Entitlements, PLAN_FEATURES } from "@fundroom/domain";
import type { ModuleManifest } from "./manifest.js";
import type { ModuleRegistry } from "./registry.js";
import { ModuleEnablementRepo } from "./repos/enablement-repo.js";

/*
 * Per-workspace enablement (§5.3): rows in `core.module_enablement` override each module's
 * `defaultEnabled`. Resolved once per request (one indexed read) and cached briefly per
 * workspace so the 404 guard on module routes costs nothing.
 */
export interface WorkspaceModules {
  readonly workspaceId: string;
  readonly enabled: ReadonlySet<string>;
  /** Flag overrides from `config.flags` merged over manifest defaults. */
  readonly flags: ReadonlyMap<string, boolean>;
}

export async function loadWorkspaceModules(
  db: Database,
  ctx: TenantContext,
  registry: ModuleRegistry,
  tx?: Tx | undefined,
): Promise<WorkspaceModules> {
  const rows =
    tx === undefined
      ? await db.withTenant(ctx, (t) => new ModuleEnablementRepo(ctx, t).list())
      : await new ModuleEnablementRepo(ctx, tx).list();
  const byModule = new Map(rows.map((r) => [r.module, r]));
  const enabled = new Set<string>();
  const flags = new Map(registry.flagDefaults);
  for (const m of registry.modules) {
    const row = byModule.get(m.id);
    const on =
      m.required === true ? true : row === undefined ? (m.defaultEnabled ?? true) : row.enabled;
    if (!on) continue;
    // A module whose dependency is off is off too.
    if ((m.dependsOn ?? []).some((dep) => !enabled.has(dep))) continue;
    enabled.add(m.id);
    const cfg = (row?.config ?? {}) as { flags?: Record<string, unknown> };
    for (const [k, v] of Object.entries(cfg.flags ?? {})) {
      if (typeof v === "boolean" && k.startsWith(`${m.id}.`)) flags.set(k, v);
    }
  }
  return { workspaceId: ctx.workspaceId, enabled, flags };
}

export interface EnablementCache {
  /**
   * `tx`: read through the caller's open transaction on a cache miss. A caller that already
   * holds a transaction (an outbox subscriber, a job) must pass it — opening a second pool
   * connection while holding one deadlocks the pool once every connection is held that way
   * (found in E2.6's review).
   */
  get(db: Database, ctx: TenantContext, tx?: Tx | undefined): Promise<WorkspaceModules>;
  invalidate(workspaceId: string): void;
}

/** Small per-process cache; enablement changes call `invalidate`. Default TTL 15 s. */
export function createEnablementCache(
  registry: ModuleRegistry,
  options: { ttlMs?: number; now?: () => number } = {},
): EnablementCache {
  const ttl = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: WorkspaceModules; until: number }>();
  return {
    async get(db, ctx, tx) {
      const hit = cache.get(ctx.workspaceId);
      if (hit !== undefined && hit.until > now()) return hit.value;
      const value = await loadWorkspaceModules(db, ctx, registry, tx);
      cache.set(ctx.workspaceId, { value, until: now() + ttl });
      return value;
    },
    invalidate(workspaceId) {
      cache.delete(workspaceId);
    },
  };
}

export function isHiddenFor(m: ModuleManifest, offeringStatus: OfferingStatus): boolean {
  return (m.offeringStatusRules?.hiddenWhen ?? []).includes(offeringStatus);
}

/**
 * Whether the workspace's offering status switches this module off outright (E1.6, R3). Unlike
 * `isHiddenFor` this applies to staff too: the bootstrap reports the module `enabled: false` and
 * emits none of its slots, and `api.ts` answers `module_disabled` for every route it mounts.
 *
 * **It applies to a `required` manifest as well, and used not to.** The short-circuit that used to
 * stand here — `if (m.required === true) return false;` — conflated two different questions asked
 * of two different rows:
 *
 *  - `required` answers "can a `core.module_enablement` row switch this off?" (no; and
 *    `loadWorkspaceModules`, which is the function that reads those rows, still honours it
 *    unconditionally). It is an *administrator preference* rule.
 *  - `disabledWhen` answers "may this workspace run this at all, whoever asks?" It is a
 *    *compliance* rule, read off `core.workspace.offering_status`, and E1.6's as-built is blunt
 *    that a compliance control an admin can walk around is no control.
 *
 * Reading the first to answer the second made `disabledWhen` **silently inert** on every kernel
 * manifest — a declaration accepted by `defineModule` and then ignored, which is the one thing a
 * manifest field must never be. E2.3's share links are the first manifest to declare both, and
 * the symptom was a "Share links" item in an `informational` workspace's admin nav pointing at
 * routes that (correctly) 404. Either the combination is legal and must work, or `defineModule`
 * should refuse it; since a kernel feature with a compliance switch is exactly what the product
 * needs, it is legal and it works.
 *
 * What this function still does **not** do is switch off *kernel* routes: they are registered
 * directly on the API app, above the per-module enablement middleware, so `requireOffering` in
 * `apps/server/src/middleware/authz.ts` remains the thing that closes that door. Both read the
 * same `disabledWhen` list, and `routes/links.test.ts` pins that they agree.
 */
export function isDisabledForOffering(m: ModuleManifest, offeringStatus: OfferingStatus): boolean {
  return (m.offeringStatusRules?.disabledWhen ?? []).includes(offeringStatus);
}

/**
 * Whether module `m`, `enabled` for a workspace with entitlements `e`, is **read-only** there
 * (A-3, ADR-0063 §3.2): on, optional, and outside an enforced plan — a downgrade. Staff may read it
 * and switch it off; their writes answer 402 `plan_limit` (`apps/server/src/module-read-only.ts`).
 * Investors are unaffected: what they reach is behind `requireMember`, never the permission guard.
 *
 * Computed at use time from the resolved workspace's plan, never stored and never cached with
 * enablement, so a plan change is seen on the next request with nothing to invalidate. A required
 * module is never read-only: no plan may list it, and the kernel cannot be switched off.
 */
export function moduleReadOnly(
  e: Pick<Entitlements, "enforced" | "allowsModule">,
  m: Pick<ModuleManifest, "id" | "required">,
  enabled: boolean,
): boolean {
  return e.enforced && enabled && m.required !== true && !e.allowsModule(m.id);
}

/**
 * The caller's permissions among the enabled modules' catalogue. `AuthzPort.permissionsFor`
 * (the matrix in `@fundroom/authz`) decides what a role holds; this only narrows the
 * catalogue to enabled modules. External kinds hold no permission (ADR-0014).
 *
 * `enabled` is the *preference* answer — `loadWorkspaceModules` knows about enablement rows and
 * nothing about the offering status, which lives on `core.workspace`. A caller assembling the
 * bootstrap should narrow it with `isDisabledForOffering` first, so that one response cannot
 * report a module off in `modules[].enabled` and hand out its permissions in the same breath.
 */
export function permissionsFor(
  membership: Pick<Membership, "kind" | "role" | "status"> | undefined,
  registry: ModuleRegistry,
  enabled: ReadonlySet<string>,
  authz: {
    permissionsFor(
      m: { kind: "staff" | "external"; role: string; status: string },
      catalogue: Iterable<string>,
    ): string[];
  },
): string[] {
  if (membership === undefined || membership.status !== "active") return [];
  const catalogue = [...registry.permissions.entries()]
    .filter(([, mod]) => enabled.has(mod))
    .map(([p]) => p);
  return authz.permissionsFor(membership, catalogue);
}

export interface BootstrapInput {
  readonly registry: ModuleRegistry;
  readonly workspace: ResolvedWorkspace | undefined;
  readonly modules: WorkspaceModules | undefined;
  readonly membership: Membership | undefined;
  /**
   * From `permissionsFor()`; the bootstrap never computes rights itself. It does **drop** the
   * permissions of a module the offering status switched off, because it is the same response
   * that reports that module `enabled: false` — see `buildBootstrap`.
   */
  readonly permissions: readonly string[];
  /**
   * The workspace's plan entitlements (A-3). Read for staff only: they drive `modules[].readOnly`
   * and the `entitlements` block, both of which describe the plan, and the plan is not an
   * investor's business. Omitted: nothing is read-only and no block is emitted.
   */
  readonly entitlements?: Entitlements | undefined;
}

/** `null` = all: an unrestricted list, no plan, or CONTROL_PLANE=off. */
function entitlementsBody(e: Entitlements) {
  const { modules, features } = e;
  return {
    modules: modules === "all" ? null : [...modules].sort(),
    // Display order (`PLAN_FEATURES`), the order every other surface lists them in.
    features: features === "all" ? null : PLAN_FEATURES.filter((f) => features.has(f)),
  };
}

/** The `/api/v1/modules` body. */
export function buildBootstrap(input: BootstrapInput) {
  const { registry, workspace, membership } = input;
  const enabled = input.modules?.enabled ?? new Set<string>();
  const flags = input.modules?.flags ?? registry.flagDefaults;
  const status = workspace?.offeringStatus ?? "none";
  const isStaff = membership?.kind === "staff";
  // Staff only (see `BootstrapInput.entitlements`): an investor's bootstrap must not tell them
  // which modules the company's plan has lapsed on, so for them nothing is read-only.
  const entitlements = isStaff ? input.entitlements : undefined;
  /*
   * The offering status applied to the permission catalogue as well as to the module list.
   *
   * `permissionsFor` narrows to the modules **enablement** leaves on, and deliberately knows
   * nothing about the offering status, which lives on `core.workspace` rather than on a
   * `core.module_enablement` row. Without this the same response would report `share-links`
   * `enabled: false` in `modules[]` and hand an owner `share-links.manage` in `permissions`, and
   * a client asked to reconcile two server facts picks the wrong one eventually (E1.6: one
   * server-computed boolean beats letting the browser re-derive the rule).
   */
  const withheld = new Set(
    [...registry.permissions.entries()]
      .filter(([, mod]) => {
        const manifest = registry.modules.find((m) => m.id === mod);
        return manifest !== undefined && isDisabledForOffering(manifest, status);
      })
      .map(([permission]) => permission),
  );
  return {
    workspace: workspace
      ? {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          offeringStatus: workspace.offeringStatus,
          defaultLocale: workspace.defaultLocale,
        }
      : null,
    modules: registry.modules.map((m) => {
      // The offering status can switch a module off for everyone (E1.6); `hidden` remains the
      // softer, investor-only rule. `slots` follow `on`, so a module the status switched off
      // contributes no admin nav item — which is the whole point: a nav computed from facts the
      // server holds must not offer a screen whose routes the server 404s.
      const offeringOff = isDisabledForOffering(m, status);
      const on = enabled.has(m.id) && !offeringOff;
      const hidden = !isStaff && isHiddenFor(m, status);
      return {
        id: m.id,
        version: m.version,
        enabled: on,
        hidden,
        readOnly: entitlements !== undefined && moduleReadOnly(entitlements, m, on),
        flags: Object.fromEntries([...flags.entries()].filter(([k]) => k.startsWith(`${m.id}.`))),
        slots: (hidden || !on ? {} : { ...(m.slots ?? {}) }) as Record<string, unknown[]>,
      };
    }),
    permissions: input.permissions.filter((p) => !withheld.has(p)),
    membership: membership
      ? { id: membership.id, kind: membership.kind, role: membership.role }
      : null,
    ...(entitlements === undefined ? {} : { entitlements: entitlementsBody(entitlements) }),
  };
}
