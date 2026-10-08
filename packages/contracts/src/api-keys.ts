import { z } from "@hono/zod-openapi";
import { paginationQuery, TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Workspace API keys (E3.4, ADR-0052). Handlers live in `apps/server/src/routes/api-keys.ts` —
 * kernel routes behind the `required` `api-keys` manifest; the token rules and the repository are
 * `@fundroom/api-keys`.
 *
 * A key acts as the member who created it, capped by its scopes (∩ that member's CURRENT role
 * permissions), and can call only routes whose matrix row is `apiKey: true`. None of the routes
 * here is: a key never sees or mints keys. The plaintext token exists exactly once, in the
 * response that minted it (create, rotate); the column holds `sha256(token)`.
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const ApiKeyStatusSchema = z.enum(["live", "expired", "revoked"]).openapi({
  description:
    "`live` authenticates; `expired` passed its `expiresAt` (including a rotated key's grace window); `revoked` was revoked (see `revokedReason`)",
  example: "live",
});

export const ApiKeyRevokedReasonSchema = z
  .enum(["revoked", "rotated", "creator_inactive", "erased"])
  .openapi({
    description:
      "`revoked` by an admin; `rotated` with a zero grace window; `creator_inactive` by the hourly sweep once the member who created it lost their role or left; `erased` with that member's identity",
    example: "revoked",
  });

/** A permission name from the authz catalogue (`metrics.read`). */
export const ApiKeyScopeSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/u, "<module>.<verb>")
  .openapi({ example: "metrics.read" });

/**
 * `frk_` + 43 base64url characters. Shown once. Only new tokens are ever returned, so the response
 * shape is `frk_`; keys minted before the A-2 rename (`shk_…`) still authenticate.
 */
export const ApiKeyTokenSchema = z
  .string()
  .regex(/^frk_[A-Za-z0-9_-]{43}$/u)
  .openapi({
    description:
      "The key itself. Shown ONCE, in this response; the server keeps only a sha256. Send it as `Authorization: Bearer <token>`.",
    example: "frk_8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA",
  });

export const ApiKeyIdParams = z.object({ id: UuidSchema });

export const ApiKeyCreatorSchema = z.object({
  membershipId: UuidSchema,
  displayName: z.string().nullable(),
});

export const ApiKeySchema = z
  .object({
    id: UuidSchema,
    name: z.string().openapi({ example: "Zapier" }),
    prefix: z.string().openapi({
      description:
        "The token's first 12 characters, for recognising a key; not a secret. `frk_…`, or `shk_…` for a key created before the FundRoom rename",
      example: "frk_8Zr2Qk9v",
    }),
    scopes: z.array(ApiKeyScopeSchema),
    status: ApiKeyStatusSchema,
    createdAt: TimestampSchema,
    createdBy: ApiKeyCreatorSchema.openapi({
      description: "The member the key acts as (its permissions cap the key's scopes)",
    }),
    expiresAt: z.union([TimestampSchema, z.null()]),
    revokedAt: z.union([TimestampSchema, z.null()]),
    revokedReason: z.union([ApiKeyRevokedReasonSchema, z.null()]),
    replacedById: z.union([UuidSchema, z.null()]).openapi({
      description: "The key that replaced this one when it was rotated",
    }),
    lastUsedAt: z.union([TimestampSchema, z.null()]).openapi({
      description: "Updated at most once a minute",
    }),
    note: z.string().nullable(),
  })
  .openapi("ApiKey");

export const ApiKeyListQuery = paginationQuery(100);

export const ApiKeyListSchema = z
  .object({
    items: z.array(ApiKeySchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("ApiKeyList");

export const ApiKeyScopeOptionSchema = z.object({
  id: ApiKeyScopeSchema,
  description: z.string(),
  held: z.boolean().openapi({
    description:
      "Whether the caller holds this permission; a key can only be given scopes its creator holds",
  }),
});

export const ApiKeyScopesSchema = z
  .object({ scopes: z.array(ApiKeyScopeOptionSchema) })
  .openapi("ApiKeyScopes");

const NameSchema = z.string().trim().min(1).max(80);
const NoteSchema = z.string().trim().max(500);

export const CreateApiKeyBody = z.object({
  name: NameSchema,
  scopes: z.array(ApiKeyScopeSchema).min(1).max(100).openapi({
    description:
      "Permissions the key may use; each must be offered by `GET /api-keys/scopes` and held by the caller (else 400 `validation_failed`, reason `scope_not_held`). Immutable: create a new key to change them.",
  }),
  expiresAt: z.union([TimestampSchema, z.null()]).optional().openapi({
    description: "In the future and at most two years ahead; omitted or null = never expires",
  }),
  note: z.union([NoteSchema, z.null()]).optional(),
});

export const CreatedApiKeySchema = z
  .object({ key: ApiKeySchema, token: ApiKeyTokenSchema })
  .openapi("CreatedApiKey");

export const UpdateApiKeyBody = z
  .object({
    name: NameSchema.optional(),
    note: z.union([NoteSchema, z.null()]).optional(),
  })
  .refine((b) => b.name !== undefined || b.note !== undefined, {
    message: "nothing to change",
  });

export const RotateApiKeyBody = z.object({
  graceHours: z.number().int().min(0).max(168).default(24).openapi({
    description:
      "How long the old key keeps working (0 revokes it at once, reason `rotated`); the old key's expiry becomes the earlier of its own and now + grace",
  }),
});

export const RotatedApiKeySchema = z
  .object({ key: ApiKeySchema, token: ApiKeyTokenSchema, previous: ApiKeySchema })
  .openapi("RotatedApiKey");

export const ApiKeyResultSchema = z.object({ key: ApiKeySchema }).openapi("ApiKeyResult");
