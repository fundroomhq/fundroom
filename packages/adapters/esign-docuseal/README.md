# @fundroom/esign-docuseal

`ESignPort` over the [DocuSeal](https://www.docuseal.com) REST API. Works with
DocuSeal Cloud (`https://api.docuseal.com`, the default; EU: `https://api.docuseal.eu`) and
self-hosted DocuSeal (the admin supplies the app URL; the API lives under `<base>/api`). Stateless:
one port per workspace connection. Runtime dependency: `@fundroom/ports` only (+ `node:zlib` to
read PDF page sizes). Every call goes through the injected, SSRF-guarded `deps.fetch`.

## Endpoints used

All API calls send `X-Auth-Token: <api key>`.

| Port method | DocuSeal call | Confidence |
|---|---|---|
| `verifyCredentials` | `GET /templates?limit=1` | verified (OpenAPI) |
| `createEnvelope` (template) | `POST /submissions` `{template_id, send_email, order:"preserved", completed_redirect_url, message, submitters:[{name,email,role,external_id,metadata,values,order,send_email}]}` → array of submitters (`submission_id`) | verified (OpenAPI + open-source controller) |
| `createEnvelope` (pdf) | `POST /submissions/pdf` `{name, documents:[{name, file: base64, fields:[{name,type,role,required,areas:[{x,y,w,h,page}]}]}], submitters:[…]}` → submission (`id`) | endpoint verified (OpenAPI); **area units inferred** (see below); **Cloud / Pro only** |
| `status` | `GET /submissions/{id}` | verified |
| `signingUrl` | `GET /submissions/{id}`, then `PUT /submitters/{submitterId}` `{completed_redirect_url: returnUrl}` → `embed_src` | verified (OpenAPI: PUT response carries `embed_src`) |
| `downloadSigned` | `GET /submissions/{id}/documents?merge=true` → `documents[].url`; the file URL and the submission's `audit_log_url` fetched **without** `X-Auth-Token`, bounded by `maxBytes`, `%PDF-` checked | verified (OpenAPI); `merge` query param verified in OpenAPI |
| `void` | `GET /submissions/{id}` then `DELETE /submissions/{id}` (archive; idempotent when already archived) | verified |
| `parseCallback` | webhook `POST` `{event_type, timestamp, data}` with the admin-configured header `X-Fundroom-Signature: <secret>` | verified (DocuSeal sends configured secret headers verbatim; open-source `SendWebhookRequest`) |

Sources: DocuSeal's OpenAPI document (<https://console.docuseal.com/openapi.json>), the API docs
(<https://www.docuseal.com/docs/api>), the webhook docs in the DocuSeal repository, and the
open-source routes/controllers (read for API shape only; nothing copied — DocuSeal is AGPL).

## Mapping notes

- **Identity**: each submitter gets `external_id = "<externalId>.<signerKey>"` and
  `metadata = {seedhost_envelope_id, seedhost_signer_key}`; status, signing links and callbacks map
  back through those, so any unique signer key `[A-Za-z0-9_-]{1,64}` works.
- **Order**: our 1-based `order` → DocuSeal's 0-based `order` (same order = parallel), submission
  `order: "preserved"`.
- **Template envelopes**: `templateRef` must be the numeric template id; `role` is the template's
  submitter role name (required when there is more than one signer). The kernel sends `Signer`
  unless the caller names another role, so a multi-role template needs a submitter role named
  exactly `Signer`. `prefill` goes to the first
  signer's `values` (keys are template field names).
- **PDF envelopes**: each port field becomes a DocuSeal field `{kind}_{signerKey}_{n}` (`signature`,
  `date`, `name` → `text` prefilled with the signer's name) with role = the signer's `role` or
  `Signer <key>`. Geometry: fractions × the page size read from the PDF's `/MediaBox` (raw or in
  pdf-lib's compressed object streams); mixed page sizes use the first (logged); no MediaBox →
  US Letter.
- **Embedded** envelopes use `send_email: false`; the signing link is the submitter's `embed_src`
  after `PUT /submitters/{id}` set `completed_redirect_url` to the caller's `returnUrl`.
- **Status table** is in `src/adapter.ts` (archived → `voided`; `expire_at` in the past →
  `expired`; missing `status` fields on older self-hosted versions are derived from submitters).
- **Artifacts**: the merged signed PDF is `document`; the audit log PDF is `certificate`.
- **Errors**: as in the Documenso adapter — 401/403 `unauthorized`, 404 `not_found`,
  400/409/422 `rejected`, 429 `rate_limited`, 5xx/network `unavailable` (retryable), 3xx/non-JSON
  `invalid_response`, oversize `too_large`; the API key never appears in a message. A 404 from
  `/submissions/pdf` is reported as `rejected` "DocuSeal Pro or Cloud required".

## Callback verification

The secret is **ours** (`meta.callbackSecret = "ours"`). `parseCallback` compares the
`X-Fundroom-Signature` header to the connection's callback secret with `crypto.timingSafeEqual`.
The pre-rename `X-Seedhost-Signature` (`LEGACY_SECRET_HEADER`) is accepted permanently, because
existing DocuSeal webhooks send it: every one of the two headers that is present must match (each
compared in constant time, no early exit), and at least one must be present, so a wrong value is
never rescued by a right one riding alongside. It then
requires a JSON body whose `event_type` is `form.*` (submission id at `data.submission.id`)
or `submission.*` (`data.id`). No freshness window: DocuSeal's `timestamp` is the event's creation
time and is reused on every retry for up to 48 h, and the header is static, so a window would only
drop legitimate retries — the kernel re-pulls `status()` on every accepted callback anyway.
Garbage, a missing header or no configured secret → `undefined`, never a throw.

(DocuSeal releases from 2026-05 can also sign webhooks with `X-Docuseal-Signature` =
`<ts>.<hex HMAC-SHA256(secret, "<ts>.<body>")>` using a vendor-generated `whsec_…` key. Supporting
it would make the secret "vendor"-generated; not done here because older self-hosted versions lack
it and the static header works on every version.)

## Admin setup (vendor side)

1. DocuSeal → **Settings → API**: copy the API key into FundRoom's connection form (`apiToken`).
2. Base URL: leave empty for DocuSeal Cloud (US); `https://api.docuseal.eu` for the EU cloud;
   the app URL (e.g. `https://docuseal.example.com`) for self-hosted. Self-hosted must be https
   unless its host is in `ESIGN_ALLOW_PRIVATE_HOSTS`. Document download URLs must be served by the
   DocuSeal host (or a storage host reachable under the same policy) **without a redirect** — an
   instance that answers file URLs with a 302 to object storage will fail downloads with
   `invalid_response` (the guarded client follows no redirects).
3. DocuSeal → **Settings → Webhooks**: add the callback URL shown in FundRoom, enable
   `form.viewed`, `form.completed`, `form.declined`, `submission.completed`, `submission.expired`,
   `submission.archived`, and add a **secret header** with key `X-Fundroom-Signature` and the
   one-time callback secret FundRoom shows as its value.
4. For e-sign NDAs (PDF envelopes) the account must be DocuSeal Cloud or a Pro self-hosted
   licence; the open-source edition supports template envelopes (round closing) only.

## Testing

`src/adapter.test.ts` runs `describeESignPortContract` against a scripted fake (current and
legacy response shapes) plus API-root, geometry (including pdf-lib object-stream PDFs), status,
error-mapping, download-limit, signing-link, void and callback tests. The fake is exported at
`@fundroom/esign-docuseal/testing` (`createFakeDocuseal`, `fakeFetch`).

## Confidence notes

- **Field area units for `/submissions/pdf` are inferred.** The API reference says "exact pixel
  coordinates"; DocuSeal stores areas as page fractions internally and its PDF page geometry is in
  PDF points, so we send PDF points (1/72 in, top-left origin). The Pro code that converts them is
  not open source. **Verify on a live DocuSeal Cloud account before relying on NDA field
  placement**; if DocuSeal expects fractions, `toDocusealArea` is the one function to change.
- `/submissions/pdf` absence on the open-source edition is verified from its `config/routes.rb`.
- Sub-processor facts: DPA terms are on DocuSeal's GDPR page (<https://www.docuseal.com/privacy/gdpr>,
  "Data Processing Agreements" section; no standalone DPA document was found); EU data stays in
  Ireland on docuseal.eu. No certification is claimed on a public page we could find.
