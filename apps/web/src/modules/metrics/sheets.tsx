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
  Input,
  LoadingState,
  PageHeader,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Mail, RefreshCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, describeError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  CALENDAR_PERIOD_KINDS,
  type CalendarPeriodKind,
  type MetricDefinitionView,
  type MetricSheetConnection,
  metricDefinitionsQuery,
  metricSheetsQuery,
  metricsSettingsQuery,
} from "../../lib/metrics-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { periodKindLabel } from "./format.js";
import { initialMapping, MappingFields, type MappingState, mappingBody } from "./mapping.js";
import { isSourceOverlap, overlapKeys } from "./sources.js";

/*
 * The Google Sheets connection (E2.4 §8). A service account, not an OAuth dance: a
 * self-hoster has nowhere to register a client, so the admin pastes the service-account JSON
 * and we keep the private key envelope-encrypted.
 *
 * The **service-account email is shown as prominently as anything on this screen**, because
 * "share the sheet with this address" is the step everybody misses and the server's
 * `unauthorized` failure detail says exactly that. A connection that looks configured and
 * syncs nothing is otherwise indistinguishable from a broken integration.
 *
 * "Sync now" is rate-limited server-side (6/hour per workspace; Google's quota is per
 * project, which is the thing being protected), so a 429 is a normal answer here and is shown
 * with its retry hint rather than as a generic failure.
 */

function statusVariant(
  status: MetricSheetConnection["status"],
): "default" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "ok":
      return "default";
    case "failed":
      return "destructive";
    case "syncing":
      return "warning";
    default:
      return "outline";
  }
}

function statusLabel(status: MetricSheetConnection["status"]): string {
  switch (status) {
    case "ok":
      return m.metrics_sync_ok();
    case "failed":
      return m.metrics_sync_failed();
    case "syncing":
      return m.metrics_sync_syncing();
    default:
      return m.metrics_sync_idle();
  }
}

