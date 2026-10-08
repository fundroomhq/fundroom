import { Alert, AlertDescription, AlertTitle, Button, EmptyState } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CirclePause } from "lucide-react";
import type { ReactNode } from "react";
import {
  billingQuery,
  graceDaysLeft,
  isInGrace,
  useCanSeeBilling,
} from "../../lib/billing-queries.js";
import { formatDate } from "../../lib/format.js";
import type { Bootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";
import { useSignOut } from "../account-menu.js";

/*
 * What a workspace that is not simply "active" looks like (E3.10, ADR-0058 §5.1). The server is
 * the gate — a suspended or held workspace answers 423 to staff and 404 to everyone else for
 * anything but sign-in, the bootstrap and (for `billing.read` holders) billing — so these screens
 * only say why the rest of the app has gone quiet, and where the one way out is.
 *
 * Staff learn the status and reason from the bootstrap; investors are only ever told
 * `suspended` with no reason (no oracle about a company's billing or compliance to its
 * investors), and see the same "portal unavailable" screen whichever it is.
 */
export type WorkspaceStatusState = NonNullable<Bootstrap["workspaceStatus"]>;

/**
 * One sentence per status and reason; `null` reason is what non-staff get. `billing`: the viewer
 * can open the billing page — the one thing a held workspace still serves (with sign-in) — and
 * is told so while the new-workspace check runs. The check is never named (A-5 D7).
 */
export function workspaceStatusSentence(
  state: WorkspaceStatusState,
  { billing = false }: { billing?: boolean } = {},
): string {
  if (state.status === "pending_review") {
    return billing
      ? `${m.workspace_status_pending_review()} ${m.workspace_status_pending_review_billing()}`
      : m.workspace_status_pending_review();
  }
  switch (state.reason) {
    case "billing":
      return m.workspace_status_suspended_billing();
    case "operator":
      return m.workspace_status_suspended_operator();
    case "sanctions":
      return m.workspace_status_suspended_review();
    // E3.11: the host is moving the workspace to another cell (planned downtime).
    case "relocation":
      return m.workspace_status_suspended_relocation();
    default:
      return m.workspace_status_suspended();
  }
}

/** The strip above the admin header while the workspace is suspended or held. */
export function WorkspaceStatusBanner({
  state,
  billingLink,
}: {
  state: WorkspaceStatusState;
  billingLink: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <CirclePause aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">{workspaceStatusSentence(state, { billing: billingLink })}</p>
      {billingLink ? <BillingLink /> : null}
    </div>
  );
}

/**
 * The admin body for every screen but billing while the workspace is unavailable: every API
 * behind it would answer 423, so rather than a page of errors, one explanation — and for owner
 * and finance, the way to the billing page.
 */
export function WorkspaceUnavailablePanel({
  state,
  billingLink,
}: {
  state: WorkspaceStatusState;
  billingLink: boolean;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <EmptyState
        icon={<CirclePause aria-hidden="true" />}
        title={m.workspace_unavailable_title()}
        description={workspaceStatusSentence(state, { billing: billingLink })}
        action={
          billingLink ? (
            <Button asChild>
              <Link to="/admin/billing">{m.workspace_status_billing_link()}</Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * The investor portal of a suspended or held workspace. Deliberately the same screen whatever
 * the reason (investors are never told it), with the only thing left to do: sign out.
 */
export function PortalUnavailableScreen({ staff }: { staff: boolean }) {
  const signOut = useSignOut();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        icon={<CirclePause aria-hidden="true" />}
        title={m.portal_unavailable_title()}
        description={m.portal_unavailable_body()}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {staff ? (
              <Button asChild variant="outline">
                <Link to="/admin">{m.portal_unavailable_admin()}</Link>
              </Button>
            ) : null}
            <Button type="button" onClick={() => void signOut()}>
              {m.account_sign_out()}
            </Button>
          </div>
        }
      />
    </div>
  );
}

function graceSentence(graceUntil: string): string {
  const days = graceDaysLeft(graceUntil);
  return days === 0
    ? m.billing_grace_over()
    : m.billing_grace_countdown({ count: days, date: formatDate(graceUntil) });
}

/** The past-due warning on the billing page itself. */
export function GraceNotice({ graceUntil }: { graceUntil: string }) {
  return (
    <Alert variant="warning">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{m.billing_grace_title()}</AlertTitle>
      <AlertDescription>{graceSentence(graceUntil)}</AlertDescription>
    </Alert>
  );
}

/**
 * The admin-shell strip while a payment is overdue and the workspace still runs: how long until
 * it is suspended. Asks `GET /billing` only when `enabled` (billing on, viewer holds
 * `billing.read`) — anyone else could not act on it and would get a 404 for asking.
 */
export function usePastDueBanner(enabled: boolean): ReactNode {
  const billing = useQuery({ ...billingQuery, enabled });
  const sub = billing.data?.subscription;
  if (!enabled || !isInGrace(sub)) return undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">{graceSentence(sub.graceUntil)}</p>
      <BillingLink />
    </div>
  );
}

/**
 * "Go to billing", for anyone who can see billing (`canSeeBilling` / `useCanSeeBilling` — the
 * caller decides). Also used by the plan notices of A-3 and by `ErrorAlert` for `plan_limit`.
 */
export function BillingLink() {
  // Persistently underlined: on the warning strip, colour alone cannot tell a link from the
  // sentence beside it (WCAG 2.2 AA 1.4.1).
  return (
    <Link to="/admin/billing" className="font-semibold underline underline-offset-4">
      {m.workspace_status_billing_link()}
    </Link>
  );
}

/**
 * `BillingLink` for viewers who can see billing, nothing for anyone else. Render it only where a
 * link may be shown (it reads the config and the bootstrap).
 */
export function BillingLinkIfAllowed() {
  return useCanSeeBilling() ? <BillingLink /> : null;
}
