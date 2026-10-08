import { z } from "@hono/zod-openapi";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Audit log contracts (E2.7 package A): `GET /audit/events`, `GET /audit/verify`,
 * `GET /audit/export-key`, `POST /audit/exports`; E3.13 `GET /audit/anchors`,
 * `GET /audit/anchors/{checkpointId}/proof`. Handlers: `apps/server/src/routes/audit.ts`;
 * the bundle format and its offline verifier: `@fundroom/audit` (`bundle.ts`, README).
 *
 * Enum values are spelled out rather than imported from `@fundroom/db`: this package keeps no
 * `@fundroom/*` dependencies so the SDK builds from the contract alone.
 */

export const AuditOutcomeSchema = z.enum(["success", "denied", "failure"]).openapi("AuditOutcome");

export const AuditActorKindSchema = z
  .enum(["staff", "external", "system", "host"])
  .openapi("AuditActorKind");

const ACTION_FILTER_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.?$/u;

export const AuditEventsQuery = z.object({
  action: z.string().max(128).regex(ACTION_FILTER_RE).optional().openapi({
    description:
      "An exact action (`access.invited`), or a prefix when it ends in `.` (`access.` = every access event)",
    example: "access.",
  }),
  actorMembershipId: UuidSchema.optional(),
  subjectMembershipId: UuidSchema.optional(),
  resourceKind: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/u)
    .optional(),
  resourceId: UuidSchema.optional(),
  outcome: AuditOutcomeSchema.optional(),
  from: TimestampSchema.optional().openapi({
    description: "Inclusive lower bound on `occurredAt`",
  }),
  to: TimestampSchema.optional().openapi({ description: "Inclusive upper bound on `occurredAt`" }),
  cursor: z
    .string()
    .max(64)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const AuditEventSchema = z
  .object({
    id: UuidSchema,
    seq: z.number().int().min(1).openapi({ description: "Position in the workspace's hash chain" }),
    occurredAt: TimestampSchema,
    actorKind: AuditActorKindSchema,
    actorMembershipId: z.union([UuidSchema, z.null()]),
    actorName: z.string().nullable().openapi({ description: "`null` when unknown or erased" }),
    onBehalfOfMembershipId: z.union([UuidSchema, z.null()]).openapi({
      description: "Set when staff acted while viewing as this member",
    }),
    action: z.string().openapi({ example: "access.invited" }),
    resourceKind: z.string().openapi({ example: "membership" }),
    resourceId: z.union([UuidSchema, z.null()]),
    subjectMembershipId: z.union([UuidSchema, z.null()]),
    subjectName: z.string().nullable().openapi({ description: "`null` when unknown or erased" }),
    outcome: AuditOutcomeSchema,
    ip: z.string().nullable().openapi({
      description: "Truncated to the /24 (IPv4) or /48 (IPv6) network unless configured otherwise",
      example: "203.0.113.0/24",
    }),
    userAgent: z.string().nullable(),
    requestId: z.union([UuidSchema, z.null()]),
    meta: z.record(z.string(), z.unknown()),
    diff: z.unknown().openapi({ description: "`{ before, after }` with redacted fields, or null" }),
  })
  .openapi("AuditEvent");

export const AuditEventPageSchema = z
  .object({
    items: z.array(AuditEventSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("AuditEventPage");

/** E3.13: how the workspace's checkpoints fared against their external anchors. */
export const AuditAnchorSummarySchema = z
  .object({
    checked: z.number().int().min(0).openapi({ description: "Checkpoints with an anchor row" }),
    verified: z.number().int().min(0).openapi({
      description:
        "Anchored with a trusted (RFC 3161, pinned) time within 8 days of the checkpoint",
    }),
    unverifiedOrigin: z.number().int().min(0).openapi({
      description: "Proof consistent but its signer is not pinned / trusted",
    }),
    failed: z.number().int().min(0),
    late: z.number().int().min(0).optional().openapi({
      description:
        "Trusted anchor time more than 8 days after the checkpoint (`anchor_late`; a warning — it proves existence from then on only)",
    }),
    presenceOnly: z.number().int().min(0).optional().openapi({
      description:
        "In a transparency log but without a trusted time (Rekor only): proves presence, not when",
    }),
    missing: z.number().int().min(0).openapi({
      description:
        "Checkpoints older than 8 days with no receipt while anchoring is configured (`anchor_missing`)",
    }),
  })
  .openapi("AuditAnchorSummary");

export const AuditVerificationSchema = z
  .object({
    ok: z.boolean(),
    headSeq: z.number().int().min(0),
    checkedRows: z.number().int().min(0),
    checkpoints: z.number().int().min(0),
    problems: z.array(z.string()),
    /** E3.13 (additive): absent on servers before E3.13. */
    anchors: AuditAnchorSummarySchema.optional(),
  })
  .openapi("AuditVerification");

// --- external anchoring (E3.13, ADR-0061) -------------------------------------------------------

/** What one anchor driver returned for a batch root (`AnchorReceipt` in `@fundroom/ports`). */
export const AuditAnchorReceiptSchema = z
  .object({
    kind: z.string().openapi({ example: "rfc3161" }),
    reference: z.string().openapi({
      description: "Human locator: TSA URL + serial, or Rekor log URL + log index",
    }),
    anchoredAt: TimestampSchema,
    proof: z.record(z.string(), z.unknown()).openapi({
      description: "Everything needed to verify offline (base64 DER token, Rekor entry + proof)",
    }),
  })
  .openapi("AuditAnchorReceipt");

export const AuditAnchorsQuery = z.object({
  cursor: z
    .string()
    .max(64)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const AuditAnchorItemSchema = z
  .object({
    checkpointId: UuidSchema,
    seq: z.number().int().min(0).openapi({ description: "Chain position the checkpoint covers" }),
    createdAt: TimestampSchema,
    anchored: z.boolean().openapi({ description: "At least one anchor receipt exists" }),
    state: z.enum(["anchored", "pending", "failed"]).openapi({
      description:
        "`anchored`: ≥ 1 receipt. `pending`: not batched yet, or still inside the 7-day retry window. `failed`: batched, but every driver failed for 7 days (no more retries).",
    }),
    batchId: z.union([UuidSchema, z.null()]),
    receipts: z.array(
      z.object({
        kind: z.string(),
        reference: z.string(),
        anchoredAt: TimestampSchema,
      }),
    ),
  })
  .openapi("AuditAnchorItem");

export const AuditAnchorPageSchema = z
  .object({
    /** Anchor driver kinds this install is configured with (empty = anchoring is off). */
    configured: z.array(z.string()),
    /**
     * A-3 (ADR-0063, decision 20): whether the workspace's plan includes `anchoring`. Every
     * workspace is anchored and verified whatever its plan; without the feature, downloading a
     * checkpoint's proof (`GET /audit/anchors/{checkpointId}/proof`) answers 402 `plan_limit`.
     */
    planAllows: z.boolean().openapi({
      description:
        "Whether the workspace's plan includes anchor proofs. Checkpoints are anchored and verified on every plan; without it, downloading a proof answers 402 `plan_limit`.",
    }),
    items: z.array(AuditAnchorItemSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("AuditAnchorPage");

export const AuditAnchorProofParams = z.object({ checkpointId: UuidSchema });

/**
 * A self-contained proof that a checkpoint existed by the anchors' time: verify it offline with
 * `fundroom audit verify-anchor <proof.json> [--anchor-cert …]`.
 */
export const AuditAnchorProofSchema = z
  .object({
    checkpoint: z
      .object({
        workspace_id: UuidSchema,
        seq: z.number().int().min(0),
        hash: z.string().openapi({ description: "Hex of the chain hash at `seq`" }),
        event_id: UuidSchema,
        head_occurred_at: TimestampSchema,
        previous_checkpoint_id: z.union([UuidSchema, z.null()]),
      })
      .openapi({ description: "The canonical checkpoint facts the leaf hashes" }),
    leafHash: z.string().openapi({ description: "Hex SHA-256(0x00 || canonical checkpoint)" }),
    leafIndex: z.number().int().min(0),
    path: z
      .array(z.string())
      .openapi({ description: "Hex sibling hashes, leaf to root (RFC 6962)" }),
    treeSize: z.number().int().min(1),
    root: z.string().openapi({ description: "Hex Merkle root that was anchored" }),
    receipts: z.array(AuditAnchorReceiptSchema),
  })
  .openapi("AuditAnchorProof");

export const AuditExportKeySchema = z
  .object({
    keyId: z.string().openapi({ example: "v2" }),
    publicKey: z.string().openapi({
      description: "Base64 of the raw 32-byte Ed25519 public key",
      example: "0vN6m1a6Xx2A0h8d7hZf6k0cQ2c9C6r3oS4r0VbqM9w=",
    }),
    current: z.boolean().openapi({ description: "The key new exports are signed with" }),
  })
  .openapi("AuditExportKey");

export const AuditExportKeysSchema = z
  .object({
    alg: z.literal("Ed25519"),
    keys: z.array(AuditExportKeySchema),
  })
  .openapi("AuditExportKeys");

export const AuditExportBody = z
  .object({
    from: TimestampSchema.optional().openapi({
      description: "Start of the window; omitted = the start of the chain",
    }),
    to: TimestampSchema.optional().openapi({ description: "End of the window; omitted = now" }),
  })
  .refine(
    (b) => b.from === undefined || b.to === undefined || Date.parse(b.from) <= Date.parse(b.to),
    {
      message: "`from` must not be after `to`",
      path: ["from"],
    },
  )
  .openapi("AuditExportRequest");
