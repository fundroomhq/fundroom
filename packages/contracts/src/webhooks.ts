import { z } from "@hono/zod-openapi";
import { TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * Outbound webhooks (E3.4, ADR-0052). Handlers live in `apps/server/src/routes/webhooks.ts` —
 * kernel routes behind the `required` `webhooks` manifest; the signer, fan-out and delivery are
 * `@fundroom/webhooks`. Wire format: Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature: v1,<base64 HMAC-SHA256>`).
 *
 * The endpoint URL is write-only: no response carries it, only `urlHost` (scheme + host) and
 * `urlHint` (its last ≤4 characters). The signing secret exists once, in the response that
 * minted it (create, rotate-secret).
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const WebhookTopicSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u, "<resource>.<event>")
  .openapi({ example: "update.published" });

export const WebhookDeliveryStatusSchema = z
  .enum(["pending", "sending", "succeeded", "failed", "cancelled"])
  .openapi({
    description:
      "`pending` waits for its (next) attempt; `sending` is in flight; `succeeded` got a 2xx; `failed` exhausted its retries (the dead-letter list — redeliverable); `cancelled` was dropped when its endpoint was disabled",
    example: "succeeded",
  });

export const WebhookDisabledReasonSchema = z.enum(["gone", "failing", "manual"]).openapi({
  description:
    "`gone`: the receiver answered 410; `failing`: 20 deliveries in a row exhausted their retries; `manual`: an admin switched it off",
  example: "failing",
});

export const WebhookSecretSchema = z
  .string()
  .regex(/^whsec_[A-Za-z0-9+/=]{40,}$/u)
  .openapi({
    description:
      "The signing secret (`whsec_` + base64). Shown ONCE, in this response. Verify deliveries with it (the SDK's `verifyWebhook`, or any Standard Webhooks library).",
    example: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  });

export const WebhookEndpointIdParams = z.object({ id: UuidSchema });
export const WebhookDeliveryIdParams = z.object({ id: UuidSchema });

export const WebhookTopicOptionSchema = z.object({
  topic: WebhookTopicSchema,
  moduleId: z.string(),
  description: z.string(),
  personLevel: z.boolean().openapi({
    description:
      "Person-level engagement (a named member viewed or downloaded something): delivered only for members whose tracking consent allows it",
  }),
});

export const WebhookTopicsSchema = z
  .object({ topics: z.array(WebhookTopicOptionSchema) })
  .openapi("WebhookTopics");

export const DeliveryStatusCountsSchema = z
  .object({
    pending: z.number().int(),
    sending: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
  })
  .openapi("WebhookDeliveryCounts");

export const WebhookEndpointSchema = z
  .object({
    id: UuidSchema,
    description: z.string().nullable(),
    urlHost: z.string().openapi({ example: "https://hooks.zapier.com" }),
    urlHint: z.string().openapi({ description: "The URL's last ≤4 characters", example: "x9Qz" }),
    events: z.array(WebhookTopicSchema),
    enabled: z.boolean(),
    disabledReason: z.union([WebhookDisabledReasonSchema, z.null()]),
    consecutiveFailures: z.number().int(),
    lastSuccessAt: z.union([TimestampSchema, z.null()]),
    lastFailureAt: z.union([TimestampSchema, z.null()]),
    secretRotating: z.boolean().openapi({
      description: "The previous secret is still valid (deliveries carry both signatures)",
    }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    stats: z
      .object({ last24h: DeliveryStatusCountsSchema })
      .optional()
      .openapi({ description: "Detail only: deliveries created in the last 24 hours, by status" }),
  })
  .openapi("WebhookEndpoint");

export const WebhookEndpointListSchema = z
  .object({
    items: z.array(WebhookEndpointSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("WebhookEndpointList");

const UrlSchema = trimmedText({ min: 1, max: 2048 }).openapi({
  description:
    "Where deliveries are POSTed. `https://` only (plain `http://` only for hosts the operator allows); private and link-local addresses are refused. Never returned.",
  example: "https://hooks.zapier.com/hooks/catch/123/abc/",
});
const DescriptionSchema = z.string().trim().max(200);

export const CreateWebhookEndpointBody = z.object({
  url: UrlSchema,
  description: z.union([DescriptionSchema, z.null()]).optional(),
  events: z.array(WebhookTopicSchema).min(1).max(100).openapi({
    description: "Topics from `GET /webhooks/topics`",
  }),
});

export const CreatedWebhookEndpointSchema = z
  .object({ endpoint: WebhookEndpointSchema, secret: WebhookSecretSchema })
  .openapi("CreatedWebhookEndpoint");

export const UpdateWebhookEndpointBody = z
  .object({
    url: UrlSchema.optional().openapi({
      description: "Re-pointing an endpoint needs a fresh session (step-up)",
    }),
    description: z.union([DescriptionSchema, z.null()]).optional(),
    events: z.array(WebhookTopicSchema).min(1).max(100).optional(),
    enabled: z.boolean().optional().openapi({
      description: "Re-enabling clears `disabledReason` and the failure count",
    }),
  })
  .refine(
    (b) =>
      b.url !== undefined ||
      b.description !== undefined ||
      b.events !== undefined ||
      b.enabled !== undefined,
    { message: "nothing to change" },
  );

export const RotateWebhookSecretBody = z.object({
  graceHours: z.number().int().min(0).max(168).default(24).openapi({
    description:
      "How long deliveries also carry a signature under the previous secret (0 = stop at once)",
  }),
});

export const RotatedWebhookSecretSchema = z
  .object({ endpoint: WebhookEndpointSchema, secret: WebhookSecretSchema })
  .openapi("RotatedWebhookSecret");

export const WebhookDeliverySchema = z
  .object({
    id: UuidSchema.openapi({ description: "The `webhook-id` header; stable across retries" }),
    endpointId: UuidSchema,
    topic: z.string(),
    eventId: z.string(),
    status: WebhookDeliveryStatusSchema,
    attempts: z.number().int(),
    nextAttemptAt: z.union([TimestampSchema, z.null()]),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    lastDurationMs: z.number().int().nullable(),
    createdAt: TimestampSchema,
    deliveredAt: z.union([TimestampSchema, z.null()]),
    manual: z.boolean().openapi({ description: "A test send or a manual redelivery" }),
  })
  .openapi("WebhookDelivery");

export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  payload: z.record(z.string(), z.unknown()).openapi({
    description: "The body sent: `{ id, type, timestamp, workspaceId, data, schemaVersion }`",
  }),
  lastResponseExcerpt: z.string().nullable().openapi({
    description: "The first ≤512 printable characters of the last response body",
  }),
}).openapi("WebhookDeliveryDetail");

export const WebhookDeliveryListQuery = z.object({
  endpointId: UuidSchema.optional(),
  status: WebhookDeliveryStatusSchema.optional(),
  topic: z.string().max(100).optional(),
  cursor: z
    .string()
    .max(512)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const WebhookDeliveryListSchema = z
  .object({
    items: z.array(WebhookDeliverySchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("WebhookDeliveryList");

export const WebhookDeliveryResultSchema = z
  .object({ delivery: WebhookDeliverySchema })
  .openapi("WebhookDeliveryResult");
