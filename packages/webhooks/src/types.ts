import type {
  WebhookDisabledReason as DbWebhookDisabledReason,
  WebhookDeliveryStatus,
} from "@fundroom/db";
import type { JsonObject } from "@fundroom/ports";

/*
 * Outbound webhook domain types (E3.4, ADR-0052). `*Record` is the row as this package sees it
 * (sealed columns stay sealed); `*View` is what the routes return (contract `WebhookEndpoint`,
 * `WebhookDelivery`). The URL and the secrets never appear in a view.
 */

export {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DISABLED_REASONS,
  type WebhookDeliveryStatus,
} from "@fundroom/db";
export type WebhookDisabledReason = DbWebhookDisabledReason;

/** Workspace key purpose for the sealed URL and secrets. */
export const WEBHOOK_KEY_PURPOSE = "webhook-secret";
/** Endpoints per workspace; one more → 409 `conflict` `too_many_endpoints`. */
export const MAX_WEBHOOK_ENDPOINTS = 20;
export const WEBHOOK_DESCRIPTION_MAX = 200;
/** Secret rotation overlap: 0..168 hours, default 24. */
export const WEBHOOK_ROTATE_GRACE_MAX_HOURS = 168;
export const WEBHOOK_ROTATE_GRACE_DEFAULT_HOURS = 24;
/** Delays before retry n (1-based): 9 retries ≈ 47 h, then `failed` (the DLQ). */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [
  30, 120, 600, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400,
] as const;
/** A `Retry-After` is honoured up to this many seconds. */
export const WEBHOOK_MAX_RETRY_AFTER_SECONDS = 3_600;
/** Exhausted deliveries in a row before the endpoint auto-disables (`failing`). */
export const WEBHOOK_AUTO_DISABLE_AFTER = 20;
/** A `sending` claim older than this is stale and may be re-claimed. */
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;
export const WEBHOOK_HTTP_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const WEBHOOK_WORKER_CONCURRENCY = 4;
export const WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT = 10;
export const WEBHOOK_LAST_ERROR_MAX = 300;
export const WEBHOOK_RESPONSE_EXCERPT_MAX = 512;
export const WEBHOOK_RETENTION_DAYS = 30;
export const WEBHOOK_USER_AGENT = "FundRoom-Webhooks/1";
/** Synthetic topic for test sends; never subscribable. */
export const WEBHOOK_PING_TOPIC = "webhook.ping";
/** Topics delivered only when person-level tracking consent allows it for that member. */
export const PERSON_LEVEL_WEBHOOK_TOPICS: readonly string[] = [
  "document.viewed",
  "document.downloaded",
  "update.viewed",
];
/** Rate limits: redeliver per workspace, test per endpoint. */
export const WEBHOOK_REDELIVER_LIMIT = { max: 60, windowMs: 60 * 60_000 } as const;
export const WEBHOOK_TEST_LIMIT = { max: 10, windowMs: 60_000 } as const;
export const WEBHOOK_JOBS = {
  deliver: "webhooks.deliver",
  deliverDue: "webhooks.deliver-due",
  retention: "webhooks.retention",
} as const;
export const WEBHOOK_FANOUT_SUBSCRIPTION = "webhooks.fanout";

