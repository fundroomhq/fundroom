import { Alert, AlertDescription, AlertTitle, Badge } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { billingQuery, canSeeBilling } from "../../lib/billing-queries.js";
import { useWebConfig } from "../../lib/config-context.js";
import {
  type PlanFeature,
  planAllowsFeature,
  planFeatureLabel,
  STOPPING_FEATURES,
} from "../../lib/plan-features.js";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";
import { BillingLink } from "./workspace-status.js";

/*
 * A-3 (ADR-0063): a downgrade freezes the configuration. What is on stays on, can be maintained
 * (credentials, secrets, narrowing, re-checking) and can be turned off; nothing new can be added
 * or turned on. A settings page whose feature the plan leaves out says so once, at the top, and
 * greys out only the controls that would add or turn on something. What turns things off —
 * disable, delete, revoke, rotate — stays available: rotating a leaked secret must never need
 * an upgrade. Two features stop instead of keeping what is set up (AI requests, completing an
 * access review), and their notice says so; audit anchoring keeps running and only its proof
 * downloads need the plan (decision 20).
 *
 * The plan comes from the bootstrap (`entitlements.features`, staff only); absent or `null`
 * means every feature, which is also what every install without a control plane sees.
 */

/** Whether the workspace's plan lets staff turn `feature` on (from the cached bootstrap). */
export function usePlanAllowsFeature(feature: PlanFeature): boolean {
  const bootstrap = useBootstrap();
  return planAllowsFeature(bootstrap.data, feature);
}

/**
 * Who changes the plan, and where. An install that does not bill: the host. One that bills: for
 * viewers who can open Billing, what the Billing page itself will say — the host when the
 * workspace is billed by hand (`manual` driver), otherwise an owner, there, with the link; for
 * anyone else, ask an owner (they cannot see which it is).
 */
export function PlanChangeHint() {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  const billing = config.billing === true && canSeeBilling(config, bootstrap.data);
  // The same cached `GET /billing` as the Billing page; asked only by those who may read it.
  const overview = useQuery({ ...billingQuery, enabled: billing });
  if (config.billing !== true) return <p>{m.plan_change_contact_host()}</p>;
  if (!billing) return <p>{m.plan_change_ask_owner()}</p>;
  if (overview.data?.driver === "manual") return <p>{m.error_billing_manual_body()}</p>;
  return (
    <p>
      {m.plan_change_owner_billing()} <BillingLink />
    </p>
  );
}

/** The notice above a feature's settings; renders nothing when the plan includes it. */
export function PlanFeatureNotice({
  feature,
  id,
  className,
  allowed: allowedByServer,
}: {
  feature: PlanFeature;
  /** For `aria-describedby` on the controls the plan greys out. */
  id?: string;
  className?: string;
  /** The page's own answer from the server (e.g. `planAllows`), when it has one: it wins. */
  allowed?: boolean | undefined;
}) {
  const allowedByPlan = usePlanAllowsFeature(feature);
  if (allowedByServer ?? allowedByPlan) return null;
  const name = planFeatureLabel(feature);
  return (
    <Alert id={id} className={className}>
      <Lock aria-hidden="true" />
      <AlertTitle>{m.plan_feature_notice_title()}</AlertTitle>
      <AlertDescription>
        <p>
          {feature === "anchoring"
            ? // Decision 20: the log is still anchored; only proof downloads need the plan.
              m.plan_feature_notice_body_anchoring({ feature: name })
            : STOPPING_FEATURES.has(feature)
              ? m.plan_feature_notice_body_stops({ feature: name })
              : m.plan_feature_notice_body({ feature: name })}
        </p>
        <PlanChangeHint />
      </AlertDescription>
    </Alert>
  );
}

/**
 * RR3 RL4: a removal the plan allows but would not let anyone redo — the last SCIM token, the
 * SSO connection, a vendor connection, a webhook endpoint — says so in its confirm dialog.
 * Returns the dialog's description with that sentence added when the plan leaves `feature` out
 * (and `applies`, e.g. "this is the last token").
 */
export function usePlanRemovalWarning(
  feature: PlanFeature,
  applies = true,
): (description: string) => string {
  const allowed = usePlanAllowsFeature(feature);
  return (description) =>
    allowed || !applies
      ? description
      : `${description} ${m.plan_removal_warning({ feature: planFeatureLabel(feature) })}`;
}

/** The short form beside a single switch that the plan keeps from being turned on. */
export function NotOnPlanBadge() {
  return <Badge variant="secondary">{m.plan_feature_notice_title()}</Badge>;
}

/** A line beside controls in a card without the notice: why they are greyed out. */
export function PlanFeatureHint({ feature, id }: { feature: PlanFeature; id: string }) {
  const allowed = usePlanAllowsFeature(feature);
  if (allowed) return null;
  return (
    <p id={id} className="text-sm text-muted-foreground">
      {m.plan_feature_unavailable_hint({ feature: planFeatureLabel(feature) })}
    </p>
  );
}
