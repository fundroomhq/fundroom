import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  Field,
  fieldAria,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  LoadingState,
  Separator,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import * as z from "zod/mini";
import { type Enrolment, TotpEnrolmentForm } from "../components/account/security-cards.js";
import { CopyButton } from "../components/copy-button.js";
import { ErrorAlert } from "../components/error-alert.js";
import { describeError, isApiError, isCode } from "../lib/api.js";
import { useWebConfig } from "../lib/config-context.js";
import {
  beginEnrolPasskey,
  beginEnrolTotp,
  confirmEnrolTotp,
  ENROL_SESSION_KEY,
  enrolSessionQuery,
  finishEnrolPasskey,
  startEnrol,
  verifyEnrol,
} from "../lib/platform-enrol-queries.js";
import { isWebAuthnCancelled, register, webAuthnSupported } from "../lib/webauthn.js";
import { m } from "../paraglide/messages.js";

const searchSchema = z.object({
  token: z.catch(z.optional(z.string()), undefined),
});

/*
 * `/platform/enrol?token=…` (E3.10 FR2) — outside the console layout (`platform_`): the visitor
 * has no operator session and may have no account at all. Four steps: the address the link was
 * made for → the code emailed to it → one factor (authenticator app or passkey) through the
 * enrolment-only endpoints → "ask your operator to grant you". The token stays in memory only
 * (never in storage), and a finished or expired enrolment session sends the page back to the
 * start rather than to an error.
 */
export const Route = createFileRoute("/platform_/enrol")({
  validateSearch: searchSchema,
  component: EnrolPage,
});

type Step =
  | { kind: "email" }
  | { kind: "code"; email: string }
  | { kind: "factor"; email: string }
  | { kind: "done"; email: string; recoveryCodes: string[] | null }
  | { kind: "already"; email: string };

function EnrolPage() {
  const { token } = Route.useSearch();
  // A session left over in this browser (a reload after the code) goes straight to the factor.
  const existing = useQuery(enrolSessionQuery);
  const [step, setStep] = useState<Step>({ kind: "email" });
  useEffect(() => {
    if (existing.data && step.kind === "email") {
      setStep({ kind: "factor", email: existing.data.email });
    }
  }, [existing.data, step.kind]);

  if (existing.isPending) {
    return (
      <Frame>
        <LoadingState label={m.common_loading()} />
      </Frame>
    );
  }
  if (step.kind === "factor") {
    return (
      <Frame>
        <FactorStep
          email={step.email}
          onDone={(recoveryCodes) => setStep({ kind: "done", email: step.email, recoveryCodes })}
          onExpired={() => setStep({ kind: "email" })}
        />
      </Frame>
    );
  }
  if (step.kind === "done" || step.kind === "already") {
    return (
      <Frame>
        <DoneStep
          email={step.email}
          already={step.kind === "already"}
          recoveryCodes={step.kind === "done" ? step.recoveryCodes : null}
        />
      </Frame>
    );
  }
  if (token === undefined || token === "") {
    return (
      <Frame>
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.platform_enrol_no_token_title()}</AlertTitle>
          <AlertDescription>{m.platform_enrol_no_token_body()}</AlertDescription>
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      {step.kind === "email" ? (
        <EmailStep token={token} onSent={(email) => setStep({ kind: "code", email })} />
      ) : (
        <CodeStep
          token={token}
          email={step.email}
          onBack={() => setStep({ kind: "email" })}
          onVerified={() => setStep({ kind: "factor", email: step.email })}
          onAlready={() => setStep({ kind: "already", email: step.email })}
        />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const config = useWebConfig();
  return (
    <main id="main" className="flex min-h-svh items-start justify-center bg-muted/30 p-4 sm:p-8">
      <div className="w-full max-w-md space-y-4 pt-8">
        <p className="text-sm font-semibold">{config.instanceName}</p>
        <Card>
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

function EmailStep({ token, onSent }: { token: string; onSent: (email: string) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const start = useMutation({
    mutationFn: (address: string) => startEnrol(token, address),
    onSuccess: (_data, address) => onSent(address),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (address !== "" && !start.isPending) start.mutate(address);
  };
  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.platform_enrol_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.platform_enrol_body()}</p>
      </div>
      <ErrorAlert error={start.error} />
      <Field id={id} label={m.platform_enrol_email()} description={m.platform_enrol_email_help()}>
        <Input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...fieldAria(id, { description: true })}
        />
      </Field>
      <Button
        type="submit"
        className="w-full"
        loading={start.isPending}
        disabled={email.trim() === ""}
      >
        {m.platform_enrol_send()}
      </Button>
    </form>
  );
}

function CodeStep({
  token,
  email,
  onBack,
  onVerified,
  onAlready,
}: {
  token: string;
  email: string;
  onBack: () => void;
  onVerified: () => void;
  onAlready: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const verify = useMutation({
    mutationFn: (c: string) => verifyEnrol(token, email, c),
    onSuccess: (session) => {
      queryClient.setQueryData(ENROL_SESSION_KEY, session);
      onVerified();
    },
    onError: (error) => {
      setCode("");
      // The account already has a factor: nothing to enrol, the grant is next.
      if (conflictReason(error) === "already_enrolled") onAlready();
    },
  });
  // One sentence for every wrong part (token, address or code): the server does not say which.
  const inlineError =
    verify.isError && isCode(verify.error, "invalid_code", "expired", "too_many_attempts")
      ? isCode(verify.error, "invalid_code")
        ? m.platform_enrol_code_invalid()
        : describeError(verify.error).body
      : undefined;
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) verify.mutate(code);
      }}
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.platform_enrol_code_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.platform_enrol_code_body({ email })}</p>
      </div>
      {verify.isError && inlineError === undefined ? <ErrorAlert error={verify.error} /> : null}
      <Field id={id} label={m.verify_code()} error={inlineError}>
        <InputOTP
          id={id}
          maxLength={6}
          value={code}
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          disabled={verify.isPending}
          onChange={setCode}
          onComplete={(c: string) => verify.mutate(c)}
          {...fieldAria(id, { error: inlineError !== undefined })}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </Field>
      <Button
        type="submit"
        className="w-full"
        loading={verify.isPending}
        disabled={code.length < 6}
      >
        {m.common_continue()}
      </Button>
      <Button type="button" variant="link" size="sm" onClick={onBack}>
        {m.platform_enrol_change_email()}
      </Button>
    </form>
  );
}

