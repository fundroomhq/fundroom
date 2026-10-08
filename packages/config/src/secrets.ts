import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConfigIssue } from "./errors.js";
import { keyTextFingerprint } from "./key-ring.js";

export type ValueSource = "env" | "file";

export interface ResolvedValue {
  readonly value: string;
  readonly source: ValueSource;
  /** Set when `source === "file"`. */
  readonly path?: string;
}

export interface ResolveResult {
  /** Plain `KEY -> value` map ready for schema parsing. */
  readonly values: Record<string, string>;
  /** Where each value came from, for `doctor`. */
  readonly sources: Record<string, ResolvedValue>;
  readonly issues: readonly ConfigIssue[];
  /** Keys whose value came from their old (legacy) name, with the exact variable read. */
  readonly legacy: readonly LegacyEnvUse[];
}

/**
 * A config key read through its old name (`LEGACY_ENV_NAMES`). `legacy` is the variable that
 * actually held the value: the old name itself or its `_FILE` twin.
 */
export interface LegacyEnvUse {
  readonly key: string;
  readonly legacy: string;
  /**
   * Set when a spelling of the new name is set too, to the same value (A-2 FIX: templates set
   * both for one minor release so an older image, which reads only the old name, still finds
   * the key). The variable named here is the one whose value is used.
   */
  readonly sameAs?: string;
}

export type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * Resolves every known config key from the environment, honouring the
 * `NAME_FILE` convention: if `NAME_FILE` is set, the value is read from that
 * file (trailing newline stripped, which is what Docker / Kubernetes secret
 * mounts produce). Setting both `NAME` and `NAME_FILE` is an error rather than
 * a silent precedence rule, because a stale plain-text value winning over a
 * mounted secret is exactly the footgun this convention exists to avoid.
 *
 * `legacyNames` maps a key to the name it used to have (A-2: `FUNDROOM_SECRET_KEY` ←
 * `SEEDHOST_SECRET_KEY`). The old name and its `_FILE` twin are read when no spelling of the
 * new name is set, and the use is reported in `legacy` so `doctor` and boot can warn. When a
 * spelling of the new name *and* a spelling of the old one are both set, each side is resolved
 * with the usual rules (file contents, trailing newlines stripped) and:
 * - the two effective values are byte-identical: accepted, the new name's value is used, and
 *   the use is reported in `legacy` with `sameAs` (the deploy templates set both names for one
 *   minor release, because an older image reads only the old one and, finding no key, would
 *   generate a fresh one);
 * - anything else (different values, an unreadable file, NAME + NAME_FILE on one side) is an
 *   error, for the same reason as above: for a master key only one of them decrypts the
 *   existing data. The message names every variable set and a fingerprint of each value
 *   (never the value): for a key, the same `sha256:<12 hex>` `doctor` prints for the key ring.
 *
 * Empty strings count as unset everywhere (Compose passes an unset `${X:-}` as `""`).
 * Only keys in `knownKeys` (and their legacy names) are considered so that unrelated
 * `*_FILE` variables in the environment are never opened.
 */
export function resolveEnv(
  env: Readonly<Record<string, string | undefined>>,
  knownKeys: readonly string[],
  readFile: ReadFile = defaultReadFile,
  legacyNames: Readonly<Partial<Record<string, string>>> = {},
): ResolveResult {
  const values: Record<string, string> = {};
  const sources: Record<string, ResolvedValue> = {};
  const issues: ConfigIssue[] = [];
  const legacy: LegacyEnvUse[] = [];

  for (const key of knownKeys) {
    const old = legacyNames[key];
    let name = key;
    if (old !== undefined) {
      const current = setSpellings(env, key);
      const previous = setSpellings(env, old);
      if (current.length > 0 && previous.length > 0) {
        const sideIssues: ConfigIssue[] = [];
        const fresh = resolveOne(env, key, readFile, sideIssues);
        const stale = resolveOne(env, old, readFile, sideIssues);
        if (
          sideIssues.length === 0 &&
          fresh !== undefined &&
          stale !== undefined &&
          fresh.value === stale.value
        ) {
          values[key] = fresh.value;
          sources[key] = fresh;
          legacy.push({
            key,
            legacy: stale.source === "file" ? `${old}_FILE` : old,
            sameAs: fresh.source === "file" ? `${key}_FILE` : key,
          });
          continue;
        }
        issues.push({ key, message: bothSetMessage(env, key, old, readFile) });
        continue;
      }
      if (previous.length > 0) name = old;
    }

    const resolved = resolveOne(env, name, readFile, issues);
    if (resolved === undefined) continue;
    values[key] = resolved.value;
    sources[key] = resolved;
    if (name !== key) {
      legacy.push({ key, legacy: resolved.source === "file" ? `${name}_FILE` : name });
    }
  }

  return { values, sources, issues, legacy };
}

