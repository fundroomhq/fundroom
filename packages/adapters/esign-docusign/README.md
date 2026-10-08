# @fundroom/esign-docusign

`ESignPort` adapter for **DocuSign eSignature REST API v2.1**, authenticated with
the **OAuth JWT grant**. Export: `docusignAdapter` (`ESignAdapterDefinition`). Depends only on
`@fundroom/ports` and Node builtins; JWT signing uses `node:crypto` (RS256), no JOSE library.

## Credentials (connection form)

| key | kind | notes |
|---|---|---|
| `environment` | select `demo` \| `production` | picks the account server: `account-d.docusign.com` / `account.docusign.com` |
| `integrationKey` | text | the app's Integration Key (JWT `iss`) |
| `userId` | text | GUID of the user the integration impersonates (JWT `sub`) |
| `privateKeyPem` | pem | RSA private key of the integration's keypair (PKCS#1 or PKCS#8) |
| `accountId` | text, optional | defaults to the user's default account from `/oauth/userinfo` |
| `connectHmacKey` | secret | Connect HMAC key (DocuSign generates it: `callbackSecret: "vendor"`) |
| `connectHmacKeySecondary` | secret, optional | second key accepted during a rotation |

## Endpoints used

| call | endpoint | confidence |
|---|---|---|
| token | `POST https://{account server}/oauth/token` form `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT>`; JWT claims `iss, sub, aud=<account server host>, iat, exp=iat+3600, scope="signature impersonation"` | verified (DocuSign JWT grant docs) |
| account | `GET https://{account server}/oauth/userinfo` → `accounts[].{account_id,is_default,account_name,base_uri}` | verified |
| create | `POST {base_uri}/restapi/v2.1/accounts/{accountId}/envelopes` with `status:"sent"`, `documents[].documentBase64` + `recipients.signers[].tabs` (`signHereTabs`, `dateSignedTabs`, `fullNameTabs`), or `templateId` + `templateRoles[]` with `tabs.textTabs` prefill; `customFields.textCustomFields` carries `seedhost_external_id` | verified shape; tab `width`/`height` on date/name tabs inferred |
| status | `GET …/envelopes/{id}`, `GET …/envelopes/{id}/recipients`, `GET …/envelopes/{id}/custom_fields` (template role map only) | verified |
| signing URL | `POST …/envelopes/{id}/views/recipient` `{returnUrl, authenticationMethod:"none", clientUserId, recipientId, userName, email}` | verified |
| download | `GET …/envelopes/{id}/documents/combined?certificate=false`, `GET …/envelopes/{id}/documents/certificate` | verified |
| void | `PUT …/envelopes/{id}` `{status:"voided", voidedReason}` | verified |

## Behaviour

- **Token cache**: one access token per port instance, reused until 5 minutes before `expires_in`;
  concurrent callers share one in-flight token request; a 401 from the REST API drops the token and
  retries once. The account (base URI) is resolved once per port instance.
- **Base URI validation**: `base_uri` from userinfo will receive our bearer token, so it must be an
  `https://*.docusign.net` origin with no port or userinfo; anything else is `invalid_response` and
  no REST call is made. Signing URLs handed to a browser must be https `*.docusign.net`/`*.docusign.com`.
- **Fields**: page fractions → points (72 DPI, top-left origin). The page size is read from the PDF's
  `/MediaBox` (plain objects and Flate object streams, no PDF library). Mixed page sizes use the
  first size for every page (logged); a PDF without a MediaBox is assumed US Letter 612×792 (logged).
- **Embedded signing**: `embedded: true` sets `clientUserId = signerKey`, which makes the recipient
  captive (DocuSign sends no email); `signingUrl()` returns a recipient view. Remote recipients →
  `signingUrl()` answers `undefined`.
- **Signer keys**: PDF signers carry a recipient custom field `seedhost_signer_key=<key>`; template
  roles cannot, so the envelope custom field `seedhost_roles` (`Role=key;…`, ≤ 100 chars) maps
  `roleName` back.
- **Status mapping**: see the table at the top of `src/docusign-port.ts` (`voided` with an "expired"
  reason → `expired`; DocuSign voids envelopes when they expire).
- `downloadSigned` first checks the envelope is `completed` (DocuSign would otherwise serve the unsigned
  document), bounds each artifact by `maxBytes` (Content-Length and streamed), requires `%PDF-`.
- **Errors**: 401/403 unauthorized, 404 not_found, 400/409/422 rejected, 429 rate_limited
  (retryable), 5xx/network unavailable (retryable), bad JSON invalid_response. Token-endpoint 400s
  (`consent_required`, `invalid_grant`) are unauthorized. Messages carry the operation, the status and
  at most DocuSign's `errorCode` — never vendor messages, keys or tokens.

## Callback verification

DocuSign Connect with HMAC: each active key produces a header `X-DocuSign-Signature-<n>`
(n = 1…100) = base64(HMAC-SHA256(key, raw body)). `parseCallback` computes the HMAC for each
configured key and accepts when **any** header matches **any** key (`timingSafeEqual`, no early exit),
so keys can be rotated with no downtime. It then reads only `event`, `data.envelopeId` (GUID) and the
`seedhost_external_id` custom field from the JSON payload (legacy XML: `<EnvelopeID>`). The payload has
no signed timestamp, so no freshness window is enforced; a replay only causes one extra status pull.

## Vendor-side setup

1. **Apps and Keys** → add an app (integration key) → *Authentication: JWT* → generate an RSA keypair;
   paste the private key here. Note the **User ID** and optionally the **API Account ID**.
2. Grant consent once as that user: open
   `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<integrationKey>&redirect_uri=<a redirect URI registered on the app>`
   (use `account.docusign.com` for production). Until then the token call fails with `consent_required`.
3. **Settings → Connect → Add configuration (Custom)**: URL = the callback URL shown on our
   E-signature settings page; data format **JSON (REST v2.1)**; events: envelope sent, delivered,
   completed, declined, voided (recipient events optional); enable **Include HMAC signature**.
4. **Settings → Connect → Connect keys → Add secret key**; paste it as *Connect HMAC key*.
5. Templates for round closing: the template's signer role must be named exactly `Signer` — the
   kernel sends `roleName: "Signer"` for every template envelope unless the caller names another
   role. Prefill tabs are Text tabs on that role whose Data Label is the prefill name.
6. Production: complete DocuSign's go-live review for the integration key, then switch
   `environment` to `production` (production has its own keys and user ids).

## Confidence notes

Verified against DocuSign's public docs and developer blog: JWT claims and endpoints, userinfo shape,
Connect HMAC header/encoding and multi-key behaviour, envelope/recipient/view/void/download endpoints,
and that expired envelopes become `voided`. Inferred (needs a sandbox run before GA): exact spelling of
`voidedReason` for expiry (we match `/expir/i`), `width`/`height` accepted on `dateSignedTabs` /
`fullNameTabs`, and `customFields` on PDF recipients being echoed by `GET …/recipients`.
All tests run against a scripted fake (`src/testing/fake-docusign.ts`), not the live API.
