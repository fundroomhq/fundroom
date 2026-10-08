import { z } from "@hono/zod-openapi";
import { TimestampSchema } from "./schemas.js";

/*
 * Per-tenant data residency (E3.11, ADR-0059): `GET /api/v1/residency`, handler in
 * `apps/server/src/routes/residency.ts`. Every location is OPERATOR-DECLARED (`declared:
 * "operator"`): the product cannot verify where a database or bucket physically is.
 */

export const JurisdictionSchema = z
  .enum(["eu", "uk", "ch", "us", "ca", "au", "other"])
  .openapi("Jurisdiction");

/** A vendor's jurisdiction: `varies` = a global edge or per-request routing. */
export const VendorJurisdictionSchema = z
  .enum(["eu", "uk", "ch", "us", "ca", "au", "other", "varies"])
  .openapi("VendorJurisdiction");

export const MoveStateSchema = z
  .enum([
    "requested",
    "exporting",
    "exported",
    "importing",
    "imported",
    "switched",
    "retired",
    "failed",
    "cancelled",
  ])
  .openapi("MoveState");

export const DataRegionSchema = z
  .object({
    code: z.string().openapi({ example: "eu" }),
    label: z.string().openapi({ description: "'' when the operator declared none" }),
    jurisdiction: z.union([JurisdictionSchema, z.null()]),
  })
  .openapi("DataRegion");

export const RESIDENCY_COMPONENTS = [
  "database",
  "jobs",
  "search",
  "analytics",
  "objectStorage",
  "backups",
  "email",
  "telemetry",
  "errorReporting",
  "virusScan",
  "ai",
] as const;

export const ResidencyComponentSchema = z
  .object({
    component: z.enum(RESIDENCY_COMPONENTS),
    location: z.union([z.string(), z.null()]),
    jurisdiction: z.union([VendorJurisdictionSchema, z.null()]),
    inRegion: z.union([z.boolean(), z.null()]).openapi({
      description: "null when the region or the component's jurisdiction is unknown or `varies`",
    }),
  })
  .openapi("ResidencyComponent");

export const ResidencySubProcessorSchema = z
  .object({
    name: z.string(),
    purpose: z.string(),
    dataProcessed: z.string(),
    location: z.string(),
    jurisdiction: VendorJurisdictionSchema,
    transferMechanism: z.union([z.string(), z.null()]),
    dpaUrl: z.union([z.string(), z.null()]),
    certifications: z.array(z.string()),
    scope: z.enum(["deployment", "workspace"]).openapi({
      description:
        "`deployment`: configured by the operator; `workspace`: a vendor this workspace connected itself",
    }),
    outsideRegion: z.union([z.boolean(), z.null()]),
  })
  .openapi("ResidencySubProcessor");

export const ResidencyRelocationSchema = z
  .object({
    state: MoveStateSchema,
    targetRegion: z.union([z.string(), z.null()]),
    requestedAt: TimestampSchema,
  })
  .openapi("ResidencyRelocation");

export const ResidencySchema = z
  .object({
    region: z.union([DataRegionSchema, z.null()]).openapi({
      description: "null: the operator declared no region",
    }),
    declared: z.literal("operator"),
    cellId: z.union([z.string(), z.null()]).openapi({ description: "Only with CONTROL_PLANE=on" }),
    components: z.array(ResidencyComponentSchema),
    subProcessors: z.array(ResidencySubProcessorSchema),
    relocation: z.union([ResidencyRelocationSchema, z.null()]),
  })
  .openapi("Residency");
