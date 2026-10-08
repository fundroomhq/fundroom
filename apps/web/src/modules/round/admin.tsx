import type { Allocation, InstrumentKind, RoundStage, Terms } from "@fundroom/round-terms";
import { INSTRUMENT_KINDS, ROUND_STAGES } from "@fundroom/round-terms";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
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
import {
  ArrowLeft,
  Download,
  PieChart,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { call, describeError, isApiError, isCode } from "../../lib/api.js";
import { formatDate, formatDateTime } from "../../lib/format.js";
import { useBootstrap } from "../../lib/queries.js";
import {
  api,
  type ClosingTask,
  COMMITMENT_STATUSES,
  type Commitment,
  type CommitmentStatus,
  INTEREST_STATUSES,
  type InterestDecision,
  type InterestStatus,
  type InterestSubmission,
  type Round,
  type RoundCounters,
  type RoundSettings,
  roundClosingTasksQuery,
  roundCommitmentsQuery,
  roundDetailQuery,
  roundExportHref,
  roundInterestQueueQuery,
  roundSettingsQuery,
  roundsQuery,
  roundVerificationsQuery,
  type TermsRevision,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  type Verification,
  type VerificationMethod,
  type VerificationStatus,
  verificationEvidenceHref,
} from "../../lib/round-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";
import { AllocationTracker } from "./allocation.js";
import { ClosingSettingsCard, ClosingTab } from "./closing-admin.js";
import {
  commitmentStatusLabel,
  commitmentStatusVariant,
  formatMoney,
  instrumentLabel,
  interestStatusLabel,
  interestStatusVariant,
  methodLabel,
  pathLabel,
  roundStatusLabel,
  stageLabel,
  subjectLabel,
  verificationStatusLabel,
  verificationStatusVariant,
} from "./format.js";
import { TermsList } from "./terms.js";

/*
 * The round, staff side (E2.5 §W). `/admin/round` is the list; `/admin/round/rounds/<id>/<tab>`
 * is one round; `/admin/round/verifications` is the accreditation queue and
 * `/admin/round/settings` the module's own two settings.
 *
 * Three house rules show up repeatedly below:
 *
 *  - **terms are superseded, never edited** (§D3). The terms form always writes a new revision
 *    and the history table below it keeps every one, so "what were the terms when she
 *    subscribed?" has an answer.
 *  - **a verification cannot be marked verified without evidence** (design/04 R7). The server
 *    refuses it; this screen refuses it too, and says which kind of evidence the chosen method
 *    needs, so the refusal is not a surprise arriving after the dialog closes.
 *  - **the >35 non-accredited count warns and never blocks** (§D7) — see `allocation.tsx`.
 *
 * The export is a plain anchor rather than a fetch: it is step-up-gated and returns `text/csv`,
 * and letting the browser handle the download is both simpler and the only way the step-up
 * redirect lands somewhere a person can act on.
 */

const DETAIL_TABS = ["overview", "terms", "interest", "commitments", "closing"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

interface Can {
  readonly manage: boolean;
  readonly publish: boolean;
  readonly settings: boolean;
  /** E3.5: may read the e-sign connection (to say "no vendor connected" on the closing tab). */
  readonly esignRead: boolean;
  /** E3.7: may open the accreditation vendor screen (linked from the verification queue). */
  readonly accreditationRead: boolean;
}

function tabLabel(tab: DetailTab): string {
  switch (tab) {
    case "overview":
      return m.round_tab_overview();
    case "terms":
      return m.round_tab_terms();
    case "interest":
      return m.round_tab_interest();
    case "commitments":
      return m.round_tab_commitments();
    default:
      return m.round_tab_closing();
  }
}

function roundStatusVariant(status: string): "success" | "secondary" | "outline" {
  return status === "open" ? "success" : status === "closed" ? "secondary" : "outline";
}

export default function RoundAdmin({ splat }: ModulePageProps) {
  const parts = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const can: Can = {
    manage: permissions.includes("round.manage"),
    publish: permissions.includes("round.publish"),
    settings: permissions.includes("round.settings"),
    esignRead: permissions.includes("esign.read"),
    accreditationRead: permissions.includes("accreditation.read"),
  };
  if (parts[0] === "verifications") return <VerificationsScreen can={can} />;
  if (parts[0] === "settings") return <SettingsScreen />;
  if (parts[0] === "rounds" && parts[1] !== undefined) {
    // E3.5: the closing tasks list moved into the "closing" tab; old `/tasks` links land there.
    const requested = parts[2] === "tasks" ? "closing" : parts[2];
    const tab = DETAIL_TABS.find((t) => t === requested) ?? "overview";
    return <RoundDetailScreen id={parts[1]} tab={tab} can={can} />;
  }
  return <RoundsListScreen can={can} />;
}

// --- list -------------------------------------------------------------------------------------

interface CreateForm {
  name: string;
  stage: RoundStage;
  instrumentKind: InstrumentKind;
  targetAmount: string;
  currency: string;
  minimumInvestment: string;
  summary: string;
  showProgress: boolean;
}

function CreateRoundDialog({ defaultCurrency }: { defaultCurrency: string }) {
  const ids = {
    name: useId(),
    stage: useId(),
    kind: useId(),
    target: useId(),
    currency: useId(),
    minimum: useId(),
    summary: useId(),
    progress: useId(),
  };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>({
    name: "",
    stage: "seed",
    instrumentKind: "safe",
    targetAmount: "",
    currency: defaultCurrency,
    minimumInvestment: "",
    summary: "",
    showProgress: true,
  });
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<{ round: Round }>("/round/rounds", {
          body: {
            name: form.name.trim(),
            stage: form.stage,
            instrumentKind: form.instrumentKind,
            targetAmount: form.targetAmount.trim(),
            currency: form.currency.trim().toUpperCase(),
            minimumInvestment:
              form.minimumInvestment.trim() === "" ? null : form.minimumInvestment.trim(),
            summary: form.summary.trim() === "" ? null : form.summary.trim(),
            showProgress: form.showProgress,
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_created());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.round_new()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.round_new()}</DialogTitle>
          <DialogDescription>{m.round_new_hint()}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field id={ids.name} label={m.round_field_name()} required>
            <Input
              id={ids.name}
              value={form.name}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={ids.stage} label={m.round_field_stage()}>
              <NativeSelect
                id={ids.stage}
                value={form.stage}
                onChange={(e) => setForm({ ...form, stage: e.target.value as RoundStage })}
              >
                {ROUND_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {stageLabel(stage)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={ids.kind} label={m.round_field_instrument()}>
              <NativeSelect
                id={ids.kind}
                value={form.instrumentKind}
                onChange={(e) =>
                  setForm({ ...form, instrumentKind: e.target.value as InstrumentKind })
                }
              >
                {INSTRUMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {instrumentLabel(kind)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={ids.target} label={m.round_field_target()} required>
              <Input
                id={ids.target}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                value={form.targetAmount}
                onChange={(e) => setForm({ ...form, targetAmount: e.target.value })}
              />
            </Field>
            <Field id={ids.currency} label={m.round_field_currency()} required>
              <Input
                id={ids.currency}
                value={form.currency}
                maxLength={3}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              />
            </Field>
            <Field
              id={ids.minimum}
              label={m.round_field_minimum()}
              description={m.round_field_minimum_hint()}
            >
              <Input
                id={ids.minimum}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                value={form.minimumInvestment}
                onChange={(e) => setForm({ ...form, minimumInvestment: e.target.value })}
                {...fieldAria(ids.minimum, { description: true })}
              />
            </Field>
          </div>
          <Field
            id={ids.summary}
            label={m.round_field_summary()}
            description={m.round_field_summary_hint()}
          >
            <Textarea
              id={ids.summary}
              rows={4}
              maxLength={4000}
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              {...fieldAria(ids.summary, { description: true })}
            />
          </Field>
          <label htmlFor={ids.progress} className="flex items-start gap-2 text-sm">
            <input
              id={ids.progress}
              type="checkbox"
              className="mt-1"
              checked={form.showProgress}
              onChange={(e) => setForm({ ...form, showProgress: e.target.checked })}
            />
            <span>{m.round_field_show_progress()}</span>
          </label>
          <ErrorAlert error={create.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={create.isPending}>
              {m.round_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoundsListScreen({ can }: { can: Can }) {
  const rounds = useQuery(roundsQuery);
  const settings = useQuery({ ...roundSettingsQuery, enabled: can.settings, retry: false });
  const list = rounds.data?.rounds ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.round_admin_title()}
        description={m.round_admin_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: "round/verifications" }}>
                <ShieldCheck aria-hidden="true" />
                {m.round_verifications_link()}
              </Link>
            </Button>
            {can.settings ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "round/settings" }}>
                  <Settings aria-hidden="true" />
                  {m.round_settings_link()}
                </Link>
              </Button>
            ) : null}
            {can.manage ? (
              <CreateRoundDialog defaultCurrency={settings.data?.defaultCurrency ?? "USD"} />
            ) : null}
          </div>
        }
      />
      {rounds.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {rounds.isError ? <ErrorAlert error={rounds.error} /> : null}
      {rounds.data === undefined ? null : list.length === 0 ? (
        <EmptyState
          icon={<PieChart aria-hidden="true" />}
          title={m.round_list_empty_title()}
          description={m.round_list_empty_body()}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{m.round_col_name()}</TableHead>
              <TableHead scope="col">{m.round_col_stage()}</TableHead>
              <TableHead scope="col">{m.round_col_instrument()}</TableHead>
              <TableHead scope="col">{m.round_col_target()}</TableHead>
              <TableHead scope="col">{m.round_col_status()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((round) => (
              <TableRow key={round.id}>
                <TableHead scope="row" className="font-medium">
                  <Link
                    to="/admin/$"
                    params={{ _splat: `round/rounds/${round.id}` }}
                    className="text-primary underline underline-offset-4"
                  >
                    {round.name}
                  </Link>
                </TableHead>
                <TableCell>{stageLabel(round.stage)}</TableCell>
                <TableCell>{instrumentLabel(round.instrumentKind)}</TableCell>
                <TableCell className="tabular-nums">
                  {formatMoney(round.targetAmount, round.currency)}
                </TableCell>
                <TableCell>
                  <Badge variant={roundStatusVariant(round.status)}>
                    {roundStatusLabel(round.status)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// --- detail -----------------------------------------------------------------------------------

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/admin/$" params={{ _splat: "round" }}>
        <ArrowLeft aria-hidden="true" />
        {m.round_back_to_list()}
      </Link>
    </Button>
  );
}

function RoundDetailScreen({ id, tab, can }: { id: string; tab: DetailTab; can: Can }) {
  const detail = useQuery(roundDetailQuery(id));
  const round = detail.data?.round;
  return (
    <div className="space-y-6">
      <BackLink />
      {detail.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {detail.isError ? <ErrorAlert error={detail.error} /> : null}
      {detail.data === undefined || round === undefined ? null : (
        <>
          <PageHeader
            title={round.name}
            description={m.round_summary_line({
              stage: stageLabel(round.stage),
              instrument: instrumentLabel(round.instrumentKind),
            })}
            actions={
              can.publish ? (
                <Button asChild variant="outline">
                  <a href={roundExportHref(round.id)}>
                    <Download aria-hidden="true" />
                    {m.round_export()}
                  </a>
                </Button>
              ) : null
            }
          />
          <nav aria-label={m.round_tabs_label()}>
            <ul className="flex list-none flex-wrap gap-2 border-b pb-2">
              {DETAIL_TABS.map((t) => (
                <li key={t}>
                  <Link
                    to="/admin/$"
                    params={{ _splat: `round/rounds/${round.id}/${t}` }}
                    aria-current={t === tab ? "page" : undefined}
                    className={
                      t === tab
                        ? "rounded-md bg-accent px-3 py-1.5 text-sm font-medium"
                        : "rounded-md px-3 py-1.5 text-sm text-muted-foreground"
                    }
                  >
                    {tabLabel(t)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {tab === "overview" ? (
            <OverviewTab
              round={round}
              allocation={detail.data.allocation}
              counters={detail.data.counters}
              can={can}
            />
          ) : null}
          {tab === "terms" ? (
            <TermsTab
              round={round}
              current={detail.data.terms}
              history={detail.data.history}
              canManage={can.manage}
            />
          ) : null}
          {tab === "interest" ? <InterestTab round={round} canManage={can.manage} /> : null}
          {tab === "commitments" ? <CommitmentsTab round={round} canManage={can.manage} /> : null}
          {tab === "closing" ? (
            <>
              <ClosingTab round={round} canManage={can.manage} canReadESign={can.esignRead} />
              <TasksTab round={round} canManage={can.manage} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function OverviewTab({
  round,
  allocation,
  counters,
  can,
}: {
  round: Round;
  allocation: Allocation;
  counters: RoundCounters;
  can: Can;
}) {
  const queryClient = useQueryClient();
  const publish = useGuardedMutation({
    mutationFn: (action: "open" | "close") =>
      call(
        api().POST<{ round: Round }>(`/round/rounds/{id}/${action}`, {
          params: { path: { id: round.id } },
        }),
      ),
    onSuccess: (_result, action) => {
      toast.success(action === "open" ? m.round_opened() : m.round_closed());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{m.round_overview_title()}</CardTitle>
          <CardDescription>
            {round.openedAt === null
              ? m.round_never_opened()
              : m.round_opened_at({ when: formatDateTime(round.openedAt) })}
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={roundStatusVariant(round.status)}>
              {roundStatusLabel(round.status)}
            </Badge>
            {round.showProgress ? (
              <Badge variant="outline">{m.round_progress_shown()}</Badge>
            ) : (
              <Badge variant="outline">{m.round_progress_hidden()}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ErrorAlert error={publish.error} />
          {can.publish ? (
            <div className="flex flex-wrap gap-2">
              {round.status === "planning" ? (
                <ConfirmDialog
                  trigger={<Button type="button">{m.round_open()}</Button>}
                  title={m.round_open_title()}
                  description={m.round_open_body()}
                  confirmLabel={m.round_open()}
                  pending={publish.isPending}
                  onConfirm={() => publish.mutate("open")}
                />
              ) : null}
              {round.status === "open" ? (
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="outline">
                      {m.round_close()}
                    </Button>
                  }
                  title={m.round_close_title()}
                  description={m.round_close_body()}
                  confirmLabel={m.round_close()}
                  pending={publish.isPending}
                  onConfirm={() => publish.mutate("close")}
                />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AllocationTracker allocation={allocation} counters={counters} currency={round.currency} />
    </div>
  );
}

// --- terms ------------------------------------------------------------------------------------

interface TermsForm {
  variant: "post_money" | "pre_money";
  valuationCap: string;
  discountPercent: string;
  interestRatePercent: string;
  maturityMonths: string;
  preMoneyValuation: string;
  pricePerShare: string;
  liquidationPreferenceMultiple: string;
  optionPoolPercent: string;
  mfn: boolean;
  proRata: boolean;
  participating: boolean;
}

function termsFormOf(terms: Terms | null): TermsForm {
  const base: TermsForm = {
    variant: "post_money",
    valuationCap: "",
    discountPercent: "",
    interestRatePercent: "",
    maturityMonths: "24",
    preMoneyValuation: "",
    pricePerShare: "",
    liquidationPreferenceMultiple: "1",
    optionPoolPercent: "",
    mfn: false,
    proRata: false,
    participating: false,
  };
  if (terms === null) return base;
  if (terms.kind === "safe") {
    return {
      ...base,
      variant: terms.variant,
      valuationCap: terms.valuationCap ?? "",
      discountPercent: terms.discountPercent ?? "",
      mfn: terms.mfn,
      proRata: terms.proRata,
    };
  }
  if (terms.kind === "note") {
    return {
      ...base,
      valuationCap: terms.valuationCap ?? "",
      discountPercent: terms.discountPercent ?? "",
      interestRatePercent: terms.interestRatePercent,
      maturityMonths: String(terms.maturityMonths),
      mfn: terms.mfn,
      proRata: terms.proRata,
    };
  }
  return {
    ...base,
    preMoneyValuation: terms.preMoneyValuation,
    pricePerShare: terms.pricePerShare ?? "",
    liquidationPreferenceMultiple: terms.liquidationPreferenceMultiple,
    optionPoolPercent: terms.optionPoolPercent ?? "",
    participating: terms.participating,
    proRata: terms.proRata,
  };
}

/** The jsonb body for the round's declared instrument. Blank optionals are omitted, not sent as "". */
function termsBody(kind: InstrumentKind, form: TermsForm): Record<string, unknown> {
  const opt = (value: string): string | undefined =>
    value.trim() === "" ? undefined : value.trim();
  if (kind === "safe") {
    return {
      kind: "safe",
      variant: form.variant,
      ...(opt(form.valuationCap) === undefined ? {} : { valuationCap: opt(form.valuationCap) }),
      ...(opt(form.discountPercent) === undefined
        ? {}
        : { discountPercent: opt(form.discountPercent) }),
      mfn: form.mfn,
      proRata: form.proRata,
    };
  }
  if (kind === "note") {
    return {
      kind: "note",
      ...(opt(form.valuationCap) === undefined ? {} : { valuationCap: opt(form.valuationCap) }),
      ...(opt(form.discountPercent) === undefined
        ? {}
        : { discountPercent: opt(form.discountPercent) }),
      interestRatePercent: form.interestRatePercent.trim(),
      maturityMonths: Number(form.maturityMonths),
      mfn: form.mfn,
      proRata: form.proRata,
    };
  }
  return {
    kind: "priced",
    preMoneyValuation: form.preMoneyValuation.trim(),
    ...(opt(form.pricePerShare) === undefined ? {} : { pricePerShare: opt(form.pricePerShare) }),
    liquidationPreferenceMultiple: form.liquidationPreferenceMultiple.trim(),
    participating: form.participating,
    proRata: form.proRata,
    ...(opt(form.optionPoolPercent) === undefined
      ? {}
      : { optionPoolPercent: opt(form.optionPoolPercent) }),
  };
}

function TermsTab({
  round,
  current,
  history,
  canManage,
}: {
  round: Round;
  current: TermsRevision | null;
  history: readonly TermsRevision[];
  canManage: boolean;
}) {
  const ids = {
    variant: useId(),
    cap: useId(),
    discount: useId(),
    interest: useId(),
    maturity: useId(),
    preMoney: useId(),
    price: useId(),
    liquidation: useId(),
    pool: useId(),
    mfn: useId(),
    proRata: useId(),
    participating: useId(),
  };
  const [form, setForm] = useState<TermsForm>(() => termsFormOf(current?.terms ?? null));
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT<{ terms: TermsRevision }>("/round/rounds/{id}/terms", {
          params: { path: { id: round.id } },
          body: { terms: termsBody(round.instrumentKind, form) },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_terms_saved());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  const kind = round.instrumentKind;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{m.round_terms_form_title()}</CardTitle>
          <CardDescription>{m.round_terms_form_hint()}</CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {kind === "safe" ? (
                  <Field id={ids.variant} label={m.round_terms_variant()}>
                    <NativeSelect
                      id={ids.variant}
                      value={form.variant}
                      onChange={(e) =>
                        setForm({ ...form, variant: e.target.value as TermsForm["variant"] })
                      }
                    >
                      <option value="post_money">{m.round_terms_safe_post_money()}</option>
                      <option value="pre_money">{m.round_terms_safe_pre_money()}</option>
                    </NativeSelect>
                  </Field>
                ) : null}
                {kind === "safe" || kind === "note" ? (
                  <>
                    <Field id={ids.cap} label={m.round_terms_cap()}>
                      <Input
                        id={ids.cap}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.valuationCap}
                        onChange={(e) => setForm({ ...form, valuationCap: e.target.value })}
                      />
                    </Field>
                    <Field id={ids.discount} label={m.round_terms_discount()}>
                      <Input
                        id={ids.discount}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.discountPercent}
                        onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                      />
                    </Field>
                  </>
                ) : null}
                {kind === "note" ? (
                  <>
                    <Field id={ids.interest} label={m.round_terms_interest()} required>
                      <Input
                        id={ids.interest}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.interestRatePercent}
                        onChange={(e) => setForm({ ...form, interestRatePercent: e.target.value })}
                      />
                    </Field>
                    <Field id={ids.maturity} label={m.round_terms_maturity()} required>
                      <Input
                        id={ids.maturity}
                        type="number"
                        min={1}
                        max={120}
                        className="tabular-nums"
                        value={form.maturityMonths}
                        onChange={(e) => setForm({ ...form, maturityMonths: e.target.value })}
                      />
                    </Field>
                  </>
                ) : null}
                {kind === "priced" ? (
                  <>
                    <Field id={ids.preMoney} label={m.round_terms_pre_money()} required>
                      <Input
                        id={ids.preMoney}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.preMoneyValuation}
                        onChange={(e) => setForm({ ...form, preMoneyValuation: e.target.value })}
                      />
                    </Field>
                    <Field id={ids.price} label={m.round_terms_price_per_share()}>
                      <Input
                        id={ids.price}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.pricePerShare}
                        onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })}
                      />
                    </Field>
                    <Field id={ids.liquidation} label={m.round_terms_liquidation()}>
                      <Input
                        id={ids.liquidation}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.liquidationPreferenceMultiple}
                        onChange={(e) =>
                          setForm({ ...form, liquidationPreferenceMultiple: e.target.value })
                        }
                      />
                    </Field>
                    <Field id={ids.pool} label={m.round_terms_option_pool()}>
                      <Input
                        id={ids.pool}
                        type="text"
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form.optionPoolPercent}
                        onChange={(e) => setForm({ ...form, optionPoolPercent: e.target.value })}
                      />
                    </Field>
                  </>
                ) : null}
              </div>
              <fieldset className="flex flex-wrap items-center gap-4 text-sm">
                <legend className="sr-only">{m.round_terms_flags()}</legend>
                {kind === "priced" ? (
                  <label htmlFor={ids.participating} className="flex items-center gap-2">
                    <input
                      id={ids.participating}
                      type="checkbox"
                      checked={form.participating}
                      onChange={(e) => setForm({ ...form, participating: e.target.checked })}
                    />
                    {m.round_terms_participating()}
                  </label>
                ) : (
                  <label htmlFor={ids.mfn} className="flex items-center gap-2">
                    <input
                      id={ids.mfn}
                      type="checkbox"
                      checked={form.mfn}
                      onChange={(e) => setForm({ ...form, mfn: e.target.checked })}
                    />
                    {m.round_terms_mfn()}
                  </label>
                )}
                <label htmlFor={ids.proRata} className="flex items-center gap-2">
                  <input
                    id={ids.proRata}
                    type="checkbox"
                    checked={form.proRata}
                    onChange={(e) => setForm({ ...form, proRata: e.target.checked })}
                  />
                  {m.round_terms_pro_rata()}
                </label>
              </fieldset>
              <ErrorAlert error={save.error} />
              <Button type="submit" loading={save.isPending}>
                {m.round_terms_save()}
              </Button>
            </form>
          ) : current === null ? (
            <p className="text-sm text-muted-foreground">{m.round_terms_none()}</p>
          ) : (
            <TermsList terms={current.terms} currency={round.currency} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m.round_terms_history_title()}</CardTitle>
          <CardDescription>{m.round_terms_history_hint()}</CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.round_terms_history_empty()}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{m.round_col_revision()}</TableHead>
                  <TableHead scope="col">{m.round_col_as_of()}</TableHead>
                  <TableHead scope="col">{m.round_col_author()}</TableHead>
                  <TableHead scope="col">{m.round_col_state()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((revision) => (
                  <TableRow key={revision.id}>
                    <TableHead scope="row" className="tabular-nums">
                      {revision.revision}
                    </TableHead>
                    <TableCell>{formatDate(revision.asOf)}</TableCell>
                    <TableCell>{revision.createdBy?.displayName ?? m.round_system()}</TableCell>
                    <TableCell>
                      <Badge variant={revision.supersededBy === null ? "success" : "outline"}>
                        {revision.supersededBy === null
                          ? m.round_terms_current()
                          : m.round_terms_superseded()}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- interest queue ---------------------------------------------------------------------------

function DecideInterestDialog({
  submission,
  decision,
  currency,
}: {
  submission: InterestSubmission;
  decision: "accept" | "decline";
  currency: string;
}) {
  const ids = { amount: useId(), note: useId() };
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const decide = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<InterestDecision>(`/round/interest/{id}/${decision}`, {
          params: { path: { id: submission.id } },
          body: {
            ...(decision === "accept" && amount.trim() !== "" ? { amount: amount.trim() } : {}),
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          },
        }),
      ),
    onSuccess: (result) => {
      toast.success(
        decision === "accept" ? m.round_interest_accepted() : m.round_interest_declined(),
      );
      for (const warning of result.warnings ?? []) toast.warning(decisionWarningLabel(warning));
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={decision === "accept" ? "default" : "outline"}>
          {decision === "accept" ? m.round_accept() : m.round_decline()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {decision === "accept" ? m.round_accept_title() : m.round_decline_title()}
          </DialogTitle>
          <DialogDescription>
            {decision === "accept"
              ? m.round_accept_body({ amount: formatMoney(submission.amount, currency) })
              : m.round_decline_body()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate();
          }}
        >
          {decision === "accept" ? (
            <Field
              id={ids.amount}
              label={m.round_accept_override()}
              description={m.round_accept_override_hint()}
            >
              <Input
                id={ids.amount}
                type="text"
                inputMode="decimal"
                className="tabular-nums"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                {...fieldAria(ids.amount, { description: true })}
              />
            </Field>
          ) : null}
          <Field id={ids.note} label={m.round_decision_note()}>
            <Textarea
              id={ids.note}
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <ErrorAlert error={decide.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={decide.isPending}>
              {decision === "accept" ? m.round_accept() : m.round_decline()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function decisionWarningLabel(warning: string): string {
  switch (warning) {
    case "non_accredited_limit":
      return m.round_warning_non_accredited_limit();
    default:
      return warning;
  }
}

function InterestTab({ round, canManage }: { round: Round; canManage: boolean }) {
  const filterId = useId();
  const [status, setStatus] = useState<InterestStatus | "all">("submitted");
  const queue = useQuery(roundInterestQueueQuery(round.id, status));
  const submissions = queue.data?.submissions ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_queue_title()}</CardTitle>
        <CardDescription>{m.round_queue_hint()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-56">
          <label htmlFor={filterId} className="text-sm font-medium">
            {m.round_filter_status()}
          </label>
          <NativeSelect
            id={filterId}
            value={status}
            onChange={(e) => setStatus(e.target.value as InterestStatus | "all")}
          >
            <option value="all">{m.round_filter_all()}</option>
            {INTEREST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {interestStatusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {queue.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {queue.isError ? <ErrorAlert error={queue.error} /> : null}
        {queue.data === undefined ? null : submissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.round_queue_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.round_col_person()}</TableHead>
                <TableHead scope="col">{m.round_col_amount()}</TableHead>
                <TableHead scope="col">{m.round_col_subject()}</TableHead>
                <TableHead scope="col">{m.round_col_path()}</TableHead>
                <TableHead scope="col">{m.round_col_status()}</TableHead>
                <TableHead scope="col">{m.round_col_actions()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.map((submission) => (
                <TableRow key={submission.id}>
                  <TableHead scope="row" className="font-medium">
                    {submission.member?.displayName ?? m.round_unknown_member()}
                  </TableHead>
                  <TableCell className="tabular-nums">
                    {formatMoney(submission.amount, submission.currency || round.currency)}
                  </TableCell>
                  <TableCell>
                    {subjectLabel(submission.subject)}
                    {submission.entityName === null ? null : ` — ${submission.entityName}`}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{pathLabel(submission.accreditationPath)}</Badge>
                      {submission.nonAccredited ? (
                        <Badge variant="warning">{m.round_badge_non_accredited()}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={interestStatusVariant(submission.status)}>
                      {interestStatusLabel(submission.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && submission.status === "submitted" ? (
                      <div className="flex flex-wrap gap-2">
                        <DecideInterestDialog
                          submission={submission}
                          decision="accept"
                          currency={round.currency}
                        />
                        <DecideInterestDialog
                          submission={submission}
                          decision="decline"
                          currency={round.currency}
                        />
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// --- commitments ------------------------------------------------------------------------------

function AddCommitmentDialog({ round }: { round: Round }) {
  const ids = { name: useId(), amount: useId(), status: useId(), note: useId() };
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<CommitmentStatus>("soft");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const add = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<{ commitment: Commitment }>("/round/rounds/{id}/commitments", {
          params: { path: { id: round.id } },
          body: {
            displayName: displayName.trim(),
            amount: amount.trim(),
            status,
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_commitment_added());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <Plus aria-hidden="true" />
          {m.round_commitment_add()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.round_commitment_add()}</DialogTitle>
          <DialogDescription>{m.round_commitment_add_hint()}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field id={ids.name} label={m.round_field_display_name()} required>
            <Input
              id={ids.name}
              value={displayName}
              maxLength={200}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field id={ids.amount} label={m.round_col_amount()} required>
            <Input
              id={ids.amount}
              type="text"
              inputMode="decimal"
              className="tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field id={ids.status} label={m.round_col_status()}>
            <NativeSelect
              id={ids.status}
              value={status}
              onChange={(e) => setStatus(e.target.value as CommitmentStatus)}
            >
              {COMMITMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {commitmentStatusLabel(s)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id={ids.note} label={m.round_decision_note()}>
            <Textarea
              id={ids.note}
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <ErrorAlert error={add.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={add.isPending}>
              {m.round_commitment_add()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CommitmentsTab({ round, canManage }: { round: Round; canManage: boolean }) {
  const commitments = useQuery(roundCommitmentsQuery(round.id));
  const queryClient = useQueryClient();
  const update = useGuardedMutation({
    mutationFn: (input: { id: string; status: CommitmentStatus }) =>
      call(
        api().PATCH<{ commitment: Commitment }>("/round/commitments/{id}", {
          params: { path: { id: input.id } },
          body: { status: input.status },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_commitment_updated());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  const rows = commitments.data?.commitments ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_commitments_title()}</CardTitle>
        <CardDescription>{m.round_commitments_hint()}</CardDescription>
        {canManage ? <AddCommitmentDialog round={round} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert error={update.error} />
        {commitments.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {commitments.isError ? <ErrorAlert error={commitments.error} /> : null}
        {commitments.data === undefined ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.round_commitments_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.round_col_person()}</TableHead>
                <TableHead scope="col">{m.round_col_amount()}</TableHead>
                <TableHead scope="col">{m.round_col_status()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((commitment) => (
                <TableRow key={commitment.id}>
                  <TableHead scope="row" className="font-medium">
                    {commitment.member?.displayName ??
                      commitment.displayName ??
                      m.round_unknown_member()}
                  </TableHead>
                  <TableCell className="tabular-nums">
                    {formatMoney(commitment.amount, round.currency)}
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <NativeSelect
                        aria-label={m.round_commitment_status_label({
                          name:
                            commitment.member?.displayName ??
                            commitment.displayName ??
                            m.round_unknown_member(),
                        })}
                        className="w-40"
                        value={commitment.status}
                        onChange={(e) =>
                          update.mutate({
                            id: commitment.id,
                            status: e.target.value as CommitmentStatus,
                          })
                        }
                      >
                        {COMMITMENT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {commitmentStatusLabel(s)}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Badge variant={commitmentStatusVariant(commitment.status)}>
                        {commitmentStatusLabel(commitment.status)}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// --- closing tasks ----------------------------------------------------------------------------

function TasksTab({ round, canManage }: { round: Round; canManage: boolean }) {
  const titleId = useId();
  const tasks = useQuery(roundClosingTasksQuery(round.id));
  const [title, setTitle] = useState("");
  const queryClient = useQueryClient();
  const list = tasks.data?.tasks ?? [];
  const replace = useGuardedMutation({
    mutationFn: (next: readonly { id?: string; title: string; done: boolean }[]) =>
      call(
        api().PUT<{ tasks: ClosingTask[] }>("/round/rounds/{id}/closing-tasks", {
          params: { path: { id: round.id } },
          body: { tasks: next },
        }),
      ),
    onSuccess: () => {
      setTitle("");
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  const asBody = (over: readonly ClosingTask[]) =>
    over.map((t) => ({ id: t.id, title: t.title, done: t.done }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_tasks_title()}</CardTitle>
        <CardDescription>{m.round_tasks_hint()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert error={replace.error} />
        {tasks.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.round_tasks_empty()}</p>
        ) : (
          <ul className="list-none space-y-2">
            {list.map((task) => (
              <li key={task.id} className="flex items-center gap-2 text-sm">
                <input
                  id={`task-${task.id}`}
                  type="checkbox"
                  checked={task.done}
                  disabled={!canManage}
                  onChange={(e) =>
                    replace.mutate(
                      asBody(list).map((t) =>
                        t.id === task.id ? { ...t, done: e.target.checked } : t,
                      ),
                    )
                  }
                />
                <label htmlFor={`task-${task.id}`}>{task.title}</label>
                {task.doneAt === null ? null : (
                  <span className="text-xs text-muted-foreground">{formatDate(task.doneAt)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim() === "") return;
              replace.mutate([...asBody(list), { title: title.trim(), done: false }]);
            }}
          >
            <Field id={titleId} label={m.round_task_new()} className="w-72">
              <Input
                id={titleId}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={replace.isPending}>
              {m.round_task_add()}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- verifications ----------------------------------------------------------------------------

/**
 * The server's rule, restated in the UI: a `verified` decision needs a method, and the method
 * decides what counts as evidence — a file for a document review or a professional letter, a
 * note naming the source for a third-party service or the minimum-investment representation
 * (design/04 R7, contract §S). The dialog refuses the same things the server refuses, so the
 * refusal arrives while there is still a form to fix rather than as a 409 afterwards.
 */
export function evidenceSatisfied(
  method: VerificationMethod | "",
  hasFile: boolean,
  note: string,
): boolean {
  switch (method) {
    case "document_review":
    case "professional_letter":
      return hasFile;
    case "third_party":
    case "minimum_investment":
      return note.trim() !== "";
    default:
      return false;
  }
}

/** A verification a vendor runs (VerifyInvestor.com, Parallel Markets), not a person. */
function isVendorRow(verification: Pick<Verification, "provider">): boolean {
  return verification.provider !== "manual";
}

/** `vendor_error` in words where we know the code; the vendor's own text otherwise. */
function vendorErrorLabel(error: string): string {
  switch (error) {
    case "connection_changed":
      return m.round_verification_vendor_error_connection_changed();
    case "member_erased":
      return m.round_verification_vendor_error_member_erased();
    case "member_inactive":
      return m.round_verification_vendor_error_member_inactive();
    case "imported":
      return m.round_verification_vendor_error_imported();
    case "start_failed":
      return m.round_verification_vendor_error_start_failed();
    case "start_timeout":
      return m.round_verification_vendor_error_start_timeout();
    case "polling_stopped":
      return m.round_verification_vendor_error_polling_stopped();
    case "renewal_not_recertified":
      return m.round_verification_vendor_error_renewal_not_recertified();
    default:
      return m.round_verification_vendor_error({ error });
  }
}

/**
 * The server never polls these again, so "Check now" would only earn a 409: an imported row
 * (its vendor ref belongs to another install's connection) and an erased member's row.
 */
function canCheckNow(verification: Verification): boolean {
  return (
    isVendorRow(verification) &&
    verification.status === "pending" &&
    verification.vendorError !== "imported" &&
    verification.vendorError !== "member_erased"
  );
}

/** `reason` on a 409 `conflict`, flat or under `details`. */
function conflictReason(error: unknown): string | undefined {
  if (!isCode(error, "conflict") || !isApiError(error)) return undefined;
  const flat = error.body.error["reason"];
  if (typeof flat === "string") return flat;
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.["reason"];
  return typeof nested === "string" ? nested : undefined;
}

function DecideVerificationDialog({ verification }: { verification: Verification }) {
  const ids = { status: useId(), method: useId(), note: useId(), expiry: useId() };
  const vendor = isVendorRow(verification);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"verified" | "rejected">("verified");
  const [method, setMethod] = useState<VerificationMethod | "">(
    verification.method ?? (vendor ? "third_party" : ""),
  );
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const queryClient = useQueryClient();
  const decide = useGuardedMutation({
    mutationFn: () =>
      call(
        // The answer is the verification itself, flat (`RoundVerification`).
        api().POST<Verification>("/round/verifications/{id}/decide", {
          params: { path: { id: verification.id } },
          body: {
            status,
            ...(method === "" ? {} : { method }),
            ...(note.trim() === "" ? {} : { note: note.trim() }),
            ...(expiresAt === "" ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_verification_decided());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  const ok = status === "rejected" || evidenceSatisfied(method, verification.hasEvidence, note);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={vendor ? "outline" : "default"}>
          {m.round_verification_decide()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.round_verification_decide()}</DialogTitle>
          <DialogDescription>{m.round_verification_decide_hint()}</DialogDescription>
        </DialogHeader>
        {vendor ? (
          <Alert>
            <AlertTitle>
              {m.round_verification_override_title({ vendor: verification.providerLabel })}
            </AlertTitle>
            <AlertDescription>
              <p>{m.round_verification_override_body({ vendor: verification.providerLabel })}</p>
              {verification.vendorStatus === null ? null : (
                <p>{m.round_verification_vendor_status({ status: verification.vendorStatus })}</p>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate();
          }}
        >
          <Field id={ids.status} label={m.round_col_status()}>
            <NativeSelect
              id={ids.status}
              value={status}
              onChange={(e) => setStatus(e.target.value as "verified" | "rejected")}
            >
              <option value="verified">{m.round_verification_verified()}</option>
              <option value="rejected">{m.round_verification_rejected()}</option>
            </NativeSelect>
          </Field>
          <Field
            id={ids.method}
            label={m.round_verification_method()}
            description={m.round_verification_method_hint()}
          >
            <NativeSelect
              id={ids.method}
              value={method}
              onChange={(e) => setMethod(e.target.value as VerificationMethod | "")}
              {...fieldAria(ids.method, { description: true })}
            >
              <option value="">{m.round_verification_method_none()}</option>
              {VERIFICATION_METHODS.map((value) => (
                <option key={value} value={value}>
                  {methodLabel(value)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={ids.note}
            label={m.round_decision_note()}
            description={m.round_verification_note_hint()}
          >
            <Textarea
              id={ids.note}
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              {...fieldAria(ids.note, { description: true })}
            />
          </Field>
          <Field
            id={ids.expiry}
            label={m.round_verification_expiry()}
            description={m.round_verification_expiry_hint()}
          >
            <Input
              id={ids.expiry}
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              {...fieldAria(ids.expiry, { description: true })}
            />
          </Field>
          {ok ? null : (
            <p className="text-sm font-medium text-destructive">
              {m.round_verification_needs_evidence()}
            </p>
          )}
          {conflictReason(decide.error) === "member_erased" ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.round_verification_member_erased_title()}</AlertTitle>
              <AlertDescription>{m.round_verification_member_erased_body()}</AlertDescription>
            </Alert>
          ) : (
            <ErrorAlert error={decide.error} />
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={decide.isPending} disabled={!ok}>
              {m.round_verification_record()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Check now": queues a sync of a pending vendor verification (202). The answer arrives with the
 * sync, not with this request, so the toast says "queued", and the queue refreshes shortly after.
 */
function CheckNowButton({ verification }: { verification: Verification }) {
  const queryClient = useQueryClient();
  const check = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<{ queued: true }>("/round/verifications/{id}/check", {
          params: { path: { id: verification.id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_verification_check_queued({ vendor: verification.providerLabel }));
      void queryClient.invalidateQueries({ queryKey: ["round", "verifications"] });
    },
    onError: (error) => {
      toast.error(
        isCode(error, "conflict")
          ? m.round_verification_check_conflict()
          : describeError(error).body,
      );
      void queryClient.invalidateQueries({ queryKey: ["round", "verifications"] });
    },
  });
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      loading={check.isPending}
      onClick={() => check.mutate()}
      aria-label={m.round_verification_check_now_for({ vendor: verification.providerLabel })}
    >
      <RefreshCw aria-hidden="true" />
      {m.round_verification_check_now()}
    </Button>
  );
}

/** The status cell: the badge, who decided (a vendor), and the vendor's own status and error. */
function VerificationStatusCell({ verification }: { verification: Verification }) {
  return (
    <div className="grid gap-1">
      <span>
        <Badge variant={verificationStatusVariant(verification.status)}>
          {verificationStatusLabel(verification.status)}
        </Badge>
      </span>
      {verification.decidedByProvider === null ? null : (
        <span className="text-xs text-muted-foreground">
          {verification.status === "rejected"
            ? m.round_verification_rejected_by({ vendor: verification.providerLabel })
            : m.round_verification_verified_by({ vendor: verification.providerLabel })}
        </span>
      )}
      {verification.status === "pending" && verification.vendorStatus !== null ? (
        <span className="text-xs text-muted-foreground">
          {m.round_verification_vendor_status({ status: verification.vendorStatus })}
        </span>
      ) : null}
      {verification.vendorError === null ? null : (
        <span className="text-xs font-medium text-destructive">
          {vendorErrorLabel(verification.vendorError)}
        </span>
      )}
    </div>
  );
}

function verificationAnchor(id: string): string {
  return `verification-${id}`;
}

function VerificationsScreen({ can }: { can: Can }) {
  const filterId = useId();
  const [status, setStatus] = useState<VerificationStatus | "all">("pending");
  const verifications = useQuery(roundVerificationsQuery(status));
  const rows = verifications.data?.verifications ?? [];
  const listed = new Set(rows.map((r) => r.id));
  return (
    <div className="space-y-6">
      <BackLink />
      <PageHeader
        title={m.round_verifications_title()}
        description={m.round_verifications_subtitle()}
        actions={
          can.accreditationRead ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/accreditation">
                <ShieldCheck aria-hidden="true" />
                {m.round_verifications_vendor_link()}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="max-w-56">
        <label htmlFor={filterId} className="text-sm font-medium">
          {m.round_filter_status()}
        </label>
        <NativeSelect
          id={filterId}
          value={status}
          onChange={(e) => setStatus(e.target.value as VerificationStatus | "all")}
        >
          <option value="all">{m.round_filter_all()}</option>
          {VERIFICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {verificationStatusLabel(s)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {verifications.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {verifications.isError ? <ErrorAlert error={verifications.error} /> : null}
      {verifications.data === undefined ? null : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.round_verifications_empty()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{m.round_col_person()}</TableHead>
              <TableHead scope="col">{m.round_col_provider()}</TableHead>
              <TableHead scope="col">{m.round_col_status()}</TableHead>
              <TableHead scope="col">{m.round_col_method()}</TableHead>
              <TableHead scope="col">{m.round_col_evidence()}</TableHead>
              <TableHead scope="col">{m.round_col_last_checked()}</TableHead>
              <TableHead scope="col">{m.round_col_actions()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((verification) => (
              <TableRow key={verification.id} id={verificationAnchor(verification.id)}>
                <TableHead scope="row" className="font-medium">
                  <span className="block">
                    {verification.displayName ?? m.round_unknown_member()}
                  </span>
                  {verification.email === null ? null : (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {verification.email}
                    </span>
                  )}
                </TableHead>
                <TableCell>
                  <div className="grid gap-1">
                    <span>{verification.providerLabel}</span>
                    {verification.reverificationOf === null ? null : (
                      <span>
                        <Badge variant="outline">{m.round_verification_renewal()}</Badge>{" "}
                        {listed.has(verification.reverificationOf) ? (
                          <a
                            href={`#${verificationAnchor(verification.reverificationOf)}`}
                            className="text-xs underline underline-offset-4"
                          >
                            {m.round_verification_renews()}
                          </a>
                        ) : null}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <VerificationStatusCell verification={verification} />
                </TableCell>
                <TableCell>
                  {verification.method === null
                    ? m.round_verification_method_none()
                    : methodLabel(verification.method)}
                </TableCell>
                <TableCell>
                  {verification.evidencePurgedAt !== null ? (
                    m.round_evidence_purged({
                      when: formatDate(verification.evidencePurgedAt),
                    })
                  ) : verification.hasEvidence ? (
                    // Staff-only page, and the bytes are decrypted server-side on demand, so a
                    // plain anchor is the whole of it — no blob, no pre-fetch, nothing cached.
                    <a
                      href={verificationEvidenceHref(verification.id)}
                      rel="noopener noreferrer"
                      target="_blank"
                      className="text-primary underline underline-offset-4"
                    >
                      {m.round_evidence_download()}
                    </a>
                  ) : (
                    m.round_evidence_none()
                  )}
                </TableCell>
                <TableCell>
                  {!isVendorRow(verification)
                    ? m.round_verification_not_applicable()
                    : verification.vendorCheckedAt === null
                      ? m.round_verification_not_checked()
                      : formatDateTime(verification.vendorCheckedAt)}
                </TableCell>
                <TableCell>
                  {can.manage && verification.status === "pending" ? (
                    <div className="flex flex-wrap gap-2">
                      {canCheckNow(verification) ? (
                        <CheckNowButton verification={verification} />
                      ) : null}
                      <DecideVerificationDialog verification={verification} />
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// --- settings ---------------------------------------------------------------------------------

function SettingsScreen() {
  const ids = { retention: useId(), currency: useId() };
  const settings = useQuery(roundSettingsQuery);
  const [form, setForm] = useState<{ retention: string; currency: string } | null>(null);
  const queryClient = useQueryClient();
  const state = form ?? {
    retention: String(settings.data?.evidenceRetentionDays ?? 90),
    currency: settings.data?.defaultCurrency ?? "USD",
  };
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH<RoundSettings>("/round/settings", {
          body: {
            evidenceRetentionDays: Number(state.retention),
            defaultCurrency: state.currency.trim().toUpperCase(),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_settings_saved());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <div className="space-y-6">
      <BackLink />
      <PageHeader title={m.round_settings_title()} description={m.round_settings_subtitle()} />
      {settings.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {settings.isError ? <ErrorAlert error={settings.error} /> : null}
      {settings.data === undefined ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{m.round_settings_title()}</CardTitle>
            <CardDescription>{m.round_settings_evidence_hint()}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="max-w-md space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <Field
                id={ids.retention}
                label={m.round_settings_retention()}
                description={m.round_settings_retention_hint()}
                required
              >
                <Input
                  id={ids.retention}
                  type="number"
                  min={1}
                  max={3650}
                  className="tabular-nums"
                  value={state.retention}
                  onChange={(e) => setForm({ ...state, retention: e.target.value })}
                  {...fieldAria(ids.retention, { description: true })}
                />
              </Field>
              <Field
                id={ids.currency}
                label={m.round_settings_currency()}
                description={m.round_settings_currency_hint()}
                required
              >
                <Input
                  id={ids.currency}
                  maxLength={3}
                  value={state.currency}
                  onChange={(e) => setForm({ ...state, currency: e.target.value })}
                  {...fieldAria(ids.currency, { description: true })}
                />
              </Field>
              <ErrorAlert error={save.error} />
              <Button type="submit" loading={save.isPending}>
                {m.round_settings_save()}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
      {settings.data === undefined ? null : <ClosingSettingsCard settings={settings.data} />}
      {settings.data === undefined ? null : <ReverificationSettingsCard settings={settings.data} />}
    </div>
  );
}

/**
 * Accreditation re-verification (E3.7): one reminder `reminderDays` before a verification
 * expires, and — when `autoStart` is on and a vendor is connected — a new vendor verification
 * opened at that moment. A vendor bills per verification, so the box says so next to it.
 */
function ReverificationSettingsCard({ settings }: { settings: RoundSettings }) {
  const ids = { days: useId(), autoStart: useId() };
  const [form, setForm] = useState<{ days: string; autoStart: boolean } | null>(null);
  const queryClient = useQueryClient();
  const state = form ?? {
    days: String(settings.reverification.reminderDays),
    autoStart: settings.reverification.autoStart,
  };
  const days = Number(state.days);
  const valid = state.days.trim() !== "" && Number.isInteger(days) && days >= 1 && days <= 60;
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH<RoundSettings>("/round/settings", {
          body: { reverification: { reminderDays: days, autoStart: state.autoStart } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_settings_saved());
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_reverification_title()}</CardTitle>
        <CardDescription>{m.round_reverification_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-md space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field
            id={ids.days}
            label={m.round_reverification_days()}
            description={m.round_reverification_days_hint()}
            required
          >
            <Input
              id={ids.days}
              type="number"
              min={1}
              max={60}
              className="tabular-nums"
              value={state.days}
              onChange={(e) => setForm({ ...state, days: e.target.value })}
              {...fieldAria(ids.days, { description: true })}
            />
          </Field>
          <div className="flex items-start gap-2">
            <input
              id={ids.autoStart}
              type="checkbox"
              className="mt-1 size-4"
              checked={state.autoStart}
              onChange={(e) => setForm({ ...state, autoStart: e.target.checked })}
              aria-describedby={`${ids.autoStart}-hint`}
            />
            <div className="grid gap-1">
              <label htmlFor={ids.autoStart} className="text-sm font-medium">
                {m.round_reverification_auto_start()}
              </label>
              <p id={`${ids.autoStart}-hint`} className="text-sm text-muted-foreground">
                {m.round_reverification_auto_start_hint()}
              </p>
            </div>
          </div>
          <ErrorAlert error={save.error} />
          <Button type="submit" loading={save.isPending} disabled={!valid}>
            {m.round_reverification_save()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
