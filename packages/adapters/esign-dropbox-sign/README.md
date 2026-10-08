# @fundroom/esign-dropbox-sign

`ESignPort` adapter for **Dropbox Sign API v3** (formerly HelloSign). Export:
`dropboxSignAdapter` (`ESignAdapterDefinition`). Depends only on `@fundroom/ports` and Node builtins.

## Credentials (connection form)

| key | kind | notes |
|---|---|---|
| `apiKey` | secret | HTTP basic auth username (empty password); also the callback HMAC key |
| `testMode` | select `test` \| `live` | `test` sends `test_mode=1` (non-binding). Anything but `live` is treated as test. |

The API origin is fixed at `https://api.hellosign.com/v3`; a configured base URL is ignored so the API
key can only be sent to Dropbox Sign. `callbackSecret: "vendor"` with no extra field (the API key signs
callbacks).

## Endpoints used

| call | endpoint | confidence |
|---|---|---|
| verify | `GET /v3/account` → `account.{account_id,email_address}` | verified |
| create (PDF) | `POST /v3/signature_request/send`, multipart: `files[0]`, `title`, `subject`, `message`, `signers[i][name\|email_address\|order]`, `metadata[k]`, `form_fields_per_document` (JSON string), `test_mode`, `signing_redirect_url` | verified params; bracket encoding for signers/metadata in multipart inferred from the classic curl examples |
| create (template) | `POST /v3/signature_request/send_with_template`, JSON: `template_ids`, `signers[{role,name,email_address}]`, `custom_fields[{name,value}]`, `metadata`, `test_mode` | verified |
| status | `GET /v3/signature_request/{id}` (410 after cancel → `voided`) | verified fields; 410 for the requester inferred from the cancel docs |
| download | `GET /v3/signature_request/files/{id}?file_type=pdf` (409 = still preparing → retryable) | verified |
| void | `POST /v3/signature_request/cancel/{id}` (410 = already cancelled → ok) | verified |

## Behaviour

- **Fields**: page fractions → the "new" coordinate system (72 DPI, top-left origin, `page` set,
  `document_index: 0`). Dropbox Sign sizes `width`/`height` at 80 DPI even in that system, so sizes are
  scaled by 80/72. Page size from the PDF's `/MediaBox` (same scanner as the DocuSign adapter; US
  Letter fallback, logged). Field types: signature → `signature`, date → `date_signed`, name → a
  required `text` field (Dropbox Sign has no auto-filled full-name field).
- **Signer order**: our 1-based order → 0-based `signers[i][order]`, sent only when there is more
  than one signer.
- **externalId** → `metadata.seedhost_external_id`; signer keys → `metadata.seedhost_signers` (JSON
  `[[key, role|null], …]`), mapped back by `signer_role`, then `order`, then position.
- **No embedded signing** (`supports.embeddedSigning: false`): a Dropbox Sign `sign_url` works only
  inside the `hellosign-embedded` iframe library on a domain registered to an API app (needs a
  `client_id` and `create_embedded`), while our portal opens signing URLs top-level. Every signer is
  emailed by Dropbox Sign; `signingUrl()` answers `undefined`.
- **Status mapping**: see the table at the top of `src/dropbox-sign-port.ts`.
- `downloadSigned` requires `is_complete` first (the files endpoint also serves in-progress PDFs),
  bounds by `maxBytes` and requires `%PDF-`. The merged PDF ends with Dropbox Sign's audit-trail page,
  so there is no separate `certificate`.
- **Errors**: as the port requires; messages carry only `error.error_name`, never `error_msg`, the API
  key or signer data.

## Callback verification

Callbacks are `multipart/form-data` with the event JSON in the field `json` (a raw `application/json`
body is also accepted). The multipart parser is bounded (1 MiB, ≤ 64 parts), takes the boundary only
from Content-Type and refuses a body without its closing delimiter. Authenticity:
`event.event_hash` = hex HMAC-SHA256(key = API key, `event_time` + `event_type`), compared with
`timingSafeEqual`. `event_time` must be within **[now − 72 h, now + 5 min]**: the hash does not cover
the request id, so it is only a wake-up (replay-harmless), and Dropbox Sign retries with the original
`event_time` for 20+ hours — rejecting those would count toward the 10 consecutive failures after
which Dropbox Sign clears the callback URL. The route answers `Hello API Event Received`.

## Vendor-side setup

1. Dropbox Sign → **Settings → API**: copy the API key (create one if needed).
2. On the same page set **Account callback** URL = the callback URL shown on our E-signature
   settings page. Dropbox Sign sends a `callback_test` event; our route acknowledges it.
3. Templates for round closing: create the template in Dropbox Sign with ONE signer role named
   exactly `Signer` — the kernel sends `role: "Signer"` for every template envelope unless the
   caller names another role (a round-level template-role setting, where one exists, must match the
   template) — and text merge fields named like the round's prefill mapping; use the template id as
   the subscription template ref. A role named anything else (e.g. `Investor`) makes Dropbox Sign
   refuse the request.
4. Leave *Mode* on `test` until the account has a paid API plan; switch to `live` for binding
   signatures.

## Confidence notes

Verified against developers.hellosign.com (send, send_with_template, get, files, cancel, embedded
sign_url) and the official SDKs' `EventCallbackHelper` (hash recipe). Inferred (needs a sandbox run
before GA): multipart bracket encoding of `signers`/`metadata`, the 80-DPI size scaling (from Dropbox's
help article), and 410 on `GET` after cancel. All tests run against a scripted fake
(`src/testing/fake-dropbox-sign.ts`), not the live API.
