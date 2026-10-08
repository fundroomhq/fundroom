import {
  decimalText,
  discountFactor,
  fixed,
  fixedOr0,
  money,
  percentOf,
  percentText,
  percentValue,
  product,
  ratio,
  sharePrice,
  shares,
  wholeValue,
} from "./money.js";
import type { InstrumentKind, NoteTerms, PricedTerms, SafeTerms, Terms } from "./terms.js";

/*
 * "What does this mean for me?" — the one calculator (E2.5 §P).
 *
 * It runs unchanged on the server (`GET /round/current/calculate`) and in the investor's
 * browser, and that is the reason it is a package: an investor who types 100,000 into the box
 * and then reads a different percentage on the confirmation screen has been told two things,
 * and one of them is wrong.
 *
 * Two rules shape everything below.
 *
 * **It never throws.** Every input has already been through `TermsSchema`, but a cap of `"0"`,
 * a 100 % discount and a round target of `"0"` are all valid decimal strings and every one of
 * them divides by zero somewhere. A calculator that 500s on a number a founder typed into the
 * terms form is worse than one that says, in words, that ownership cannot be estimated from
 * these terms — so the ownership fields are optional and an arm that cannot fill them explains
 * why instead.
 *
 * **It is arithmetic, not advice.** Nothing here decides anything; it renders sentences a
 * person can check against their term sheet. Every result carries `assumptions`, every one of
 * them reaches the screen beside the figures, and the last one always says this is an estimate.
 */

export interface CalculatorInput {
  readonly terms: Terms;
  /** What the investor is putting in, as a decimal string. */
  readonly amount: string;
  /** The round's target, as a decimal string — the new money a cap or pre-money sits beside. */
  readonly roundTarget: string;
}

export interface CalculatorResult {
  readonly kind: InstrumentKind;
  /** Ownership at the worse of the two conversion prices, as a percentage with two decimals. */
  readonly ownershipPercentLow?: string;
  /** Ownership at the better price; equal to `Low` when the terms give only one price. */
  readonly ownershipPercentHigh?: string;
  /** The post-money valuation the estimate implies, in whole units. */
  readonly effectiveValuation?: string;
  /** Whole shares, when the terms name a price per share. */
  readonly sharesEstimate?: string;
  /** Plain-English sentences, in reading order. */
  readonly explanation: readonly string[];
  /** What the figures took for granted; always ends with the rounding and estimate notes. */
  readonly assumptions: readonly string[];
}

const NOT_ADVICE =
  "These figures are an estimate to help you think about the round — not investment advice, and not an offer of these terms.";
const IGNORES_POOL =
  "Ignores any new or enlarged option pool agreed at the next round, which would reduce your percentage.";
const ROUNDED = "Percentages are rounded to two decimal places.";
const PRICE_UNKNOWN =
  "The price of the next priced round is unknown, so no percentage can be estimated yet.";

interface Draft {
  low?: bigint;
  high?: bigint;
  valuation?: bigint;
  shares?: bigint;
  readonly explanation: string[];
  readonly assumptions: string[];
}

function draft(): Draft {
  return { explanation: [], assumptions: [] };
}

function result(kind: InstrumentKind, d: Draft): CalculatorResult {
  return {
    kind,
    ...(d.low !== undefined ? { ownershipPercentLow: percentValue(d.low) } : {}),
    ...(d.high !== undefined ? { ownershipPercentHigh: percentValue(d.high) } : {}),
    ...(d.valuation !== undefined ? { effectiveValuation: wholeValue(d.valuation) } : {}),
    ...(d.shares !== undefined ? { sharesEstimate: wholeValue(d.shares) } : {}),
    explanation: d.explanation,
    assumptions: [...d.assumptions, ROUNDED, NOT_ADVICE],
  };
}

/**
 * The cap-and-discount half of a convertible, shared by the SAFE and the note because the two
 * convert by exactly the same rule — the note simply converts a larger number.
 *
 * `post` is the denominator the cap implies: the cap itself for a post-money SAFE or a note, the
 * cap plus the round target for a pre-money SAFE.
 *
 * The cap number is the **low** end of the range, not the high one, and that is not a naming
 * quibble. A convertible converts at the *better* of the cap and the discounted round price, so
 * the cap is the price the investor is guaranteed not to do worse than: ownership at the cap is
 * a floor, and a discount can only raise it. The high end is what the discount buys if the next
 * round prices exactly at the cap — an honest upper end of a range rather than a promise, since
 * a round priced above the cap converts at the cap.
 */
