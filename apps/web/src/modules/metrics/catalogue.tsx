import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, describeError } from "../../lib/api.js";
import {
  AGGREGATIONS,
  DIRECTIONS,
  type MetricAudience,
  type MetricDefinitionView,
  metricDefinitionsQuery,
  PERIOD_KINDS,
  UNIT_KINDS,
} from "../../lib/metrics-queries.js";
import { groupsQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { aggregationLabel, directionLabel, periodKindLabel, unitLabel } from "./format.js";

/*
 * The metric catalogue (E2.4 §9): what a workspace measures, and who may see each one.
 *
 * `audience` is the whole of the per-metric gating (decision D2) — a metric is not something
 * an investor requests access to, it is a number shown or not shown, so it is a stored
 * audience rather than a grant. The default is the closed one, `staff_only`: a definition is
 * created long before anybody decides who may see it, and a number nobody has chosen to
 * publish is not published.
 *
 * Deleting is a step-up route. `useGuardedMutation` sends the caller to `/auth/step-up` when
 * the server asks for a fresher session, so there is nothing to special-case here.
 */

interface DefinitionForm {
  key: string;
  name: string;
  description: string;
  unit: MetricDefinitionView["unit"];
  currency: string;
  aggregation: MetricDefinitionView["aggregation"];
  direction: MetricDefinitionView["direction"];
  periodKind: MetricDefinitionView["periodKind"];
  decimals: string;
  audience: MetricAudience;
}

function formOf(definition?: MetricDefinitionView): DefinitionForm {
  return {
    key: definition?.key ?? "",
    name: definition?.name ?? "",
    description: definition?.description ?? "",
    unit: definition?.unit ?? "count",
    currency: definition?.currency ?? "USD",
    aggregation: definition?.aggregation ?? "last",
    direction: definition?.direction ?? "up_good",
    periodKind: definition?.periodKind ?? "month",
    decimals: String(definition?.decimals ?? 0),
    audience: definition?.audience ?? { kind: "staff_only" },
  };
}

export function audienceLabel(
  audience: MetricAudience,
  groups?: readonly { id: string; name: string }[],
): string {
  switch (audience.kind) {
    case "all":
      return m.metrics_audience_all();
    case "groups": {
      const names = audience.groupIds.map((id) => groups?.find((g) => g.id === id)?.name ?? "…");
      return m.metrics_audience_groups({ groups: names.join(", ") });
    }
    default:
      return m.metrics_audience_staff_only();
  }
}

function AudienceEditor({
  id,
  audience,
  onChange,
}: {
  id: string;
  audience: MetricAudience;
  onChange: (audience: MetricAudience) => void;
}) {
  const groups = useQuery(groupsQuery);
  const groupIds = audience.kind === "groups" ? audience.groupIds : [];
  return (
    <div className="space-y-2">
      <Field
        id={id}
        label={m.metrics_field_audience()}
        description={m.metrics_field_audience_help()}
      >
        <NativeSelect
          id={id}
          value={audience.kind}
          {...fieldAria(id, { description: true })}
          onChange={(e) => {
            const kind = e.target.value;
            onChange(
              kind === "all"
                ? { kind: "all" }
                : kind === "groups"
                  ? { kind: "groups", groupIds }
                  : { kind: "staff_only" },
            );
          }}
        >
          <option value="staff_only">{m.metrics_audience_staff_only()}</option>
          <option value="all">{m.metrics_audience_all_option()}</option>
          <option value="groups">{m.metrics_audience_groups_option()}</option>
        </NativeSelect>
      </Field>
      {audience.kind === "groups" ? (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{m.metrics_field_groups()}</legend>
          {(groups.data?.groups ?? []).map((group) => (
            <label key={group.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={groupIds.includes(group.id)}
                onChange={(e) =>
                  onChange({
                    kind: "groups",
                    groupIds: e.target.checked
                      ? [...groupIds, group.id]
                      : groupIds.filter((x) => x !== group.id),
                  })
                }
              />
              {group.name}
            </label>
          ))}
          {/* An empty `groups` audience admits nobody, and the server refuses it outright. */}
          {groupIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.metrics_audience_groups_empty()}</p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

function DefinitionFields({
  form,
  setForm,
  base,
  isNew,
}: {
  form: DefinitionForm;
  setForm: (form: DefinitionForm) => void;
  base: string;
  isNew: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${base}-name`} label={m.metrics_field_name()} required>
          <Input
            id={`${base}-name`}
            required
            maxLength={120}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field
          id={`${base}-key`}
          label={m.metrics_field_key()}
          description={m.metrics_field_key_help()}
          required
        >
          <Input
            id={`${base}-key`}
            required
            readOnly={!isNew}
            pattern="[a-z][a-z0-9_]*"
            maxLength={63}
            value={form.key}
            {...fieldAria(`${base}-key`, { description: true })}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
          />
        </Field>
      </div>
      <Field id={`${base}-desc`} label={m.metrics_field_description()}>
        <Textarea
          id={`${base}-desc`}
          rows={2}
          maxLength={2000}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${base}-unit`} label={m.metrics_field_unit()}>
          <NativeSelect
            id={`${base}-unit`}
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value as DefinitionForm["unit"] })}
          >
            {UNIT_KINDS.map((unit) => (
              <option key={unit} value={unit}>
                {unitLabel(unit)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {form.unit === "currency" ? (
          <Field
            id={`${base}-cur`}
            label={m.metrics_field_currency()}
            description={m.metrics_field_currency_help()}
            required
          >
            <Input
              id={`${base}-cur`}
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={form.currency}
              {...fieldAria(`${base}-cur`, { description: true })}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            />
          </Field>
        ) : null}
        <Field
          id={`${base}-agg`}
          label={m.metrics_field_aggregation()}
          description={m.metrics_field_aggregation_help()}
        >
          <NativeSelect
            id={`${base}-agg`}
            value={form.aggregation}
            {...fieldAria(`${base}-agg`, { description: true })}
            onChange={(e) =>
              setForm({ ...form, aggregation: e.target.value as DefinitionForm["aggregation"] })
            }
          >
            {AGGREGATIONS.map((a) => (
              <option key={a} value={a}>
                {aggregationLabel(a)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          id={`${base}-dir`}
          label={m.metrics_field_direction()}
          description={m.metrics_field_direction_help()}
        >
          <NativeSelect
            id={`${base}-dir`}
            value={form.direction}
            {...fieldAria(`${base}-dir`, { description: true })}
            onChange={(e) =>
              setForm({ ...form, direction: e.target.value as DefinitionForm["direction"] })
            }
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {directionLabel(d)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id={`${base}-per`} label={m.metrics_field_period_kind()}>
          <NativeSelect
            id={`${base}-per`}
            value={form.periodKind}
            onChange={(e) =>
              setForm({ ...form, periodKind: e.target.value as DefinitionForm["periodKind"] })
            }
          >
            {PERIOD_KINDS.map((p) => (
              <option key={p} value={p}>
                {periodKindLabel(p)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id={`${base}-dec`} label={m.metrics_field_decimals()}>
          <Input
            id={`${base}-dec`}
            type="number"
            inputMode="numeric"
            min={0}
            max={6}
            value={form.decimals}
            onChange={(e) => setForm({ ...form, decimals: e.target.value })}
          />
        </Field>
      </div>
      <AudienceEditor
        id={`${base}-aud`}
        audience={form.audience}
        onChange={(audience) => setForm({ ...form, audience })}
      />
    </div>
  );
}

function bodyOf(form: DefinitionForm) {
  return {
    name: form.name.trim(),
    description: form.description.trim() === "" ? null : form.description.trim(),
    unit: form.unit,
    // The column CHECKs that `currency` is non-null exactly when the unit is `currency`.
    currency: form.unit === "currency" ? form.currency.trim().toUpperCase() : null,
    aggregation: form.aggregation,
    direction: form.direction,
    periodKind: form.periodKind,
    decimals: Number(form.decimals) || 0,
    audience: form.audience,
  };
}

function NewDefinitionDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DefinitionForm>(formOf());
  const base = useId();
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () => {
      // `POST` takes `description?`/`currency?` as absent-or-present, not nullable; `PATCH`
      // takes them as nullable. `exactOptionalPropertyTypes` makes the difference load-bearing.
      const { currency, description, ...rest } = bodyOf(form);
      return call(
        api().POST("/metrics/definitions", {
          body: {
            ...rest,
            key: form.key.trim(),
            ...(currency === null ? {} : { currency }),
            ...(description === null ? {} : { description }),
          },
        }),
      );
    },
    onSuccess: () => {
      toast.success(m.metrics_definition_created());
      setOpen(false);
      setForm(formOf());
      void queryClient.invalidateQueries({ queryKey: metricDefinitionsQuery.queryKey });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.metrics_new_definition()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.metrics_new_definition()}</DialogTitle>
            <DialogDescription>{m.metrics_new_definition_body()}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={create.error} />
          <DefinitionFields form={form} setForm={setForm} base={base} isNew />
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              {m.metrics_create_definition()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDefinitionDialog({ definition }: { definition: MetricDefinitionView }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DefinitionForm>(formOf(definition));
  const base = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/metrics/definitions/{id}", {
          params: { path: { id: definition.id } },
          body: bodyOf(form),
        }),
      ),
    onSuccess: () => {
      toast.success(m.metrics_definition_saved());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: metricDefinitionsQuery.queryKey });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setForm(formOf(definition));
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={m.metrics_edit_definition({ name: definition.name })}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.metrics_edit_definition({ name: definition.name })}</DialogTitle>
            <DialogDescription>{m.metrics_edit_definition_body()}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={save.error} />
          <DefinitionFields form={form} setForm={setForm} base={base} isNew={false} />
          <DialogFooter>
            <Button type="submit" loading={save.isPending}>
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDefinitionButton({ definition }: { definition: MetricDefinitionView }) {
  const queryClient = useQueryClient();
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/metrics/definitions/{id}", { params: { path: { id: definition.id } } })),
    onSuccess: () => {
      toast.success(m.metrics_definition_deleted());
      void queryClient.invalidateQueries({ queryKey: metricDefinitionsQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={m.metrics_delete_definition({ name: definition.name })}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      }
      title={m.metrics_delete_definition({ name: definition.name })}
      description={m.metrics_delete_definition_body()}
      confirmLabel={m.metrics_delete_confirm()}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}

export function CatalogueScreen({ canManage }: { canManage: boolean }) {
  const definitions = useQuery(metricDefinitionsQuery);
  const groups = useQuery(groupsQuery);
  const rows = definitions.data?.definitions ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.metrics_catalogue_title()}
        description={m.metrics_catalogue_subtitle()}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: "metrics" }}>
                <ArrowLeft aria-hidden="true" />
                {m.metrics_back_to_grid()}
              </Link>
            </Button>
            {canManage ? <NewDefinitionDialog /> : null}
          </div>
        }
      />
      {definitions.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {definitions.isError ? <ErrorAlert error={definitions.error} /> : null}
      {definitions.data ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.metrics_catalogue_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.metrics_col_name()}</TableHead>
                <TableHead>{m.metrics_col_key()}</TableHead>
                <TableHead>{m.metrics_col_unit()}</TableHead>
                <TableHead>{m.metrics_col_period()}</TableHead>
                <TableHead>{m.metrics_col_direction()}</TableHead>
                <TableHead>{m.metrics_col_audience()}</TableHead>
                {canManage ? <TableHead>{m.common_actions()}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((definition) => (
                <TableRow key={definition.id}>
                  <TableCell className="font-medium">{definition.name}</TableCell>
                  <TableCell className="font-mono text-xs">{definition.key}</TableCell>
                  <TableCell>
                    {unitLabel(definition.unit)}
                    {definition.currency === null ? "" : ` (${definition.currency})`}
                  </TableCell>
                  <TableCell>{periodKindLabel(definition.periodKind)}</TableCell>
                  <TableCell>{directionLabel(definition.direction)}</TableCell>
                  <TableCell>
                    <Badge variant={definition.audience.kind === "all" ? "default" : "outline"}>
                      {audienceLabel(definition.audience, groups.data?.groups)}
                    </Badge>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex gap-1">
                        <EditDefinitionDialog definition={definition} />
                        <DeleteDefinitionButton definition={definition} />
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}
