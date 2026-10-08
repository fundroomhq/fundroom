import { describe, expect, it } from "vitest";
import { buildBootstrap, isDisabledForOffering, permissionsFor } from "./enablement.js";
import {
  defineModule,
  isLiveModuleServices,
  ModuleManifestError,
  type ModuleServices,
} from "./manifest.js";
import { createModuleRegistry } from "./registry.js";

const access = defineModule({
  id: "access",
  version: "1.0.0",
  permissions: ["access.read", "access.manage"],
});
const content = defineModule({
  id: "content",
  version: "1.0.0",
  dependsOn: ["access"],
  permissions: ["content.read", "content.manage"],
  flags: { "content.drafts": { default: true } },
  slots: { "investor.nav": [{ id: "home", label: "Home", to: "/", order: 10 }] },
  offeringStatusRules: { hiddenWhen: ["informational"] },
});
const terms = defineModule({
  id: "terms",
  version: "1.0.0",
  // Permissions so the bootstrap has something to withhold; a module switched off by the
  // offering status must not hand out its rights in the same response that reports it off.
  permissions: ["terms.read", "terms.sign"],
  // The compliance gate E1.6 added: not "keep it off the investor's menu" but "this workspace
  // may not run it at all". No shipped module needs it yet; the round and terms module (E2.5)
  // is what it exists for.
  offeringStatusRules: { disabledWhen: ["none", "informational"] },
});
/*
 * A kernel manifest with a compliance switch: `required: true` **and** `disabledWhen`.
 *
 * This fixture used to pin the opposite of what it pins now — that `isDisabledForOffering`
 * answered `false` for it, on the reading that "a `required` module is kernel plumbing; an
 * offering status cannot remove it". That reading conflated two questions asked of two different
 * rows, and it was wrong in a way no shipped manifest could show until E2.3: `required` answers
 * "can a `core.module_enablement` row switch this off?" — which `loadWorkspaceModules` still
 * answers `no` to, unconditionally — while `disabledWhen` answers "may this workspace run it at
 * all?" off `core.workspace.offering_status`. Letting the first decide the second made the second
 * **silently inert** on every kernel manifest: a field `defineModule` accepts and then ignores.
 * The symptom, once share links became the first manifest to declare both, was an admin nav item
 * in an `informational` workspace pointing at routes that (correctly) 404.
 *
 * `required` still means what it always meant — no enablement row can switch it off. What it no
 * longer means is "exempt from compliance".
 */
const requiredEverywhere = defineModule({
  id: "kernel-ish",
  version: "1.0.0",
  required: true,
  offeringStatusRules: { disabledWhen: ["informational"] },
  slots: {
    "admin.nav": [{ id: "kernel-ish", label: "Kernel-ish", to: "/admin/kernel-ish", order: 99 }],
  },
});
const dataRoom = defineModule({
  id: "data-room",
  version: "1.0.0",
  dependsOn: ["access", "content"],
  jobs: [{ name: "data-room.render", handler: async () => {} }],
  events: { handles: { "membership.revoked": async () => {} } },
  blockHydrators: [{ type: "document_list", hydrate: async () => ({ documents: [] }) }],
});

