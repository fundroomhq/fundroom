import {
  Badge,
  Button,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plug, Settings, Table2 } from "lucide-react";
import { useId, useState } from "react";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call } from "../../lib/api.js";
import {
  CALENDAR_PERIOD_KINDS,
  type CalendarPeriodKind,
  type MetricDefinitionView,
  type MetricGrid,
  type MetricGridCell,
  metricGridQuery,
} from "../../lib/metrics-queries.js";
import { useBootstrap } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";
import { CatalogueScreen } from "./catalogue.js";
import { MetricsCsvImportDialog } from "./csv-import.js";
import { periodKeyLabel, periodKindLabel } from "./format.js";
import { RevisionHistoryDialog } from "./history.js";
import { SheetsScreen } from "./sheets.js";
import { KpiSourcesScreen } from "./sources.js";

/*
 * KPIs, staff side (E2.4). `/admin/metrics` is the **period grid** — metrics down, periods
 * across, one numeric input per cell — with `/admin/metrics/catalogue` for the definitions,
 * `/admin/metrics/sheets` for the Google Sheets connection and `/admin/metrics/sources` for the
 * KPI-source bindings to QuickBooks, Xero and Stripe (E3.6).
 *
 * The grid is the screen this epic exists for, and three of §9's rules live in it:
 *
 *  - **an empty cell means "no point", never zero.** A month nobody has a figure for and a
 *    month whose figure is genuinely 0 are different facts, and conflating them puts a lie in
 *    a chart. A blank cell is simply not sent.
 *  - **a cell that has not changed writes nothing.** `metrics.point` is append-only, so a
 *    re-save that wrote every cell again would turn a stray keystroke into a restatement
 *    storm across the whole history.
 *  - **a changed cell is a restatement**, and the admin is told so *before* they save — with
 *    the count in a live region and the word "Restates" in the cell itself, not only a colour.
 *
 * `needs_review` cells are shown distinctly for a different reason: those are values a Sheets
 * sync found different from something a person had typed. The sync wrote the new revision
 * (never silently overwriting the old one) and flagged it; a human is being asked to look.
 */

export default function MetricsAdmin({ splat }: ModulePageProps) {
  const [head] = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const can = {
    manage: permissions.includes("metrics.manage"),
    settings: permissions.includes("metrics.settings"),
  };
  if (head === "catalogue") return <CatalogueScreen canManage={can.manage} />;
  if (head === "sheets") return <SheetsScreen />;
  if (head === "sources") return <KpiSourcesScreen canManage={can.manage} />;
  return <GridScreen can={can} />;
}

const cellKey = (definitionId: string, periodKey: string): string =>
  `${definitionId}::${periodKey}`;

/**
 * Compares two decimal *strings* without ever making a float of them. `numeric(20, 6)` does
 * not survive a round trip through a double (§5) and this comparison is exactly what decides
 * whether a published figure gets restated, so `Number()` must not appear in it: `1250000`
 * and `1250000.000000` are the same number and must compare equal, and two values that differ
 * in the seventh decimal must not.
 */
export function canonicalDecimal(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/u.exec(trimmed);
  if (match === null) return trimmed;
  const sign = match[1] === "-" ? "-" : "";
  const whole = (match[2] ?? "").replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  const digits = `${whole === "" ? "0" : whole}${fraction === "" ? "" : `.${fraction}`}`;
  // `-0` is `0`: a sign on nothing is not a different number.
  return digits === "0" ? "0" : `${sign}${digits}`;
}

/** What the server stored, spelled the way a person would type it back. */
function displayValue(cell: MetricGridCell | undefined): string {
  return cell === undefined ? "" : canonicalDecimal(cell.value);
}

type CellState = "empty" | "unchanged" | "new" | "restated" | "withdrawn";

function stateOf(draft: string | undefined, cell: MetricGridCell | undefined): CellState {
  if (draft === undefined) return cell === undefined ? "empty" : "unchanged";
  const typed = canonicalDecimal(draft);
  if (typed === "") return cell === undefined ? "empty" : "withdrawn";
  if (cell === undefined) return "new";
  return typed === canonicalDecimal(cell.value) ? "unchanged" : "restated";
}

