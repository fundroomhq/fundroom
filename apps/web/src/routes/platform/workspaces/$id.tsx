import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  fieldAria,
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
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, BarChart3, Eye } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import {
  LimitsList,
  NoteConfirmDialog,
  WorkspaceStatusBadges,
} from "../../../components/platform/common.js";
import { MoveWorkspaceCard } from "../../../components/platform/move-workspace.js";
import { formatBytes, formatDate, formatDateTime } from "../../../lib/format.js";
import {
  describePlatformError,
  formatCount,
  type LiftableHold,
  orderedHolds,
  PLATFORM_KEY,
  type PlatformMe,
  type PlatformWorkspaceDetail,
  patchWorkspace,
  platformCellsQuery,
  platformMeQuery,
  platformPlansQuery,
  platformWorkspaceQuery,
  platformWorkspaceUsageQuery,
  recordManualSubscription,
  rescreenWorkspace,
  SANCTIONS_KEY,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  sanctionsDecisionLabel,
  sanctionsOutcomeLabel,
  subscriptionStatusLabel,
  suspendWorkspace,
  unsuspendWorkspace,
  type WorkspaceHold,
  workspaceKey,
} from "../../../lib/platform-queries.js";
import { countryOptions } from "../../../lib/signup-queries.js";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";

export const Route = createFileRoute("/platform/workspaces/$id")({ component: WorkspacePage });

/*
 * One workspace as the operator sees it (E3.10): status with its actions, plan and cell, the
 * subscription, the latest sanctions screening and 30 days of usage. The owners' addresses are
 * on this page because an operator needs a billing contact, and the server audits every read
 * of them (`platform.workspace.owners_read`) — the page says so next to the list.
 */
function WorkspacePage() {
  const { id } = Route.useParams();
  const workspace = useQuery(platformWorkspaceQuery(id));
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/platform">
          <ArrowLeft aria-hidden="true" />
          {m.platform_back_to_workspaces()}
        </Link>
      </Button>
      {workspace.isPending ? <LoadingState lines={6} label={m.common_loading()} /> : null}
      {workspace.isError ? <ErrorAlert error={workspace.error} /> : null}
      {workspace.data ? <WorkspaceDetail ws={workspace.data} /> : null}
    </div>
  );
}

function WorkspaceDetail({ ws }: { ws: PlatformWorkspaceDetail }) {
  return (
    <>
      <PageHeader
        title={ws.name}
        description={m.platform_workspace_subtitle({ slug: ws.slug, id: ws.id })}
      />
      <OverviewCard ws={ws} />
      <CompanyCard ws={ws} />
      <StatusCard ws={ws} />
      <PlanCellCard ws={ws} />
      <MoveWorkspaceCard ws={ws} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SubscriptionCard ws={ws} />
        <SanctionsCard ws={ws} />
      </div>
      <OwnersCard ws={ws} />
      <UsageCard id={ws.id} />
    </>
  );
}

function OverviewCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_overview_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.platform_legal_name()}</dt>
          <dd>{ws.legalName ?? m.platform_not_recorded()}</dd>
          <dt className="text-muted-foreground">{m.platform_country()}</dt>
          <dd>{ws.country ?? m.platform_not_recorded()}</dd>
          <dt className="text-muted-foreground">{m.platform_col_created()}</dt>
          <dd>{formatDateTime(ws.createdAt)}</dd>
          <dt className="text-muted-foreground">{m.platform_custom_domains()}</dt>
          <dd>{formatCount(ws.customDomains)}</dd>
          {ws.deletedAt === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.platform_deleted_at()}</dt>
              <dd>{formatDateTime(ws.deletedAt)}</dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

/*
 * The tenant's company as sanctions screening and invoicing know it (E3.10 FR2). A change is
 * screened again when the install screens at all (the server queues it); a re-screen never takes
 * a live portal down by itself — a hit only lands in the sanctions queue.
 */
function CompanyCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const invalidate = useInvalidateWorkspace(ws.id);
  const countries = useMemo(() => countryOptions(getLocale()), []);
  const legalId = useId();
  const countryId = useId();
  const [legalName, setLegalName] = useState(ws.legalName ?? "");
  const [country, setCountry] = useState(ws.country ?? "");
  const [submitted, setSubmitted] = useState(false);
  const changes: { legalName?: string; country?: string } = {};
  if (legalName.trim() !== (ws.legalName ?? "")) changes.legalName = legalName.trim();
  if (country !== (ws.country ?? "")) changes.country = country;
  const legalInvalid = legalName.trim() === "";
  const countryInvalid = country === "";
  const save = useMutation({
    mutationFn: () => patchWorkspace(ws.id, changes),
    onSuccess: () => {
      invalidate();
      toast.success(m.platform_company_saved());
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_company_title()}</CardTitle>
        <CardDescription>{m.platform_company_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-[1fr_16rem_auto] md:items-start"
          aria-label={m.platform_company_title()}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (legalInvalid || countryInvalid || Object.keys(changes).length === 0) return;
            save.mutate();
          }}
        >
          <Field
            id={legalId}
            label={m.platform_legal_name()}
            error={submitted && legalInvalid ? m.platform_create_legal_invalid() : undefined}
            required
          >
            <Input
              id={legalId}
              value={legalName}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setLegalName(e.target.value)}
              {...fieldAria(legalId, { error: submitted && legalInvalid })}
            />
          </Field>
          <Field
            id={countryId}
            label={m.platform_country()}
            error={submitted && countryInvalid ? m.platform_create_country_invalid() : undefined}
            required
          >
            <NativeSelect
              id={countryId}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              {...fieldAria(countryId, { error: submitted && countryInvalid })}
            >
              <option value="">{m.signup_country_choose()}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button
            type="submit"
            className="md:mt-6"
            loading={save.isPending}
            disabled={Object.keys(changes).length === 0}
          >
            {m.platform_company_save()}
          </Button>
          {save.isError ? (
            <Alert variant="destructive" role="alert" className="md:col-span-3">
              <AlertDescription>{describePlatformError(save.error)}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** After any write: the detail, the list rows and the sanctions queue may all have moved. */
function useInvalidateWorkspace(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKey(id) });
    void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "workspaces", "list"] });
    void queryClient.invalidateQueries({ queryKey: SANCTIONS_KEY });
  };
}

function StatusCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkspace(ws.id);
  const onDone = (next: PlatformWorkspaceDetail) => {
    // Write answers carry `owners: []` (only the detail GET reads — and audits — the owners),
    // so keep the list this page already has rather than blanking it until the refetch.
    queryClient.setQueryData<PlatformWorkspaceDetail>(workspaceKey(ws.id), (prev) => ({
      ...next,
      owners: prev?.owners ?? next.owners,
    }));
    invalidate();
  };
  const suspend = useMutation({
    mutationFn: (note: string) => suspendWorkspace(ws.id, note),
    onSuccess: (next) => {
      onDone(next);
      toast.success(m.platform_suspended_toast({ name: ws.name }));
    },
  });
  const holds = orderedHolds(ws.holds);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_status_title()}</CardTitle>
        <CardDescription>{statusSentence(ws)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <WorkspaceStatusBadges status={ws.status} reason={ws.suspendedReason} holds={ws.holds} />
        {holds.length > 1 ? (
          <p className="text-sm text-muted-foreground">{m.platform_holds_several()}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {/* An operator suspension adds to whatever else holds the workspace; it is not a
              replacement for it. */}
          {holds.includes("operator") ? null : (
            <NoteConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  {m.platform_suspend()}
                </Button>
              }
              title={m.platform_suspend_title({ name: ws.name })}
              description={m.platform_suspend_body()}
              confirmLabel={m.platform_suspend()}
              noteLabel={m.platform_note_label()}
              noteDescription={m.platform_note_help()}
              destructive
              pending={suspend.isPending}
              error={suspend.isError ? describePlatformError(suspend.error) : undefined}
              onConfirm={(note) => suspend.mutateAsync(note)}
            />
          )}
          {holds.map((hold) => (
            <LiftHold key={hold} ws={ws} hold={hold} onDone={onDone} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One action per hold: each lifts only its own flag (`unsuspend` with `hold`), so the page never
 * offers a single "unsuspend" that would look like it clears everything.
 */
function LiftHold({
  ws,
  hold,
  onDone,
}: {
  ws: PlatformWorkspaceDetail;
  hold: LiftableHold;
  onDone: (next: PlatformWorkspaceDetail) => void;
}) {
  const lift = useMutation({
    mutationFn: (note: string) => unsuspendWorkspace(ws.id, note, hold),
    onSuccess: (next) => {
      onDone(next);
      toast.success(
        next.status === "active"
          ? m.platform_unsuspended_toast({ name: ws.name })
          : m.platform_hold_lifted_toast({ name: ws.name }),
      );
    },
  });
  const words = liftWords(hold, ws.name);
  return (
    <NoteConfirmDialog
      trigger={
        <Button type="button" variant="outline">
          {words.action}
        </Button>
      }
      title={words.title}
      description={words.body}
      confirmLabel={words.action}
      noteLabel={m.platform_note_label()}
      noteDescription={m.platform_note_help()}
      pending={lift.isPending}
      error={lift.isError ? describePlatformError(lift.error) : undefined}
      onConfirm={(note) => lift.mutateAsync(note)}
    />
  );
}

function liftWords(
  hold: WorkspaceHold,
  name: string,
): { action: string; title: string; body: string } {
  switch (hold) {
    case "sanctions_review":
      return {
        action: m.platform_release(),
        title: m.platform_release_title({ name }),
        body: m.platform_unsuspend_sanctions_body(),
      };
    case "sanctions":
      return {
        action: m.platform_lift_sanctions(),
        title: m.platform_lift_sanctions_title({ name }),
        body: m.platform_unsuspend_sanctions_body(),
      };
    case "billing":
      return {
        action: m.platform_lift_billing(),
        title: m.platform_lift_billing_title({ name }),
        body: m.platform_unsuspend_billing_body(),
      };
    default:
      return {
        action: m.platform_unsuspend(),
        title: m.platform_unsuspend_title({ name }),
        body: m.platform_unsuspend_body(),
      };
  }
}

function statusSentence(ws: PlatformWorkspaceDetail): string {
  if (ws.status === "active") return m.platform_status_active_body();
  if (ws.status === "pending_review") return m.platform_status_pending_body();
  switch (ws.suspendedReason) {
    case "billing":
      return m.platform_status_suspended_billing_body();
    case "sanctions":
      return m.platform_status_suspended_sanctions_body();
    case "relocation":
      return m.platform_status_suspended_relocation_body();
    default:
      return m.platform_status_suspended_operator_body();
  }
}

const NO_PLAN = "";

function PlanCellCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const plans = useQuery(platformPlansQuery);
  const cells = useQuery(platformCellsQuery);
  const invalidate = useInvalidateWorkspace(ws.id);
  const planFieldId = useId();
  const cellFieldId = useId();
  const [plan, setPlan] = useState(ws.planId ?? NO_PLAN);
  const [cell, setCell] = useState(ws.cellId);
  const savePlan = useMutation({
    mutationFn: () => patchWorkspace(ws.id, { planId: plan === NO_PLAN ? null : plan }),
    onSuccess: () => {
      invalidate();
      toast.success(m.platform_plan_changed());
    },
    onError: (error) => toast.error(describePlatformError(error)),
  });
  const saveCell = useMutation({
    mutationFn: () => patchWorkspace(ws.id, { cellId: cell }),
    onSuccess: () => {
      invalidate();
      toast.success(m.platform_cell_changed());
    },
    onError: (error) => toast.error(describePlatformError(error)),
  });
  // Archived plans stay on the workspaces that have them but cannot be assigned: only the
  // current one is listed, so the select still shows what the workspace is on.
  const planOptions = (plans.data?.plans ?? []).filter(
    (p) => p.archivedAt === null || p.id === ws.planId,
  );
  // E3.11: a label change is instant only between cells of this database; a cell elsewhere is
  // reached by a move (the card below), so the select never offers one.
  const cellOptions = (cells.data?.cells ?? []).filter(
    (c) => c.local && (c.status === "active" || c.id === ws.cellId),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_plan_cell_title()}</CardTitle>
        <CardDescription>{m.platform_plan_cell_body()}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            savePlan.mutate();
          }}
        >
          <Field id={planFieldId} label={m.platform_col_plan()} className="flex-1">
            <NativeSelect
              id={planFieldId}
              value={plan}
              disabled={plans.isPending}
              onChange={(e) => setPlan(e.target.value)}
            >
              <option value={NO_PLAN}>{m.platform_no_plan()}</option>
              {planOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.archivedAt === null
                    ? p.name
                    : m.platform_plan_archived_option({ name: p.name })}
                </option>
              ))}
              {ws.planId !== null && !planOptions.some((p) => p.id === ws.planId) ? (
                <option value={ws.planId}>{ws.planId}</option>
              ) : null}
            </NativeSelect>
          </Field>
          <Button
            type="submit"
            loading={savePlan.isPending}
            disabled={plan === (ws.planId ?? NO_PLAN)}
          >
            {m.platform_change_plan()}
          </Button>
        </form>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveCell.mutate();
          }}
        >
          <Field id={cellFieldId} label={m.platform_col_cell()} className="flex-1">
            <NativeSelect
              id={cellFieldId}
              value={cell}
              disabled={cells.isPending}
              onChange={(e) => setCell(e.target.value)}
            >
              {cellOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {m.platform_cell_option({ id: c.id, region: c.region })}
                </option>
              ))}
              {cellOptions.some((c) => c.id === ws.cellId) ? null : (
                <option value={ws.cellId}>{ws.cellId}</option>
              )}
            </NativeSelect>
          </Field>
          <Button type="submit" loading={saveCell.isPending} disabled={cell === ws.cellId}>
            {m.platform_change_cell()}
          </Button>
        </form>
        <p className="text-sm text-muted-foreground md:col-span-2">
          {m.platform_cell_local_only()}
        </p>
        {plans.isError ? <ErrorAlert error={plans.error} /> : null}
        {cells.isError ? <ErrorAlert error={cells.error} /> : null}
      </CardContent>
    </Card>
  );
}

function SubscriptionCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const sub = ws.subscription;
  const me = useQuery(platformMeQuery);
  const manual = manualBilling(me.data);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_subscription_title()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {sub === null ? (
          <p className="text-sm text-muted-foreground">{m.platform_no_subscription_body()}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{m.platform_col_status()}</dt>
            <dd>
              <Badge variant="outline">{subscriptionStatusLabel(sub.status)}</Badge>
            </dd>
            <dt className="text-muted-foreground">{m.platform_provider()}</dt>
            <dd>
              {sub.provider === "stripe"
                ? m.platform_provider_stripe()
                : m.platform_provider_manual()}
            </dd>
            <dt className="text-muted-foreground">{m.platform_period_end()}</dt>
            <dd>
              {sub.currentPeriodEnd === null
                ? m.platform_not_recorded()
                : formatDate(sub.currentPeriodEnd)}
            </dd>
          </dl>
        )}
        {manual ? <ManualSubscriptionForm ws={ws} /> : null}
      </CardContent>
    </Card>
  );
}

/*
 * The manual billing driver (BILLING_DRIVER=manual): the host invoices by hand, so the operator
 * records what was agreed — the subscription's status and paid-up-to date — here. Offered only
 * when the install bills manually (`/platform/me`'s `billingDriver`); the route answers 409
 * `billing_unavailable` for any other driver anyway.
 */
function manualBilling(me: PlatformMe | undefined): boolean {
  return me?.billingDriver === "manual";
}