function convertible(
  d: Draft,
  input: {
    readonly converting: bigint;
    readonly post: bigint | undefined;
    readonly discount: bigint | undefined;
    readonly instrument: string;
    readonly capSentence: (ownership: string) => string;
  },
): void {
  const { converting, post, discount, instrument } = input;
  const hasDiscount = discount !== undefined && discount > 0n;

  if (post === undefined || post <= 0n) {
    if (hasDiscount) {
      const factor = discountFactor(discount);
      const equivalent = factor > 0n ? ratio(converting, factor) : undefined;
      d.explanation.push(
        `This ${instrument} has no valuation cap, so your ownership depends on the price of the next priced round.`,
      );
      d.explanation.push(
        equivalent === undefined
          ? `A ${percentText(discount)} discount means you convert at a lower price per share than the new money in that round.`
          : `A ${percentText(discount)} discount means ${money(converting)} buys as much of that round as ${money(equivalent)} of new money would.`,
      );
      d.assumptions.push(PRICE_UNKNOWN);
      return;
    }
    d.explanation.push(
      `This ${instrument} has no valuation cap and no discount, so it converts at the price of the next priced round, on the same terms as the new money.`,
    );
    d.assumptions.push(PRICE_UNKNOWN);
    return;
  }

  const low = percentOf(converting, post);
  if (low === undefined) {
    d.explanation.push(
      `These terms do not give enough to estimate ownership from: the valuation they imply is ${money(post)}.`,
    );
    return;
  }
  d.low = low;
  d.valuation = post;
  d.explanation.push(input.capSentence(percentText(low)));

  if (!hasDiscount) {
    d.high = low;
    d.explanation.push(
      "If the next priced round values the company below the cap, you convert at that lower price and own more.",
    );
    return;
  }

  const factor = discountFactor(discount);
  const discounted = product(post, factor);
  const high = percentOf(converting, discounted);
  if (high === undefined) {
    d.high = low;
    d.explanation.push(
      `A ${percentText(discount)} discount applies instead whenever it gives you a better price than the cap.`,
    );
    return;
  }
  d.high = high;
  d.explanation.push(
    `A ${percentText(discount)} discount applies whenever it gives you a better price than the cap: if the next priced round prices at the cap, you convert as though the company were worth ${money(discounted)}, for about ${percentText(high)}.`,
  );
  d.assumptions.push(
    "The range runs from converting at the cap to converting at the discount to a round priced at the cap; a round priced above the cap converts at the cap.",
  );
}

function mfnSentence(instrument: string): string {
  return `A most-favoured-nation clause means that if the company later issues a ${instrument} on better terms, you may take those terms instead.`;
}

const PRO_RATA =
  "Pro-rata rights let you invest again in the next priced round to keep your percentage.";

function safe(terms: SafeTerms, amount: bigint, target: bigint): CalculatorResult {
  const d = draft();
  const cap = fixed(terms.valuationCap);
  const preMoney = terms.variant === "pre_money";
  const post = cap === undefined ? undefined : preMoney ? cap + target : cap;

  convertible(d, {
    converting: amount,
    post,
    discount: fixed(terms.discountPercent),
    instrument: "SAFE",
    capSentence: (ownership) =>
      preMoney
        ? `A pre-money cap of ${money(cap ?? 0n)} plus a ${money(target)} round values the company at about ${money(post ?? 0n)} once the round closes, so ${money(amount)} buys about ${ownership} of it.`
        : `At a ${money(cap ?? 0n)} post-money cap, ${money(amount)} buys about ${ownership} of the company.`,
  });

  if (preMoney && cap !== undefined) {
    d.assumptions.push(
      `Assumes the full round target of ${money(target)} is raised: the cap is a pre-money cap, so the round is added to it before your share is worked out.`,
    );
  }
  if (post !== undefined && post > 0n) d.assumptions.push(IGNORES_POOL);
  if (terms.mfn) d.explanation.push(mfnSentence("SAFE"));
  if (terms.proRata) d.explanation.push(PRO_RATA);
  return result("safe", d);
}

