import { Field, fieldAria, Input } from "@fundroomhq/ui";
import { NativeSelect } from "../../components/compliance/common.js";
import {
  CALENDAR_PERIOD_KINDS,
  type CalendarPeriodKind,
  type MetricCsvMapping,
  type MetricDefinitionView,
} from "../../lib/metrics-queries.js";
import { m } from "../../paraglide/messages.js";
import { periodKindLabel } from "./format.js";

/*
 * The column mapping a tabular import needs (E2.4 §9's `MetricCsvMapping`): which column holds
 * the period, what grain those periods are, and which column feeds which metric. Shared by the
 * CSV dialog and the Sheets connection because they read the same rows out of the same kind of
 * export and the server takes the same shape for both.
 *
 * Column names are compared after the server's `normalizeHeaderCell` — `trim()`, lowercase,
 * runs of whitespace to `_` — which is also what the CSV preview echoes back, so an admin who
 * typed "Net Burn" and sees `net_burn` in the preview is looking at the same thing.
 */
export interface MappingState {
  periodColumn: string;
  periodKind: CalendarPeriodKind;
  /** definition key → CSV column name. Empty means "this metric is not in the file". */
  columns: Record<string, string>;
}

export function initialMapping(
  definitions: readonly MetricDefinitionView[],
  from?: MetricCsvMapping | undefined,
): MappingState {
  const columns: Record<string, string> = {};
  for (const definition of definitions) {
    // A founder's export usually names the column after the metric, so the key is the default
    // guess — it is only a guess, and every row is editable.
    columns[definition.key] =
      from?.columns.find((c) => c.key === definition.key)?.column ?? definition.key;
  }
  const kind = from?.periodKind;
  return {
    periodColumn: from?.periodColumn ?? "period",
    periodKind: kind === "month" || kind === "quarter" || kind === "year" ? kind : "month",
    columns,
  };
}

export function mappingBody(mapping: MappingState): MetricCsvMapping {
  return {
    periodColumn: mapping.periodColumn.trim(),
    periodKind: mapping.periodKind,
    columns: Object.entries(mapping.columns)
      .filter(([, column]) => column.trim() !== "")
      .map(([key, column]) => ({ key, column: column.trim() })),
  };
}

export function MappingFields({
  base,
  definitions,
  mapping,
  onChange,
}: {
  base: string;
  definitions: readonly MetricDefinitionView[];
  mapping: MappingState;
  onChange: (mapping: MappingState) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{m.metrics_csv_mapping_legend()}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          id={`${base}-period`}
          label={m.metrics_csv_period_column()}
          description={m.metrics_csv_period_column_help()}
          required
        >
          <Input
            id={`${base}-period`}
            required
            value={mapping.periodColumn}
            {...fieldAria(`${base}-period`, { description: true })}
            onChange={(e) => onChange({ ...mapping, periodColumn: e.target.value })}
          />
        </Field>
        <Field id={`${base}-kind`} label={m.metrics_csv_period_kind()}>
          <NativeSelect
            id={`${base}-kind`}
            value={mapping.periodKind}
            onChange={(e) =>
              onChange({ ...mapping, periodKind: e.target.value as CalendarPeriodKind })
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
      <div className="grid gap-3 md:grid-cols-2">
        {definitions.map((definition) => (
          <Field
            key={definition.id}
            id={`${base}-col-${definition.id}`}
            label={m.metrics_csv_column_for({ metric: definition.name })}
          >
            <Input
              id={`${base}-col-${definition.id}`}
              value={mapping.columns[definition.key] ?? ""}
              placeholder={m.metrics_csv_column_none()}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  columns: { ...mapping.columns, [definition.key]: e.target.value },
                })
              }
            />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}
