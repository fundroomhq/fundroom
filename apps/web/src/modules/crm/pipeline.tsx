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
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  type AllocationView,
  type CommitmentSummary,
  callAs,
  crmApi,
  crmContactsQuery,
  crmOrganizationsQuery,
  crmPipelineQuery,
  type PipelineItem,
  type PipelineStage,
  type RoundSummary,
  roundAllocationQuery,
  roundsQuery,
} from "../../lib/crm-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { itemSubjectName, nameOfMembership, OwnerMark, peopleOf, usePeople } from "./common.js";
import { commitmentStatusLabel, formatMoney } from "./format.js";
import { ReconciliationPanel } from "./reconciliation.js";

/*
 * The pipeline board (§W "crm"). Columns are stages in `position` order; a card is one
 * `crm.pipeline_item`.
 *
 * The board is deliberately **not** drag-and-drop. Every card carries a "Move to" select,
 * which is one tab stop, works with a screen reader and a keyboard, and is the same control in
 * jsdom as in a browser. A Kanban that can only be operated with a mouse would fail design/07
 * before it failed a test.
 *
 * Committed money comes from the round module and is joined here, in the browser, by
 * commitment id (§D1: the modules never read each other's tables). Both round lookups retry
 * nothing: the round module may be off, in which case the selector keeps only "All" and
 * "No round" and the cards show forecasts alone.
 */

const ALL = "all";
const NO_ROUND = "none";

function byPosition(a: PipelineStage, b: PipelineStage): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

function CommitmentLine({
  commitment,
  currency,
}: {
  commitment: CommitmentSummary | undefined;
  currency: string | null;
}) {
  if (commitment === undefined) {
    return <p className="text-xs text-muted-foreground">{m.crm_card_commitment_missing()}</p>;
  }
  return (
    <p className="text-xs">
      {m.crm_card_commitment({
        amount: formatMoney(commitment.amount, currency),
        status: commitmentStatusLabel(commitment.status),
      })}
    </p>
  );
}

function PipelineCard({
  item,
  stages,
  currency,
  ownerName,
  commitment,
  showCommitment,
  canManage,
}: {
  item: PipelineItem;
  stages: readonly PipelineStage[];
  currency: string | null;
  ownerName: string | undefined;
  commitment: CommitmentSummary | undefined;
  showCommitment: boolean;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const name = itemSubjectName(item);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["crm"] });
  };

  const move = useGuardedMutation({
    mutationFn: (stageId: string) =>
      callAs<PipelineItem>(
        crmApi().PATCH("/crm/pipeline/{id}", {
          params: { path: { id: item.id } },
          body: { stageId },
        }),
      ),
    onSuccess: () => {
      toast.success(m.crm_item_moved({ name }));
      invalidate();
    },
  });

  const remove = useGuardedMutation({
    mutationFn: () =>
      callAs<unknown>(crmApi().DELETE("/crm/pipeline/{id}", { params: { path: { id: item.id } } })),
    onSuccess: () => {
      toast.success(m.crm_item_removed({ name }));
      invalidate();
    },
  });

  return (
    <li className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            {item.contact === null ? m.crm_subject_organization() : m.crm_subject_contact()}
          </p>
        </div>
        <OwnerMark name={ownerName} />
      </div>
      <p className="mt-2 text-sm tabular-nums">
        {m.crm_card_forecast({ amount: formatMoney(item.amount, item.currency ?? currency) })}
      </p>
      {showCommitment && item.commitmentId !== null ? (
        <CommitmentLine commitment={commitment} currency={currency} />
      ) : null}
      {canManage ? (
        <div className="mt-3 flex items-end gap-2">
          <NativeSelect
            aria-label={m.crm_move_label({ name })}
            className="h-8 text-xs"
            value={item.stageId}
            disabled={move.isPending}
            onChange={(e) => move.mutate(e.target.value)}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </NativeSelect>
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.crm_remove_item({ name })}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            }
            title={m.crm_remove_item({ name })}
            description={m.crm_remove_item_body()}
            confirmLabel={m.common_remove()}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      ) : null}
      <ErrorAlert error={move.error ?? remove.error} />
    </li>
  );
}

