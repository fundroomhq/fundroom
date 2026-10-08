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
  Field,
  fieldAria,
  Input,
  LoadingState,
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
import { Check, Circle, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { call } from "../../lib/api.js";
import { esignConnectionQuery } from "../../lib/esign-queries.js";
import { formatDate } from "../../lib/format.js";
import {
  type ClosingStage,
  closingRefusal,
  closingStageLabel,
  describeClosingError,
  isLiveSignatureRequest,
  type PrefillSource,
  prefillSourceLabel,
  ROUND_CLOSING_PREFILL_SOURCES,
  type RoundClosingCommitment,
  type RoundClosingSettings,
  type RoundSignatureRequest,
  roundClosingQuery,
  SIGNABLE_COMMITMENT_STATUSES,
  signatureStatusLabel,
  signatureStatusVariant,
} from "../../lib/round-closing-queries.js";
import { api, type Round, type RoundSettings } from "../../lib/round-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { commitmentStatusLabel, commitmentStatusVariant, formatMoney } from "./format.js";

/*
 * Round closing, staff side (E3.5 §6, ADR-0053): the per-commitment checklist (documents sent →
 * signed → wired → confirmed), the round's roll-up in counts and money, and the three actions
 * that move a commitment along: send the subscription agreement for signature, void it, and
 * mark the money received.
 *
 * Everything shown is derived by the server. The buttons follow the server's rules (send only a
 * soft/verbal commitment with no open request; confirm only a wired one) so a refusal is rare —
 * and when one arrives anyway (no vendor, no template, a signer with no address) it names the
 * fix and links to where it is made.
 */

const SUMMARY_STAGES: readonly ClosingStage[] = [
  "not_started",
  "documents_sent",
  "signed",
  "wired",
  "confirmed",
];

function investorName(row: RoundClosingCommitment): string {
  return row.investor.name ?? m.round_unknown_member();
}

export function ClosingTab({
  round,
  canManage,
  canReadESign,
}: {
  round: Round;
  canManage: boolean;
  canReadESign: boolean;
}) {
  const closing = useQuery(roundClosingQuery(round.id));
  const connection = useQuery({ ...esignConnectionQuery, enabled: canReadESign && canManage });
  const data = closing.data;
  return (
    <div className="space-y-6">
      {connection.data?.connection === null ? (
        <Alert>
          <AlertTitle>{m.round_closing_no_vendor_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {m.round_closing_no_vendor_body()}{" "}
              <Link to="/admin/esign" className="font-medium underline underline-offset-4">
                {m.round_closing_connect_vendor()}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{m.round_closing_title()}</CardTitle>
          <CardDescription>{m.round_closing_hint()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {closing.isPending ? <LoadingState label={m.common_loading()} /> : null}
          {closing.isError ? <ErrorAlert error={closing.error} /> : null}
          {data === undefined ? null : (
            <>
              <ul
                aria-label={m.round_closing_summary_label()}
                className="grid list-none gap-3 sm:grid-cols-3 lg:grid-cols-5"
              >
                {SUMMARY_STAGES.map((stage) => (
                  <li key={stage} className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{closingStageLabel(stage)}</p>
                    <p className="text-2xl font-semibold tabular-nums">
                      {data.summary[stage].count}
                    </p>
                    <p className="text-sm tabular-nums">
                      {formatMoney(data.summary[stage].amount, data.currency)}
                    </p>
                  </li>
                ))}
              </ul>
              {data.summary.withdrawn.count > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {m.round_closing_withdrawn({
                    count: data.summary.withdrawn.count,
                    amount: formatMoney(data.summary.withdrawn.amount, data.currency),
                  })}
                </p>
              ) : null}
              {data.commitments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.round_commitments_empty()}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label={m.round_closing_table()}>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">{m.round_col_person()}</TableHead>
                        <TableHead scope="col">{m.round_col_amount()}</TableHead>
                        <TableHead scope="col">{m.round_col_status()}</TableHead>
                        <TableHead scope="col">{m.round_closing_col_checklist()}</TableHead>
                        <TableHead scope="col">{m.round_closing_col_signature()}</TableHead>
                        {canManage ? (
                          <TableHead scope="col">
                            <span className="sr-only">{m.common_actions()}</span>
                          </TableHead>
                        ) : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.commitments.map((row) => (
                        <ClosingRow key={row.commitmentId} row={row} canManage={canManage} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StageChips({ row }: { row: RoundClosingCommitment }) {
  const c = row.checklist;
  const steps = [
    {
      key: "sent",
      label: m.round_closing_step_sent(),
      done: c.documentsSent,
      at: c.documentsSentAt,
    },
    { key: "signed", label: m.round_closing_step_signed(), done: c.signed, at: c.signedAt },
    { key: "wired", label: m.round_closing_step_wired(), done: c.wired, at: c.wiredAt },
    {
      key: "confirmed",
      label: m.round_closing_step_confirmed(),
      done: c.confirmed,
      at: c.confirmedAt,
    },
  ];
  return (
    <ul
      className="flex list-none flex-wrap gap-1"
      aria-label={m.round_closing_steps_for({ name: investorName(row) })}
    >
      {steps.map((step) => (
        <li key={step.key}>
          <Badge variant={step.done ? "success" : "outline"} className="gap-1">
            {step.done ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
            {step.label}
            <span className="sr-only">
              {step.done ? m.round_closing_step_done() : m.round_closing_step_not_done()}
            </span>
            {step.done && step.at !== null ? (
              <span className="font-normal">{formatDate(step.at)}</span>
            ) : null}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ClosingRow({ row, canManage }: { row: RoundClosingCommitment; canManage: boolean }) {
  const request = row.signatureRequest;
  // An `error` request whose envelope reached the vendor may still be signed there: it is voided,
  // not sent again (the server refuses a second agreement with 409 `signature_request_open`).
  const open = isLiveSignatureRequest(request);
  const canSend = SIGNABLE_COMMITMENT_STATUSES.includes(row.status) && !open;
  const canConfirm = row.status === "wired" && !row.checklist.confirmed;
  return (
    <TableRow>
      <TableHead scope="row" className="font-medium">
        {investorName(row)}
      </TableHead>
      <TableCell className="tabular-nums">{formatMoney(row.amount, row.currency)}</TableCell>
      <TableCell>
        <Badge variant={commitmentStatusVariant(row.status)}>
          {commitmentStatusLabel(row.status)}
        </Badge>
      </TableCell>
      <TableCell>
        <StageChips row={row} />
      </TableCell>
      <TableCell>
        {request === null ? (
          <span className="text-sm text-muted-foreground">{m.round_closing_no_request()}</span>
        ) : (
          <div className="space-y-1">
            <Badge variant={signatureStatusVariant(request.status)}>
              {signatureStatusLabel(request.status)}
            </Badge>
            {request.status === "error" && open ? (
              <div className="text-xs text-muted-foreground">{m.round_closing_error_live()}</div>
            ) : null}
            <div className="text-xs text-muted-foreground">
              {m.round_closing_sent_on({ when: formatDate(request.sentAt) })}
            </div>
          </div>
        )}
      </TableCell>
      {canManage ? (
        <TableCell className="text-right">
          <div className="flex flex-wrap justify-end gap-1">
            {canSend ? <SendForSignatureDialog row={row} /> : null}
            {open && request !== null ? <VoidRequestDialog row={row} request={request} /> : null}
            {canConfirm ? <ConfirmCommitmentDialog row={row} /> : null}
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** A refusal from the closing routes, with the link to where it is fixed when there is one. */
function ClosingRefusalAlert({ error }: { error: unknown }) {
  const refusal = closingRefusal(error);
  if (refusal === undefined) return <ErrorAlert error={error} />;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.round_closing_refused()}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>{describeClosingError(error)}</p>
        {refusal === "esign_not_configured" || refusal === "esign_template_unsupported" ? (
          <p>
            <Link to="/admin/esign" className="font-medium underline underline-offset-4">
              {m.round_closing_go_to_esign()}
            </Link>
          </p>
        ) : null}
        {refusal === "subscription_template_missing" ? (
          <p>
            <Link
              to="/admin/$"
              params={{ _splat: "round/settings" }}
              className="font-medium underline underline-offset-4"
            >
              {m.round_closing_go_to_settings()}
            </Link>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function SendForSignatureDialog({ row }: { row: RoundClosingCommitment }) {
  const ids = { message: useId(), name: useId(), email: useId() };
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [signerName, setSignerName] = useState(row.investor.name ?? "");
  const [signerEmail, setSignerEmail] = useState("");
  // A member signs as themselves (the server ignores `signer` then); anyone else may need an
  // address typed in when the commitment recorded none.
  const askSigner = row.investor.membershipId === null;
  const queryClient = useQueryClient();
  const send = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<RoundSignatureRequest>("/round/commitments/{id}/signature-request", {
          params: { path: { id: row.commitmentId } },
          body: {
            ...(message.trim() === "" ? {} : { message: message.trim() }),
            ...(askSigner && signerEmail.trim() !== "" && signerName.trim() !== ""
              ? { signer: { name: signerName.trim(), email: signerEmail.trim() } }
              : {}),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_closing_sent_ok({ name: investorName(row) }));
      setOpen(false);
      setMessage("");
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  // An address without a name cannot be sent; no address means "use the one on record".
  const signerIncomplete = askSigner && signerEmail.trim() !== "" && signerName.trim() === "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) send.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          aria-label={m.round_closing_send_named({ name: investorName(row) })}
        >
          {m.round_closing_send()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!signerIncomplete) send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.round_closing_send_title({ name: investorName(row) })}</DialogTitle>
            <DialogDescription>
              {m.round_closing_send_body({ amount: formatMoney(row.amount, row.currency) })}
            </DialogDescription>
          </DialogHeader>
          <Field
            id={ids.message}
            label={m.round_closing_message()}
            description={m.round_closing_message_hint()}
          >
            <Textarea
              id={ids.message}
              rows={3}
              maxLength={2000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              {...fieldAria(ids.message, { description: true })}
            />
          </Field>
          {askSigner ? (
            <fieldset className="grid gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{m.round_closing_signer()}</legend>
              <p className="text-sm text-muted-foreground">{m.round_closing_signer_hint()}</p>
              <Field id={ids.name} label={m.round_closing_signer_name()}>
                <Input
                  id={ids.name}
                  value={signerName}
                  maxLength={200}
                  onChange={(e) => setSignerName(e.target.value)}
                />
              </Field>
              <Field id={ids.email} label={m.round_closing_signer_email()}>
                <Input
                  id={ids.email}
                  type="email"
                  value={signerEmail}
                  maxLength={320}
                  onChange={(e) => setSignerEmail(e.target.value)}
                />
              </Field>
            </fieldset>
          ) : null}
          {send.isError ? <ClosingRefusalAlert error={send.error} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={send.isPending} disabled={signerIncomplete}>
              {m.round_closing_send_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VoidRequestDialog({
  row,
  request,
}: {
  row: RoundClosingCommitment;
  request: RoundSignatureRequest;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const queryClient = useQueryClient();
  const voidIt = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<RoundSignatureRequest>("/round/signature-requests/{id}/void", {
          params: { path: { id: request.id } },
          body: reason.trim() === "" ? {} : { reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_closing_voided_ok({ name: investorName(row) }));
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
    onError: (error) => toast.error(describeClosingError(error)),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={voidIt.isPending}
          aria-label={m.round_closing_void_named({ name: investorName(row) })}
        >
          {m.round_closing_void()}
        </Button>
      }
      title={m.round_closing_void_title({ name: investorName(row) })}
      description={m.round_closing_void_body()}
      confirmLabel={m.round_closing_void()}
      pending={voidIt.isPending}
      onConfirm={() => voidIt.mutate()}
    >
      <Field id={reasonId} label={m.round_closing_void_reason()}>
        <Textarea
          id={reasonId}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

function ConfirmCommitmentDialog({ row }: { row: RoundClosingCommitment }) {
  const queryClient = useQueryClient();
  const confirm = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST<unknown>("/round/commitments/{id}/confirm", {
          params: { path: { id: row.commitmentId } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.round_closing_confirmed_ok({ name: investorName(row) }));
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
    onError: (error) => toast.error(describeClosingError(error)),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={confirm.isPending}
          aria-label={m.round_closing_confirm_named({ name: investorName(row) })}
        >
          {m.round_closing_confirm()}
        </Button>
      }
      title={m.round_closing_confirm_title({ name: investorName(row) })}
      description={
        row.investor.membershipId === null
          ? m.round_closing_confirm_body_no_member({
              amount: formatMoney(row.amount, row.currency),
            })
          : m.round_closing_confirm_body({ amount: formatMoney(row.amount, row.currency) })
      }
      confirmLabel={m.round_closing_confirm()}
      pending={confirm.isPending}
      onConfirm={() => confirm.mutate()}
    />
  );
}

// --- settings ---------------------------------------------------------------------------------

interface PrefillRow {
  readonly key: number;
  readonly field: string;
  readonly source: PrefillSource;
}

function rowsOf(prefill: Readonly<Record<string, PrefillSource>>): PrefillRow[] {
  return Object.entries(prefill).map(([field, source], i) => ({ key: i, field, source }));
}

export const MAX_PREFILL_FIELDS = 50;

/**
 * The subscription agreement's vendor-side template and what fills its fields. The template
 * ref is whatever the vendor calls it (a Documenso template id, a DocuSign template GUID); the
 * mapping is vendor field name → a fact this workspace knows, computed at send time.
 */
export function ClosingSettingsCard({ settings }: { settings: RoundSettings }) {
  const base = useId();
  const closing: RoundClosingSettings = settings.closing;
  const [templateRef, setTemplateRef] = useState(closing.subscriptionTemplateRef ?? "");
  const [templateRole, setTemplateRole] = useState(closing.templateRole);
  const [rows, setRows] = useState<PrefillRow[]>(() => rowsOf(closing.prefill));
  const [nextKey, setNextKey] = useState(rows.length);
  const queryClient = useQueryClient();
  const names = rows.map((r) => r.field.trim());
  const duplicate = names.find((n, i) => n !== "" && names.indexOf(n) !== i);
  const blank = rows.some((r) => r.field.trim() === "") || templateRole.trim() === "";
  const save = useGuardedMutation({
    mutationFn: () => {
      const prefill: Record<string, PrefillSource> = {};
      for (const row of rows) prefill[row.field.trim()] = row.source;
      return call(
        api().PATCH<RoundSettings>("/round/settings", {
          body: {
            closing: {
              subscriptionTemplateRef: templateRef.trim() === "" ? null : templateRef.trim(),
              templateRole: templateRole.trim(),
              prefill,
            },
          },
        }),
      );
    },
    onSuccess: () => {
      toast.success(m.round_closing_settings_saved());
      void queryClient.invalidateQueries({ queryKey: ["round"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_closing_settings_title()}</CardTitle>
        <CardDescription>{m.round_closing_settings_hint()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (duplicate === undefined && !blank) save.mutate();
          }}
        >
          <Field
            id={`${base}-template`}
            label={m.round_closing_template_ref()}
            description={m.round_closing_template_ref_hint()}
            className="max-w-md"
          >
            <Input
              id={`${base}-template`}
              value={templateRef}
              maxLength={200}
              spellCheck={false}
              className="font-mono"
              onChange={(e) => setTemplateRef(e.target.value)}
              {...fieldAria(`${base}-template`, { description: true })}
            />
          </Field>
          <Field
            id={`${base}-role`}
            label={m.round_closing_template_role()}
            description={m.round_closing_template_role_hint()}
            required
            className="max-w-md"
          >
            <Input
              id={`${base}-role`}
              value={templateRole}
              maxLength={100}
              required
              spellCheck={false}
              onChange={(e) => setTemplateRole(e.target.value)}
              {...fieldAria(`${base}-role`, { description: true })}
            />
          </Field>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{m.round_closing_prefill()}</legend>
            <p className="text-sm text-muted-foreground">{m.round_closing_prefill_hint()}</p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.round_closing_prefill_empty()}</p>
            ) : (
              <ul className="list-none space-y-2">
                {rows.map((row, i) => (
                  <li key={row.key} className="flex flex-wrap items-end gap-2">
                    <Field
                      id={`${base}-field-${row.key}`}
                      label={m.round_closing_prefill_field({ n: i + 1 })}
                      className="w-64"
                    >
                      <Input
                        id={`${base}-field-${row.key}`}
                        value={row.field}
                        maxLength={100}
                        spellCheck={false}
                        className="font-mono"
                        onChange={(e) =>
                          setRows((cur) =>
                            cur.map((r) =>
                              r.key === row.key ? { ...r, field: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field
                      id={`${base}-source-${row.key}`}
                      label={m.round_closing_prefill_source({ n: i + 1 })}
                      className="w-56"
                    >
                      <NativeSelect
                        id={`${base}-source-${row.key}`}
                        value={row.source}
                        onChange={(e) =>
                          setRows((cur) =>
                            cur.map((r) =>
                              r.key === row.key
                                ? { ...r, source: e.target.value as PrefillSource }
                                : r,
                            ),
                          )
                        }
                      >
                        {ROUND_CLOSING_PREFILL_SOURCES.map((s) => (
                          <option key={s} value={s}>
                            {prefillSourceLabel(s)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={m.round_closing_prefill_remove({ n: i + 1 })}
                      onClick={() => setRows((cur) => cur.filter((r) => r.key !== row.key))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.length >= MAX_PREFILL_FIELDS}
              onClick={() => {
                setRows((cur) => [...cur, { key: nextKey, field: "", source: "investor_name" }]);
                setNextKey((k) => k + 1);
              }}
            >
              <Plus aria-hidden="true" />
              {m.round_closing_prefill_add()}
            </Button>
          </fieldset>
          {duplicate === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {m.round_closing_prefill_duplicate({ field: duplicate })}
            </p>
          )}
          <ErrorAlert error={save.error} />
          <Button
            type="submit"
            loading={save.isPending}
            disabled={duplicate !== undefined || blank}
          >
            {m.round_closing_settings_save()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
