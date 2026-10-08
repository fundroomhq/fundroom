# @fundroom/ai

The kernel side of AI assist: which model the install uses, each workspace's opt-in and
provider acknowledgement, budgets and rate limits, the `core.ai_request` table, the one `ai.run` job, the
hourly retention sweep and erasure. Modules own the prompts: they register **AI tasks** in their manifest
and start requests through `ModuleServices.ai`. Operations:
[`docs/runbooks/ai-assist.md`](../../docs/runbooks/ai-assist.md).

**AI never writes tenant content.** A task's result is a *suggestion* stored on its request row and shown
only to the staff member who asked for it. Applying it goes through the module's normal write paths (an
update draft save, a Q&A answer save), under that staff member's name.

## Pieces

- **`ModelPort`** (`@fundroom/ports`, `model.ts`) — `generate({system, messages, maxOutputTokens, json?,
  signal?})` → `{text, finish, usage, model}`, plus `info` (`id`, `label`, `model`, `hosting`, `location`,
  `jurisdiction`, `trainsOnInputs`, `retention`, `subProcessor`). `trainsOnInputs` is `false` where it is
  known that the provider does not train (a self-hosted server; Anthropic) and `null` where the software
  cannot know (a third-party OpenAI-compatible host); never `true`. Two adapters implement the port:
  [`@fundroom/ai-openai-compatible`](../adapters/ai-openai-compatible/README.md) (Ollama, vLLM,
  llama.cpp, LM Studio, hosted OpenAI-compatible APIs) and
  [`@fundroom/ai-anthropic`](../adapters/ai-anthropic/README.md). The server picks one from `AI_PROVIDER`
  (`createAiModel` in `apps/server/src/ai/wiring.ts`, which also builds the guarded outbound client and,
  without `AI_PROVIDER_LABEL`, labels an OpenAI-compatible server `Self-hosted model at <host[:port]>`).
  `none` means no port: every start answers `409 ai_unavailable`, and `GET /ai/status` answers 200 with
  `available: false`.
- **`aiProviderKey(info)`** — `JSON.stringify([id, hosting, label, model, location, jurisdiction])` (over 400
  characters: `id|hosting|sha256:<hex>`). A workspace's acknowledgement stores it; a feature is effectively
  on only while it matches the current provider (`acknowledged`, `effectiveAiFeatures` — residency uses the
  same helper), so any change to those facts turns AI off everywhere until an `ai.manage` holder
  acknowledges again.
- **The reservation** — `aiRequestReservation(env)` from `@fundroom/config`:
  `2 × AI_MAX_INPUT_CHARS + 3 × AI_MAX_OUTPUT_TOKENS` tokens (132 000 at the defaults), one request's worst
  case including the corrective turn. It is also the minimum monthly budget (config rule, `PUT
  /ai/settings`, `usage.minimumBudget`, `usage.budgetBelowMinimum`).
- **The kernel** (`createAiKernel`, `src/kernel.ts`) — `services` (`AiServices`: `start`,
  `discardForSubject`, `discardCiting`; this is `ModuleServices.ai` and `Container.ai`), `status`,
  `updateSettings`, `getRequest`, `deleteRequest` (behind `GET /ai/status`, `PUT /ai/settings`, `GET|DELETE
  /ai/requests/{id}`, via `Container.aiKernel`), `run`, `sweep` and the job definitions. Start errors are
  `AiKernelStartError` (an `AiStartError` carrying `retryAfterMs`), which the API error handler turns into
  409/429 with `Retry-After`; a budget above the operator cap or below the reservation is `AiSettingsError`
  (400 `validation_failed`, `details.max` / `details.min`) unless it equals the stored value.
- **`./testing`** — `createFakeModel(options?)` (a scripted `ModelPort` that records `calls`; every test
  uses it instead of a real model) and `describeModelPortContract(name, setup, options?)`, the shared suite
  each adapter runs.

## Tasks (the module seam)


```ts
// in a module manifest (packages/module-kit)
aiTasks: (services) => [{
  feature: "update_draft",              // AiFeature: update_draft | qa_answer
  permission: "updates.manage",         // needed to start AND to read the result
  paramsSchema,                         // validated by the module route, again by the job
  prepare: async (ctx, input) => ({ kind: "prompt", system, user, json }) /* or { kind: "refused", code } */,
  finish: async (ctx, input, prompt, { json, text }) => ({ kind: "result", result }) /* or refused */,
}],
```