/**
 * Every environment variable that can carry `key`: the name, `NAME_FILE`, and the same two for
 * its legacy name when `legacyNames` has one. For pre-load code (the first-run key bootstrap)
 * that must recognise a configured key under any spelling.
 */
export function envSpellings(
  key: string,
  legacyNames: Readonly<Partial<Record<string, string>>> = {},
): readonly string[] {
  const old = legacyNames[key];
  return old === undefined ? [key, `${key}_FILE`] : [key, `${key}_FILE`, old, `${old}_FILE`];
}

/** `sha256:` + the first 8 hex of the value's sha256: tells two values apart without showing either. */
export function valueFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)}`;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function setSpellings(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return [name, `${name}_FILE`].filter((n) => isSet(env[n]));
}

/**
 * The refusal for a new and an old spelling that do not resolve to one identical value. Written
 * for the master key (the only renamed key): on an upgraded install the OLD name is normally the
 * one holding the key the data was encrypted with — a platform that generates secrets per name
 * (a Render Blueprint sync) puts a brand-new random value under the new name — so the message
 * must not tell the operator to keep the new one. It sends them to the fingerprint instead.
 */
function bothSetMessage(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  old: string,
  readFile: ReadFile,
): string {
  const set = [...setSpellings(env, key), ...setSpellings(env, old)];
  const listed = set.map((n) => describeSetVariable(env, n, readFile)).join(" and ");
  return (
    `${listed} are set and do not hold the same value; ${old} is the old name of ${key}. ` +
    `On an upgraded install ${old} normally holds the key your existing data was encrypted with ` +
    `(a platform that generates secrets per variable, such as a Render Blueprint sync, may have put ` +
    `a new random value under ${key}). Compare the fingerprints with the key ring fingerprint ` +
    "`fundroom doctor` (or the old deployment's boot log) printed before the upgrade, " +
    `then set ${key} to the value that matches and remove ${old} — or set both to that same ` +
    "value while an older image may still run. Do not delete a value you have not matched: " +
    "data encrypted with it cannot be read without it."
  );
}

function describeSetVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  readFile: ReadFile,
): string {
  const raw = env[name] as string;
  if (!name.endsWith("_FILE")) return `${name} (${conflictFingerprint(raw)})`;
  try {
    return `${name} (${raw}, ${conflictFingerprint(stripTrailingNewline(readFile(raw)))})`;
  } catch {
    return `${name} (${raw}, unreadable)`;
  }
}

/**
 * A usable key is identified exactly as `doctor` identifies it (`sha256:<12 hex>` of the decoded
 * bytes, so the operator can match it against `doctor` output from before the upgrade); anything
 * else by the first 8 hex of the text's sha256.
 */
function conflictFingerprint(value: string): string {
  const key = keyTextFingerprint(value);
  return key === undefined
    ? `${valueFingerprint(value)} of the text, not a valid key`
    : `key ${key}`;
}

/** One name and its `_FILE` twin, with the original conflict / unreadable / empty rules. */
function resolveOne(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  readFile: ReadFile,
  issues: ConfigIssue[],
): ResolvedValue | undefined {
  const fileKey = `${name}_FILE`;
  const direct = env[name];
  const filePath = env[fileKey];

  if (isSet(filePath)) {
    if (isSet(direct)) {
      issues.push({
        key: name,
        message: `both ${name} and ${fileKey} are set; remove one (${fileKey} is preferred for secrets).`,
      });
      return undefined;
    }
    let raw: string;
    try {
      raw = readFile(filePath);
    } catch (err) {
      issues.push({
        key: fileKey,
        message: `could not read ${filePath}: ${describeError(err)}.`,
      });
      return undefined;
    }
    const value = stripTrailingNewline(raw);
    if (value === "") {
      issues.push({ key: fileKey, message: `${filePath} is empty.` });
      return undefined;
    }
    return { value, source: "file", path: filePath };
  }

  if (isSet(direct)) return { value: direct, source: "env" };
  return undefined;
}

function stripTrailingNewline(s: string): string {
  return s.replace(/(\r?\n)+$/u, "");
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    switch (err.code) {
      case "ENOENT":
        return "file not found";
      case "EACCES":
        return "permission denied";
      case "EISDIR":
        return "path is a directory";
      default:
        return err.code;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
