import { type BillingPort, BillingProviderError, BillingSignatureError } from "@fundroom/ports";

/*
 * `@fundroom/billing-manual` (E3.10, ADR-0058; owner: agent B). The operator invoices outside
 * FundRoom and records the subscription through `POST /platform/workspaces/{id}/subscription`;
 * checkout and portal answer 409 `billing_manual` in the route, and there are no webhooks.
 *
 * So every provider call here refuses: the service never reaches them with this driver (it
 * branches on `driver` first), and a caller that does has a bug worth a loud error rather than a
 * silent success. `reportUsage` is the exception — the port documents it as a no-op for manual.
 */

/** The manual billing adapter. */
export function createManualBilling(): BillingPort {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new BillingProviderError(`manual billing has no ${name}`, false);
  };
  return {
    driver: "manual",
    meta: { subProcessor: null },
    createCheckout: refuse("checkout"),
    createPortalSession: refuse("customer portal"),
    parseWebhook() {
      throw new BillingSignatureError("manual billing receives no webhooks");
    },
    getSubscription: refuse("provider subscription"),
    async reportUsage() {},
    cancel: refuse("provider subscription"),
  };
}
