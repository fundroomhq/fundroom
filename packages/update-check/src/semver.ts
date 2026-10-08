/*
 * A strict SemVer 2.0 parser and comparator for `x.y.z` and `x.y.z-pre`, and nothing else.
 *
 * Deliberately narrower than the spec: no build metadata (`+sha`), no leading `v`, no ranges, no
 * loose coercion. Release versions are ours to publish, so anything outside this shape in the
 * index is a malformed index rather than a version to guess at — and a guess is how "1.10.0 is
 * older than 1.9.0" ships. Numeric parts are capped at `Number.MAX_SAFE_INTEGER` so a comparison
 * is never a float comparison in disguise.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  readonly prerelease: readonly (string | number)[];
}

/** Longest version string accepted anywhere (the index, the running build). */
export const MAX_VERSION_LENGTH = 64;

const NUM = "0|[1-9]\\d*";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`,
  "u",
);

function safeInt(text: string): number | undefined {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The parsed version, or `undefined` for anything that is not strict `x.y.z[-pre]`. */
export function parseSemVer(text: string): SemVer | undefined {
  if (text.length === 0 || text.length > MAX_VERSION_LENGTH) return undefined;
  const m = SEMVER.exec(text);
  if (m === null) return undefined;
  const major = safeInt(m[1] ?? "");
  const minor = safeInt(m[2] ?? "");
  const patch = safeInt(m[3] ?? "");
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const prerelease: (string | number)[] = [];
  if (m[4] !== undefined) {
    for (const id of m[4].split(".")) {
      if (/^\d+$/u.test(id)) {
        const n = safeInt(id);
        if (n === undefined) return undefined;
        prerelease.push(n);
      } else prerelease.push(id);
    }
  }
  return { major, minor, patch, prerelease };
}

export function isSemVer(text: string): boolean {
  return parseSemVer(text) !== undefined;
}

export function isPrerelease(v: SemVer): boolean {
  return v.prerelease.length > 0;
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** SemVer 2.0 precedence (§11): -1 when `a < b`, 0 when equal, 1 when `a > b`. */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const core = sign(a.major - b.major) || sign(a.minor - b.minor) || sign(a.patch - b.patch);
  if (core !== 0) return core;
  // A stable release outranks every prerelease of the same core version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return sign(b.prerelease.length - a.prerelease.length);
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i] as string | number;
    const y = b.prerelease[i] as string | number;
    if (x === y) continue;
    // Numeric identifiers rank below alphanumeric ones.
    if (typeof x === "number" && typeof y === "number") return sign(x - y);
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return sign(a.prerelease.length - b.prerelease.length);
}

/** `compareSemVer` over strings; throws on an invalid version (callers validate first). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  if (x === undefined) throw new RangeError(`not a version: ${a}`);
  if (y === undefined) throw new RangeError(`not a version: ${b}`);
  return compareSemVer(x, y);
}
