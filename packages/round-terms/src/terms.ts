import { parseFixed } from "@fundroom/decimal";
import { z } from "zod";

/*
 * The terms of a round, as data (E2.5 D3, contract §P).
 *
 * `round.terms.terms` is a jsonb column holding one of three shapes chosen by the round's
 * `instrument_kind`, and these schemas are what decides whether a shape is one of them. They
 * live in a package rather than in the module because the investor's browser runs the same
 * calculator over the same object: a SAFE that the server would accept and the SPA would refuse
 * (or the other way round) is a support ticket nobody can reproduce.
 *
 * Deliberately **no `@hono/zod-openapi`** here. The server module wraps these with `.openapi()`
 * names of its own; importing the OpenAPI flavour of zod would drag Hono into the browser
 * bundle for the sake of a component name the browser never sees.
 */

/** The three instruments a round can be raised on. Mirrors the `round.instrument_kind` enum. */
export const INSTRUMENT_KINDS = ["safe", "note", "priced"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

/** Mirrors the `round.stage` enum. Ordered youngest to oldest, with `other` last. */
export const ROUND_STAGES = [
  "pre_seed",
  "seed",
  "series_a",
  "series_b",
  "bridge",
  "other",
] as const;
export type RoundStage = (typeof ROUND_STAGES)[number];

/**
 * Plain decimal text, sign optional, exponent notation refused.
 *
 * The same regex `@fundroom/decimal` parses with and the same one the wire uses everywhere
 * else in the product: `numeric(20, 6)` never comes back from Postgres in exponent form, so a
 * value in that form did not come from a column, and `1e7` silently meaning ten million in a
 * valuation cap is not a widening anyone should make by accident.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/** Money and valuations on the wire: a decimal string, never a JavaScript number. */
export const Decimal = z.string().regex(DECIMAL_RE).max(32);

/**
 * A percentage, `0`…`100` inclusive, as a decimal string.
 *
 * The bound is checked through `parseFixed` rather than a regex or a `Number()`: the string has
 * already been proved to be plain decimal text, and comparing fixed-point bigints is the only
 * comparison in this package that cannot disagree with the arithmetic that follows it.
 */
const Percent = Decimal.refine(
  (text) => {
    const value = parseFixed(text);
    return value !== undefined && value >= 0n && value <= 100_000_000n;
  },
  { message: "must be a percentage between 0 and 100" },
);

export const SafeTermsSchema = z
  .object({
    kind: z.literal("safe"),
    variant: z.enum(["post_money", "pre_money"]),
    valuationCap: Decimal.optional(),
    discountPercent: Percent.optional(),
    mfn: z.boolean().default(false),
    proRata: z.boolean().default(false),
  })
  .strict();
export type SafeTerms = z.output<typeof SafeTermsSchema>;

export const NoteTermsSchema = z
  .object({
    kind: z.literal("note"),
    valuationCap: Decimal.optional(),
    discountPercent: Percent.optional(),
    interestRatePercent: Percent,
    maturityMonths: z.number().int().min(1).max(120),
    mfn: z.boolean().default(false),
    proRata: z.boolean().default(false),
  })
  .strict();
export type NoteTerms = z.output<typeof NoteTermsSchema>;

export const PricedTermsSchema = z
  .object({
    kind: z.literal("priced"),
    preMoneyValuation: Decimal,
    pricePerShare: Decimal.optional(),
    liquidationPreferenceMultiple: Decimal.default("1"),
    participating: z.boolean().default(false),
    proRata: z.boolean().default(false),
    optionPoolPercent: Percent.optional(),
  })
  .strict();
export type PricedTerms = z.output<typeof PricedTermsSchema>;

export const TermsSchema = z.discriminatedUnion("kind", [
  SafeTermsSchema,
  NoteTermsSchema,
  PricedTermsSchema,
]);
export type Terms = z.output<typeof TermsSchema>;

/**
 * Bumped when the stored shape changes; written to `round.terms.terms_schema_version` and read
 * back before anything trusts a row. Every jsonb column in this repo carries one.
 */
export const TERMS_SCHEMA_VERSION = 1;

/**
 * Parses stored or submitted terms against the schema for the round's declared instrument.
 *
 * Parsing against the **kind** rather than against the union is the whole point: the union alone
 * would happily accept a note body for a round whose column says `safe`, and the two would then
 * disagree for as long as the row exists. Picking the schema by `kind` makes the `z.literal`
 * check do the work, so a mismatch throws a `ZodError` naming the field, like any other invalid
 * input.
 */
export function parseTerms(kind: InstrumentKind, data: unknown): Terms {
  switch (kind) {
    case "safe":
      return SafeTermsSchema.parse(data);
    case "note":
      return NoteTermsSchema.parse(data);
    case "priced":
      return PricedTermsSchema.parse(data);
    default:
      throw new RangeError(`unknown instrument kind: ${String(kind)}`);
  }
}
