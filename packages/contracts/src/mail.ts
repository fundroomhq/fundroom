import { z } from "@hono/zod-openapi";
import { page, TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Mail delivery feedback (E2.6). Handlers live in `apps/server/src/routes/mail.ts` — kernel
 * routes, because the facts are `core.mail_message` / `core.mail_suppression`, which every module
 * that sends mail depends on and none owns. The webhook itself (`POST /webhooks/email/{driver}`)
 * is an ops route outside `/api/v1` and has no contract here: its body is the provider's.
 *
 * Enum values are spelled out rather than imported, so the generated SDK builds from the contract
 * alone. `z.union([X, z.null()])`, never `.nullable()` on a named schema.
 */

export const MailCapabilitiesSchema = z
  .object({
    perMessageTracking: z.boolean().openapi({
      description:
        "The provider can switch open/click tracking per message. When false, tracking is an account setting at the provider, and events for members who did not consent are discarded on arrival.",
    }),
    webhooks: z.boolean().openapi({
      description: "The driver parses delivery webhooks (bounces, complaints, opens, clicks).",
    }),
  })
  .openapi("MailCapabilities");

export const MailStatusSchema = z
  .object({
    driver: z.string().openapi({ example: "resend" }),
    capabilities: MailCapabilitiesSchema,
    webhookUrl: z.union([z.url(), z.null()]).openapi({
      description:
        "The URL to paste into the provider's webhook settings; `null` when the driver has no webhooks (SMTP).",
      example: "https://investors.acme.com/webhooks/email/resend",
    }),
  })
  .openapi("MailStatus");

export const MailSuppressionReasonSchema = z
  .enum(["bounce", "complaint", "manual", "provider"])
  .openapi({
    description:
      "`bounce` a hard bounce, `complaint` the recipient marked a message as spam, `manual` an admin added it, `provider` the email provider refused the recipient from its own suppression list",
    example: "bounce",
  });

export const MailSuppressionSchema = z
  .object({
    id: UuidSchema,
    address: z.string().openapi({
      description:
        "Masked (`a•••@example.com`). The list is keyed by a keyed hash of the address; the address itself is never stored.",
      example: "a•••@example.com",
    }),
    reason: MailSuppressionReasonSchema,
    messageRef: z.union([UuidSchema, z.null()]).openapi({
      description: "The sent message the bounce or complaint was about",
    }),
    createdAt: TimestampSchema,
  })
  .openapi("MailSuppression");

export const MailSuppressionPageSchema = page(MailSuppressionSchema, "MailSuppressionPage");

export const MailSuppressionListQuery = z.object({
  cursor: z
    .string()
    .max(64)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MailSuppressionIdParam = z.object({ id: UuidSchema });
