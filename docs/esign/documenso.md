# Documenso

Connect [Documenso](https://documenso.com) — Documenso Cloud or your own instance — as the workspace's e-signature vendor. Documenso supports everything FundRoom uses: PDF envelopes (the NDA ceremony), templates (round closing) and embedded signing. General behaviour is in the [e-signature guide](README.md); endpoint-level detail is in the adapter's [README](../../packages/adapters/esign-documenso/README.md).

FundRoom uses Documenso's **public API v1**. Documenso still serves it but is moving to v2; see the note in the guide.

## Before you start

- **Cloud**: a Documenso account (a team account if several people will manage templates).
- **Self-hosted**: the instance must be reachable from FundRoom over `https://`. If it sits on a private address, the operator lists its host in `ESIGN_ALLOW_PRIVATE_HOSTS`. The v1 API uploads and downloads files through **presigned object-store URLs**, so the instance must use S3-compatible (or Azure) upload transport (`NEXT_PUBLIC_UPLOAD_TRANSPORT=s3`) — with database transport, downloads of signed documents fail — and FundRoom must be able to reach that object-store host too (list it as well if it is private).
- The Documenso host's clock must be correct: its callbacks carry a per-delivery timestamp and FundRoom refuses those more than 5 minutes off.

## 1. Create an API token

1. In Documenso, open **Settings → API Tokens** (for a team: the team's settings → **API Tokens**). A team token acts for the team, and the envelopes and templates it can see are the team's.
2. Create a token (name it e.g. "FundRoom"; choose no expiry, or note the date to rotate it). Copy it — it starts with `api_`.

## 2. Connect in FundRoom

1. **Settings → E-signature** → vendor **Documenso**.
2. **Base URL**: leave empty for Documenso Cloud (`https://app.documenso.com`); for self-hosted, the instance's address, e.g. `https://sign.example.com`.
3. **API token**: paste the token. Save (you are asked to confirm your identity if your sign-in is not fresh). FundRoom verifies the token against Documenso before storing it.
4. Copy the **callback URL** and the **callback secret** shown once after saving. If you lose the secret, use **Rotate callback secret** and paste the new one in step 3.

## 3. Add the webhook in Documenso

1. **Settings → Webhooks** (team settings for a team token) → **Create webhook**.
2. **Webhook URL**: the callback URL from FundRoom.
3. **Secret**: the callback secret from FundRoom (Documenso sends it back as `X-Documenso-Secret`).
4. **Events**: document opened, signed, completed, rejected and cancelled. More events do no harm; each one only triggers a status pull.
5. Save. There is nothing to test from FundRoom's side: status sync works without callbacks, callbacks only make it faster. Documenso's webhook log shows each delivery's response (200 = accepted, 401 = wrong secret or skewed clock).

## 4. Round closing: build the subscription template

1. In Documenso, create a **template** from your subscription agreement.
2. Add exactly one signing recipient placeholder and name it to match the round's **Template role** setting, default **`Signer`** (matched case-insensitively; a template with a single recipient also accepts it under any name).
3. Place the signer's signature, name and date fields.
4. For each fact FundRoom should fill in, add a **text** (or number) field and give it a **label** — e.g. `investor_name`, `amount`, `valuation_cap`. A prefill name that matches a text/number field label fills that field; any other name is sent as a PDF form value (for a PDF with AcroForm fields, the form field's name).
5. Note the template's numeric **id** (in its URL, `…/templates/<id>`).
6. In FundRoom, **Settings → Round** (`/admin/round/settings`), **Closing** card: set the subscription template reference to that id, and map each field label to a source (`investor_name`, `investor_email`, `amount`, `round_name`, `company_name`, `valuation_cap`, `date`).

Send one commitment to yourself first and check the fields.

## 5. NDA ceremony

No template is needed: FundRoom renders the NDA to PDF and places the signature, name and date fields itself. Investors sign on Documenso's signing page and are returned to the portal afterwards. Set the legal document's ceremony to **E-signature** under **Legal**.

## Good to know

- **Certificate**: Documenso seals its signing certificate into the signed PDF, so there is no separate certificate document.
- **Voiding** an open envelope deletes the pending document in Documenso (v1 has no "cancelled" state); FundRoom then records it as voided. A completed or rejected document is never deleted.
- **No idempotent create**: if FundRoom stops between Documenso's answer and recording it, the document may exist in Documenso while FundRoom shows `orphaned_draft`. Find it by its external id (the FundRoom envelope id) and delete it in Documenso ([troubleshooting](README.md#orphaned-drafts)).
- **Rotating the API token**: create the new token, paste it in FundRoom (the other fields stay), save, then delete the old token in Documenso.
