import type { ReleaseIndex } from "./release-index.js";
import { compareSemVer, isPrerelease, parseSemVer, type SemVer } from "./semver.js";

/*
 * What the admin page and `fundroom doctor` say about this install's version.
 *
 *  - `disabled`          no check was made: `UPDATE_CHECK=false` (`opted_out`), or a multi-tenant
 *                        host, where the running version is the operator's business and not a
 *                        tenant admin's (`multi_tenant`).
 *  - `unknown`           this build has no place in the release line: a development build
 *                        (`0.0.0`, what an unreleased checkout reports), a prerelease, or a
 *                        version string that does not parse. `latestVersion` is still reported.
 *  - `current`           nothing newer than this build is listed (a build newer than `latest`,
 *                        e.g. a hotfix ahead of the index, is current too).
 *  - `update_available`  a newer stable release exists and none of the newer ones is a security
 *                        release.
 *  - `security_update`   at least one security release is newer than this build. Checked
 *                        against every release, not just `latest`: skipping 1.4.1 (security) by
 *                        looking only at 1.4.2 (not security) would hide the one fact that
 *                        matters.
 *  - `error`             the index could not be fetched or did not validate.
 */
export const UPDATE_STATUSES = [
  "disabled",
  "unknown",
  "current",
  "update_available",
  "security_update",
  "error",
] as const;
export type UpdateStatusKind = (typeof UPDATE_STATUSES)[number];

export const DISABLED_REASONS = ["opted_out", "multi_tenant"] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

export interface UpdateStatus {
  readonly status: UpdateStatusKind;
  /** Only with `disabled`. */
  readonly reason?: DisabledReason;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  /** ISO 8601; when the index was fetched (or the fetch failed). */
  readonly checkedAt?: string;
  /** Release notes of `latestVersion` (https, from the index). */
  readonly releaseUrl?: string;
  /** Security releases newer than `currentVersion`, newest first. Only with `security_update`. */
  readonly securityReleases?: readonly string[];
}

/** The version every unreleased build reports (`apps/server/package.json`). */
export const DEV_VERSION = "0.0.0";

export function disabledStatus(currentVersion: string, reason: DisabledReason): UpdateStatus {
  return { status: "disabled", reason, currentVersion };
}

export function errorStatus(currentVersion: string, now: Date): UpdateStatus {
  return { status: "error", currentVersion, checkedAt: now.toISOString() };
}

/** Pure: the status of `current` against a validated index, as of `now`. */
export function deriveUpdateStatus(current: string, index: ReleaseIndex, now: Date): UpdateStatus {
  const latest = index.releases.find((r) => r.version === index.latest);
  const base = {
    currentVersion: current,
    latestVersion: index.latest,
    checkedAt: now.toISOString(),
    ...(latest === undefined ? {} : { releaseUrl: latest.url }),
  };
  const cur = parseSemVer(current);
  if (cur === undefined || current === DEV_VERSION || isPrerelease(cur)) {
    return { status: "unknown", ...base };
  }
  const newer = (v: SemVer | undefined): v is SemVer =>
    v !== undefined && !isPrerelease(v) && compareSemVer(v, cur) > 0;
  const security = index.releases
    .filter((r) => r.security)
    .map((r) => ({ version: r.version, v: parseSemVer(r.version) }))
    .filter((r): r is { version: string; v: SemVer } => newer(r.v))
    .sort((a, b) => compareSemVer(b.v, a.v))
    .map((r) => r.version);
  if (security.length > 0) {
    return { status: "security_update", ...base, securityReleases: security };
  }
  return { status: newer(parseSemVer(index.latest)) ? "update_available" : "current", ...base };
}

/** One line for `fundroom doctor`. Plain text; the doctor never fails because of it. */
export function formatUpdateStatus(s: UpdateStatus): string {
  const notes = s.releaseUrl === undefined ? "" : ` — ${s.releaseUrl}`;
  switch (s.status) {
    case "disabled":
      return s.reason === "multi_tenant"
        ? "Update check: not reported on a multi-tenant host"
        : "Update check: off (UPDATE_CHECK=false)";
    case "unknown":
      return `Update check: ${s.currentVersion} is a development or prerelease build; latest release is ${s.latestVersion ?? "unknown"}`;
    case "current":
      return `Update check: up to date (${s.currentVersion}; latest release ${s.latestVersion ?? s.currentVersion})`;
    case "update_available":
      return `Update check: ${s.latestVersion ?? "a newer release"} is available (running ${s.currentVersion})${notes}`;
    case "security_update":
      return `Update check: SECURITY UPDATE — ${(s.securityReleases ?? []).join(", ")} fixes security issues (running ${s.currentVersion}; latest ${s.latestVersion ?? "unknown"})${notes}`;
    case "error":
      return "Update check: could not read the release index (network or index problem; this does not fail doctor)";
  }
}
