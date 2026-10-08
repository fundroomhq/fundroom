import type { FundRoomSchemas } from "@fundroom/sdk";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  fieldAria,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  LoadingState,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { KeyRound, Smartphone } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { ApiFailure, api, call, describeError, isCode } from "../../lib/api.js";
import { isServerReturnPath, withoutSteppedMarker } from "../../lib/central-auth.js";
import { useWebConfig } from "../../lib/config-context.js";
import { meQuery, refreshSession } from "../../lib/queries.js";
import { sessionIsCentralBound } from "../../lib/sso-login.js";
import {
  authenticate,
  isWebAuthnCancelled,
  register,
  webAuthnSupported,
} from "../../lib/webauthn.js";
import { m } from "../../paraglide/messages.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";

type Enrolment = FundRoomSchemas["TotpEnrolment"];

function StepHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-4 space-y-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * Adding the owner's second factor (E0.8; A-5 for the hosted cases). Used by the setup wizard's
 * security step and by the signup Done screen, where the founder's session is still the
 * canonical host's own (unbound, fresh) and can enrol the first factor.
 *
 * Which view is shown follows a fresh `/me`, because the server's rules decide what works:
 *  - no factor yet → enrol a passkey or an authenticator app (a level-1 session may enrol the
 *    first one);
 *  - a session minted by a central-auth handoff (`boundWorkspaceId`) with no factor → it may not
 *    change the account at all (`bound_session_restricted`), so: sign in here by email code
 *    instead (an ordinary session), then enrol;
 *  - a factor already, but level 1 → confirm it (the step-up screen, or inline where that
 *    screen would lose the page: the signup Done screen). After a passkey confirmation that
 *    completed without verifying the user (no PIN or biometric, still level 1) the server lets
 *    that session enrol an authenticator app, so one is offered then — and only then: a
 *    cancelled confirmation proved nothing, and the server would refuse. A central-bound session
 *    may not enrol at all; after such a confirmation it is offered a sign-in here by email code,
 *    whose ordinary session can confirm the key and add an app.
 */
