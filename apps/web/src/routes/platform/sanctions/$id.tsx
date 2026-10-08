import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ErrorAlert } from "../../../components/error-alert.js";
import { NoteConfirmDialog } from "../../../components/platform/common.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  decideSanctions,
  describePlatformError,
  PLATFORM_KEY,
  SANCTIONS_KEY,
  type SanctionsDecision,
  type SanctionsScreeningDetail,
  sanctionsDecisionLabel,
  sanctionsOutcomeLabel,
  sanctionsScreeningQuery,
} from "../../../lib/platform-queries.js";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";

export const Route = createFileRoute("/platform/sanctions/$id")({ component: ScreeningPage });

/*
 * One screening and its decision (E3.10). The operator reads every list entry the matcher
 * flagged, then clears the workspace (a false positive: the hold lifts, or a sanctions
 * suspension ends) or confirms the match (the workspace is suspended for sanctions). Both are
 * irreversible from here and both need a written note, which is kept with the screening as the
 * legal record — so each goes through a confirm dialog that will not submit without one.
 */
function ScreeningPage() {
  const { id } = Route.useParams();
  const screening = useQuery(sanctionsScreeningQuery(id));
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/platform/sanctions">
          <ArrowLeft aria-hidden="true" />
          {m.platform_back_to_sanctions()}
        </Link>
      </Button>
      {screening.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {screening.isError ? <ErrorAlert error={screening.error} /> : null}
      {screening.data ? <Screening s={screening.data} /> : null}
    </div>
  );
}

function formatScore(score: number): string {
  return new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 }).format(
    score,
  );
}

function Screening({ s }: { s: SanctionsScreeningDetail }) {
  return (
    <>
      <PageHeader
        title={s.subjectName}
        description={m.platform_screening_subtitle({
          provider: s.provider,
          list: s.listVersion,
        })}
      />
      <Card>
        <CardHeader>
          <CardTitle>{m.platform_screening_summary()}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{m.platform_col_workspace()}</dt>
            <dd>
              {s.workspaceSlug === null ? (
                m.platform_workspace_gone()
              ) : (
                <Link
                  to="/platform/workspaces/$id"
                  params={{ id: s.workspaceId }}
                  className="font-mono underline underline-offset-4"
                >
                  {s.workspaceSlug}
                </Link>
              )}
            </dd>
            <dt className="text-muted-foreground">{m.platform_country()}</dt>
            <dd>{s.subjectCountry ?? m.platform_not_recorded()}</dd>
            <dt className="text-muted-foreground">{m.platform_col_outcome()}</dt>
            <dd>
              <Badge variant={s.outcome === "clear" ? "success" : "warning"}>
                {sanctionsOutcomeLabel(s.outcome)}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">{m.platform_screened_at()}</dt>
            <dd>{formatDateTime(s.createdAt)}</dd>
            <dt className="text-muted-foreground">{m.platform_col_decision()}</dt>
            <dd>
              {sanctionsDecisionLabel(s.decision)}
              {s.decidedAt === null ? null : (
                <span className="text-muted-foreground">
                  {" "}
                  {m.platform_decided_at({ when: formatDateTime(s.decidedAt) })}
                </span>
              )}
            </dd>
            {s.decisionNote === null ? null : (
              <>
                <dt className="text-muted-foreground">{m.platform_note_label()}</dt>
                <dd className="whitespace-pre-wrap">{s.decisionNote}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>
      <MatchesCard s={s} />
      {s.decision === null && s.outcome !== "clear" ? <DecisionCard s={s} /> : null}
    </>
  );
}

function MatchesCard({ s }: { s: SanctionsScreeningDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_matches_title()}</CardTitle>
        <CardDescription>
          {s.outcome === "error" ? m.platform_matches_error() : m.platform_matches_body()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {s.matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.platform_matches_none()}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">{m.platform_matches_title()}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.platform_col_listed_name()}</TableHead>
                  <TableHead className="text-right">{m.platform_col_score()}</TableHead>
                  <TableHead>{m.platform_col_programs()}</TableHead>
                  <TableHead>{m.platform_col_source()}</TableHead>
                  <TableHead>{m.platform_col_entry()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...s.matches]
                  .sort((a, b) => b.score - a.score)
                  .map((match) => (
                    <TableRow key={`${match.source}:${match.listEntryId}:${match.name}`}>
                      <TableCell className="font-medium">{match.name}</TableCell>
                      <TableCell className="text-right">{formatScore(match.score)}</TableCell>
                      <TableCell>{match.programs.join(", ")}</TableCell>
                      <TableCell>{match.source}</TableCell>
                      <TableCell className="font-mono text-xs">{match.listEntryId}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionCard({ s }: { s: SanctionsScreeningDetail }) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ decision, note }: { decision: SanctionsDecision; note: string }) =>
      decideSanctions(s.id, decision, note),
    onSuccess: (next, { decision }) => {
      queryClient.setQueryData(sanctionsScreeningQuery(s.id).queryKey, next);
      void queryClient.invalidateQueries({ queryKey: SANCTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "workspaces"] });
      toast.success(
        decision === "cleared"
          ? m.platform_decision_cleared_toast()
          : m.platform_decision_confirmed_toast(),
      );
    },
  });
  const error = decide.isError ? describePlatformError(decide.error) : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_decide_title()}</CardTitle>
        <CardDescription>{m.platform_decide_body()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <NoteConfirmDialog
          trigger={<Button type="button">{m.platform_decide_clear()}</Button>}
          title={m.platform_decide_clear_title({ name: s.subjectName })}
          description={m.platform_decide_clear_body()}
          confirmLabel={m.platform_decide_clear()}
          noteLabel={m.platform_note_label()}
          noteDescription={m.platform_decide_note_help()}
          pending={decide.isPending}
          error={decide.variables?.decision === "cleared" ? error : undefined}
          onConfirm={(note) => decide.mutateAsync({ decision: "cleared", note })}
        />
        <NoteConfirmDialog
          trigger={
            <Button type="button" variant="destructive">
              {m.platform_decide_confirm()}
            </Button>
          }
          title={m.platform_decide_confirm_title({ name: s.subjectName })}
          description={m.platform_decide_confirm_body()}
          confirmLabel={m.platform_decide_confirm()}
          noteLabel={m.platform_note_label()}
          noteDescription={m.platform_decide_note_help()}
          destructive
          pending={decide.isPending}
          error={decide.variables?.decision === "confirmed" ? error : undefined}
          onConfirm={(note) => decide.mutateAsync({ decision: "confirmed", note })}
        />
      </CardContent>
    </Card>
  );
}
