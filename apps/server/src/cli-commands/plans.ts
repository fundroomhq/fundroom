import { userInfo } from "node:os";
import { type AuditRecorder, createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import { platform } from "@fundroom/contracts";
import {
  createPlan,
  getPlan,
  listPlans,
  type Plan,
  type PlanActor,
  PlanError,
  type PlanLimits,
  type PlanPatch,
  planWorkspaceCounts,
  updatePlan,
} from "@fundroom/control-plane";
import { createDatabase, type Database } from "@fundroom/db";
import { isPlanFeature, PLAN_FEATURES, type PlanFeature } from "@fundroom/domain";
import { OPTIONAL_MODULE_IDS } from "../entitlements.js";

export const PLANS_USAGE = `usage: fundroom plan list [--json]
       fundroom plan upsert <id> [--name <name>] [--limits <json>] [--price <ref>|--no-price]
                                 [--metered-price <ref>]... [--no-metered-price]
                                 [--trial-days <n>] [--public|--no-public]
                                 [--modules <id,id…|all|none>] [--features <id,id…|all|none>]
  --limits replaces the numbers; a modules/features list it does not mention is kept
  (clear one with --modules all / --features all)`;

/*
 * fundroom plan list|upsert (E3.10, ADR-0058; owner: agent M). `core.plan` rows; audited
 * `plan.create` / `plan.update` on the platform chain (`meta.source = "cli:<os user>"`), in the
 * same host transaction as the write. `upsert` creates the plan (`--name` required then) or
 * changes only the flags given on an existing one — `--limits` REPLACES the numeric limits (a
 * number left out is unlimited). Archiving stays with the operator API, where the workspaces on the
 * plan are visible. Exit 0 ok, 1 refused (a concurrent change, a price-ref conflict), 2 usage.
 *
 * Entitlements (A-3, ADR-0063, round-1 decision 10): `--modules` / `--features` take
 * comma-separated ids, `all` (remove the key: no restriction) or `none` (`[]`). A list flag
 * overrides the same key in `--limits`. A list neither flag nor `--limits` mentions is KEPT from the
 * plan's current limits, read in the same transaction as the write — so raising seats with
 * `--limits '{"staffSeats":10}'` never silently gives a plan every module and feature, and
 * `--features sso,scim` alone never drops a seat limit. Clearing a list takes `--modules all`.
 * (The API's `PATCH` replaces the whole object; the console always sends the lists.)
 */
export interface PlansDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly osUser: string;
  readonly out?: (line: string) => void;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every value of a repeatable flag, in order. */
function flags(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const v = args[i + 1];
    if (a === name && v !== undefined) out.push(v);
  });
  return out;
}

/** `modules=[a b]`, `modules=[]` (none) or `modules=all` (key absent: no restriction). */
function listText(name: string, list: readonly string[] | undefined): string {
  return `${name}=${list === undefined ? "all" : `[${list.join(" ")}]`}`;
}

/**
 * The limits column: the numeric limits (`unlimited` when none is set), then the two entitlement
 * lists, always printed so `all` is never confused with "not shown".
 */
export function limitsText(limits: PlanLimits): string {
  const numbers = Object.entries(limits)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return [
    numbers === "" ? "unlimited" : numbers,
    listText("modules", limits.modules),
    listText("features", limits.features),
  ].join(" ");
}

