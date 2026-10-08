import { Button, Field, fieldAria, InputOTP, InputOTPGroup, InputOTPSlot } from "@fundroomhq/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import * as z from "zod/mini";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError, isCode } from "../../../lib/api.js";
import { leaveForServerPath, signInDestination } from "../../../lib/central-auth.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { refreshSession } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

const searchSchema = z.object({
  email: z.catch(z.string(), ""),
  returnTo: z.catch(z.optional(z.string()), undefined),
  remember: z.catch(z.optional(z.boolean()), undefined),
});

export const Route = createFileRoute("/_auth/login/verify")({
  validateSearch: searchSchema,
  component: VerifyPage,
});

const RESEND_COOLDOWN_S = 30;

function VerifyPage() {
  const { email, returnTo, remember } = Route.useSearch();
  const config = useWebConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const id = useId();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const verify = useMutation({
    mutationFn: (c: string) =>
      call(
        api().POST("/auth/otp/verify", {
          body: { email, code: c, rememberDevice: remember === true },
        }),
      ),
    onSuccess: async () => {
      await refreshSession(queryClient);
      // E3.10: a central-auth `next` is a server route — a page load, not a router hop.
      if (leaveForServerPath(signInDestination(returnTo), config.basePath)) return;
      await navigate({ to: signInDestination(returnTo), replace: true });
    },
    onError: () => setCode(""),
  });
  const resend = useMutation({
    mutationFn: () => call(api().POST("/auth/otp/start", { body: { email } })),
    onSuccess: () => setCooldown(RESEND_COOLDOWN_S),
  });

  const inlineError =
    verify.isError && isCode(verify.error, "invalid_code", "expired", "too_many_attempts")
      ? describeError(verify.error).body
      : undefined;
  const otherError = verify.isError && inlineError === undefined ? verify.error : resend.error;

  // The code was right, but the membership it would open has expired (E3.2): another code would
  // be refused the same way, so the form gives way to the explanation and a way back.
  if (verify.isError && isCode(verify.error, "membership_expired")) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">{m.verify_title()}</h1>
        <ErrorAlert error={verify.error} />
        <Button asChild>
          <Link to="/login" search={{ returnTo }}>
            {m.common_back()}
          </Link>
        </Button>
      </div>
    );
  }

  if (email === "") {
    return (
      <div className="space-y-4">
        <p>{m.verify_missing_email()}</p>
        <Button asChild>
          <Link to="/login" search={{ returnTo }}>
            {m.common_back()}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) verify.mutate(code);
      }}
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.verify_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.verify_subtitle({ email })}</p>
      </div>
      <ErrorAlert error={otherError} />
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={cooldown > 0 || resend.isPending}
          onClick={() => resend.mutate()}
        >
          {cooldown > 0 ? m.verify_resend_in({ seconds: String(cooldown) }) : m.verify_resend()}
        </Button>
        <Button asChild variant="link" size="sm">
          <Link to="/login" search={{ returnTo }}>
            {m.verify_change_email()}
          </Link>
        </Button>
      </div>
    </form>
  );
}
