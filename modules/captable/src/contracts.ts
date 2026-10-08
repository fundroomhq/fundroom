import { TimestampSchema, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import {
  DISCLAIMER_MAX,
  IMPORT_FORMATS,
  IMPORT_MAX_BYTES,
  INVESTOR_VIEWS,
  NOTE_MAX,
  SECURITY_KINDS,
  SNAPSHOT_SOURCES,
  SNAPSHOT_STATUSES,
} from "./model.js";

/*
 * Route schemas for `/api/v1/captable/*` (E3.6 §8). Every `.openapi("Captable…")` name is stable
 * API (the web and the SDK consume them). House rules: a named schema is never `.nullable()`d
 * (`z.union([X, z.null()])` instead), and every quantity is a decimal **string** — shares and
 * money do not survive a round trip through a double.
 */

export const CaptableDecimalSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/u)
  .openapi("CaptableDecimal", {
    example: "1250000",
    description: "Decimal as text (no exponent, no trailing fraction zeros); never a JSON number.",
  });

export const CaptablePercentSchema = z
  .string()
  .regex(/^\d+\.\d{4}$/u)
  .openapi("CaptablePercent", {
    example: "12.3456",
    description:
      "Percent of fully diluted, four decimal places, each rounded half away from zero on its own: a column of them need not sum to exactly 100.0000 (the UI notes the rounding).",
  });

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .openapi({ example: "2026-09-30", description: "Calendar date, YYYY-MM-DD" });

const NullableDecimal = z.union([CaptableDecimalSchema, z.null()]);
const NullableString = z.union([z.string(), z.null()]);
const NullableUuid = z.union([UuidSchema, z.null()]);
const NullableDate = z.union([DateOnly, z.null()]);

export const CaptableSecurityKindSchema = z.enum(SECURITY_KINDS).openapi("CaptableSecurityKind");
export const CaptableSnapshotSourceSchema = z
  .enum(SNAPSHOT_SOURCES)
  .openapi("CaptableSnapshotSource");
export const CaptableSnapshotStatusSchema = z
  .enum(SNAPSHOT_STATUSES)
  .openapi("CaptableSnapshotStatus");
export const CaptableImportFormatSchema = z.enum(IMPORT_FORMATS).openapi("CaptableImportFormat");
export const CaptableInvestorViewSchema = z.enum(INVESTOR_VIEWS).openapi("CaptableInvestorView");

export const CaptableCurrencyAmountSchema = z
  .object({ currency: z.string().length(3), amount: CaptableDecimalSchema })
  .openapi("CaptableCurrencyAmount");

export const CaptableClassSummarySchema = z
  .object({
    name: z.string(),
    kind: CaptableSecurityKindSchema,
    position: z.number().int(),
    shares: NullableDecimal,
    fullyDilutedShares: CaptableDecimalSchema,
    percentFullyDiluted: CaptablePercentSchema,
    amounts: z.array(CaptableCurrencyAmountSchema),
    holders: z.number().int(),
    lines: z.number().int(),
  })
  .openapi("CaptableClassSummary");

export const CaptableOptionPoolSchema = z
  .object({
    poolShares: NullableDecimal,
    granted: NullableDecimal,
    available: NullableDecimal,
  })
  .openapi("CaptableOptionPool", {
    description:
      "`poolShares` is the plan's total pool, `granted` the option lines, `available` pool − granted (floored at 0; null without a pool).",
  });

export const CaptableConvertibleSchema = z
  .object({
    currency: z.string().length(3),
    safes: CaptableDecimalSchema,
    notes: CaptableDecimalSchema,
    total: CaptableDecimalSchema,
  })
  .openapi("CaptableConvertible");

export const CaptableSummarySchema = z
  .object({
    fullyDilutedShares: CaptableDecimalSchema,
    classes: z.array(CaptableClassSummarySchema),
    optionPool: z.union([CaptableOptionPoolSchema, z.null()]),
    convertiblesOutstanding: z.array(CaptableConvertibleSchema),
    holderCount: z.number().int(),
    lineCount: z.number().int(),
    matchedHolders: z.number().int(),
    unmatchedHolders: z.number().int(),
  })
  .openapi("CaptableSummary", {
    description:
      "Fully diluted = common + preferred (as converted 1:1) + warrants + granted options + the pool still available. SAFEs and notes are listed as outstanding amounts and count no shares until they convert.",
  });

export const CaptableSnapshotSchema = z
  .object({
    id: UuidSchema,
    asOf: DateOnly,
    source: CaptableSnapshotSourceSchema,
    status: CaptableSnapshotStatusSchema,
    note: NullableString,
    importedBy: NullableUuid,
    createdAt: TimestampSchema,
    publishedAt: z.union([TimestampSchema, z.null()]),
    summary: CaptableSummarySchema,
  })
  .openapi("CaptableSnapshot");

export const CaptableSnapshotListSchema = z
  .object({ snapshots: z.array(CaptableSnapshotSchema) })
  .openapi("CaptableSnapshotList");

export const CaptableHoldingSchema = z
  .object({
    id: UuidSchema,
    classId: UuidSchema,
    className: z.string(),
    kind: CaptableSecurityKindSchema,
    holderName: z.string(),
    holderEmail: NullableString,
    membershipId: NullableUuid,
    shares: NullableDecimal,
    amount: NullableDecimal,
    currency: NullableString,
    issuedOn: NullableDate,
    erased: z.boolean(),
  })
  .openapi("CaptableHolding");

