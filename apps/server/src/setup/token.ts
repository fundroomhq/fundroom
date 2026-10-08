import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The setup token (ADR-0018): a freshly exposed host must not be claimable by whoever finds
 * it first, so the wizard's privileged step requires a secret the operator can only get from
 * the deployment itself. Sources, in order:
 *
 *   1. `SETUP_TOKEN` (deploy templates that cannot show logs; `doctor` redacts it);
 *   2. `<DATA_DIR>/setup-token`, written 0600 by the process that generated it, so
 *      `fundroom setup-token` and a restarted container print the same value;
 *   3. generated in memory and printed to the logs (no writable data dir: Helm, PaaS).
 *
 * The file is removed once setup completes; the token is never reused for anything else.
 */
export const SETUP_TOKEN_FILE = "setup-token";
export type SetupTokenSource = "env" | "file" | "generated";

export interface SetupToken {
  readonly source: SetupTokenSource;
  /** Where the file lives when `source` is `file`; also the path a generated token was persisted to. */
  readonly path: string | undefined;
  verify(candidate: string): boolean;
  /** For the banner and the CLI. */
  reveal(): string;
  /** Deletes the file (if any); the in-memory value keeps answering `false` afterwards. */
  consume(): void;
}

export interface SetupTokenOptions {
  readonly configured?: string | undefined;
  readonly dataDir: string;
  readonly random?: ((bytes: number) => Buffer) | undefined;
}

export function resolveSetupToken(options: SetupTokenOptions): SetupToken {
  const path = join(options.dataDir, SETUP_TOKEN_FILE);
  let value: string;
  let source: SetupTokenSource;
  let persisted = false;
  if (options.configured !== undefined && options.configured.trim() !== "") {
    value = options.configured.trim();
    source = "env";
  } else if (existsSync(path) && readFileSync(path, "utf8").trim() !== "") {
    value = readFileSync(path, "utf8").trim();
    source = "file";
    persisted = true;
  } else {
    value = (options.random ?? randomBytes)(24).toString("base64url");
    source = "generated";
    try {
      writeFileSync(path, `${value}\n`, { mode: 0o600, flag: "wx" });
      persisted = true;
    } catch {
      // No writable data dir (Helm, PaaS): the logs are the only place the token appears.
    }
  }
  let consumed = false;
  return {
    source,
    path: persisted ? path : undefined,
    verify(candidate) {
      if (consumed) return false;
      const a = Buffer.from(candidate.trim());
      const b = Buffer.from(value);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    reveal: () => value,
    consume() {
      consumed = true;
      if (persisted) {
        try {
          if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
        } catch {
          // best effort; the token no longer verifies either way
        }
      }
    },
  };
}

/**
 * E-UP-11: the token of an install whose first-run wizard is off (CONTROL_PLANE=on). Nothing is
 * generated, read or written; it verifies nothing, and there is nothing to reveal.
 */
export function disabledSetupToken(): SetupToken {
  return {
    // Never shown: the status endpoint reports `tokenSource` only while setup is required.
    source: "env",
    path: undefined,
    verify: () => false,
    reveal() {
      throw new Error("first-run setup is off under the control plane: there is no setup token");
    },
    consume() {},
  };
}

/**
 * Fix round 1 L7: deletes `<DATA_DIR>/setup-token` (a token generated before the control plane
 * was turned on). Best effort; true when a file was removed.
 */
export function removeSetupTokenFile(dataDir: string): boolean {
  const path = join(dataDir, SETUP_TOKEN_FILE);
  try {
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The log banner: printed at boot while setup is required, and by `fundroom setup-token`. */
export function setupTokenBanner(token: SetupToken, setupUrl: string): string {
  return [
    "",
    "== FundRoom first-run setup =============================================",
    `   Open ${setupUrl} and enter this setup token:`,
    "",
    `       ${token.reveal()}`,
    "",
    token.source === "env"
      ? "   (from SETUP_TOKEN)"
      : token.path
        ? `   (also in ${token.path}; \`fundroom setup-token\` prints it again)`
        : "   (generated for this process only; restart to get a new one)",
    "=========================================================================",
    "",
  ].join("\n");
}
