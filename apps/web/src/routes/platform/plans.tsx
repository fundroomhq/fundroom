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
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Scale } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  EntitlementsFields,
  entitlementLimits,
  entitlementsDraft,
  type LimitsDraft,
  LimitsFields,
  LimitsList,
  limitsDraft,
  parseLimits,
} from "../../components/platform/common.js";
import { isCode } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import {
  archivePlan,
  createPlan,
  describePlatformError,
  formatCount,
  MAX_METERED_PRICE_REFS,
  PLANS_KEY,
  type Plan,
  type PlanEntitlementCatalog,
  parseMeteredPriceRefs,
  platformPlansQuery,
  updatePlan,
} from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/platform/plans")({ component: PlansPage });

/*
 * Plans (E3.10): what each tier allows. A limit that is not set is unlimited — the form says
 * "Unlimited" with a switch rather than asking for a big number, because the server treats an
 * absent key as no limit and a number as a limit it enforces.
 *
 * Edits are optimistic: the form sends the `version` it was opened with, and a 409
 * `version_conflict` (another operator saved first) keeps what this operator typed on screen and
 * offers to load the newer version — never a silent overwrite.
 *
 * Archiving is one-way here: an archived plan stays on the workspaces that have it but can no
 * longer be assigned or offered at signup.
 *
 * Entitlements (A-3, ADR-0063): the form's Modules and Features fieldsets edit `limits.modules` /
 * `limits.features` (absent = all) from the list response's `entitlementCatalog`. A PATCH replaces
 * the whole `limits` object, so the form always sends both lists as loaded — editing a number
 * never drops them.
 */
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/u;

