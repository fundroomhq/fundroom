import type {
  KpiBinding,
  KpiSourceMetric,
  KpiSourceProvider,
  KpiSources,
} from "../lib/metrics-queries.js";
import type { NotifyChannel, SlackChannelRef } from "../lib/notify-queries.js";
import { METRIC_DEFINITION_ID, notifyChannel } from "./mock-api.js";

/*
 * Fixtures for the E3.6 consumers of the Integrations hub: the metrics KPI-source bindings and
 * the notify `slack_app` channel kind. Typed against the hand-written shapes in `lib/` until the
 * SDK is regenerated with these routes.
 */

export const KPI_BINDING_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7a01";

export const QBO_METRICS: KpiSourceMetric[] = [
  { key: "revenue", label: "Revenue", kind: "flow", unit: "currency", historical: true },
  { key: "expenses", label: "Expenses", kind: "flow", unit: "currency", historical: true },
  { key: "net_income", label: "Net income", kind: "flow", unit: "currency", historical: true },
  { key: "cash", label: "Cash", kind: "stock", unit: "currency", historical: true },
];

export const STRIPE_METRICS: KpiSourceMetric[] = [
  { key: "gross_volume", label: "Gross volume", kind: "flow", unit: "currency", historical: true },
  { key: "net_volume", label: "Net volume", kind: "flow", unit: "currency", historical: true },
  { key: "new_customers", label: "New customers", kind: "flow", unit: "count", historical: true },
  { key: "mrr", label: "MRR", kind: "stock", unit: "currency", historical: false },
  {
    key: "active_subscriptions",
    label: "Active subscriptions",
    kind: "stock",
    unit: "count",
    historical: false,
  },
];

export function kpiBinding(over: Partial<KpiBinding> = {}): KpiBinding {
  return {
    id: KPI_BINDING_ID,
    definitionId: METRIC_DEFINITION_ID,
    provider: "quickbooks",
    sourceMetric: "revenue",
    enabled: true,
    status: "ok",
    lastSyncAt: "2026-09-26T04:55:00.000Z",
    lastSuccessAt: "2026-09-26T04:55:00.000Z",
    lastError: null,
    consecutiveFailures: 0,
    historyFrom: "2024-10",
    historyNote: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-26T04:55:00.000Z",
    ...over,
  };
}

export function kpiProvider(over: Partial<KpiSourceProvider> = {}): KpiSourceProvider {
  const connected = over.connected ?? true;
  return {
    provider: "quickbooks",
    connected,
    status: connected ? "active" : null,
    accountLabel: null,
    lastSuccessAt: connected ? "2026-09-26T04:55:00.000Z" : null,
    lastError: null,
    metrics: QBO_METRICS,
    ...over,
  };
}

export function kpiSources(over: Partial<KpiSources> = {}): KpiSources {
  return {
    providers: [
      kpiProvider({ provider: "quickbooks", accountLabel: "Acme Inc.", metrics: QBO_METRICS }),
      kpiProvider({ provider: "xero", connected: false, status: null, metrics: QBO_METRICS }),
      kpiProvider({
        provider: "stripe",
        status: "reauth_required",
        accountLabel: "acct_1Acme",
        lastError: "Stripe refused the key",
        metrics: STRIPE_METRICS,
      }),
    ],
    bindings: [kpiBinding()],
    ...over,
  };
}

export const SLACK_APP_CHANNEL_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c09";

export const SLACK_CHANNELS: SlackChannelRef[] = [
  { id: "C0000DEALS", name: "deals", isPrivate: false },
  { id: "C000FOUNDR", name: "founders", isPrivate: true },
];

export function slackAppChannel(over: Partial<NotifyChannel> = {}): NotifyChannel {
  return {
    ...notifyChannel({ id: SLACK_APP_CHANNEL_ID, name: "Deal flow" }),
    kind: "slack_app",
    urlHint: null,
    slackChannelId: "C0000DEALS",
    slackChannelName: "deals",
    ...over,
  };
}