/** One sealed column's key reference (SHE1). */
export interface SealedRef {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

/** `webhook_endpoint.encryption`: one ref per sealed column. */
export interface EndpointEncryption {
  readonly url?: SealedRef | undefined;
  readonly secret?: SealedRef | undefined;
  readonly secretPrev?: SealedRef | undefined;
}
export const ENDPOINT_ENCRYPTION_SCHEMA_VERSION = 1;

/** One `core.webhook_endpoint` row. */
export interface WebhookEndpointRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly description: string | null;
  readonly urlEnc: Uint8Array;
  readonly encryption: EndpointEncryption;
  readonly urlHost: string;
  readonly urlHint: string;
  readonly secretEnc: Uint8Array;
  readonly secretPrevEnc: Uint8Array | null;
  readonly secretPrevExpiresAt: Date | null;
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason: WebhookDisabledReason | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly createdByMembershipId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The body sent (ids only, as on the outbox). */
export interface WebhookPayload {
  readonly id: string;
  readonly type: string;
  /** ISO time the event was created. */
  readonly timestamp: string;
  readonly workspaceId: string;
  readonly data: JsonObject;
  readonly schemaVersion: number;
}
export const WEBHOOK_PAYLOAD_SCHEMA_VERSION = 1;

/** One `core.webhook_delivery` row. */
export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly topic: string;
  readonly eventId: string;
  readonly payload: JsonObject;
  readonly payloadSchemaVersion: number;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly claimedAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly lastResponseExcerpt: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly manual: boolean;
}

/** Deliveries of one endpoint in the last 24 h, by status (detail only). */
export type DeliveryStatusCounts = Readonly<Record<WebhookDeliveryStatus, number>>;

/** The contract's `WebhookEndpoint` (dates as ISO strings). */
export interface WebhookEndpointView {
  readonly id: string;
  readonly description: string | null;
  readonly urlHost: string;
  readonly urlHint: string;
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason: WebhookDisabledReason | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  /** The previous secret is still valid (rotation overlap). */
  readonly secretRotating: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Detail only. */
  readonly stats?: { readonly last24h: DeliveryStatusCounts } | undefined;
}

/** The contract's `WebhookDelivery`; `payload`/`lastResponseExcerpt` on the detail only. */
export interface WebhookDeliveryView {
  readonly id: string;
  readonly endpointId: string;
  readonly topic: string;
  readonly eventId: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly manual: boolean;
  readonly payload?: JsonObject | undefined;
  readonly lastResponseExcerpt?: string | null | undefined;
}

export function toEndpointView(
  e: WebhookEndpointRecord,
  now: Date,
  stats?: DeliveryStatusCounts,
): WebhookEndpointView {
  return {
    id: e.id,
    description: e.description,
    urlHost: e.urlHost,
    urlHint: e.urlHint,
    events: [...e.events],
    enabled: e.enabled,
    disabledReason: e.disabledReason,
    consecutiveFailures: e.consecutiveFailures,
    lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: e.lastFailureAt?.toISOString() ?? null,
    secretRotating:
      e.secretPrevEnc !== null &&
      e.secretPrevExpiresAt !== null &&
      e.secretPrevExpiresAt.getTime() > now.getTime(),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    ...(stats === undefined ? {} : { stats: { last24h: stats } }),
  };
}

export function toDeliveryView(d: WebhookDeliveryRecord, detail = false): WebhookDeliveryView {
  return {
    id: d.id,
    endpointId: d.endpointId,
    topic: d.topic,
    eventId: d.eventId,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    lastDurationMs: d.lastDurationMs,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    manual: d.manual,
    ...(detail ? { payload: bodyOf(d), lastResponseExcerpt: d.lastResponseExcerpt } : {}),
  };
}

/**
 * The body sent, in the documented key order with `id` (= `webhook-id`) first, then `eventId`
 * (the delivery's `event_id`: the outbox id, or `ping:<uuid>`) — stable across a manual
 * redelivery, which gets a new `id`, so a receiver can dedupe the re-send against the original.
 * The stored `payload` is everything but those two, and jsonb does not keep key order, so the
 * order is restored here rather than trusted from the column.
 */
export function bodyOf(d: Pick<WebhookDeliveryRecord, "id" | "eventId" | "payload">): JsonObject {
  const payload = d.payload;
  return {
    id: d.id,
    eventId: d.eventId,
    type: payload["type"] ?? null,
    timestamp: payload["timestamp"] ?? null,
    workspaceId: payload["workspaceId"] ?? null,
    data: payload["data"] ?? {},
    schemaVersion: payload["schemaVersion"] ?? WEBHOOK_PAYLOAD_SCHEMA_VERSION,
  };
}
