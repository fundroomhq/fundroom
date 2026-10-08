import { Alert, AlertDescription, AlertTitle, Button, type ButtonProps } from "@fundroomhq/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ExternalLink, LogIn, ShieldCheck } from "lucide-react";
import { openInNewTab } from "../embed/EmbedFrame.js";
import { safeReturnTo } from "../lib/api.js";
import { useWebConfig } from "../lib/config-context.js";
import { beginSso, ssoLoginNavigation, ssoLoginQuery } from "../lib/sso-login.js";
import { m } from "../paraglide/messages.js";
import { useSignOut } from "./account-menu.js";
import { isFramed } from "./compliance/esign-ceremony.js";
import { ErrorAlert } from "./error-alert.js";

/*
 * Workspace single sign-on (E3.8). Two surfaces share the one button: the sign-in form, and the
 * "this workspace requires single sign-on" screen a staff member lands on when enforcement
 * refuses the session they hold.
 *
 * Framed (the embed tree, or any iframe): the IdP refuses to be framed and the binding cookie
 * `begin` sets would be the frame's partitioned one, which the IdP's return to the workspace's
 * own address could not see. So, as the E3.7 verification card does, the button opens the
 * workspace's sign-in at its own address in a new tab and the person continues there.
 */

/** Path + query of the workspace sign-in at its own address, returning to `returnTo`. */
function canonicalLoginPath(returnTo: string): string {
  const safe = safeReturnTo(returnTo);
  return safe === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(safe)}`;
}

export function SsoSignInButton({
  name,
  returnTo,
  loginHint,
  variant = "outline",
  onBeforeBegin,
  reauth = false,
}: {
  name: string | null;
  returnTo: string;
  loginHint?: string | undefined;
  variant?: ButtonProps["variant"];
  /** Runs before the redirect starts (the form stops its pending passkey autofill here). */
  onBeforeBegin?: (() => Promise<void>) | undefined;
  /** Step-up of an SSO-bound session: the IdP signs the same person in again. */
  reauth?: boolean;
}) {
  const config = useWebConfig();
  const begin = useMutation({
    mutationFn: async () => {
      if (onBeforeBegin) await onBeforeBegin();
      return beginSso({ returnTo, loginHint, reauth });
    },
    onSuccess: (data) => ssoLoginNavigation.assign(data.url),
  });
  const label = reauth
    ? name === null
      ? m.sso_login_reauth_generic()
      : m.sso_login_reauth({ name })
    : name === null
      ? m.sso_login_continue_generic()
      : m.sso_login_continue({ name });

  if (isFramed(config)) {
    const path = canonicalLoginPath(returnTo);
    const href = `${config.canonicalOrigin.replace(/\/$/u, "")}${path}`;
    return (
      <div className="space-y-2">
        <Button asChild variant={variant} className="w-full">
          <a
            href={href}
            target="_blank"
            rel="noopener"
            onClick={(e) => {
              e.preventDefault();
              openInNewTab(config.canonicalOrigin, path);
            }}
          >
            <ExternalLink aria-hidden="true" />
            {label}
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">{m.sso_login_embedded_hint()}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ErrorAlert error={begin.error ?? undefined} />
      <Button
        type="button"
        variant={variant}
        className="w-full"
        loading={begin.isPending || begin.isSuccess}
        onClick={() => begin.mutate()}
      >
        <LogIn aria-hidden="true" />
        {label}
      </Button>
    </div>
  );
}

/**
 * The screen a staff member sees when the workspace enforces single sign-on and their session
 * did not come from it (403 `sso_required`, or the bootstrap's `ssoRequired`). Investors never
 * reach it: enforcement does not apply to them.
 */
export function SsoRequiredScreen({ owner = false }: { owner?: boolean }) {
  const config = useWebConfig();
  const href = useRouterState({ select: (s) => s.location.href });
  const sso = useQuery(ssoLoginQuery);
  const signOut = useSignOut();
  const workspace = config.workspace?.name ?? config.instanceName;
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <section
        aria-labelledby="sso-required-title"
        className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
          <h1 id="sso-required-title" className="text-lg font-semibold">
            {m.sso_login_required_title()}
          </h1>
        </div>
        <p className="text-sm">{m.sso_login_required_body({ workspace })}</p>
        <SsoSignInButton
          name={sso.data?.name ?? null}
          returnTo={safeReturnTo(href)}
          variant="default"
        />
        {/*
         * Break-glass (ADR-0056 decision 8): an owner at authentication level 2 is always let in,
         * so a broken IdP cannot lock the workspace out of the settings that would fix it.
         */}
        <p className="text-xs text-muted-foreground">
          {m.sso_login_required_owner_note()}{" "}
          {owner ? (
            <Link
              to="/auth/step-up"
              search={{ returnTo: "/admin/sso", reason: "level" }}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {m.sso_login_required_owner_link()}
            </Link>
          ) : null}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
          {m.account_sign_out()}
        </Button>
      </section>
    </div>
  );
}

/**
 * The security screen's answer for a bound session: SSO-bound (FR1), or handed over by the
 * canonical host (E3.10 central auth), whose account settings live on that host.
 */
export function SsoSessionRestrictedNotice({ kind = "sso" }: { kind?: "sso" | "central" }) {
  const config = useWebConfig();
  return (
    <Alert role="status">
      <ShieldCheck aria-hidden="true" />
      <AlertTitle>
        {kind === "central"
          ? m.central_session_restricted_title()
          : m.sso_login_session_restricted_title()}
      </AlertTitle>
      <AlertDescription>
        <p>
          {kind === "central"
            ? m.central_session_restricted_body({ instance: config.instanceName })
            : m.sso_login_session_restricted_body()}
        </p>
      </AlertDescription>
    </Alert>
  );
}
