import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import * as z from "zod/mini";
import { ErrorAlert } from "../../../components/error-alert.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  formatCount,
  sanctionsDecisionLabel,
  sanctionsOutcomeLabel,
  sanctionsQueueQuery,
} from "../../../lib/platform-queries.js";
import { m } from "../../../paraglide/messages.js";

/*
 * `status`: the open queue (potential matches and errors nobody has decided) or every screening.
 * `workspace`: narrows the list to one workspace — where the workspace page's "screening
 * history" link lands. The server has no per-workspace filter, so it is applied here.
 */
const searchSchema = z.object({
  status: z.catch(z.optional(z.enum(["open", "all"])), undefined),
  workspace: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/platform/sanctions/")({
  validateSearch: searchSchema,
  component: SanctionsPage,
});

/**
 * The sanctions review queue (E3.10). A potential match or a failed screen holds the workspace
 * (`pending_review`) until an operator decides; the decision itself happens on the screening's
 * own page, where the matches are.
 */
function SanctionsPage() {
  const search = Route.useSearch();
  const status = search.status ?? "open";
  const list = useQuery(sanctionsQueueQuery(status));
  const items = (list.data?.items ?? []).filter(
    (s) => search.workspace === undefined || s.workspaceId === search.workspace,
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.platform_sanctions_queue_title()}
        description={m.platform_sanctions_queue_body()}
      />
      <nav aria-label={m.platform_sanctions_views()} className="flex gap-4 text-sm">
        <Link
          to="/platform/sanctions"
          search={{}}
          className="underline underline-offset-4 aria-[current=page]:font-semibold"
          aria-current={status === "open" && search.workspace === undefined ? "page" : undefined}
        >
          {m.platform_sanctions_open()}
        </Link>
        <Link
          to="/platform/sanctions"
          search={{ status: "all" }}
          className="underline underline-offset-4 aria-[current=page]:font-semibold"
          aria-current={status === "all" && search.workspace === undefined ? "page" : undefined}
        >
          {m.platform_sanctions_all()}
        </Link>
      </nav>
      {search.workspace === undefined ? null : (
        <p className="text-sm text-muted-foreground">{m.platform_sanctions_one_workspace()}</p>
      )}
      {list.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={m.platform_sanctions_none_title()}
            description={
              status === "open" ? m.platform_sanctions_none_open() : m.platform_sanctions_none_all()
            }
          />
        ) : (
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableCaption className="sr-only">
                  {m.platform_sanctions_queue_title()}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.platform_col_subject()}</TableHead>
                    <TableHead>{m.platform_col_workspace()}</TableHead>
                    <TableHead>{m.platform_col_outcome()}</TableHead>
                    <TableHead className="text-right">{m.platform_col_matches()}</TableHead>
                    <TableHead>{m.platform_col_decision()}</TableHead>
                    <TableHead>{m.platform_screened_at()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link
                          to="/platform/sanctions/$id"
                          params={{ id: s.id }}
                          className="font-medium underline underline-offset-4"
                        >
                          {s.subjectName}
                        </Link>
                        {s.subjectCountry === null ? null : (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {s.subjectCountry}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.workspaceSlug ?? m.platform_workspace_gone()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.outcome === "clear" ? "success" : "warning"}>
                          {sanctionsOutcomeLabel(s.outcome)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatCount(s.matchCount)}</TableCell>
                      <TableCell>{sanctionsDecisionLabel(s.decision)}</TableCell>
                      <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}
