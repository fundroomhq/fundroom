import type { FundRoomSchemas } from "@fundroom/sdk";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  LoadingState,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, call, describeError } from "../../lib/api.js";
import { refreshSession, totpQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * Account-security cards shared by the security settings screen and the operator enrolment page
 * (E3.10 FR2: a new operator enrols a factor before they are granted).
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  footer,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_cancel()}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button type="button" variant="destructive" loading={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- TOTP --------------------------------------------------------------------------------------

export type Enrolment = FundRoomSchemas["TotpEnrolment"];

export function TotpCard() {
  const queryClient = useQueryClient();
  const status = useQuery(totpQuery);
  const [enrolment, setEnrolment] = useState<Enrolment | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: totpQuery.queryKey });
    void refreshSession(queryClient);
  };

  const enrol = useGuardedMutation({
    mutationFn: () => call(api().POST("/auth/totp/enrol")),
    onSuccess: (data) => setEnrolment(data),
    onError: (error) => toast.error(describeError(error).title),
  });
  const confirm = useGuardedMutation<FundRoomSchemas["RecoveryCodes"], string>({
    mutationFn: (c) => call(api().POST("/auth/totp/enrol/confirm", { body: { code: c } })),
    onSuccess: (data) => {
      setEnrolment(undefined);
      setRecoveryCodes(data.recoveryCodes);
      invalidate();
    },
  });
  const regenerate = useGuardedMutation({
    mutationFn: () => call(api().POST("/auth/totp/recovery-codes")),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const disable = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/auth/totp")),
    onSuccess: () => {
      toast.success(m.totp_disabled());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  return (
    <SectionCard
      title={m.totp_title()}
      description={m.totp_subtitle()}
      action={
        status.data?.enrolled ? (
          <Badge variant="success">
            <ShieldCheck aria-hidden="true" />
            {m.totp_on()}
          </Badge>
        ) : null
      }
    >
      {status.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
      {status.isError ? <ErrorAlert error={status.error} /> : null}
      {status.data && !status.data.enrolled && !enrolment ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{m.totp_off_body()}</p>
          <Button type="button" loading={enrol.isPending} onClick={() => enrol.mutate()}>
            {m.totp_enable()}
          </Button>
        </div>
      ) : null}
      {enrolment ? (
        <TotpEnrolmentForm
          enrolment={enrolment}
          pending={confirm.isPending}
          error={confirm.isError ? confirm.error : undefined}
          onConfirm={(c) => confirm.mutate(c)}
          onCancel={() => setEnrolment(undefined)}
        />
      ) : null}
      {status.data?.enrolled ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {m.totp_recovery_left({ count: String(status.data.recoveryCodesLeft) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              {m.totp_regenerate()}
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  {m.totp_disable()}
                </Button>
              }
              title={m.totp_disable_title()}
              description={m.totp_disable_body()}
              confirmLabel={m.totp_disable()}
              pending={disable.isPending}
              onConfirm={() => disable.mutate()}
            />
          </div>
        </div>
      ) : null}
      <Dialog
        open={recoveryCodes !== undefined}
        onOpenChange={(open) => {
          if (!open) setRecoveryCodes(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.totp_recovery_title()}</DialogTitle>
            <DialogDescription>{m.totp_recovery_body()}</DialogDescription>
          </DialogHeader>
          <ul className="grid grid-cols-2 gap-1 rounded bg-muted p-3 font-mono text-sm">
            {(recoveryCodes ?? []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <DialogFooter>
            <CopyButton value={(recoveryCodes ?? []).join("\n")} label={m.common_copy()} />
            <DialogClose asChild>
              <Button type="button">{m.totp_recovery_saved()}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

/**
 * The authenticator-app enrolment itself: the QR code (and the secret to type in), then the first
 * code. Shared by the security settings and the operator enrolment page, which point it at
 * different endpoints (`/auth/totp/*` vs `/platform/enrol/totp*`, same bodies and answers).
 */
export function TotpEnrolmentForm({
  enrolment,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  enrolment: Enrolment;
  pending: boolean;
  error: unknown;
  onConfirm: (code: string) => void;
  onCancel?: () => void;
}) {
  const [qr, setQr] = useState<string | undefined>();
  const [code, setCode] = useState("");
  useEffect(() => {
    let cancelled = false;
    void import("qrcode").then(async (QRCode) => {
      const url = await QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 192 });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);
  // A failed confirmation clears the code so the next one can be typed straight in.
  useEffect(() => {
    if (error !== undefined) setCode("");
  }, [error]);
  const codeId = "totp-confirm-code";
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (code.length >= 6) onConfirm(code);
      }}
    >
      <p className="text-sm">{m.totp_scan()}</p>
      <div className="flex flex-wrap items-start gap-4">
        {qr ? (
          <img src={qr} alt={m.totp_qr_alt()} width={192} height={192} className="rounded-md" />
        ) : (
          <LoadingState lines={1} label={m.common_loading()} />
        )}
        <div className="space-y-2 text-sm">
          <p>{m.totp_manual()}</p>
          <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
            {enrolment.secretBase32}
          </code>
          <CopyButton value={enrolment.secretBase32} label={m.common_copy()} />
        </div>
      </div>
      <Field
        id={codeId}
        label={m.totp_first_code()}
        error={error !== undefined ? describeError(error).body : undefined}
      >
        <InputOTP
          id={codeId}
          maxLength={6}
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          {...fieldAria(codeId, { error: error !== undefined })}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={pending} disabled={code.length < 6}>
          {m.totp_confirm()}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="outline" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
        )}
      </div>
    </form>
  );
}