function line(plan: Plan, workspaces: number): string {
  return [
    plan.id,
    plan.name,
    limitsText(plan.limits),
    plan.billingPriceRef ?? "-",
    `trial=${plan.trialDays}d`,
    plan.public ? "public" : "private",
    plan.archivedAt === null ? "live" : `archived:${plan.archivedAt.toISOString()}`,
    `workspaces=${workspaces}`,
    `v${plan.version}`,
  ].join("\t");
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** A `--modules` / `--features` value: the ids, or `"all"` (remove the key = no restriction). */
export type ListFlag = readonly string[] | "all";

export interface ListFlags {
  readonly modules?: ListFlag;
  readonly features?: ListFlag;
}

/**
 * One list flag. `all` and `none` are words, not ids (no module or feature is called either);
 * otherwise comma-separated ids, sorted (the order the server stores). Feature ids are checked here
 * against the closed list; module ids only for shape — whether a module exists in this build is the
 * server's call (`unknown_module`).
 */
function listFlag(
  rest: readonly string[],
  name: "--modules" | "--features",
): Parsed<ListFlag | undefined> {
  if (!rest.includes(name)) return { ok: true, value: undefined };
  const raw = flag(rest, name)?.trim();
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    return { ok: false, error: `${name} needs comma-separated ids, all or none` };
  }
  if (raw === "all") return { ok: true, value: "all" };
  if (raw === "none") return { ok: true, value: [] };
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => id === "")) {
    return { ok: false, error: `${name}: an empty id (check the commas in "${raw}")` };
  }
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return { ok: false, error: `${name} lists ${twice} twice` };
  if (name === "--features") {
    const unknown = ids.find((id) => !isPlanFeature(id));
    if (unknown !== undefined) {
      return {
        ok: false,
        error: `--features: ${unknown} is not a feature (valid: ${PLAN_FEATURES.join(", ")})`,
      };
    }
  }
  return { ok: true, value: [...ids].sort() };
}

/** `limits` with the `keep` lists copied from `current` (where `current` has them). */
export function keepLists(
  limits: PlanLimits,
  current: PlanLimits,
  keep: readonly ListKey[],
): PlanLimits {
  const out: { -readonly [K in keyof PlanLimits]: PlanLimits[K] } = { ...limits };
  if (keep.includes("modules") && current.modules !== undefined) out.modules = [...current.modules];
  if (keep.includes("features") && current.features !== undefined) {
    out.features = [...current.features];
  }
  return out;
}

/**
 * `limits` with the list flags applied: `all` removes the key, a list replaces it, an absent flag
 * leaves the key as it is.
 */
export function withLists(limits: PlanLimits, lists: ListFlags): PlanLimits {
  const out: { -readonly [K in keyof PlanLimits]: PlanLimits[K] } = { ...limits };
  if (lists.modules === "all") delete out.modules;
  else if (lists.modules !== undefined) out.modules = [...lists.modules];
  if (lists.features === "all") delete out.features;
  else if (lists.features !== undefined) out.features = lists.features as PlanFeature[];
  return out;
}

function schemaError(prefix: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
  return `${prefix}: ${issues.map((i) => `${i.path.join(".") || "(object)"}: ${i.message}`).join("; ")}`;
}

/** The two entitlement keys of `PlanLimits`. */
export type ListKey = "modules" | "features";
const LIST_KEYS: readonly ListKey[] = ["modules", "features"];

/**
 * The upsert flags, validated with the API's own schemas. `lists` is set only when a list flag is
 * given WITHOUT `--limits`: the command then applies it to the plan's current limits (with
 * `--limits`, the flags are already folded into `patch.limits`). `keep` names the lists `--limits`
 * leaves out and no flag sets: the command carries them over from the plan's current limits.
 */
