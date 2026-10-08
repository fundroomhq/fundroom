import { z } from "@hono/zod-openapi";
import { MembershipKindSchema, MembershipRoleSchema, MembershipStatusSchema } from "./access.js";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Access administration contracts (E2.7 package B1): the access review report and records,
 * member sessions, ownership transfer, revoke-all-sessions and workspace deletion. Handlers live
 * in `apps/server/src/routes/access-admin.ts`; the report is built by `@fundroom/identity`'s
 * `createAccessReviewService`.
 */

export const ACCESS_REVIEW_FLAGS = [
  "stale",
  "never_active",
  "expiring",
  "accreditation_lapsed",
  "accreditation_diverges",
  "pending_gates",
] as const;
export const AccessReviewFlagSchema = z.enum(ACCESS_REVIEW_FLAGS).openapi("AccessReviewFlag");

export const AccessReviewRowSchema = z
  .object({
    membershipId: UuidSchema,
    /** `null` when the person has no name on record or was erased. */
    name: z.string().nullable(),
    /** Primary email; `null` when there is none or it was erased. */
    email: z.string().nullable(),
    kind: MembershipKindSchema,
    role: MembershipRoleSchema,
    status: MembershipStatusSchema,
    /** Live group names, alphabetical. */
    groups: z.array(z.string()),
    /** Live grants naming this membership directly (group and role grants are not counted). */
    grantCount: z.number().int().nonnegative(),
    /** Latest of `membership.last_seen_at` and this workspace's sessions' `last_seen_at`. */
    lastActiveAt: TimestampSchema.nullable(),
    expiresAt: TimestampSchema.nullable(),
    /** Live sessions whose last workspace is this one. */
    activeSessions: z.number().int().nonnegative(),
    nda: z.object({ kind: z.string(), signedAt: TimestampSchema }).nullable(),
    accreditation: z
      .object({
        signedAt: TimestampSchema,
        /** `attestation.expires_at` (twelve calendar months after signing, E2.3). */
        expiresAt: TimestampSchema.nullable(),
        /** The strictest `accredited` gate that applies to this member; `null` when none does. */
        gateMaxAgeDays: z.number().int().nullable(),
        /** `signedAt + gateMaxAgeDays`: when the gate stops accepting this attestation. */
        gateLapsesAt: TimestampSchema.nullable(),
        /** The gate's window and the attestation's own expiry disagree by more than a day. */
        diverges: z.boolean(),
      })
      .nullable(),
    /** Attestation-bound gates still pending in `effective_access` (`nda:v3`, `accredited`). */
    pendingGates: z.array(z.string()),
    flags: z.array(AccessReviewFlagSchema),
  })
  .openapi("AccessReviewRow");

export const AccessReviewRecordSchema = z
  .object({
    id: UuidSchema,
    reviewerMembershipId: UuidSchema,
    reviewerName: z.string().nullable(),
    completedAt: TimestampSchema,
    memberCount: z.number().int().nonnegative(),
    flaggedCount: z.number().int().nonnegative(),
    note: z.string().nullable(),
    /** sha256 (hex) of the report's canonical JSON at completion. */
    reportSha256: z.string(),
  })
  .openapi("AccessReviewRecord");

export const AccessReviewReportSchema = z
  .object({
    generatedAt: TimestampSchema,
    members: z.array(AccessReviewRowSchema),
    summary: z.object({
      members: z.number().int().nonnegative(),
      flagged: z.number().int().nonnegative(),
      byFlag: z.record(z.string(), z.number().int().nonnegative()),
      /** True when the workspace has more non-revoked members than the report bound. */
      truncated: z.boolean(),
    }),
    lastReview: z.union([AccessReviewRecordSchema, z.null()]),
    /**
     * Last completed review + 90 days; never reviewed → the workspace's creation + 90 days (the
     * instant the `access-review.overdue` reminder starts).
     */
    nextReviewDueAt: TimestampSchema,
    /**
     * sha256 (hex) of this report's evidence form (the canonical JSON of `{schemaVersion,
     * generatedAt, members, summary}` with `lastActiveAt` recorded to the day). Send it back with
     * `generatedAt` when completing the review to attest to exactly this report.
     */
    reportSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .openapi("AccessReviewReport");

export const AccessReviewQuery = z.object({
  format: z.enum(["json", "csv"]).default("json"),
});

export const AccessReviewListSchema = z
  .object({ items: z.array(AccessReviewRecordSchema) })
  .openapi("AccessReviewList");

export const CompleteReviewBody = z
  .object({
    note: z.string().trim().max(1000).optional(),
    /** The `reportSha256` of the report the reviewer was shown. */
    reportSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    /** The `generatedAt` of that report; required with `reportSha256`. */
    generatedAt: TimestampSchema.optional(),
  })
  .refine((b) => (b.reportSha256 === undefined) === (b.generatedAt === undefined), {
    message: "reportSha256 and generatedAt go together",
    path: ["generatedAt"],
  });

export const ReviewParams = z.object({ id: UuidSchema });

export const MemberSessionSchema = z
  .object({
    id: UuidSchema,
    deviceName: z.string().nullable(),
    /** Short user-agent summary ("Firefox on macOS"). */
    device: z.string(),
    ip: z.string().nullable(),
    createdAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    authLevel: z.number().int(),
    idleExpiresAt: TimestampSchema,
    absoluteExpiresAt: TimestampSchema,
  })
  .openapi("MemberSession");

export const MemberSessionsSchema = z
  .object({ sessions: z.array(MemberSessionSchema) })
  .openapi("MemberSessions");

export const MemberParams = z.object({ id: UuidSchema });
export const MemberSessionParams = z.object({ id: UuidSchema, sessionId: UuidSchema });

export const RevokedCountSchema = z
  .object({ revoked: z.number().int().nonnegative() })
  .openapi("RevokedCount");

/** Every danger-zone body carries the workspace slug typed back. */
const Confirm = z.string().max(100).openapi({ description: "The workspace slug, typed back" });

export const TransferOwnershipBody = z.object({
  toMembershipId: UuidSchema,
  confirm: Confirm,
  keepOwner: z.boolean().default(false),
});

export const RevokeAllSessionsBody = z.object({
  confirm: Confirm,
  includeStaff: z.boolean().default(false),
});

export const DeleteWorkspaceBody = z.object({ confirm: Confirm });

export const WorkspaceDeletedSchema = z
  .object({ purgeAfter: TimestampSchema })
  .openapi("WorkspaceDeleted");
