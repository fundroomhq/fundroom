import { add, formatFixed, parseFixed } from "@fundroom/decimal";
import {
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
import type { AllocationView, PipelineItem, RoundSummary } from "../../lib/crm-queries.js";
import { m } from "../../paraglide/messages.js";
import { itemSubjectName } from "./common.js";
import { formatMoney } from "./format.js";

/*
 * Forecast against committed, for one round (§D2).
 *
 * The two numbers on this panel come from two different modules and mean two different things:
 * the forecast is the sum of what staff typed on the cards, the committed buckets are what
 * `round.commitment` actually holds. The panel exists to show the gap, so it never blends them
 * into a single figure and it never calls a forecast "raised".
 *
 * The sum is done in fixed point. `numeric(20, 6)` does not survive a double, and a total that
 * is off in the sixth decimal because a browser added `0.1 + 0.2` is precisely the kind of
 * discrepancy this panel would then be blamed for.
 */
export function sumAmounts(items: readonly { amount: string | null }[]): string {
  let total = 0n;
  for (const item of items) {
    if (item.amount === null) continue;
    const parsed = parseFixed(item.amount);
    // A figure that cannot be read is not a zero. It is left out and the caller can say so.
    if (parsed === undefined) continue;
    total = add(total, parsed);
  }
  return formatFixed(total, 2);
}

export function ReconciliationPanel({
  round,
  items,
  allocation,
}: {
  round: RoundSummary | undefined;
  items: readonly PipelineItem[];
  allocation: AllocationView | undefined;
}) {
  const currency = round?.currency ?? null;
  const forecast = sumAmounts(items);
  const withAmount = items.filter((i) => i.amount !== null).length;
  const commitments = allocation?.commitments ?? [];
  const linked = items.filter((i) => i.commitmentId !== null);
  const orphans = linked.filter((i) => !commitments.some((c) => c.id === i.commitmentId));

  const rows: readonly { key: string; label: string; value: string }[] =
    allocation === undefined
      ? []
      : [
          { key: "target", label: m.crm_recon_target(), value: allocation.allocation.target },
          { key: "soft", label: m.crm_commitment_soft(), value: allocation.allocation.soft },
          { key: "verbal", label: m.crm_commitment_verbal(), value: allocation.allocation.verbal },
          { key: "signed", label: m.crm_commitment_signed(), value: allocation.allocation.signed },
          { key: "wired", label: m.crm_commitment_wired(), value: allocation.allocation.wired },
          {
            key: "remaining",
            label: m.crm_recon_remaining(),
            value: allocation.allocation.remaining,
          },
        ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.crm_recon_title()}</CardTitle>
        <CardDescription>{m.crm_recon_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">{m.crm_recon_forecast()}</dt>
            <dd>
              <span className="block text-lg font-semibold tabular-nums">
                {formatMoney(forecast, currency)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {m.crm_recon_forecast_from({ count: String(withAmount) })}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{m.crm_recon_committed()}</dt>
            <dd>
              <span className="block text-lg font-semibold tabular-nums">
                {allocation === undefined
                  ? m.crm_recon_no_allocation()
                  : formatMoney(allocation.allocation.committed, currency)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {m.crm_recon_committed_note()}
              </span>
            </dd>
          </div>
        </dl>
        {allocation === undefined ? (
          <p className="text-sm text-muted-foreground">{m.crm_recon_allocation_unavailable()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.crm_recon_bucket()}</TableHead>
                <TableHead scope="col">{m.crm_recon_amount()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableHead scope="row" className="font-normal">
                    {row.label}
                  </TableHead>
                  <TableCell className="tabular-nums">{formatMoney(row.value, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {orphans.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {m.crm_recon_orphans_title({ count: String(orphans.length) })}
            </p>
            <p className="text-sm text-muted-foreground">{m.crm_recon_orphans_body()}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {orphans.map((item) => (
                <li key={item.id}>
                  {itemSubjectName(item)} — {m.crm_recon_orphan_item()}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {allocation !== undefined && commitments.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.crm_recon_linked({
              linked: String(linked.length - orphans.length),
              total: String(commitments.length),
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
