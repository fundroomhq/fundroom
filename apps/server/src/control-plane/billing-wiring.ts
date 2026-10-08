import {
  type BillingJobs,
  type BillingNotifier,
  type BillingService,
  createBillingJobs,
  createBillingService,
  enqueueBillingCancel,
} from "@fundroom/billing";
import { createManualBilling } from "@fundroom/billing-manual";
import { createStripeBilling } from "@fundroom/billing-stripe";
import {
  findWorkspaceById,
  listWorkspaceOwnerContacts,
  systemContext,
  type Tx,
} from "@fundroom/db";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { BillingPort, ControlPlaneHooks } from "@fundroom/ports";
import { billingPastDueEmail } from "../mail/billing-past-due.js";
import { billingSuspendedEmail } from "../mail/billing-suspended.js";
import { SERVER_VERSION } from "../version.js";
import type { ControlPlaneWiringDeps, WiringKernel } from "./types.js";

/*
 * Billing (E3.10; owner: agent B) → `container.billing`, read by `routes/billing.ts` and
 * `routes/billing-webhook.ts`. Builds the `billing-stripe` / `billing-manual` adapter for
 * BILLING_DRIVER (with its own guarded outbound client) and the `@fundroom/billing` service.
 * `enabled`: CONTROL_PLANE=on and BILLING_DRIVER is not `none` — every billing route 404s otherwise.
 *
 * Stripe's client is its own guarded agent, never the general-purpose one: every request carries
 * the secret key, so it follows no redirect (the API never redirects; a redirect is how a
 * key-bearing request reaches a host nobody named), 10 s and 1 MiB per call, private hosts only
 * from OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS (a local fake behind STRIPE_API_BASE in tests; config
 * refuses a non-default STRIPE_API_BASE in prod).
 */
export interface BillingKernel extends WiringKernel {
  readonly enabled: boolean;
  readonly driver: "none" | "manual" | "stripe";
  readonly hooks: ControlPlaneHooks;
  /** The provider adapter; `null` when disabled. The webhook route verifies through it. */
  readonly port: BillingPort | null;
  /** `null` when disabled. */
  readonly service: BillingService | null;
  /** The jobs' bodies, callable directly (tests, and nothing else). `null` when disabled. */
  readonly tasks: BillingJobs | null;
  /**
   * In a workspace's soft-delete transaction: enqueue `billing.cancel` (Stripe only; the job
   * cancels only a live provider subscription, and only if the workspace is still deleted).
   * `undefined` when there is nothing to cancel with (billing off, or the manual driver).
   */
  readonly cancelOnDelete?: ((tx: Tx, workspaceId: string) => Promise<void>) | undefined;
}

/** Stripe client budget: one API call. */
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_MAX_RESPONSE_BYTES = 1024 * 1024;

export function createBillingWiring(deps: ControlPlaneWiringDeps): BillingKernel {
  const raw = deps.config.raw;
  const driver = raw.BILLING_DRIVER;
  const enabled = deps.controlPlaneEnabled && driver !== "none";
  if (!enabled) {
    return {
      enabled: false,
      driver,
      hooks: {},
      port: null,
      service: null,
      tasks: null,
      cancelOnDelete: undefined,
      jobs: [],
      async close() {},
    };
  }
  const log = deps.log("billing");
  let outbound: OutboundHttp | undefined;
  let port: BillingPort;
  if (driver === "stripe") {
    outbound = createOutboundHttp({
      allowPrivate: false,
      allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
      userAgent: `FundRoom/${SERVER_VERSION} (+billing)`,
      timeoutMs: STRIPE_TIMEOUT_MS,
      maxResponseBytes: STRIPE_MAX_RESPONSE_BYTES,
      maxConcurrentLookups: 4,
      maxRedirects: 0,
      log,
    });
    port = createStripeBilling({
      fetch: outbound.fetch,
      apiBase: raw.STRIPE_API_BASE,
      secretKey: raw.STRIPE_SECRET_KEY,
      webhookSecret: raw.STRIPE_WEBHOOK_SECRET,
      now: deps.now,
    });
  } else {
    port = createManualBilling();
  }

  /** The owners' mail, after the change committed (a failure is logged by the service). */
  const notify: BillingNotifier = async ({ kind, workspaceId, graceUntil }) => {
    const ws = await findWorkspaceById(deps.db, workspaceId);
    if (ws === undefined) return;
    const owners = await deps.db.withTenant(systemContext(workspaceId), (tx) =>
      listWorkspaceOwnerContacts(tx),
    );
    // BASE_URL, never a custom domain: the link must work whatever the tenant's DNS says.
    const billingUrl = deps.workspaceUrl(
      { slug: ws.slug, primaryHost: null },
      "/admin/billing",
    ).href;
    for (const owner of owners) {
      const message =
        kind === "past_due"
          ? billingPastDueEmail(owner.email, {
              workspaceId,
              workspaceName: ws.name,
              graceUntil: graceUntil ?? deps.now(),
              billingUrl,
              locale: owner.locale,
            })
          : billingSuspendedEmail(owner.email, {
              workspaceId,
              workspaceName: ws.name,
              billingUrl,
              locale: owner.locale,
            });
      try {
        await deps.mailer.send(message);
      } catch (error) {
        log("billing.mail_failed", {
          level: "warn",
          kind,
          workspaceId,
          membershipId: owner.membershipId,
          error: error instanceof Error ? error.name : "error",
        });
      }
    }
  };

  const serviceDeps = {
    db: deps.db,
    audit: deps.audit,
    queue: deps.queue,
    port,
    graceDays: raw.BILLING_GRACE_DAYS,
    // A-2: the Stripe meter event names are the operator's (defaults `fundroom_*`).
    meters: {
      staffSeats: raw.BILLING_METER_SEATS_EVENT,
      storageGb: raw.BILLING_METER_STORAGE_EVENT,
    },
    now: deps.now,
    invalidate: () => deps.resolver.invalidate(),
    notify,
    log,
  };
  const service = createBillingService(serviceDeps);
  const tasks = createBillingJobs(serviceDeps);
  return {
    enabled: true,
    driver,
    hooks: service.hooks,
    port,
    service,
    tasks,
    cancelOnDelete:
      driver === "stripe"
        ? (tx, workspaceId) => enqueueBillingCancel(deps.queue, tx, workspaceId, "deleted")
        : undefined,
    jobs: tasks.definitions,
    async close() {
      await outbound?.close();
    },
  };
}
