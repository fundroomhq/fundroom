import type { FundRoomSchemas } from "@fundroom/sdk";

/*
 * E-signature fixtures (E3.5) for the admin screens: the four drivers as the adapters describe
 * themselves (credential keys per the adapter packages), one connection and envelopes.
 */
type DriverInfo = FundRoomSchemas["ESignDriverInfo"];
type Connection = FundRoomSchemas["ESignConnection"];
type Envelope = FundRoomSchemas["ESignEnvelope"];

export const CONNECTION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7a01";
export const ENVELOPE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b01";
export const COMPLETED_ENVELOPE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b02";
export const CALLBACK_SECRET = "whsec_Qm9vT2ZUaGVTZWNyZXRTaG93bk9uY2U";

const subProcessor = (name: string, region: string) => ({
  name,
  purpose: "Electronic signatures",
  region,
  dpaUrl: `https://${name.toLowerCase().replace(/\s+/gu, "")}.example/dpa`,
  certifications: ["SOC 2"],
});

export function esignDrivers(): FundRoomSchemas["ESignDriverList"] {
  const drivers: DriverInfo[] = [
    {
      meta: {
        driver: "documenso",
        displayName: "Documenso",
        selfHostable: true,
        baseUrl: { required: false, default: "https://app.documenso.com" },
        supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
        callbackSecret: "ours",
        subProcessor: subProcessor("Documenso", "EU"),
      },
      credentialFields: [{ key: "apiToken", label: "API token", kind: "secret", required: true }],
    },
    {
      meta: {
        driver: "docuseal",
        displayName: "DocuSeal",
        selfHostable: true,
        baseUrl: { required: false, default: "https://api.docuseal.com" },
        supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
        callbackSecret: "ours",
        subProcessor: subProcessor("DocuSeal", "US"),
      },
      credentialFields: [{ key: "apiToken", label: "API token", kind: "secret", required: true }],
    },
    {
      meta: {
        driver: "docusign",
        displayName: "DocuSign",
        selfHostable: false,
        baseUrl: { required: false },
        supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
        callbackSecret: "vendor",
        subProcessor: subProcessor("DocuSign", "US"),
      },
      credentialFields: [
        {
          key: "environment",
          label: "Environment",
          kind: "select",
          options: ["demo", "production"],
          required: true,
        },
        { key: "integrationKey", label: "Integration key", kind: "text", required: true },
        { key: "userId", label: "User ID", kind: "text", required: true },
        { key: "privateKeyPem", label: "RSA private key", kind: "pem", required: true },
        { key: "accountId", label: "Account ID", kind: "text", required: false },
        { key: "connectHmacKey", label: "Connect HMAC key", kind: "secret", required: true },
        {
          key: "connectHmacKeySecondary",
          label: "Secondary Connect HMAC key",
          kind: "secret",
          required: false,
        },
      ],
    },
    {
      meta: {
        driver: "dropbox-sign",
        displayName: "Dropbox Sign",
        selfHostable: false,
        baseUrl: { required: false },
        supports: { templates: true, pdf: true, embeddedSigning: false, void: true },
        callbackSecret: "vendor",
        subProcessor: subProcessor("Dropbox Sign", "US"),
      },
      credentialFields: [
        { key: "apiKey", label: "API key", kind: "secret", required: true },
        {
          key: "testMode",
          label: "Mode",
          kind: "select",
          options: ["test", "live"],
          required: true,
        },
      ],
    },
  ];
  return { drivers };
}

export function esignConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: CONNECTION_ID,
    driver: "documenso",
    displayName: "Documenso",
    status: "active",
    supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
    baseUrlHost: "sign.acme.test",
    callbackUrl: `https://acme.fundroom.test/api/v1/webhooks/esign/${CONNECTION_ID}`,
    callbackSecretKind: "ours",
    credentialHints: { apiToken: "••••ab12" },
    lastVerifiedAt: "2026-09-20T10:00:00.000Z",
    lastError: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...over,
  };
}

export function esignEnvelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: ENVELOPE_ID,
    purpose: "round_closing",
    subject: { module: "round", kind: "commitment", id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5705" },
    status: "sent",
    signerStatus: "viewed",
    signerName: "Ada Lovelace",
    signerEmail: "ada@example.com",
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5706",
    title: "Seed 2026 subscription agreement",
    driver: "documenso",
    sentAt: "2026-09-21T10:00:00.000Z",
    completedAt: null,
    hasSigned: false,
    hasCertificate: false,
    vaultedDocumentId: null,
    errorCode: null,
    createdAt: "2026-09-21T09:59:00.000Z",
    ...over,
  };
}

export function completedNdaEnvelope(over: Partial<Envelope> = {}): Envelope {
  return esignEnvelope({
    id: COMPLETED_ENVELOPE_ID,
    purpose: "nda",
    subject: {
      module: "compliance",
      kind: "legal_document",
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7c01",
    },
    status: "completed",
    signerStatus: "signed",
    signerName: "Grace Brewster",
    signerEmail: "grace@example.com",
    title: "Mutual NDA",
    completedAt: "2026-09-22T12:00:00.000Z",
    hasSigned: true,
    hasCertificate: true,
    vaultedDocumentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7d01",
    ...over,
  });
}
