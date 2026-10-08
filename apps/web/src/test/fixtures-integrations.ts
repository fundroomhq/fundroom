import type { FundRoomSchemas } from "@fundroom/sdk";

/*
 * Integrations hub fixtures (E3.6): the six providers as their adapters describe themselves
 * (credential keys per contract §3: Stripe `restrictedKey`, Calendly `personalAccessToken`,
 * Cal.com none), connections in every health state, booking links and recorded bookings.
 */
type ProviderInfo = FundRoomSchemas["IntegrationProviderInfo"];
type Provider = ProviderInfo["provider"];
type Connection = FundRoomSchemas["IntegrationConnection"];
type BookingLink = FundRoomSchemas["BookingLink"];
type Booking = FundRoomSchemas["IntegrationBooking"];

export const WEBHOOK_SECRET = "whsec_Y2FsY29tU2VjcmV0U2hvd25PbmNlT25seQ";
export const START_URL =
  "https://acme.fundroom.test/oauth/integrations/start?ticket=abcdefghijklmnop";
export const GROUP_BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8a01";
export const GROUP_LEAD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8a02";
export const LINK_CEO_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8b01";
export const LINK_CFO_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8b02";
export const XERO_ORG_A = "8a1f2c3d-0000-4000-8000-00000000000a";
export const XERO_ORG_B = "8a1f2c3d-0000-4000-8000-00000000000b";

const CONNECTION_IDS: Record<Provider, string> = {
  quickbooks: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c01",
  xero: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c02",
  stripe: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c03",
  slack: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c04",
  calendly: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c05",
  calcom: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8c06",
};

const sub = (name: string, purpose: string, region = "US") => ({
  name,
  purpose,
  region,
  dpaUrl: `https://${name.toLowerCase().replace(/[^a-z]/gu, "")}.example/dpa`,
});

const kpi = (keys: [string, string, "flow" | "stock", boolean][]) =>
  keys.map(([key, label, kind, historical]) => ({
    key,
    label,
    kind,
    unit: "currency" as const,
    historical,
  }));

const ACCOUNTING = kpi([
  ["revenue", "Revenue", "flow", true],
  ["expenses", "Expenses", "flow", true],
  ["net_income", "Net income", "flow", true],
  ["cash", "Cash", "stock", true],
]);

export function integrationProviders(
  available: Partial<Record<Provider, boolean>> = {},
): FundRoomSchemas["IntegrationProviderList"] {
  const providers: ProviderInfo[] = [
    {
      provider: "quickbooks",
      displayName: "QuickBooks Online",
      capabilities: ["kpi"],
      auth: "oauth2",
      available: available.quickbooks ?? true,
      credentialFields: [],
      scopeExplanation: [
        "Reads your profit and loss and balance sheet reports.",
        "Never writes to your books.",
      ],
      kpiMetrics: ACCOUNTING,
      bookingLinkHosts: [],
      subProcessor: sub("Intuit", "Accounting data"),
    },
    {
      provider: "xero",
      displayName: "Xero",
      capabilities: ["kpi"],
      auth: "oauth2",
      available: available.xero ?? true,
      credentialFields: [],
      scopeExplanation: ["Reads your profit and loss, balance sheet and bank summary."],
      kpiMetrics: ACCOUNTING,
      bookingLinkHosts: [],
      subProcessor: sub("Xero", "Accounting data", "US"),
    },
    {
      provider: "stripe",
      displayName: "Stripe",
      capabilities: ["kpi"],
      auth: "secret",
      available: available.stripe ?? true,
      credentialFields: [
        { key: "restrictedKey", label: "Restricted API key", kind: "secret", required: true },
      ],
      scopeExplanation: ["Reads charges, balance transactions, customers and subscriptions."],
      kpiMetrics: [
        ...kpi([
          ["gross_volume", "Gross volume", "flow", true],
          ["mrr", "MRR", "stock", false],
        ]),
      ],
      bookingLinkHosts: [],
      subProcessor: sub("Stripe", "Payments data"),
    },
    {
      provider: "slack",
      displayName: "Slack",
      capabilities: ["chat"],
      auth: "oauth2",
      available: available.slack ?? false,
      credentialFields: [],
      scopeExplanation: ["Posts notifications to channels you choose."],
      kpiMetrics: [],
      bookingLinkHosts: [],
      subProcessor: sub("Slack", "Chat notifications"),
    },
    {
      provider: "calendly",
      displayName: "Calendly",
      capabilities: ["booking"],
      auth: "secret",
      available: available.calendly ?? true,
      credentialFields: [
        {
          key: "personalAccessToken",
          label: "Personal access token",
          kind: "secret",
          required: true,
        },
      ],
      scopeExplanation: ["Receives invitee created and cancelled events."],
      kpiMetrics: [],
      bookingLinkHosts: ["calendly.com"],
      subProcessor: sub("Calendly", "Scheduling"),
    },
    {
      provider: "calcom",
      displayName: "Cal.com",
      capabilities: ["booking"],
      auth: "secret",
      available: available.calcom ?? true,
      credentialFields: [],
      scopeExplanation: ["Receives booking created, cancelled and rescheduled events."],
      kpiMetrics: [],
      bookingLinkHosts: ["cal.com", "app.cal.com"],
      subProcessor: sub("Cal.com", "Scheduling", "EU"),
    },
  ];
  return { providers };
}

export function integrationConnection(
  provider: Provider,
  over: Partial<Connection> = {},
): Connection {
  const booking = provider === "calendly" || provider === "calcom";
  return {
    id: CONNECTION_IDS[provider],
    provider,
    status: "active",
    environment: "production",
    accountLabel: provider === "quickbooks" ? "Acme Ltd (realm 1234)" : "Acme",
    externalAccountId: "acct-1",
    scope: null,
    lastSuccessAt: "2026-09-25T05:15:00.000Z",
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    connectedAt: "2026-09-01T10:00:00.000Z",
    webhookUrl: booking
      ? `https://acme.fundroom.test/webhooks/integrations/${CONNECTION_IDS[provider]}`
      : null,
    ...over,
  };
}

export function bookingLink(over: Partial<BookingLink> = {}): BookingLink {
  return {
    id: LINK_CEO_ID,
    provider: "calcom",
    url: "https://cal.com/acme/investor-call",
    label: "Book a call with the CEO",
    description: "30 minutes, video",
    audience: { kind: "all" },
    position: 0,
    enabled: true,
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    ...over,
  };
}

export function cfoLink(over: Partial<BookingLink> = {}): BookingLink {
  return bookingLink({
    id: LINK_CFO_ID,
    provider: "calendly",
    url: "https://calendly.com/acme-cfo/diligence",
    label: "Diligence Q&A with the CFO",
    description: null,
    audience: { kind: "groups", groupIds: [GROUP_LEAD_ID] },
    position: 1,
    ...over,
  });
}

export function groupList(): FundRoomSchemas["GroupList"] {
  return {
    groups: [
      {
        id: GROUP_BOARD_ID,
        name: "Board",
        kind: "custom",
        memberCount: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: GROUP_LEAD_ID,
        name: "Lead investors",
        kind: "custom",
        memberCount: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  } as FundRoomSchemas["GroupList"];
}

export function integrationBooking(over: Partial<Booking> = {}): Booking {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8d01",
    provider: "calcom",
    status: "booked",
    startsAt: "2026-10-02T15:00:00.000Z",
    endsAt: "2026-10-02T15:30:00.000Z",
    inviteeEmail: "ada@investor.test",
    inviteeName: "Ada Lovelace",
    eventName: "Investor call",
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02",
    receivedAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T09:00:00.000Z",
    ...over,
  };
}