/** `YYYY-MM-DD` of an ISO timestamp (UTC), for a date input. */
function dayOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function ManualSubscriptionForm({ ws }: { ws: PlatformWorkspaceDetail }) {
  const invalidate = useInvalidateWorkspace(ws.id);
  const statusId = useId();
  const endId = useId();
  const [status, setStatus] = useState<SubscriptionStatus>(ws.subscription?.status ?? "active");
  const [periodEnd, setPeriodEnd] = useState(dayOf(ws.subscription?.currentPeriodEnd));
  const save = useMutation({
    mutationFn: () =>
      recordManualSubscription(ws.id, {
        status,
        // A cleared date means "no end recorded" (null), not "leave as it was".
        currentPeriodEnd: periodEnd === "" ? null : `${periodEnd}T00:00:00.000Z`,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(m.platform_manual_saved());
    },
  });
  const noPlan = ws.planId === null;
  return (
    <form
      className="space-y-3 border-t pt-4"
      aria-label={m.platform_manual_title()}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{m.platform_manual_title()}</h3>
        <p className="text-sm text-muted-foreground">
          {noPlan ? m.platform_manual_no_plan() : m.platform_manual_body()}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={statusId} label={m.platform_col_status()}>
          <NativeSelect
            id={statusId}
            value={status}
            disabled={noPlan}
            onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
          >
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {subscriptionStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={endId}
          label={m.platform_period_end()}
          description={m.platform_manual_period_help()}
        >
          <Input
            id={endId}
            type="date"
            value={periodEnd}
            disabled={noPlan}
            onChange={(e) => setPeriodEnd(e.target.value)}
            {...fieldAria(endId, { description: true })}
          />
        </Field>
      </div>
      {save.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{describePlatformError(save.error)}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" variant="outline" loading={save.isPending} disabled={noPlan}>
        {m.platform_manual_save()}
      </Button>
    </form>
  );
}

function SanctionsCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const invalidate = useInvalidateWorkspace(ws.id);
  const rescreen = useMutation({
    mutationFn: () => rescreenWorkspace(ws.id),
    onSuccess: () => {
      invalidate();
      toast.success(m.platform_rescreen_queued());
    },
    onError: (error) => toast.error(describePlatformError(error)),
  });
  const s = ws.sanctions;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_sanctions_title()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {s === null ? (
          <p className="text-sm text-muted-foreground">{m.platform_sanctions_never()}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{m.platform_col_outcome()}</dt>
            <dd>{sanctionsOutcomeLabel(s.outcome)}</dd>
            <dt className="text-muted-foreground">{m.platform_col_decision()}</dt>
            <dd>{sanctionsDecisionLabel(s.decision)}</dd>
            <dt className="text-muted-foreground">{m.platform_screened_at()}</dt>
            <dd>{formatDateTime(s.createdAt)}</dd>
          </dl>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            loading={rescreen.isPending}
            onClick={() => rescreen.mutate()}
          >
            {m.platform_rescreen()}
          </Button>
          <Link
            to="/platform/sanctions"
            search={{ status: "all", workspace: ws.id }}
            className="text-sm underline underline-offset-4"
          >
            {m.platform_sanctions_history_link()}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function OwnersCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_owners_title()}</CardTitle>
        <CardDescription>{m.platform_owners_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <Eye aria-hidden="true" />
          <AlertDescription>{m.platform_owners_audited()}</AlertDescription>
        </Alert>
        {ws.owners.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.platform_owners_none()}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {ws.owners.map((o) => (
              <li key={o.email} className="font-mono break-all">
                {o.email}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function UsageCard({ id }: { id: string }) {
  const usage = useQuery(platformWorkspaceUsageQuery(id));
  // Oldest first on the wire; the newest day is what an operator looks for first.
  const days = [...(usage.data?.last30 ?? [])].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_usage_title()}</CardTitle>
        <CardDescription>{m.platform_usage_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {usage.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {usage.isError ? <ErrorAlert error={usage.error} /> : null}
        {usage.data ? (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {usage.data.plan === null
                  ? m.platform_usage_no_plan()
                  : m.platform_usage_plan({ name: usage.data.plan.name })}
              </p>
              {usage.data.plan === null ? null : <LimitsList limits={usage.data.plan.limits} />}
            </div>
            {days.length === 0 ? (
              <EmptyState
                icon={<BarChart3 />}
                title={m.platform_usage_none_title()}
                description={m.platform_usage_none_body()}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableCaption>{m.platform_usage_caption()}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.platform_col_day()}</TableHead>
                      <TableHead className="text-right">{m.platform_limit_staff_seats()}</TableHead>
                      <TableHead className="text-right">
                        {m.platform_limit_investor_seats()}
                      </TableHead>
                      <TableHead className="text-right">{m.platform_limit_storage()}</TableHead>
                      <TableHead className="text-right">
                        {m.platform_limit_custom_domains()}
                      </TableHead>
                      <TableHead className="text-right">{m.platform_col_emails_sent()}</TableHead>
                      <TableHead className="text-right">{m.platform_col_docs_viewed()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {days.map((d) => (
                      <TableRow key={d.day}>
                        <TableCell className="font-mono text-xs">{d.day}</TableCell>
                        <TableCell className="text-right">{formatCount(d.staffSeats)}</TableCell>
                        <TableCell className="text-right">{formatCount(d.investorSeats)}</TableCell>
                        <TableCell className="text-right">{formatBytes(d.storageBytes)}</TableCell>
                        <TableCell className="text-right">{formatCount(d.customDomains)}</TableCell>
                        <TableCell className="text-right">{formatCount(d.emailsSent)}</TableCell>
                        <TableCell className="text-right">{formatCount(d.docsViewed)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
