import type {
  Jurisdiction,
  ModelAdapterDeps,
  ModelFinish,
  ModelHosting,
  ModelPort,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  SubProcessorMeta,
} from "@fundroom/ports";
import { ModelProviderError } from "@fundroom/ports";
import {
  errorBody,
  httpError,
  isRecord,
  retryAfterMs,
  token,
  transportError,
  withOneRetry,
} from "./transport.js";

/*
 * `@fundroom/ai-openai-compatible` (E3.12, ADR-0060): the self-hosted model adapter — Ollama,
 * vLLM, llama.cpp server, LM Studio — or a hosted OpenAI-compatible API. Plain
 * `POST {base}/v1/chat/completions` through the guarded outbound client (vendors file §2).
 *
 * - The system prompt is the first message; `temperature: 0.2`; the output cap goes in
 *   `max_tokens` (Ollama/llama.cpp/vLLM) or `max_completion_tokens` (OpenAI reasoning models).
 * - JSON: `json_schema` sends the OpenAI nested `response_format` (local servers read
 *   `json_schema.schema` and enforce it with a grammar); `json_object` and `prompt` append the
 *   schema to the system prompt (`json_object` also asks for a JSON object — OpenAI requires the
 *   word JSON in the messages for it).
 * - `store: false` only to a third-party host (local servers ignore unknown fields, but nothing is
 *   sent that a self-hosted server does not need); an `Authorization: Bearer` header only when a
 *   key is configured. No training opt-in is ever sent.
 * - Errors are parsed defensively (`error.code` may be a string, a number or null; the body may
 *   be HTML) — see `mapError`. Nothing logs prompt or response text.
 */

export type OpenAiJsonMode = "json_schema" | "json_object" | "prompt";
export type OpenAiTokenParam = "max_tokens" | "max_completion_tokens";

export interface OpenAiCompatibleConfig {
  /** `AI_BASE_URL`, with or without a trailing `/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string;
  readonly hosting: ModelHosting;
  readonly label: string;
  readonly location: string | null;
  readonly jurisdiction: Jurisdiction | "varies" | null;
  readonly jsonMode: OpenAiJsonMode;
  readonly tokenParam: OpenAiTokenParam;
  readonly timeoutMs: number;
}

export const OPENAI_COMPATIBLE_PURPOSE = "AI assist (workspaces that turn it on)";
export const OPENAI_COMPATIBLE_DATA_PROCESSED =
  "Prompts built from workspace content: update text, KPI values, data-room passages, investor questions";

const TEMPERATURE = 0.2;

/** 429 codes that mean quota/billing, not "too fast" (vendors §2.4): never retried. */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
]);

const CONTEXT_MESSAGE =
  /context length|context window|maximum context|context_length|too many tokens|prompt is too long|exceeds the (?:available )?context/iu;

