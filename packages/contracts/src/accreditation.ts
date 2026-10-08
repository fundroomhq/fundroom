import { z } from "@hono/zod-openapi";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Accreditation vendor connections (E3.7, ADR-0055). Handlers live in
 * `apps/server/src/routes/accreditation.ts` — kernel routes behind the `required` `accreditation`
 * manifest; the service is `@fundroom/accreditation` and the vendor adapters implement
 * `AccreditationVendorPort` (`@fundroom/ports`). The verification *record* stays in the round
 * module (`modules/round/src/contracts.ts`).
 *
 * Credentials are write-only: no response carries a credential value, only `credentialHints`
 * (e.g. `••••ab12`).
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const AccreditationVendorDriverSchema = z
  .enum(["verifyinvestor", "parallel-markets"])
  .openapi({ example: "verifyinvestor" });

export const AccreditationDriverSchema = z
  .enum(["manual", "verifyinvestor", "parallel-markets"])
  .openapi({ example: "manual" });

export const AccreditationCredentialFieldSchema = z.object({
  key: z.string().openapi({ example: "apiToken" }),
  label: z.string().openapi({ example: "API token" }),
  kind: z.enum(["text", "secret", "select"]),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  help: z.string().optional(),
});

export const AccreditationSubProcessorSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  location: z.string(),
  url: z.string(),
});

export const AccreditationProviderInfoSchema = z
  .object({
    driver: AccreditationVendorDriverSchema,
    label: z.string().openapi({ example: "VerifyInvestor.com" }),
    handoff: z.enum(["invite_email", "widget"]).openapi({
      description:
        "`invite_email`: the vendor emails the investor an invitation. `widget`: the investor continues on a page of ours that embeds the vendor's JS SDK (register `handoffUrl` as the vendor's redirect URI).",
    }),
    supportsEntities: z.boolean(),
    certificate: z.boolean().openapi({
      description: "Whether a PDF certificate/letter is downloaded and kept as evidence",
    }),
    callbackSignature: z.string().openapi({ example: "X-Signature-SHA256 HMAC" }),
    subProcessor: AccreditationSubProcessorSchema,
    credentialFields: z.array(AccreditationCredentialFieldSchema),
    offered: z.boolean().openapi({
      description:
        "Whether the operator offers this vendor (`ACCREDITATION_DRIVERS`). A workspace keeps a connection to a vendor no longer offered, but cannot create or replace one with it.",
    }),
  })
  .openapi("AccreditationProviderInfo");

export const AccreditationProviderListSchema = z
  .object({ providers: z.array(AccreditationProviderInfoSchema) })
  .openapi("AccreditationProviderList");

export const AccreditationConnectionSchema = z
  .object({
    id: UuidSchema,
    driver: AccreditationVendorDriverSchema,
    label: z.string().openapi({ example: "Parallel Markets" }),
    environment: z.string().openapi({ example: "production" }),
    credentialHints: z.record(z.string(), z.string()).openapi({
      description: "Per credential field, a masked hint (`••••ab12`); never a value",
    }),
    status: z.enum(["active", "error"]),
    lastVerifiedAt: z.union([TimestampSchema, z.null()]),
    lastError: z.string().nullable(),
    lastCallbackAt: z.union([TimestampSchema, z.null()]),
    callbackUrl: z.string().openapi({
      description: "Where the vendor must POST its callbacks (paste into the vendor's settings)",
      example:
        "https://investors.example.com/webhooks/accreditation/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    }),
    handoffUrl: z.string().openapi({
      description:
        "The investor page that continues a widget verification — Parallel Markets' client redirect URI must be exactly this",
      example: "https://acme.investors.example.com/api/v1/round/current/verification/handoff",
    }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("AccreditationConnection");

export const AccreditationConnectionResponseSchema = z
  .object({ connection: z.union([AccreditationConnectionSchema, z.null()]) })
  .openapi("AccreditationConnectionResponse");

export const AccreditationConnectionPutSchema = z
  .object({
    driver: AccreditationVendorDriverSchema,
    credentials: z.record(z.string().min(1).max(64), z.string().max(20_000)).openapi({
      description:
        "Values for the driver's `credentialFields`, keyed by `key`. Never returned. On a same-driver save a blank or absent secret field keeps the stored value.",
    }),
    clearCredentials: z.array(z.string().min(1).max(64)).max(32).optional().openapi({
      description: "Same-driver save only: keys of OPTIONAL secret fields to forget.",
    }),
  })
  .openapi("AccreditationConnectionPut");

/** PUT /accreditation/connection and POST …/verify: the connection as it now stands. */
export const AccreditationConnectionSavedSchema = z
  .object({ connection: AccreditationConnectionSchema })
  .openapi("AccreditationConnectionSaved");
