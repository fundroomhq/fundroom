import { Alert, AlertDescription, AlertTitle } from "@fundroomhq/ui";
import { describeError, isCode, isPlanEntitlementRefusal } from "../lib/api.js";
import { m } from "../paraglide/messages.js";
import { PlanChangeHint } from "./billing/plan-feature-notice.js";
import { BillingLinkIfAllowed } from "./billing/workspace-status.js";

/** Inline error for forms; shows the request id so support can find the log line. */
export function ErrorAlert({ error }: { error: unknown }) {
  if (error === undefined || error === null) return null;
  const d = describeError(error);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{d.title}</AlertTitle>
      <AlertDescription>
        <p>{d.body}</p>
        {/* A-3: a module or feature not on the plan — who changes the plan depends on the
            install. A quota reached already says Billing; the link goes to those who can. */}
        {isPlanEntitlementRefusal(error) ? (
          <PlanChangeHint />
        ) : isCode(error, "plan_limit") ? (
          <BillingLinkIfAllowed />
        ) : null}
        {d.requestId !== undefined ? (
          <p className="text-xs opacity-80">{m.common_request_id({ id: d.requestId })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
