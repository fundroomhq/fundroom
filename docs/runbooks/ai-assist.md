# Runbook: AI assist

AI assist drafts two things for staff: an investor update (from the workspace's KPIs, its last sent update and
the author's notes), and an answer to an investor's data-room question (from the documents that investor can
view, with page citations). This runbook is for whoever runs the install: choosing and configuring a model,
what leaves the host, budgets and limits, and what each error code means.

Reference material: `packages/ai` (the kernel
service, the `ai.run` job and the retention sweep), `packages/adapters/ai-openai-compatible`,
`packages/adapters/ai-anthropic`, `modules/updates/src/ai/` and `modules/data-room/src/qa/ai/`.

## The model

- **AI never writes tenant content.** Every request produces a *suggestion*, stored on a `core.ai_request`
  row and shown only to the staff member who asked for it. They read it and apply it through the normal
  editor: **Create draft** makes an ordinary update draft, **Use this text** fills the Q&A answer editor. An
  answer saved that way is authored by that staff member, so four-eyes approval still applies. Nothing
  AI-generated reaches an investor without a staff save and the existing publish or release step.
- **You provide the model; each workspace opts in.** One provider per install, set by environment
  (`AI_PROVIDER`). The default is `none`: the feature does not exist anywhere, every start answers
  `409 ai_unavailable`, and `GET /ai/status` answers `200` with `available: false`.
- **Off by default in every workspace.** An owner or admin (`ai.manage`) turns it on under **Settings → AI
  assist**, feature by feature (update drafts, Q&A answers), and must **acknowledge the provider**: its name,
  model, location and whether it runs on your infrastructure or a third party's. The acknowledgement is
  bound to that provider. Change the provider, its hosting, label, model, location or jurisdiction and every
  workspace's AI turns itself off until someone with `ai.manage` acknowledges again (see
  [Changing the provider](#changing-the-provider)).
- **No training by FundRoom.** FundRoom never trains or fine-tunes a model, the adapters send no training
  opt-in, and the OpenAI-compatible adapter sends `store: false` to a third-party host. Whether the
  *provider* trains is another matter: the provider info carries `trainsOnInputs`, which is `false` only
  where it is known (a self-hosted server; Anthropic) and `null` ("not stated") for a third-party
  OpenAI-compatible host, whose terms the software cannot know. The settings page and privacy notice say
  "Not used to train models" only when it is `false`.
- **Documents and questions are data, not instructions.** They are wrapped in delimiters and the system
  prompt says so; the model has no tools; its output is JSON validated on the server; Q&A answers are plain
  text; every citation is checked against the passages actually sent, and those that don't match are
  dropped; figures in an update draft that do not appear in the material are listed for the author (see
  [What the author sees](#what-the-author-sees)). None of this makes a model incapable of being misled by a document: that is why a person
  reviews every suggestion.

## What has to be true first

- **A worker running.** Suggestions are made by the `ai.run` job, and old ones are deleted by the hourly
  `ai.retention` job; see [queue-backlog.md](queue-backlog.md). With `WORKER_MODE=external`, it is the worker
  process that calls the model, so the worker needs the network route to it.
- **The CLI.** As in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app <command>` in the
  reference Compose stack. Below, `fundroom` stands for it.
- **A model that fits the prompts.** Prompts are capped at `AI_MAX_INPUT_CHARS` (default 60 000 characters,
  roughly 15 000 tokens of English) plus up to `AI_MAX_OUTPUT_TOKENS` (default 4 000) of output. The model
  server's context window must hold both. For Ollama that means setting its context length, see below.

## Choose a provider

| `AI_PROVIDER` | For | Hosting | Sub-processor |
|---|---|---|---|
| `none` (default) | AI assist off | — | — |
| `openai-compatible` | a model server you run: Ollama, vLLM, llama.cpp `llama-server`, LM Studio | `self_hosted` | none: nothing leaves your infrastructure |
| `openai-compatible` | a hosted OpenAI-compatible API (OpenAI, a regional inference provider, a gateway) | `third_party` | yes, named by `AI_PROVIDER_LABEL` |
| `anthropic` | Anthropic's API (Claude) | `third_party` | yes: Anthropic, United States |

**Hosting is decided like this.** `anthropic` is always `third_party`. For `openai-compatible`, `AI_HOSTING`
wins when set; otherwise the install looks at `AI_BASE_URL`'s host. A host that is evidently yours counts as
`self_hosted`: `localhost`, a private or link-local address (10/8, 172.16/12, 192.168/16, 169.254/16,
100.64/10, IPv6 `fc…`/`fd…`, addresses starting `fe80:`, and loopback), a single-label name (a Compose or Kubernetes service, like
`ollama`) or a name ending `.local`, `.internal`, `.lan`, `.home.arpa`, `.svc` or `.cluster.local`. Anything
else is `third_party`. Set `AI_HOSTING` explicitly when the guess is wrong: `self_hosted` for a model server
of your own on a public name, `third_party` for someone else's server on a private address (a peered VPC, a
provider's private endpoint).

What `third_party` changes:

- The acknowledgement a workspace admin must accept says that **documents leave your infrastructure**.
- The provider is listed as a **sub-processor**: deployment-wide, and in a workspace's list while that
  workspace has AI effectively on (see [residency.md](residency.md)).
- In `APP_ENV=prod` or `staging`, `AI_BASE_URL` must be `https:`, even on a private address.
- For `openai-compatible`, `AI_PROVIDER_LABEL` and `AI_PROVIDER_JURISDICTION` are required.

**`AI_HOSTING=self_hosted` is a declaration, not evidence.** Workspaces are told the model runs on your
infrastructure, no sub-processor is listed, and `store: false` is not sent. So in `prod` and `staging` plain
`http:` is refused on `AI_BASE_URL` for any host that is not evidently yours, whatever `AI_HOSTING` says.
Declaring `self_hosted` for a public host over `https:` is allowed (you may run a public server), and
`fundroom doctor` warns about it; make sure it is true.

The model server's host is let through the outbound client's private-address check (it is the one private
host AI assist may reach). Redirects are never followed, and a response is capped at 4 MiB.

## Ollama (the self-hosted quickstart)

The reference Compose file has a commented `ollama` service under its optional profiles. Uncomment it (and
its `ollama:` volume), then:

```
# .env
COMPOSE_PROFILES=ai                  # add to what is there: worker,ai
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://ollama:11434
AI_MODEL=qwen3.5:9b
```

```
docker compose up -d ollama
docker compose exec ollama ollama pull qwen3.5:9b
docker compose up -d app          # (and worker) so they read the new AI_* values
fundroom doctor 2>&1 | grep aiAssist
#   aiAssist  openai-compatible (self_hosted, qwen3.5:9b)  default
```

No API key: local Ollama ignores it. `http://ollama:11434` is a service name, so the install treats it as
`self_hosted` and nothing leaves your infrastructure. The adapter appends `/v1/chat/completions` (a base
ending in `/v1` works too).

- **Model.** `qwen3.5:9b` (Apache-2.0, about 6.6 GB at Q4) is the recommended default: good at following a
  JSON schema and multilingual, and it fits an 8–12 GB GPU or Apple Silicon. Smaller or CPU-only hosts:
  `qwen3.5:4b` or `gemma4:e4b`. More capacity: `gpt-oss:20b` (16 GB) or `qwen3.5:27b` / `gemma4:26b`. Pick
  one whose licence you are happy with; the Llama licences carry extra terms.
- **Set the context length.** Ollama serves the context it is *configured* with, not the model's native one:
  4k tokens on GPUs under 24 GiB of VRAM. It cannot be changed through the API, and **a prompt longer than
  the context is silently cut**, so the model answers from part of the material. Set
  `OLLAMA_CONTEXT_LENGTH` on the Ollama service to **16384–32768**:

  | `OLLAMA_CONTEXT_LENGTH` | Keep `AI_MAX_INPUT_CHARS` at or below | `AI_MAX_OUTPUT_TOKENS` |
  |---|---|---|
  | 32768 | 60000 (the default) | 4000 (the default) |
  | 16384 | 36000 | 3000 |

  A token is about four characters of English, fewer for other languages; leave headroom. A larger context
  costs memory on the model server, multiplied by `OLLAMA_NUM_PARALLEL`.
- **Concurrency.** Each app or worker process makes at most `AI_CONCURRENCY` (default 2) model calls at once.
  Ollama queues what it cannot run in parallel. Keep `AI_CONCURRENCY` × (processes that run jobs) close to
  `OLLAMA_NUM_PARALLEL`, or waiting calls run into `AI_TIMEOUT_MS`.
- **Speed.** A 9B model on a CPU takes minutes for an update draft. `AI_TIMEOUT_MS` defaults to 3 minutes;
  raise it (up to 15) rather than letting drafts fail with `provider_timeout`. The first call after
  `OLLAMA_KEEP_ALIVE` (default 5 minutes) of idleness also pays the time it takes to load the model.
- **GPU.** On an NVIDIA host, give the service the GPU (the commented example shows the
  `deploy.resources.reservations.devices` block) and install the NVIDIA Container Toolkit. Without it Ollama
  runs on the CPU.
- **Keep it private.** Ollama has no authentication. The example only `expose`s port 11434 on the Compose
  network: do not publish it on the host.
- **Ollama cloud models** (`*-cloud` tags, or `https://ollama.com` as the base URL) run on Ollama's hosted
  service. That is a third party: set `AI_HOSTING=third_party`, `AI_PROVIDER_LABEL`,
  `AI_PROVIDER_JURISDICTION` and an `AI_API_KEY`.

## vLLM, llama.cpp and LM Studio

All three speak the same protocol; configure them like Ollama with their own base URL.

- **vLLM** (`http://vllm:8000`). Set `--max-model-len` to hold the prompt plus output (a prompt that is too
  long is refused, not cut). With `--api-key`, set the same value in `AI_API_KEY`. Reasoning models (Qwen,
  DeepSeek-R1) need `--structured-outputs-config.enable_in_reasoning=True`, or the JSON constraint may not be
  applied; the kernel still strips `<think>…</think>` and retries once on invalid JSON.
- **llama.cpp** `llama-server` (`http://llama:8080`). Start it with a context large enough (`-c 32768`, or
  `-c 0` to take the model's). It answers `503` while a model loads; the adapter retries once, so a request
  sent during a long load fails with `provider_unavailable`. With `--api-key`, set `AI_API_KEY`.
- **LM Studio** (its server, default port 1234). Load the model with a context length large enough in LM
  Studio itself.

If the server rejects `response_format: json_schema` (older builds, some gateways), set
`AI_JSON_MODE=json_object`, or `prompt` as a last resort (the schema goes into the system prompt and the
server's output is validated like any other). If it ignores `max_tokens`, set
`AI_TOKEN_PARAM=max_completion_tokens`.

In `prod` and `staging`, plain `http:` is accepted only to a host that is evidently yours (see
[hosting](#choose-a-provider)) with `self_hosted` hosting. Use TLS for a model server across a network you
do not control.

## A hosted OpenAI-compatible API

```
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com          # or https://api.openai.com/v1
AI_API_KEY=…                                # or AI_API_KEY_FILE=/run/secrets/ai_api_key
AI_MODEL=<model id>
AI_PROVIDER_LABEL=OpenAI                    # the sub-processor's name, shown to workspaces
AI_PROVIDER_LOCATION=United States          # where it processes data, in words
AI_PROVIDER_JURISDICTION=us                 # eu | uk | ch | us | ca | au | other | varies
#AI_TOKEN_PARAM=max_completion_tokens       # OpenAI's reasoning models refuse max_tokens
```

`AI_PROVIDER_LABEL` and `AI_PROVIDER_JURISDICTION` are required: the provider becomes a sub-processor of
every workspace that turns AI on, and the residency page compares its jurisdiction with your declared
region (`varies` is never shown as in-region). The adapter sends `store: false`. The software cannot know
the provider's terms, so the settings page and privacy notice say the host has not stated whether the
provider trains on the data, and that the provider keeps inputs and outputs under its own API terms. Check
those terms (OpenAI's API, for example, does not train on inputs unless you opt in, and keeps
abuse-monitoring logs for up to 30 days) and state them, and any zero-data-retention arrangement, in your own
sub-processor list and DPA.

## Anthropic

```
AI_PROVIDER=anthropic
AI_API_KEY=…                                # or AI_API_KEY_FILE
AI_MODEL=claude-opus-5                      # or claude-sonnet-5, claude-haiku-4-5
```

`AI_BASE_URL` defaults to `https://api.anthropic.com` and must stay that in `APP_ENV=prod` (it is a test
seam). Anthropic is listed as a sub-processor in the United States. It does not train on API inputs, and
deletes inputs and outputs within 30 days by default; zero data retention is available by arrangement with
Anthropic. Two things to know:

- **Thinking counts as output.** Current models think before answering, and those tokens count against
  `AI_MAX_OUTPUT_TOKENS` and the monthly budget. If drafts fail with `output_truncated`, raise
  `AI_MAX_OUTPUT_TOKENS` (8000–16000).
- **Fable models require 30-day retention** and are refused under a zero-data-retention arrangement. Don't
  configure one if you promised tenants zero retention.

## What leaves the host

With `self_hosted` hosting, nothing leaves your infrastructure. With `third_party`, each request sends the
provider one prompt:

| Feature | Sent to the model |
|---|---|
| Update draft | the staff member's notes (up to 2 000 characters); the chosen template's section titles; the most recent sent update that went to **everyone** (audience "all"; among the last 20 sent), without its sections restricted to groups or staff: title, section titles and text, up to 12 000 characters (less when the input budget is tight, left out when under 400 characters of room remain); if the metrics module is on, up to 12 KPIs whose audience is "all" and that have a value (at most 4 000 characters), each with name, unit or currency, latest and previous period and value, and the change. Staff-only and group-only KPIs and updates never reach the model: a draft's text is read by the whole audience |
| Q&A answer | the question's subject and body; up to 8 page passages (each up to 3 500 characters), each with its document title and page number. Passages come only from current, ready versions of documents **the asking investor can view** (veiled paths and documents behind a session-bound gate such as MFA or an IP allow-list excluded, since the investor is not present to satisfy it). For a question about a **folder**, a document is used only if everyone who can see that folder can also see the document, with no extra gate and no earlier expiry, because an answer published to the folder is read by all of them (at most 32 documents are compared this way). Retrieval prefers pages that contain every term of the question and falls back to pages that contain its rarer terms. Audiences are checked when the suggestion is made, not again later |

The prompt names neither the staff member nor the investor, but the material itself can contain personal
data (a name in a document, a question that mentions someone). The model has no tools and no network access
through FundRoom; it only returns text.

**Kept on the host:** the suggestion (the `core.ai_request` row: its parameters, the result, token counts)
for `AI_RESULT_RETENTION_HOURS` (default 7 days; the hourly `ai.retention` job deletes it, so up to an hour
longer). A staff member can discard their own sooner. It is also discarded when the requesting member is
erased, and a Q&A suggestion when its question is erased, or when a document it cites, or the document or
folder its question is about, is binned or purged. A discarded request whose model call is already under way
is emptied at once (parameters and result cleared) and deleted when the call settles; its result is thrown
away. Suggestions are not included in workspace exports; the workspace's
AI settings are. The audit log records `ai.settings_updated` and `ai.request_started` (feature and subject,
never content); the job itself writes no audit rows. Adapters never log prompt or response text.

## Budgets and limits

| Limit | Key (default) | When it is hit |
|---|---|---|
| Tokens per workspace per UTC calendar month (input + output) | `AI_MONTHLY_TOKEN_BUDGET` (2 000 000) | `429 ai_budget_exhausted`, `Retry-After` until the next month. A workspace can set a lower budget on its settings page, never a higher one, and never below one reservation (below) |
| Requests one staff member may start per hour | `AI_REQUESTS_PER_USER_HOUR` (30) | `429 ai_rate_limited` with `Retry-After`. Checked before anything the workspace shares |
| Requests in flight per workspace | 4 (fixed) | `429 ai_busy` |
| Model calls in flight per process | `AI_CONCURRENCY` (2) | further calls wait their turn |
| Prompt size | `AI_MAX_INPUT_CHARS` (60 000) | the request is refused `input_too_large` (modules trim their material to fit first) |
| Output per call | `AI_MAX_OUTPUT_TOKENS` (4 000) | the request fails `output_truncated` |
| One model call | `AI_TIMEOUT_MS` (180 000) | the request fails `provider_timeout` |

**Reservations.** Every request in flight holds a reservation of its worst case until its job settles:
`2 × AI_MAX_INPUT_CHARS + 3 × AI_MAX_OUTPUT_TOKENS` tokens (132 000 with the defaults: two prompts at one
token per character, since the corrective retry resends the prompt with the first answer, plus three
outputs). A start is refused `ai_budget_exhausted` when this month's usage plus one reservation exceeds the
budget, and `ai_busy` when only the reservations of other in-flight requests tip it over (a slot frees in
minutes). The same number is the **minimum budget**: config refuses an `AI_MONTHLY_TOKEN_BUDGET` below it
while a provider is set, and `PUT /ai/settings` refuses a lower workspace budget (`400 validation_failed`,
`details.min`) unless it is the value already stored. A workspace whose stored budget is below the minimum
(for example after you raised the limits) has every feature off: the status reports
`usage.budgetBelowMinimum`, the settings page asks for a higher budget, and a start answers
`409 ai_disabled` with reason `budget_below_minimum`.

"In flight" means queued or running, including a request discarded or cancelled while its model call is
under way: it keeps its slot and reservation until the call returns.

Asking again for the same thing (the same member, feature, question and parameters) while a request is in
flight returns that request instead of starting a second one, even when the member's hourly allowance is
used up. A start refused by a check before it is charged (rate limit, busy, budget) costs nothing; a start
that loses a race under the lock still spends its hourly hit.

**Charging.** A run that called the model is charged the usage the server reports, once, when it settles,
including suggestions discarded before they finished. A failed model call (the provider may still have
processed and billed the prompt) is charged its prompt's characters as input tokens. A call whose worker
died is charged half a reservation by the sweep when it marks the request `stale`; this can overcharge, never
undercharge. A server that reports no usage counts as zero tokens for successful calls, so **the monthly
budget binds such a server only loosely**; the per-user and per-workspace request limits still apply.
Ollama, vLLM, llama.cpp and the hosted APIs report usage.

## Changing the provider

The acknowledgement is bound to the provider's identity: provider, hosting, label, model, location and
jurisdiction. For a
self-hosted server without `AI_PROVIDER_LABEL` the label is derived from `AI_BASE_URL`'s host and port
("Self-hosted model at ollama:11434"), so moving the server to another address changes it too. Set
`AI_PROVIDER_LABEL` if you want a name that survives a move. Changing any of them (moving
from `qwen3.5:9b` to `qwen3.5:27b` counts) turns AI off in every workspace: the settings page
shows the new provider and asks an owner or admin to acknowledge it, and until then every start answers
`409 ai_acknowledgement_required` and queued requests are refused `disabled` when they run. Nothing is
switched back on for tenants without their say.

Before switching a workspace-visible fact (third-party provider, model, location), tell your tenants: for a
managed host this is a sub-processor change, which your DPA probably requires you to announce in advance.
Changing a setting that is not part of the identity (the limits, `AI_JSON_MODE`, `AI_TOKEN_PARAM`,
`AI_API_KEY`) does not need a new acknowledgement.

## Turn it off

- **One workspace:** its owner or admin switches it off on **Settings → AI assist**. Requests for the
  features turned off are cancelled in the same step (status `cancelled`); one whose model call is under way
  keeps its slot until the call returns, and its result is dropped.
- **The whole install:** `AI_PROVIDER=none` and restart. Every workspace's AI is off, the settings page says
  your host has not configured a model, and existing suggestions expire on their normal schedule.

## Errors

### When starting a request (HTTP)

| Code | Means | Fix |
|---|---|---|
| `409 ai_unavailable` | `AI_PROVIDER=none`, or the process has no model | configure a provider; check `fundroom doctor` |
| `409 ai_disabled` | the workspace, or this feature, is switched off; or (reason `budget_below_minimum`) the workspace's budget is below one reservation; or the requester is being erased | an owner or admin turns it on, or raises the budget |
| `409 ai_acknowledgement_required` | never acknowledged, or the provider changed since | an owner or admin acknowledges on the settings page |
| `429 ai_rate_limited` | this staff member's hourly allowance is used | wait for `Retry-After`, or raise `AI_REQUESTS_PER_USER_HOUR` |
| `429 ai_busy` | four requests are in flight in the workspace, or the other in-flight requests' reservations leave no room in the budget | wait; if it persists, the worker is not running or the model is stuck (see `stale` below) |
| `429 ai_budget_exhausted` | this month's usage plus one reservation exceeds the budget | wait for the next month, raise the workspace's budget (up to `AI_MONTHLY_TOKEN_BUDGET`) or the install cap, or lower `AI_MAX_INPUT_CHARS` / `AI_MAX_OUTPUT_TOKENS` |

### On a finished request (`errorCode`)

A request ends `done`, `refused` (the task declined to run it), `failed` (the model call or its output went
wrong) or `cancelled`. A request its requester discarded (`discarded`) is not visible any more (404). One
cancelled because its sources changed shows as `cancelled` with `sources_changed` until its call settles,
then it is deleted (404).

| `errorCode` | Status | Means | Fix |
|---|---|---|---|
| `disabled` | refused | the feature was turned off, or the provider changed, between start and run | turn it on or acknowledge again, then retry |
| `forbidden` | refused | the requester lost the permission (or their membership) between start and run | — |
| `workspace_unavailable` | refused | the workspace is suspended, held or deleted | — |
| `sources_changed` | cancelled | a document the suggestion cites, or the question's document or folder, was binned or purged while the call ran | ask again |
| `subject_gone` | refused | the question was deleted, closed or erased, or its document or folder was deleted | — |
| `no_asker` | refused | the question was entered by staff or imported, so there is no investor whose access could bound the sources | answer it by hand |
| `no_sources` | refused | no page of a document the investor can view (and, for a folder question, everyone who can see the folder can view) matched the question | expected when the answer is not in the data room, the matching documents are narrower than the folder's audience or sit behind an MFA or IP gate, or documents have no extracted text yet ([document-rendering.md](document-rendering.md)) |
| `input_too_large` | refused | the prompt still exceeded `AI_MAX_INPUT_CHARS` | raise it if the model's context allows |
| `invalid_output` | failed or refused | the model's answer was not JSON even after one corrective retry (failed), or was JSON of the wrong shape (refused by the task) | retry; a small model that keeps failing here may be too weak for the task, or need `AI_JSON_MODE=json_schema` on a server that enforces it |
| `empty_output` | refused | the model returned a draft with no usable section | retry, or add notes |
| `invalid_result` / `result_too_large` | failed | the task produced a result that is not an object, or over 256 KiB | report it: a module bug, not a host problem |
| `invalid_params` | failed or refused | the request's parameters no longer validate (for example a template that no longer exists) | start a new request |
| `output_truncated` | failed | the model hit `AI_MAX_OUTPUT_TOKENS` (or its context) before finishing | raise `AI_MAX_OUTPUT_TOKENS`; for Ollama also `OLLAMA_CONTEXT_LENGTH` |
| `refused_by_model` | failed | the model or provider refused or filtered the output | rephrase; nothing to fix on the host |
| `provider_unavailable` | failed | the model server was unreachable, overloaded or loading, twice; or it answered with a redirect (never followed) or more than 4 MiB | check it is running and reachable **from the worker**, and that `AI_BASE_URL` is the final address (no `http:` → `https:` redirect) |
| `provider_timeout` | failed | no answer within `AI_TIMEOUT_MS` (one deadline covers the call and its retry) | raise it, lower `AI_CONCURRENCY`, use a smaller model or a GPU |
| `provider_rate_limited` | failed | the provider's rate limit, still hit after one retry | lower `AI_CONCURRENCY`, or raise the limit with the provider |
| `provider_quota` | failed | the provider account is out of credit or at its spend limit (a quota 429, or 402) | top up or raise the limit with the provider |
| `provider_auth` | failed | the API key was refused | fix `AI_API_KEY` |
| `provider_not_found` | failed | the model does not exist on the server (not pulled, wrong id, no access) | `ollama pull <model>`, or fix `AI_MODEL` |
| `provider_bad_request` | failed | the server refused the request: often an unsupported `response_format` or token parameter | try `AI_JSON_MODE=json_object`, or `AI_TOKEN_PARAM=max_completion_tokens` |
| `provider_context_exceeded` | failed | the prompt does not fit the model's context (or the server refused it as too large) | lower `AI_MAX_INPUT_CHARS`, or give the server a larger context |
| `timeout` | failed | the job itself was aborted or expired (not the model call) | check the worker; raise `AI_TIMEOUT_MS` if model calls are merely slow |
| `stale` | failed | a running request outlived its job's expiry (2 × `AI_TIMEOUT_MS` + 60 s) by another minute, or a queued one was never claimed within an hour (or the job expiry, if longer): a worker died or is not running | check the worker and [queue-backlog.md](queue-backlog.md) |
| `internal` | failed | anything else | the worker log has the error class (never the content) |

A failed request can simply be asked for again; nothing is retried automatically beyond the adapter's one
retry of a transient error and the kernel's one corrective retry of invalid JSON.

## What the author sees

- **Update draft:** the preview lists figures in the draft that appear in neither the KPIs nor the notes
  (`unverifiedNumbers`), and, separately, figures found only in the previous update
  (`numbersFromLastUpdate`: are they still current?). Dates and periods (Q3, FY2025, 2026-03, March 12) are
  not counted as figures. Links whose URL was not in the material are reduced to their text. Nothing is
  removed from the draft on the author's behalf.
- **Q&A answer:** each citation must name a passage that was sent, and its quote must be found in that
  passage: at least 24 characters and 4 words, or 12 characters in a script written without spaces (Chinese,
  Japanese, Thai, …). Others are dropped and counted. The quote shown is the page's own text, not the
  model's wording. Source markers are renumbered `[1]…[n]`, a trailing source list the model wrote is replaced
  by a server-built one (title, page), and an answer left with no verified citation is shown as
  `unsupported`.

## Verify

1. `fundroom doctor 2>&1 | grep aiAssist` shows `off`, or `<provider> (<hosting>, <model>)`.
2. For Ollama, `docker compose exec ollama ollama list` shows the model named in `AI_MODEL`, spelled the
   same way.
3. In a test workspace: **Settings → AI assist** shows the provider, hosting and retention; turn on update
   drafts, acknowledge, then **Updates → Draft with AI**. The draft appears within `AI_TIMEOUT_MS`.
4. For third-party hosting: **Settings → Data residency** in that workspace lists the provider as a
   sub-processor once AI is on, and the deployment-wide list names it whenever it is configured.
5. The privacy-notice template (v3) has an "AI assist" section filled from the workspace's effective state:
   the features in use and their material, where it runs, retention and training. Legal documents are
   snapshots, so a notice published while AI was off keeps saying it is not used. While any feature is on,
   **Settings → AI assist** tells the workspace admin to update and republish the privacy notice and DPA
   (DPA template v3 covers sending content extracts to the configured model). Tell tenants on older
   versions to publish the new ones.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `none` | `openai-compatible` or `anthropic` |
| `AI_BASE_URL` | unset | required with `openai-compatible` (`http://ollama:11434`; a trailing `/v1` is fine); anthropic: defaults to `https://api.anthropic.com`, must stay that in `prod` (staging may point at a proxy); in `prod`/`staging` `https:` is required for third-party hosting and for any host that is not evidently yours |
| `AI_API_KEY` (or `_FILE`) | unset | required with `anthropic`; optional for `openai-compatible` (plain `http:` is only possible to a host that is evidently yours, see `AI_BASE_URL`) |
| `AI_MODEL` | unset | required unless `AI_PROVIDER=none`; 1–200 characters |
| `AI_HOSTING` | derived | `openai-compatible` only: `self_hosted` or `third_party` |
| `AI_PROVIDER_LABEL` | unset | sub-processor name; required for third-party `openai-compatible` |
| `AI_PROVIDER_LOCATION` | unset | where the provider processes data, in words |
| `AI_PROVIDER_JURISDICTION` | unset | `eu`, `uk`, `ch`, `us`, `ca`, `au`, `other` or `varies`; required for third-party `openai-compatible` |
| `AI_JSON_MODE` | `json_schema` | `openai-compatible` only: `json_schema`, `json_object` or `prompt` |
| `AI_TOKEN_PARAM` | `max_tokens` | `openai-compatible` only: or `max_completion_tokens` |
| `AI_TIMEOUT_MS` | `180000` | 5 000–900 000, per model call |
| `AI_MAX_OUTPUT_TOKENS` | `4000` | 256–32 000 |
| `AI_MAX_INPUT_CHARS` | `60000` | 4 000–400 000 |
| `AI_CONCURRENCY` | `2` | 1–32 model calls in flight per process |
| `AI_MONTHLY_TOKEN_BUDGET` | `2000000` | per workspace per UTC month; at least `2 × AI_MAX_INPUT_CHARS + 3 × AI_MAX_OUTPUT_TOKENS` (132 000 with the defaults) while a provider is set, at most 10 000 000 000 |
| `AI_REQUESTS_PER_USER_HOUR` | `30` | 1–1 000 |
| `AI_RESULT_RETENTION_HOURS` | `168` | 1–2 160 |
