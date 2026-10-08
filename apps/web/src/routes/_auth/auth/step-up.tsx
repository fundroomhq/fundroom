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
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExternalLink, KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import * as z from "zod/mini";
import { SecureStep } from "../../../components/account/secure-step.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { SsoSignInButton } from "../../../components/sso-sign-in.js";
import { useTopLevelPopup } from "../../../embed/top-level-popup.js";
import { api, call, describeError, isCode, safeReturnTo } from "../../../lib/api.js";
import {
  centralAuthNavigation,
  centralStartHref,
  leaveForServerPath,
  signInReturnPath,
  withoutSteppedMarker,
} from "../../../lib/central-auth.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { type Me, meQuery, refreshSession, totpQuery } from "../../../lib/queries.js";
import { sessionIsCentralBound, sessionIsSsoBound, ssoLoginQuery } from "../../../lib/sso-login.js";
import { authenticate, isWebAuthnCancelled, webAuthnSupported } from "../../../lib/webauthn.js";
import { m } from "../../../paraglide/messages.js";

const searchSchema = z.object({
  returnTo: z.catch(z.optional(z.string()), undefined),
  /** E3.10: central auth's re-authentication sends `next=/auth/central/authorize?…` (a server path). */
  next: z.catch(z.optional(z.string()), undefined),
  reason: z.catch(z.optional(z.enum(["level", "fresh"])), undefined),
});

/** Re-prove possession (fresh) or raise the auth level (level 2) on the current session. */
export const Route = createFileRoute("/_auth/auth/step-up")({
  validateSearch: searchSchema,
  component: StepUpPage,
});