interface AddForm {
  subject: "contact" | "organization";
  contactId: string;
  organizationId: string;
  stageKey: string;
  amount: string;
  currency: string;
  ownerMembershipId: string;
}

function AddItemDialog({
  stages,
  roundId,
  defaultCurrency,
}: {
  stages: readonly PipelineStage[];
  roundId: string | undefined;
  defaultCurrency: string;
}) {
  const [open, setOpen] = useState(false);
  const base = useId();
  const queryClient = useQueryClient();
  const contacts = useQuery(crmContactsQuery());
  const organizations = useQuery(crmOrganizationsQuery());
  const people = usePeople({ kind: "staff" });
  const [form, setForm] = useState<AddForm>({
    subject: "contact",
    contactId: "",
    organizationId: "",
    stageKey: "",
    amount: "",
    currency: defaultCurrency,
    ownerMembershipId: "",
  });

  const create = useGuardedMutation({
    mutationFn: () =>
      callAs<PipelineItem>(
        crmApi().POST("/crm/pipeline", {
          body: {
            ...(roundId === undefined ? {} : { roundId }),
            ...(form.subject === "contact"
              ? { contactId: form.contactId }
              : { organizationId: form.organizationId }),
            ...(form.stageKey === "" ? {} : { stageKey: form.stageKey }),
            ...(form.amount.trim() === ""
              ? {}
              : { amount: form.amount.trim(), currency: form.currency.trim().toUpperCase() }),
            ...(form.ownerMembershipId === "" ? {} : { ownerMembershipId: form.ownerMembershipId }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.crm_item_added());
      setOpen(false);
      setForm({
        subject: "contact",
        contactId: "",
        organizationId: "",
        stageKey: "",
        amount: "",
        currency: defaultCurrency,
        ownerMembershipId: "",
      });
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.crm_add_item()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.crm_add_item()}</DialogTitle>
            <DialogDescription>{m.crm_add_item_body()}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={create.error} />
          <Field id={`${base}-subject`} label={m.crm_field_subject()}>
            <NativeSelect
              id={`${base}-subject`}
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value as AddForm["subject"] })}
            >
              <option value="contact">{m.crm_subject_contact()}</option>
              <option value="organization">{m.crm_subject_organization()}</option>
            </NativeSelect>
          </Field>
          {form.subject === "contact" ? (
            <Field id={`${base}-contact`} label={m.crm_field_contact()} required>
              <NativeSelect
                id={`${base}-contact`}
                required
                value={form.contactId}
                onChange={(e) => setForm({ ...form, contactId: e.target.value })}
              >
                <option value="">{m.crm_choose_contact()}</option>
                {(contacts.data?.contacts ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <Field id={`${base}-org`} label={m.crm_field_organization()} required>
              <NativeSelect
                id={`${base}-org`}
                required
                value={form.organizationId}
                onChange={(e) => setForm({ ...form, organizationId: e.target.value })}
              >
                <option value="">{m.crm_choose_organization()}</option>
                {(organizations.data?.organizations ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field id={`${base}-stage`} label={m.crm_field_stage()}>
            <NativeSelect
              id={`${base}-stage`}
              value={form.stageKey}
              onChange={(e) => setForm({ ...form, stageKey: e.target.value })}
            >
              <option value="">{m.crm_stage_default()}</option>
              {stages.map((s) => (
                <option key={s.id} value={s.key}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${base}-amount`}
              label={m.crm_field_amount()}
              description={m.crm_field_amount_help()}
            >
              <Input
                id={`${base}-amount`}
                type="text"
                inputMode="decimal"
                value={form.amount}
                {...fieldAria(`${base}-amount`, { description: true })}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field id={`${base}-currency`} label={m.crm_field_currency()}>
              <Input
                id={`${base}-currency`}
                pattern="[A-Za-z]{3}"
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
          <Field id={`${base}-owner`} label={m.crm_field_owner()}>
            <NativeSelect
              id={`${base}-owner`}
              value={form.ownerMembershipId}
              onChange={(e) => setForm({ ...form, ownerMembershipId: e.target.value })}
            >
              <option value="">{m.crm_owner_none()}</option>
              {peopleOf(people).map((p) => (
                <option key={p.membershipId} value={p.membershipId}>
                  {p.displayName}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              {m.crm_add_item_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StageColumn({
  stage,
  items,
  stages,
  currency,
  people,
  commitments,
  showCommitment,
  canManage,
  headingId,
}: {
  stage: PipelineStage;
  items: readonly PipelineItem[];
  stages: readonly PipelineStage[];
  currency: string | null;
  people: ReturnType<typeof peopleOf>;
  commitments: readonly CommitmentSummary[];
  showCommitment: boolean;
  canManage: boolean;
  headingId: string;
}) {
  return (
    <section aria-labelledby={headingId} className="w-72 shrink-0 rounded-lg bg-muted/40 p-3">
      <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {stage.name}
        <span className="text-xs font-normal text-muted-foreground">
          {m.crm_stage_count({ count: String(items.length) })}
        </span>
        {stage.isTerminal ? <Badge variant="outline">{m.crm_stage_terminal()}</Badge> : null}
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{m.crm_stage_empty()}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <PipelineCard
              key={item.id}
              item={item}
              stages={stages}
              currency={currency}
              ownerName={item.ownerName ?? nameOfMembership(people, item.ownerMembershipId)}
              commitment={commitments.find((c) => c.id === item.commitmentId)}
              showCommitment={showCommitment}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function PipelineScreen({ canManage }: { canManage: boolean }) {
  const selectId = useId();
  const headingBase = useId();
  const [choice, setChoice] = useState<string>(ALL);
  const rounds = useQuery(roundsQuery);
  const roundList: readonly RoundSummary[] = rounds.data?.rounds ?? [];
  const roundId = choice === ALL || choice === NO_ROUND ? undefined : choice;
  const round = roundList.find((r) => r.id === roundId);

  const pipeline = useQuery(crmPipelineQuery(roundId));
  const people = usePeople({ kind: "staff" });
  const allocation = useQuery({
    ...roundAllocationQuery(roundId ?? ""),
    enabled: roundId !== undefined,
  });

  const stages = [...(pipeline.data?.stages ?? [])].sort(byPosition);
  const allItems = pipeline.data?.items ?? [];
  // "No round" needs no server support: the unfiltered board already has every item, so the
  // choice is a filter in the browser rather than a magic value in the query string.
  const items = choice === NO_ROUND ? allItems.filter((i) => i.roundId === null) : allItems;
  const allocationView: AllocationView | undefined = allocation.data ?? undefined;
  const commitments = allocationView?.commitments ?? [];
  const currency = round?.currency ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.crm_pipeline_title()}
        description={m.crm_pipeline_subtitle()}
        actions={
          canManage && stages.length > 0 ? (
            <AddItemDialog
              stages={stages}
              roundId={roundId}
              defaultCurrency={round?.currency ?? "USD"}
            />
          ) : null
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={selectId} className="text-sm font-medium">
            {m.crm_round_filter()}
          </label>
          <NativeSelect
            id={selectId}
            className="w-64"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value={ALL}>{m.crm_round_all()}</option>
            <option value={NO_ROUND}>{m.crm_round_none()}</option>
            {roundList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {rounds.isError ? (
          <p className="text-sm text-muted-foreground">{m.crm_rounds_unavailable()}</p>
        ) : null}
      </div>
      {pipeline.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {pipeline.isError ? <ErrorAlert error={pipeline.error} /> : null}
      {roundId !== undefined ? (
        <ReconciliationPanel round={round} items={items} allocation={allocationView} />
      ) : null}
      {pipeline.data ? (
        stages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.crm_pipeline_no_stages()}</p>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {stages.map((stage) => (
              <StageColumn
                key={stage.id}
                stage={stage}
                stages={stages}
                items={items.filter((i) => i.stageId === stage.id)}
                currency={currency}
                people={peopleOf(people)}
                commitments={commitments}
                showCommitment={roundId !== undefined}
                canManage={canManage}
                headingId={`${headingBase}-${stage.id}`}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