describe("defineModule", () => {
  it("validates ids, permissions, jobs and flags", () => {
    expect(() => defineModule({ id: "Bad", version: "1.0.0" })).toThrow(ModuleManifestError);
    expect(() => defineModule({ id: "x", version: "1" })).toThrow(/SemVer/u);
    expect(() => defineModule({ id: "x", version: "1.0.0", permissions: ["y.read"] })).toThrow(
      /x\.<verb>/u,
    );
    expect(() =>
      defineModule({ id: "x", version: "1.0.0", jobs: [{ name: "y.z", handler: async () => {} }] }),
    ).toThrow();
    expect(() =>
      defineModule({ id: "x", version: "1.0.0", flags: { "y.f": { default: true } } }),
    ).toThrow();
    expect(() => defineModule({ id: "x", version: "1.0.0", migrations: "/tmp" })).toThrow(
      /schema/u,
    );
    expect(() => defineModule({ id: "x", version: "1.0.0", dependsOn: ["x"] })).toThrow(/itself/u);
    const h = { type: "metric_grid", hydrate: async () => ({}) };
    expect(() => defineModule({ id: "x", version: "1.0.0", blockHydrators: [h, h] })).toThrow(
      /twice/u,
    );
    expect(() =>
      defineModule({ id: "x", version: "1.0.0", blockHydrators: [{ ...h, type: "Bad-Type" }] }),
    ).toThrow(/snake_case/u);
  });

  it("validates search and portability declarations (E2.8)", () => {
    const entries = async () => [];
    expect(() =>
      defineModule({ id: "x", version: "1.0.0", search: { version: 0, entries } }),
    ).toThrow(/search\.version/u);
    const base = { id: "x", version: "1.0.0", schema: "x" } as const;
    expect(() =>
      defineModule({
        ...base,
        portability: {
          version: 1,
          tables: [
            { table: "a", mode: "rows" },
            { table: "a", mode: "rows" },
          ],
        },
      }),
    ).toThrow(/twice/u);
    expect(() =>
      defineModule({
        ...base,
        portability: { version: 1, tables: [{ table: "a", mode: "skip" }] },
      }),
    ).toThrow(/reason/u);
    expect(() =>
      defineModule({
        ...base,
        portability: {
          version: 1,
          tables: [
            { table: "a", mode: "rows", blobs: [{ keyColumn: "k", encryptionColumn: "e" }] },
          ],
        },
      }),
    ).toThrow(/purpose/u);
    expect(() =>
      defineModule({
        ...base,
        portability: {
          version: 1,
          tables: [{ table: "a", mode: "skip", reason: "derived", includeWhen: "rawAnalytics" }],
        },
      }),
    ).toThrow(/includeWhen/u);
    expect(() =>
      defineModule({
        id: "x",
        version: "1.0.0",
        portability: { version: 1, tables: [{ table: "a", mode: "rows" }] },
      }),
    ).toThrow(/schema/u);
    expect(() =>
      defineModule({
        ...base,
        search: { version: 1, entries },
        portability: {
          version: 1,
          tables: [
            { table: "a", mode: "rows" },
            { table: "b", mode: "skip", reason: "derived" },
            { table: "c", mode: "rows", includeWhen: "rawAnalytics" },
          ],
          beforeImport: async () => {},
        },
      }),
    ).not.toThrow();
  });
});

describe("createModuleRegistry", () => {
  it("orders by dependencies deterministically and merges contributions", () => {
    const r = createModuleRegistry([dataRoom, content, access]);
    expect(r.ids).toEqual(["access", "content", "data-room"]);
    expect([...r.permissions.keys()]).toEqual([
      "access.read",
      "access.manage",
      "content.read",
      "content.manage",
    ]);
    expect(r.jobs.map((j) => j.name)).toEqual(["data-room.render"]);
    expect(r.subscriptions.map((s) => s.id)).toEqual(["data-room.membership_revoked"]);
    expect(r.flagDefaults.get("content.drafts")).toBe(true);
    expect(r.blockHydrators.get("document_list")?.module).toBe("data-room");
    expect(r.blockHydrators.has("metric_grid")).toBe(false);
    const dup = defineModule({
      id: "metrics",
      version: "1.0.0",
      blockHydrators: [{ type: "document_list", hydrate: async () => ({}) }],
    });
    expect(() => createModuleRegistry([dataRoom, content, access, dup])).toThrow(/declared twice/u);
  });

  it("selects MODULES plus transitive dependencies", () => {
    const r = createModuleRegistry([dataRoom, content, access], { only: ["data-room"] });
    expect(r.ids).toEqual(["access", "content", "data-room"]);
    const only = createModuleRegistry([dataRoom, content, access], { only: ["access"] });
    expect(only.ids).toEqual(["access"]);
    expect(only.has("content")).toBe(false);
    expect(() => only.get("content")).toThrow(/unknown module/u);
    expect(() => createModuleRegistry([access], { only: ["nope"] })).toThrow(
      /unknown module nope/u,
    );
  });

  it("rejects cycles, duplicates and unknown dependencies", () => {
    const a = defineModule({ id: "a", version: "1.0.0", dependsOn: ["b"] });
    const b = defineModule({ id: "b", version: "1.0.0", dependsOn: ["a"] });
    expect(() => createModuleRegistry([a, b])).toThrow(/cycle/u);
    expect(() => createModuleRegistry([a])).toThrow(/unknown module b/u);
    expect(() => createModuleRegistry([access, access])).toThrow(/twice/u);
  });
});

