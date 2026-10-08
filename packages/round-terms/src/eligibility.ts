import { parseFixed } from "@fundroom/decimal";

import { money } from "./money.js";

/*
 * Which accreditation path an interest submission takes (E2.5 D4, contract §P).
 *
 * This is the one place the rule is written down. The server calls it when a submission comes
 * in and stores the answer on the row; the SPA calls it as the investor types, so the copy on
 * the form can change before they submit rather than after. **The browser never decides** — it
 * only previews what the server will decide from the same four facts, which is why the function
 * takes those four facts and nothing else.
 *
 * The four facts are the workspace's offering status, whether the investor is subscribing as a
 * person or through an entity, the amount, and the round's currency.
 */

export type AccreditationPath =
  | "none"
  | "self_attested"
  | "self_certified"
  | "verification_required";

/** Mirrors the `round.accreditation_path` enum, in increasing order of what it asks of anyone. */
export const ACCREDITATION_PATHS = [
  "none",
  "self_attested",
  "self_certified",
  "verification_required",
] as const;

/**
 * The minimum-investment safe harbour: an issuer may treat a purchaser as accredited on written
 * representations alone when the amount is at or above these figures (SEC no-action letter,
 * 12 March 2025). Decimal strings, and USD — the letter names dollars.
 */
export const US_MIN_INVESTMENT = { individual: "200000", entity: "1000000" } as const;

export interface EligibilityInput {
  readonly offeringStatus: "none" | "informational" | "506b" | "506c" | "non_us";
  readonly subject: "individual" | "entity";
  readonly amount: string;
  readonly currency: string;
}

export interface Eligibility {
  readonly path: AccreditationPath;
  /** Whether the questionnaire is shown; its answers are recorded on every path that shows it. */
  readonly questionnaire: boolean;
  /** Whether the amount clears the minimum-investment figure for this subject. */
  readonly thresholdMet: boolean;
  /** The figure that was compared against, when there is one. Always USD. */
  readonly threshold?: { readonly amount: string; readonly currency: "USD" };
  /** One sentence, for the screen. Plain English, legal-neutral. */
  readonly reason: string;
}

/**
 * The path for one prospective subscription.
 *
 * Throws a `RangeError` for `none` and `informational`: the round module is disabled in those
 * two statuses (`ROUND_DISABLED_WHEN`), so reaching this function with one of them means a
 * route that should have answered 404 did not, and a quiet `"none"` would paper over it. The
 * module's own offering gate is the thing that keeps this unreachable.
 */
export function eligibility(input: EligibilityInput): Eligibility {
  const { offeringStatus, subject } = input;

  switch (offeringStatus) {
    case "none":
    case "informational":
      throw new RangeError(
        `round eligibility is not defined for offering status "${offeringStatus}"`,
      );

    case "506b":
      return {
        path: "self_attested",
        questionnaire: true,
        thresholdMet: false,
        reason:
          "This is a private offering to people the company already knows, so you confirm your own status by answering a short questionnaire. Nothing needs to be verified by a third party.",
      };

    case "non_us":
      return {
        path: "none",
        questionnaire: false,
        thresholdMet: false,
        reason:
          "This offering is made outside the United States, so the US accreditation rules do not apply and there is nothing to confirm here.",
      };

    case "506c": {
      const threshold = { amount: US_MIN_INVESTMENT[subject], currency: "USD" } as const;
      const minimum = parseFixed(threshold.amount) ?? 0n;
      const amount = parseFixed(input.amount);
      const isUsd = input.currency.trim().toUpperCase() === "USD";
      // At or above, not above: the figure in the letter is the amount that qualifies, and an
      // investor putting in exactly $200,000 has met it.
      const met = isUsd && amount !== undefined && amount >= minimum;

      if (met) {
        return {
          path: "self_certified",
          questionnaire: true,
          thresholdMet: true,
          threshold,
          reason: `Because you are investing at least ${money(minimum)} as ${subject === "entity" ? "an entity" : "an individual"}, you can confirm your accredited status with written representations instead of sending documents for verification.`,
        };
      }
      return {
        path: "verification_required",
        questionnaire: true,
        thresholdMet: false,
        threshold,
        reason: isUsd
          ? `This offering is generally solicited, so your accredited status has to be verified before the company can accept your investment. Investing at least ${money(minimum)} would let you confirm it with written representations instead.`
          : "This offering is generally solicited, so your accredited status has to be verified before the company can accept your investment.",
      };
    }

    default:
      throw new RangeError(`unknown offering status: ${String(offeringStatus)}`);
  }
}
