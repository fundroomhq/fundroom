import {
  Button,
  Field,
  fieldAria,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  LoadingState,
  Textarea,
} from "@fundroomhq/ui";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, describeError, isCode } from "../../lib/api.js";
import { useWebConfig } from "../../lib/config-context.js";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * The public "request access" form (E3.1). A stranger who is not a member leaves their name
 * and address, proves the address with a 6-digit code, and the request lands in the admins'
 * queue. Three steps on one route: details → code → "received".
 *
 * **Every answer is neutral.** The server replies to `start` identically whether the address is
 * new, already a member, rate-limited or caught by the honeypot (only an `expiresAt`, computed
 * the same way every time), and `verify` answers "received" whether or not a queue row was made.
 * `verify` takes the address plus the code: any unexpired code mailed to that address works, so
 * a resend (just another `start`) never invalidates a code already in the inbox. So the copy never says "you already have access" or
 * "your request was queued" — only "if it can be considered, the team will be in touch".
 *
 * **The honeypot** (`website`) is for bots that fill every field. It is off-screen, `inert`,
 * `aria-hidden` and out of the tab order, so neither a sighted visitor nor a screen reader ever
 * meets it; whatever it holds is sent, and the server turns a filled one into a silent decoy.
 *
 * No "are you accredited?" question: that is an open counsel question (§19 Q7), not a form field.
 */
export const Route = createFileRoute("/_auth/request-access")({ component: RequestAccessPage });

const NAME_MAX = 120;
const FIRM_MAX = 160;
const REASON_MAX = 2000;
const RESEND_COOLDOWN_S = 30;

/**
 * The shape the server's `z.email()` accepts (zod's default email pattern), so an address it
 * would refuse is caught beside the field instead of as a generic "check the form" alert.
 */
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u;

type Step = "details" | "code" | "received";

function RequestAccessPage() {
  const bootstrap = useBootstrap();
  const [unavailable, setUnavailable] = useState(false);

  if (bootstrap.isPending) return <LoadingState label={m.common_loading()} />;
  if (unavailable || bootstrap.data?.requestAccessEnabled !== true) return <Unavailable />;
  return (
    <RequestAccessFlow
      offering506b={bootstrap.data.workspace?.offeringStatus === "506b"}
      onUnavailable={() => setUnavailable(true)}
    />
  );
}

