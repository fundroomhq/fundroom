import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  LoadingState,
  PageHeader,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, isApiError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  isBindable,
  KPI_PROVIDERS,
  type KpiBinding,
  type KpiProvider,
  type KpiSourceProvider,
  METRIC_SOURCES_KEY,
  type MetricDefinitionView,
  metricDefinitionsQuery,
  metricSourcesQuery,
} from "../../lib/metrics-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { periodKeyLabel } from "./format.js";

/*
 * KPI sources (E3.6 §5): which metric reads which provider's monthly series.
 *
 * The **connection** is not made here. QuickBooks, Xero and Stripe are connected once, in the
 * Integrations hub, by somebody with `integrations.manage`; this screen shows whether each one
 * is there and healthy and links to the hub otherwise. What is decided here is the binding —
 * definition → (provider, source metric) — and that needs `metrics.settings` plus a fresh
 * session (step-up is handled by `useGuardedMutation`).
 *
 * Three rules the screen makes visible rather than leaving to a 422:
 *
 *  - only a **month-period, non-formula** definition can be bound. The others are listed with
 *    the reason, not hidden, so "why can't I bind Net burn?" has an answer on the page;
 *  - a source metric with **`historical: false`** (Stripe MRR, active subscriptions) only ever
 *    has a current value, so a sync writes the current month and never back-fills. The form
 *    says so next to the select, before the admin saves;
 *  - a binding's **last error** is shown in words on its row, because a nightly sync that fails
 *    at 04:55 is otherwise invisible.
 */

export function providerLabel(provider: KpiProvider): string {
  switch (provider) {
    case "quickbooks":
      return m.metrics_kpi_provider_quickbooks();
    case "xero":
      return m.metrics_kpi_provider_xero();
    case "stripe":
      return m.metrics_kpi_provider_stripe();
  }
}

/**
 * One source per metric (C fix round 1): binding a metric the Sheets mapping writes, or mapping
 * a bound metric in Sheets, answers 409 `conflict` with `reason: "source_overlap"` (Sheets also
 * names the offending `keys`). Both screens say which source is in the way, not "conflict".
 */
export function isSourceOverlap(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.code === "conflict" &&
    error.body.error["reason"] === "source_overlap"
  );
}

