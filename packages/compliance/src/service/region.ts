import type { LegalSettings } from "@fundroom/domain";

/*
 * Consent tiers by region and the statutory erasure clock (E2.6 decisions 4 and 5, design/04 §3.2).
 *
 * Pure on purpose, like `consentAllows`: every rule here is a legal default that is wrong in a way
 * nobody notices (a UK tenant silently put on notice-only, a US request given the EU's shorter
 * clock the other way round), so each one is a table with an exhaustive test beside it.
 *
 * Region defaults are applied **at write time, never at read time**. `allowsPurpose` keeps reading
 * the stored `consentMode` and nothing else: a region is an input to the admin's decision, not a
 * second source of truth that could disagree with the mode the admin can see.
 */

export type ConsentMode = LegalSettings["consentMode"];
export type PrivacyRegion = NonNullable<LegalSettings["privacyRegion"]>;

/**
 * The consent mode a region's law points at (design/04 §3.2's tiers). EU: prior opt-in. UK:
 * opt-out. US: notice (GPC is honoured in every mode anyway). `other` and "not said" get the
 * strict default, because the safe failure of guessing wrong is asking somebody a question they
 * did not need to be asked.
 */
export function regionConsentDefault(region: PrivacyRegion | null | undefined): ConsentMode {
  switch (region) {
    case "uk":
      return "opt_out";
    case "us":
      return "notice_only";
    default:
      return "opt_in";
  }
}

/** How protective a mode is: `opt_in` (3) > `opt_out` (2) > `notice_only` (1). */
export function consentModeRank(mode: ConsentMode): number {
  switch (mode) {
    case "opt_in":
      return 3;
    case "opt_out":
      return 2;
    case "notice_only":
      return 1;
  }
}

/** Whether `mode` is less protective than what `region` points at — a warning, never a block. */
export function consentModeWeakerThanRegion(
  mode: ConsentMode,
  region: PrivacyRegion | null | undefined,
): boolean {
  return consentModeRank(mode) < consentModeRank(regionConsentDefault(region));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statutory response window for an erasure request, in days. GDPR Art. 12(3) and UK GDPR: one
 * month, taken as 30 days (the shorter reading — "one month" from 31 January is not 31 days).
 * US state laws (CCPA/CPRA and the ones modelled on it): 45 days. `other` and "not said" get the
 * shorter clock for the same reason `regionConsentDefault` gets the stricter mode.
 */
export function erasureWindowDays(region: PrivacyRegion | null | undefined): number {
  return region === "us" ? 45 : 30;
}

/** When the answer to an erasure request received at `requestedAt` is due. */
export function erasureDueAt(region: PrivacyRegion | null | undefined, requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + erasureWindowDays(region) * DAY_MS);
}

type PatchableKey =
  | "consentMode"
  | "privacyRegion"
  | "legalHold"
  | "enforceAcceptance"
  | "relationshipWarningDays"
  | "defaultDisclaimerSlug";

/** What a legal-settings PATCH may carry. Absent (or `undefined`) keys are left alone. */
export type LegalSettingsPatch = {
  readonly [K in PatchableKey]?: LegalSettings[K] | undefined;
};

/** Why `consentMode` has the value it has after a patch — recorded in the audit row. */
export type ConsentModeSource = "admin" | "region_default" | "unchanged";

export interface LegalSettingsChange {
  readonly next: LegalSettings;
  readonly consentModeSource: ConsentModeSource;
  /** `regionConsentDefault(next.privacyRegion)`. */
  readonly suggestedConsentMode: ConsentMode;
  /** The stored mode is less protective than the region's suggestion. */
  readonly consentModeWeakerThanRegion: boolean;
}

/**
 * Decision 4 as one function the route calls and a test enumerates.
 *
 * - `consentMode` sent → the admin's mode stands, whatever the region says; a weaker one is
 *   *reported* (`consentModeWeakerThanRegion`), never corrected.
 * - `privacyRegion` sent **and changed**, no `consentMode` → the mode becomes the region's
 *   suggestion. That is the one place a mode is written without being sent, and it is visible:
 *   the response carries the new mode and the audit diff shows it moving.
 * - `privacyRegion` sent but unchanged → nothing happens to the mode. A settings form that echoes
 *   the whole object back must not quietly reset a mode the admin chose deliberately after
 *   picking the region — that would be exactly the silent rewrite this rule exists to prevent.
 */
export function applyLegalSettingsPatch(
  current: LegalSettings,
  patch: LegalSettingsPatch,
): LegalSettingsChange {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<Pick<LegalSettings, PatchableKey>>;
  let next: LegalSettings = { ...current, ...defined };
  let consentModeSource: ConsentModeSource = "unchanged";
  if (defined.consentMode !== undefined) {
    consentModeSource = "admin";
  } else if (
    Object.hasOwn(defined, "privacyRegion") &&
    defined.privacyRegion !== current.privacyRegion
  ) {
    const suggested = regionConsentDefault(defined.privacyRegion);
    if (suggested !== current.consentMode) {
      next = { ...next, consentMode: suggested };
      consentModeSource = "region_default";
    }
  }
  return {
    next,
    consentModeSource,
    suggestedConsentMode: regionConsentDefault(next.privacyRegion),
    consentModeWeakerThanRegion: consentModeWeakerThanRegion(next.consentMode, next.privacyRegion),
  };
}
