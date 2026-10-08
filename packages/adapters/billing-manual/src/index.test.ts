import { BillingProviderError, BillingSignatureError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createManualBilling } from "./index.js";

describe("createManualBilling", () => {
  const port = createManualBilling();

  it("is the manual driver with no sub-processor", () => {
    expect(port.driver).toBe("manual");
    expect(port.meta.subProcessor).toBeNull();
  });

  it("refuses every provider call, loudly", async () => {
    await expect(
      port.createCheckout({
        workspaceId: "w",
        customerRef: null,
        email: "o@example.test",
        legalName: "A",
        priceRef: "p",
        trialDays: 0,
        successUrl: "https://a.test/s",
        cancelUrl: "https://a.test/c",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(BillingProviderError);
    await expect(
      port.createPortalSession({ customerRef: "c", returnUrl: "https://a.test" }),
    ).rejects.toBeInstanceOf(BillingProviderError);
    await expect(port.getSubscription("s")).rejects.toBeInstanceOf(BillingProviderError);
    await expect(port.cancel("s")).rejects.toBeInstanceOf(BillingProviderError);
    expect(() =>
      port.parseWebhook({ rawBody: new Uint8Array(), headers: new Headers(), now: new Date() }),
    ).toThrow(BillingSignatureError);
  });

  it("reports usage as a no-op", async () => {
    await expect(
      port.reportUsage({
        customerRef: "c",
        meter: "m",
        value: 1,
        timestamp: new Date(),
        identifier: "i",
      }),
    ).resolves.toBeUndefined();
  });
});