function PlansPage() {
  const plans = useQuery(platformPlansQuery);
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  // Bumped to re-seed the form from the server's copy (after a version conflict).
  const [formKey, setFormKey] = useState(0);
  const list = plans.data?.plans ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.platform_plans_title()}
        description={m.platform_plans_body()}
        actions={
          editing === null ? (
            <Button type="button" onClick={() => setEditing("new")}>
              <Plus aria-hidden="true" />
              {m.platform_plan_new()}
            </Button>
          ) : null
        }
      />
      {editing === null ? null : (
        <PlanForm
          key={`${editing === "new" ? "new" : editing.id}:${formKey}`}
          plan={editing === "new" ? null : editing}
          catalog={plans.data?.entitlementCatalog}
          onDone={() => setEditing(null)}
          onReload={async () => {
            const fresh = await plans.refetch();
            const latest =
              editing === "new" ? undefined : fresh.data?.plans.find((p) => p.id === editing.id);
            if (latest !== undefined) setEditing(latest);
            setFormKey((k) => k + 1);
          }}
        />
      )}
      {plans.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {plans.isError ? <ErrorAlert error={plans.error} /> : null}
      {plans.data ? (
        list.length === 0 ? (
          <EmptyState
            icon={<Scale />}
            title={m.platform_plans_none_title()}
            description={m.platform_plans_none_body()}
          />
        ) : (
          <Card>
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableCaption className="sr-only">{m.platform_plans_title()}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.platform_col_plan()}</TableHead>
                    <TableHead>{m.platform_plan_limits()}</TableHead>
                    <TableHead>{m.platform_plan_terms()}</TableHead>
                    <TableHead className="text-right">{m.platform_nav_workspaces()}</TableHead>
                    <TableHead>{m.common_actions()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((plan) => (
                    <PlanRow key={plan.id} plan={plan} onEdit={() => setEditing(plan)} />
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

function PlanRow({ plan, onEdit }: { plan: Plan; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () => archivePlan(plan.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLANS_KEY });
      toast.success(m.platform_plan_archived_toast({ name: plan.name }));
    },
    onError: (error) => toast.error(describePlatformError(error)),
  });
  const archived = plan.archivedAt !== null;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{plan.name}</div>
        <div className="font-mono text-xs text-muted-foreground">{plan.id}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {plan.public ? <Badge variant="secondary">{m.platform_plan_public()}</Badge> : null}
          {archived ? (
            <Badge variant="outline">
              {m.platform_plan_archived_on({ when: formatDate(plan.archivedAt ?? "") })}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <LimitsList limits={plan.limits} />
      </TableCell>
      <TableCell className="align-top text-sm">
        <div>{m.platform_plan_trial_days_value({ days: plan.trialDays })}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {plan.billingPriceRef ?? m.platform_plan_no_price()}
        </div>
        {plan.billingMeteredPriceRefs.length === 0 ? null : (
          <div className="text-xs text-muted-foreground">
            {m.platform_plan_metered_label()}{" "}
            <span className="font-mono break-all">{plan.billingMeteredPriceRefs.join(", ")}</span>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right align-top">{formatCount(plan.workspaces)}</TableCell>
      <TableCell className="align-top">
        {archived ? null : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              {m.platform_plan_edit_named({ name: plan.name })}
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="ghost" size="sm" disabled={archive.isPending}>
                  {m.platform_plan_archive_named({ name: plan.name })}
                </Button>
              }
              title={m.platform_plan_archive_title({ name: plan.name })}
              description={m.platform_plan_archive_body()}
              confirmLabel={m.platform_plan_archive()}
              onConfirm={() => archive.mutate()}
              pending={archive.isPending}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function PlanForm({
  plan,
  catalog,
  onDone,
  onReload,
}: {
  plan: Plan | null;
  catalog: PlanEntitlementCatalog | undefined;
  onDone: () => void;
  onReload: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const idId = useId();
  const nameId = useId();
  const priceId = useId();
  const trialId = useId();
  const meteredId = useId();
  const [id, setId] = useState(plan?.id ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [price, setPrice] = useState(plan?.billingPriceRef ?? "");
  const [metered, setMetered] = useState((plan?.billingMeteredPriceRefs ?? []).join("\n"));
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 0));
  const [isPublic, setIsPublic] = useState(plan?.public ?? false);
  const [limits, setLimits] = useState<LimitsDraft>(limitsDraft(plan?.limits ?? {}));
  const [entitlements, setEntitlements] = useState(() => entitlementsDraft(plan?.limits ?? {}));
  const [submitted, setSubmitted] = useState(false);
  const trial = Number(trialDays);
  const idInvalid = plan === null && !PLAN_ID_RE.test(id);
  const nameInvalid = name.trim() === "";
  const trialInvalid = !Number.isInteger(trial) || trial < 0 || trial > 90 || trialDays === "";
  const meteredParsed = parseMeteredPriceRefs(metered);
  const meteredError = meteredParsed.ok
    ? undefined
    : meteredParsed.reason === "too_many"
      ? m.platform_plan_metered_too_many({ max: MAX_METERED_PRICE_REFS })
      : meteredParsed.reason === "duplicate"
        ? m.platform_plan_metered_duplicate()
        : m.platform_plan_metered_too_long();
  const save = useMutation({
    mutationFn: () => {
      const parsed = parseLimits(limits);
      if (parsed === undefined) throw new Error("invalid limits");
      const body = {
        name: name.trim(),
        limits: { ...parsed, ...entitlementLimits(entitlements, catalog) },
        billingPriceRef: price.trim() === "" ? null : price.trim(),
        billingMeteredPriceRefs: meteredParsed.ok ? meteredParsed.refs : [],
        trialDays: trial,
        public: isPublic,
      };
      return plan === null
        ? createPlan({ id, ...body })
        : updatePlan(plan.id, { ...body, version: plan.version });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: PLANS_KEY });
      toast.success(
        plan === null
          ? m.platform_plan_created_toast({ name: saved.name })
          : m.platform_plan_saved_toast({ name: saved.name }),
      );
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (
      idInvalid ||
      nameInvalid ||
      trialInvalid ||
      meteredError !== undefined ||
      parseLimits(limits) === undefined
    )
      return;
    save.mutate();
  };
  const conflict = save.isError && isCode(save.error, "version_conflict");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {plan === null ? m.platform_plan_new() : m.platform_plan_edit_title({ name: plan.name })}
        </CardTitle>
        <CardDescription>{m.platform_plan_form_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {plan === null ? (
            <Field
              id={idId}
              label={m.platform_plan_id()}
              description={m.platform_plan_id_help()}
              error={submitted && idInvalid ? m.platform_plan_id_invalid() : undefined}
              required
            >
              <Input
                id={idId}
                value={id}
                autoComplete="off"
                className="font-mono"
                onChange={(e) => setId(e.target.value)}
                {...fieldAria(idId, { description: true, error: submitted && idInvalid })}
              />
            </Field>
          ) : null}
          <Field
            id={nameId}
            label={m.common_name()}
            error={submitted && nameInvalid ? m.platform_plan_name_invalid() : undefined}
            required
          >
            <Input
              id={nameId}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              {...fieldAria(nameId, { error: submitted && nameInvalid })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={trialId}
              label={m.platform_plan_trial_days()}
              error={submitted && trialInvalid ? m.platform_plan_trial_invalid() : undefined}
            >
              <Input
                id={trialId}
                type="number"
                min={0}
                max={90}
                step={1}
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                {...fieldAria(trialId, { error: submitted && trialInvalid })}
              />
            </Field>
            <Field
              id={priceId}
              label={m.platform_plan_price()}
              description={m.platform_plan_price_help()}
            >
              <Input
                id={priceId}
                value={price}
                maxLength={255}
                autoComplete="off"
                className="font-mono"
                onChange={(e) => setPrice(e.target.value)}
                {...fieldAria(priceId, { description: true })}
              />
            </Field>
          </div>
          <Field
            id={meteredId}
            label={m.platform_plan_metered()}
            description={m.platform_plan_metered_help()}
            error={submitted ? meteredError : undefined}
          >
            <Textarea
              id={meteredId}
              value={metered}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(e) => setMetered(e.target.value)}
              {...fieldAria(meteredId, {
                description: true,
                error: submitted && meteredError !== undefined,
              })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            {m.platform_plan_public_label()}
          </label>
          <LimitsFields draft={limits} onChange={setLimits} showErrors={submitted} />
          <EntitlementsFields draft={entitlements} catalog={catalog} onChange={setEntitlements} />
          {conflict ? (
            <Alert variant="warning" role="alert">
              <AlertTitle>{m.platform_plan_conflict_title()}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{describePlatformError(save.error)}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void onReload()}>
                  {m.platform_plan_conflict_reload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : save.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{describePlatformError(save.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>
              {plan === null ? m.platform_plan_create() : m.common_save()}
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              {m.common_cancel()}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