export const CaptableHolderSchema = z
  .object({
    key: z.string(),
    holderName: z.string(),
    holderEmail: NullableString,
    membershipId: NullableUuid,
    fullyDilutedShares: CaptableDecimalSchema,
    percentFullyDiluted: CaptablePercentSchema,
    amounts: z.array(CaptableCurrencyAmountSchema),
    lines: z.number().int(),
  })
  .openapi("CaptableHolder");

export const CaptableSnapshotDetailSchema = z
  .object({
    snapshot: CaptableSnapshotSchema,
    holders: z.array(CaptableHolderSchema),
    holdings: z.array(CaptableHoldingSchema),
  })
  .openapi("CaptableSnapshotDetail");

export const CaptableIdParams = z.object({ id: UuidSchema });

// --- import ---------------------------------------------------------------------------------

export const CaptableImportBodySchema = z
  .object({
    format: CaptableImportFormatSchema,
    /** Characters, a coarse first bound; the service enforces the 2 MiB UTF-8 byte cap. */
    csv: z.string().min(1).max(IMPORT_MAX_BYTES),
    asOf: DateOnly,
    note: z.string().trim().max(NOTE_MAX).optional(),
  })
  .openapi("CaptableImportBody");

export const CaptableImportWarningSchema = z
  .object({
    line: z.union([z.number().int(), z.null()]),
    column: NullableString,
    code: z.string(),
    message: z.string(),
  })
  .openapi("CaptableImportWarning");

export const CaptableImportLineSchema = z
  .object({
    line: z.number().int(),
    holderName: z.string(),
    holderEmail: NullableString,
    membershipId: NullableUuid,
    className: z.string(),
    kind: CaptableSecurityKindSchema,
    shares: NullableDecimal,
    amount: NullableDecimal,
    currency: NullableString,
    issuedOn: NullableDate,
  })
  .openapi("CaptableImportLine");

export const CaptableImportPreviewSchema = z
  .object({
    format: CaptableImportFormatSchema,
    source: CaptableSnapshotSourceSchema,
    asOf: DateOnly,
    rows: z.number().int(),
    matched: z.number().int(),
    unmatched: z.number().int(),
    summary: CaptableSummarySchema,
    warnings: z.array(CaptableImportWarningSchema),
    lines: z.array(CaptableImportLineSchema),
  })
  .openapi("CaptableImportPreview");

export const CaptableImportResultSchema = z
  .object({ snapshot: CaptableSnapshotSchema, preview: CaptableImportPreviewSchema })
  .openapi("CaptableImportResult");

// --- settings -------------------------------------------------------------------------------

export const CaptableSettingsSchema = z
  .object({
    investorView: CaptableInvestorViewSchema,
    disclaimer: NullableString,
    defaultDisclaimer: z.string(),
  })
  .openapi("CaptableSettings");

export const CaptableSettingsBodySchema = z
  .object({
    investorView: CaptableInvestorViewSchema,
    disclaimer: z.union([z.string().max(DISCLAIMER_MAX), z.null()]),
  })
  .openapi("CaptableSettingsBody");

// --- investor -------------------------------------------------------------------------------

export const CaptableMyHoldingSchema = z
  .object({
    className: z.string(),
    kind: CaptableSecurityKindSchema,
    shares: NullableDecimal,
    amount: NullableDecimal,
    currency: NullableString,
    issuedOn: NullableDate,
  })
  .openapi("CaptableMyHolding");

export const CaptableInvestorShareBucketSchema = z
  .object({
    kind: z.enum(["common", "preferred", "options", "warrants"]),
    percentFullyDiluted: z
      .string()
      .regex(/^\d+\.\d$/u)
      .openapi({ example: "76.4", description: "Percent of fully diluted, one decimal place" }),
  })
  .openapi("CaptableInvestorShareBucket", {
    description: "`options` is granted options and the unallocated pool together.",
  });

export const CaptableInvestorConvertiblesBucketSchema = z
  .object({ kind: z.literal("convertibles"), present: z.literal(true) })
  .openapi("CaptableInvestorConvertiblesBucket", {
    description: "SAFEs/notes exist (they hold no fully diluted shares until they convert).",
  });

export const CaptableInvestorSummarySchema = z
  .object({
    buckets: z.array(
      z.union([CaptableInvestorShareBucketSchema, CaptableInvestorConvertiblesBucketSchema]),
    ),
  })
  .openapi("CaptableInvestorSummary", {
    description:
      'Kind buckets only, with nothing but their % of fully diluted to one decimal place (no share counts, amounts or totals). A bucket is shown only with at least three distinct holders other than the caller holding fully diluted > 0, none above 70% of their combined position and no two above 90%. Omitted buckets are left out, never folded; if the omitted share buckets have other holders who, pooled, fail the same test, the smallest shown bucket is omitted too. An empty `buckets` list means summary mode with nothing showable ("not enough holders to show a breakdown"); `CaptableMe.summary` is `null` only in `own_line` mode.',
  });

export const CaptableMeSchema = z
  .object({
    snapshotId: UuidSchema,
    asOf: DateOnly,
    disclaimer: z.string(),
    holdings: z.array(CaptableMyHoldingSchema),
    ownership: z.object({
      fullyDilutedShares: CaptableDecimalSchema,
      percentFullyDiluted: z
        .string()
        .regex(/^\d+\.\d{2}$/u)
        .openapi({ example: "15.09", description: "The caller's % of fully diluted, 2 dp" }),
    }),
    summary: z.union([CaptableInvestorSummarySchema, z.null()]),
  })
  .openapi("CaptableMe");
