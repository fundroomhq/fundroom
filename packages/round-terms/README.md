# @fundroom/round-terms

The terms of a round, as data and arithmetic. Pure: `zod` and
`@fundroom/decimal`, no I/O, no `@hono/zod-openapi` — the server module wraps these schemas with
its own OpenAPI component names, so the browser never pulls Hono in for the sake of one.

It is a package rather than a file inside `modules/round` because both sides of the wire run it.
`GET /round/current/calculate` and the investor's calculator card call the same `calculate()`, and
`POST /round/current/interest` and the form's live path hint call the same `eligibility()`. An
investor who reads one percentage while typing and a different one on the confirmation screen has
been told two things, and one of them is wrong.

## What it exports

- **Vocabularies** — `INSTRUMENT_KINDS`, `ROUND_STAGES`, `ACCREDITATION_PATHS`,
  `COMMITMENT_STATUSES`; each mirrors a Postgres enum in the `round` schema.
- **Schemas** — `Decimal` (the wire form of money: a plain decimal string, exponent notation
  refused), `SafeTermsSchema`, `NoteTermsSchema`, `PricedTermsSchema`, `TermsSchema` (the
  discriminated union stored in `round.terms.terms`), `TERMS_SCHEMA_VERSION`, and `parseTerms(kind,
  data)`, which parses against the round's declared instrument so a note body can never be stored
  under a round whose column says `safe`.
- **`calculate(input)`** — the ownership estimate.
- **`eligibility(input)`** and `US_MIN_INVESTMENT` — the accreditation path.
- **`allocation(commitments, target)`** — the progress buckets.

Percentages are decimal strings `0`…`100`; every figure in and out is a string, and all of the
arithmetic happens on fixed-point `bigint`s through `@fundroom/decimal`.

## The calculator

`calculate({ terms, amount, roundTarget })` answers `{ kind, ownershipPercentLow?,
ownershipPercentHigh?, effectiveValuation?, sharesEstimate?, explanation, assumptions }`.
Percentages carry two decimals, `effectiveValuation` and `sharesEstimate` are whole units, and
`explanation` and `assumptions` are plain-English sentences meant to be printed beside the figures.

| Terms | Ownership | `effectiveValuation` |
| --- | --- | --- |
| SAFE, post-money cap | `amount / cap` | the cap |
| SAFE, pre-money cap | `amount / (cap + roundTarget)` | cap + target |
| SAFE or note, cap **and** discount | low `amount / cap`, high `amount / (cap × (1 − d))` | the cap |
| SAFE or note, discount only | not estimated — it depends on the next round's price | — |
| Note | as above, on `principal × (1 + rate × months / 12)` | the cap |
| Priced | `amount / (preMoney + roundTarget)`; shares `amount / pricePerShare` | preMoney + target |

The cap number is the **low** end of the range, not the high one. A convertible converts at the
better of the cap and the discounted round price, so ownership at the cap is the floor and a
discount can only raise it; the high end is what the discount buys if the next round prices exactly
at the cap. A note's interest is **simple**, not compounded, and the accrued amount is what
converts — both are stated in the result rather than assumed silently.

It never throws. A cap of `"0"`, a 100 % discount and a target of `"0"` are all valid inputs that
divide by zero somewhere; every one of them omits the ownership fields and says so in words,
because a 500 on a figure a founder typed into the terms form is worse than an honest "we cannot
estimate that from these terms". `assumptions` always ends with the rounding note and the reminder
that this is an estimate, not advice.

`CalculatorInput` carries no currency and the sentences are written with `$`. Every round we can
calculate for today is in dollars; a non-USD round needs a currency on the input, which is a change
to this interface rather than a formatting tweak.

## The accreditation path

`eligibility({ offeringStatus, subject, amount, currency })` answers `{ path, questionnaire,
thresholdMet, threshold?, reason }`. The path is computed **on the server** and stored on the
submission row; the browser calls this only to preview what the server will decide.

| Offering status | Path | Questionnaire | Notes |
| --- | --- | --- | --- |
| `none`, `informational` | — | — | throws `RangeError`: the module is disabled in these statuses |
| `506b` | `self_attested` | yes | the investor answers for themselves; nothing is verified |
| `506c`, USD, amount ≥ threshold | `self_certified` | yes | written representations under the minimum-investment safe harbour |
| `506c`, anything else | `verification_required` | yes | answers are still recorded; a human decides |
| `non_us` | `none` | no | neutral copy, no US prompts |

`US_MIN_INVESTMENT` is `{ individual: "200000", entity: "1000000" }` (SEC no-action letter,
12 March 2025). The comparison is **at or above**: exactly $200,000 meets it. The safe harbour is a
dollar figure, so it cannot apply to a round in another currency — a large non-USD subscription is
still `verification_required`.

## Allocation

`allocation(commitments, target)` adds the round up once, for the admin tracker, the investor
progress bar, the CRM reconciliation panel and the commitments export: `{ target, soft, verbal,
signed, wired, committed (verbal + signed + wired), total (soft + committed), remaining (never
below zero), percent: { soft, committed, wired } }`.

`withdrawn` rows are excluded rather than shown as a fifth bucket — a withdrawal is the absence of
a commitment, and a tracker that kept them would make the round look fuller than it is. `total` is
exact even when the round is oversubscribed; only the `percent` fields are capped at 100, so a
progress bar cannot overflow while the figure beside it still tells the truth.
