import type { FundRoomSchemas } from "@fundroom/sdk";

/*
 * AI assist fixtures (E3.12), shaped exactly like `packages/contracts/src/ai.ts` (`AiStatus`,
 * `AiRequest`, the two result kinds) so a contract change breaks these tests at typecheck.
 */
export type AiStatus = FundRoomSchemas["AiStatus"];
export type AiRequest = FundRoomSchemas["AiRequest"];

export const AI_REQUEST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a01";
export const AI_ACK_MEMBERSHIP = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a02";

export const SELF_HOSTED: FundRoomSchemas["AiProviderInfo"] = {
  id: "openai-compatible",
  label: "Ollama at ollama:11434",
  model: "qwen3.5:9b",
  hosting: "self_hosted",
  location: null,
  jurisdiction: null,
  trainsOnInputs: false,
  retention: "Prompts are processed on the operator's own server and not stored by the model.",
};

export const THIRD_PARTY: FundRoomSchemas["AiProviderInfo"] = {
  id: "anthropic",
  label: "Anthropic",
  model: "claude-sonnet-4-5",
  hosting: "third_party",
  location: "United States",
  jurisdiction: "us",
  trainsOnInputs: false,
  retention: "Anthropic deletes API inputs and outputs within 30 days.",
};

export function aiStatus(over: Partial<AiStatus> = {}): AiStatus {
  return {
    available: true,
    provider: SELF_HOSTED,
    settings: {
      enabled: false,
      features: { updateDraft: false, qaAnswer: false },
      monthlyTokenBudget: null,
      acknowledgement: null,
    },
    needsAcknowledgement: true,
    effective: { updateDraft: false, qaAnswer: false },
    planAllows: true,
    usage: {
      month: "2026-09",
      inputTokens: 150_000,
      outputTokens: 50_000,
      requests: 12,
      budget: 2_000_000,
      minimumBudget: 132_000,
      budgetBelowMinimum: false,
    },
    ...over,
  };
}

/** A workspace with both features effectively on (acknowledged for the current provider). */
export function aiOn(over: Partial<AiStatus> = {}): AiStatus {
  return aiStatus({
    settings: {
      enabled: true,
      features: { updateDraft: true, qaAnswer: true },
      monthlyTokenBudget: null,
      acknowledgement: {
        providerKey: "openai-compatible|self_hosted|Ollama at ollama:11434|qwen3.5:9b",
        hosting: "self_hosted",
        at: "2026-09-20T10:00:00.000Z",
        byMembershipId: AI_ACK_MEMBERSHIP,
      },
    },
    needsAcknowledgement: false,
    effective: { updateDraft: true, qaAnswer: true },
    ...over,
  });
}

export const AI_UNAVAILABLE: AiStatus = aiStatus({
  available: false,
  provider: null,
  needsAcknowledgement: false,
});

export function aiRequest(over: Partial<AiRequest> = {}): AiRequest {
  return {
    id: AI_REQUEST_ID,
    feature: "update_draft",
    subjectId: null,
    status: "queued",
    errorCode: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    finishedAt: null,
    result: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...over,
  };
}

/** A settings slot like the kernel `ai` manifest's. */
export const AI_SETTINGS_SLOT = {
  id: "ai",
  version: "0.1.0",
  enabled: true,
  hidden: false,
  readOnly: false,
  flags: {},
  slots: {
    "admin.settings": [
      { id: "ai", label: "AI assist", to: "/admin/settings/ai", order: 40, icon: "sparkles" },
    ],
  },
};
