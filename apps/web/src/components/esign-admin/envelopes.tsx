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
  Field,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api, call } from "../../lib/api.js";
import {
  canResync,
  describeESignError,
  downloadEnvelopeArtifact,
  ENVELOPE_TABS,
  type EnvelopeTab,
  ESIGN_KEY,
  ESIGN_PURPOSES,
  type ESignEnvelope,
  type ESignPurpose,
  envelopeErrorLabel,
  envelopeStatusLabel,
  envelopeStatusVariant,
  envelopeTabLabel,
  esignEnvelopeQuery,
  esignEnvelopesQuery,
  isLiveAtVendor,
  isOpenEnvelope,
  purposeLabel,
  signerStatusLabel,
} from "../../lib/esign-queries.js";
import { formatDateTime } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { NativeSelect } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * Every envelope the workspace sent (E3.5): NDAs from the portal's acceptance gate and
 * subscription agreements from round closing. Status comes from the vendor's API (a callback
 * only wakes the sync; nothing in it is trusted), so the one lever here besides void is
 * "check status now" — rate-limited server-side to 10 a minute per workspace.
 */
export function EnvelopesCard({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<EnvelopeTab>("all");
  const [purpose, setPurpose] = useState<ESignPurpose | "">("");
  const purposeId = useId();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.esign_envelopes_title()}</CardTitle>
        <CardDescription>{m.esign_envelopes_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs">
          <Field id={purposeId} label={m.esign_filter_purpose()}>
            <NativeSelect
              id={purposeId}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as ESignPurpose | "")}
            >
              <option value="">{m.esign_filter_all_purposes()}</option>
              {ESIGN_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {purposeLabel(p)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as EnvelopeTab)}>
          <TabsList aria-label={m.esign_envelopes_tabs()} className="h-auto flex-wrap">
            {ENVELOPE_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {envelopeTabLabel(t)}
              </TabsTrigger>
            ))}
          </TabsList>
          {ENVELOPE_TABS.map((t) => (
            <TabsContent key={t} value={t}>
              {t === tab ? (
                <EnvelopesTable
                  tab={t}
                  purpose={purpose === "" ? undefined : purpose}
                  canManage={canManage}
                />
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function EnvelopesTable({
  tab,
  purpose,
  canManage,
}: {
  tab: EnvelopeTab;
  purpose: ESignPurpose | undefined;
  canManage: boolean;
}) {
  const list = useInfiniteQuery(esignEnvelopesQuery(tab, purpose));
  const [open, setOpen] = useState<ESignEnvelope>();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isPending) return <LoadingState lines={3} label={m.common_loading()} />;
  if (list.isError) return <ErrorAlert error={list.error} />;
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{m.esign_envelopes_empty()}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={m.esign_envelopes_table({ tab: envelopeTabLabel(tab) })}>
            <TableHeader>
              <TableRow>
                <TableHead>{m.esign_col_title()}</TableHead>
                <TableHead>{m.esign_col_signer()}</TableHead>
                <TableHead>{m.esign_col_purpose()}</TableHead>
                <TableHead>{m.esign_col_status()}</TableHead>
                <TableHead>{m.esign_col_sent()}</TableHead>
                <TableHead>{m.esign_col_completed()}</TableHead>
                <TableHead>
                  <span className="sr-only">{m.common_actions()}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((envelope) => (
                <TableRow key={envelope.id}>
                  <TableCell className="font-medium">{envelope.title}</TableCell>
                  <TableCell>
                    <div>{envelope.signerName}</div>
                    <div className="text-xs text-muted-foreground">{envelope.signerEmail}</div>
                  </TableCell>
                  <TableCell>{purposeLabel(envelope.purpose)}</TableCell>
                  <TableCell>
                    <Badge variant={envelopeStatusVariant(envelope.status)}>
                      {envelopeStatusLabel(envelope.status)}
                    </Badge>
                    {envelope.signerStatus === null || !isOpenEnvelope(envelope.status) ? null : (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {signerStatusLabel(envelope.signerStatus)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {envelope.sentAt === null ? "—" : formatDateTime(envelope.sentAt)}
                  </TableCell>
                  <TableCell>
                    {envelope.completedAt === null ? "—" : formatDateTime(envelope.completedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={m.esign_details_for({
                        title: envelope.title,
                        signer: envelope.signerName,
                      })}
                      onClick={() => setOpen(envelope)}
                    >
                      {m.esign_details()}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {m.common_load_more()}
        </Button>
      ) : null}
      {open === undefined ? null : (
        <EnvelopeDialog row={open} canManage={canManage} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}

function EnvelopeDialog({
  row,
  canManage,
  onClose,
}: {
  row: ESignEnvelope;
  canManage: boolean;
  onClose: () => void;
}) {
  const detail = useQuery({ ...esignEnvelopeQuery(row.id), placeholderData: row });
  const envelope = detail.data ?? row;
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ESIGN_KEY });

  const sync = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/esign/envelopes/{id}/sync", { params: { path: { id: envelope.id } } })),
    onSuccess: () => {
      toast.success(m.esign_sync_queued());
      void invalidate();
    },
  });
  const voidIt = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/esign/envelopes/{id}/void", {
          params: { path: { id: envelope.id } },
          body: { reason: reason.trim() },
        }),
      ),
    onSuccess: (result) => {
      toast.success(m.esign_voided_ok());
      queryClient.setQueryData(esignEnvelopeQuery(envelope.id).queryKey, result);
      setVoiding(false);
      setReason("");
      void invalidate();
    },
  });
  const download = useMutation({
    mutationFn: (which: "signed" | "certificate") => downloadEnvelopeArtifact(envelope, which),
    onError: (error) => toast.error(describeESignError(error)),
  });

  // An `error` envelope the vendor accepted may still be live there: void and resync apply.
  const open = isLiveAtVendor(envelope);
  const canSync = canResync(envelope);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{envelope.title}</DialogTitle>
          <DialogDescription>{purposeLabel(envelope.purpose)}</DialogDescription>
        </DialogHeader>
        {detail.isError ? <ErrorAlert error={detail.error} /> : null}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{m.esign_col_status()}</dt>
          <dd>
            <Badge variant={envelopeStatusVariant(envelope.status)}>
              {envelopeStatusLabel(envelope.status)}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">{m.esign_col_signer()}</dt>
          <dd>
            {envelope.signerName}{" "}
            <span className="text-muted-foreground">{envelope.signerEmail}</span>
          </dd>
          <dt className="text-muted-foreground">{m.esign_signer_status()}</dt>
          <dd>{envelope.signerStatus === null ? "—" : signerStatusLabel(envelope.signerStatus)}</dd>
          <dt className="text-muted-foreground">{m.esign_created()}</dt>
          <dd>{formatDateTime(envelope.createdAt)}</dd>
          <dt className="text-muted-foreground">{m.esign_col_sent()}</dt>
          <dd>{envelope.sentAt === null ? "—" : formatDateTime(envelope.sentAt)}</dd>
          <dt className="text-muted-foreground">{m.esign_col_completed()}</dt>
          <dd>{envelope.completedAt === null ? "—" : formatDateTime(envelope.completedAt)}</dd>
          <dt className="text-muted-foreground">{m.esign_vaulted()}</dt>
          <dd>
            {envelope.vaultedDocumentId === null ? m.esign_vaulted_no() : m.esign_vaulted_yes()}
          </dd>
        </dl>
        {envelope.errorCode === null ? null : (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.esign_envelope_error_title()}</AlertTitle>
            <AlertDescription>
              <p>{envelopeErrorLabel(envelope.errorCode)}</p>
              {envelope.status === "error" && open ? (
                <p>{m.esign_envelope_live_at_vendor()}</p>
              ) : null}
              <p className="font-mono text-xs">{envelope.errorCode}</p>
            </AlertDescription>
          </Alert>
        )}
        {envelope.status === "completed" && !envelope.hasSigned && envelope.errorCode === null ? (
          <p className="text-sm text-muted-foreground">{m.esign_collecting()}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {envelope.hasSigned ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={download.isPending && download.variables === "signed"}
              onClick={() => download.mutate("signed")}
            >
              <Download aria-hidden="true" />
              {m.esign_download_signed()}
            </Button>
          ) : null}
          {envelope.hasCertificate ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={download.isPending && download.variables === "certificate"}
              onClick={() => download.mutate("certificate")}
            >
              <Download aria-hidden="true" />
              {m.esign_download_certificate()}
            </Button>
          ) : null}
          {canManage && canSync ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={sync.isPending}
              onClick={() => sync.mutate()}
            >
              {m.esign_sync()}
            </Button>
          ) : null}
          {canManage && open && !voiding ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => setVoiding(true)}>
              {m.esign_void()}
            </Button>
          ) : null}
        </div>
        {sync.isError ? <ErrorAlert error={sync.error} /> : null}
        {voiding ? (
          <form
            className="space-y-3 rounded-md border p-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (reason.trim() !== "") voidIt.mutate();
            }}
          >
            <p className="text-sm">{m.esign_void_body()}</p>
            <Field id={reasonId} label={m.esign_void_reason()} required>
              <Textarea
                id={reasonId}
                rows={2}
                maxLength={500}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {voidIt.isError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{m.esign_void_failed()}</AlertTitle>
                <AlertDescription>{describeESignError(voidIt.error)}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                loading={voidIt.isPending}
                disabled={reason.trim() === ""}
              >
                {m.esign_void_submit()}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setVoiding(false);
                  voidIt.reset();
                }}
              >
                {m.common_cancel()}
              </Button>
            </div>
          </form>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_close()}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