`prepare` and `finish` run **outside any transaction**, with the requester's staff tenant context.
`prepare` builds the prompt from the module's own data and does the module's own access checks; it must keep `system + user` within `input.maxInputChars`
(`AI_MAX_INPUT_CHARS`). Untrusted text (documents, questions, notes) goes inside delimiters that the system
prompt declares to be data. `finish` validates the model's JSON and returns what is stored. Modules never
import each other: context from another module comes through `aiContextProviders` (the metrics module's
`kpis` provider feeds `update_draft`).

## Lifecycle

**In flight** = `queued` or `running`, or `cancelled` while its model call is still under way (`started_at`
set, `finished_at` null). An in-flight request holds a slot (4 per workspace) and one reservation.

**`start`** (called from a module route, outside a transaction): params sanitised (lone surrogates, NUL…) →
provider available and task registered → feature effectively on (settings read from the workspace row, not
the resolver cache; a budget below the reservation reads as off → `ai_disabled`, reason
`budget_below_minimum`) → without locks: reuse the caller's in-flight request for the same (feature, subject,
requester, params), even if their hourly limit is spent; else refuse on the per-user limit (peek), then
busy/budget → atomic per-user hit → one transaction under an advisory lock per workspace: reuse again; refuse
if the requester is being erased (`ai_disabled`); `ai_busy` at 4 in flight; `ai_budget_exhausted` when
`used + reservation > budget`; `ai_busy` when only the other in-flight reservations tip it over; insert the
row; audit `ai.request_started`; enqueue `ai.run` in the same transaction.

**`ai.run`** (no retries): claim the row (`queued` → `running`) → re-check the workspace is active
(`refused workspace_unavailable`), the feature (fresh settings), the task's module enablement and the
requester's permission (`refused disabled|forbidden`), re-validate params (`failed invalid_params`) →
`task.prepare` → size check (`refused input_too_large`) → the process-wide `AI_CONCURRENCY` semaphore → re-check
"still running and workspace active" (else the model is not called) → the model call, output capped at
`AI_MAX_OUTPUT_TOKENS` → strip code fences and `<think>` blocks, parse JSON (prose around one object is
tolerated), one corrective turn on invalid JSON after the same re-check (`failed invalid_output` after it) →
`task.finish` → the result sanitised (lone surrogates, NUL, U+FFFE/FFFF dropped; non-finite numbers → null;
must be a plain object ≤ 256 KiB) → settle. Other failure codes: `output_truncated`, `refused_by_model`,
`provider_<code>`, `timeout` (the job was aborted), `internal`. The job never audits and never locks the
workspace row. Nothing it logs contains prompt or response text.

**Settle and charge.** One short transaction locks the row `FOR UPDATE` and, only while the job still owns it
(running, or cancelled while running and not yet settled), writes the outcome and charges the month's usage:
the reported tokens, or for a failed model call its prompt characters as input tokens. A row cancelled or
discarded meanwhile gets its result dropped (`discarded` and `sources_changed` rows are deleted). A row the
sweep already failed is not charged again; a settle that fails rolls its charge back.

**`ai.retention`** (hourly, per workspace, rows claimed `FOR UPDATE SKIP LOCKED`): deletes rows past
`expires_at` (`AI_RESULT_RETENTION_HOURS`) once out of flight; fails `stale` a running request past the job
expiry (2 × `AI_TIMEOUT_MS` + 60 s) plus 60 s, or a queued one unclaimed for max(1 h, job expiry), charging a
crashed call half a reservation (may overcharge, never undercharges); settles orphaned cancelled rows.

**Discards** all go through one path (`AiRequestRepo.discardWhere`): a queued-unclaimed or settled row is
deleted; a row whose call is under way becomes `cancelled`, params and result cleared at once, and is deleted
when the call settles. The requester's `DELETE` and member erasure (`deleteAiRequestsOfMember`, called by the
compliance identity step) mark it `discarded` (404 at once); `discardForSubject(tx, …)` (a question erased,
binned or purged) and `discardCiting(tx, ctx, documentId)` (a cited document binned or purged; also every
in-flight `qa_answer` of the workspace) mark it `sources_changed` (readable as `cancelled` until settled, then
404). Both run inside the caller's transaction.

**Settings**: a write that leaves a feature off cancels that workspace's queued and running requests of it
in the same transaction (running ones keep their slot until the call settles); audited `ai.settings_updated`
with before, after and the cancelled count.

## Tables


`core.ai_request` (one row per request: feature, subject, requester, status, params, result, error code,
provider key, model, token counts, expiry) and `core.ai_usage_monthly` (tokens and requests per workspace per
UTC month). Both are tenant-fenced with row-level security and skipped by workspace export (transient and
instance-local); the workspace's `ai` settings block travels with the export.