export function parseUpsert(args: readonly string[]): Parsed<{
  readonly id: string;
  readonly patch: PlanPatch;
  readonly lists?: ListFlags;
  readonly keep?: readonly ListKey[];
}> {
  const [id, ...rest] = args;
  if (id === undefined || !platform.PlanIdSchema.safeParse(id).success) {
    return { ok: false, error: "the plan id must match ^[a-z0-9][a-z0-9_-]{0,40}$" };
  }
  const patch: { -readonly [K in keyof PlanPatch]: PlanPatch[K] } = {};
  const name = flag(rest, "--name");
  if (name !== undefined) {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      return { ok: false, error: "--name must be 1 to 100 characters" };
    }
    patch.name = trimmed;
  }
  const modules = listFlag(rest, "--modules");
  if (!modules.ok) return modules;
  const features = listFlag(rest, "--features");
  if (!features.ok) return features;
  const lists: ListFlags = {
    ...(modules.value !== undefined ? { modules: modules.value } : {}),
    ...(features.value !== undefined ? { features: features.value } : {}),
  };
  const hasLists = Object.keys(lists).length > 0;
  if (hasLists) {
    // The ids' shape (and the list sizes), by the API's schema, before anything is read.
    const shape = platform.PlanLimitsSchema.safeParse(withLists({}, lists));
    if (!shape.success)
      return { ok: false, error: schemaError("--modules/--features", shape.error.issues) };
  }
  let keep: ListKey[] = [];
  const limits = flag(rest, "--limits");
  if (limits !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(limits);
    } catch {
      return { ok: false, error: "--limits must be a JSON object" };
    }
    const parsed = platform.PlanLimitsSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: schemaError("--limits", parsed.error.issues) };
    // A list flag overrides the same key in `--limits`.
    patch.limits = hasLists ? withLists(parsed.data, lists) : parsed.data;
    const mentioned = json as Record<string, unknown>;
    keep = LIST_KEYS.filter((k) => !(k in mentioned) && lists[k] === undefined);
  }
  if (rest.includes("--no-price")) patch.billingPriceRef = null;
  const price = flag(rest, "--price");
  if (price !== undefined) {
    if (price.length < 1 || price.length > 255) {
      return { ok: false, error: "--price must be 1 to 255 characters" };
    }
    patch.billingPriceRef = price;
  }
  // The metered prices: every `--metered-price` given REPLACES the list; `--no-metered-price`
  // clears it.
  const metered = flags(rest, "--metered-price");
  if (rest.includes("--no-metered-price")) patch.billingMeteredPriceRefs = [];
  if (metered.length > 0) {
    const parsed = platform.MeteredPriceRefsSchema.safeParse(metered);
    if (!parsed.success) {
      return {
        ok: false,
        error: "--metered-price: at most 10 distinct refs of 1 to 255 characters",
      };
    }
    patch.billingMeteredPriceRefs = parsed.data;
  }
  const trial = flag(rest, "--trial-days");
  if (trial !== undefined) {
    const n = Number(trial);
    if (!Number.isInteger(n) || n < 0 || n > 90) {
      return { ok: false, error: "--trial-days must be an integer from 0 to 90" };
    }
    patch.trialDays = n;
  }
  if (rest.includes("--public")) patch.public = true;
  if (rest.includes("--no-public")) patch.public = false;
  return {
    ok: true,
    value: {
      id,
      patch,
      ...(hasLists && patch.limits === undefined ? { lists } : {}),
      ...(keep.length > 0 ? { keep } : {}),
    },
  };
}

/** One sentence per `PlanError` the command can meet. */
export function planErrorSentence(id: string, error: PlanError): string {
  switch (error.reason) {
    case "version_conflict":
      return `plan ${id} changed while this command ran (someone else saved it first); nothing was written — run the command again`;
    case "exists":
      return `plan ${id} was created while this command ran; nothing was written — run the command again`;
    case "not_found":
      return `plan ${id} no longer exists; nothing was written`;
    default:
      return error.message;
  }
}

/** Names the module and lists what a plan may name instead. */
export function unknownModuleSentence(module: string): string {
  return `--modules: ${module} is not an optional module of this build (valid: ${OPTIONAL_MODULE_IDS.join(", ")})`;
}

