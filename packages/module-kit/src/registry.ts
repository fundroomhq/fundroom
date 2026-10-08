import type { MigrationSource } from "@fundroom/db";
import type { EventTopic } from "@fundroom/domain";
import type { Subscription } from "@fundroom/events";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import {
  AI_FEATURES,
  type AiFeature,
  type ModuleManifest,
  ModuleManifestError,
  type ModuleRegistryView,
  type ModuleServices,
  type RegisteredAiContextProvider,
  type RegisteredAiTask,
  type RegisteredHydrator,
  type ResourceKindPolicy,
} from "./manifest.js";

/*
 * The registry (§5.3 "registry mechanics"): validates the set of compiled-in modules,
 * orders them by `dependsOn` (deterministic topological order, ties by id), and exposes
 * the merged contributions the composition root wires: migration sources, jobs, event
 * subscriptions, the permission catalogue.
 */
export interface RegistryOptions {
  /** `MODULES` from config: load only these (and their dependencies). `undefined` = all. */
  readonly only?: readonly string[] | undefined;
}

export interface ModuleRegistry {
  /** Boot order. */
  readonly modules: readonly ModuleManifest[];
  readonly ids: readonly string[];
  has(id: string): boolean;
  get(id: string): ModuleManifest;
  /** `<module>.<verb>` → module id. */
  readonly permissions: ReadonlyMap<string, string>;
  readonly migrationSources: readonly MigrationSource[];
  /** Jobs declared as plain arrays. `resolveJobs(services)` adds the factory-built ones. */
  readonly jobs: readonly JobDefinition<JsonObject>[];
  /** Every module job, static and factory-built; names checked for the `<id>.` prefix and uniqueness. */
  resolveJobs(services: ModuleServices): readonly JobDefinition<JsonObject>[];
  readonly subscriptions: readonly Subscription[];
  /** Flag defaults across modules. */
  readonly flagDefaults: ReadonlyMap<string, boolean>;
  /** Resource kind → RBAC policy, merged across modules (kinds are globally unique). */
  readonly resourceKinds: Readonly<Record<string, ResourceKindPolicy>>;
  /** Content block type → provider, merged across modules (types are globally unique). */
  readonly blockHydrators: ReadonlyMap<string, RegisteredHydrator>;
  /**
   * Every webhook-able topic with the module that offers it, in boot order (E3.4). A topic is
   * offered by one module only.
   */
  webhookTopics(): readonly WebhookTopicEntry[];
  /**
   * AI tasks by feature (E3.12), built from every manifest's `aiTasks(services)`. One task per
   * feature across all modules; a task's permission must be declared by its module. Call lazily
   * (inside a handler or job), never at registration time.
   */
  resolveAiTasks(services: ModuleServices): ReadonlyMap<AiFeature, RegisteredAiTask>;
  /** AI context providers by key (E3.12), from every manifest's `aiContextProviders(services)`. */
  resolveAiContextProviders(
    services: ModuleServices,
  ): ReadonlyMap<string, RegisteredAiContextProvider>;
}

/**
 * The `ModuleServices.registry` view: the registry's static contributions plus
 * `aiContextProviders`, resolved from `services` on first read and then memoised.
 */
export function registryViewOf(
  registry: ModuleRegistry,
  services: () => ModuleServices,
): ModuleRegistryView {
  let providers: ReadonlyMap<string, RegisteredAiContextProvider> | undefined;
  return {
    ids: registry.ids,
    has: (id) => registry.has(id),
    permissions: registry.permissions,
    blockHydrators: registry.blockHydrators,
    get aiContextProviders() {
      providers ??= registry.resolveAiContextProviders(services());
      return providers;
    },
  };
}

export interface WebhookTopicEntry {
  readonly topic: EventTopic;
  readonly moduleId: string;
}