function StepUpPage() {
  const search = Route.useSearch();
  const { reason } = search;
  const config = useWebConfig();
  const returnTo = signInReturnPath(search, config.basePath);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  /*
   * Read afresh (E-UP-18 review L1): whether the account has a factor decides between the tabs
   * and enrolling one here, and a cached `/me` may be from before a factor was added elsewhere.
   */
  const me = useQuery({ ...meQuery, refetchOnMount: "always" });
  // Once: a later refetch (the enrolment's own, on mounting) must not take the screen away.
  const [settled, setSettled] = useState(false);
  const freshMe = settled || (me.isFetchedAfterMount && !me.isFetching);
  useEffect(() => {
    if (freshMe) setSettled(true);
  }, [freshMe]);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [password, setPassword] = useState("");
  const [passkeys, setPasskeys] = useState(false);
  const ids = { code: useId(), recovery: useId(), password: useId() };

  useEffect(() => {
    void webAuthnSupported().then(setPasskeys);
  }, []);

  const done = async () => {
    await refreshSession(queryClient);
    if (leaveForServerPath(returnTo, config.basePath)) return;
    await navigate({ to: safeReturnTo(returnTo), replace: true });
  };
  const totp = useMutation({
    mutationFn: (c: string) => call(api().POST("/auth/totp/verify", { body: { code: c } })),
    onSuccess: done,
    onError: () => setCode(""),
  });
  const recover = useMutation({
    mutationFn: (c: string) => call(api().POST("/auth/totp/recovery", { body: { code: c } })),
    onSuccess: done,
  });
  /*
   * E-UP-18 review M1: a security key that does not verify the user (no PIN, no biometric)
   * completes the ceremony and leaves the session at level 1. Going back would only be sent here
   * again — on the canonical host in a central sign-in, round and round — so for the level the
   * session is read again first, and a key that did not get it there is said so (below).
   */
  const [keyUnverified, setKeyUnverified] = useState(false);
  /** The session could not be read after the key (fix round 3): nothing is concluded from it. */
  const [levelReadError, setLevelReadError] = useState<unknown>(undefined);
  const passkey = useMutation({
    mutationFn: async () => {
      const begin = await call(api().POST("/auth/passkeys/login/begin"));
      const response = await authenticate(begin.options);
      return call(
        api().POST("/auth/passkeys/step-up/finish", {
          body: { challengeId: begin.challengeId, response },
        }),
      );
    },
    onMutate: () => setLevelReadError(undefined),
    onSuccess: async () => {
      if (reason === "level") {
        await concludeLevel();
        return;
      }
      await done();
    },
  });
  /** After the key, for the level: read the session (only), then go on or say why not. */
  const [levelReading, setLevelReading] = useState(false);
  async function concludeLevel() {
    // The error (and its "Try again", which keeps focus) stays up until a read succeeds.
    setLevelReading(true);
    let after: Me | null;
    try {
      // A failed read must not look like the level-1 session the cache still holds.
      after = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    } catch (error) {
      setLevelReadError(error);
      return;
    } finally {
      setLevelReading(false);
    }
    setLevelReadError(undefined);
    if ((after?.session.authLevel ?? 0) < 2) {
      setKeyUnverified(true);
      return;
    }
    await done();
  }
  const reverify = useMutation({
    mutationFn: (p: string) =>
      call(api().POST("/auth/password/reverify", { body: { password: p } })),
    onSuccess: done,
  });

  const mfa = me.data?.session.user.mfaEnrolled === true;
  /*
   * E3.8 (review r5 B2): a session minted by the workspace's single sign-on may not re-verify a
   * password (`sso_session_restricted`) and may not read or enrol factors. It can use a factor it
   * already has — `mfaEnrolled` is the only signal it may read, so a passkey is offered only then
   * — and above all it can go back to its IdP, which re-authenticates and raises this session.
   */
  const ssoBound = sessionIsSsoBound(me.data?.session);
  /*
   * E3.10: a session central auth handed to this workspace host is bound the same way (no
   * password re-verify, no factor enrolment: `bound_session_restricted`). Its way back is the
   * canonical host (`reauth=1`, the "Continue" below), never the workspace's IdP.
   */
  const centralBound = sessionIsCentralBound(me.data?.session);
  const bound = ssoBound || centralBound;
  const sso = useQuery({ ...ssoLoginQuery, enabled: ssoBound && reason === "fresh" });
  /*
   * Only for freshness (review r6 L2): a reauth mints a level-1 session unless the IdP asserts a
   * mapped MFA method, so offering it for `level` would loop straight back here.
   */
  const ssoReauth = ssoBound && reason === "fresh" && sso.data?.available === true;
  const centralOffered = config.centralAuth != null && !ssoReauth && config.tree !== "embed";
  const passwordOn = !bound && config.auth.methods.includes("password") && reason === "fresh";
  /*
   * E3.9 FR2 C1: the server leaves `passkey` out of the page's methods where passkeys cannot
   * work (a path mount or another origin than the passkey RP's) and refuses the routes there, so
   * the tab is not offered and the next factor becomes the default.
   */
  const passkeyOn = passkeys && config.auth.methods.includes("passkey");
  /*
   * After a key that did not verify the user (M1), the tabs stay — the account may well have an
   * authenticator app or recovery codes to finish with — and adding an app is offered beside
   * them only where it can work: an account without one (the server refuses a second,
   * `mfa_already_enrolled`), a session that may enrol (not bound) and not in a frame. Read
   * afresh: an app may have been added since anything cached.
   */
  const appEnrollable = keyUnverified && !bound && config.tree !== "embed";
  const totpStatus = useQuery({
    ...totpQuery,
    enabled: appEnrollable,
    staleTime: 0,
    refetchOnMount: "always",
  });
  // Unknown until read since the key (fix round 4): a cached answer is not one.
  const totpKnown =
    totpStatus.isFetchedAfterMount && !totpStatus.isFetching && totpStatus.isSuccess;
  const totpNow = totpKnown ? totpStatus.data : undefined;
  // No app and no recovery codes: the key is all there is, so those tabs would lead nowhere.
  const passkeyOnly = totpNow?.enrolled === false && totpNow.recoveryCodesLeft === 0;
  const tabs = [
    ...(passkeyOn && (!bound || mfa) ? ["passkey"] : []),
    ...(mfa && !passkeyOnly ? ["totp", "recovery"] : []),
    ...(passwordOn ? ["password"] : []),
  ];
  /*
   * E-UP-18: a level step-up for an account with no second factor has nothing to confirm with —
   * on the canonical host in the middle of a central sign-in (`level=2`), "open security
   * settings" would lose the way back. Adding the first factor here raises this session (an
   * authenticator app, or a passkey that verified the user) and returns as any step-up does.
   * Decided on a `/me` read since this screen opened (L1), and kept once a factor was added
   * here: that sets `mfaEnrolled`, which must not swap the enrolment for the tabs before its
   * recovery codes are read. Not for a bound session, which may not enrol
   * (`bound_session_restricted`), nor in a frame (L4: the top-level window below is the way).
   */
  const needsFactor =
    reason === "level" && !bound && config.tree !== "embed" && freshMe && me.data != null && !mfa;
  const [factorAdded, setFactorAdded] = useState(false);
  const enrolHere = needsFactor || factorAdded;
  // Latched once decided (fix round 5): a refetch on reconnect must not take the app's
  // enrolment away from under it.
  const offerAppNow = appEnrollable && totpNow?.enrolled === false;
  const [appOffered, setAppOffered] = useState(false);
  useEffect(() => {
    if (offerAppNow) setAppOffered(true);
  }, [offerAppNow]);
  const offerApp = offerAppNow || appOffered;
  const secureHere = enrolHere || offerApp;
  /*
   * Why the key was not enough, said by what this session can do next (fix round 3). Where the
   * app is offered, its own view says it.
   */
  const totpPending = appEnrollable && !totpKnown && !totpStatus.isError;
  const keyWarning =
    !keyUnverified || offerApp || totpPending
      ? undefined
      : config.tree === "embed"
        ? m.step_up_key_unverified_embed()
        : centralBound && centralOffered
          ? m.step_up_key_unverified_central({ instance: config.instanceName })
          : ssoBound
            ? m.step_up_key_unverified_sso()
            : totpNow?.enrolled === true
              ? m.step_up_key_unverified_app()
              : m.step_up_key_unverified();
  /*
   * Focus goes to the view that takes over (fix rounds 3-4): once a factor is added here (it
   * shows any recovery codes), and when the app is first offered after the key. Its heading may
   * not be there yet (the view is loading), so it is watched for until it is.
   */
  const secureRef = useRef<HTMLDivElement>(null);
  // Each of the two moves once: the offer, then (again) the factor added from it.
  const focusFor = factorAdded ? "added" : offerApp ? "offer" : undefined;
  useEffect(() => {
    const root = secureRef.current;
    if (focusFor === undefined || root === null) return;
    let focused: Element | null = null;
    const follow = () => {
      const heading = root.querySelector("h2");
      if (!(heading instanceof HTMLElement) || heading === focused) return;
      const active = document.activeElement;
      if (
        focused === null &&
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      ) {
        // Someone is typing: not the first move either (fix round 5). Later, as below.
        focused = heading;
        return;
      }
      // After the first move, only where focus was left with nowhere to be (its view went).
      if (focused !== null && active !== null && active !== document.body) return;
      heading.tabIndex = -1;
      heading.focus();
      focused = heading;
    };
    follow();
    const watch = new MutationObserver(follow);
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [focusFor]);
  const codeError =
    totp.isError && isCode(totp.error, "invalid_code", "too_many_attempts")
      ? describeError(totp.error).body
      : undefined;

  if (me.data === null) {
    // Signed out: a sign-in afresh confirms nothing, so no `stepped` marker rides into it (L4).
    void navigate({
      to: "/login",
      search: { returnTo: withoutSteppedMarker(safeReturnTo(returnTo)) },
      replace: true,
    });
    return null;
  }
  if (me.isError && me.data === undefined) {
    // Nothing to decide with (fix round 3): no guessed tabs, only the error and a retry.
    return (
      <div className="space-y-5">
        <h1 className="text-xl font-semibold">{m.step_up_title()}</h1>
        {config.tree === "embed" ? <StepUpAtTopLevel reason={reason} onDone={done} /> : null}
        <ErrorAlert error={me.error} />
        <Button
          type="button"
          variant="outline"
          loading={me.isFetching}
          onClick={() => void me.refetch()}
        >
          {m.common_retry()}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.step_up_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {reason === "fresh" ? m.step_up_fresh_body() : m.step_up_level_body()}
        </p>
      </div>
      {config.tree === "embed" ? <StepUpAtTopLevel reason={reason} onDone={done} /> : null}
      {levelReadError !== undefined ? (
        <div className="space-y-2">
          <ErrorAlert error={levelReadError} />
          <Button
            type="button"
            variant="outline"
            loading={levelReading}
            onClick={() => void concludeLevel()}
          >
            {m.common_retry()}
          </Button>
        </div>
      ) : me.isError && !passkey.isPending && !levelReading ? (
        // A failed refresh with the account still cached: said, and the cached choices stay —
        // not while the key or the read after it is under way, which say their own outcome.
        <ErrorAlert error={me.error} />
      ) : null}
      {totpStatus.isError ? <ErrorAlert error={totpStatus.error} /> : null}
      {/*
       * Mounted throughout, so what the key came to is announced when it is known — also where
       * the app's own view says it at length (a short line, for screen readers only).
       */}
      <div role="status" aria-live="polite" data-slot="step-up-notice">
        {keyWarning !== undefined ? (
          <Alert variant="warning" role="none">
            <AlertDescription>{keyWarning}</AlertDescription>
          </Alert>
        ) : keyUnverified && offerApp ? (
          <p className="sr-only">{m.step_up_key_unverified_short()}</p>
        ) : null}
      </div>
      {/*
       * E3.10: on a workspace host with central auth, the session may have come from the
       * canonical host, and re-proving it there (`reauth=1`) is the one way that always works.
       */}
      {centralOffered ? (
        <div className="space-y-3">
          <Button
            type="button"
            className="w-full"
            onClick={() =>
              centralAuthNavigation.assign(
                centralStartHref(config.centralAuth?.startPath ?? "", returnTo, {
                  reauth: true,
                  // E-UP-18 D1: a fresh sign-in alone may come back at level 1, and here again.
                  ...(reason === "level" ? { level: 2 as const } : {}),
                }),
              )
            }
          >
            {m.login_central_continue()}
          </Button>
          {tabs.length > 0 || enrolHere ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              {m.login_or()}
              <Separator className="flex-1" />
            </div>
          ) : null}
        </div>
      ) : null}
      {ssoReauth ? (
        <SsoSignInButton
          name={sso.data?.name ?? null}
          returnTo={safeReturnTo(returnTo)}
          variant="default"
          reauth
        />
      ) : null}
      {ssoReauth && tabs.length > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Separator className="flex-1" />
          {m.login_or()}
          <Separator className="flex-1" />
        </div>
      ) : null}
      {reason === "level" && !freshMe && !keyUnverified && !factorAdded ? (
        <LoadingState lines={3} label={m.common_loading()} />
      ) : (
        <>
          {/* One instance throughout, so an app added from the offer keeps its recovery codes. */}
          {secureHere ? (
            <div ref={secureRef}>
              <SecureStep
                passwordEnabled={false}
                stepped={keyUnverified}
                onNext={() => void done()}
                onFinished={() => setFactorAdded(true)}
              />
            </div>
          ) : null}
          {secureHere && !enrolHere && tabs.length > 0 ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              {m.login_or()}
              <Separator className="flex-1" />
            </div>
          ) : null}
          {enrolHere ? null : factorChoices()}
        </>
      )}
    </div>
  );

  /** What this session can confirm with: the tabs, or why there is nothing (a render helper). */
  function factorChoices() {
    return centralBound && tabs.length === 0 ? (
      centralOffered ? null : (
        <p className="text-sm">{m.central_stepup_nothing()}</p>
      )
    ) : bound && tabs.length === 0 ? (
      ssoReauth || (reason === "fresh" && sso.isPending) ? null : (
        // Nothing this session can use: say so rather than offer dead ends.
        <p className="text-sm">{m.sso_login_stepup_nothing()}</p>
      )
    ) : tabs.length === 0 ? (
      <div className="space-y-3">
        <p className="text-sm">{m.step_up_nothing_body()}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/security" })}
        >
          {m.step_up_go_security()}
        </Button>
      </div>
    ) : (
      <Tabs defaultValue={tabs[0] ?? "totp"}>
        <TabsList aria-label={m.step_up_methods_label()}>
          {tabs.includes("passkey") ? (
            <TabsTrigger value="passkey">{m.step_up_tab_passkey()}</TabsTrigger>
          ) : null}
          {tabs.includes("totp") ? (
            <TabsTrigger value="totp">{m.step_up_tab_totp()}</TabsTrigger>
          ) : null}
          {tabs.includes("recovery") ? (
            <TabsTrigger value="recovery">{m.step_up_tab_recovery()}</TabsTrigger>
          ) : null}
          {tabs.includes("password") ? (
            <TabsTrigger value="password">{m.step_up_tab_password()}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="passkey" className="space-y-4 pt-4">
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
            {m.step_up_use_passkey()}
          </Button>
        </TabsContent>
        <TabsContent value="totp" className="pt-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6) totp.mutate(code);
            }}
          >
            <ErrorAlert error={totp.isError && codeError === undefined ? totp.error : undefined} />
            <Field id={ids.code} label={m.step_up_totp_code()} error={codeError}>
              <InputOTP
                id={ids.code}
                maxLength={6}
                value={code}
                autoComplete="one-time-code"
                inputMode="numeric"
                onChange={setCode}
                onComplete={(c: string) => totp.mutate(c)}
                {...fieldAria(ids.code, { error: codeError !== undefined })}
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
              loading={totp.isPending}
              disabled={code.length < 6}
            >
              {m.common_continue()}
            </Button>
          </form>
        </TabsContent>
        <TabsContent value="recovery" className="pt-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (recovery.trim().length >= 8) recover.mutate(recovery.trim());
            }}
          >
            <ErrorAlert error={recover.error} />
            <Field
              id={ids.recovery}
              label={m.step_up_recovery_code()}
              description={m.step_up_recovery_hint()}
            >
              <Input
                id={ids.recovery}
                value={recovery}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRecovery(e.target.value)}
                {...fieldAria(ids.recovery, { description: true })}
              />
            </Field>
            <Button type="submit" className="w-full" loading={recover.isPending}>
              {m.common_continue()}
            </Button>
          </form>
        </TabsContent>
        <TabsContent value="password" className="pt-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (password.length > 0) reverify.mutate(password);
            }}
          >
            <ErrorAlert error={reverify.error} />
            <Field id={ids.password} label={m.login_password()}>
              <Input
                id={ids.password}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                {...fieldAria(ids.password, {})}
              />
            </Field>
            <Button type="submit" className="w-full" loading={reverify.isPending}>
              {m.common_continue()}
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    );
  }
}

