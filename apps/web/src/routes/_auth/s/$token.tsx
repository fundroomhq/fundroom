import {
  Button,
  ErrorState,
  Field,
  fieldAria,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  LoadingState,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { CertificateButton } from "../../../components/compliance/certificate-button.js";
import { Clickwrap } from "../../../components/compliance/clickwrap.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError, isCode } from "../../../lib/api.js";
import { type PendingAcceptance, workspaceScoped } from "../../../lib/compliance-queries.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { splitByCeremony } from "../../../lib/esign-member-queries.js";
import { refreshSession } from "../../../lib/queries.js";
import { describeShareLinkError, shareLinkErrorReason } from "../../../lib/share-links-queries.js";
import { m } from "../../../paraglide/messages.js";

/*
 * The share-link landing (E2.3, contract C4 and S6.2). A stranger holding a token arrives here
 * with no session, no membership and no account.
 *
 * **It owns the whole sign-in ceremony and never hands off to `/login`.** That is a security
 * property, not a layout preference. If the generic `POST /auth/otp/start` learned to accept a
 * link id, possession of the *id* would buy eligibility and the passcode would be bypassed
 * entirely — and an id, unlike its token, ends up in URLs, logs and admin screens. So all three
 * steps hang off the token in the path: resolve, then `start` (which checks the passcode and the
 * address together), then `verify`. The passcode is enforced transitively and the challenge is
 * bound to the link, so a code minted by one link cannot be spent at another.
 *
 * **It shows nothing gated.** The resolve response deliberately carries no target-resource name:
 * the whole point of admission is that it happens before anybody is inside, and a leaked URL
 * must not reveal what it leads to. An unknown, revoked, paused, expired or exhausted token is
 * one indistinguishable 404, so there is one "this link does not work" screen.
 *
 * **The token leaves the address bar the moment it resolves** (S7). Otherwise it sits in
 * `document.referrer` for every later navigation and in the `Referer` of every subresource the
 * app fetches afterwards. The component keeps its own copy, so the flow survives the rewrite;
 * a reload after it does not, which is the correct trade for a bearer token in a URL.
 */
export const Route = createFileRoute("/_auth/s/$token")({ component: ShareLinkPage });

type Step = "email" | "otp" | "accept" | "done";

function ShareLinkPage() {
  const params = Route.useParams();
  // Captured once: the address bar loses the token below, and this must not follow it.
  const [token] = useState(params.token);
  const config = useWebConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<readonly PendingAcceptance[]>([]);
  const [membershipId, setMembershipId] = useState("");
  const [stamps, setStamps] = useState<readonly string[]>([]);
  const ids = { email: useId(), passcode: useId(), code: useId() };

  const link = useQuery({
    queryKey: ["share-link", token],
    queryFn: () => call(api().GET("/links/{token}", { params: { path: { token } } })),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const resolved = link.data !== undefined;
  useEffect(() => {
    if (!resolved) return;
    // Drop the last path segment — the token — keeping any base path the install is mounted at.
    // `history` only, never the router: the route must stay mounted with its params intact.
    const stripped = window.location.pathname.replace(/\/[^/]*$/u, "");
    window.history.replaceState(null, "", `${stripped === "" ? "/" : stripped}`);
  }, [resolved]);

  const start = useMutation({
    mutationFn: () =>
      call(
        api().POST("/links/{token}/start", {
          params: { path: { token } },
          body: {
            email: email.trim(),
            ...(passcode.trim() === "" ? {} : { passcode: passcode.trim() }),
          },
        }),
      ),
    onSuccess: () => {
      setCode("");
      setStep("otp");
    },
  });

  const verify = useMutation({
    mutationFn: (entered: string) =>
      call(
        api().POST("/links/{token}/verify", {
          params: { path: { token } },
          body: { email: email.trim(), code: entered, rememberDevice: false },
        }),
      ),
    onSuccess: async (login) => {
      setMembershipId(login.membership?.id ?? "");
      await refreshSession(queryClient);
      /*
       * The visitor is a member now, so an outstanding NDA is an ordinary click-wrap — the same
       * ceremony the portal interstitial runs, over the same bytes from the same endpoint. It
       * runs here rather than after the redirect so the link's own terms are agreed before the
       * room is on screen, which is the shape S6.2 asks for.
       */
      const gates = await call(api().GET("/compliance/gates"));
      /*
       * E3.5: an e-signature NDA is not signed on this page. It needs the vendor's own signing
       * page at top level and a status that may take a while to settle — which the portal's
       * interstitial already does — so only click-wrap documents are agreed here and anything
       * the vendor must sign is left to the portal, one redirect later.
       */
      // A resource-scoped NDA (`scope: "resource"`, the link's own gate included) belongs to
      // the lock badge's unlock sheet, not to this page (E3.5 B3).
      const { clickwrap } = splitByCeremony(workspaceScoped(gates.pending));
      if (clickwrap.length > 0) {
        setPending(clickwrap);
        setStep("accept");
        return;
      }
      await navigate({ to: "/", replace: true });
    },
    onError: () => setCode(""),
  });

  if (link.isPending) return <LoadingState label={m.common_loading()} />;
  if (link.isError || link.data === undefined) {
    const d = link.isError ? describeError(link.error) : undefined;
    return (
      <ErrorState
        title={m.share_link_invalid_title()}
        description={m.share_link_invalid_body()}
        requestId={d?.requestId}
        requestIdLabel={m.common_request_id_label()}
      />
    );
  }

  const workspace = link.data.workspaceName ?? config.workspace?.name ?? config.instanceName;

  if (step === "accept") {
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{m.share_link_accept_title()}</h1>
          <p className="text-sm text-muted-foreground">{m.share_link_accept_body({ workspace })}</p>
        </div>
        <Clickwrap
          documents={pending}
          idPrefix="share-link-accept"
          submitLabel={m.acceptance_gate_submit()}
          onAccepted={(accepted) => {
            setStamps(accepted);
            setStep("done");
          }}
        />
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{m.share_link_done_title()}</h1>
          <p className="text-sm text-muted-foreground">{m.share_link_done_body()}</p>
        </div>
        {membershipId === "" ? null : (
          <div className="flex flex-wrap gap-2">
            {stamps.map((stamp) => (
              <CertificateButton key={stamp} membershipId={membershipId} stamp={stamp} />
            ))}
          </div>
        )}
        <Button className="w-full" onClick={() => void navigate({ to: "/", replace: true })}>
          {m.share_link_enter({ workspace })}
        </Button>
      </div>
    );
  }

  if (step === "otp") {
    const inlineError =
      verify.isError && isCode(verify.error, "invalid_code", "expired", "too_many_attempts")
        ? describeError(verify.error).body
        : undefined;
    return (
      <form
        className="space-y-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (code.length === 6) verify.mutate(code);
        }}
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{m.verify_title()}</h1>
          <p className="text-sm text-muted-foreground">
            {m.verify_subtitle({ email: start.data?.emailHint ?? email })}
          </p>
        </div>
        {inlineError === undefined && verify.isError ? <ErrorAlert error={verify.error} /> : null}
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
            onComplete={(entered: string) => verify.mutate(entered)}
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
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setCode("");
            setStep("email");
          }}
        >
          {m.verify_change_email()}
        </Button>
      </form>
    );
  }

  /*
   * The refusals the server is willing to distinguish belong beside the field that caused them.
   * Only two things are ever distinguishable here, and only to somebody already holding a
   * resolvable token: the three passcode answers, and "that address is not on this link's list"
   * — which is reachable only after the passcode has been satisfied. Everything else, the one
   * 404 included, is the generic alert, because anything finer would answer "does this link
   * exist?" to whoever asked.
   */
  const reason = start.isError ? shareLinkErrorReason(start.error) : undefined;
  const refusal = start.isError ? describeShareLinkError(start.error) : undefined;
  const passcodeRefused =
    reason === "passcode_required" || reason === "passcode_wrong" || reason === "passcode_locked";
  const emailRefused = reason === "email_not_allowed";
  return (
    <form
      className="space-y-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (email.trim() !== "") start.mutate();
      }}
    >
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{m.share_link_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.share_link_body({ workspace })}</p>
        {link.data.emailHint === undefined ? null : (
          <p className="text-sm">{m.share_link_email_hint({ hint: link.data.emailHint })}</p>
        )}
      </div>
      {start.isError && !passcodeRefused && !emailRefused ? (
        <ErrorAlert error={start.error} />
      ) : null}
      <Field
        id={ids.email}
        label={m.login_email()}
        required
        error={emailRefused ? refusal : undefined}
      >
        <Input
          id={ids.email}
          type="email"
          value={email}
          required
          autoFocus
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          {...fieldAria(ids.email, { error: emailRefused })}
        />
      </Field>
      {link.data.requiresPasscode ? (
        <Field
          id={ids.passcode}
          label={m.share_link_passcode()}
          description={m.share_link_passcode_hint()}
          required
          error={passcodeRefused ? refusal : undefined}
        >
          <Input
            id={ids.passcode}
            type="password"
            value={passcode}
            required
            autoComplete="off"
            onChange={(e) => setPasscode(e.target.value)}
            {...fieldAria(ids.passcode, { description: true, error: passcodeRefused })}
          />
        </Field>
      ) : null}
      <Button type="submit" className="w-full" loading={start.isPending}>
        {m.share_link_continue()}
      </Button>
      <p className="text-xs text-muted-foreground">{m.share_link_footnote()}</p>
    </form>
  );
}
