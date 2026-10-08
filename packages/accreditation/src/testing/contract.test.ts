import type { AccreditationVendorDriver } from "@fundroom/ports";
import { describeAccreditationPortContract } from "./contract.js";
import { createMemoryAccreditationAdapter, memorySignature } from "./memory-adapter.js";

/** The in-memory adapter honours the same contract every vendor adapter runs. */
for (const driver of [
  "verifyinvestor",
  "parallel-markets",
] as const satisfies readonly AccreditationVendorDriver[]) {
  describeAccreditationPortContract(
    `memory (${driver})`,
    async ({ credentials, callbackSecret }) => {
      const { definition, vendor } = createMemoryAccreditationAdapter(driver);
      const apiKey = credentials === "invalid" ? "invalid" : "memory-api-secret-value";
      const webhook = "memory-webhook-secret-value";
      const creds: Record<string, string> =
        driver === "verifyinvestor"
          ? { apiToken: apiKey, environment: "staging" }
          : { apiKey, clientId: "client-123", environment: "demo" };
      if (callbackSecret !== false) {
        creds[driver === "verifyinvestor" ? "webhookSecret" : "webhookSigningKey"] = webhook;
      }
      const port = definition.create({ credentials: creds }, { fetch, now: () => new Date() });
      return {
        port,
        secrets: [apiKey, webhook],
        vendor: {
          accredit: (ref, o) => vendor.accredit(ref, o),
          reject: (ref) => vendor.reject(ref),
          cancel: (ref) => vendor.cancel(ref),
          unknownStatus: (ref, raw) =>
            vendor.setStatus(ref, { status: "unknown", vendorStatus: raw }),
          failNext: (kind) => vendor.failNext(1, kind),
          callback: (refs) => vendor.callbackRequest(refs, webhook),
          forgedCallback: (refs) => {
            const rawBody = vendor.callbackBody(refs);
            return {
              headers: new Headers({
                "x-memory-signature": memorySignature("wrong-secret", rawBody),
              }),
              rawBody,
            };
          },
        },
        cleanup: async () => {},
      };
    },
    { callbackTimestamp: false },
  );
}
