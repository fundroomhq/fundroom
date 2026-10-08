import { Button, Checkbox, Field, fieldAria, Input, Label, Separator } from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Mail } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api, call, isCode } from "../lib/api.js";
import { leaveForServerPath, signInDestination } from "../lib/central-auth.js";
import { useWebConfig } from "../lib/config-context.js";
import { oidcProvidersQuery, refreshSession } from "../lib/queries.js";
import {
  beginSso,
  discoverSso,
  NO_SSO,
  ssoLoginNavigation,
  ssoLoginQuery,
} from "../lib/sso-login.js";
import {
  authenticate,
  cancelPending,
  isWebAuthnCancelled,
  webAuthnAutofillSupported,
  webAuthnSupported,
} from "../lib/webauthn.js";
import { m } from "../paraglide/messages.js";
import { isFramed } from "./compliance/esign-ceremony.js";
import { ErrorAlert } from "./error-alert.js";
import { SsoSignInButton } from "./sso-sign-in.js";

/*
 * The sign-in form shared by /login and /auth/popup. Every "start" endpoint answers the same
 * way whether or not the address is known (anti-enumeration), so the copy never says
 * "no account". Passkeys: an explicit button plus conditional UI (autofill) when supported.
 */
export function LoginForm({
  returnTo,
  onSignedIn,
  lead,
}: {
  returnTo: string;
  onSignedIn?: (() => void) | undefined;
  /** Rendered under the heading, before every other way in (E3.10: central auth's "Continue"). */
  lead?: ReactNode;
}) {
  const config = useWebConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const methods = config.auth.methods;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [sentLink, setSentLink] = useState<string | undefined>();
  const [passkeys, setPasskeys] = useState(false);
  /** Framed and the address belongs to the workspace's SSO: say so and offer the new tab. */
  const [framedSso, setFramedSso] = useState<string | undefined>();
  /*
   * The conditional-UI (autofill) passkey request started on mount. `active`: it may be pending
   * in the browser. `abandoned`: the visitor chose another way in, so a request still waiting on
   * `/login/begin` must not start its ceremony afterwards.
   */
  const conditional = useRef({ active: false, abandoned: false });
  const ids = { email: useId(), password: useId(), remember: useId() };

  const oidc = useQuery({ ...oidcProvidersQuery, enabled: methods.includes("oidc") });
  /*
   * The workspace's own single sign-on (E3.8). Only where a workspace resolved: the canonical
   * host with no workspace has no IdP to send anyone to.
   */
  const ssoInfo = useQuery({ ...ssoLoginQuery, enabled: config.workspace !== null });
  const sso = ssoInfo.data ?? NO_SSO;
  const framed = isFramed(config);

  const finishLogin = async () => {
    await refreshSession(queryClient);
    if (onSignedIn) onSignedIn();
    // E3.10: `/auth/central/authorize` is a server route — a page load, not a router hop.
    else if (!leaveForServerPath(signInDestination(returnTo), config.basePath)) {
      await navigate({ to: signInDestination(returnTo), replace: true });
    }
  };

  const otpStart = useMutation({
    mutationFn: (e: string) => call(api().POST("/auth/otp/start", { body: { email: e } })),
    onSuccess: (_data, e) =>
      void navigate({
        to: "/login/verify",
        search: { email: e, returnTo, remember: remember || undefined },
      }),
  });
  const linkStart = useMutation({
    mutationFn: (e: string) => call(api().POST("/auth/magic-link/start", { body: { email: e } })),
    onSuccess: (data) => setSentLink(data.emailHint),
  });
  const passwordLogin = useMutation({
    mutationFn: () =>
      call(
        api().POST("/auth/password/login", {
          body: { email, password, rememberDevice: remember },
        }),
      ),
    onSuccess: () => void finishLogin(),
  });
  const passkeyLogin = useMutation({
    mutationFn: async (autofill: boolean) => {
      const begin = await call(api().POST("/auth/passkeys/login/begin"));
      if (autofill && conditional.current.abandoned) {
        // Read as a cancellation (`isWebAuthnCancelled`), so no error is shown for it.
        throw Object.assign(new Error("conditional request abandoned"), { name: "AbortError" });
      }
      const response = await authenticate(begin.options, autofill);
      return call(
        api().POST("/auth/passkeys/login/finish", {
          body: { challengeId: begin.challengeId, response, rememberDevice: remember },
        }),
      );
    },
    onSuccess: () => void finishLogin(),
  });
  /*
   * Home-realm discovery: an address in one of the workspace's verified SSO domains goes to the
   * IdP instead of getting a code. Asked only where SSO is available; a "no" — or no answer —
   * sends the code exactly as before, so the screen reveals nothing about the address.
   */
  const emailStart = useMutation({
    mutationFn: async (input: { email: string; fallback: "otp" | "link" }) => {
      if (!sso.available || !(await discoverSso(input.email))) return { kind: "email" as const };
      if (framed) return { kind: "framed" as const };
      const begin = await beginSso({ returnTo, loginHint: input.email });
      return { kind: "sso" as const, url: begin.url };
    },
    onSuccess: (out, input) => {
      if (out.kind === "sso") ssoLoginNavigation.assign(out.url);
      else if (out.kind === "framed") setFramedSso(input.email);
      else if (input.fallback === "link") linkStart.mutate(input.email);
      else otpStart.mutate(input.email);
    },
  });
  const oidcBegin = useMutation({
    mutationFn: (provider: string) =>
      call(api().POST("/auth/oidc/begin", { body: { provider, returnTo } })),
    onSuccess: (data) => window.location.assign(data.url),
  });

  useEffect(() => {
    if (!methods.includes("passkey")) return;
    let cancelled = false;
    void webAuthnSupported().then((ok) => {
      if (!cancelled) setPasskeys(ok);
    });
    void webAuthnAutofillSupported().then((ok) => {
      if (cancelled || !ok || conditional.current.active) return;
      conditional.current = { active: true, abandoned: false };
      passkeyLogin.mutate(true);
    });
    return () => {
      cancelled = true;
      void abandonConditional();
    };
    // The conditional request runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods]);

  const busy =
    otpStart.isPending ||
    linkStart.isPending ||
    passwordLogin.isPending ||
    oidcBegin.isPending ||
    emailStart.isPending ||
    (emailStart.isSuccess && emailStart.data.kind === "sso");
  const passkeyError =
    passkeyLogin.isError && !isWebAuthnCancelled(passkeyLogin.error)
      ? passkeyLogin.error
      : undefined;
  const formError =
    otpStart.error ?? linkStart.error ?? passwordLogin.error ?? oidcBegin.error ?? emailStart.error;

  /*
   * Stop the autofill request before starting anything else, and wait for the abort (E2.10).
   *
   * It used to be `void cancelPending()` followed straight away by the OTP request: the abort
   * landed whenever the lazily imported library got round to it, a conditional request still
   * waiting on `/login/begin` went on to open its ceremony *after* the click, and a failed abort
   * (the library chunk not loading) was an unhandled rejection. E2.2 recorded roughly one first
   * click in three on "Email me a code" doing nothing at all. Now the abort is awaited, a late
   * `begin` is dropped, a failure to abort cannot stop the request, and the request's own
   * failure is shown in the form's alert — a click always ends in a request or an error.
   */
  const abandonConditional = async () => {
    if (!conditional.current.active) return;
    conditional.current = { active: false, abandoned: true };
    try {
      await cancelPending();
    } catch {
      // Nothing to cancel if the library never loaded; the new request must still go out.
    }
  };

  // Available but not enforced: one more way in, next to the passkey and instance providers.
  const offerSso = sso.available && !sso.enforced;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    await abandonConditional();
    if (usePassword) passwordLogin.mutate();
    else emailStart.mutate({ email, fallback: "otp" });
  };

  if (sentLink !== undefined) {
    return (
      <div className="space-y-4" role="status">
        <h1 className="text-xl font-semibold">{m.login_link_sent_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.login_link_sent_body({ email: sentLink })}
        </p>
        <Button type="button" variant="outline" onClick={() => setSentLink(undefined)}>
          {m.common_back()}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.login_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.login_subtitle({ workspace: config.workspace?.name ?? config.instanceName })}
        </p>
      </div>
      <ErrorAlert error={formError ?? passkeyError} />
      {lead}
      {sso.available && sso.enforced ? (
        /*
         * Enforced: staff can only get in through the IdP, so it leads. Investors are never
         * held to it (ADR-0056 decision 8) and keep the email form below.
         */
        <div className="space-y-3">
          <p className="text-sm">
            {m.sso_login_enforced_hint({
              workspace: config.workspace?.name ?? config.instanceName,
            })}
          </p>
          <SsoSignInButton
            name={sso.name}
            returnTo={returnTo}
            variant="default"
            onBeforeBegin={abandonConditional}
          />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            {m.sso_login_investors_below()}
            <Separator className="flex-1" />
          </div>
        </div>
      ) : null}
      {framedSso !== undefined ? (
        <div className="space-y-2" role="status">
          <p className="text-sm">{m.sso_login_discovered_embedded()}</p>
          <SsoSignInButton name={sso.name} returnTo={returnTo} loginHint={framedSso} />
        </div>
      ) : null}
      <Field id={ids.email} label={m.login_email()} required>
        <Input
          id={ids.email}
          type="email"
          name="email"
          inputMode="email"
          autoComplete={passkeys ? "username webauthn" : "username"}
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...fieldAria(ids.email, {})}
        />
      </Field>
      {usePassword ? (
        <Field id={ids.password} label={m.login_password()} required>
          <Input
            id={ids.password}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            {...fieldAria(ids.password, {})}
          />
        </Field>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox
          id={ids.remember}
          checked={remember}
          onCheckedChange={(v) => setRemember(v === true)}
        />
        <Label htmlFor={ids.remember} className="font-normal">
          {m.login_remember()}
        </Label>
      </div>
      <Button type="submit" className="w-full" loading={busy} disabled={email.trim() === ""}>
        <Mail aria-hidden="true" />
        {usePassword ? m.login_with_password() : m.login_send_code()}
      </Button>
      {isCode(formError, "unsupported") && usePassword ? null : null}
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        {methods.includes("magic_link") && !usePassword ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={email.trim() === "" || busy}
            onClick={() =>
              void abandonConditional().then(() => emailStart.mutate({ email, fallback: "link" }))
            }
          >
            {m.login_send_link()}
          </Button>
        ) : null}
        {methods.includes("password") ? (
          <Button type="button" variant="link" size="sm" onClick={() => setUsePassword((v) => !v)}>
            {usePassword ? m.login_use_code_instead() : m.login_use_password()}
          </Button>
        ) : null}
      </div>
      {passkeys || offerSso || (oidc.data && oidc.data.providers.length > 0) ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            {m.login_or()}
            <Separator className="flex-1" />
          </div>
          {offerSso ? (
            <SsoSignInButton
              name={sso.name}
              returnTo={returnTo}
              onBeforeBegin={abandonConditional}
            />
          ) : null}
          {passkeys ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              loading={passkeyLogin.isPending && passkeyLogin.variables === false}
              onClick={() => {
                void abandonConditional().then(() => passkeyLogin.mutate(false));
              }}
            >
              <KeyRound aria-hidden="true" />
              {m.login_with_passkey()}
            </Button>
          ) : null}
          {(oidc.data?.providers ?? []).map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="outline"
              className="w-full"
              loading={oidcBegin.isPending && oidcBegin.variables === p.id}
              onClick={() => void abandonConditional().then(() => oidcBegin.mutate(p.id))}
            >
              {m.login_with_sso({ provider: p.id.toUpperCase() })}
            </Button>
          ))}
        </div>
      ) : null}
    </form>
  );
}