function RequestAccessFlow({
  offering506b,
  onUnavailable,
}: {
  offering506b: boolean;
  onUnavailable: () => void;
}) {
  const config = useWebConfig();
  const [step, setStep] = useState<Step>("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [firm, setFirm] = useState("");
  const [reason, setReason] = useState("");
  const [website, setWebsite] = useState("");
  // The address the codes were mailed to — what `verify` pairs with the code.
  const [sentTo, setSentTo] = useState("");
  const [emailError, setEmailError] = useState<string>();
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const ids = {
    name: useId(),
    email: useId(),
    firm: useId(),
    reason: useId(),
    website: useId(),
    code: useId(),
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const start = useMutation({
    mutationFn: () =>
      call(
        api().POST("/access-requests/start", {
          body: {
            email: email.trim(),
            name: name.trim(),
            ...(firm.trim() === "" ? {} : { firm: firm.trim() }),
            ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
            ...(website === "" ? {} : { website }),
          },
        }),
      ),
    onSuccess: () => {
      setSentTo(email.trim());
      setCode("");
      setCooldown(RESEND_COOLDOWN_S);
      setStep("code");
    },
    onError: (error) => {
      // The server 404s when requests were switched off after the page loaded.
      if (isCode(error, "not_found")) onUnavailable();
      // Name, firm and reason are bounded by the inputs themselves; the address is the field
      // the server can still refuse, so its refusal is shown there.
      if (isCode(error, "validation_failed")) setEmailError(m.requestaccess_email_invalid());
    },
  });
  const verify = useMutation({
    mutationFn: (c: string) =>
      call(api().POST("/access-requests/verify", { body: { email: sentTo, code: c } })),
    onSuccess: () => setStep("received"),
    onError: (error) => {
      setCode("");
      if (isCode(error, "not_found")) onUnavailable();
    },
  });

  if (step === "received") {
    return (
      <div className="space-y-4" role="status">
        <FocusedHeading>{m.requestaccess_received_title()}</FocusedHeading>
        <p className="text-sm text-muted-foreground">{m.requestaccess_received_body()}</p>
        <Button asChild variant="outline">
          <Link to="/login">{m.requestaccess_back_to_sign_in()}</Link>
        </Button>
      </div>
    );
  }

  if (step === "code") {
    // One generic refusal for unknown / wrong / expired / exhausted: they are indistinguishable.
    const inlineError =
      verify.isError && isCode(verify.error, "invalid_code")
        ? describeError(verify.error).body
        : undefined;
    const otherError = verify.isError && inlineError === undefined ? verify.error : start.error;
    return (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) verify.mutate(code);
        }}
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{m.requestaccess_code_title()}</h1>
          <p className="text-sm text-muted-foreground">
            {m.requestaccess_code_subtitle({ email: sentTo })}
          </p>
        </div>
        <ErrorAlert error={otherError} />
        <Field id={ids.code} label={m.verify_code()} error={inlineError}>
          <InputOTP
            id={ids.code}
            maxLength={6}
            value={code}
            autoFocus
            autoComplete="one-time-code"
            inputMode="numeric"
            disabled={verify.isPending}
            onChange={setCode}
            onComplete={(c: string) => verify.mutate(c)}
            {...fieldAria(ids.code, { error: inlineError !== undefined })}
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={cooldown > 0 || start.isPending}
            onClick={() => {
              verify.reset();
              start.mutate();
            }}
          >
            {cooldown > 0 ? m.verify_resend_in({ seconds: String(cooldown) }) : m.verify_resend()}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => {
              verify.reset();
              start.reset();
              setStep("details");
            }}
          >
            {m.requestaccess_edit_details()}
          </Button>
        </div>
      </form>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending || name.trim() === "" || email.trim() === "") return;
    if (!EMAIL_PATTERN.test(email.trim())) {
      setEmailError(m.requestaccess_email_invalid());
      document.getElementById(ids.email)?.focus();
      return;
    }
    start.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.requestaccess_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.requestaccess_subtitle({ workspace: config.workspace?.name ?? config.instanceName })}
        </p>
      </div>
      {offering506b ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {m.requestaccess_506b_note()}
        </p>
      ) : null}
      <ErrorAlert error={isCode(start.error, "validation_failed") ? null : start.error} />
      <Field id={ids.name} label={m.requestaccess_name()} required>
        <Input
          id={ids.name}
          name="name"
          autoComplete="name"
          autoFocus
          required
          maxLength={NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...fieldAria(ids.name, {})}
        />
      </Field>
      <Field id={ids.email} label={m.requestaccess_email()} error={emailError} required>
        <Input
          id={ids.email}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailError(undefined);
          }}
          {...fieldAria(ids.email, { error: emailError !== undefined })}
        />
      </Field>
      <Field id={ids.firm} label={m.requestaccess_firm()}>
        <Input
          id={ids.firm}
          name="organization"
          autoComplete="organization"
          maxLength={FIRM_MAX}
          value={firm}
          onChange={(e) => setFirm(e.target.value)}
          {...fieldAria(ids.firm, {})}
        />
      </Field>
      <Field
        id={ids.reason}
        label={m.requestaccess_reason()}
        description={m.requestaccess_reason_count({
          used: String(reason.length),
          max: String(REASON_MAX),
        })}
      >
        <Textarea
          id={ids.reason}
          name="reason"
          rows={4}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          {...fieldAria(ids.reason, { description: true })}
        />
      </Field>
      {/* Honeypot: never seen, never focused, never announced. */}
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
      >
        <label htmlFor={ids.website}>{m.requestaccess_website()}</label>
        <input
          id={ids.website}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        className="w-full"
        loading={start.isPending}
        disabled={name.trim() === "" || email.trim() === ""}
      >
        {m.requestaccess_submit()}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {m.requestaccess_have_access()}{" "}
        <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
          {m.requestaccess_sign_in()}
        </Link>
      </p>
    </form>
  );
}

/** A page-level heading that takes focus when its step appears, so the change is announced. */
function FocusedHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="text-xl font-semibold outline-none">
      {children}
    </h1>
  );
}

function Unavailable() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{m.requestaccess_unavailable_title()}</h1>
      <p className="text-sm text-muted-foreground">
        {m.requestaccess_unavailable_body()}{" "}
        <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
          {m.requestaccess_sign_in()}
        </Link>
      </p>
    </div>
  );
}
