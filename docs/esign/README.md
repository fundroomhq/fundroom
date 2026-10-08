# E-signature

FundRoom can send documents for legally binding electronic signature through a vendor the workspace connects: **Documenso**, **DocuSeal**, **DocuSign** or **Dropbox Sign**. This guide is for the workspace admin who connects the vendor and for the operator who runs the install. Step-by-step vendor setup is on one page per vendor ([Documenso](documenso.md), [DocuSeal](docuseal.md), [DocuSign](docusign.md), [Dropbox Sign](dropbox-sign.md)); what to do when something goes wrong in production is in the [e-signature runbook](../runbooks/esign.md).

FundRoom never signs anything itself and never copies vendor code: it talks to the vendor's HTTP API with the workspace's own credentials, and keeps an encrypted copy of what was signed.

## What it is used for

| Use | Who starts it | Document | How the signer signs | Where the signed copy ends up |
|---|---|---|---|---|
| **NDA ceremony** | the investor, at the NDA gate | the current version of a legal document whose ceremony is *E-signature*, rendered to PDF by FundRoom | in the vendor's signing page, opened from the portal (vendors with embedded signing), or from the vendor's email (Dropbox Sign) | kernel store + data room `Signed documents/NDAs` |
| **Round closing** | staff, per commitment (**Round → Closing → Send for signature**) | the vendor-side **template** named in the round's closing settings, prefilled from the commitment | always from the vendor's email | kernel store + data room `Signed documents/<round name>` |

Both go through the same pipeline, one **envelope** per signer and document:

```
request ──▶ envelope `draft` ──vendor create──▶ `sent` ──status pulls──▶ `delivered` ──▶ `completed`
                                                           │                              │
                                                           ▼                              ▼ esign.collect
                                             `declined` / `voided` / `expired`   download · %PDF- check · virus scan
                                                                                  · encrypt · store
                                                                                          │
                                                                          esign.envelope_completed
                                                          ┌───────────────────────┼──────────────────────┐
                                                          ▼                       ▼                      ▼
                                             NDA: acceptance recorded   round: commitment `signed`   data room: vaulted,
                                             (gate opens)                                            legal hold, staff-only
```

### NDA ceremony

A legal document (**Legal → document → Ceremony**) is accepted either by **click-wrap** (the default: a checkbox and a certificate FundRoom issues) or by **E-signature**. Click-wrap is *not* a signed NDA; if your counsel wants a signature, choose E-signature. Choosing it needs an active connection (otherwise `409 esign_not_configured`), and the connection cannot be removed while any live document uses it (`409 esign_ceremony_in_use`).

For an investor who owes that document:

1. The gate shows the ESIGN consent disclosure (below) with an unticked checkbox and a **Sign with ‹vendor›** button. Consent is recorded once per member (attestation `esign-consent:v1`, audited `esign.consent_recorded`).
2. FundRoom renders the document's current version to a plain A4 PDF (title, version, body, and a final page with the signature, name and date boxes) and creates the envelope. The PDF uses the PDF standard fonts only, so characters outside Western European text (Greek, Cyrillic, CJK, most emoji) are replaced; keep e-sign NDAs in a Latin-script language.
3. With a vendor that supports embedded signing, the investor is taken to the vendor's signing page and back to the portal (`/sign?documentId=…`) afterwards; inside an embedded portal the button opens a first-party popup instead, because a vendor signing page must never be framed. With Dropbox Sign the vendor emails the link.
4. When the envelope is completed and its signed copy collected, FundRoom records the acceptance (method `esign`, evidence `esign:v1:<envelopeId>`) — **only** if that version is still current and the member still live and not erased. Otherwise it audits `esign.nda_version_superseded` and the gate stays closed: publishing a new NDA version while an envelope is out means the investor signs again. The portal polls `GET /esign/nda/status` and opens as soon as the acceptance is on record.

Starting again while an envelope for the same member, document and version is open returns that envelope instead of creating a second one.

### Round closing

Each commitment gets a derived checklist — **documents sent**, **signed**, **wired**, **confirmed** — shown on **Round → Closing** with summary tiles, next to the round's manual closing tasks. The investor sees their own checklist on the round page and can download their signed copy.

