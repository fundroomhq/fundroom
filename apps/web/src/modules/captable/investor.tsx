import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { PieChart, Scale } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { isApiError } from "../../lib/api.js";
import {
  type CaptableInvestorShareBucket,
  type CaptableInvestorSummary,
  type CaptableMyHolding,
  captableMeQuery,
} from "../../lib/captable-queries.js";
import { Markdown } from "../../lib/markdown.js";
import { m } from "../../paraglide/messages.js";
import {
  bucketLabel,
  classKindLabel,
  formatAmount,
  formatAsOf,
  formatBucketPercent,
  formatPercent,
  formatShares,
} from "./format.js";

/*
 * Cap table, reader side (E3.6 §8): "your holdings". `GET /captable/me` carries the whole page
 * — the published snapshot's date, this member's own lines, the disclaimer and, only when the
 * workspace chose `summary`, a coarse breakdown by kind (see `SummaryCard`).
 *
 * A 404 means "nothing for you here" whichever of its reasons applies (module off, nothing
 * published, the workspace shows investors nothing), and the screen says the same thing for
 * all of them: telling a reader *which* would say something about the workspace's cap table
 * they were not shown. A member with no line in a published snapshot gets their own empty
 * state, not a zero.
 */

function DisclaimerAside({ body }: { body: string }) {
  return (
    <aside
      aria-label={m.captable_disclaimer_title()}
      className="rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground"
    >
      <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
        <Scale aria-hidden="true" className="size-3.5" />
        {m.captable_disclaimer_title()}
      </p>
      <Markdown
        source={body}
        className="prose prose-sm prose-neutral max-w-prose dark:prose-invert"
      />
    </aside>
  );
}

function HoldingsTable({ holdings }: { holdings: readonly CaptableMyHolding[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{m.captable_my_holdings_caption()}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{m.captable_col_class()}</TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_shares()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_amount()}
            </TableHead>
            <TableHead scope="col">{m.captable_col_issued()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {holdings.map((h, i) => (
            // A member can hold two identical-looking lines (two grants of one class), and the
            // payload has no row id, so the position is the key.
            <TableRow key={i}>
              <TableHead scope="row" className="font-medium">
                {h.className}
                <span className="block text-xs font-normal text-muted-foreground">
                  {classKindLabel(h.kind)}
                </span>
              </TableHead>
              <TableCell className="text-right tabular-nums">
                {h.shares === null ? "—" : formatShares(h.shares)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {h.amount === null ? "—" : formatAmount(h.amount, h.currency)}
              </TableCell>
              <TableCell>{h.issuedOn === null ? "—" : formatAsOf(h.issuedOn)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/*
 * The company-wide view (`investorView: "summary"`, ORCH R2-G1). Deliberately coarse so that no
 * single reader can difference their way to another holder: kind buckets only, each with
 * nothing but its % of fully diluted to one decimal place, a bucket shown only when at least
 * three *other* holders are in it, and SAFEs/notes as presence alone. What the server left out
 * is not mentioned by name or counted here — only that small categories are not shown.
 */
function SummaryCard({ summary }: { summary: CaptableInvestorSummary }) {
  const shares = summary.buckets.filter(
    (b): b is CaptableInvestorShareBucket => b.kind !== "convertibles",
  );
  const convertibles = summary.buckets.some((b) => b.kind === "convertibles");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.captable_investor_summary_title()}</CardTitle>
        <CardDescription>{m.captable_investor_summary_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.captable_investor_summary_none()}</p>
        ) : null}
        {shares.length === 0 ? null : (
          <Table>
            <caption className="sr-only">{m.captable_investor_summary_title()}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.captable_col_category()}</TableHead>
                <TableHead scope="col" className="text-right">
                  {m.captable_col_percent_fd()}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.map((b) => (
                <TableRow key={b.kind}>
                  <TableHead scope="row" className="font-medium">
                    {bucketLabel(b.kind)}
                  </TableHead>
                  <TableCell className="text-right tabular-nums">
                    {formatBucketPercent(b.percentFullyDiluted)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {convertibles ? (
          <p className="text-sm">{m.captable_investor_convertibles_present()}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">{m.captable_investor_summary_note()}</p>
      </CardContent>
    </Card>
  );
}

export default function CaptableInvestor() {
  const me = useQuery(captableMeQuery);
  const notFound = me.isError && isApiError(me.error) && me.error.status === 404;
  const data = me.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.captable_investor_title()}
        description={m.captable_investor_subtitle()}
      />
      {me.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {me.isError && !notFound ? <ErrorAlert error={me.error} /> : null}
      {notFound ? (
        <EmptyState
          icon={<PieChart aria-hidden="true" />}
          title={m.captable_investor_empty_title()}
          description={m.captable_investor_empty_body()}
        />
      ) : null}
      {data === undefined ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{m.captable_my_holdings_title()}</CardTitle>
              <CardDescription>{m.captable_as_of({ asOf: formatAsOf(data.asOf) })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.holdings.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.captable_my_holdings_none()}</p>
              ) : (
                <>
                  <p className="text-sm">
                    {m.captable_my_ownership({
                      shares: formatShares(data.ownership.fullyDilutedShares),
                      percent: formatPercent(data.ownership.percentFullyDiluted),
                    })}
                  </p>
                  <HoldingsTable holdings={data.holdings} />
                </>
              )}
            </CardContent>
          </Card>
          {/* Straight under the numbers it qualifies, not at the foot of the page. */}
          <DisclaimerAside body={data.disclaimer} />
          {data.summary === null ? null : <SummaryCard summary={data.summary} />}
        </>
      )}
    </div>
  );
}
