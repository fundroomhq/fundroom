import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { m } from "../paraglide/messages.js";
import { api, call, isApiError } from "./api.js";
import type { WebConfig } from "./config.js";
import { useWebConfig } from "./config-context.js";
import { planAllowsFeature, planFeatureLabel } from "./plan-features.js";
import { type Bootstrap, useBootstrap } from "./queries.js";

/*
 * AI assist (E3.12, ADR-0060). The host configures one model (or none: `config.ai` is false and
 * nothing here is asked for); a workspace opts in on Settings → AI assist, acknowledging which
 * provider its material goes to. Every AI feature produces a SUGGESTION on a kernel request row
 * the SPA polls (`GET /ai/requests/{id}`); staff apply it through the product's normal write paths
 * (create an update draft, save a Q&A answer), so nothing AI-written reaches an investor unsaved.
 */
export type AiStatus = FundRoomSchemas["AiStatus"];
export type AiSettings = FundRoomSchemas["AiSettings"];
export type AiProviderInfo = FundRoomSchemas["AiProviderInfo"];
export type AiRequest = FundRoomSchemas["AiRequest"];
export type AiRequestStatus = FundRoomSchemas["AiRequestStatus"];
export type AiUpdateDraftResult = FundRoomSchemas["AiUpdateDraftResult"];
export type AiQaAnswerResult = FundRoomSchemas["AiQaAnswerResult"];
export type AiCitation = FundRoomSchemas["AiCitation"];
export type PutAiSettings = {
  enabled: boolean;
  features: FundRoomSchemas["AiFeatureFlags"];
  monthlyTokenBudget: number | null;
  acknowledge: boolean;
};
export type AiEffectiveFeature = keyof FundRoomSchemas["AiFeatureFlags"];

export const AI_KEY = ["ai"] as const;

export const aiStatusQuery = queryOptions({
  queryKey: [...AI_KEY, "status"] as const,
  queryFn: () => call(api().GET("/ai/status")),
});

/**
 * Test seam: how often a running request is polled (every 1.5 s), the longest back-off between
 * polls after a transient failure (a 5xx, 429 or network blip keeps polling), and when to give up
 * on a request that never finishes (15 minutes; the kernel's sweep marks it `stale` later).
 */
export const aiPolling = { intervalMs: 1500, maxBackoffMs: 30_000, giveUpMs: 15 * 60_000 };

/** A failure worth polling through: offline, the server's 5xx, or a 429. */
export function isTransientAiError(error: unknown): boolean {
  return isApiError(error) && (error.status === 0 || error.status === 429 || error.status >= 500);
}

/** A request that will not change any more: stop polling. */
export function isAiTerminal(status: AiRequestStatus): boolean {
  return status === "done" || status === "failed" || status === "refused" || status === "cancelled";
}

export function aiRequestQuery(id: string) {
  return queryOptions({
    queryKey: [...AI_KEY, "request", id] as const,
    queryFn: () => call(api().GET("/ai/requests/{id}", { params: { path: { id } } })),
    staleTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data !== undefined && isAiTerminal(data.status)) return false;
      if (query.state.status === "error") {
        if (!isTransientAiError(query.state.error)) return false;
        const failures = Math.min(6, Math.max(1, query.state.fetchFailureCount));
        return Math.min(aiPolling.maxBackoffMs, aiPolling.intervalMs * 2 ** failures);
      }
      return aiPolling.intervalMs;
    },
  });
}

/**
 * Poll one request until it is terminal. Transient failures keep polling (with back-off) and are
 * reported as `retrying`; any other failure (a 404: the row is gone or no longer yours) is `error`.
 * After `aiPolling.giveUpMs` without a terminal state the hook stops and says so (`gaveUp`);
 * `checkAgain()` starts a fresh window.
 */
export function useAiRequest(id: string) {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);
  const query = useQuery({ ...aiRequestQuery(id), enabled: !gaveUp });
  const terminal = query.data !== undefined && isAiTerminal(query.data.status);
  useEffect(() => {
    if (terminal || gaveUp) return;
    const t = setTimeout(
      () => setGaveUp(true),
      Math.max(0, startedAt + aiPolling.giveUpMs - Date.now()),
    );
    return () => clearTimeout(t);
  }, [terminal, gaveUp, startedAt]);
  const hardError = query.isError && !isTransientAiError(query.error) ? query.error : null;
  return {
    data: query.data,
    terminal,
    error: hardError,
    retrying: query.isError && isTransientAiError(query.error) && !gaveUp,
    gaveUp: gaveUp && !terminal,
    checkAgain: () => {
      setStartedAt(Date.now());
      setGaveUp(false);
      void query.refetch();
    },
  };
}

export function putAiSettings(body: PutAiSettings) {
  return call(api().PUT("/ai/settings", { body }));
}

export function startUpdateDraft(body: {
  notes: string | null;
  template: "yc" | "minimal" | "board" | "blank";
}) {
  return call(api().POST("/updates/ai/draft", { body }));
}

export function startQaSuggestion(questionId: string) {
  return call(
    api().POST("/data-room/qa/inbox/{id}/ai-suggestion", {
      params: { path: { id: questionId } },
    }),
  );
}

