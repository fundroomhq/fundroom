import { z } from "@hono/zod-openapi";
import { TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * Integrations hub (E3.6, ADR-0054). Handlers live in `apps/server/src/routes/integrations.ts`
 * (kernel routes behind the `required` `integrations` manifest), `integrations-oauth.ts` and
 * `integrations-webhook.ts` (ops tree, no session); the service is `@fundroom/integrations` and
 * the vendor adapters implement `IntegrationAdapter` (`@fundroom/ports`).
 *
 * Credentials are write-only: no response carries a token, key or secret. A booking provider's
 * webhook signing secret exists once, in the response that minted it (connect,
 * rotate-webhook-secret).
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const IntegrationProviderSchema = z
  .enum(["quickbooks", "xero", "stripe", "slack", "calendly", "calcom"])
  .openapi({ example: "quickbooks" });

export const BookingProviderSchema = z.enum(["calendly", "calcom"]).openapi({ example: "calcom" });

export const IntegrationCapabilitySchema = z.enum(["kpi", "chat", "booking"]);

export const IntegrationConnectionStatusSchema = z
  .enum(["active", "degraded", "reauth_required"])
  .openapi({
    description:
      "`degraded`: 3+ consecutive vendor failures (still used, retried). `reauth_required`: the vendor refused the token; reconnect.",
    example: "active",
  });

export const IntegrationEnvironmentSchema = z
  .enum(["production", "sandbox"])
  .openapi({ example: "production" });

export const IntegrationCredentialFieldSchema = z.object({
  key: z.string().openapi({ example: "restrictedKey" }),
  label: z.string().openapi({ example: "Restricted API key" }),
  kind: z.enum(["text", "secret"]),
  required: z.boolean(),
  help: z.string().optional(),
});

export const KpiSourceMetricSchema = z
  .object({
    key: z.string().openapi({ example: "revenue" }),
    label: z.string().openapi({ example: "Revenue" }),
    kind: z.enum(["flow", "stock"]),
    unit: z.enum(["currency", "count"]),
    historical: z.boolean().openapi({
      description:
        "`false`: the vendor only knows the current value (e.g. Stripe MRR); only the current month is written",
    }),
  })
  .openapi("KpiSourceMetric");

export const IntegrationProviderInfoSchema = z
  .object({
    provider: IntegrationProviderSchema,
    displayName: z.string().openapi({ example: "QuickBooks Online" }),
    capabilities: z.array(IntegrationCapabilitySchema),
    auth: z.enum(["oauth2", "secret"]),
    available: z.boolean().openapi({
      description:
        "`false`: an OAuth provider whose client the operator has not configured (INTEGRATIONS_<P>_CLIENT_ID/_SECRET); it cannot be connected",
    }),
    credentialFields: z.array(IntegrationCredentialFieldSchema).openapi({
      description: "Secret providers: the connect form's fields (empty for OAuth providers)",
    }),
    scopeExplanation: z.array(z.string()).openapi({
      description: "Plain-language list shown before connecting: what we read, what we never do",
    }),
    kpiMetrics: z.array(KpiSourceMetricSchema).openapi({
      description: "KPI sources only: the metrics this provider can feed (empty otherwise)",
    }),
    bookingLinkHosts: z.array(z.string()).openapi({
      description: "Booking providers only: hosts a booking link URL may use (empty otherwise)",
      example: ["cal.com", "app.cal.com"],
    }),
    subProcessor: z.object({
      name: z.string(),
      purpose: z.string(),
      region: z.string(),
      dpaUrl: z.string(),
    }),
  })
  .openapi("IntegrationProviderInfo");

export const IntegrationProviderListSchema = z
  .object({ providers: z.array(IntegrationProviderInfoSchema) })
  .openapi("IntegrationProviderList");

export const IntegrationAccountSchema = z
  .object({
    id: z.string().openapi({ example: "8a1f2c3d-…" }),
    name: z.string().openapi({ example: "Acme Ltd" }),
  })
  .openapi("IntegrationAccount");

export const IntegrationConnectionSchema = z
  .object({
    id: UuidSchema,
    provider: IntegrationProviderSchema,
    status: IntegrationConnectionStatusSchema,
    environment: IntegrationEnvironmentSchema,
    accountLabel: z.string().nullable().openapi({ example: "Acme Ltd (realm 1234)" }),
    externalAccountId: z.string().nullable(),
    availableAccounts: z.array(IntegrationAccountSchema).optional().openapi({
      description:
        "Xero only: the organisations the grant covers; choose one with `PUT /integrations/xero/account`",
    }),
    scope: z.string().nullable(),
    lastSuccessAt: z.union([TimestampSchema, z.null()]),
    lastFailureAt: z.union([TimestampSchema, z.null()]),
    lastError: z.string().nullable().openapi({
      description: "A short, vendor-neutral reason; never a credential or vendor text verbatim",
    }),
    consecutiveFailures: z.number().int().min(0),
    connectedAt: TimestampSchema,
    webhookUrl: z.string().nullable().openapi({
      description:
        "Booking providers only: where the vendor must POST booking events (Cal.com: paste into its webhook settings; Calendly: subscribed automatically)",
      example:
        "https://investors.example.com/webhooks/integrations/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    }),
  })
  .openapi("IntegrationConnection");

export const IntegrationConnectionListSchema = z
  .object({ connections: z.array(IntegrationConnectionSchema) })
  .openapi("IntegrationConnectionList");

export const IntegrationProviderParams = z.object({ provider: IntegrationProviderSchema });

export const IntegrationWebhookSecretSchema = z.string().min(16).max(200).openapi({
  description:
    "The webhook signing secret (Cal.com: paste into the vendor's webhook settings). Shown ONCE, in this response.",
});

export const IntegrationConnectBodySchema = z
  .object({
    credentials: z.record(z.string().min(1).max(64), z.string().max(4000)).openapi({
      description:
        "Values for the provider's `credentialFields`, keyed by `key` (Stripe `restrictedKey`, Calendly `personalAccessToken`; Cal.com none). Never returned.",
    }),
    environment: IntegrationEnvironmentSchema.optional().openapi({
      description: "Ignored where the credential decides it (Stripe `rk_live_`/`rk_test_`)",
    }),
  })
  .openapi("IntegrationConnectBody");

export const IntegrationConnectResultSchema = z
  .object({
    connection: IntegrationConnectionSchema,
    webhookSecret: IntegrationWebhookSecretSchema.optional(),
  })
  .openapi("IntegrationConnectResult");

export const IntegrationOAuthBeginBodySchema = z
  .object({
    environment: IntegrationEnvironmentSchema.optional(),
    returnPath: z
      .string()
      .max(300)
      .regex(/^\/admin\/[A-Za-z0-9/_-]*$/u)
      .optional()
      .openapi({
        description:
          "Where to land after the vendor's consent screen. Default `/admin/integrations`.",
        example: "/admin/integrations",
      }),
  })
  .openapi("IntegrationOAuthBeginBody");

export const IntegrationOAuthBeginResultSchema = z
  .object({
    startUrl: z.string().openapi({
      description:
        "Navigate the top-level window here (`window.location.assign`); single use, valid for 2 minutes",
      example: "https://investors.example.com/oauth/integrations/start?ticket=…",
    }),
    expiresAt: TimestampSchema,
  })
  .openapi("IntegrationOAuthBeginResult");

export const IntegrationOAuthCompleteBodySchema = z
  .object({
    pendingToken: z.string().min(16).max(200).openapi({
      description:
        "The one-time token from the callback redirect's URL fragment (`#pending=…`); valid 10 minutes, single use",
    }),
  })
  .openapi("IntegrationOAuthCompleteBody");

export const IntegrationSelectAccountBodySchema = z
  .object({ externalAccountId: z.string().min(1).max(300) })
  .openapi("IntegrationSelectAccountBody");

export const IntegrationWebhookSecretResultSchema = z
  .object({
    connection: IntegrationConnectionSchema,
    webhookSecret: IntegrationWebhookSecretSchema,
  })
  .openapi("IntegrationWebhookSecretResult");

// --- booking links ----------------------------------------------------------------------------

export const BookingLinkAudienceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("groups"), groupIds: z.array(UuidSchema).min(1).max(50) }),
  ])
  .openapi("BookingLinkAudience");

