import { calculate, type Terms } from "@fundroom/round-terms";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  Input,
} from "@fundroomhq/ui";
import { Scale } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { isDecimal } from "../../lib/round-queries.js";
import { m } from "../../paraglide/messages.js";
import { formatPercent } from "./format.js";

/*
 * "What this means for you" (design/03 A4), and its ceiling: design/03:204 caps this at "a
 * read-only summary plus a simple ownership estimate with a disclaimer". Scenario modelling is
 * a later epic, so there is one input here and no sliders.
 *
 * The arithmetic is `calculate()` from `@fundroom/round-terms` — **the same function the
 * server runs** (`GET /round/current/calculate`). Running it locally is what makes the figure
 * move as somebody types without a request per keystroke; running the *same* function is what
 * stops the two answers from drifting, which would be far worse than a slower field.
 *
 * Contract §X.2: the cap is the **low** end of the range and the discount the high one — a
 * convertible converts at the better of the two prices, so ownership at the cap is a floor a
 * discount can only raise. The two figures are labelled by the term that produces them ("at
 * the cap", "with the discount") rather than as "worst" and "best", which would be a
 * prediction rather than a description.
 */

export function Calculator({
  terms,
  roundTarget,
  defaultAmount = "",
}: {
  terms: Terms;
  roundTarget: string;
  defaultAmount?: string;
}) {
  const amountId = useId();
  const [amount, setAmount] = useState(defaultAmount);
  const trimmed = amount.trim();
  const usable = isDecimal(trimmed) && Number(trimmed) > 0;
  const result = useMemo(() => {
    if (!usable) return undefined;
    try {
      return calculate({ terms, amount: trimmed, roundTarget });
    } catch {
      // A total function by contract; a malformed set of stored terms must still not take the
      // page down, so the card simply shows nothing rather than an error nobody can act on.
      return undefined;
    }
  }, [terms, trimmed, roundTarget, usable]);

  const low = result?.ownershipPercentLow;
  const high = result?.ownershipPercentHigh;
  const sameFigure = low !== undefined && high !== undefined && low === high;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_calculator_title()}</CardTitle>
        <CardDescription>{m.round_calculator_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field
          id={amountId}
          label={m.round_calculator_amount()}
          description={m.round_calculator_amount_hint()}
        >
          <Input
            id={amountId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="max-w-48 tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            {...fieldAria(amountId, { description: true })}
          />
        </Field>

        {result === undefined ? (
          <p className="text-sm text-muted-foreground">{m.round_calculator_prompt()}</p>
        ) : (
          <div className="space-y-4">
            {low === undefined && high === undefined ? null : (
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                {low === undefined ? null : (
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      {sameFigure ? m.round_calculator_ownership() : m.round_calculator_at_cap()}
                    </dt>
                    <dd className="text-2xl font-semibold tabular-nums">{formatPercent(low)}</dd>
                  </div>
                )}
                {high === undefined || sameFigure ? null : (
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      {m.round_calculator_with_discount()}
                    </dt>
                    <dd className="text-2xl font-semibold tabular-nums">{formatPercent(high)}</dd>
                  </div>
                )}
              </dl>
            )}
            {result.explanation.length === 0 ? null : (
              <div className="space-y-1">
                {result.explanation.map((sentence) => (
                  <p key={sentence} className="text-sm">
                    {sentence}
                  </p>
                ))}
              </div>
            )}
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{m.round_calculator_assumptions()}</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {result.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <aside
          aria-label={m.round_calculator_disclaimer_label()}
          className="flex gap-2 rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          <Scale aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>{m.round_calculator_disclaimer()}</p>
        </aside>
      </CardContent>
    </Card>
  );
}
