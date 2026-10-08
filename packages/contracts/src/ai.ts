import { z } from "@hono/zod-openapi";
import { VendorJurisdictionSchema } from "./residency.js";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * AI assist (E3.12, ADR-0060). Kernel routes `/ai/*` live in `apps/server/src/routes/ai.ts`
 * behind the `required` `ai` manifest; the kernel is `@fundroom/ai` and model adapters implement
 * `ModelPort` (`@fundroom/ports`). Two module routes start requests and answer `AiStarted`:
 * `POST /updates/ai/draft` (body in `modules/updates/src/contracts.ts`) and
 * `POST /data-room/qa/inbox/{id}/ai-suggestion` (no body).
 *
 * AI never writes tenant content: a result is a suggestion staff apply through the normal write
 * paths (save an update draft, save a Q&A answer).
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */

export const AI_FEATURES = ["update_draft", "qa_answer"] as const;
export const AiFeatureSchema = z.enum(AI_FEATURES).openapi("AiFeature");

export const AiHostingSchema = z.enum(["self_hosted", "third_party"]).openapi("AiHosting");

/** The operator's model provider as tenants see it (never a key or a URL). */
export const AiProviderInfoSchema = z
  .object({
    id: z.enum(["openai-compatible", "anthropic", "fake"]),
    label: z.string().openapi({ example: "Ollama at ollama:11434" }),
    model: z.string().openapi({ example: "qwen3.5:9b" }),
    hosting: AiHostingSchema,
    location: z.union([z.string(), z.null()]).openapi({
      description: "null = the operator's own infrastructure",
    }),
    jurisdiction: z.union([VendorJurisdictionSchema, z.null()]),
    trainsOnInputs: z.union([z.literal(false), z.null()]).openapi({
      description:
        "false = the provider is known not to train on inputs (operator-run, or its API terms say so); null = not stated (a third-party OpenAI-compatible host)",
    }),
    retention: z.string().openapi({ description: "One English sentence of API facts" }),
  })
  .openapi("AiProviderInfo");

export const AiFeatureFlagsSchema = z
  .object({ updateDraft: z.boolean(), qaAnswer: z.boolean() })
  .openapi("AiFeatureFlags");

export const AiAcknowledgementSchema = z
  .object({
    providerKey: z.string().max(400),
    hosting: AiHostingSchema,
    at: TimestampSchema,
    byMembershipId: UuidSchema,
  })
  .openapi("AiAcknowledgement");

/** The workspace's stored `settings.ai` block. */
export const AiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    features: AiFeatureFlagsSchema,
    monthlyTokenBudget: z.union([z.number().int(), z.null()]).openapi({
      description: "null = the operator's AI_MONTHLY_TOKEN_BUDGET",
    }),
    acknowledgement: z.union([AiAcknowledgementSchema, z.null()]),
  })
  .openapi("AiSettings");

export const AiUsageSchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/u)
      .openapi({ example: "2026-09" }),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    requests: z.number().int(),
    budget: z.number().int().openapi({ description: "The effective monthly token budget" }),
    minimumBudget: z.number().int().openapi({
      description:
        "One request's worst-case reservation: a monthly budget below it can never start a request (PUT refuses it)",
    }),
    budgetBelowMinimum: z.boolean().openapi({
      description:
        "The effective budget is below `minimumBudget` (e.g. the operator raised AI_MAX_*): every feature reads off in `effective`, and starts answer 409 `ai_disabled` with `reason: budget_below_minimum`",
    }),
  })
  .openapi("AiUsage");

/** `GET /ai/status` (always 200, also when AI is unavailable) and `PUT /ai/settings`. */
export const AiStatusSchema = z
  .object({
    available: z.boolean(),
    provider: z.union([AiProviderInfoSchema, z.null()]),
    settings: AiSettingsSchema,
    needsAcknowledgement: z.boolean().openapi({
      description: "No acknowledgement for the current provider identity",
    }),
    effective: AiFeatureFlagsSchema,
    /** A-3 (ADR-0063): false only under CONTROL_PLANE=on with a plan that leaves AI out. */
    planAllows: z.boolean().openapi({
      description:
        'The workspace\'s plan includes AI assist. When false, turning AI or a feature on and every new request answer 402 `plan_limit` (`feature: "ai"`), and queued requests are refused `plan_limit`; `settings` and `effective` still show what is configured.',
    }),
    usage: AiUsageSchema,
  })
  .openapi("AiStatus");