export function overlapKeys(error: unknown): string[] {
  if (!isSourceOverlap(error) || !isApiError(error)) return [];
  const keys = error.body.error["keys"];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

/** How often, and for how long, the screen re-reads the bindings after "Sync now". */
export const SYNC_POLL_MS = 2_000;
export const SYNC_POLL_LIMIT_MS = 120_000;

/** What "the sync has done something" is measured against: each binding's status and time. */
function bindingSignature(bindings: readonly KpiBinding[]): string {
  return bindings
    .map((b) => `${b.id}:${b.status}:${b.lastSyncAt ?? ""}`)
    .sort()
    .join("|");
}

function ConnectionBadge({ provider }: { provider: KpiSourceProvider }) {
  if (!provider.connected || provider.status === null) {
    return <Badge variant="outline">{m.metrics_kpi_status_not_connected()}</Badge>;
  }
  switch (provider.status) {
    case "active":
      return <Badge variant="success">{m.metrics_kpi_status_connected()}</Badge>;
    case "degraded":
      return <Badge variant="warning">{m.metrics_kpi_status_degraded()}</Badge>;
    case "reauth_required":
      return <Badge variant="destructive">{m.metrics_kpi_status_reauth()}</Badge>;
  }
}

function BindingStatusBadge({ binding }: { binding: KpiBinding }) {
  if (!binding.enabled) return <Badge variant="outline">{m.metrics_kpi_binding_paused()}</Badge>;
  switch (binding.status) {
    case "ok":
      return <Badge variant="success">{m.metrics_sync_ok()}</Badge>;
    case "failed":
      return <Badge variant="destructive">{m.metrics_sync_failed()}</Badge>;
    case "syncing":
      return <Badge variant="warning">{m.metrics_sync_syncing()}</Badge>;
    default:
      return <Badge variant="outline">{m.metrics_sync_idle()}</Badge>;
  }
}

function ProvidersCard({ providers }: { providers: readonly KpiSourceProvider[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.metrics_kpi_providers_title()}</CardTitle>
        <CardDescription>{m.metrics_kpi_providers_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {providers.map((provider) => {
            const name = providerLabel(provider.provider);
            const needsHub = !provider.connected || provider.status !== "active";
            return (
              <li
                key={provider.provider}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{name}</span>
                    <ConnectionBadge provider={provider} />
                  </div>
                  {provider.accountLabel === null ? null : (
                    <p className="text-sm text-muted-foreground">{provider.accountLabel}</p>
                  )}
                  {provider.connected && provider.lastError !== null ? (
                    <p className="break-words text-sm text-destructive">
                      {m.metrics_kpi_provider_last_error({ error: provider.lastError })}
                    </p>
                  ) : null}
                  {provider.connected && provider.metrics.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {m.metrics_kpi_provider_no_metrics()}
                    </p>
                  ) : null}
                </div>
                <Link to="/admin/integrations" className="text-sm underline underline-offset-4">
                  {!provider.connected
                    ? m.metrics_kpi_connect_link_named({ provider: name })
                    : needsHub
                      ? m.metrics_kpi_fix_link_named({ provider: name })
                      : m.metrics_kpi_manage_link_named({ provider: name })}
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function BindingForm({
  definition,
  binding,
  providers,
  onDone,
}: {
  definition: MetricDefinitionView;
  binding: KpiBinding | undefined;
  providers: readonly KpiSourceProvider[];
  onDone: () => void;
}) {
  const base = useId();
  const queryClient = useQueryClient();
  const firstConnected = providers.find((p) => p.connected)?.provider ?? providers[0]?.provider;
  const [provider, setProvider] = useState<KpiProvider | undefined>(
    binding?.provider ?? firstConnected,
  );
  const catalogue = providers.find((p) => p.provider === provider);
  // The server refuses a unit mismatch (a currency series into a count metric), so only the
  // series of this definition's unit are offered.
  const compatible = (p: KpiSourceProvider | undefined) =>
    (p?.metrics ?? []).filter((metric) => metric.unit === definition.unit);
  const metrics = compatible(catalogue);
  const [sourceMetric, setSourceMetric] = useState<string>(
    binding?.sourceMetric ?? metrics[0]?.key ?? "",
  );
  const [enabled, setEnabled] = useState(binding?.enabled ?? true);
  const chosen = metrics.find((metric) => metric.key === sourceMetric);
  const currentOnly = chosen !== undefined && !chosen.historical;

  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT("/metrics/definitions/{id}/binding", {
          params: { path: { id: definition.id } },
          body: { provider: provider ?? "quickbooks", sourceMetric, enabled },
        }),
      ),
    onSuccess: () => {
      toast.success(m.metrics_kpi_binding_saved({ metric: definition.name }));
      void queryClient.invalidateQueries({ queryKey: METRIC_SOURCES_KEY });
      onDone();
    },
  });

  return (
    <form
      className="space-y-4 rounded-md border p-4"
      aria-label={m.metrics_kpi_binding_form_named({ metric: definition.name })}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {isSourceOverlap(save.error) ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.metrics_kpi_overlap_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {m.metrics_kpi_overlap_body({ metric: definition.name })}{" "}
              <Link
                to="/admin/$"
                params={{ _splat: "metrics/sheets" }}
                className="underline underline-offset-4"
              >
                {m.metrics_kpi_overlap_sheets_link()}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <ErrorAlert error={save.error} />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${base}-provider`} label={m.metrics_kpi_field_provider()} required>
          <NativeSelect
            id={`${base}-provider`}
            required
            value={provider ?? ""}
            onChange={(e) => {
              const next = e.target.value as KpiProvider;
              setProvider(next);
              // A metric key from one provider means nothing to another.
              setSourceMetric(compatible(providers.find((p) => p.provider === next))[0]?.key ?? "");
            }}
          >
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.connected
                  ? providerLabel(p.provider)
                  : m.metrics_kpi_provider_option_not_connected({
                      provider: providerLabel(p.provider),
                    })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={`${base}-metric`}
          label={m.metrics_kpi_field_source_metric()}
          description={currentOnly ? m.metrics_kpi_current_only_hint() : undefined}
          required
        >
          <NativeSelect
            id={`${base}-metric`}
            required
            value={sourceMetric}
            {...fieldAria(`${base}-metric`, { description: currentOnly })}
            onChange={(e) => setSourceMetric(e.target.value)}
          >
            {metrics.map((metric) => (
              <option key={metric.key} value={metric.key}>
                {metric.historical
                  ? metric.label
                  : m.metrics_kpi_metric_option_current_only({ metric: metric.label })}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {catalogue !== undefined && metrics.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          {m.metrics_kpi_no_compatible_series({ provider: providerLabel(catalogue.provider) })}
        </p>
      ) : null}
      {catalogue !== undefined && !catalogue.connected ? (
        <p className="text-sm text-muted-foreground">
          {m.metrics_kpi_binding_not_connected_note({
            provider: providerLabel(catalogue.provider),
          })}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          id={`${base}-enabled`}
          type="checkbox"
          className="size-4"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor={`${base}-enabled`} className="text-sm">
          {m.metrics_kpi_field_enabled()}
        </label>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          loading={save.isPending}
          disabled={provider === undefined || sourceMetric === ""}
        >
          {m.metrics_kpi_binding_save()}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}

function DefinitionRow({
  definition,
  bindable,
  binding,
  providers,
}: {
  definition: MetricDefinitionView;
  bindable: boolean;
  binding: KpiBinding | undefined;
  providers: readonly KpiSourceProvider[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(
        api().DELETE("/metrics/definitions/{id}/binding", {
          params: { path: { id: definition.id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.metrics_kpi_binding_removed({ metric: definition.name }));
      void queryClient.invalidateQueries({ queryKey: METRIC_SOURCES_KEY });
    },
  });
  const sourceMetric =
    binding === undefined
      ? undefined
      : providers
          .find((p) => p.provider === binding.provider)
          ?.metrics.find((metric) => metric.key === binding.sourceMetric);

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{definition.name}</h3>
        {binding === undefined ? null : <BindingStatusBadge binding={binding} />}
      </div>
      {!bindable ? (
        <p className="text-sm text-muted-foreground">{m.metrics_kpi_not_bindable()}</p>
      ) : binding === undefined ? (
        <p className="text-sm text-muted-foreground">{m.metrics_kpi_unbound()}</p>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="text-muted-foreground">{m.metrics_kpi_col_source()}</dt>
          <dd>
            {m.metrics_kpi_source_value({
              provider: providerLabel(binding.provider),
              metric: sourceMetric?.label ?? binding.sourceMetric,
            })}
            {sourceMetric !== undefined && !sourceMetric.historical
              ? ` · ${m.metrics_kpi_current_only_short()}`
              : null}
          </dd>
          <dt className="text-muted-foreground">{m.metrics_sheets_last_sync()}</dt>
          <dd>
            {binding.lastSyncAt === null
              ? m.metrics_sheets_never_synced()
              : formatDateTime(binding.lastSyncAt)}
          </dd>
          <dt className="text-muted-foreground">{m.metrics_kpi_history_from_label()}</dt>
          <dd>
            {binding.historyFrom === null
              ? m.metrics_kpi_history_none()
              : m.metrics_kpi_history_from({ month: periodKeyLabel(binding.historyFrom) })}
          </dd>
          {binding.historyNote === null ? null : (
            // Persistent until a later backfill succeeds: later good syncs do not hide it.
            <>
              <dt className="text-muted-foreground">{m.metrics_kpi_history_note_label()}</dt>
              <dd className="flex flex-wrap items-center gap-2 break-words">
                <Badge variant="warning">{m.metrics_kpi_note_badge()}</Badge>
                <span>{binding.historyNote}</span>
              </dd>
            </>
          )}
          {binding.lastError === null ||
          binding.lastError === binding.historyNote ? null : binding.status === "ok" ? (
            // A successful sync can still carry a note ("history too large to backfill"):
            // a warning to read, not a failure to fix.
            <>
              <dt className="text-muted-foreground">{m.metrics_kpi_note()}</dt>
              <dd className="flex flex-wrap items-center gap-2 break-words">
                <Badge variant="warning">{m.metrics_kpi_note_badge()}</Badge>
                <span>{binding.lastError}</span>
              </dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">{m.metrics_sheets_last_error()}</dt>
              <dd className="break-words text-destructive">
                {binding.lastError}
                {binding.consecutiveFailures > 0
                  ? ` · ${m.metrics_kpi_failures({ count: String(binding.consecutiveFailures) })}`
                  : null}
              </dd>
            </>
          )}
        </dl>
      )}
      {bindable ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={editing}
            aria-label={
              binding === undefined
                ? m.metrics_kpi_bind_named({ metric: definition.name })
                : m.metrics_kpi_change_named({ metric: definition.name })
            }
            onClick={() => setEditing((v) => !v)}
          >
            {binding === undefined ? m.metrics_kpi_bind() : m.metrics_kpi_change()}
          </Button>
          {binding === undefined ? null : (
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  aria-label={m.metrics_kpi_unbind_named({ metric: definition.name })}
                >
                  {m.metrics_kpi_unbind()}
                </Button>
              }
              title={m.metrics_kpi_unbind_named({ metric: definition.name })}
              description={m.metrics_kpi_unbind_body()}
              confirmLabel={m.metrics_kpi_unbind()}
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          )}
        </div>
      ) : null}
      <ErrorAlert error={remove.error} />
      {editing ? (
        <BindingForm
          definition={definition}
          binding={binding}
          providers={providers}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </li>
  );
}

type SyncPhase =
  | { kind: "idle" }
  | { kind: "queued"; baseline: string; deadline: number }
  | { kind: "done" }
  | { kind: "timed_out" };

/*
 * "Sync now" only enqueues the workspace's KPI job (202 `{queued: true}`): a 24-month backfill can
 * take minutes, so nothing is read inline. The screen then re-reads `GET /metrics/sources` every
 * couple of seconds until the bindings show the job has run (a status or last-sync time changed
 * and nothing is still `syncing`), or gives up after two minutes and says it is still running.
 */
function SyncCard({
  bindings,
  phase,
  onQueued,
}: {
  bindings: readonly KpiBinding[];
  phase: SyncPhase;
  onQueued: () => void;
}) {
  const sync = useGuardedMutation({
    mutationFn: () => call(api().POST("/metrics/sources/sync")),
    onSuccess: () => onQueued(),
  });
  const active = bindings.filter((b) => b.enabled).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.metrics_kpi_sync_title()}</CardTitle>
        <CardDescription>{m.metrics_kpi_sync_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 429 is an expected answer (6 an hour); describeError turns Retry-After into words. */}
        <ErrorAlert error={sync.error} />
        <Button
          type="button"
          loading={sync.isPending || phase.kind === "queued"}
          disabled={active === 0 || phase.kind === "queued"}
          onClick={() => sync.mutate()}
        >
          <RefreshCw aria-hidden="true" />
          {m.metrics_sheets_sync_now()}
        </Button>
        {active === 0 ? (
          <p className="text-sm text-muted-foreground">{m.metrics_kpi_sync_nothing()}</p>
        ) : null}
        <div aria-live="polite">
          {phase.kind === "queued" ? (
            <Alert>
              <AlertTitle>{m.metrics_kpi_sync_queued_title()}</AlertTitle>
              <AlertDescription>{m.metrics_kpi_sync_queued_body()}</AlertDescription>
            </Alert>
          ) : phase.kind === "done" ? (
            <Alert variant="success">
              <AlertTitle>{m.metrics_kpi_sync_finished_title()}</AlertTitle>
              <AlertDescription>{m.metrics_kpi_sync_finished_body()}</AlertDescription>
            </Alert>
          ) : phase.kind === "timed_out" ? (
            <Alert variant="warning">
              <AlertTitle>{m.metrics_kpi_sync_slow_title()}</AlertTitle>
              <AlertDescription>{m.metrics_kpi_sync_slow_body()}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function KpiSourcesScreen({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<SyncPhase>({ kind: "idle" });
  const sources = useQuery({
    ...metricSourcesQuery,
    refetchInterval: phase.kind === "queued" ? SYNC_POLL_MS : false,
  });
  const signature = sources.data ? bindingSignature(sources.data.bindings) : undefined;
  const stillSyncing = (sources.data?.bindings ?? []).some((b) => b.status === "syncing");
  useEffect(() => {
    if (phase.kind !== "queued" || signature === undefined) return;
    if (signature !== phase.baseline && !stillSyncing) {
      setPhase({ kind: "done" });
      // The grid and the history dialogs read the points the job just wrote.
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    } else if (Date.now() >= phase.deadline) {
      setPhase({ kind: "timed_out" });
    }
  }, [phase, signature, stillSyncing, queryClient]);
  // The deadline has to be noticed even if no refetch lands after it.
  useEffect(() => {
    if (phase.kind !== "queued") return;
    const timer = setTimeout(
      () => setPhase((p) => (p.kind === "queued" ? { kind: "timed_out" } : p)),
      Math.max(0, phase.deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [phase]);
  const definitions = useQuery(metricDefinitionsQuery);
  // Every provider the module knows gets a row, even one the server did not mention.
  const providers: KpiSourceProvider[] = KPI_PROVIDERS.map(
    (provider) =>
      sources.data?.providers.find((p) => p.provider === provider) ?? {
        provider,
        connected: false,
        status: null,
        accountLabel: null,
        lastSuccessAt: null,
        lastError: null,
        metrics: [],
      },
  );
  const bindings = sources.data?.bindings ?? [];
  const rows = (definitions.data?.definitions ?? []).map((d) => ({
    bindable: isBindable(d),
    view: d as MetricDefinitionView,
  }));
  const anyConnected = providers.some((p) => p.connected);

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.metrics_kpi_title()}
        description={m.metrics_kpi_subtitle()}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/$" params={{ _splat: "metrics" }}>
              <ArrowLeft aria-hidden="true" />
              {m.metrics_back_to_grid()}
            </Link>
          </Button>
        }
      />
      {sources.isPending || definitions.isPending ? (
        <LoadingState label={m.common_loading()} />
      ) : null}
      {sources.isError ? <ErrorAlert error={sources.error} /> : null}
      {definitions.isError ? <ErrorAlert error={definitions.error} /> : null}
      {sources.data && definitions.data ? (
        <>
          <ProvidersCard providers={providers} />
          {anyConnected ? null : (
            <Alert>
              <AlertTitle>{m.metrics_kpi_none_connected_title()}</AlertTitle>
              <AlertDescription>
                <p>
                  {m.metrics_kpi_none_connected_body()}{" "}
                  <Link to="/admin/integrations" className="underline underline-offset-4">
                    {m.metrics_kpi_open_integrations()}
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          )}
          {canManage ? (
            <SyncCard
              bindings={bindings}
              phase={phase}
              onQueued={() => {
                setPhase({
                  kind: "queued",
                  baseline: bindingSignature(bindings),
                  deadline: Date.now() + SYNC_POLL_LIMIT_MS,
                });
                void queryClient.invalidateQueries({ queryKey: METRIC_SOURCES_KEY });
              }}
            />
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>{m.metrics_kpi_bindings_title()}</CardTitle>
              <CardDescription>{m.metrics_kpi_bindings_body()}</CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.metrics_grid_empty()}</p>
              ) : (
                <ul className="divide-y">
                  {rows.map(({ view, bindable }) => (
                    <DefinitionRow
                      key={view.id}
                      definition={view}
                      bindable={bindable}
                      binding={bindings.find((b) => b.definitionId === view.id)}
                      providers={providers}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