export function SecureStep({
  passwordEnabled,
  onNext,
  onSkip,
  stepUpReturn,
  stepped = false,
  onFinished,
  onUnconfirmed,
  staleAction,
}: {
  /** Whether the install signs in with passwords (offered beside the authenticator app). */
  passwordEnabled: boolean;
  /** After a factor was added (the caller checks the session level). */
  onNext: () => void;
  /** "Skip for now"; omitted where skipping would only lead back here. */
  onSkip?: (() => void) | undefined;
  /**
   * Where the step-up screen returns to, for an account that already has a factor. Omitted:
   * confirming happens here, with the passkey (the signup Done screen, whose page — and the
   * workspace address on it — a round trip through the step-up screen would lose).
   */
  stepUpReturn?: string | undefined;
  /** Back from the step-up screen and still level 1: the confirmation did not verify the user. */
  stepped?: boolean;
  /** Told when a factor was added (the success view, with any recovery codes, is showing). */
  onFinished?: (() => void) | undefined;
  /** Told whether a passkey added here has left the session at level 1 (not yet confirmed). */
  onUnconfirmed?: ((unconfirmed: boolean) => void) | undefined;
  /**
   * What a session too old to add a factor (`step_up_required` `fresh`, no factor yet) is offered;
   * by default, signing in afresh here by email code.
   */
  staleAction?: ReactNode;
}) {
  const config = useWebConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  // Read afresh: whether the account already has a factor decides what this step can do.
  const me = useQuery({ ...meQuery, refetchOnMount: "always" });
  const [supported, setSupported] = useState(false);
  // E3.9 FR2 C1: not offered where the server says passkeys cannot work (path mount, off-RP origin).
  const passkeyOn = supported && config.auth.methods.includes("passkey");
  /*
   * What this step has done: added a passkey or an app, or (inline) confirmed an existing factor.
   * Kept while the app's enrolment form is open, so its Back returns to the view it came from.
   */
  const [done, setDone] = useState<"passkey" | "totp" | "confirmed" | undefined>();
  const [enrolment, setEnrolment] = useState<Enrolment | undefined>();
  const [qr, setQr] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [password, setPassword] = useState("");
  /*
   * A passkey confirmation completed in this view, whatever level it reached: the server then
   * holds a presence proof for this session, which lets it add an authenticator app — and still
   * does after a later attempt is cancelled (L-c).
   */
  const [proofSeen, setProofSeen] = useState(false);
  /**
   * The registration itself raised the session to level 2 (E-UP-18 D2: the new passkey verified
   * the user), so no confirmation follows it.
   */
  const [raised, setRaised] = useState(false);
  /** The app form's own "Confirm it's you" was used: its progress and result show in the form. */
  const [formStepUp, setFormStepUp] = useState(false);
  const passwordId = useId();
  const codeId = useId();
  useEffect(() => {
    void webAuthnSupported().then(setSupported);
  }, []);
  useEffect(() => {
    if (!enrolment) {
      setQr(undefined);
      return;
    }
    let cancelled = false;
    void import("qrcode").then(async (QRCode) => {
      const url = await QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 160 });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  const passkey = useMutation({
    mutationFn: async () => {
      const begin = await call(api().POST("/auth/passkeys/register/begin"));
      const response = await register(begin.options);
      return call(
        api().POST("/auth/passkeys/register/finish", {
          body: { challengeId: begin.challengeId, response, label: m.setup_passkey_label() },
        }),
      );
    },
    onSuccess: (registered) => {
      setDone("passkey");
      onFinished?.();
      // E-UP-18 D2: a passkey that verified the user (PIN, biometric) raises the session as it
      // registers — the response says so — and a second ceremony would only ask again.
      if (registered.authLevel === 2) {
        setRaised(true);
        void refreshSession(queryClient);
        return;
      }
      // A-5: a key that did not verify the user leaves the session where it was — confirming
      // with it may still raise it. Asked at once, so the session leaves this step at level 2
      // (and a central-auth handoff from it carries level 2), or says plainly that this key
      // cannot get it there. A browser that wants a fresh click for the second ceremony (Safari)
      // rejects this one: the view then asks for that click.
      stepUp.mutate();
    },
  });
  const stepUp = useMutation({
    mutationFn: async () => {
      const begin = await call(api().POST("/auth/passkeys/login/begin"));
      const response = await authenticate(begin.options);
      return call(
        api().POST("/auth/passkeys/step-up/finish", {
          body: { challengeId: begin.challengeId, response },
        }),
      );
    },
    onSuccess: () => {
      setProofSeen(true);
      // The app form asks for the current code again; the old one is stale by now.
      setCode("");
    },
    // The session (and `mfaEnrolled`) changed either way; nothing may read the old `/me`.
    onSettled: () => refreshSession(queryClient),
  });
  const setPasswordThenEnrol = useMutation({
    mutationFn: async () => {
      if (passwordEnabled && password.length > 0) {
        await call(api().PUT("/auth/password", { body: { password } }));
      }
      return call(api().POST("/auth/totp/enrol"));
    },
    onSuccess: (data) => {
      // The enrolment form takes over; `done` stays, for its Back.
      setEnrolment(data);
      setCode("");
    },
  });
  const confirm = useMutation({
    mutationFn: (c: string) => call(api().POST("/auth/totp/enrol/confirm", { body: { code: c } })),
    onSuccess: (data) => {
      setEnrolment(undefined);
      setRecoveryCodes(data.recoveryCodes);
      setDone("totp");
      onFinished?.();
      void refreshSession(queryClient);
    },
  });

  // A registration that raised the session is level 2 before `/me` has caught up with it.
  const level = Math.max(me.data?.session.authLevel ?? 0, raised ? 2 : 0);
  const confirming = done === "passkey" || done === "confirmed";
  // Nothing to settle after a registration that raised the session: no confirmation was asked.
  const stepUpSettling = !raised && (stepUp.isPending || stepUp.isIdle || me.isFetching);
  /*
   * A passkey added here left the session at level 1: told only from the settled view that says
   * so — not while the confirmation is in progress, nor under the app's enrolment form.
   */
  const unconfirmed = done === "passkey" && level < 2 && !stepUpSettling && enrolment === undefined;
  useEffect(() => {
    onUnconfirmed?.(unconfirmed);
  }, [onUnconfirmed, unconfirmed]);

  /**
   * Signs this session out and opens this host's sign-in, coming back here — without `stepped`
   * (a fresh sign-in has confirmed nothing) and never to a server path.
   */
  const signInByEmail = async () => {
    try {
      await call(api().POST("/auth/logout"));
    } catch {
      // Already gone: the sign-in screen is the right place either way.
    }
    queryClient.clear();
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login", search: { returnTo: withoutStepped(href) } });
  };

  /** Confirming the factor: inline with the passkey, or the step-up screen and back. */
  const confirmControl = (variant: "default" | "outline") =>
    stepUpReturn === undefined ? (
      <Button
        type="button"
        variant={variant}
        loading={stepUp.isPending}
        onClick={() => {
          if (enrolment !== undefined) {
            // From the app form: the refusal stays until this confirmation has an outcome.
            setFormStepUp(true);
          } else {
            setPasswordThenEnrol.reset();
            if (!confirming) setDone("confirmed");
          }
          stepUp.mutate();
        }}
      >
        <KeyRound aria-hidden="true" />
        {m.setup_secure_confirm()}
      </Button>
    ) : (
      <Button asChild variant={variant}>
        <Link to="/auth/step-up" search={{ returnTo: stepUpReturn, reason: "level" }}>
          {m.setup_secure_confirm()}
        </Link>
      </Button>
    );

  if (enrolment) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (code.length < 6) return;
          setFormStepUp(false);
          confirm.mutate(code);
        }}
      >
        <StepHeading title={m.setup_secure_title()} body={m.totp_scan()} />
        <div className="flex flex-wrap items-start gap-4">
          {qr ? (
            <img src={qr} alt={m.totp_qr_alt()} width={160} height={160} className="rounded-md" />
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
        {formStepUp && stepUp.isSuccess ? (
          <Alert variant="success">
            <AlertDescription>{m.setup_secure_totp_reconfirm()}</AlertDescription>
          </Alert>
        ) : confirm.isError && isCode(confirm.error, "step_up_required") ? (
          <div className="space-y-2">
            {formStepUp && stepUp.isError && !isWebAuthnCancelled(stepUp.error) ? (
              <ErrorAlert error={stepUp.error} />
            ) : null}
            {confirmControl("outline")}
          </div>
        ) : confirm.isError && !isCode(confirm.error, "invalid_code") ? (
          <ErrorAlert error={confirm.error} />
        ) : null}
        <Field
          id={codeId}
          label={m.totp_first_code()}
          error={
            confirm.isError && isCode(confirm.error, "invalid_code")
              ? describeError(confirm.error).body
              : undefined
          }
        >
          <InputOTP
            id={codeId}
            maxLength={6}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            {...fieldAria(codeId, { error: confirm.isError })}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={confirm.isPending} disabled={code.length < 6}>
            {m.setup_secure_totp_confirm()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              confirm.reset();
              setFormStepUp(false);
              setEnrolment(undefined);
            }}
          >
            {m.common_back()}
          </Button>
        </div>
      </form>
    );
  }

  if (confirming && stepUpSettling) {
    return <LoadingState lines={3} label={m.setup_secure_passkey_confirming()} />;
  }
  if (confirming && level < 2) {
    /*
     * Still level 1. Two different cases (L3): the confirmation completed without verifying the
     * user (no PIN or biometric) — the server then lets this session add an authenticator app,
     * so that is the way on; or it never completed (cancelled, often because the browser wanted
     * a click of its own for it, or failed) — nothing was proved, the server would refuse an
     * app, and the way on is to confirm again, by a click. Once one has completed, a later
     * cancelled retry does not take the app away: that proof still counts.
     */
    const unverified = proofSeen;
    const cancelled = stepUp.isError && isWebAuthnCancelled(stepUp.error);
    const body = unverified
      ? m.setup_secure_stepped_body()
      : cancelled
        ? done === "passkey"
          ? m.setup_secure_passkey_confirm_body()
          : m.setup_secure_confirm_body()
        : describeError(stepUp.error).body;
    return (
      <div className="space-y-4">
        <StepHeading title={m.setup_secure_title()} body={body} />
        {unverified && stepUp.isError && !cancelled ? <ErrorAlert error={stepUp.error} /> : null}
        {setPasswordThenEnrol.isError ? <ErrorAlert error={setPasswordThenEnrol.error} /> : null}
        <div className="flex flex-wrap gap-2">
          {unverified ? (
            <Button
              type="button"
              loading={setPasswordThenEnrol.isPending}
              onClick={() => setPasswordThenEnrol.mutate()}
            >
              <Smartphone aria-hidden="true" />
              {m.setup_secure_totp_instead()}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={unverified ? "outline" : "default"}
            disabled={setPasswordThenEnrol.isPending}
            onClick={() => stepUp.mutate()}
          >
            <KeyRound aria-hidden="true" />
            {m.setup_secure_passkey_confirm()}
          </Button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4">
        <StepHeading title={m.setup_secure_title()} body={m.setup_secure_body()} />
        <Alert variant="success">
          <AlertTitle>
            {done === "passkey"
              ? m.setup_secure_passkey_done()
              : done === "totp"
                ? m.setup_secure_totp_done()
                : m.setup_secure_confirmed()}
          </AlertTitle>
          {recoveryCodes ? (
            <AlertDescription>
              <p className="mb-2">{m.setup_recovery_codes_body()}</p>
              <ul
                className="grid grid-cols-2 gap-1 font-mono text-xs"
                aria-label={m.setup_recovery_codes_label()}
              >
                {recoveryCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="mt-2">
                <CopyButton value={recoveryCodes.join("\n")} label={m.common_copy()} />
              </div>
            </AlertDescription>
          ) : null}
        </Alert>
        <Button type="button" onClick={onNext}>
          {m.common_continue()}
        </Button>
      </div>
    );
  }

  const busy = passkey.isPending || setPasswordThenEnrol.isPending;
  const error =
    passkey.isError && !isWebAuthnCancelled(passkey.error)
      ? passkey.error
      : setPasswordThenEnrol.isError
        ? setPasswordThenEnrol.error
        : undefined;
  if (me.isFetching && me.data === undefined) {
    return <LoadingState lines={3} label={m.common_loading()} />;
  }
  const session = me.data?.session;
  const enrolled = session?.user.mfaEnrolled === true;
  const bound = session !== undefined && sessionIsCentralBound(session);

  // A central-auth session may not change the account; an ordinary one on this host may. Only
  // for an account with no factor: one that has a factor confirms it instead (below).
  if (!enrolled && (bound || isCode(error, "bound_session_restricted"))) {
    return (
      <div className="space-y-4">
        <StepHeading
          title={m.setup_secure_title()}
          body={m.setup_secure_bound_body({ instance: config.instanceName })}
        />
        <Button type="button" onClick={() => void signInByEmail()}>
          {m.setup_secure_bound_action()}
        </Button>
      </div>
    );
  }

  const totpButton = (variant: "default" | "outline") => (
    <Button
      type="button"
      variant={variant}
      loading={setPasswordThenEnrol.isPending}
      disabled={busy}
      onClick={() => setPasswordThenEnrol.mutate()}
    >
      <Smartphone aria-hidden="true" />
      {m.setup_secure_totp_instead()}
    </Button>
  );

  // No factor, but the session is too old to add one: a fresh sign-in can.
  if (
    !enrolled &&
    isCode(error, "step_up_required") &&
    error instanceof ApiFailure &&
    error.reason === "fresh"
  ) {
    return (
      <div className="space-y-4">
        <StepHeading title={m.setup_secure_title()} body={m.setup_secure_stale_body()} />
        {staleAction ?? (
          <Button type="button" onClick={() => void signInByEmail()}>
            {m.setup_secure_bound_action()}
          </Button>
        )}
      </div>
    );
  }

  // A `level` refusal means the server knows of a factor, whatever an older `/me` said.
  const levelRefusal =
    isCode(error, "step_up_required") && !(error instanceof ApiFailure && error.reason === "fresh");
  if ((enrolled && (level < 2 || isCode(error, "step_up_required"))) || levelRefusal) {
    /*
     * `stepped` only means something for an account with a factor to have confirmed; so does a
     * confirmation completed here. Only after one is an authenticator app offered: before it the
     * server refuses one (no presence proof; `requireFactorProof`). A bound session may not add an authenticator app (the server refuses), so it is
     * not offered there — after a confirmation that did not verify, it is offered an ordinary
     * sign-in here instead (M2), which can confirm the key and then add an app; without that it
     * would only go round the step-up again, to the same level 1.
     */
    const unverified = proofSeen || stepped;
    const offerTotp = !bound;
    const emailWayOut = bound && unverified;
    return (
      <div className="space-y-4">
        <StepHeading
          title={m.setup_secure_title()}
          body={
            emailWayOut
              ? m.setup_secure_bound_stepped_body({ instance: config.instanceName })
              : unverified
                ? m.setup_secure_stepped_body()
                : m.setup_secure_confirm_body()
          }
        />
        {/* The server decides whether this session may enrol; a refusal is said, not hidden. */}
        {setPasswordThenEnrol.isError ? <ErrorAlert error={setPasswordThenEnrol.error} /> : null}
        <div className="flex flex-wrap gap-2">
          {emailWayOut ? (
            <Button type="button" onClick={() => void signInByEmail()}>
              {m.setup_secure_bound_action()}
            </Button>
          ) : null}
          {unverified && offerTotp ? totpButton("default") : null}
          {confirmControl(emailWayOut || (unverified && offerTotp) ? "outline" : "default")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StepHeading title={m.setup_secure_title()} body={m.setup_secure_body()} />
      {error ? <ErrorAlert error={error} /> : null}
      <ul className="space-y-3">
        {passkeyOn ? (
          <li className="flex flex-wrap items-center gap-3 rounded-md border p-3">
            <KeyRound aria-hidden="true" className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{m.setup_secure_passkey_title()}</div>
              <div className="text-muted-foreground">{m.setup_secure_passkey_body()}</div>
            </div>
            <Button
              type="button"
              size="sm"
              loading={passkey.isPending}
              disabled={busy}
              onClick={() => passkey.mutate()}
            >
              {m.setup_secure_passkey_action()}
            </Button>
          </li>
        ) : null}
        <li className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <Smartphone aria-hidden="true" className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">
                {passwordEnabled
                  ? m.setup_secure_password_totp_title()
                  : m.setup_secure_totp_title()}
              </div>
              <div className="text-muted-foreground">{m.setup_secure_totp_body()}</div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={setPasswordThenEnrol.isPending}
              disabled={busy || (passwordEnabled && password.length > 0 && password.length < 12)}
              onClick={() => setPasswordThenEnrol.mutate()}
            >
              {m.setup_secure_totp_action()}
            </Button>
          </div>
          {passwordEnabled ? (
            <Field id={passwordId} label={m.password_new()} description={m.password_hint()}>
              <Input
                id={passwordId}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                {...fieldAria(passwordId, { description: true })}
              />
            </Field>
          ) : null}
        </li>
      </ul>
      {onSkip === undefined ? null : (
        <Button type="button" variant="ghost" onClick={onSkip} disabled={busy}>
          {m.setup_skip()}
        </Button>
      )}
    </div>
  );
}

/** `href` without the `stepped` marker (a fresh sign-in has confirmed nothing); never a server path. */
export function withoutStepped(href: string): string {
  const out = withoutSteppedMarker(href);
  return isServerReturnPath(out) ? "/" : out;
}