- **Send for signature** needs an active connection whose vendor supports templates, a subscription template reference in the **Closing** card of **Settings → Round** (`/admin/round/settings`), a commitment in `soft` or `verbal`, a round that is `open` or `closed`, and no request already open for it. The signer is the commitment's member; for a commitment that names no member, staff type the signer's name and email in the dialog.
- The envelope's fields are filled from the **prefill mapping** in the same card: *vendor field name → source*, where the source is one of `investor_name`, `investor_email`, `amount` (formatted with the round currency, e.g. `$250,000.00`), `round_name`, `company_name`, `valuation_cap` (the cap, or the pre-money valuation of a priced round; empty when unset) and `date` (the send date, `YYYY-MM-DD`, UTC). How a vendor matches the field name is on its page.
- **The template's signer role must match the round's Template role setting** (`closing.templateRole`, default `Signer`). FundRoom sends one signer per envelope, with that role name; DocuSign and Dropbox Sign refuse a role the template does not have, and DocuSeal's default first role ("First Party") must be renamed.
- When the envelope completes, the commitment moves to `signed` (only from `soft` or `verbal`), staff holding `round.manage` get a `round.signature_completed` notification, and once the data room has filed the copy the commitment links it.
- **Mark confirmed** (a `wired` commitment) closes the checklist and emails the investor a confirmation when the commitment names a member.
- A declined, voided, expired or failed envelope alerts staff holding `esign.read` (`esign.envelope_attention`). Void a request with **Void**; send again once it is terminal.

Wire instructions and wire-change alerts are not part of this release.

### Vaulting into the data room

When the data-room module is enabled, a completed envelope's signed PDF — and the vendor's separate certificate / audit trail, if it sends one — is filed as a document under the envelope's folder (`Signed documents/NDAs`, `Signed documents/<round name>`), titled `<envelope title> — signed` / `— certificate`. Those documents are:

- **on legal hold** (`esign:<envelopeId>`): they cannot be deleted, binned or purged;
- **staff-only**: the first folder the vault creates is flagged staff-only (or, if the whole path already existed, its last folder is). Nothing at or below a staff-only folder is visible to an investor, a delegate or a share-link visitor **whatever grants exist** — a grant on the data-room root, the folder or the document is accepted and has no effect. The flag cannot be cleared. To share a signed copy with investors, move that document out of the staff-only subtree (audited); the hold stays with it.