function GridToolbar({
  periodKind,
  periods,
  onPeriodKind,
  onPeriods,
}: {
  periodKind: CalendarPeriodKind;
  periods: number;
  onPeriodKind: (kind: CalendarPeriodKind) => void;
  onPeriods: (n: number) => void;
}) {
  const kindId = useId();
  const countId = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <label htmlFor={kindId} className="text-sm font-medium">
          {m.metrics_grid_period_kind()}
        </label>
        <NativeSelect
          id={kindId}
          value={periodKind}
          className="w-40"
          onChange={(e) => onPeriodKind(e.target.value as CalendarPeriodKind)}
        >
          {CALENDAR_PERIOD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {periodKindLabel(kind)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <label htmlFor={countId} className="text-sm font-medium">
          {m.metrics_grid_period_count()}
        </label>
        <NativeSelect
          id={countId}
          value={String(periods)}
          className="w-28"
          onChange={(e) => onPeriods(Number(e.target.value))}
        >
          {[6, 12, 24, 36].map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

function GridCell({
  definition,
  period,
  cell,
  draft,
  canManage,
  onChange,
}: {
  definition: MetricDefinitionView;
  period: MetricGrid["periods"][number];
  cell: MetricGridCell | undefined;
  draft: string | undefined;
  canManage: boolean;
  onChange: (value: string) => void;
}) {
  const state = stateOf(draft, cell);
  const value = draft ?? displayValue(cell);
  return (
    <TableCell className="align-top">
      <div className="flex items-start gap-1">
        {canManage ? (
          <Input
            type="text"
            inputMode="decimal"
            // A data table's row and column headers do not name a control for assistive
            // technology, so every cell says which metric and which period it is.
            aria-label={m.metrics_cell_label({
              metric: definition.name,
              period: periodKeyLabel(period.key, period.label),
            })}
            className="h-8 w-28 text-right tabular-nums"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <span className="tabular-nums">{value === "" ? m.metrics_no_value() : value}</span>
        )}
        {cell === undefined ? null : (
          <RevisionHistoryDialog
            definition={definition}
            periodKey={period.key}
            periodLabel={periodKeyLabel(period.key, period.label)}
          />
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {/* Words, not only colours: a restatement is spelled out in the cell that would make
            one, and `needs_review` says what it is rather than merely looking different. */}
        {state === "restated" ? <Badge variant="warning">{m.metrics_cell_restates()}</Badge> : null}
        {state === "new" ? <Badge variant="secondary">{m.metrics_cell_new()}</Badge> : null}
        {state === "withdrawn" ? (
          <span className="text-xs text-muted-foreground">{m.metrics_cell_cannot_withdraw()}</span>
        ) : null}
        {cell?.needsReview ? <Badge variant="destructive">{m.metrics_needs_review()}</Badge> : null}
      </div>
    </TableCell>
  );
}

function GridScreen({ can }: { can: { manage: boolean; settings: boolean } }) {
  const [periodKind, setPeriodKind] = useState<CalendarPeriodKind>("month");
  const [periods, setPeriods] = useState(12);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const grid = useQuery(metricGridQuery(periodKind, periods));
  const queryClient = useQueryClient();

  const definitions = grid.data?.definitions ?? [];
  const columns = grid.data?.periods ?? [];
  const cells = new Map<string, MetricGridCell>();
  for (const cell of grid.data?.cells ?? [])
    cells.set(cellKey(cell.definitionId, cell.periodKey), cell);

  const pending = Object.entries(draft).flatMap(([key, value]) => {
    const [definitionId = "", periodKey = ""] = key.split("::");
    const state = stateOf(value, cells.get(key));
    return state === "new" || state === "restated"
      ? [{ definitionId, periodKey, value: canonicalDecimal(value), state }]
      : [];
  });
  const restatements = pending.filter((p) => p.state === "restated").length;
  const withdrawn = Object.entries(draft).filter(
    ([key, value]) => stateOf(value, cells.get(key)) === "withdrawn",
  ).length;
  const reviews = (grid.data?.cells ?? []).filter((c) => c.needsReview).length;

  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT("/metrics/grid", {
          body: {
            periodKind,
            // Only the cells that would actually change anything. An unchanged cell is not
            // sent at all, and a blank cell is not sent as a zero — see the header comment.
            cells: pending.map(({ definitionId, periodKey, value }) => ({
              definitionId,
              periodKey,
              value,
            })),
          },
        }),
      ),
    onSuccess: (result) => {
      toast.success(
        m.metrics_grid_saved({
          written: String(result.written),
          restated: String(result.restated),
          unchanged: String(result.unchanged),
        }),
      );
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ["metrics"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.metrics_admin_title()}
        description={m.metrics_admin_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: "metrics/catalogue" }}>
                <Table2 aria-hidden="true" />
                {m.metrics_catalogue_link()}
              </Link>
            </Button>
            {can.settings ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "metrics/sheets" }}>
                  <Settings aria-hidden="true" />
                  {m.metrics_settings_link()}
                </Link>
              </Button>
            ) : null}
            {can.settings ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "metrics/sources" }}>
                  <Plug aria-hidden="true" />
                  {m.metrics_kpi_link()}
                </Link>
              </Button>
            ) : null}
            {can.manage && definitions.length > 0 ? (
              <MetricsCsvImportDialog definitions={definitions} />
            ) : null}
          </div>
        }
      />
      <GridToolbar
        periodKind={periodKind}
        periods={periods}
        onPeriodKind={(kind) => {
          setPeriodKind(kind);
          setDraft({});
        }}
        onPeriods={(n) => {
          setPeriods(n);
          setDraft({});
        }}
      />
      {grid.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {grid.isError ? <ErrorAlert error={grid.error} /> : null}
      <ErrorAlert error={save.error} />
      {grid.data ? (
        definitions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.metrics_grid_empty()}</p>
        ) : (
          <>
            {reviews > 0 ? (
              <p className="text-sm" role="status">
                {m.metrics_grid_needs_review({ count: String(reviews) })}
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{m.metrics_col_name()}</TableHead>
                    {columns.map((period) => (
                      <TableHead key={period.key} scope="col">
                        {periodKeyLabel(period.key, period.label)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {definitions.map((definition) => (
                    <TableRow key={definition.id}>
                      <TableHead scope="row" className="font-medium">
                        {definition.name}
                      </TableHead>
                      {columns.map((period) => (
                        <GridCell
                          key={period.key}
                          definition={definition}
                          period={period}
                          cell={cells.get(cellKey(definition.id, period.key))}
                          draft={draft[cellKey(definition.id, period.key)]}
                          canManage={can.manage}
                          onChange={(value) =>
                            setDraft((d) => ({
                              ...d,
                              [cellKey(definition.id, period.key)]: value,
                            }))
                          }
                        />
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {can.manage ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  loading={save.isPending}
                  disabled={pending.length === 0}
                  onClick={() => save.mutate()}
                >
                  {m.metrics_grid_save({ count: String(pending.length) })}
                </Button>
                <p className="text-sm" role="status">
                  {restatements === 0
                    ? m.metrics_grid_no_restatements({ count: String(pending.length) })
                    : m.metrics_grid_restatement_warning({ count: String(restatements) })}
                </p>
                {withdrawn > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {m.metrics_grid_withdraw_note({ count: String(withdrawn) })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
