import type { Allocation } from "@fundroom/round-terms";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { TriangleAlert } from "lucide-react";
import type { RoundCounters } from "../../lib/round-queries.js";
import { m } from "../../paraglide/messages.js";
import { commitmentStatusLabel, formatMoney, formatPercent } from "./format.js";
import { StatusBar } from "./status-bar.js";

/*
 * The allocation tracker (design/03 §C: "target, soft-circled, hard-committed, signed,
 * wired"). It is the *same* computation as the investor's status bar — `allocation()` in
 * `@fundroom/round-terms` over `round.commitment` (§D2) — with the buckets broken out, which
 * is the difference between the two audiences and the whole of it.
 *
 * The >35 counter (§D7) is a **warning, never a block**. Rule 506(b) admits up to 35
 * non-accredited but sophisticated purchasers; going past it is the company's decision to
 * make with counsel, and a screen that refused to accept the 36th would be making a legal
 * judgement it is not entitled to make. So it says the number, says the limit, and stops.
 */

export function AllocationTracker({
  allocation,
  counters,
  currency,
}: {
  allocation: Allocation;
  counters: RoundCounters;
  currency: string;
}) {
  const rows = [
    { key: "soft", label: commitmentStatusLabel("soft"), amount: allocation.soft },
    { key: "verbal", label: commitmentStatusLabel("verbal"), amount: allocation.verbal },
    { key: "signed", label: commitmentStatusLabel("signed"), amount: allocation.signed },
    { key: "wired", label: commitmentStatusLabel("wired"), amount: allocation.wired },
    { key: "committed", label: m.round_bucket_committed(), amount: allocation.committed },
    { key: "total", label: m.round_bucket_total(), amount: allocation.total },
    { key: "remaining", label: m.round_bucket_remaining(), amount: allocation.remaining },
  ];
  const percentOf: Record<string, string | undefined> = {
    soft: allocation.percent.soft,
    committed: allocation.percent.committed,
    wired: allocation.percent.wired,
  };
  const overLimit = counters.nonAccreditedAccepted >= counters.limit;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_allocation_title()}</CardTitle>
        <CardDescription>
          {m.round_allocation_subtitle({ target: formatMoney(allocation.target, currency) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <StatusBar allocation={allocation} currency={currency} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{m.round_col_bucket()}</TableHead>
              <TableHead scope="col">{m.round_col_amount()}</TableHead>
              <TableHead scope="col">{m.round_col_share()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableHead scope="row" className="font-medium">
                  {row.label}
                </TableHead>
                <TableCell className="tabular-nums">{formatMoney(row.amount, currency)}</TableCell>
                <TableCell className="tabular-nums">
                  {percentOf[row.key] === undefined
                    ? m.round_no_amount()
                    : formatPercent(percentOf[row.key])}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">{m.round_counter_submitted()}</dt>
            <dd className="text-lg font-semibold tabular-nums">{counters.submitted}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{m.round_counter_accepted()}</dt>
            <dd className="text-lg font-semibold tabular-nums">{counters.accepted}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{m.round_counter_non_accredited()}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {m.round_counter_of_limit({
                count: String(counters.nonAccreditedAccepted),
                limit: String(counters.limit),
              })}
            </dd>
          </div>
        </dl>

        {overLimit ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{m.round_non_accredited_warning_title()}</AlertTitle>
            <AlertDescription>
              <p>
                {m.round_non_accredited_warning_body({
                  count: String(counters.nonAccreditedAccepted),
                  limit: String(counters.limit),
                })}
              </p>
              <p>{m.round_non_accredited_warning_not_blocking()}</p>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
