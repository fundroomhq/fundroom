import { Alert, AlertDescription, AlertTitle, Button, Separator } from "@fundroomhq/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import * as z from "zod/mini";
import { ErrorAlert } from "../../../components/error-alert.js";
import { LoginForm } from "../../../components/login-form.js";
import {
  centralAuthErrorText,
  centralAuthNavigation,
  centralStartHref,
  isCentralAuthError,
  signInReturnPath,
} from "../../../lib/central-auth.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { useBootstrap } from "../../../lib/queries.js";
import { ssoErrorText } from "../../../lib/sso-login.js";
import { m } from "../../../paraglide/messages.js";

const searchSchema = z.object({
  returnTo: z.catch(z.optional(z.string()), undefined),
  error: z.catch(z.optional(z.string()), undefined),
  /*
   * Where a failed workspace SSO sign-in lands (E3.8: `/auth/sso/finish` and the IdP callbacks
   * 302 here). Only ever mapped to our own sentences — the raw value is never rendered.
   */
  sso_error: z.catch(z.optional(z.string()), undefined),
  /*
   * E3.10 central auth. The canonical host's `/auth/central/authorize` sends a visitor with no
   * session here with `returnTo=/auth/central/authorize?req=…` (reached by a page load after
   * sign-in); `next` is accepted as an alias. `sso`: the workspace enforces SSO for this staff
   * member, so its own IdP button is the way in and "Continue" (which would come straight back
   * here) is not offered. `error`: see `CENTRAL_AUTH_ERRORS`.
   */
  next: z.catch(z.optional(z.string()), undefined),
  // The router parses `?sso=1` as a number; any value counts.
  sso: z.catch(z.optional(z.union([z.string(), z.number(), z.boolean()])), undefined),
});

export const Route = createFileRoute("/_auth/login/")({
  validateSearch: searchSchema,
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const { error, sso_error: ssoError } = search;
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  const returnTo = signInReturnPath(search, config.basePath);
  const central = config.centralAuth ?? null;
  return (
    <div className="space-y-4">
      {isCentralAuthError(error) ? (
        <CentralErrorAlert code={error} instance={config.instanceName} />
      ) : error ? (
        <ErrorAlert error={new Error(error)} />
      ) : null}
      {ssoError ? <SsoErrorAlert code={ssoError} /> : null}
      <LoginForm
        returnTo={returnTo}
        lead={
          central !== null && search.sso === undefined ? (
            <CentralContinue startPath={central.startPath} returnTo={returnTo} />
          ) : undefined
        }
      />
      {/* E3.1: only where the workspace takes public requests (the endpoint 404s otherwise). */}
      {bootstrap.data?.requestAccessEnabled === true ? (
        <p className="text-center text-sm text-muted-foreground">
          {m.requestaccess_login_prompt()}{" "}
          <Link
            to="/request-access"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {m.requestaccess_login_link()}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/*
 * E3.10: on a custom domain or `<slug>.<canonical>` host with central auth, the account's own
 * credentials (passkeys above all, whose relying party is the canonical host) live on the
 * canonical host, so going there is the first way in; the email code below still works here.
 * A page load, not a link the router could intercept: `/auth/central/start` is a server route.
 */
function CentralContinue({ startPath, returnTo }: { startPath: string; returnTo: string }) {
  const config = useWebConfig();
  return (
    <div className="space-y-3">
      <p className="text-sm">{m.login_central_hint({ instance: config.instanceName })}</p>
      <Button
        type="button"
        className="w-full"
        onClick={() => centralAuthNavigation.assign(centralStartHref(startPath, returnTo))}
      >
        <LogIn aria-hidden="true" />
        {m.login_central_continue()}
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        {m.login_central_or_email()}
        <Separator className="flex-1" />
      </div>
    </div>
  );
}

/** A central sign-in that came back without a session (`/auth/central/finish`'s codes). */
function CentralErrorAlert({ code, instance }: { code: string; instance: string }) {
  if (!isCentralAuthError(code)) return null;
  const text = centralAuthErrorText(code, instance);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{text.title}</AlertTitle>
      <AlertDescription>
        <p>{text.body}</p>
      </AlertDescription>
    </Alert>
  );
}

function SsoErrorAlert({ code }: { code: string }) {
  const text = ssoErrorText(code);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{text.title}</AlertTitle>
      <AlertDescription>
        <p>{text.body}</p>
      </AlertDescription>
    </Alert>
  );
}