function note(terms: NoteTerms, amount: bigint): CalculatorResult {
  const d = draft();
  const cap = fixed(terms.valuationCap);
  const rate = fixedOr0(terms.interestRatePercent);

  // principal × rate/100 × months/12 — simple interest, stated as such, because a note that
  // compounded would convert a different number and the investor would be reading the wrong one.
  const years = ratio(BigInt(terms.maturityMonths) * 1_000_000n, 12_000_000n) ?? 0n;
  const interest = product(product(amount, ratio(rate, 100_000_000n) ?? 0n), years);
  const converting = amount + interest;

  d.explanation.push(
    interest === 0n
      ? `The note carries ${percentText(rate)} simple interest a year over ${terms.maturityMonths} months, so ${money(converting)} converts.`
      : `Simple interest of ${percentText(rate)} a year over ${terms.maturityMonths} months adds about ${money(interest)} to your ${money(amount)}, so about ${money(converting)} converts.`,
  );

  convertible(d, {
    converting,
    post: cap,
    discount: fixed(terms.discountPercent),
    instrument: "note",
    capSentence: (ownership) =>
      `At a ${money(cap ?? 0n)} cap, ${money(converting)} buys about ${ownership} of the company.`,
  });

  d.assumptions.push(
    `Assumes the note runs its full ${terms.maturityMonths}-month term and converts with its accrued interest; the interest is simple, not compounded.`,
  );
  if (cap !== undefined && cap > 0n) d.assumptions.push(IGNORES_POOL);
  if (terms.mfn) d.explanation.push(mfnSentence("note or SAFE"));
  if (terms.proRata) d.explanation.push(PRO_RATA);
  return result("note", d);
}

function priced(terms: PricedTerms, amount: bigint, target: bigint): CalculatorResult {
  const d = draft();
  const preMoney = fixedOr0(terms.preMoneyValuation);
  const post = preMoney + target;
  const ownership = percentOf(amount, post);

  if (ownership === undefined) {
    d.explanation.push(
      "These terms do not give enough to estimate ownership from: the pre-money valuation and the round target add up to nothing.",
    );
  } else {
    d.low = ownership;
    d.high = ownership;
    d.valuation = post;
    d.explanation.push(
      `A pre-money valuation of ${money(preMoney)} plus a ${money(target)} round values the company at about ${money(post)} once the round closes, so ${money(amount)} buys about ${percentText(ownership)} of it.`,
    );
  }

  const pricePerShare = fixed(terms.pricePerShare);
  const count = pricePerShare === undefined ? undefined : ratio(amount, pricePerShare);
  if (count !== undefined && count > 0n) {
    d.shares = count;
    d.explanation.push(
      `At ${sharePrice(pricePerShare ?? 0n)} a share that is about ${shares(count)} shares.`,
    );
  } else {
    d.assumptions.push(
      "No price per share is set, so the number of shares follows once the round's price is fixed.",
    );
  }

  const multiple = fixed(terms.liquidationPreferenceMultiple);
  if (multiple !== undefined) {
    const times = decimalText(multiple);
    d.explanation.push(
      `A ${times}× ${terms.participating ? "participating" : "non-participating"} liquidation preference means you are paid back ${times}× your investment before the common shares in a sale${terms.participating ? ", and then share what is left alongside them" : ""}.`,
    );
  }

  const pool = fixed(terms.optionPoolPercent);
  d.assumptions.push(
    pool === undefined
      ? IGNORES_POOL
      : `A ${percentText(pool)} option pool comes out of the pre-money valuation, so it dilutes the existing shareholders rather than this investment.`,
  );
  d.assumptions.push(`Assumes the full round target of ${money(target)} is raised.`);
  if (terms.proRata) d.explanation.push(PRO_RATA);
  return result("priced", d);
}

/**
 * What an amount buys under a set of terms. Pure, total, and the same function on both sides of
 * the wire.
 */
export function calculate(input: CalculatorInput): CalculatorResult {
  const amount = fixedOr0(input.amount);
  const target = fixedOr0(input.roundTarget);
  switch (input.terms.kind) {
    case "safe":
      return safe(input.terms, amount, target);
    case "note":
      return note(input.terms, amount);
    case "priced":
      return priced(input.terms, amount, target);
    default:
      throw new RangeError("unknown instrument kind");
  }
}
