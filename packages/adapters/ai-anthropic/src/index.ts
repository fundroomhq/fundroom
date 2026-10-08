import {
  type ModelAdapterDeps,
  type ModelFinish,
  type ModelPort,
  ModelProviderError,
  type ModelProviderInfo,
  type ModelRequest,
  type ModelResult,
  type SubProcessorMeta,
} from "@fundroom/ports";
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
 * `@fundroom/ai-anthropic` (E3.12, ADR-0060): the Anthropic Messages API, plain
 * `POST {base}/v1/messages` through the guarded outbound client — no SDK: the wire is small and
 * the retry/timeout rules are ours (vendors file §1).
 *
 * - Headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`. `system` is top level;
 *   messages pass through (they end with a user turn — no prefill).
 * - NO `temperature`/`top_p`/`thinking`: current models answer 400 to them. JSON goes in
 *   `output_config.format` (GA structured outputs).
 * - Only `text` content blocks are joined (thinking blocks are skipped).
 * - Errors per vendors §1.5; a 429 carrying `enforced_spend_limit_reached` is a spend cap →
 *   `quota`, never retried. Nothing logs prompt or response text; the `request-id` is logged.
 */

export interface AnthropicConfig {
  /** `AI_BASE_URL` or https://api.anthropic.com. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export const ANTHROPIC_VERSION = "2023-06-01";

export const ANTHROPIC_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Anthropic",
  purpose: "AI assist (workspaces that turn it on)",
  dataProcessed:
    "Prompts built from workspace content: update text, KPI values, data-room passages, investor questions",
  location: "United States",
  jurisdiction: "us",
};

/** API facts (vendors §1.8); the web localises the frame around it, not this text. */
export const ANTHROPIC_RETENTION =
  "Anthropic deletes API inputs and outputs within 30 days and does not use them to train models, except content its trust-and-safety systems flag or that the law requires it to keep.";

const CONTEXT_MESSAGE = /prompt is too long|context window|context length|too many tokens/iu;
const SPEND_LIMIT_MESSAGE = /usage limits|spend limit|credit balance/iu;

/** `{base}/v1/messages`, accepting a base with or without `/v1` and trailing slashes. */
export function messagesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  url.pathname = `${path}/v1/messages`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function anthropicInfo(cfg: Pick<AnthropicConfig, "model">): ModelProviderInfo {
  return {
    id: "anthropic",
    label: "Anthropic",
    model: cfg.model,
    hosting: "third_party",
    location: ANTHROPIC_SUB_PROCESSOR.location,
    jurisdiction: "us",
    trainsOnInputs: false,
    retention: ANTHROPIC_RETENTION,
    subProcessor: ANTHROPIC_SUB_PROCESSOR,
  };
}

export function buildMessagesBody(model: string, req: ModelRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(req.json === undefined
      ? {}
      : { output_config: { format: { type: "json_schema", schema: req.json.schema } } }),
  };
}

function finishOf(reason: unknown): ModelFinish {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      // end_turn, stop_sequence; tool_use/pause_turn cannot happen (no tools are sent).
      return "stop";
  }
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

export function parseMessagesResponse(body: unknown, fallbackModel: string): ModelResult {
  if (!isRecord(body) || !Array.isArray(body["content"])) {
    throw new ModelProviderError("unavailable", "the model server's answer has no content", false);
  }
  const text = body["content"]
    .map((b) =>
      isRecord(b) && b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "",
    )
    .join("");
  const usage = isRecord(body["usage"]) ? body["usage"] : {};
  const model =
    typeof body["model"] === "string" && body["model"] !== "" ? body["model"] : fallbackModel;
  return {
    text,
    finish: finishOf(body["stop_reason"]),
    usage: {
      inputTokens:
        count(usage["input_tokens"]) +
        count(usage["cache_creation_input_tokens"]) +
        count(usage["cache_read_input_tokens"]),
      outputTokens: count(usage["output_tokens"]),
    },
    model,
  };
}

/** A non-2xx answer as a port error (vendors §1.5). */
export function mapError(status: number, body: unknown, headers: Headers, now: Date) {
  const error = isRecord(body) ? body["error"] : undefined;
  const type = isRecord(error) ? token(error["type"]) : undefined;
  const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "";
  const details = isRecord(error) && isRecord(error["details"]) ? error["details"] : undefined;
  const detailCode = details === undefined ? undefined : token(details["error_code"]);
  const detail = [type, detailCode].filter((x) => x !== undefined).join("/") || undefined;
  if (status >= 300 && status < 400) {
    return httpError("unavailable", status, "redirect refused", false);
  }
  switch (status) {
    case 400:
      if (SPEND_LIMIT_MESSAGE.test(message)) return httpError("quota", status, detail, false);
      return httpError(
        CONTEXT_MESSAGE.test(message) ? "context_exceeded" : "bad_request",
        status,
        detail,
        false,
      );
    case 401:
    case 403:
      return httpError("auth", status, detail, false);
    case 402:
      return httpError("quota", status, detail, false);
    case 404:
      return httpError("not_found", status, detail, false);
    case 413:
      return httpError("context_exceeded", status, detail, false);
    case 429:
      // A tier spend cap: no retry-after, `enforced_spend_limit_reached` — waiting does not help.
      if (detailCode === "enforced_spend_limit_reached")
        return httpError("quota", status, detail, false);
      return httpError("rate_limited", status, detail, true, retryAfterMs(headers, now));
    default:
      if (status === 408 || status === 409 || status >= 500) {
        return httpError("unavailable", status, detail, true, retryAfterMs(headers, now));
      }
      return httpError("bad_request", status, detail, false);
  }
}

export function createAnthropicModel(deps: ModelAdapterDeps, cfg: AnthropicConfig): ModelPort {
  const url = messagesUrl(cfg.baseUrl);
  const log = deps.log ?? (() => {});
  const info = anthropicInfo(cfg);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": cfg.apiKey,
  };

  return {
    info,
    async generate(req) {
      const body = JSON.stringify(buildMessagesBody(cfg.model, req));
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
          const requestId = token(response.headers.get("request-id") ?? undefined);
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
          const result = parseMessagesResponse(parsed, cfg.model);
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
