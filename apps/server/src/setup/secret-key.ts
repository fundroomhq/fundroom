import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envSpellings, LEGACY_ENV_NAMES } from "@fundroom/config";

/*
 * First-run secret generation (EXECUTION_PLAN §9.4 step 1, ADR-0018). Runs before
 * `loadConfig()`, on the raw environment, so a `docker compose up` with no `FUNDROOM_SECRET_KEY`
 * still boots: the key is generated once into `<DATA_DIR>/secret.key` (0600) and every later
 * start finds it there. Nothing is generated when any key variable is already set, or when
 * the data directory does not exist (a developer laptop without `/data` gets the normal
 * config error instead of a stray file).
 *
 * "Any key variable" includes the master key's old name `SEEDHOST_SECRET_KEY` (and `_FILE`),
 * which the loader still reads (LEGACY_ENV_NAMES, A-2). Missing it here would make an upgraded
 * install that still uses the old name mint a fresh key file on top of its real key.
 */
export const SECRET_KEY_FILE = "secret.key";

/** Where the generated / reused key file is announced to `loadConfig()`. */
const KEY_FILE_VARIABLE = "FUNDROOM_SECRET_KEY_FILE";

/** Every variable that already configures a master key, under any name the loader reads. */
export const KEY_VARIABLES: readonly string[] = [
  ...envSpellings("FUNDROOM_SECRET_KEY", LEGACY_ENV_NAMES),
  ...envSpellings("SECRET_KEY_RING", LEGACY_ENV_NAMES),
];

export type SecretKeyAction =
  | { readonly action: "configured"; readonly via: string }
  | { readonly action: "reused"; readonly path: string }
  | { readonly action: "generated"; readonly path: string }
  | { readonly action: "unavailable"; readonly reason: string };

export interface EnsureSecretKeyOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Defaults to `env.DATA_DIR` or `/data`. */
  readonly dataDir?: string | undefined;
  readonly random?: ((bytes: number) => Buffer) | undefined;
  /**
   * `false` only picks up an existing key file. The operator commands (`doctor`, `audit`,
   * `workspace`, `jobs`, `search`) use it: they must find the key `serve` generated, but a
   * one-off `docker compose run` must never mint a second one.
   */
  readonly generate?: boolean | undefined;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mutates `env` (sets `FUNDROOM_SECRET_KEY_FILE`) so the subsequent `loadConfig()` picks the
 * key up through the ordinary `*_FILE` convention. Returns what happened for the log line.
 */
export function ensureSecretKey(options: EnsureSecretKeyOptions): SecretKeyAction {
  const { env } = options;
  for (const name of KEY_VARIABLES) {
    if (isSet(env[name])) return { action: "configured", via: name };
  }
  const dataDir = options.dataDir ?? (isSet(env["DATA_DIR"]) ? env["DATA_DIR"] : "/data");
  const path = join(dataDir, SECRET_KEY_FILE);
  if (existsSync(path)) {
    if (statSync(path).size === 0) {
      return {
        action: "unavailable",
        reason: `${path} exists but is empty; delete it or set FUNDROOM_SECRET_KEY`,
      };
    }
    env[KEY_FILE_VARIABLE] = path;
    return { action: "reused", path };
  }
  if (options.generate === false) {
    return { action: "unavailable", reason: `${path} does not exist` };
  }
  if (!existsSync(dataDir)) {
    return { action: "unavailable", reason: `${dataDir} does not exist` };
  }
  if (!writable(dataDir)) {
    return { action: "unavailable", reason: `${dataDir} is not writable` };
  }
  const key = (options.random ?? randomBytes)(32).toString("base64");
  mkdirSync(dataDir, { recursive: true });
  // `wx`: never overwrite a key another replica wrote a moment ago.
  try {
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      env[KEY_FILE_VARIABLE] = path;
      return { action: "reused", path };
    }
    throw error;
  }
  env[KEY_FILE_VARIABLE] = path;
  return { action: "generated", path };
}

/** The operator-facing explanation printed once when a key was generated. */
export function secretKeyWarning(path: string): string {
  return [
    "",
    "!! FUNDROOM_SECRET_KEY was not set, so a master key was GENERATED and saved to",
    `!!   ${path}`,
    "!! Everything encrypted at rest (documents, TOTP secrets, sessions) depends on it.",
    "!! Back that file up now, keep the volume, and never commit it. To manage the key",
    "!! yourself, set FUNDROOM_SECRET_KEY (or SECRET_KEY_RING) and delete the file.",
    "",
  ].join("\n");
}
