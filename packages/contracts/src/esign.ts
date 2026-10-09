import { z } from "@hono/zod-openapi";
import { TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * E-signature (E3.5, ADR-0053). Handlers live in `apps/server/src/routes/esign.ts` — kernel routes
 * behind the `required` `esign` manifest; the service is `@fundroom/esign` and the vendor
 * adapters implement `ESignPort` (`@fundroom/ports`).
 *
 * Credentials are write-only: no response carries a credential value, only `credentialHints`
 * (e.g. `••••ab12`). The callback secret of an "ours" vendor exists once, in the response that
 * minted it (PUT connection, rotate-callback-secret).
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const ESignDriverSchema = z
  .enum(["documenso", "docuseal", "docusign", "dropbox-sign"])
  .openapi({ example: "documenso" });

export const ESignEnvelopeStatusSchema = z
  .enum(["draft", "sent", "delivered", "completed", "declined", "voided", "expired", "error"])
  .openapi({
    description:
      "`draft` is ours (created here, vendor not yet answered); `error` is ours (the vendor call failed or the artifact was refused); the rest are the vendor's, as pulled from its API. `completed`, `declined`, `voided` and `expired` are terminal.",
    example: "sent",
  });

export const ESignSignerStatusSchema = z
  .enum(["pending", "viewed", "signed", "declined"])
  .openapi({ example: "viewed" });

export const ESignPurposeSchema = z.enum(["nda", "round_closing"]).openapi({ example: "nda" });

export const ESignCallbackSecretSchema = z.string().min(16).max(200).openapi({
  description:
    "The callback secret to paste into the vendor's webhook settings. Shown ONCE, in this response.",
});

export const ESignCredentialFieldSchema = z.object({
  key: z.string().openapi({ example: "apiToken" }),
  label: z.string().openapi({ example: "API token" }),
  kind: z.enum(["text", "secret", "pem", "select"]),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  help: z.string().optional(),
});

export const ESignVendorSupportsSchema = z.object({
  templates: z.boolean(),
  pdf: z.boolean(),
  embeddedSigning: z.boolean(),
  void: z.boolean(),
});

export const ESignVendorMetaSchema = z.object({
  driver: ESignDriverSchema,
  displayName: z.string().openapi({ example: "Documenso" }),
  selfHostable: z.boolean(),
  baseUrl: z.object({ required: z.boolean(), default: z.string().optional() }),
  supports: ESignVendorSupportsSchema,
  callbackSecret: z.enum(["ours", "vendor"]).openapi({
    description:
      "`ours`: we generate the callback secret and the admin pastes it into the vendor; `vendor`: the vendor generates it and the admin pastes it into our form (a credential field)",
  }),
  subProcessor: z.object({
    name: z.string(),
    purpose: z.string(),
    region: z.string(),
    dpaUrl: z.string(),
    certifications: z.array(z.string()),
  }),
});

export const ESignDriverInfoSchema = z
  .object({ meta: ESignVendorMetaSchema, credentialFields: z.array(ESignCredentialFieldSchema) })
  .openapi("ESignDriverInfo");

export const ESignDriverListSchema = z
  .object({ drivers: z.array(ESignDriverInfoSchema) })
  .openapi("ESignDriverList");

export const ESignConnectionSchema = z
  .object({
    id: UuidSchema,
    driver: ESignDriverSchema,
    displayName: z.string(),
    status: z.enum(["active", "error"]),
    supports: ESignVendorSupportsSchema,
    callbackSecretKind: z.enum(["ours", "vendor"]).openapi({
      description:
        "`ours`: we minted the callback secret (shown once; rotate with `POST /esign/connection/rotate-callback-secret`). `vendor`: the vendor's own key, entered as a credential.",
    }),
    baseUrlHost: z.string().nullable().openapi({ example: "sign.example.com" }),
    callbackUrl: z.string().openapi({
      description: "Where the vendor must POST its callbacks (paste into the vendor's settings)",
      example: "https://investors.example.com/webhooks/esign/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    }),
    credentialHints: z.record(z.string(), z.string()).openapi({
      description: "Per credential field, a masked hint (`••••ab12`); never a value",
    }),
    lastVerifiedAt: z.union([TimestampSchema, z.null()]),
    lastError: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("ESignConnection");

export const ESignConnectionResponseSchema = z
  .object({ connection: z.union([ESignConnectionSchema, z.null()]) })
  .openapi("ESignConnectionResponse");

export const ESignConnectionPutSchema = z
  .object({
    driver: ESignDriverSchema,
    baseUrl: trimmedText({ min: 1, max: 2048 }).optional().openapi({
      description:
        "Self-hosted vendors only: the instance's origin. `https://` only, unless the operator allow-lists the host (ESIGN_ALLOW_PRIVATE_HOSTS). Never returned.",
      example: "https://sign.example.com",
    }),
    credentials: z.record(z.string().min(1).max(64), z.string().max(20_000)).openapi({
      description:
        'Values for the driver\'s `credentialFields`, keyed by `key`. Never returned. On a same-driver save a blank or absent secret field keeps the stored value — unless the base URL changes, when every stored secret must be typed again (422 `esign_credentials_required`, details `{reason: "base_url_changed", fields}`), so a secret is never sent to a host it was not entered for.',
    }),
    clearCredentials: z.array(z.string().min(1).max(64)).max(32).optional().openapi({
      description:
        'Same-driver save only: keys of OPTIONAL secret fields to forget (e.g. a secondary rotation key). A required field → 400 `validation_failed` `{reason: "cannot_clear_required"}`; an unknown key → `{reason: "unknown_field"}`; a key both cleared and given a value → `{reason: "clear_conflict"}`.',
    }),
  })
  .openapi("ESignConnectionPut");

export const ESignConnectionSavedSchema = z
  .object({
    connection: ESignConnectionSchema,
    callbackSecret: ESignCallbackSecretSchema.optional(),
  })
  .openapi("ESignConnectionSaved");

export const ESignCallbackSecretResultSchema = z
  .object({ connection: ESignConnectionSchema, callbackSecret: ESignCallbackSecretSchema })
  .openapi("ESignCallbackSecretResult");

export const ESignSubjectSchema = z.object({
  module: z.string().openapi({ example: "round" }),
  kind: z.string().openapi({ example: "commitment" }),
  id: UuidSchema,
});

export const ESignEnvelopeSchema = z
  .object({
    id: UuidSchema,
    purpose: ESignPurposeSchema,
    subject: ESignSubjectSchema,
    status: ESignEnvelopeStatusSchema,
    signerStatus: z.union([ESignSignerStatusSchema, z.null()]),
    signerName: z.string(),
    signerEmail: z.string(),
    membershipId: z.union([UuidSchema, z.null()]),
    title: z.string(),
    driver: ESignDriverSchema,
    sentAt: z.union([TimestampSchema, z.null()]),
    completedAt: z.union([TimestampSchema, z.null()]),
    hasSigned: z.boolean().openapi({ description: "The signed PDF was collected and stored" }),
    hasCertificate: z.boolean(),
    vaultedDocumentId: z.union([UuidSchema, z.null()]),
    errorCode: z.string().nullable(),
    createdAt: TimestampSchema,
  })
  .openapi("ESignEnvelope");

export const ESignEnvelopePageSchema = z
  .object({
    items: z.array(ESignEnvelopeSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("ESignEnvelopePage");

export const ESignEnvelopeIdParams = z.object({ id: UuidSchema });

export const ESignEnvelopeListQuery = z.object({
  status: ESignEnvelopeStatusSchema.optional(),
  purpose: ESignPurposeSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const ESignVoidBody = z.object({
  reason: trimmedText({ min: 1, max: 500 }).openapi({ example: "Sent to the wrong address" }),
});

export const ESignNdaStartBodySchema = z
  .object({
    documentId: UuidSchema,
    consentToElectronicRecords: z.boolean().openapi({
      description:
        "The member consents to receive and sign records electronically (ESIGN Act §101(c)). Must be ticked by the member; never pre-ticked. Anything but `true` answers 422 `esign_consent_required`.",
    }),
    disclosureVersion: z.number().int().openapi({
      description:
        "The version of the consumer disclosure the member was shown (currently `1`). A stale version answers 422 `esign_consent_required`.",
      example: 1,
    }),
  })
  .openapi("ESignNdaStartBody");

export const ESignNdaStartResultSchema = z
  .object({
    envelope: ESignEnvelopeSchema,
    signingUrl: z.string().nullable().openapi({
      description:
        "Open top-level (never in a frame). `null`: the vendor emails the signing link instead.",
    }),
  })
  .openapi("ESignNdaStartResult");

export const ESignNdaStatusQuery = z.object({ documentId: UuidSchema });

export const ESignNdaStatusSchema = z
  .object({
    /**
     * `failed`: the current version's envelope was signed at the vendor but its signed copy could
     * not be collected (too large, not a PDF, infected…); the gate stays closed and a fresh
     * `POST /esign/nda/start` is allowed (it supersedes the failed envelope).
     */
    status: z.enum(["none", "open", "completed", "superseded", "failed"]),
    envelopeId: z.union([UuidSchema, z.null()]),
  })
  .openapi("ESignNdaStatus");

export const ESignCallbackParams = z.object({ connectionId: UuidSchema });
