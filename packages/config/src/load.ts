import { ConfigError, type ConfigIssue } from "./errors.js";
import { type KeyRing, keyRingFromSingleKey, parseKeyRing } from "./key-ring.js";
import {
  type AppEnv,
  crossFieldRules,
  ENV_KEYS,
  EXAMPLES,
  envSchema,
  LEGACY_ENV_NAMES,
  type PathMountEntry,
  pathMountsOf,
  type RawEnv,
  type Role,
} from "./schema.js";
import { type LegacyEnvUse, type ReadFile, type ResolvedValue, resolveEnv } from "./secrets.js";

/** Where a config value came from. `default` = schema default, `unset` = optional and absent. */
export type ConfigSource = "env" | "file" | "default" | "unset";

export interface LoadOptions {
  /** Defaults to `process.env`. Inject for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `fs.readFileSync(path, "utf8")`. Inject for tests. */
  readonly readFile?: ReadFile;
}

/**
 * Typed, validated configuration. Derived fields (`roles`, `keyRing`, `modules`)
 * are the ones the rest of the app should use; the raw env is kept on `raw`
 * for `doctor` and for adapters that need a driver-specific field.
 */
export interface AppConfig {
  readonly appEnv: AppEnv;
  readonly isProduction: boolean;
  readonly baseUrl: URL;
  readonly basePath: string;
  /**
   * `PATH_MOUNTS` (E3.9): the public origins + prefixes a proxy may present this portal under,
   * matched per request against `X-Forwarded-Prefix` (`matchPathMount` in @fundroom/http).
   * Empty when unset.
   */
  readonly pathMounts: readonly PathMountEntry[];
  readonly roles: ReadonlySet<Role>;
  /** `undefined` means "all compiled-in modules". */
  readonly modules: readonly string[] | undefined;
  readonly keyRing: KeyRing;
  /**
   * Keys that were read through their old name (`LEGACY_ENV_NAMES`), e.g.
   * `{ key: "FUNDROOM_SECRET_KEY", legacy: "SEEDHOST_SECRET_KEY" }`. `configWarnings` turns each
   * into a deprecation warning (doctor and boot). Empty on a fully renamed environment.
   */
  readonly legacyEnv: readonly LegacyEnvUse[];
  readonly raw: RawEnv;
}

export type LoadResult =
  | { readonly ok: true; readonly config: AppConfig; readonly sources: SourceMap }
  | { readonly ok: false; readonly error: ConfigError };

export type SourceMap = Readonly<Record<string, ConfigSource>>;

/** Parses and validates the environment. Throws `ConfigError` listing every problem. */
export function loadConfig(options: LoadOptions = {}): AppConfig {
  const result = tryLoadConfig(options);
  if (!result.ok) throw result.error;
  return result.config;
}

/** Like `loadConfig` but returns issues instead of throwing, and reports value sources. */
export function tryLoadConfig(options: LoadOptions = {}): LoadResult {
  const env = options.env ?? process.env;
  const resolved = resolveEnv(env, ENV_KEYS, options.readFile, LEGACY_ENV_NAMES);
  const issues: ConfigIssue[] = [...resolved.issues];

  const parsed = envSchema.safeParse(resolved.values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "?");
      issues.push({ key, message: humanize(issue), ...withExample(key) });
    }
  }
  if (issues.length > 0) return { ok: false, error: new ConfigError(issues) };
  if (!parsed.success) throw new Error("unreachable: parse failed without issues");

  const raw = parsed.data;
  for (const issue of crossFieldRules(
    raw,
    new Set(Object.keys(resolved.values)),
    secretKeyVariable(resolved.sources, resolved.legacy),
  )) {
    issues.push({ ...withExample(issue.key), ...issue });
  }

  let keyRing: KeyRing | undefined;
  if (raw.SECRET_KEY_RING !== undefined && raw.FUNDROOM_SECRET_KEY === undefined) {
    const ring = parseKeyRing(raw.SECRET_KEY_RING);
    if (ring.ok) keyRing = ring.ring;
    else issues.push(...ring.issues);
  } else if (raw.FUNDROOM_SECRET_KEY !== undefined && raw.SECRET_KEY_RING === undefined) {
    const ring = keyRingFromSingleKey(raw.FUNDROOM_SECRET_KEY);
    if (ring.ok) keyRing = ring.ring;
    else issues.push(...ring.issues);
  }

  if (issues.length > 0 || keyRing === undefined) {
    return { ok: false, error: new ConfigError(issues) };
  }

  const roles = applyWorkerMode(new Set<Role>(raw.ROLES), raw.WORKER_MODE);

  const config: AppConfig = {
    appEnv: raw.APP_ENV,
    isProduction: raw.APP_ENV === "prod",
    baseUrl: new URL(raw.BASE_URL),
    basePath: raw.BASE_PATH,
    pathMounts: pathMountsOf(raw),
    roles,
    modules: raw.MODULES,
    keyRing,
    legacyEnv: resolved.legacy,
    raw,
  };

  return { ok: true, config, sources: sourceMap(resolved.sources, raw) };
}

/** The variable(s) the operator set for the master key, as they spelled them. */
function secretKeyVariable(
  sources: Readonly<Record<string, ResolvedValue>>,
  legacy: readonly LegacyEnvUse[],
): string {
  const key = "FUNDROOM_SECRET_KEY";
  const use = legacy.find((u) => u.key === key);
  if (use !== undefined)
    return use.sameAs === undefined ? use.legacy : `${use.sameAs} and ${use.legacy}`;
  return sources[key]?.source === "file" ? `${key}_FILE` : key;
}

function applyWorkerMode(roles: Set<Role>, mode: RawEnv["WORKER_MODE"]): ReadonlySet<Role> {
  switch (mode) {
    case "embedded":
      roles.add("worker");
      break;
    case "external":
    case "off":
      roles.delete("worker");
      break;
    case undefined:
      break;
  }
  return roles;
}

function sourceMap(resolved: Readonly<Record<string, ResolvedValue>>, raw: RawEnv): SourceMap {
  const out: Record<string, ConfigSource> = {};
  for (const key of ENV_KEYS) {
    const r = resolved[key];
    if (r !== undefined) out[key] = r.source;
    else out[key] = raw[key] === undefined ? "unset" : "default";
  }
  return out;
}

/** Turns Zod's generic wording into operator-facing text. */
function humanize(issue: { code: string; message: string }): string {
  const m = issue.message;
  if (issue.code === "invalid_type" && /received undefined/iu.test(m)) return "required.";
  if (issue.code === "invalid_type" && /expected number, received nan/iu.test(m)) {
    return "must be a number.";
  }
  return `${m.replace(/^Invalid input: /u, "")}.`;
}

function withExample(key: string): { example?: string } {
  const example = (EXAMPLES as Readonly<Record<string, string | undefined>>)[key];
  return example === undefined ? {} : { example };
}