/** `{base}/v1/chat/completions`, accepting a base with or without `/v1` and trailing slashes. */
export function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  url.pathname = `${path}/v1/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** The retention sentence shown on the settings page and in the privacy notice. */
export function openAiCompatibleRetention(hosting: ModelHosting, label: string): string {
  return hosting === "self_hosted"
    ? "The model runs on infrastructure your host operates, so prompts and answers are not sent to an outside AI provider."
    : `${label} keeps API inputs and outputs under its own API terms; FundRoom asks it not to store completions (store: false) and never opts in to model training.`;
}

export function openAiCompatibleInfo(cfg: OpenAiCompatibleConfig): ModelProviderInfo {
  const subProcessor: SubProcessorMeta | null =
    cfg.hosting === "self_hosted"
      ? null
      : {
          name: cfg.label,
          purpose: OPENAI_COMPATIBLE_PURPOSE,
          dataProcessed: OPENAI_COMPATIBLE_DATA_PROCESSED,
          location: cfg.location ?? "Not stated by the host",
          jurisdiction: cfg.jurisdiction ?? "varies",
        };
  return {
    id: "openai-compatible",
    label: cfg.label,
    model: cfg.model,
    hosting: cfg.hosting,
    location: cfg.location,
    jurisdiction: cfg.jurisdiction,
    // Operator-run: nothing leaves. A third-party host's terms are unknown to the software.
    trainsOnInputs: cfg.hosting === "self_hosted" ? false : null,
    retention: openAiCompatibleRetention(cfg.hosting, cfg.label),
    subProcessor,
  };
}

/** A-Z a-z 0-9 _ - , at most 64 (OpenAI's rule for `json_schema.name`). */
function schemaName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  return clean === "" ? "result" : clean;
}

export function buildChatBody(
  cfg: OpenAiCompatibleConfig,
  req: ModelRequest,
): Record<string, unknown> {
  let system = req.system;
  let responseFormat: Record<string, unknown> | undefined;
  if (req.json !== undefined) {
    if (cfg.jsonMode === "json_schema") {
      responseFormat = {
        type: "json_schema",
        json_schema: { name: schemaName(req.json.name), schema: req.json.schema, strict: true },
      };
    } else {
      if (cfg.jsonMode === "json_object") responseFormat = { type: "json_object" };
      system = `${system}\n\nRespond only with a JSON object that matches this JSON schema:\n${JSON.stringify(req.json.schema)}`;
    }
  }
  return {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    temperature: TEMPERATURE,
    [cfg.tokenParam]: req.maxOutputTokens,
    stream: false,
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(cfg.hosting === "third_party" ? { store: false } : {}),
  };
}

function finishOf(reason: unknown, refusal: boolean): ModelFinish {
  if (refusal) return "refusal";
  switch (reason) {
    case "length":
      return "length";
    case "content_filter":
      return "filtered";
    default:
      // `stop`, and anything else a compatible server invents (tool_calls cannot happen: no
      // tools are sent).
      return "stop";
  }
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  // Some servers answer with content parts.
  if (Array.isArray(content)) {
    return content
      .map((p) => (isRecord(p) && typeof p["text"] === "string" ? p["text"] : ""))
      .join("");
  }
  return "";
}

export function parseChatResponse(body: unknown, fallbackModel: string): ModelResult {
  const choice = isRecord(body) && Array.isArray(body["choices"]) ? body["choices"][0] : undefined;
  const message = isRecord(choice) ? choice["message"] : undefined;
  if (!isRecord(choice) || !isRecord(message)) {
    throw new ModelProviderError("unavailable", "the model server's answer has no choices", false);
  }
  const refusal = typeof message["refusal"] === "string" && message["refusal"] !== "";
  const usage = isRecord(body) && isRecord(body["usage"]) ? body["usage"] : {};
  const model = isRecord(body) && typeof body["model"] === "string" ? body["model"] : "";
  return {
    text: contentText(message["content"]),
    finish: finishOf(choice["finish_reason"], refusal),
    usage: {
      inputTokens: count(usage["prompt_tokens"]),
      outputTokens: count(usage["completion_tokens"]),
    },
    model: model === "" ? fallbackModel : model,
  };
}

/** A non-2xx answer as a port error (vendors §2.4). */
export function mapError(status: number, body: unknown, headers: Headers, now: Date) {
  const error = isRecord(body) ? body["error"] : undefined;
  const type = isRecord(error) ? token(error["type"]) : undefined;
  const code = isRecord(error) ? token(error["code"]) : undefined;
  const message = isRecord(error)
    ? typeof error["message"] === "string"
      ? error["message"]
      : ""
    : typeof error === "string"
      ? error
      : "";
  const detail = [type, code].filter((x) => x !== undefined).join("/") || undefined;
  const contextExceeded = code === "context_length_exceeded" || CONTEXT_MESSAGE.test(message);
  if (status >= 300 && status < 400) {
    return httpError("unavailable", status, "redirect refused", false);
  }
  switch (status) {
    case 400:
    case 422:
      return httpError(contextExceeded ? "context_exceeded" : "bad_request", status, detail, false);
    case 401:
    case 403:
      return httpError("auth", status, detail, false);
    case 402:
      return httpError("quota", status, detail, false);
    case 404:
      return httpError("not_found", status, detail, false);
    case 413:
      return httpError("context_exceeded", status, detail, false);
    case 429: {
      if (
        (code !== undefined && QUOTA_CODES.has(code)) ||
        (type !== undefined && QUOTA_CODES.has(type))
      ) {
        return httpError("quota", status, detail, false);
      }
      return httpError("rate_limited", status, detail, true, retryAfterMs(headers, now));
    }
    default:
      if (status === 408 || status === 409 || status >= 500) {
        return httpError("unavailable", status, detail, true, retryAfterMs(headers, now));
      }
      return httpError("bad_request", status, detail, false);
  }
}

export function createOpenAiCompatibleModel(
  deps: ModelAdapterDeps,
  cfg: OpenAiCompatibleConfig,
): ModelPort {
  const url = chatCompletionsUrl(cfg.baseUrl);
  const log = deps.log ?? (() => {});
  const info = openAiCompatibleInfo(cfg);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...(cfg.apiKey === null || cfg.apiKey === "" ? {} : { authorization: `Bearer ${cfg.apiKey}` }),
  };

  return {
    info,
    async generate(req) {
      const body = JSON.stringify(buildChatBody(cfg, req));
      return withOneRetry(
        { provider: info.id, timeoutMs: cfg.timeoutMs, log, callerSignal: req.signal },
        async (signal, attempt) => {
          const started = Date.now();
          let response: Response;
          try {
            response = await deps.fetch(url, {
              method: "POST",
              headers,
              body,
              redirect: "manual",
              signal,
            });
          } catch (e) {
            const err = transportError(e);
            log({ event: "ai.model_call_failed", provider: info.id, attempt, code: err.code });
            throw err;
          }
          const requestId = token(response.headers.get("x-request-id") ?? undefined);
          const status = response.status;
          if (status < 200 || status > 299) {
            const err = mapError(status, await errorBody(response), response.headers, deps.now());
            log({
              event: "ai.model_call_failed",
              provider: info.id,
              attempt,
              status,
              code: err.code,
              ...(requestId === undefined ? {} : { requestId }),
            });
            throw err;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(await response.text());
          } catch (e) {
            if (e instanceof SyntaxError) {
              throw new ModelProviderError(
                "unavailable",
                "the model server's answer is not JSON",
                false,
              );
            }
            throw e;
          }
          const result = parseChatResponse(parsed, cfg.model);
          log({
            event: "ai.model_call",
            provider: info.id,
            attempt,
            status,
            ms: Date.now() - started,
            finish: result.finish,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(requestId === undefined ? {} : { requestId }),
          });
          return result;
        },
      );
    },
  };
}
