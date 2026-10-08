import type { Terms } from "@fundroom/round-terms";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@fundroomhq/ui";
import type { ReactNode } from "react";
import { m } from "../../paraglide/messages.js";
import { formatMoney, formatRate, instrumentLabel, stageLabel } from "./format.js";

/*
 * The instrument summary card (design/03 A4): "explain the live round — instrument, amount,
 * cap/discount/MFN, pro-rata, minimums".
 *
 * Every term is **named in words and then explained in a sentence**. A cap table is not common
 * knowledge, and a card that said only "Cap $8,000,000 · Discount 20% · MFN" would be a term
 * sheet reprinted, not an explanation. The sentences are descriptive, never advisory — they
 * say what the term *is*, not whether it is a good deal.
 */

interface TermRow {
  readonly key: string;
  readonly term: string;
  readonly value: string;
  readonly note: string;
}

function safeRows(terms: Extract<Terms, { kind: "safe" }>, currency: string): TermRow[] {
  const rows: TermRow[] = [
    {
      key: "variant",
      term: m.round_terms_instrument(),
      value:
        terms.variant === "post_money"
          ? m.round_terms_safe_post_money()
          : m.round_terms_safe_pre_money(),
      note:
        terms.variant === "post_money"
          ? m.round_terms_safe_post_money_note()
          : m.round_terms_safe_pre_money_note(),
    },
  ];
  if (terms.valuationCap !== undefined) {
    rows.push({
      key: "cap",
      term: m.round_terms_cap(),
      value: formatMoney(terms.valuationCap, currency),
      note: m.round_terms_cap_note(),
    });
  }
  if (terms.discountPercent !== undefined) {
    rows.push({
      key: "discount",
      term: m.round_terms_discount(),
      value: formatRate(terms.discountPercent),
      note: m.round_terms_discount_note(),
    });
  }
  rows.push(mfnRow(terms.mfn), proRataRow(terms.proRata));
  return rows;
}

function noteRows(terms: Extract<Terms, { kind: "note" }>, currency: string): TermRow[] {
  const rows: TermRow[] = [
    {
      key: "instrument",
      term: m.round_terms_instrument(),
      value: m.round_instrument_note(),
      note: m.round_terms_note_note(),
    },
  ];
  if (terms.valuationCap !== undefined) {
    rows.push({
      key: "cap",
      term: m.round_terms_cap(),
      value: formatMoney(terms.valuationCap, currency),
      note: m.round_terms_cap_note(),
    });
  }
  if (terms.discountPercent !== undefined) {
    rows.push({
      key: "discount",
      term: m.round_terms_discount(),
      value: formatRate(terms.discountPercent),
      note: m.round_terms_discount_note(),
    });
  }
  rows.push(
    {
      key: "interest",
      term: m.round_terms_interest(),
      value: formatRate(terms.interestRatePercent),
      note: m.round_terms_interest_note(),
    },
    {
      key: "maturity",
      term: m.round_terms_maturity(),
      value: m.round_terms_maturity_value({ months: String(terms.maturityMonths) }),
      note: m.round_terms_maturity_note(),
    },
    mfnRow(terms.mfn),
    proRataRow(terms.proRata),
  );
  return rows;
}

function pricedRows(terms: Extract<Terms, { kind: "priced" }>, currency: string): TermRow[] {
  const rows: TermRow[] = [
    {
      key: "instrument",
      term: m.round_terms_instrument(),
      value: m.round_instrument_priced(),
      note: m.round_terms_priced_note(),
    },
    {
      key: "pre-money",
      term: m.round_terms_pre_money(),
      value: formatMoney(terms.preMoneyValuation, currency),
      note: m.round_terms_pre_money_note(),
    },
  ];
  if (terms.pricePerShare !== undefined) {
    rows.push({
      key: "price",
      term: m.round_terms_price_per_share(),
      value: formatMoney(terms.pricePerShare, currency),
      note: m.round_terms_price_per_share_note(),
    });
  }
  rows.push({
    key: "liquidation",
    term: m.round_terms_liquidation(),
    value: m.round_terms_liquidation_value({ multiple: terms.liquidationPreferenceMultiple }),
    note: terms.participating
      ? m.round_terms_liquidation_participating()
      : m.round_terms_liquidation_non_participating(),
  });
  if (terms.optionPoolPercent !== undefined) {
    rows.push({
      key: "pool",
      term: m.round_terms_option_pool(),
      value: formatRate(terms.optionPoolPercent),
      note: m.round_terms_option_pool_note(),
    });
  }
  rows.push(proRataRow(terms.proRata));
  return rows;
}

function mfnRow(mfn: boolean): TermRow {
  return {
    key: "mfn",
    term: m.round_terms_mfn(),
    value: mfn ? m.round_terms_mfn_yes() : m.round_terms_mfn_no(),
    note: m.round_terms_mfn_note(),
  };
}

function proRataRow(proRata: boolean): TermRow {
  return {
    key: "pro-rata",
    term: m.round_terms_pro_rata(),
    value: proRata ? m.round_terms_pro_rata_yes() : m.round_terms_pro_rata_no(),
    note: m.round_terms_pro_rata_note(),
  };
}

export function termRows(terms: Terms, currency: string): readonly TermRow[] {
  switch (terms.kind) {
    case "safe":
      return safeRows(terms, currency);
    case "note":
      return noteRows(terms, currency);
    default:
      return pricedRows(terms, currency);
  }
}

export function TermsList({ terms, currency }: { terms: Terms; currency: string }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {termRows(terms, currency).map((row) => (
        <div key={row.key} className="space-y-1">
          <dt className="text-sm font-medium">{row.term}</dt>
          <dd className="space-y-1">
            <p className="text-lg font-semibold tabular-nums">{row.value}</p>
            <p className="text-sm text-muted-foreground">{row.note}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface InstrumentSummary {
  readonly name: string;
  readonly stage: string;
  readonly instrumentKind: string;
  readonly currency: string;
  readonly targetAmount: string;
  readonly minimumInvestment: string | null;
}

/** The card at the top of the investor page and inside the `round_summary` content block. */
export function InstrumentSummaryCard({
  round,
  terms,
  children,
}: {
  round: InstrumentSummary;
  terms: Terms | null;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{round.name}</CardTitle>
        <CardDescription>
          {m.round_summary_line({
            stage: stageLabel(round.stage),
            instrument: instrumentLabel(round.instrumentKind),
          })}
        </CardDescription>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {m.round_summary_target({ amount: formatMoney(round.targetAmount, round.currency) })}
          </Badge>
          {round.minimumInvestment === null ? null : (
            <Badge variant="outline">
              {m.round_summary_minimum({
                amount: formatMoney(round.minimumInvestment, round.currency),
              })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {terms === null ? (
          <p className="text-sm text-muted-foreground">{m.round_terms_none()}</p>
        ) : (
          <TermsList terms={terms} currency={round.currency} />
        )}
        {children}
      </CardContent>
    </Card>
  );
}
