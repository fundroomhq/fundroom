# @fundroom/ai-openai-compatible

`ModelPort` over the OpenAI Chat Completions protocol: the **self-hosted model adapter**
for Ollama, vLLM, llama.cpp `llama-server` and LM Studio, which also works with hosted OpenAI-compatible
APIs. Plain `fetch` through the injected, SSRF-guarded `deps.fetch`; runtime dependency `@fundroom/ports`
only. Operations: [`docs/runbooks/ai-assist.md`](../../../docs/runbooks/ai-assist.md).

Exports `createOpenAiCompatibleModel(deps, cfg)`, the types `OpenAiCompatibleConfig`, `OpenAiJsonMode` and
`OpenAiTokenParam`, and the pure pieces it is built from (`chatCompletionsUrl`, `buildChatBody`,
`parseChatResponse`, `mapError`, `openAiCompatibleInfo`, `openAiCompatibleRetention`,
`OPENAI_COMPATIBLE_PURPOSE`, `OPENAI_COMPATIBLE_DATA_PROCESSED`). `cfg` is `{ baseUrl, apiKey, model, hosting, label, location, jurisdiction,
jsonMode, tokenParam, timeoutMs }`, filled from the `AI_*` keys by `apps/server/src/ai/wiring.ts`.

- **The wire.** `POST {base}/v1/chat/completions` (a base already ending in `/v1` is not doubled). The system
  prompt is the first message; `temperature: 0.2`; the output cap goes in `max_tokens` or
  `max_completion_tokens` (`AI_TOKEN_PARAM`: Ollama and llama.cpp only read `max_tokens`, OpenAI's reasoning
  models only the other). `Authorization: Bearer` only when a key is configured.
- **JSON.** `AI_JSON_MODE`: `json_schema` (default) sends
  `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}`, which all four
  servers enforce (the local ones ignore `name`/`strict`); `json_object` asks only for valid JSON;
  `prompt` sends no `response_format`; both of the latter append the schema to the system prompt (OpenAI
  requires the word JSON in the messages for `json_object`). The kernel validates
  the result either way.
- **Privacy.** `store: false` is sent when hosting is `third_party`. No training opt-in is ever sent. Prompt
  and response text are never logged.
- **Result.** `choices[0].message.content` (an array of parts is joined); `message.refusal` → finish `refusal`; `finish_reason` `stop` →
  `stop`, `length` → `length`, `content_filter` → `filtered`, anything else → `stop`. Usage from `prompt_tokens` /
  `completion_tokens`, 0 when the server leaves them out. Code fences and `<think>` blocks are left for the
  kernel to strip.
- **Errors** (`ModelProviderError`). Error bodies are parsed loosely (`error.code` may be a string, a number
  or null; a proxy may answer HTML). 400/422 → `bad_request`, or `context_exceeded` when the code or
  message says the context is exceeded; 401/403 → `auth`; 402 → `quota`; 404 → `not_found` (model not
  pulled); 413 → `context_exceeded`; 429 → `rate_limited`, retryable, honouring `retry-after-ms` /
  `retry-after`, except the quota and spend-limit codes (`insufficient_quota`, …) → `quota`, not
  retryable; 408, 409 and 5xx, including llama.cpp's 503 while a model loads → `unavailable`, retryable;
  a redirect → `unavailable`, not followed; a network error → `unavailable`, retryable; abort or the
  deadline → `timeout`. A retryable error is retried **once**, never more, and only when the server's
  `retry-after` is at most 10 s; one `timeoutMs` deadline covers both attempts. The shared plumbing is in
  `src/transport.ts` (the Anthropic adapter carries an identical copy).
- **Info** (`openAiCompatibleInfo`, `openAiCompatibleRetention`). `hosting` is the effective hosting from
  config. `trainsOnInputs` is `false` when `self_hosted` and `null` ("not stated") when `third_party`: the
  software cannot know a hosted provider's terms. `self_hosted`: no sub-processor; the retention sentence
  says prompts and answers are not sent to an outside AI provider. `third_party`: `subProcessor` is `{name: AI_PROVIDER_LABEL, purpose: "AI assist
  (workspaces that turn it on)", dataProcessed, location, jurisdiction}` (location "Not stated by the host"
  and jurisdiction `varies` when unset), and the retention sentence says the provider keeps inputs and
  outputs under its own API terms, that FundRoom asks it not to store completions and never opts in to
  training.

**Server notes.** Ollama serves the context it is configured with (`OLLAMA_CONTEXT_LENGTH`; 4k by default on
smaller GPUs) and silently truncates longer prompts, which is why the runbook insists on setting it. vLLM
refuses over-long prompts with a 400. llama.cpp answers 503 while loading. LM Studio is covered by the same
contract suite but was not checked against its source.
