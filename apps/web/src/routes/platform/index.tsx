import {
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import * as z from "zod/mini";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { WorkspaceStatusBadges } from "../../components/platform/common.js";
import { CreateWorkspaceForm } from "../../components/platform/create-workspace.js";
import { formatDate } from "../../lib/format.js";
import {
  platformPlansQuery,
  platformWorkspacesQuery,
  subscriptionStatusLabel,
  WORKSPACE_STATUSES,
  type WorkspaceStatus,
  workspaceStatusLabel,
} from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * The filters live in the URL, so a filtered list survives a reload and can be pasted to a
 * colleague. Unknown values are dropped rather than rejected — the server would refuse them.
 */
const searchSchema = z.object({
  q: z.catch(z.optional(z.string()), undefined),
  status: z.catch(z.optional(z.enum(WORKSPACE_STATUSES)), undefined),
  plan: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/platform/")({
  validateSearch: searchSchema,
  component: WorkspacesPage,
});

/**
 * Every workspace on this install (E3.10): status, plan, subscription and cell, keyset-paged
 * oldest first. Only names and counters — the operator API carries no tenant content.
 */
function WorkspacesPage() {
  const search = Route.useSearch();
  const workspaces = useInfiniteQuery(platformWorkspacesQuery(search));
  const items = workspaces.data?.pages.flatMap((page) => page.items) ?? [];
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.platform_workspaces_title()}
        description={m.platform_workspaces_body()}
        actions={
          creating ? null : (
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {m.platform_create_open()}
            </Button>
          )
        }
      />
      {creating ? <CreateWorkspaceForm onDone={() => setCreating(false)} /> : null}
      <Filters />
      {workspaces.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {workspaces.isError ? <ErrorAlert error={workspaces.error} /> : null}
      {workspaces.data ? (
        items.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title={m.platform_workspaces_none_title()}
            description={m.platform_workspaces_none_body()}
          />
        ) : (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <Table>
                <TableCaption className="sr-only">{m.platform_workspaces_title()}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.platform_col_workspace()}</TableHead>
                    <TableHead>{m.platform_col_status()}</TableHead>
                    <TableHead>{m.platform_col_plan()}</TableHead>
                    <TableHead>{m.platform_col_subscription()}</TableHead>
                    <TableHead>{m.platform_col_cell()}</TableHead>
                    <TableHead>{m.platform_col_created()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((ws) => (
                    <TableRow key={ws.id}>
                      <TableCell>
                        <Link
                          to="/platform/workspaces/$id"
                          params={{ id: ws.id }}
                          className="font-medium underline underline-offset-4"
                        >
                          {ws.name}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">{ws.slug}</div>
                      </TableCell>
                      <TableCell>
                        <WorkspaceStatusBadges
                          status={ws.status}
                          reason={ws.suspendedReason}
                          holds={ws.holds}
                        />
                        {ws.deletedAt === null ? null : (
                          <div className="text-xs text-muted-foreground">
                            {m.platform_deleted({ when: formatDate(ws.deletedAt) })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{ws.planId ?? m.platform_no_plan()}</TableCell>
                      <TableCell>
                        {ws.subscription === null
                          ? m.platform_no_subscription()
                          : subscriptionStatusLabel(ws.subscription.status)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{ws.cellId}</TableCell>
                      <TableCell>{formatDate(ws.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {workspaces.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={workspaces.isFetchingNextPage}
                  onClick={() => void workspaces.fetchNextPage()}
                >
                  {m.common_load_more()}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}

function Filters() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const plans = useQuery(platformPlansQuery);
  const qId = useId();
  const statusId = useId();
  const planId = useId();
  const [q, setQ] = useState(search.q ?? "");
  const [status, setStatus] = useState<WorkspaceStatus | "">(search.status ?? "");
  const [plan, setPlan] = useState(search.plan ?? "");
  // Back/forward changes the URL under the form: follow it.
  useEffect(() => {
    setQ(search.q ?? "");
    setStatus(search.status ?? "");
    setPlan(search.plan ?? "");
  }, [search.q, search.status, search.plan]);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    void navigate({
      to: "/platform",
      search: {
        ...(q.trim() === "" ? {} : { q: q.trim() }),
        ...(status === "" ? {} : { status }),
        ...(plan === "" ? {} : { plan }),
      },
    });
  };
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      aria-label={m.platform_filters_label()}
      onSubmit={apply}
    >
      <Field id={qId} label={m.platform_filter_q()} className="min-w-48 flex-1">
        <Input id={qId} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <Field id={statusId} label={m.platform_col_status()}>
        <NativeSelect
          id={statusId}
          value={status}
          onChange={(e) => setStatus(e.target.value as WorkspaceStatus | "")}
        >
          <option value="">{m.platform_filter_any()}</option>
          {WORKSPACE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {workspaceStatusLabel(s)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={planId} label={m.platform_col_plan()}>
        <NativeSelect id={planId} value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="">{m.platform_filter_any()}</option>
          {(plans.data?.plans ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {/* A plan in the URL that the list does not (yet) have still reads as selected. */}
          {plan !== "" && !(plans.data?.plans ?? []).some((p) => p.id === plan) ? (
            <option value={plan}>{plan}</option>
          ) : null}
        </NativeSelect>
      </Field>
      <Button type="submit">{m.platform_filter_apply()}</Button>
    </form>
  );
}