Vaulting is best effort: with the data room disabled nothing is filed, and the signed copy stays in the kernel store (downloadable from **Settings → E-signature**). The details are in [`modules/data-room/README.md`](../../modules/data-room/README.md#vaulting).

## Choosing a vendor

From each adapter's declared capabilities (`GET /esign/drivers`):

| | Documenso | DocuSeal | DocuSign | Dropbox Sign |
|---|---|---|---|---|
| Self-hostable | yes (open source, AGPL) | yes (open source, AGPL; Pro licence for some features) | no | no |
| Base URL | cloud default `https://app.documenso.com`, or your instance | cloud default `https://api.docuseal.com`, EU `https://api.docuseal.eu`, or your instance | none (found from the account) | none (fixed `https://api.hellosign.com/v3`) |
| Templates (round closing) | yes | yes, every edition | yes | yes |
| PDF envelopes (NDA ceremony) | yes | **Cloud or Pro only** — the open-source edition answers 404, so an NDA start fails with `esign_provider_error` | yes | yes |
| Embedded signing (investor signs from the portal) | yes | yes | yes | **no** — every signer gets an email |
| Separate certificate PDF | no (sealed into the signed PDF) | yes (audit log) | yes | no (audit page appended to the signed PDF) |
| Callback secret | ours (FundRoom generates it) | ours (sent as a custom header) | DocuSign's Connect HMAC key(s) | the API key itself |
| API used | v1 (see note) | REST | eSignature REST v2.1, OAuth JWT grant | API v3 |

Rules of thumb:

- **Keep signing data on your infrastructure**: self-hosted Documenso (full feature set) or DocuSeal Pro. DocuSeal's open-source edition is fine for round closing only.
- **Your investors or counsel expect a household name**: DocuSign. Most setup work (JWT app, consent, Connect, go-live review).
- **Dropbox Sign** works for both uses, but NDA signers wait for an email, and one Dropbox Sign account has a single callback URL (see its page).
- **Documenso v1 deprecation**: the adapter uses Documenso's public API v1, which Documenso still serves but is replacing with v2 ("envelopes"). Expect a v2 adapter in a later release; watch Documenso's changelog before upgrading a self-hosted instance.

The operator decides which vendors workspaces may pick with `ESIGN_DRIVERS` ([below](#operator-settings)).

## Connecting a vendor

Owners and admins (`esign.manage`) connect under **Settings → E-signature** (`/admin/esign`); `esign.read` (owner, admin, legal) can see the connection and the envelope register. Saving, rotating the callback secret and disconnecting are step-up actions.

1. Pick the vendor. The form shows that vendor's credential fields; self-hostable vendors also get a **Base URL** field. On a first connection (or when switching vendor) empty means the vendor's cloud. When re-saving the **same** vendor, empty means **keep the stored address** — the screen only shows its host, so you can re-key or change another field without retyping the URL. Typing a different address is a change of host: every stored secret must be entered again (`422 esign_credentials_required`, reason `base_url_changed`, listing the `fields`) — a stored secret is only ever sent to the address it was typed for — and it is refused with `409 envelopes_open` while envelopes are open. To move a self-hosted connection back to the vendor's cloud, type the cloud URL explicitly (for example `https://app.documenso.com` or `https://api.docuseal.com`).
2. Save. The credentials are **verified live** against the vendor before anything is stored; a refusal is `422 esign_credentials_rejected` with a `reason` (see [troubleshooting](#credentials-rejected)). Credentials are sealed (encrypted) and never shown again: the screen shows only hints such as `••••ab12`. Re-saving the same vendor with a secret field left blank keeps the stored value.
3. Copy the **callback URL** (and, for Documenso and DocuSeal, the **callback secret**, shown **once**) into the vendor's webhook settings as its page describes.
4. **Verify** re-checks the credentials at any time and records the result (`lastVerifiedAt`, `lastError`, status `active`/`error`).

A workspace has at most one connection. Switching to another vendor is refused with `409 envelopes_open` while any envelope is `draft`, `sent` or `delivered` on the current one; with none open, the old connection is retired (its envelopes and signed copies stay) and the new one gets a **new callback URL**. Disconnecting is refused while envelopes are open or a live legal document uses the E-signature ceremony. Signed records are never deleted by either. At most 10 saves per workspace per hour may create a new connection (a first connection, a vendor switch, or reconnecting after a disconnect); the next answers `429 rate_limited` with `Retry-After`. Re-keying the same connection is not limited.

### The callback URL and secret

```
<BASE_URL>/webhooks/esign/<connectionId>
```

It is per connection, outside `/api/v1`, and served on the install's canonical `BASE_URL` — as configured, path included, without a trailing slash — not a workspace custom domain. It must be reachable from the vendor's servers (for a self-hosted vendor on your LAN, from that host). The connection id stays the same when you re-save the same vendor.

| Vendor | Secret | Where it goes |
|---|---|---|
| Documenso | ours | the webhook's **Secret** field (sent back as `X-Documenso-Secret`) |
| DocuSeal | ours | a custom webhook header `X-Fundroom-Signature` whose value is the secret |
| DocuSign | DocuSign's | generate a Connect HMAC key in DocuSign and paste it into *Connect HMAC key* here; a *secondary* key field allows rotation without downtime |
| Dropbox Sign | the API key | nothing extra: Dropbox Sign signs callbacks with the API key |

**Rotate callback secret** (Documenso, DocuSeal) mints a new secret, shows it once, and the old one **stops working immediately** — paste the new one into the vendor straight away. Callbacks refused in between are harmless (below).

### Callbacks are only wake-ups

Nothing in a vendor callback is trusted. FundRoom checks the callback's authenticity with the connection's secret, then **re-reads the envelope's status from the vendor's API** and acts on that answer. A forged or replayed callback can at most cause one extra status pull, and a lost callback costs only latency, because of the status sync below.

| Answer | When |
|---|---|
| `200` | authentic (Dropbox Sign gets the body `Hello API Event Received`, which it requires). Also for an envelope FundRoom does not know — the URL does not reveal what exists. |
| `401` | not authentic, or the connection is unknown or deleted (one answer for all). Counted as `fundroom_security_events_total{event="esign_callback_rejected"}`; the first per minute is logged as `security.esign_callback_rejected`, the rest summarised in `esign.callback_summary`. |
| `413` | body over 256 KiB |
| `200`, nothing queued | over budget: more than 120 authenticated callbacks per minute for one connection, or 6,000 for all connections together (per process). Never a 429, because Dropbox Sign clears its callback URL after 10 non-2xx answers; the status sync picks the envelope up. Past 30,000 callbacks a minute that reach the connection lookup, callbacks are answered the same way without being looked at (every answer held to 50 ms, so timing reveals nothing), except for connections that authenticated in the last 5 minutes. |
| `500` | ingestion failed; the vendor retries |

Freshness windows are the adapter's own: Documenso ±5 minutes (so a Documenso host with a badly skewed clock has its callbacks refused), Dropbox Sign −72 hours/+5 minutes (its retries keep the original event time for 20+ hours), DocuSeal and DocuSign none (neither signs a timestamp).

### Status sync

Every open envelope is also polled, whether or not callbacks arrive. A cron job (`esign.sync-due`, every 5 minutes) queues a status pull (`esign.sync`) for each envelope that is due:

- after a send or any status change: **5 minutes**, then 15 minutes, 1 hour, 6 hours, and every **24 hours** after that while nothing changes;
- a callback or **Resync** (admin, 10 per minute per workspace) pulls at once;
- an envelope still open **60 days** after it was sent gets one last status pull: if the vendor finished it, that result is applied; if it is still open, it is voided at the vendor and marked `expired`. If the vendor cannot be reached, FundRoom keeps trying for 3 more days (at least every 6 hours) before voiding (best effort) and expiring it;
- a vendor error that will not heal by retrying (e.g. `unauthorized` after the API key was revoked) sets the envelope to status `error` with that `errorCode` and **keeps polling** on the same schedule — `error` is not final, it recovers on the next successful pull; transient errors (`rate_limited`, `unavailable`) only push the next pull back;
- an envelope the vendor no longer knows (`not_found` twice in a row) is treated as voided at the vendor (Documenso deletes a cancelled document outright).

Statuses only move forward; a terminal status (`completed`, `declined`, `voided`, `expired`) never changes again.

### Collecting the signed copy

When an envelope completes, `esign.collect`:

1. downloads the signed PDF (and certificate, when separate) through the e-sign HTTP client — no redirects, 15-second timeout, at most `ESIGN_MAX_ARTIFACT_BYTES` for both together (default 25 MiB);
2. checks each file starts with `%PDF-`;
3. scans each with the install's virus scanner ([av-failure.md](../runbooks/av-failure.md)); a scanner that is down makes the job retry;
4. encrypts each with a per-workspace data key (purpose `esign-artifact`) and stores it at `ws/<workspace>/esign/<envelopeId>/signed.pdf` / `certificate.pdf`, recording its SHA-256;
5. records the acceptance (NDA) and publishes `esign.envelope_completed`, which the data room and round react to.

A collection that fails for good leaves the envelope `completed` **without** a copy and with an `errorCode` (`artifact_too_large`, `artifact_not_pdf`, `artifact_infected`, `artifact_<vendor error>`), audited and published as `esign.envelope_changed` with status `error`. An NDA acceptance is not recorded without a collected copy. **Resync** clears the error and collects again — except `artifact_infected`, which is final (security event `esign_artifact_infected`). Transient failures retry on their own and are re-queued every 15 minutes until they succeed.

Staff download copies from the envelope's detail dialog (`GET /esign/envelopes/{id}/signed.pdf`, `/certificate.pdf`; audited `esign.artifact_downloaded`). An investor downloads their own signed copies from the portal (`/esign/me/envelopes/{id}/signed.pdf`) — never anyone else's.

## Records, retention and erasure

- **Signed records are kept.** The kernel's encrypted copies are never deleted by FundRoom, and the vaulted data-room copies are on legal hold. The plan's retention floor for signed records is six years; that is your policy to enforce at workspace level too: deleting a workspace crypto-shreds its data keys, signed copies included, unless the workspace is under legal hold (**Legal & offering → Settings**). Export the workspace first ([tenant-export-and-deletion.md](../runbooks/tenant-export-and-deletion.md)).
- **Erasure** of a member (DSAR) pseudonymises the signer on every envelope that names them (by membership or email): name `Erased signer`, email `erased+<envelopeId>@erased.invalid`. Envelopes of that member still open (`sent`, `delivered`) are **voided at the vendor** by the next sweep (within about 5 minutes, reason `erasure`). New envelopes for an erased member are refused (`409`, reason `signer_erased`). Signed copies stay: they are records under legal hold, and **the signed PDF itself still shows the signer's name** as signed. The report counts `esignEnvelopesPseudonymised`.
- **The vendor's copy is not erased by FundRoom.** The vendor is your sub-processor and keeps its own envelope, signer data and audit trail under its retention settings. Handle erasure requests there too, following the vendor's DPA.
- **Access requests (DSAR export)** include `esign.json` (the member's envelopes: status, dates, the signed copy's SHA-256) and each signed PDF as `esign/<envelopeId>-signed.pdf`.
- **Workspace export** does not carry the connection (credentials) or the envelope register (bound to the vendor account). Signed copies travel only as vaulted data-room documents — so with the data room disabled they are not in the export; download them from **Settings → E-signature** first.

## ESIGN consent

In the US, the ESIGN Act (§101(c)) requires a consumer's consent to electronic records before they are used in place of paper. Before the first e-sign NDA envelope for a member, the portal shows this disclosure (version 1) with an unticked checkbox, and `POST /esign/nda/start` is refused with `422 esign_consent_required` unless `consentToElectronicRecords: true` and `disclosureVersion: 1` are sent:

> Consent to use electronic records and signatures
>
> By ticking the box you agree that the documents we ask you to sign may be provided to you electronically and that you will sign them electronically, through the e-signature service named on the button. Your electronic signature has the same legal effect as a handwritten one.
>
> You may ask for a paper copy of any document you sign, free of charge, by contacting the company that invited you. You may withdraw this consent at any time by telling them; withdrawing does not affect documents you have already signed, and you will then be offered another way to sign.
>
> To view and keep the documents you need a current web browser, an email address, and software that opens PDF files. You can download a copy of every document you sign from the portal.

The attestation stores `{disclosureVersion: 1, disclosureSha256}`. **The digest is of the English canonical text** (`packages/esign/src/consent.ts`), even when the portal shows a translation — one canonical text keeps the evidence comparable across locales. That is a deliberate deviation for counsel to review, as are these points:

- Withdrawal is handled by the company, outside the product: there is no withdrawal button, and "another way to sign" means staff switch the document back to click-wrap or arrange a paper signature.
- Round-closing envelopes are sent from the vendor's email without this in-portal consent; the vendor's own consumer disclosure (DocuSign, Dropbox Sign and others show one) applies there. Confirm with counsel that this is sufficient for your investors.

## The API

Key-callable with the `esign.read` scope ([API keys](../api/README.md)): `GET /esign/envelopes` (filters `status`, `purpose` = `nda`|`round_closing`, keyset `cursor`, `limit` ≤ 100) and `GET /esign/envelopes/{id}`. Everything else — the connection, downloads, void and resync — needs a signed-in admin. Round closing: `GET /round/rounds/{id}/closing` is key-callable with `round.read`; sending, voiding and confirming need a signed-in member with `round.manage`. Webhook topics `esign.envelope_changed`, `esign.envelope_completed`, `round.signature_completed` and `round.commitment_confirmed` are listed in [webhooks.md](../api/webhooks.md#topics).

Errors specific to e-signature:

| Status | `code` | Meaning |
|---|---|---|
| 409 | `esign_not_configured` | no active connection (sending, starting an NDA, choosing the E-signature ceremony) |
| 422 | `esign_template_unsupported` | the vendor cannot send this kind of document (template, or PDF: `reason: pdf_unsupported`) |
| 422 | `esign_credentials_rejected` | the vendor refused the credentials when saving (`reason`: `unauthorized`, `unreachable`, `misconfigured`) |
| 502 | `esign_provider_error` | the vendor refused or failed a call (`providerCode`: `unauthorized`, `not_found`, `rejected`, `rate_limited`, `unavailable`, `invalid_response`, `too_large`) |
| 409 | `envelope_not_open` | void on an envelope that is already terminal |
| 409 | `envelopes_open` | switching vendor or disconnecting while envelopes are open |
| 409 | `esign_ceremony_in_use` | disconnecting while a legal document uses the E-signature ceremony |
| 409 | `esign_required` | a click-wrap acceptance of a document whose ceremony is E-signature |
| 422 | `esign_consent_required` | NDA start without the ESIGN consent |
| 409 | `conflict` | `reason`: `envelope_creating` (void of an envelope still being created, < 15 min), `signer_erased`, `vendor_secret` (rotate on a vendor-secret driver); round: `signature_request_open`, `signature_request_pending`, `commitment_not_signable`, `commitment_not_wired`, `subscription_template_missing`, `round_not_open` |
| 422 | `signer_email_missing` | a round commitment names no member and no signer email was given |
| 403 | `forbidden` | `reason: embed_frame` — NDA start from inside an embedded portal |

## Troubleshooting

### Credentials rejected

`esign_credentials_rejected` on save, or connection status `error` after **Verify** (`lastError` says why):

- **`unauthorized`** — the vendor refused the token/key. Documenso: a revoked or expired API token, or a team token used for a personal account. DocuSeal: the key of another instance or region (a key for `api.docuseal.eu` is unknown to the US cloud). DocuSign: consent not granted yet (`consent_required`) or the wrong environment for the integration key (`invalid_grant`), a user id that is not a GUID from the same account, a private key that is not the app's. Dropbox Sign: a wrong or deleted API key.
- **`unreachable`** — the base URL could not be reached: DNS, TLS, a timeout, a redirect (never followed), or the outbound policy refused the address. A self-hosted instance on a private address must be listed in `ESIGN_ALLOW_PRIVATE_HOSTS`; `http://` is only accepted for a listed host.
- **`misconfigured`** — reachable, but not the API the adapter expects (a wrong path, a web app instead of the API).
- `validation_failed` reasons before any vendor call: `invalid_base_url`, `https_required`, `base_url_not_allowed` (outbound policy), `base_url_not_supported` (DocuSign, Dropbox Sign), `missing_field`, `invalid_option`, `driver_not_offered` (not in `ESIGN_DRIVERS`).

### Callbacks answer 401

Nothing is lost — status sync still converges within its schedule — but status changes arrive late. Check, in order: the URL is the one on **Settings → E-signature** now (a vendor switch changes it); the secret was pasted after the last rotation (Documenso secret field, DocuSeal header **name** `X-Fundroom-Signature` and value); DocuSign has *Include HMAC signature* on and the key here is a current Connect key; Dropbox Sign's API key here is the one the account uses; the self-hosted Documenso's clock is right (±5 minutes). The vendor's own webhook log shows what it sent and what it got back.

### Envelopes stuck in `sent` / `delivered`

Usually nobody has signed yet: the signer status in the envelope dialog (`pending`, `viewed`, `signed`) says so. Otherwise see the [runbook](../runbooks/esign.md#envelopes-stuck-in-sent-or-delivered): whether the sync cron is running, whether pulls are failing, and **Resync**.

### Orphaned drafts

If the process stopped between the vendor's answer and FundRoom recording it, the envelope stays `draft`; after 15 minutes the sweep marks it `error` with `errorCode` `orphaned_draft`. The vendor may still hold a document that was sent to the signer: find it in the vendor's dashboard by the envelope id (sent as its external id / metadata) and cancel it there, then void the envelope here and send again. For round closing, a claim left `pending` longer than 15 minutes is released by the next **Send for signature**.

### `artifact_*` error codes

| `errorCode` | Meaning | What to do |
|---|---|---|
| `artifact_too_large` | signed PDF + certificate exceed `ESIGN_MAX_ARTIFACT_BYTES` | raise the limit (operator, up to 100 MiB), restart, **Resync** |
| `artifact_not_pdf` | the vendor answered with something that is not a PDF | check the vendor's download (DocuSeal: file URLs must not redirect); **Resync** |
| `artifact_infected` | the scanner flagged the vendor's file | final; investigate with the vendor. Security event `esign_artifact_infected` |
| `artifact_unauthorized`, `artifact_not_found`, `artifact_rejected`, `artifact_invalid_response` | the vendor refused the download | fix credentials / vendor state, then **Resync** |
| `orphaned_draft` | see above | void, send again |
| `vendor_not_found` | first `not_found` from the vendor; a second one voids the envelope | none |
| an unsuffixed provider code (`unauthorized`, `rejected`, …) on an `error` envelope | a status pull failed for good | fix the cause; the next pull recovers it |

## Operator settings

| Key | Default | Meaning |
|---|---|---|
| `ESIGN_DRIVERS` | `documenso,docuseal,docusign,dropbox-sign` | Comma list of vendors workspace admins may connect. Removing one keeps existing connections working (sync, callbacks, collection), but they can no longer be saved or re-keyed with that vendor. |
| `ESIGN_ALLOW_PRIVATE_HOSTS` | empty | Hosts a self-hosted Documenso/DocuSeal may be reached on at a private address (and over plain `http`) — include the object-store host Documenso's presigned URLs point at. Independent of `OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]` and `WEBHOOK_ALLOW_PRIVATE_HOSTS`: vendor base URLs are chosen by workspace admins. With `APP_ENV=prod` or `staging` the server refuses to start if it lists `localhost`, a loopback or unspecified address, or a wildcard. A listed host skips every address check, so never list a name that could resolve to a link-local or metadata address. |
| `ESIGN_MAX_ARTIFACT_BYTES` | `26214400` (25 MiB) | Largest signed PDF plus certificate one envelope may have, 1 MiB–100 MiB. The e-sign client reads at most this + 64 KiB per response. |

The e-sign client is its own guarded HTTP client: https only (except listed hosts), no redirects, 15-second timeout, base URLs checked when saved and again on every call.

## Sub-processors

The vendor a workspace connects processes signer names, email addresses, the documents sent and the signing audit trail (IP addresses, timestamps) on the company's behalf, so it belongs on the workspace's sub-processor list (`packages/compliance/templates/sub-processors.md`). A self-hosted Documenso or DocuSeal is not a third party. The adapters declare:

| Provider | Purpose | Location | DPA | Certifications |
|---|---|---|---|---|
| Documenso, Inc. | Electronic signature of documents (envelopes, signer emails, audit certificate) | Documenso Cloud (vendor-operated); self-hosted: your own infrastructure | <https://documen.so/dpa> | SOC 2 |
| DocuSeal LLC | Electronic signature of documents (submissions, signer emails, audit log) | US (`api.docuseal.com`) or EU/Ireland (`api.docuseal.eu`); self-hosted: your own infrastructure | <https://www.docuseal.com/privacy/gdpr> | none stated |
| Docusign, Inc. | Electronic signature of documents (envelopes, signer identity and audit trail) | US, EU, Canada or Australia (the account's data region) | <https://www.docusign.com/legal/terms-and-conditions/data-protection-attachment> | ISO 27001, SOC 1 Type II, SOC 2 Type II |
| Dropbox, Inc. (Dropbox Sign) | Electronic signature of documents (signature requests, signer identity and audit trail) | United States | <https://assets.dropbox.com/documents/en/legal/hs-data-processing-agreement.pdf> | ISO 27001, SOC 2 Type II |

The list is not yet filled in automatically: add the row for the vendor you connect when you publish the sub-processor list, and give the 30-day notice the template describes before switching vendors.