describe("webhook topics (E3.4)", () => {
  it("defineModule accepts catalogue topics a module emits, and kernel topics on a kernel manifest", () => {
    expect(() =>
      defineModule({
        id: "updates",
        version: "1.0.0",
        schema: "updates",
        events: { emits: ["update.published", "update.viewed"] },
        webhooks: ["update.published", "update.viewed"],
      }),
    ).not.toThrow();
    expect(() =>
      defineModule({ id: "access", version: "1.0.0", webhooks: ["membership.created"] }),
    ).not.toThrow();
  });

  it("defineModule rejects unknown, un-emitted and duplicate topics", () => {
    expect(() =>
      defineModule({ id: "access", version: "1.0.0", webhooks: ["nope.happened"] }),
    ).toThrow(/is not an event/u);
    expect(() =>
      defineModule({
        id: "updates",
        version: "1.0.0",
        events: { emits: ["update.sent"] },
        webhooks: ["update.published"],
      }),
    ).toThrow(/not in the module's events.emits/u);
    expect(() =>
      defineModule({
        id: "updates",
        version: "1.0.0",
        schema: "updates",
        webhooks: ["update.sent"],
      }),
    ).toThrow(/not in the module's events.emits/u);
    expect(() =>
      defineModule({
        id: "access",
        version: "1.0.0",
        webhooks: ["membership.created", "membership.created"],
      }),
    ).toThrow(/declared twice/u);
  });

  it("the registry lists topics with their module in boot order and refuses a topic offered twice", () => {
    const kernel = defineModule({
      id: "access",
      version: "1.0.0",
      webhooks: ["membership.created", "membership.revoked"],
    });
    const updates = defineModule({
      id: "updates",
      version: "1.0.0",
      dependsOn: ["access"],
      events: { emits: ["update.sent"] },
      webhooks: ["update.sent"],
    });
    expect(createModuleRegistry([updates, kernel]).webhookTopics()).toEqual([
      { topic: "membership.created", moduleId: "access" },
      { topic: "membership.revoked", moduleId: "access" },
      { topic: "update.sent", moduleId: "updates" },
    ]);
    expect(createModuleRegistry([access]).webhookTopics()).toEqual([]);
    const thief = defineModule({ id: "thief", version: "1.0.0", webhooks: ["membership.created"] });
    expect(() => createModuleRegistry([kernel, thief])).toThrow(
      /webhook topic membership.created offered by access and thief/u,
    );
  });
});

describe("bootstrap", () => {
  const registry = createModuleRegistry([dataRoom, content, access, terms, requiredEverywhere]);
  const workspace = {
    id: "w",
    slug: "acme",
    name: "Acme",
    offeringStatus: "informational" as const,
    settings: {},
    settingsSchemaVersion: 1,
    aclVersion: 0,
    defaultLocale: "en",
    ssoEnforced: false,
    ssoConnectionId: null,
    ssoConnectionVersion: null,
    cellId: "default",
    dataRegion: null,
    status: "active" as const,
    suspendedReason: null,
    planId: null,
    primaryHost: null,
    planLimits: null,
  };
  const base = {
    kind: "staff" as const,
    status: "active" as const,
    id: "m",
    role: "owner" as const,
  };

  it("narrows the catalogue to enabled modules and lets AuthzPort decide", () => {
    const enabled = new Set(["access", "content"]);
    const seen: string[][] = [];
    const authz = {
      permissionsFor: (
        m: { kind: "staff" | "external"; role: string; status: string },
        catalogue: Iterable<string>,
      ) => {
        seen.push([...catalogue]);
        return m.kind === "staff" ? [...catalogue].filter((p) => p.endsWith(".manage")) : [];
      },
    };
    expect(permissionsFor(base, registry, enabled, authz)).toEqual([
      "access.manage",
      "content.manage",
    ]);
    expect(seen[0]).toEqual(["access.read", "access.manage", "content.read", "content.manage"]);
    expect(
      permissionsFor({ ...base, kind: "external", role: "investor" }, registry, enabled, authz),
    ).toEqual([]);
    expect(permissionsFor({ ...base, status: "revoked" }, registry, enabled, authz)).toEqual([]);
    expect(permissionsFor(undefined, registry, enabled, authz)).toEqual([]);
  });

  it("hides modules per offering status for investors but not staff, and drops slots of disabled modules", () => {
    const modules = {
      workspaceId: "w",
      enabled: new Set(["access", "content"]),
      flags: new Map([["content.drafts", false]]),
    };
    const investor = buildBootstrap({
      registry,
      workspace,
      modules,
      membership: { ...base, kind: "external", role: "investor" } as never,
      permissions: [],
    });
    const contentDesc = investor.modules.find((m) => m.id === "content");
    expect(contentDesc).toMatchObject({
      enabled: true,
      hidden: true,
      flags: { "content.drafts": false },
      slots: {},
    });
    expect(investor.modules.find((m) => m.id === "data-room")).toMatchObject({
      enabled: false,
      slots: {},
    });
    const staff = buildBootstrap({
      registry,
      workspace,
      modules,
      membership: base as never,
      permissions: ["access.manage"],
    });
    expect(staff.permissions).toEqual(["access.manage"]);
    expect(staff.modules.find((m) => m.id === "content")).toMatchObject({ hidden: false });
    expect(staff.modules.find((m) => m.id === "content")?.slots["investor.nav"]).toHaveLength(1);
    expect(staff.workspace?.slug).toBe("acme");
    const anon = buildBootstrap({
      registry,
      workspace: undefined,
      modules: undefined,
      membership: undefined,
      permissions: [],
    });
    expect(anon.workspace).toBeNull();
    expect(anon.permissions).toEqual([]);
  });

  it("`disabledWhen` switches a module off for staff too, required manifests included", () => {
    // `hiddenWhen` is a nav decision and `disabledWhen` is a compliance one, so an admin of an
    // `informational` workspace must not be able to reach the module at all — otherwise the
    // control is a menu edit an admin can walk around (ADR-0037 decision 3).
    expect(isDisabledForOffering(terms, "informational")).toBe(true);
    expect(isDisabledForOffering(terms, "506b")).toBe(false);
    // And `required` buys no exemption; see the fixture's comment for why it used to.
    expect(isDisabledForOffering(requiredEverywhere, "informational")).toBe(true);
    expect(isDisabledForOffering(requiredEverywhere, "506b")).toBe(false);

    const modules = {
      workspaceId: "w",
      enabled: new Set(["access", "content", "terms", "kernel-ish"]),
      flags: new Map<string, boolean>(),
    };
    const staff = buildBootstrap({
      registry,
      workspace,
      modules,
      membership: base as never,
      permissions: [],
    });
    expect(staff.modules.find((m) => m.id === "terms")).toMatchObject({
      enabled: false,
      slots: {},
    });
    // The defect this closes: with the short-circuit in place the manifest's slots were still
    // emitted, so an `informational` workspace's admin nav offered a screen the server 404s.
    expect(staff.modules.find((m) => m.id === "kernel-ish")).toMatchObject({
      enabled: false,
      slots: {},
    });

    // The same registry under a status that permits it: enabled again, nav item back.
    const raising = buildBootstrap({
      registry,
      workspace: { ...workspace, offeringStatus: "506b" as const },
      modules,
      membership: base as never,
      permissions: [],
    });
    expect(raising.modules.find((m) => m.id === "terms")).toMatchObject({ enabled: true });
    const kernelish = raising.modules.find((m) => m.id === "kernel-ish");
    expect(kernelish).toMatchObject({ enabled: true });
    expect(kernelish?.slots["admin.nav"]).toHaveLength(1);
  });

  /*
   * One answer per response. `permissionsFor` narrows the catalogue by *enablement* and knows
   * nothing about the offering status (which is a column on `core.workspace`, not an enablement
   * row), so without this filter the bootstrap would report a module `enabled: false` in
   * `modules[]` and hand out its permissions in `permissions` — two server facts a client would
   * have to reconcile, and the nav is exactly where it would reconcile them wrongly.
   */
  it("withholds the permissions of a module the offering status switched off", () => {
    const modules = {
      workspaceId: "w",
      enabled: new Set(["access", "content", "terms"]),
      flags: new Map<string, boolean>(),
    };
    const granted = ["access.manage", "terms.sign", "content.manage"];
    const off = buildBootstrap({
      registry,
      workspace,
      modules,
      membership: base as never,
      permissions: granted,
    });
    expect(off.permissions).toEqual(["access.manage", "content.manage"]);

    const on = buildBootstrap({
      registry,
      workspace: { ...workspace, offeringStatus: "506b" as const },
      modules,
      membership: base as never,
      permissions: granted,
    });
    expect(on.permissions).toEqual(granted);
  });
});

describe("isLiveModuleServices", () => {
  /*
   * The whole point is that it cannot be a flag: the stub is a Proxy that throws on every
   * property read, and anything a module could *test* for could also be forged by whatever set
   * it. So the probe is the read itself.
   */
  it("tells the live composition root from the throwing OpenAPI stub", () => {
    const live = { db: {} } as unknown as ModuleServices;
    const stub = new Proxy({} as ModuleServices, {
      get(_t, prop) {
        throw new Error(`route touched deps.${String(prop)} at registration time`);
      },
    });
    expect(isLiveModuleServices(live)).toBe(true);
    expect(isLiveModuleServices(stub)).toBe(false);
  });
});