function ConnectionForm({
  definitions,
  connection,
}: {
  definitions: readonly MetricDefinitionView[];
  connection: MetricSheetConnection | null;
}) {
  const base = useId();
  const queryClient = useQueryClient();
  const [spreadsheetId, setSpreadsheetId] = useState(connection?.spreadsheetId ?? "");
  const [range, setRange] = useState(connection?.range ?? "Sheet1!A1:Z1000");
  const [credentialJson, setCredentialJson] = useState("");
  const [mapping, setMapping] = useState<MappingState>(() =>
    initialMapping(definitions, connection?.mapping),
  );
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT("/metrics/sheets", {
          body: {
            spreadsheetId: spreadsheetId.trim(),
            range: range.trim(),
            credentialJson,
            mapping: mappingBody(mapping),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.metrics_sheets_saved());
      setCredentialJson("");
      void queryClient.invalidateQueries({ queryKey: metricSheetsQuery.queryKey });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {connection === null ? m.metrics_sheets_connect() : m.metrics_sheets_reconnect()}
        </CardTitle>
        <CardDescription>{m.metrics_sheets_connect_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {isSourceOverlap(save.error) ? (
            <Alert variant="destructive">
              <AlertTitle>{m.metrics_sheets_overlap_title()}</AlertTitle>
              <AlertDescription>
                <p>{m.metrics_sheets_overlap_body()}</p>
                {overlapKeys(save.error).length > 0 ? (
                  <ul className="list-disc pl-5 font-mono text-xs">
                    {overlapKeys(save.error).map((key) => (
                      <li key={key}>{key}</li>
                    ))}
                  </ul>
                ) : null}
                <p>
                  <Link
                    to="/admin/$"
                    params={{ _splat: "metrics/sources" }}
                    className="underline underline-offset-4"
                  >
                    {m.metrics_sheets_overlap_sources_link()}
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            <ErrorAlert error={save.error} />
          )}
          <Field
            id={`${base}-json`}
            label={m.metrics_sheets_credential()}
            description={m.metrics_sheets_credential_help()}
            required
          >
            <Textarea
              id={`${base}-json`}
              required
              rows={6}
              className="font-mono text-xs"
              value={credentialJson}
              {...fieldAria(`${base}-json`, { description: true })}
              onChange={(e) => setCredentialJson(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              id={`${base}-id`}
              label={m.metrics_sheets_spreadsheet_id()}
              description={m.metrics_sheets_spreadsheet_id_help()}
              required
            >
              <Input
                id={`${base}-id`}
                required
                value={spreadsheetId}
                {...fieldAria(`${base}-id`, { description: true })}
                onChange={(e) => setSpreadsheetId(e.target.value)}
              />
            </Field>
            <Field
              id={`${base}-range`}
              label={m.metrics_sheets_range()}
              description={m.metrics_sheets_range_help()}
              required
            >
              <Input
                id={`${base}-range`}
                required
                value={range}
                {...fieldAria(`${base}-range`, { description: true })}
                onChange={(e) => setRange(e.target.value)}
              />
            </Field>
          </div>
          <MappingFields
            base={base}
            definitions={definitions}
            mapping={mapping}
            onChange={setMapping}
          />
          <Button type="submit" loading={save.isPending}>
            {m.metrics_sheets_save()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ConnectionStatus({ connection }: { connection: MetricSheetConnection }) {
  const queryClient = useQueryClient();
  const sync = useGuardedMutation({
    mutationFn: () => call(api().POST("/metrics/sheets/sync")),
    onSuccess: (result) => {
      toast.success(
        m.metrics_sync_result({
          rows: String(result.rows),
          written: String(result.written),
          restated: String(result.restated),
          review: String(result.needsReview),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
  const disconnect = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/metrics/sheets")),
    onSuccess: () => {
      toast.success(m.metrics_sheets_disconnected());
      void queryClient.invalidateQueries({ queryKey: metricSheetsQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.metrics_sheets_status_title()}</CardTitle>
        <CardDescription>{connection.spreadsheetId}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
         * The address the sheet has to be shared with. First thing on the card, because a
         * connection that is configured but not shared fails with `unauthorized` at 04:35 and
         * the admin never sees it happen.
         */}
        <Alert>
          <Mail aria-hidden="true" />
          <AlertTitle>{m.metrics_sheets_share_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.metrics_sheets_share_body()}</p>
            <p className="font-mono text-sm">{connection.serviceAccountEmail}</p>
          </AlertDescription>
        </Alert>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{m.metrics_col_status()}</dt>
            <dd>
              <Badge variant={statusVariant(connection.status)}>
                {statusLabel(connection.status)}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.metrics_sheets_last_sync()}</dt>
            <dd>
              {connection.lastSyncAt === null
                ? m.metrics_sheets_never_synced()
                : formatDateTime(connection.lastSyncAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.metrics_sheets_range()}</dt>
            <dd className="font-mono text-xs">{connection.range}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.metrics_sheets_failures()}</dt>
            <dd>{connection.consecutiveFailures}</dd>
          </div>
        </dl>
        {connection.lastError === null ? null : (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.metrics_sheets_last_error()}</AlertTitle>
            <AlertDescription>{connection.lastError}</AlertDescription>
          </Alert>
        )}
        {/*
         * 429 is an expected answer, not a fault: the limiter protects Google's per-project
         * quota. `describeError` already turns a `Retry-After` into "try again in N seconds",
         * so the admin is told when, rather than "something went wrong".
         */}
        <ErrorAlert error={sync.error} />
        <div className="flex gap-2">
          <Button type="button" loading={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw aria-hidden="true" />
            {m.metrics_sheets_sync_now()}
          </Button>
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline">
                <Trash2 aria-hidden="true" />
                {m.metrics_sheets_disconnect()}
              </Button>
            }
            title={m.metrics_sheets_disconnect()}
            description={m.metrics_sheets_disconnect_body()}
            confirmLabel={m.metrics_sheets_disconnect()}
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Workspace defaults (`GET`/`PATCH /metrics/settings`). Two fields, and both are only ever
 * defaults: they seed a new metric's currency and the grain the grid opens at. Changing one
 * re-labels nothing already stored — periods are calendar periods canonicalised in UTC and
 * there is deliberately no fiscal-year setting (decision D1), because re-bucketing history
 * after the fact is a retroactive lie about what a number meant.
 */
function DefaultsCard() {
  const settings = useQuery(metricsSettingsQuery);
  const base = useId();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<
    { defaultCurrency: string; defaultPeriodKind: CalendarPeriodKind } | undefined
  >();
  const current = form ?? settings.data;
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/metrics/settings", {
          body: {
            defaultCurrency: (current?.defaultCurrency ?? "USD").toUpperCase(),
            defaultPeriodKind: current?.defaultPeriodKind ?? "month",
          },
        }),
      ),
    onSuccess: (next) => {
      toast.success(m.metrics_settings_saved());
      setForm(undefined);
      queryClient.setQueryData(metricsSettingsQuery.queryKey, next);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.metrics_settings_card_title()}</CardTitle>
        <CardDescription>{m.metrics_settings_card_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {settings.isError ? <ErrorAlert error={settings.error} /> : null}
        {current ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <ErrorAlert error={save.error} />
            <div className="grid gap-3 md:grid-cols-2">
              <Field
                id={`${base}-cur`}
                label={m.metrics_field_currency()}
                description={m.metrics_field_currency_help()}
                required
              >
                <Input
                  id={`${base}-cur`}
                  required
                  pattern="[A-Za-z]{3}"
                  maxLength={3}
                  value={current.defaultCurrency}
                  {...fieldAria(`${base}-cur`, { description: true })}
                  onChange={(e) =>
                    setForm({ ...current, defaultCurrency: e.target.value.toUpperCase() })
                  }
                />
              </Field>
              <Field id={`${base}-kind`} label={m.metrics_field_period_kind()}>
                <NativeSelect
                  id={`${base}-kind`}
                  value={current.defaultPeriodKind}
                  onChange={(e) =>
                    setForm({
                      ...current,
                      defaultPeriodKind: e.target.value as CalendarPeriodKind,
                    })
                  }
                >
                  {CALENDAR_PERIOD_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {periodKindLabel(kind)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Button type="submit" loading={save.isPending}>
              {m.common_save()}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SheetsScreen() {
  const sheets = useQuery(metricSheetsQuery);
  const definitions = useQuery(metricDefinitionsQuery);
  const connection = sheets.data?.connection ?? null;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.metrics_settings_title()}
        description={m.metrics_settings_subtitle()}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/$" params={{ _splat: "metrics" }}>
              <ArrowLeft aria-hidden="true" />
              {m.metrics_back_to_grid()}
            </Link>
          </Button>
        }
      />
      <DefaultsCard />
      <h2 className="text-xl font-semibold tracking-tight">{m.metrics_sheets_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.metrics_sheets_subtitle()}</p>
      {sheets.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {sheets.isError ? <ErrorAlert error={sheets.error} /> : null}
      {sheets.data ? (
        <div className="space-y-6">
          {connection === null ? null : <ConnectionStatus connection={connection} />}
          <ConnectionForm
            definitions={definitions.data?.definitions ?? []}
            connection={connection}
          />
        </div>
      ) : null}
    </div>
  );
}
