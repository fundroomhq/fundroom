import { randomBytes, type ScryptOptions, scrypt as scryptCb } from "node:crypto";
import { safeEqual } from "./tokens.js";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/*
 * scrypt (RFC 7914) via node:crypto — no native build step, OWASP-recommended parameters.
 * Format: `scrypt$<log2 N>$<r>$<p>$<salt b64url>$<hash b64url>`; parameters travel with the
 * hash so they can be raised later and old hashes re-hashed on next login (`needsRehash`).
 * Argon2id is available in Node 24 behind an experimental flag; switch when it stabilises.
 */
export interface ScryptParams {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

/**
 * 64 MiB, ~200 ms on a small VPS core. OWASP's scrypt floor is `N=2^17, r=8, p=1` (128 MiB) *or*
 * the equivalent-cost `N=2^16, r=8, p=2`; the second keeps peak memory per concurrent login at
 * 64 MiB (Node runs the `p` lanes sequentially), which matters on a small host. Hashes made with
 * the older `p=1` report `needsRehash` and are upgraded on the next successful login (ASVS 6.x,
 * finding F-17).
 */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 16, r: 8, p: 2 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** NIST SP 800-63B: length is the only composition rule; long passphrases must be accepted. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function maxmem(p: ScryptParams): number {
  // 128 * N * r bytes plus headroom.
  return 128 * 2 ** p.logN * p.r * 2;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: 2 ** params.logN,
    r: params.r,
    p: params.p,
    maxmem: maxmem(params),
  });
  return [
    "scrypt",
    params.logN,
    params.r,
    params.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export interface PasswordVerdict {
  readonly ok: boolean;
  /** The stored hash uses weaker parameters than `DEFAULT_SCRYPT`; re-hash after a successful login. */
  readonly needsRehash: boolean;
}

export function parsePasswordHash(
  stored: string,
): { params: ScryptParams; salt: Buffer; key: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0) || logN > 22) return undefined;
  return {
    params: { logN, r, p },
    salt: Buffer.from(parts[4] as string, "base64url"),
    key: Buffer.from(parts[5] as string, "base64url"),
  };
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordVerdict> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const key = await scrypt(password.normalize("NFKC"), parsed.salt, parsed.key.length, {
    N: 2 ** parsed.params.logN,
    r: parsed.params.r,
    p: parsed.params.p,
    maxmem: maxmem(parsed.params),
  });
  const ok = safeEqual(key, parsed.key);
  const needsRehash =
    parsed.params.logN < DEFAULT_SCRYPT.logN ||
    parsed.params.r < DEFAULT_SCRYPT.r ||
    parsed.params.p < DEFAULT_SCRYPT.p;
  return { ok, needsRehash };
}

/**
 * A fixed hash to verify against when the account does not exist, so a login attempt for
 * an unknown email burns the same scrypt time as a wrong password (anti-enumeration).
 */
let dummy: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummy;
}

export type PasswordPolicyIssue = "too_short" | "too_long";

export function checkPasswordPolicy(password: string): PasswordPolicyIssue | undefined {
  const length = [...password.normalize("NFKC")].length;
  if (length < PASSWORD_MIN_LENGTH) return "too_short";
  if (length > PASSWORD_MAX_LENGTH) return "too_long";
  return undefined;
}

/*
 * Recovery codes (ASVS 6.5.2, finding F-18). A code carries 40 bits, well below the 112 at which
 * a fast keyed hash would be enough, so each one is stored as its own salted scrypt hash:
 * `rc1$<salt b64url>$<hash b64url>`. The cost is deliberately lower than a password's (16 MiB,
 * ~15 ms) because a user holds ten and a wrong guess checks all of them; the per-user limiter
 * caps guesses long before the cost matters online, and offline it still means ~2^40 scrypt
 * evaluations per code. Entries without the prefix are the older keyed-HMAC format and are
 * verified by the caller as before, until the user regenerates their set.
 */
const RECOVERY_SCRYPT: ScryptParams = { logN: 14, r: 8, p: 1 };
const RECOVERY_PREFIX = "rc1";

function recoveryInput(code: string, scope: string): string {
  return `${scope} ${code}`;
}

export async function hashRecoveryCode(code: string, scope: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(recoveryInput(code, scope), salt, 32, {
    N: 2 ** RECOVERY_SCRYPT.logN,
    r: RECOVERY_SCRYPT.r,
    p: RECOVERY_SCRYPT.p,
    maxmem: maxmem(RECOVERY_SCRYPT),
  });
  return [RECOVERY_PREFIX, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True for entries in the salted-scrypt format (`rc1$…`). */
export function isSlowRecoveryHash(stored: string): boolean {
  return stored.startsWith(`${RECOVERY_PREFIX}$`);
}

export async function verifyRecoveryCodeHash(
  code: string,
  scope: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== RECOVERY_PREFIX) return false;
  const salt = Buffer.from(parts[1] as string, "base64url");
  const expected = Buffer.from(parts[2] as string, "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const key = await scrypt(recoveryInput(code, scope), salt, expected.length, {
    N: 2 ** RECOVERY_SCRYPT.logN,
    r: RECOVERY_SCRYPT.r,
    p: RECOVERY_SCRYPT.p,
    maxmem: maxmem(RECOVERY_SCRYPT),
  });
  return safeEqual(key, expected);
}
