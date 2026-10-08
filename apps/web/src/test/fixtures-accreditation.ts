import type {
  AccreditationConnection,
  AccreditationProvider,
} from "../lib/accreditation-queries.js";

/*
 * Accreditation vendor fixtures (E3.7), shaped like `GET /accreditation/providers` and
 * `GET /accreditation/connection` (packages/contracts/src/accreditation.ts). Credential field keys
 * are the frozen ones from the contract; labels are the adapters' English.
 */
export const CONNECTION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8a01";
export const NOW_ISO = "2026-09-26T10:00:00.000Z";

export function verifyInvestorProvider(
  over: Partial<AccreditationProvider> = {},
): AccreditationProvider {
  return {
    driver: "verifyinvestor",
    label: "VerifyInvestor.com",
    handoff: "invite_email",
    supportsEntities: true,
    certificate: true,
    callbackSignature: "X-Signature-SHA256 HMAC",
    subProcessor: {
      name: "VerifyInvestor.com",
      purpose: "accredited investor verification",
      location: "United States",
      url: "https://www.verifyinvestor.com/privacy",
    },
    credentialFields: [
      { key: "apiToken", label: "API token", kind: "secret", required: true },
      { key: "webhookSecret", label: "Webhook secret", kind: "secret", required: false },
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        options: ["staging", "production"],
        required: true,
      },
      { key: "portalName", label: "Portal name", kind: "text", required: false },
    ],
    offered: true,
    ...over,
  };
}

export function parallelProvider(over: Partial<AccreditationProvider> = {}): AccreditationProvider {
  return {
    driver: "parallel-markets",
    label: "Parallel Markets",
    handoff: "widget",
    supportsEntities: true,
    certificate: true,
    callbackSignature: "Parallel-Signature HMAC",
    subProcessor: {
      name: "Parallel Markets",
      purpose: "accredited investor verification",
      location: "United States",
      url: "https://parallelmarkets.com/privacy",
    },
    credentialFields: [
      { key: "apiKey", label: "API key", kind: "secret", required: true },
      { key: "clientId", label: "Client ID", kind: "text", required: true },
      { key: "webhookSigningKey", label: "Webhook signing key", kind: "secret", required: false },
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        options: ["demo", "production"],
        required: true,
      },
    ],
    offered: true,
    ...over,
  };
}

export function accreditationProviders(
  providers: AccreditationProvider[] = [verifyInvestorProvider(), parallelProvider()],
) {
  return { providers };
}

export function accreditationConnection(
  over: Partial<AccreditationConnection> = {},
): AccreditationConnection {
  return {
    id: CONNECTION_ID,
    driver: "verifyinvestor",
    label: "VerifyInvestor.com",
    environment: "production",
    credentialHints: { apiToken: "••••ab12", webhookSecret: "••••cd34" },
    status: "active",
    lastVerifiedAt: NOW_ISO,
    lastError: null,
    lastCallbackAt: null,
    callbackUrl: `https://investors.example.com/webhooks/accreditation/${CONNECTION_ID}`,
    handoffUrl: "https://acme.investors.example.com/api/v1/round/current/verification/handoff",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function parallelConnection(
  over: Partial<AccreditationConnection> = {},
): AccreditationConnection {
  return accreditationConnection({
    driver: "parallel-markets",
    label: "Parallel Markets",
    environment: "demo",
    credentialHints: { apiKey: "••••ef56", clientId: "••••7890" },
    ...over,
  });
}
