import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { CreditCard, ExternalLink, ShieldCheck } from "lucide-react";
import * as z from "zod/mini";
import { GraceNotice } from "../../../components/billing/workspace-status.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { NotFoundScreen } from "../../../components/status-screens.js";
import { ApiFailure, api, call, describeError, isCode } from "../../../lib/api.js";
import {
  type BillingOverview,
  type BillingPlan,
  type BillingSubscription,
  billingNavigation,
  billingQuery,
  canSeeBilling,
  isInGrace,
  LIMIT_KINDS,
  type LimitKind,
  limitLabel,
  type PlanLimits,
  readOnlyModules,
  subscriptionStatusLabel,
  subscriptionStatusVariant,
  usageQuery,
  usedOf,
  type WorkspaceUsage,
} from "../../../lib/billing-queries.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { formatBytes, formatDate } from "../../../lib/format.js";
import { PLAN_FEATURES, planFeatureLabel } from "../../../lib/plan-features.js";
import { meQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";

const searchSchema = z.object({
  /** Where the provider's checkout sends the owner back (`success_url` / `cancel_url`). */
  checkout: z.catch(z.optional(z.enum(["success", "cancel"])), undefined),
  /**
   * A-5: the paid plan a new workspace signed up for, where signup lands the founder when that
   * plan has no trial (`/admin/billing?plan=<id>`). Never `checkout=`, which is the return above.
   */
  plan: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/admin/billing/")({
  validateSearch: searchSchema,
  component: BillingPage,
});

/*
 * Billing (E3.10, ADR-0058). A kernel screen: the subscription is a control-plane fact read
 * during tenant resolution (a suspended workspace is refused before any module runs), so nothing
 * here can be a module page. It is also the one admin screen a suspended workspace still serves
 * to owner and finance — paying is how a billing suspension ends.
 *
 * Checkout and the provider's portal need fresh auth, so both go through `useGuardedMutation`
 * (a stale session gets the step-up screen and comes back here to press the button again) and
 * then send the top window to the URL the server returned: the provider's page cannot be framed
 * and must not be opened in a popup the browser may block.
 */
function BillingPage() {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  const { checkout, plan } = Route.useSearch();
  const allowed = canSeeBilling(config, bootstrap.data);
  const billing = useQuery({ ...billingQuery, enabled: allowed });
  const usage = useQuery({ ...usageQuery, enabled: allowed });
  if (bootstrap.isPending) return <LoadingState label={m.common_loading()} />;
  if (!allowed) return <NotFoundScreen />;
  return (
    <div className="space-y-6">
      <PageHeader title={m.billing_title()} description={m.billing_subtitle()} />
      {checkout === "success" ? (
        <Alert variant="success">
          <AlertTitle>{m.billing_checkout_success_title()}</AlertTitle>
          <AlertDescription>{m.billing_checkout_success_body()}</AlertDescription>
        </Alert>
      ) : null}
      {checkout === "cancel" ? (
        <Alert>
          <AlertTitle>{m.billing_checkout_cancel_title()}</AlertTitle>
          <AlertDescription>{m.billing_checkout_cancel_body()}</AlertDescription>
        </Alert>
      ) : null}
      {billing.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {billing.isError ? (
        isCode(billing.error, "step_up_required") ? (
          <SecureFirst error={billing.error} />
        ) : (
          <ErrorAlert error={billing.error} />
        )
      ) : null}
      {billing.data ? <Overview overview={billing.data} requestedPlan={plan} /> : null}
      <UsageCard
        usage={usage.data}
        pending={usage.isPending}
        // The overview already says how to get past a step-up refusal; once is enough.
        error={usage.isError && !isCode(usage.error, "step_up_required") ? usage.error : undefined}
        readOnly={readOnlyModules(bootstrap.data)}
      />
    </div>
  );
}

/**
 * A-5: billing needs a level-2 session from an owner, and a founder fresh from signup has the
 * level-1 one an email code gives. Rather than an error card: the way to level 2 and back to this
 * very URL (`?plan=` included) — through the setup wizard's security step, which handles adding a
 * factor, confirming one, and the sessions that may not add one (it also works while a new
 * workspace is held). Only a stale proof on a level-2 session goes to the step-up screen direct.
 */
function SecureFirst({ error }: { error: unknown }) {
  // Read afresh: a factor added a moment ago (the wizard's security step) must count, and the
  // shell's copy of `/me` may predate it. No button until it is in — the wrong one sends a
  // founder round in a circle.
  const me = useQuery({ ...meQuery, refetchOnMount: "always" });
  const href = useRouterState({ select: (s) => s.location.href });
  if (me.isFetching) return <LoadingState lines={2} label={m.common_loading()} />;
  const enrolled = me.data?.session.user.mfaEnrolled === true;
  const reason = error instanceof ApiFailure ? (error.reason ?? "level") : "level";
  return (
    <Alert>
      <ShieldCheck aria-hidden="true" />
      <AlertTitle>{m.billing_secure_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{enrolled ? m.billing_secure_body_enrolled() : m.billing_secure_body()}</p>
        <Button asChild size="sm">
          {reason === "fresh" ? (
            <Link to="/auth/step-up" search={{ returnTo: href, reason }}>
              {m.billing_secure_confirm()}
            </Link>
          ) : (
            // Level 2 is the setup wizard's security step's business: it knows every case (no
            // factor, a confirmation that did not verify, a session that may not enrol here).
            <Link to="/setup" search={{ step: "secure", returnTo: href }}>
              {enrolled ? m.billing_secure_confirm() : m.billing_secure_enrol()}
            </Link>
          )}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function useProviderRedirect(path: "/billing/checkout" | "/billing/portal") {
  return useGuardedMutation({
    mutationFn: (planId: string | undefined) =>
      path === "/billing/checkout"
        ? call(api().POST("/billing/checkout", { body: { planId: planId ?? "" } }))
        : call(api().POST("/billing/portal")),
    onSuccess: (out) => billingNavigation.assign(out.url),
    onError: (error) => toast.error(describeError(error).body),
  });
}

function Overview({
  overview,
  requestedPlan,
}: {
  overview: BillingOverview;
  requestedPlan: string | undefined;
}) {
  const checkout = useProviderRedirect("/billing/checkout");
  const portal = useProviderRedirect("/billing/portal");
  const sub = overview.subscription;
  // Manual billing: the host invoices by hand and changes the plan on their side (the server
  // answers `billing_manual` to both buttons), so there is nothing to press — say who to ask.
  const selfServe = overview.driver === "stripe" && overview.canManage;
  const busy = checkout.isPending || portal.isPending;
  const isCurrent = (planId: string) =>
    sub?.planId === planId && sub.status !== "canceled" && sub.status !== "incomplete";
  // A-5: the plan signup sent the founder here to pay for, while it can still be checked out.
  // A button, never a redirect: leaving for the provider is the owner's decision.
  const finishing = selfServe
    ? overview.plans.find((p) => p.id === requestedPlan && !isCurrent(p.id))
    : undefined;
  return (
    <>
      {finishing === undefined ? null : (
        <Alert>
          <CreditCard aria-hidden="true" />
          <AlertTitle>{m.billing_plan_callout_title({ plan: finishing.name })}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{m.billing_plan_callout_body({ plan: finishing.name })}</p>
            <Button
              type="button"
              loading={checkout.isPending && checkout.variables === finishing.id}
              disabled={busy}
              onClick={() => checkout.mutate(finishing.id)}
            >
              {m.billing_plan_callout_action({ plan: finishing.name })}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <CreditCard aria-hidden="true" className="size-5 text-muted-foreground" />
            {sub === null ? m.billing_no_plan() : sub.planName}
            {sub === null ? null : (
              <Badge variant={subscriptionStatusVariant(sub.status)}>
                {subscriptionStatusLabel(sub.status)}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {sub === null ? m.billing_no_plan_body() : m.billing_current_plan()}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sub === null ? null : <SubscriptionFacts subscription={sub} />}
          {sub !== null && sub.status === "incomplete" ? (
            <CheckoutPending subscription={sub} selfServe={selfServe} />
          ) : null}
          {overview.driver === "manual" ? (
            <p className="text-sm text-muted-foreground">{m.billing_manual_body()}</p>
          ) : null}
          {overview.driver === "stripe" && !overview.canManage ? (
            <p className="text-sm text-muted-foreground">{m.billing_owner_only()}</p>
          ) : null}
          {selfServe && sub !== null ? (
            <Button
              type="button"
              variant="outline"
              loading={portal.isPending}
              disabled={busy}
              onClick={() => portal.mutate(undefined)}
            >
              <ExternalLink aria-hidden="true" />
              {m.billing_manage()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <section aria-labelledby="billing-plans" className="space-y-4">
        <h2 id="billing-plans" className="text-lg font-semibold">
          {m.billing_plans_title()}
        </h2>
        {overview.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.billing_plans_none()}</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {overview.plans.map((plan) => (
              <li key={plan.id}>
                <PlanCard
                  plan={plan}
                  // A checkout that was started but never finished is not the current plan:
                  // choosing it again is how the owner finishes (or restarts) paying for it.
                  current={isCurrent(plan.id)}
                  onChoose={
                    selfServe
                      ? {
                          pending: checkout.isPending && checkout.variables === plan.id,
                          disabled: busy,
                          choose: () => checkout.mutate(plan.id),
                        }
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/*
 * `incomplete` (E3.10 B): the provider has not confirmed a paid subscription yet — a checkout is
 * open or was abandoned, or a paid plan was assigned and nobody has checked out. Not an error:
 * say what is pending, and by when the workspace must be paid for when a deadline runs.
 */
function CheckoutPending({
  subscription: sub,
  selfServe,
}: {
  subscription: BillingSubscription;
  selfServe: boolean;
}) {
  const deadline =
    sub.graceUntil === null
      ? undefined
      : m.billing_checkout_pending_deadline({ date: formatDate(sub.graceUntil) });
  return (
    <Alert>
      <AlertTitle>{m.billing_checkout_pending_title()}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          {selfServe
            ? m.billing_checkout_pending_body_owner()
            : m.billing_checkout_pending_body_other()}
        </p>
        {deadline === undefined ? null : <p>{deadline}</p>}
      </AlertDescription>
    </Alert>
  );
}

function SubscriptionFacts({ subscription: sub }: { subscription: BillingSubscription }) {
  return (
    <div className="space-y-3">
      {isInGrace(sub) ? <GraceNotice graceUntil={sub.graceUntil} /> : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {sub.status === "trialing" && sub.trialEnd !== null ? (
          <>
            <dt className="text-muted-foreground">{m.billing_trial_ends()}</dt>
            <dd>{formatDate(sub.trialEnd)}</dd>
          </>
        ) : null}
        {sub.currentPeriodEnd !== null ? (
          <>
            <dt className="text-muted-foreground">
              {sub.cancelAtPeriodEnd ? m.billing_ends_on() : m.billing_renews_on()}
            </dt>
            <dd>{formatDate(sub.currentPeriodEnd)}</dd>
          </>
        ) : null}
      </dl>
      {sub.cancelAtPeriodEnd ? (
        <Alert variant="warning">
          <AlertTitle>{m.billing_cancel_at_period_end_title()}</AlertTitle>
          <AlertDescription>
            {sub.currentPeriodEnd === null
              ? m.billing_cancel_at_period_end_body_undated()
              : m.billing_cancel_at_period_end_body({ date: formatDate(sub.currentPeriodEnd) })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function PlanCard({
  plan,
  current,
  onChoose,
}: {
  plan: BillingPlan;
  current: boolean;
  onChoose: { pending: boolean; disabled: boolean; choose: () => void } | undefined;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {plan.name}
          {current ? <Badge variant="secondary">{m.billing_plan_current()}</Badge> : null}
        </CardTitle>
        {plan.trialDays > 0 ? (
          <CardDescription>{m.billing_plan_trial({ count: plan.trialDays })}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1 text-sm">
          {LIMIT_KINDS.map((kind) => (
            <li key={kind}>
              <span className="text-muted-foreground">{limitLabel(kind)}:</span>{" "}
              {formatLimit(kind, plan.limits)}
            </li>
          ))}
          <li>
            <span className="text-muted-foreground">{m.billing_plan_modules()}:</span>{" "}
            {formatModules(plan.limits)}
          </li>
          <li>
            <span className="text-muted-foreground">{m.billing_plan_features()}:</span>{" "}
            {formatFeatures(plan.limits)}
          </li>
        </ul>
        {onChoose !== undefined && !current ? (
          <Button
            type="button"
            loading={onChoose.pending}
            disabled={onChoose.disabled}
            onClick={onChoose.choose}
            aria-label={m.billing_plan_choose_named({ plan: plan.name })}
          >
            {m.billing_plan_choose()}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatCount(n: number): string {
  return new Intl.NumberFormat(getLocale()).format(n);
}

function formatAmount(kind: LimitKind, n: number): string {
  return kind === "storageBytes" ? formatBytes(n) : formatCount(n);
}

function formatLimit(kind: LimitKind, limits: PlanLimits | null): string {
  const max = limits?.[kind];
  return max === undefined ? m.billing_unlimited() : formatAmount(kind, max);
}

/**
 * A-3: the optional modules a plan includes; an absent list is every module. The core modules
 * (content and the kernel) are on whatever the plan says, so an empty list is "core only".
 */
function formatModules(limits: PlanLimits | null): string {
  const list = limits?.modules;
  if (list === undefined) return m.billing_plan_all_modules();
  return list.length === 0 ? m.billing_plan_core_modules_only() : formatList(list);
}

/** A-3: the features a plan includes, in the product's display order. */
function formatFeatures(limits: PlanLimits | null): string {
  const list = limits?.features;
  if (list === undefined) return m.billing_plan_all_features();
  const names = PLAN_FEATURES.filter((f) => list.includes(f)).map(planFeatureLabel);
  return names.length === 0 ? m.billing_plan_none_included() : formatList(names);
}

function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(items);
}

function UsageCard({
  usage,
  pending,
  error,
  readOnly,
}: {
  usage: WorkspaceUsage | undefined;
  pending: boolean;
  error: unknown;
  /** Modules on but outside the plan (from the bootstrap). */
  readOnly: readonly string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.billing_usage_title()}</CardTitle>
        <CardDescription>
          {usage?.today
            ? m.billing_usage_as_of({ date: formatDate(usage.today.computedAt) })
            : m.billing_usage_subtitle()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {error !== undefined ? <ErrorAlert error={error} /> : null}
        {usage ? <UsageTable usage={usage} readOnly={readOnly} /> : null}
      </CardContent>
    </Card>
  );
}

function UsageTable({ usage, readOnly }: { usage: WorkspaceUsage; readOnly: readonly string[] }) {
  const limits = usage.plan?.limits ?? null;
  return (
    <>
      {usage.today === null && usage.last30.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.billing_usage_none()}</p>
      ) : null}
      <Table aria-label={m.billing_usage_title()}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{m.billing_usage_resource()}</TableHead>
            <TableHead scope="col">{m.billing_usage_used()}</TableHead>
            <TableHead scope="col">{m.billing_usage_limit()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {LIMIT_KINDS.map((kind) => {
            const used = usedOf(usage, kind);
            const max = limits?.[kind];
            const over = used !== null && max !== undefined && used > max;
            return (
              <TableRow key={kind}>
                <TableHead scope="row" className="font-normal">
                  {limitLabel(kind)}
                </TableHead>
                <TableCell>
                  {used === null ? "—" : formatAmount(kind, used)}
                  {over ? (
                    <Badge variant="warning" className="ml-2">
                      {m.billing_usage_over()}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{formatLimit(kind, limits)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {limits?.emailsPerMonth !== undefined ? (
        <p className="text-xs text-muted-foreground">{m.billing_usage_emails_note()}</p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{m.billing_plan_modules()}</dt>
        <dd>{formatModules(limits)}</dd>
        <dt className="text-muted-foreground">{m.billing_plan_features()}</dt>
        <dd>{formatFeatures(limits)}</dd>
        {readOnly.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground">{m.billing_usage_read_only()}</dt>
            <dd>
              {formatList(readOnly)}
              <span className="block text-xs text-muted-foreground">
                {m.billing_usage_read_only_hint()}
              </span>
            </dd>
          </>
        )}
      </dl>
    </>
  );
}