function conflictReason(error: unknown): string | undefined {
  if (!isCode(error, "conflict") || !isApiError(error)) return undefined;
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  const reason = source["reason"];
  return typeof reason === "string" ? reason : undefined;
}

function FactorStep({
  email,
  onDone,
  onExpired,
}: {
  email: string;
  onDone: (recoveryCodes: string[] | null) => void;
  onExpired: () => void;
}) {
  const config = useWebConfig();
  const queryClient = useQueryClient();
  const [enrolment, setEnrolment] = useState<Enrolment | undefined>();
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    void webAuthnSupported().then(setPasskeys);
  }, []);
  // Both writes end the enrolment session on success; a 404 means it already had (15 min).
  const ended = (error: unknown) => {
    if (isCode(error, "not_found")) {
      void queryClient.removeQueries({ queryKey: ENROL_SESSION_KEY });
      onExpired();
    }
  };
  const finished = (recoveryCodes: string[] | null) => {
    queryClient.removeQueries({ queryKey: ENROL_SESSION_KEY });
    onDone(recoveryCodes);
  };
  const totp = useMutation({ mutationFn: beginEnrolTotp, onSuccess: setEnrolment, onError: ended });
  const confirm = useMutation({
    mutationFn: confirmEnrolTotp,
    onSuccess: (data) => finished(data.recoveryCodes),
    onError: ended,
  });
  const passkey = useMutation({
    mutationFn: async () => {
      const begin = await beginEnrolPasskey();
      const response = await register(begin.options);
      return finishEnrolPasskey({ challengeId: begin.challengeId, response });
    },
    onSuccess: () => finished(null),
    onError: ended,
  });
  const passkeyOn = passkeys && config.auth.methods.includes("passkey");
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.platform_enrol_factor_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.platform_enrol_factor_body({ email })}</p>
      </div>
      {enrolment ? (
        <TotpEnrolmentForm
          enrolment={enrolment}
          pending={confirm.isPending}
          error={confirm.isError ? confirm.error : undefined}
          onConfirm={(c) => confirm.mutate(c)}
        />
      ) : (
        <div className="space-y-3">
          {passkeyOn ? (
            <>
              <ErrorAlert
                error={
                  passkey.isError && !isWebAuthnCancelled(passkey.error) ? passkey.error : undefined
                }
              />
              <Button
                type="button"
                className="w-full"
                loading={passkey.isPending}
                onClick={() => passkey.mutate()}
              >
                <KeyRound aria-hidden="true" />
                {m.platform_enrol_passkey()}
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" />
                {m.login_or()}
                <Separator className="flex-1" />
              </div>
            </>
          ) : null}
          <ErrorAlert error={totp.error} />
          <Button
            type="button"
            variant={passkeyOn ? "outline" : "default"}
            className="w-full"
            loading={totp.isPending}
            onClick={() => totp.mutate()}
          >
            <ShieldCheck aria-hidden="true" />
            {m.platform_enrol_totp()}
          </Button>
        </div>
      )}
    </div>
  );
}

function DoneStep({
  email,
  already,
  recoveryCodes,
}: {
  email: string;
  already: boolean;
  recoveryCodes: string[] | null;
}) {
  const command = `fundroom operator grant ${email}`;
  return (
    <div className="space-y-4" role="status">
      <h1 className="text-xl font-semibold">
        {already ? m.platform_enrol_already_title() : m.platform_enrol_done_title()}
      </h1>
      <p className="text-sm text-muted-foreground">
        {already ? m.platform_enrol_already_body() : m.platform_enrol_done_body()}
      </p>
      <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-sm">
        {command}
      </code>
      <CopyButton value={command} label={m.common_copy()} />
      {recoveryCodes === null ? null : (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">{m.totp_recovery_title()}</h2>
          <p className="text-sm text-muted-foreground">{m.totp_recovery_body()}</p>
          <ul className="grid grid-cols-2 gap-1 rounded bg-muted p-3 font-mono text-sm">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <CopyButton value={recoveryCodes.join("\n")} label={m.common_copy()} />
        </div>
      )}
    </div>
  );
}
