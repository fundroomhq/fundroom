import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import type {
  CaptableClassSummary,
  CaptableConvertible,
  CaptableCurrencyAmount,
  CaptableOptionPool,
  CaptableSummary,
} from "../../lib/captable-queries.js";
import { m } from "../../paraglide/messages.js";
import { classKindLabel, formatAmount, formatPercent, formatShares } from "./format.js";

/*
 * The pieces the admin summary, the import preview and the investor's class summary share.
 * Every figure here was computed by the server; this file only lays it out.
 */

export function amountsText(amounts: readonly CaptableCurrencyAmount[]): string {
  return amounts.length === 0
    ? "—"
    : amounts.map((a) => formatAmount(a.amount, a.currency)).join(" · ");
}

export function convertiblesText(convertibles: readonly CaptableConvertible[]): string {
  return amountsText(convertibles.map((c) => ({ currency: c.currency, amount: c.total })));
}

/** Fully diluted by class (staff only: the investor side shows kind buckets, `investor.tsx`). */
export function ClassTable({
  classes,
  caption,
  detailed = true,
}: {
  classes: readonly CaptableClassSummary[];
  caption: string;
  detailed?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{m.captable_col_class()}</TableHead>
            <TableHead scope="col">{m.captable_col_kind()}</TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_shares()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_fully_diluted()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_percent_fd()}
            </TableHead>
            {detailed ? (
              <>
                <TableHead scope="col" className="text-right">
                  {m.captable_col_amount()}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {m.captable_col_holders()}
                </TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {classes.map((c) => (
            <TableRow key={c.name}>
              <TableHead scope="row" className="font-medium">
                {c.name}
              </TableHead>
              <TableCell>{classKindLabel(c.kind)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {c.shares === null ? "—" : formatShares(c.shares)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatShares(c.fullyDilutedShares)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(c.percentFullyDiluted)}
              </TableCell>
              {detailed ? (
                <>
                  <TableCell className="text-right tabular-nums">
                    {amountsText(c.amounts ?? [])}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.holders ?? "—"}</TableCell>
                </>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <RoundingNote />
    </div>
  );
}

/**
 * Each "% fully diluted" is rounded (4 dp) on its own by the server, so a column need not add
 * up to exactly 100%. Said under every such table rather than letting a reader find it.
 */
export function RoundingNote() {
  return <p className="mt-2 text-xs text-muted-foreground">{m.captable_rounding_note()}</p>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function optionPoolText(pool: CaptableOptionPool): string {
  if (pool.granted !== null && pool.available !== null)
    return m.captable_option_pool_value({
      pool: formatShares(pool.poolShares),
      granted: formatShares(pool.granted),
      available: formatShares(pool.available),
    });
  return formatShares(pool.poolShares ?? pool.granted);
}

/** Headline figures: fully diluted, holders, the option pool, SAFEs/notes outstanding. */
export function TotalsCard({ summary }: { summary: CaptableSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.captable_totals_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={m.captable_stat_fully_diluted()}
            value={formatShares(summary.fullyDilutedShares)}
          />
          <Stat label={m.captable_stat_holders()} value={String(summary.holderCount)} />
          <Stat
            label={m.captable_stat_convertibles()}
            value={convertiblesText(summary.convertiblesOutstanding)}
          />
          {summary.optionPool === null ? null : (
            <Stat
              label={m.captable_stat_option_pool()}
              value={optionPoolText(summary.optionPool)}
            />
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