export function createModuleRegistry(
  manifests: readonly ModuleManifest[],
  options: RegistryOptions = {},
): ModuleRegistry {
  const byId = new Map<string, ModuleManifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) throw new ModuleManifestError(`module ${m.id} is registered twice`);
    byId.set(m.id, m);
  }
  for (const m of manifests) {
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) throw new ModuleManifestError(`${m.id} depends on unknown module ${dep}`);
    }
  }

  // Selection: MODULES list plus transitive dependencies.
  let selected: Set<string>;
  if (options.only === undefined) {
    selected = new Set(byId.keys());
  } else {
    selected = new Set();
    const stack = [...options.only];
    for (const id of options.only) {
      if (!byId.has(id)) throw new ModuleManifestError(`MODULES names unknown module ${id}`);
    }
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (selected.has(id)) continue;
      selected.add(id);
      for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep);
    }
  }

  // Deterministic toposort (Kahn, smallest id first) with cycle detection.
  const ids = [...selected].sort();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(dep)?.push(id);
    }
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift() as string;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const n = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, n);
      if (n === 0) ready.push(next);
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id)).join(", ");
    throw new ModuleManifestError(`module dependency cycle among: ${stuck}`);
  }

  const modules = order.map((id) => byId.get(id) as ModuleManifest);

  const permissions = new Map<string, string>();
  const jobs: JobDefinition<JsonObject>[] = [];
  const subscriptions: Subscription[] = [];
  const migrationSources: MigrationSource[] = [];
  const flagDefaults = new Map<string, boolean>();
  const resourceKinds: Record<string, ResourceKindPolicy> = {};
  const blockHydrators = new Map<string, RegisteredHydrator>();
  const jobNames = new Set<string>();
  const webhookTopics: WebhookTopicEntry[] = [];
  const webhookOwners = new Map<string, string>();
  for (const m of modules) {
    for (const topic of m.webhooks ?? []) {
      const owner = webhookOwners.get(topic);
      if (owner !== undefined) {
        throw new ModuleManifestError(`webhook topic ${topic} offered by ${owner} and ${m.id}`);
      }
      webhookOwners.set(topic, m.id);
      webhookTopics.push({ topic: topic as EventTopic, moduleId: m.id });
    }
    for (const p of m.permissions ?? []) {
      if (permissions.has(p)) throw new ModuleManifestError(`permission ${p} declared twice`);
      permissions.set(p, m.id);
    }
    for (const j of Array.isArray(m.jobs) ? m.jobs : []) {
      if (jobNames.has(j.name)) throw new ModuleManifestError(`job ${j.name} declared twice`);
      jobNames.add(j.name);
      jobs.push(j);
    }
    for (const [topic, handler] of Object.entries(m.events?.handles ?? {})) {
      if (handler === undefined) continue;
      subscriptions.push({
        topic: topic as EventTopic,
        id: `${m.id}.${topic.replace(/\./gu, "_")}`,
        handler,
      });
    }
    if (m.migrations !== undefined) migrationSources.push({ module: m.id, dir: m.migrations });
    for (const [key, def] of Object.entries(m.flags ?? {})) flagDefaults.set(key, def.default);
    for (const [kind, policy] of Object.entries(m.resourceKinds ?? {})) {
      if (kind in resourceKinds)
        throw new ModuleManifestError(`resource kind ${kind} declared twice`);
      resourceKinds[kind] = policy;
    }
    for (const hydrator of m.blockHydrators ?? []) {
      if (blockHydrators.has(hydrator.type))
        throw new ModuleManifestError(`block hydrator ${hydrator.type} declared twice`);
      blockHydrators.set(hydrator.type, { module: m.id, hydrator });
    }
  }

  return {
    modules,
    ids: order,
    has: (id) => selected.has(id),
    get(id) {
      const m = selected.has(id) ? byId.get(id) : undefined;
      if (m === undefined) throw new ModuleManifestError(`unknown module ${id}`);
      return m;
    },
    permissions,
    migrationSources,
    jobs,
    resolveJobs(services) {
      const out = [...jobs];
      const names = new Set(jobNames);
      for (const m of modules) {
        if (typeof m.jobs !== "function") continue;
        for (const j of m.jobs(services)) {
          if (!j.name.startsWith(`${m.id}.`)) {
            throw new ModuleManifestError(
              `${m.id}: job ${JSON.stringify(j.name)} must be "${m.id}.<verb>"`,
            );
          }
          if (names.has(j.name)) throw new ModuleManifestError(`job ${j.name} declared twice`);
          names.add(j.name);
          out.push(j);
        }
      }
      return out;
    },
    subscriptions,
    flagDefaults,
    resourceKinds,
    blockHydrators,
    webhookTopics: () => webhookTopics,
    resolveAiTasks(services) {
      const out = new Map<AiFeature, RegisteredAiTask>();
      for (const m of modules) {
        for (const task of m.aiTasks?.(services) ?? []) {
          if (!(AI_FEATURES as readonly string[]).includes(task.feature)) {
            throw new ModuleManifestError(`${m.id}: unknown AI feature ${task.feature}`);
          }
          const owner = out.get(task.feature);
          if (owner !== undefined) {
            throw new ModuleManifestError(
              `AI task ${task.feature} registered by ${owner.module} and ${m.id}`,
            );
          }
          if (!(m.permissions ?? []).includes(task.permission)) {
            throw new ModuleManifestError(
              `${m.id}: AI task ${task.feature} names permission ${task.permission}, which the module does not declare`,
            );
          }
          out.set(task.feature, { module: m.id, task });
        }
      }
      return out;
    },
    resolveAiContextProviders(services) {
      const out = new Map<string, RegisteredAiContextProvider>();
      for (const m of modules) {
        for (const provider of m.aiContextProviders?.(services) ?? []) {
          const owner = out.get(provider.key);
          if (owner !== undefined) {
            throw new ModuleManifestError(
              `AI context provider ${provider.key} offered by ${owner.module} and ${m.id}`,
            );
          }
          out.set(provider.key, { module: m.id, provider });
        }
      }
      return out;
    },
  };
}