export const BookingLinkSchema = z
  .object({
    id: UuidSchema,
    provider: BookingProviderSchema,
    url: z.string().openapi({ example: "https://cal.com/acme/investor-call" }),
    label: z.string().openapi({ example: "Book a call with the CEO" }),
    description: z.string().nullable(),
    audience: BookingLinkAudienceSchema,
    position: z.number().int().min(0),
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("BookingLink");

export const BookingLinkListSchema = z
  .object({ links: z.array(BookingLinkSchema) })
  .openapi("BookingLinkList");

export const BookingLinkCreateBodySchema = z
  .object({
    provider: BookingProviderSchema,
    url: trimmedText({ min: 9, max: 500 }).openapi({
      description:
        "`https://` on one of the provider's `bookingLinkHosts` (422 `booking_link_invalid_url` otherwise)",
    }),
    label: trimmedText({ min: 1, max: 80 }),
    description: z.string().trim().max(300).nullable().optional(),
    audience: BookingLinkAudienceSchema.optional().openapi({ description: "Default everyone" }),
    position: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("BookingLinkCreateBody");

export const BookingLinkPatchBodySchema = z
  .object({
    url: trimmedText({ min: 9, max: 500 }).optional(),
    label: trimmedText({ min: 1, max: 80 }).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    audience: BookingLinkAudienceSchema.optional(),
    position: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("BookingLinkPatchBody");

export const BookingLinkIdParams = z.object({ id: UuidSchema });

/** What a member sees on the portal: no audience, no bookkeeping. */
export const BookingLinkPublicSchema = z
  .object({
    id: UuidSchema,
    provider: BookingProviderSchema,
    url: z.string(),
    label: z.string(),
    description: z.string().nullable(),
  })
  .openapi("BookingLinkPublic");

export const BookingLinkPublicListSchema = z
  .object({ links: z.array(BookingLinkPublicSchema) })
  .openapi("BookingLinkPublicList");

// --- recorded bookings ------------------------------------------------------------------------

export const IntegrationBookingSchema = z
  .object({
    id: UuidSchema,
    provider: BookingProviderSchema,
    status: z.enum(["booked", "cancelled", "rescheduled"]),
    startsAt: TimestampSchema,
    endsAt: z.union([TimestampSchema, z.null()]),
    inviteeEmail: z.string(),
    inviteeName: z.string().nullable(),
    eventName: z.string().nullable(),
    membershipId: z.union([UuidSchema, z.null()]).openapi({
      description: "The member whose address matched the invitee's at ingest; `null` otherwise",
    }),
    receivedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("IntegrationBooking");

export const IntegrationBookingPageSchema = z
  .object({
    items: z.array(IntegrationBookingSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("IntegrationBookingPage");

export const IntegrationBookingListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// --- ops routes (no session) -----------------------------------------------------------------

export const IntegrationOAuthStartQuery = z.object({ ticket: z.string().min(16).max(200) });

export const IntegrationWebhookParams = z.object({ connectionId: UuidSchema });
