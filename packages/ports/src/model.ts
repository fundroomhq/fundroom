import type { OutboundFetch } from "./http.js";
import type { Jurisdiction, SubProcessorMeta } from "./residency.js";

/**
 * The AI model port (EXECUTION_PLAN §15 E3.12, ADR-0060). Adapters:
 * `@fundroom/ai-openai-compatible` (Ollama, vLLM, llama.cpp server, LM Studio, or a hosted
 * OpenAI-compatible API) and `@fundroom/ai-anthropic`. The kernel `@fundroom/ai` owns provider
 * selection, settings, budgets and the request lifecycle; an adapter only turns one prompt into
 * one completion.
 *
 * Adapters retry ONCE internally on a retryable error (honouring retry-after up to 10 s), never
 * more; they never log prompt or response text and never send a training opt-in. Model calls are
 * network-bound and slow: never call an adapter while holding a database transaction.
 */

export type ModelHosting = "self_hosted" | "third_party";

export interface ModelProviderInfo {
  readonly id: "openai-compatible" | "anthropic" | "fake";
  /** "Ollama at ollama:11434" / "Anthropic" / AI_PROVIDER_LABEL. */
  readonly label: string;
  readonly model: string;
  readonly hosting: ModelHosting;
  /** Human text; null = the operator's own infrastructure. */
  readonly location: string | null;
  readonly jurisdiction: Jurisdiction | "varies" | null;
  /**
   * Whether the provider trains on what it is sent: `false` = known not to (operator-run, or a
   * vendor whose API terms say so — Anthropic); `null` = not stated (a third-party
   * OpenAI-compatible host: the software cannot know its terms). Never `true`: FundRoom itself
   * never trains or fine-tunes on tenant data and never sends a training opt-in.
   */
  readonly trainsOnInputs: false | null;
  /** One English sentence of API facts; the web localises the frame around it, not this text. */
  readonly retention: string;
  /** null = operator-run; absent = a test double. */
  readonly subProcessor?: SubProcessorMeta | null;
}

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * A JSON schema for structured output. Portable subset: `additionalProperties: false`, every
 * property required, no min/max/pattern keywords.
 */
export interface ModelJsonSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly system: string;
  /** Must end with a user message. */
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly json?: ModelJsonSchema;
  readonly signal?: AbortSignal;
}

export type ModelFinish = "stop" | "length" | "refusal" | "filtered";

export interface ModelResult {
  /** Joined text blocks; code fences and `<think>` blocks are NOT stripped here. */
  readonly text: string;
  readonly finish: ModelFinish;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** As reported by the server. */
  readonly model: string;
}

export const MODEL_ERROR_CODES = [
  "unavailable",
  "rate_limited",
  "auth",
  "quota",
  "bad_request",
  "not_found",
  "timeout",
  "context_exceeded",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

/** A provider-side failure. The message never carries prompt or response text. */
export class ModelProviderError extends Error {
  override readonly name = "ModelProviderError";
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface ModelPort {
  readonly info: ModelProviderInfo;
  generate(req: ModelRequest): Promise<ModelResult>;
}

/** What the composition root hands a model adapter factory. */
export interface ModelAdapterDeps {
  /** A guarded outbound fetch (operator-named host allowed, no redirects). */
  readonly fetch: OutboundFetch;
  readonly now: () => Date;
  /** Structured events only (codes, statuses, timings) — never prompt or response text. */
  readonly log?: (e: Record<string, unknown>) => void;
}
