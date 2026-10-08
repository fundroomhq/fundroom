import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Outbound webhooks (E3.4, ADR-0052). Kernel routes behind `webhooks.read` / `webhooks.manage`.
 * The endpoint URL is never returned (only `urlHost` + a ≤4-character hint), and the signing
 * secret is on the wire once — in the create or rotate-secret response.
 */
export type WebhookEndpoint = FundRoomSchemas["WebhookEndpoint"];
export type WebhookTopic = FundRoomSchemas["WebhookTopics"]["topics"][number];
export type CreatedWebhookEndpoint = FundRoomSchemas["CreatedWebhookEndpoint"];
export type RotatedWebhookSecret = FundRoomSchemas["RotatedWebhookSecret"];
export type WebhookDelivery = FundRoomSchemas["WebhookDelivery"];
export type WebhookDeliveryDetail = FundRoomSchemas["WebhookDeliveryDetail"];
export type WebhookDeliveryList = FundRoomSchemas["WebhookDeliveryList"];
export type WebhookDeliveryStatus = WebhookDelivery["status"];
export type WebhookDisabledReason = NonNullable<WebhookEndpoint["disabledReason"]>;

export const WEBHOOKS_KEY = ["webhooks"] as const;

/**
 * How a receiver verifies a delivery. The repo's `docs/api/webhooks.md` has the Node, Python and
 * PHP recipes; the Standard Webhooks spec is what every one of them implements.
 */
export const WEBHOOK_VERIFY_DOCS_URL = "https://www.standardwebhooks.com/";

export const webhookTopicsQuery = queryOptions({
  queryKey: [...WEBHOOKS_KEY, "topics"],
  queryFn: () => call(api().GET("/webhooks/topics")),
});

/** At most 20 endpoints per workspace, so one page is the whole list. */
export const webhookEndpointsQuery = queryOptions({
  queryKey: [...WEBHOOKS_KEY, "endpoints"],
  queryFn: () => call(api().GET("/webhooks/endpoints")),
});

export function webhookEndpointQuery(id: string) {
  return queryOptions({
    queryKey: [...WEBHOOKS_KEY, "endpoint", id],
    queryFn: () => call(api().GET("/webhooks/endpoints/{id}", { params: { path: { id } } })),
  });
}

export const DELIVERY_TABS = ["all", "failed", "pending", "succeeded"] as const;
export type DeliveryTab = (typeof DELIVERY_TABS)[number];

/** Newest first, keyset-paged; the cursor is opaque. */
export function webhookDeliveriesQuery(
  endpointId: string,
  tab: DeliveryTab,
  topic: string | undefined,
  limit = 50,
) {
  return infiniteQueryOptions({
    queryKey: [...WEBHOOKS_KEY, "deliveries", endpointId, tab, topic ?? null, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/webhooks/deliveries", {
          params: {
            query: {
              endpointId,
              limit,
              ...(tab === "all" ? {} : { status: tab }),
              ...(topic === undefined ? {} : { topic }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: WebhookDeliveryList) => last.nextCursor ?? undefined,
  });
}

export function webhookDeliveryQuery(id: string) {
  return queryOptions({
    queryKey: [...WEBHOOKS_KEY, "delivery", id],
    queryFn: () => call(api().GET("/webhooks/deliveries/{id}", { params: { path: { id } } })),
  });
}

export function deliveryTabLabel(tab: DeliveryTab): string {
  switch (tab) {
    case "all":
      return m.webhooks_tab_all();
    case "failed":
      return m.webhooks_tab_failed();
    case "pending":
      return m.webhooks_tab_pending();
    case "succeeded":
      return m.webhooks_tab_succeeded();
  }
}

export function deliveryStatusLabel(status: WebhookDeliveryStatus): string {
  switch (status) {
    case "pending":
      return m.webhooks_delivery_pending();
    case "sending":
      return m.webhooks_delivery_sending();
    case "succeeded":
      return m.webhooks_delivery_succeeded();
    case "failed":
      return m.webhooks_delivery_failed();
    case "cancelled":
      return m.webhooks_delivery_cancelled();
  }
}

export function deliveryStatusVariant(
  status: WebhookDeliveryStatus,
): "success" | "destructive" | "secondary" | "outline" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "pending":
    case "sending":
      return "secondary";
    case "cancelled":
      return "outline";
  }
}

export function disabledReasonLabel(reason: WebhookDisabledReason): string {
  switch (reason) {
    case "gone":
      return m.webhooks_disabled_gone();
    case "failing":
      return m.webhooks_disabled_failing();
    case "manual":
      return m.webhooks_disabled_manual();
  }
}

/** `https://hooks.example.com/…x9Qz`: enough to recognise an endpoint, never the whole URL. */
export function endpointLabel(endpoint: Pick<WebhookEndpoint, "urlHost" | "urlHint">): string {
  return `${endpoint.urlHost}/••••${endpoint.urlHint}`;
}

/** Topics grouped by the module that offers them, in the order the server lists modules. */
export function groupTopics(
  topics: readonly WebhookTopic[],
): readonly { moduleId: string; topics: readonly WebhookTopic[] }[] {
  const groups = new Map<string, WebhookTopic[]>();
  for (const topic of topics) {
    const list = groups.get(topic.moduleId) ?? [];
    list.push(topic);
    groups.set(topic.moduleId, list);
  }
  return [...groups.entries()].map(([moduleId, list]) => ({ moduleId, topics: list }));
}

function reasonOf(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const value = error.body.error["reason"];
  return typeof value === "string" ? value : undefined;
}

/** One sentence per refusal the webhook routes give; anything else falls back to the generic copy. */
export function describeWebhookError(error: unknown): string {
  switch (reasonOf(error)) {
    case "too_many_endpoints":
      return m.webhooks_error_too_many_endpoints();
    case "endpoint_disabled":
      return m.webhooks_error_endpoint_disabled();
    // Rotate-secret: the previous secret is still inside its overlap window (the endpoint view
    // carries only `secretRotating`, not when the window ends).
    case "rotation_in_progress":
      return m.webhooks_error_rotation_in_progress();
    // Redeliver: the fan-out gates are re-applied at redelivery time.
    case "subject_erased":
      return m.webhooks_error_subject_erased();
    case "tracking_not_allowed":
      return m.webhooks_error_tracking_not_allowed();
    case "topic_unavailable":
      return m.webhooks_error_topic_unavailable();
    default:
      // The URL checks (https, a public address) answer `validation_failed`; nothing else a
      // well-formed form sends can fail validation.
      if (isApiError(error) && error.code === "validation_failed") return m.webhooks_error_url();
      return describeError(error).body;
  }
}
