/*
 * `@fundroom/ai` (E3.12, ADR-0060): the kernel AI assist service — provider identity and the
 * per-workspace acknowledgement, effective state, budgets and rate limits, `core.ai_request` and
 * the single `ai.run` job, the retention sweep and the deletion hooks. Model adapters implement
 * `ModelPort` (`@fundroom/ports`); modules register AI tasks in their manifests.
 */

export { deleteAiRequestsOfMember } from "./erasure.js";
export {
  AI_CORRECTIVE_PROMPT,
  AI_JOBS,
  AI_MAX_IN_FLIGHT,
  AI_MAX_RESULT_BYTES,
  AI_RETENTION_CRON,
  type AiActor,
  type AiCaller,
  type AiKernel,
  type AiKernelDeps,
  AiKernelStartError,
  type AiLimits,
  type AiRequestView,
  AiSettingsError,
  type AiSettingsInput,
  type AiStatusView,
  createAiKernel,
} from "./kernel.js";
export {
  type AiFeatureFlags,
  acknowledged,
  aiProviderKey,
  effectiveAiFeatures,
  effectiveBudget,
  flagOf,
  msUntilNextMonth,
  parseModelJson,
  Semaphore,
  usageMonth,
} from "./policy.js";
