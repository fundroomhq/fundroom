# @fundroom/esign-documenso

`ESignPort` over the [Documenso](https://documenso.com) public API **v1**.
Works with Documenso Cloud (`https://app.documenso.com`, the default) and self-hosted
Documenso (the admin supplies the base URL). Stateless: one port per workspace connection.
Runtime dependency: `@fundroom/ports` only. Every call goes through the injected, SSRF-guarded
`deps.fetch` (no redirects followed).

## Endpoints used

| Port method | Documenso call | Confidence |
|---|---|---|
| `verifyCredentials` | `GET /api/v1/documents?page=1&perPage=1` | verified (v1 contract) |
| `createEnvelope` (pdf) | `POST /api/v1/documents` (title, externalId, recipients, meta) → `uploadUrl`; `PUT <uploadUrl>` (the PDF, **no Authorization header**); `POST /api/v1/documents/{id}/fields` (array); `POST /api/v1/documents/{id}/send` | verified (v1 contract + implementation; upload URL is a presigned S3/Azure PUT) |
| `createEnvelope` (template) | `GET /api/v1/templates/{id}` (recipients + fields); `POST /api/v1/templates/{id}/generate-document` (recipients by template recipient id, `prefillFields`, `formValues`, meta); `POST /api/v1/documents/{id}/send` | verified (v1 contract) |
| `status` | `GET /api/v1/documents/{id}` | verified |
| `signingUrl` | `GET /api/v1/documents/{id}` → the recipient's `signingUrl` | verified |
| `downloadSigned` | `GET /api/v1/documents/{id}/download` → `downloadUrl`; `GET <downloadUrl>` (**no Authorization header**), bounded by `maxBytes`, `%PDF-` checked | verified |
| `void` | `GET /api/v1/documents/{id}` then `DELETE /api/v1/documents/{id}` (only while not final) | verified |
| `parseCallback` | webhook `POST` with `X-Documenso-Secret: <secret>`, body `{event, payload:{id, externalId, …}, createdAt, webhookEndpoint}` | verified (Documenso's webhook executor) |

Sources checked: the v1 OpenAPI reference at <https://openapi-v1.documenso.com> (linked from
`https://app.documenso.com/api/v1/openapi`) and Documenso's own v1 contract/schema/implementation
and webhook executor source (read for the API shape only; nothing copied — Documenso is AGPL).

## Mapping notes

- **Field geometry**: the port's page fractions (top-left origin) × 100 → Documenso's
  `pageX/pageY/pageWidth/pageHeight` percentages. `signature` → `SIGNATURE`, `date` → `DATE`,
  `name` → `NAME`.
- **Signer keys**: Documenso recipients have no metadata, so the n-th signing recipient (ordered by
  `signingOrder`, then id) is `s<n>`; `createEnvelope` refuses signer keys that are not exactly
  `s1..sN` in signing order.
- **Template envelopes**: the signer's `role` is matched (case-insensitively) to the template
  recipient's placeholder name, then its placeholder email, then its numeric id; a
  single-recipient template accepts a role-less signer. A `prefill` key that equals the label of a
  template TEXT/NUMBER field becomes a `prefillFields` entry; every other key is sent as a PDF form
  value (`formValues`, AcroForm field name). `templateRef` must be the numeric template id.
- **Embedded** envelopes use `distributionMethod: NONE` and `send` with `sendEmail: false`.
  `signingUrl()` ignores `returnUrl`: v1 fixes the post-signing redirect at creation
  (`meta.redirectUrl` = `input.redirectUrl`).
- **Status table** is in `src/adapter.ts`. A cancelled pending document is *hard-deleted* by v1, so
  after `void()` (ours or the vendor's) `status()` throws `not_found`; the kernel treats that as
  voided. `void()` never deletes a completed/rejected document (Documenso would soft-delete it).
- **Certificate**: Documenso seals its signing certificate into the completed PDF; v1 has no
  separate certificate download, so `downloadSigned` returns only `document`.
- **Idempotency**: v1 has no externalId lookup, so a retry after an ambiguous failure can create a
  second document; the kernel's stale-draft sweep handles it. A failure after the document was
  created (upload, fields, send) deletes that draft best-effort before rethrowing.
- **Errors**: 401/403 `unauthorized`; 404 `not_found`; 400/409/422 and other 4xx `rejected`;
  429 `rate_limited` (retryable); 5xx, timeouts and network errors `unavailable` (retryable); an
  outbound-policy refusal `unavailable` (not retryable); a 3xx or non-JSON body
  `invalid_response`; an oversize artifact `too_large`. Messages never contain the token, the
  callback secret or a presigned URL; vendor messages are bounded and scrubbed.

## Callback verification

The secret is **ours** (`meta.callbackSecret = "ours"`): the kernel generates it, the admin
pastes it into Documenso. `parseCallback` compares `X-Documenso-Secret` to it with
`crypto.timingSafeEqual` (equal-length buffers), then requires a JSON body naming the document
(`payload.id` and/or `payload.externalId`). Documenso sets `createdAt` on every delivery attempt,
so callbacks older or newer than ±5 minutes are refused (a Documenso host with a badly skewed
clock will have its callbacks dropped; the 5-minute status sync still converges). Garbage, a
missing header or no configured secret → `undefined`, never a throw. The callback is only a
wake-up: the kernel re-pulls `status()`.

## Admin setup (vendor side)

1. Documenso → **Settings → API Tokens** (for a team, the team's settings): create a token and
   paste it into FundRoom's e-signature connection form (`apiToken`).
2. Self-hosted: enter the instance's base URL (e.g. `https://sign.example.com`). It must be https
   unless its host is listed in `ESIGN_ALLOW_PRIVATE_HOSTS`. v1 uploads and downloads go through
   **presigned object-store URLs**, so the instance must use S3-compatible (or Azure) upload
   transport (`NEXT_PUBLIC_UPLOAD_TRANSPORT=s3`); with database transport v1 answers 500 to
   downloads. The object-store host must also be reachable under the same outbound policy.
3. Documenso → **Settings → Webhooks** → create a webhook: URL = the callback URL shown in
   FundRoom, secret = the one-time callback secret FundRoom shows, events: document
   opened/signed/completed/rejected/cancelled.

## Testing

- `src/adapter.test.ts` runs `describeESignPortContract` twice (scripted fetch and the real
  HTTP fake) plus geometry, status, error-mapping and oversize-download tests.
- `@fundroom/esign-documenso/testing` exports `startFakeDocumenso()` — a node:http server on
  `127.0.0.1` implementing exactly the endpoints above (presigned URLs on the same port, which
  reject any request carrying `Authorization`). Its `vendor` control has `apiToken`,
  `callbackSecret` / `setCallbackSecret()`, `complete/decline/voidFromVendor`, `callback()`,
  `forgedCallback()`, `failNext(status)`, `setArtifact()` and a request log.

## Confidence notes

- Every endpoint above was confirmed against Documenso's v1 contract and implementation source
  as of 2026-09. Documenso is migrating its public API to v2 ("envelopes"); v1 is still served
  (the v1 OpenAPI reference is live) but is on a deprecation path. A v2 port is future work.
- The Azure upload header (`x-ms-blob-type: BlockBlob`, sent only to `*.blob.core.windows.net`)
  is inferred from Azure's SAS PUT rules, not tested against a live Azure-backed Documenso.
- Sub-processor facts: DPA at <https://documen.so/dpa> (Documenso's own short link to its DPA
  signing page); SOC 2 per Documenso's compliance page / trust centre. The cloud hosting region is
  not stated on a public page we could find, so `region` says "vendor-operated".