/**
 * The same step-up, in a real top-level window (ADR-0040 decision 11).
 *
 * Offered *in addition to* the tabs above rather than instead of them, because in-frame
 * re-authentication works and is the shorter path when the browser is keeping the frame's
 * partitioned cookie. What it does not always do is work at all: WebAuthn runs in a
 * cross-origin iframe only when the host page delegates `publickey-credentials-get`, and a
 * host we do not control may simply not have. The popup is the path that never depends on them.
 *
 * The honest caveat is the cookie jar. Where the host site and this portal share a registrable
 * domain the popup's session *is* the frame's session and re-authenticating there is enough;
 * where they do not, the popup holds a separate first-party session and this raises that one.
 * `useTopLevelPopup` re-reads `me` either way, so the frame shows what is actually true rather
 * than what we hoped, and the "Open in a new tab" fallback stays behind it.
 */
function StepUpAtTopLevel({
  reason,
  onDone,
}: {
  reason: "level" | "fresh" | undefined;
  onDone: () => Promise<void>;
}) {
  const runAtTopLevel = useTopLevelPopup();
  const [blocked, setBlocked] = useState(false);
  return (
    <Alert>
      <AlertTitle>{m.step_up_popup_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{m.step_up_popup_body()}</p>
        {blocked ? <p className="font-medium">{m.step_up_popup_blocked()}</p> : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void runAtTopLevel("/auth/popup", reason === undefined ? {} : { reason }).then(
              async (outcome) => {
                setBlocked(outcome === "blocked");
                if (outcome === "completed") await onDone();
              },
            );
          }}
        >
          <ExternalLink aria-hidden="true" />
          {m.step_up_popup_action()}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