/** Discard a suggestion (cancels it while it runs). Best effort: the row expires anyway. */
export function discardAiRequest(id: string) {
  return api()
    .DELETE("/ai/requests/{id}", { params: { path: { id } } })
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Whether this viewer gets AI assist at all: the install has a model (`config.ai`) and they hold
 * `ai.read`. Either alone is a link to a page or a status read that answers nothing useful.
 */
export function canSeeAi(
  config: Pick<WebConfig, "ai">,
  bootstrap: Pick<Bootstrap, "permissions"> | undefined,
): boolean {
  return config.ai === true && (bootstrap?.permissions ?? []).includes("ai.read");
}

/**
 * Whether an AI feature is effectively on for this viewer: the install has a model, the viewer
 * may read AI status and holds the feature's own permission (`also`), and the workspace has the
 * feature on with a current acknowledgement (`effective`). The status is read only when the first
 * three hold, so an install without a model makes no AI calls at all.
 *
 * A-3: and the plan includes `ai` — `effective` reports the settings, which a downgrade keeps,
 * while every start is refused (402) until the plan includes it again. The bootstrap's plan is
 * checked too, so the button goes as soon as either says so.
 */
export function useAiFeature(feature: AiEffectiveFeature, also: boolean): boolean {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  const enabled = also && canSeeAi(config, bootstrap.data);
  const status = useQuery({ ...aiStatusQuery, enabled });
  return (
    enabled &&
    status.data?.planAllows !== false &&
    planAllowsFeature(bootstrap.data, "ai") &&
    status.data?.effective[feature] === true
  );
}

/** "Runs on your host's infrastructure" / "Third-party service — documents leave …". */
export function aiHostingLabel(hosting: AiProviderInfo["hosting"]): string {
  return hosting === "self_hosted" ? m.ai_hosting_self_hosted() : m.ai_hosting_third_party();
}

/**
 * Where the model runs, as the host declared it. The host's own infrastructure is the fallback only
 * for a self-hosted model: a third-party provider with no stated location is said to be unstated.
 */
export function aiLocationLabel(provider: Pick<AiProviderInfo, "hosting" | "location">): string {
  if (provider.location !== null) return provider.location;
  return provider.hosting === "self_hosted"
    ? m.ai_provider_location_host()
    : m.ai_provider_location_not_stated();
}

/**
 * Training, as far as the software knows: `false` only when the adapter can say so (self-hosted,
 * Anthropic); `null` (a hosted OpenAI-compatible service) means the provider's own terms govern it.
 */
export function aiTrainingLabel(provider: Pick<AiProviderInfo, "trainsOnInputs">): string {
  return provider.trainsOnInputs === false
    ? m.ai_provider_no_training()
    : m.ai_provider_training_not_stated();
}

/** Why a finished request has no suggestion, from its `status` + `errorCode`. */
export function aiRequestErrorMessage(request: Pick<AiRequest, "status" | "errorCode">): string {
  // RR3-L9: a bin or purge of a cited document discards others' in-flight suggestions.
  if (request.errorCode === "sources_changed") return m.ai_error_sources_changed();
  if (request.status === "cancelled") return m.ai_error_cancelled();
  const code = request.errorCode ?? "";
  switch (code) {
    // A-3: the plan lost `ai` while the request was queued.
    case "plan_limit":
      return m.error_plan_limit_feature({ feature: planFeatureLabel("ai") });
    case "disabled":
      return m.ai_error_disabled();
    case "forbidden":
      return m.ai_error_forbidden();
    case "input_too_large":
    case "provider_context_exceeded":
      return m.ai_error_input_too_large();
    case "output_truncated":
      return m.ai_error_output_truncated();
    case "refused_by_model":
      return m.ai_error_refused_by_model();
    // The model answered, but not with something the task could use (after one corrective retry).
    case "invalid_output":
    case "empty_output":
    case "invalid_result":
    case "result_too_large":
      return m.ai_error_invalid_output();
    case "no_sources":
      return m.ai_error_no_sources();
    case "workspace_unavailable":
      return m.ai_error_workspace_unavailable();
    case "no_asker":
      return m.ai_error_no_asker();
    case "subject_gone":
    case "erased":
      return m.ai_error_subject_gone();
    case "stale":
    case "timeout":
    case "provider_timeout":
      return m.ai_error_timeout();
    case "provider_rate_limited":
    case "provider_quota":
      return m.ai_error_provider_busy();
    default:
      return code.startsWith("provider_") ? m.ai_error_provider() : m.ai_error_generic();
  }
}

/** Whether starting again could give a different outcome (not for a refusal about the subject). */
export function isAiRetryable(request: Pick<AiRequest, "errorCode">): boolean {
  const code = request.errorCode ?? "";
  return ![
    "no_asker",
    "no_sources",
    "subject_gone",
    "erased",
    "forbidden",
    "disabled",
    "workspace_unavailable",
    // A-3: refused again until the plan includes `ai`.
    "plan_limit",
  ].includes(code);
}

/** Tokens used this month as a share of the budget, 0–100 (for the meter's text). */
export function aiUsagePercent(usage: AiStatus["usage"]): number {
  if (usage.budget <= 0) return 100;
  const used = usage.inputTokens + usage.outputTokens;
  return Math.min(100, Math.round((used / usage.budget) * 100));
}
