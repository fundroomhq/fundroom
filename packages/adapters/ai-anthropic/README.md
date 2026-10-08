# @fundroom/ai-anthropic

`ModelPort` over Anthropic's Messages API. Plain `fetch` through the injected,
SSRF-guarded `deps.fetch`, not the SDK: the port needs one non-streaming call, and the adapter owns its one
retry. Runtime dependency `@fundroom/ports` only. Operations:
[`docs/runbooks/ai-assist.md`](../../../docs/runbooks/ai-assist.md).

Exports `createAnthropicModel(deps, cfg)`, the type `AnthropicConfig` (`{ baseUrl, apiKey, model, timeoutMs
}`), `ANTHROPIC_SUB_PROCESSOR`, `ANTHROPIC_RETENTION`, `ANTHROPIC_VERSION`, and the pure pieces it is built
from (`messagesUrl`, `buildMessagesBody`, `parseMessagesResponse`, `mapError`, `anthropicInfo`).

- **The wire.** `POST {base}/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and
  `content-type: application/json`. Body `{model, max_tokens, system, messages}`, plus
  `output_config: {format: {type: "json_schema", schema}}` when the task gives a schema. **No `temperature`,
  `top_p` or `thinking`**: current models refuse the first two, and thinking cannot be switched off on some
  of them. Thinking tokens therefore count toward `max_tokens` and the output usage.
- **Result.** The text is every `content` block of `type: "text"`, joined (thinking blocks are skipped).
  `stop_reason` `end_turn` / `stop_sequence` → `stop`; `max_tokens` / `model_context_window_exceeded` →
  `length`; `refusal` → `refusal`. Input usage is `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens`; output is `output_tokens`.
- **Errors** (`ModelProviderError`). 400 → `bad_request`, or `quota` when the message is the user-set
  spend-limit one, or `context_exceeded` for a context-length message; 401/403 → `auth`; 402 → `quota`;
  404 → `not_found` (an unknown model, or one the organisation cannot use); 413 → `context_exceeded`; 429 →
  `rate_limited`, retryable, honouring `retry-after`, except `enforced_spend_limit_reached` → `quota`, not
  retryable; 408, 409 and 5xx (500, 504, 529) → `unavailable`, retryable; a redirect → `unavailable`, not
  followed; a network error → `unavailable`, retryable; abort or the deadline → `timeout`. A retryable
  error is retried **once**, never more, and only when `retry-after` is at most 10 s; one `timeoutMs`
  deadline covers both attempts. Error messages carry only the status and sanitised vendor type/code,
  never the vendor's message. The shared plumbing is in `src/transport.ts` (an identical copy of the
  OpenAI-compatible adapter's). Log events (`ai.model_call`, `ai.model_call_failed`, `ai.model_retry`)
  may carry the `request-id`; prompt, response text and the key never appear.
- **Info.** Always `third_party`, with `trainsOnInputs: false`: label "Anthropic", location "United
  States", jurisdiction `us`, `subProcessor` `ANTHROPIC_SUB_PROCESSOR`. The retention sentence
  (`ANTHROPIC_RETENTION`): Anthropic deletes API inputs and outputs within 30 days and does not use them to
  train models, except content its trust-and-safety systems flag or that the law requires it to keep.

**Config.** `AI_BASE_URL` defaults to `https://api.anthropic.com` and must stay that in production (it is a
test seam). `AI_MODEL` is free text (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, …). Fable
models require 30-day retention and are refused under zero data retention.
