import { z } from "@hono/zod-openapi";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Workspace export contracts (E2.8): `/portability/exports*` and `/portability/export-key`.
 * Handlers: `apps/server/src/routes/portability.ts`; the engine and the zip format:
 * `@fundroom/portability`.
 */

export const WorkspaceExportStatusSchema = z
  .enum(["queued", "running", "ready", "failed", "expired"])
  .openapi("WorkspaceExportStatus");

export const WorkspaceExportOptionsSchema = z
  .object({
    includeRawAnalytics: z.boolean().openapi({
      description: "Include raw engagement events (page views, document views), not only rollups",
    }),
  })
  .openapi("WorkspaceExportOptions");

export const WorkspaceExportSchema = z
  .object({
    id: UuidSchema,
    status: WorkspaceExportStatusSchema,
    options: WorkspaceExportOptionsSchema,
    sizeBytes: z.number().int().min(0).nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .openapi({ description: "Hex sha256 of the zip (also sent as `X-Content-SHA256`)" }),
    error: z.string().nullable(),
    createdAt: TimestampSchema,
    completedAt: z.union([TimestampSchema, z.null()]),
    expiresAt: z.union([TimestampSchema, z.null()]).openapi({
      description: "When the file is deleted (7 days after completion)",
    }),
    downloadedAt: z.union([TimestampSchema, z.null()]),
    warnings: z.array(z.string()).optional().openapi({
      description:
        "Data the finished export could not include, e.g. a module whose schema exists in the database but is not loaded on this instance (`MODULES`). Always sent by this server; empty when nothing was left out.",
    }),
  })
  .openapi("WorkspaceExport");

export const WorkspaceExportListSchema = z
  .object({ items: z.array(WorkspaceExportSchema) })
  .openapi("WorkspaceExportList");

export const WorkspaceExportBody = z
  .object({ includeRawAnalytics: z.boolean().optional() })
  .openapi("WorkspaceExportRequest");

export const WorkspaceExportParams = z.object({ id: UuidSchema });

export const WorkspaceExportKeySchema = z
  .object({
    keyId: z.string().openapi({ example: "v2" }),
    alg: z.literal("Ed25519"),
    publicKey: z.string().openapi({
      description: "Base64 of the raw 32-byte Ed25519 public key",
      example: "0vN6m1a6Xx2A0h8d7hZf6k0cQ2c9C6r3oS4r0VbqM9w=",
    }),
  })
  .openapi("WorkspaceExportKey");

export const WorkspaceExportKeysSchema = z
  .object({ keys: z.array(WorkspaceExportKeySchema) })
  .openapi("WorkspaceExportKeys");