/** `PUT /ai/settings` (ai.manage + fresh). */
export const PutAiSettingsBody = z
  .object({
    enabled: z.boolean(),
    features: AiFeatureFlagsSchema,
    monthlyTokenBudget: z.union([z.number().int().min(1000), z.null()]),
    acknowledge: z.boolean(),
  })
  .strict()
  .openapi("PutAiSettingsBody");

export const AiRequestStatusSchema = z
  .enum(["queued", "running", "done", "failed", "refused", "cancelled"])
  .openapi("AiRequestStatus");

export const AiUpdateDraftResultSchema = z
  .object({
    kind: z.literal("update_draft"),
    title: z.string().max(200),
    doc: z.record(z.string(), z.unknown()).openapi({
      description: "A `PageDoc` (modules/content), validated by the updates task",
    }),
    kpiDefinitionIds: z.array(UuidSchema).max(12),
    sources: z.object({
      kpis: z.boolean(),
      lastUpdate: z.union([
        z.object({ postId: UuidSchema, title: z.string(), sentAt: TimestampSchema }),
        z.null(),
      ]),
    }),
    /**
     * E3.12 fix round 1 (owner U): figures in the draft that appear nowhere in the material the
     * model was given (KPI lines, last update, notes) — compared by value. Shown as "check these".
     */
    unverifiedNumbers: z.array(z.string().max(40)).max(50).openapi({
      description:
        "Figures in the draft that do not appear in the current KPIs or the notes the model was given (compared by value, unit class and sign), nor in the previous update. Check them before saving.",
    }),
    /** RR2-L5 (owner U): figures found only in the previous update, whose numbers are old. */
    numbersFromLastUpdate: z.array(z.string().max(40)).max(50).openapi({
      description:
        "Figures in the draft that appear only in the previous update (old numbers presented as current?). Check them before saving.",
    }),
  })
  .openapi("AiUpdateDraftResult");

export const AiCitationSchema = z
  .object({
    n: z.number().int().min(1),
    documentId: UuidSchema,
    versionId: UuidSchema,
    pageNo: z.number().int().min(1),
    documentTitle: z.string(),
    quote: z.string().max(300),
  })
  .openapi("AiCitation");

export const AiQaAnswerResultSchema = z
  .object({
    kind: z.literal("qa_answer"),
    outcome: z.enum(["answered", "insufficient", "unsupported"]),
    body: z.string().max(20_000).openapi({ description: "Plain text" }),
    citations: z.array(AiCitationSchema).max(12),
    droppedCitations: z.number().int().min(0),
    searchedDocuments: z.number().int().min(0),
  })
  .openapi("AiQaAnswerResult");

/** Stored in `core.ai_request.result` with `result_schema_version` 1. */
export const AiResultSchema = z
  .discriminatedUnion("kind", [AiUpdateDraftResultSchema, AiQaAnswerResultSchema])
  .openapi("AiResult");

/** `GET /ai/requests/{id}`. */
export const AiRequestSchema = z
  .object({
    id: UuidSchema,
    feature: AiFeatureSchema,
    subjectId: z.union([UuidSchema, z.null()]),
    status: AiRequestStatusSchema,
    errorCode: z.union([z.string(), z.null()]),
    createdAt: TimestampSchema,
    finishedAt: z.union([TimestampSchema, z.null()]),
    result: z.union([AiResultSchema, z.null()]),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  })
  .openapi("AiRequest");

export const AiRequestIdParams = z.object({ id: UuidSchema });

/** 202 from a module route that started (or reused) a request; poll `GET /ai/requests/{id}`. */
export const AiStartedSchema = z.object({ requestId: UuidSchema }).openapi("AiStarted");

export type AiStatus = z.infer<typeof AiStatusSchema>;
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export type AiProviderInfo = z.infer<typeof AiProviderInfoSchema>;
export type PutAiSettings = z.infer<typeof PutAiSettingsBody>;
export type AiRequest = z.infer<typeof AiRequestSchema>;
export type AiResult = z.infer<typeof AiResultSchema>;
export type AiUpdateDraftResult = z.infer<typeof AiUpdateDraftResultSchema>;
export type AiQaAnswerResult = z.infer<typeof AiQaAnswerResultSchema>;
