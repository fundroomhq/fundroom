import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { PieChart, Scale } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { Markdown } from "../../lib/markdown.js";
import { type RoundDisclaimer, roundCurrentQuery } from "../../lib/round-queries.js";
import { m } from "../../paraglide/messages.js";
import { Calculator } from "./calculator.js";
import { roundStatusLabel } from "./format.js";
import { InterestForm, MySubmissions } from "./interest-form.js";
import { InvestorClosingCard } from "./investor-closing.js";
import { StatusBar } from "./status-bar.js";
import { InstrumentSummaryCard } from "./terms.js";
import { VerificationCard } from "./verification-card.js";

/*
 * The round, reader side (E2.5 §W). One read — `GET /round/current` — carries the whole page:
 * the round, its current terms, the versioned disclaimer, the progress buckets if the round
 * publishes them, this member's own submissions, and the accreditation document the consent
 * checkbox names.
 *
 * Two things the server decides and this screen only renders:
 *
 *  - **whether there is a bar at all.** `showProgress` is a round setting (§D8); a `null`
 *    `progress` means "do not draw one", not "zero raised".
 *  - **what the form asks.** See `interest-form.tsx`: the accreditation path is server-computed
 *    and the browser never re-derives it.
 *
 * The module is disabled outright in `none` and `informational` (§R), so reaching this screen
 * at all means the workspace is making an offering — which is why the copy can name a round
 * without hedging, and why every word of it still stops short of offering to sell anything.
 */

function DisclaimerAside({ disclaimer }: { disclaimer: RoundDisclaimer }) {
  return (
    <aside
      aria-label={disclaimer.title}
      className="rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground"
    >
      <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
        <Scale aria-hidden="true" className="size-3.5" />
        {disclaimer.versionNo === null
          ? disclaimer.title
          : m.round_disclaimer_version({
              title: disclaimer.title,
              version: String(disclaimer.versionNo),
            })}
      </p>
      <Markdown
        source={disclaimer.body}
        className="prose prose-sm prose-neutral max-w-prose dark:prose-invert"
      />
    </aside>
  );
}

export default function RoundInvestor() {
  const current = useQuery(roundCurrentQuery);
  const data = current.data;

  return (
    <div className="space-y-6">
      <PageHeader title={m.round_investor_title()} description={m.round_investor_subtitle()} />
      {current.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {current.isError ? <ErrorAlert error={current.error} /> : null}
      {data === undefined ? null : data.round === null ? (
        <EmptyState
          icon={<PieChart aria-hidden="true" />}
          title={m.round_investor_empty_title()}
          description={m.round_investor_empty_body()}
        />
      ) : (
        <div className="space-y-6">
          <InstrumentSummaryCard round={data.round} terms={data.terms}>
            <Badge variant={data.round.status === "open" ? "success" : "outline"}>
              {roundStatusLabel(data.round.status)}
            </Badge>
          </InstrumentSummaryCard>

          {/* E3.5: the member's own commitments, once there are any, and how far closing got. */}
          <InvestorClosingCard />

          {data.progress === null ? null : (
            <Card>
              <CardHeader>
                <CardTitle>{m.round_progress_title()}</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBar allocation={data.progress} currency={data.round.currency} />
              </CardContent>
            </Card>
          )}

          {data.round.summary === null || data.round.summary === "" ? null : (
            <Card>
              <CardHeader>
                <CardTitle>{m.round_summary_title()}</CardTitle>
              </CardHeader>
              <CardContent>
                <Markdown
                  source={data.round.summary}
                  className="prose prose-sm prose-neutral max-w-prose dark:prose-invert"
                />
              </CardContent>
            </Card>
          )}

          {data.terms === null ? null : (
            <Calculator terms={data.terms} roundTarget={data.round.targetAmount} />
          )}

          {data.disclaimer === null ? null : <DisclaimerAside disclaimer={data.disclaimer} />}

          {data.round.status === "open" ? (
            <InterestForm
              round={data.round}
              accreditationDocument={data.accreditationDocument}
              offeringStatus={data.offeringStatus}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{m.round_interest_closed()}</p>
          )}

          {/*
           * E3.7: the investor's own accreditation verification. Offered unprompted only where
           * one is expected (506(c), or a submission that needs it); an existing one always shows.
           */}
          <VerificationCard
            needed={
              data.offeringStatus === "506c" ||
              data.submissions.some(
                (s) =>
                  s.accreditationPath === "verification_required" &&
                  (s.status === "submitted" || s.status === "accepted"),
              )
            }
          />

          <MySubmissions submissions={data.submissions} currency={data.round.currency} />
        </div>
      )}
    </div>
  );
}