/** The command against an open database; `runPlans` wires the real one. */
export async function plansCommand(argv: readonly string[], deps: PlansDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const [sub, ...args] = argv;
  if (sub === "list") {
    const { plans, counts } = await deps.db.withHost(async (tx) => ({
      plans: await listPlans(tx, { includeArchived: true }),
      counts: await planWorkspaceCounts(tx),
    }));
    if (args.includes("--json")) {
      out(
        JSON.stringify(
          plans.map((p) => ({ ...p, workspaces: counts.get(p.id) ?? 0 })),
          null,
          2,
        ),
      );
    } else {
      for (const p of plans) out(line(p, counts.get(p.id) ?? 0));
      console.error(`${plans.length} plan(s)`);
    }
    return 0;
  }
  if (sub === "upsert") {
    const parsed = parseUpsert(args);
    if (!parsed.ok) {
      console.error(`${parsed.error}\n${PLANS_USAGE}`);
      return 2;
    }
    const { id, lists, keep } = parsed.value;
    let { patch } = parsed.value;
    const actor: PlanActor = { kind: "cli", osUser: deps.osUser };
    const result = await deps.db
      .withHost(async (tx) => {
        const current = await getPlan(tx, id);
        if (current === undefined) {
          if (patch.name === undefined) return { error: "a new plan needs --name" } as const;
          const created = await createPlan(
            tx,
            {
              id,
              name: patch.name,
              limits: patch.limits ?? (lists !== undefined ? withLists({}, lists) : {}),
              billingPriceRef: patch.billingPriceRef ?? null,
              billingMeteredPriceRefs: patch.billingMeteredPriceRefs ?? [],
              trialDays: patch.trialDays ?? 0,
              public: patch.public ?? false,
            },
            actor,
            { audit: deps.audit, optionalModules: OPTIONAL_MODULE_IDS },
          );
          return { plan: created, verb: "created" } as const;
        }
        // A list flag without `--limits` replaces only that key of the limits just read; a
        // `--limits` that leaves a list out keeps the plan's current one (decision 10).
        if (lists !== undefined) patch = { ...patch, limits: withLists(current.limits, lists) };
        if (keep !== undefined && patch.limits !== undefined) {
          patch = { ...patch, limits: keepLists(patch.limits, current.limits, keep) };
        }
        if (Object.keys(patch).length === 0) return { plan: current, verb: "unchanged" } as const;
        // The version just read, in the same transaction: a concurrent operator edit between the
        // two statements surfaces as `version_conflict` rather than being overwritten.
        const updated = await updatePlan(tx, id, current.version, patch, actor, {
          audit: deps.audit,
          optionalModules: OPTIONAL_MODULE_IDS,
        });
        return { plan: updated, verb: "updated" } as const;
      })
      .catch((error: unknown) => {
        // One ref in both roles (fix round 3): a usage line item must never move a plan.
        if (error instanceof PlanError && error.reason === "price_ref_conflict") {
          return { error: error.message, code: 1 } as const;
        }
        // A required module, a typo, or a module this build does not compile in: a usage error.
        if (error instanceof PlanError && error.reason === "unknown_module") {
          return { error: unknownModuleSentence(error.module ?? "?") } as const;
        }
        // Anything else the plan service refuses is a sentence, never a stack trace.
        if (error instanceof PlanError)
          return { error: planErrorSentence(id, error), code: 1 } as const;
        throw error;
      });
    if ("error" in result) {
      // The usage text helps a usage error (exit 2), not a refusal (exit 1).
      if ("code" in result) {
        console.error(result.error);
        return result.code;
      }
      console.error(`${result.error}\n${PLANS_USAGE}`);
      return 2;
    }
    out(`${result.verb} ${line(result.plan, 0).split("\t").slice(0, 3).join("\t")}`);
    return 0;
  }
  console.error(PLANS_USAGE);
  return 2;
}

function osUser(): string {
  try {
    return process.env["SUDO_USER"] || userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

/** `fundroom plan …`; `argv` is everything after `plan`. */
export async function runPlans(argv: readonly string[], config: AppConfig): Promise<number> {
  const sub = argv[0];
  if (sub !== "list" && sub !== "upsert") {
    console.error(PLANS_USAGE);
    return 2;
  }
  const db = createDatabase({ connectionString: config.raw.DATABASE_URL, poolMax: 2 });
  try {
    return await plansCommand(argv, {
      db,
      audit: createAuditService({ db, truncateIp: config.raw.AUDIT_IP_TRUNCATE }),
      osUser: osUser(),
    });
  } finally {
    await db.close();
  }
}
