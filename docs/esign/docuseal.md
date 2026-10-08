# DocuSeal

Connect [DocuSeal](https://www.docuseal.com) — DocuSeal Cloud (US or EU) or your own instance — as the workspace's e-signature vendor. General behaviour is in the [e-signature guide](README.md); endpoint-level detail is in the adapter's [README](../../packages/adapters/esign-docuseal/README.md).

**Which edition?** Round closing (template envelopes) works on every edition. The **NDA ceremony needs DocuSeal Cloud or a Pro licence**: it sends a PDF (`/submissions/pdf`), which the open-source edition does not have — there, starting an NDA fails with `502 esign_provider_error` (`providerCode: rejected`, "DocuSeal Pro or Cloud required"). Keep NDAs on click-wrap, or pick another vendor, if you run the open-source edition.

## Before you start

- **Self-hosted**: the instance must be reachable from FundRoom over `https://`; a private address needs its host in `ESIGN_ALLOW_PRIVATE_HOSTS` (operator). Signed-document URLs must be served by the DocuSeal host (or a storage host reachable under the same rules) **without a redirect** — FundRoom follows none, so an instance that answers file URLs with a 302 to object storage fails collection with `artifact_invalid_response`.

## 1. Copy the API key

DocuSeal → **Settings → API** → copy the API key.

## 2. Connect in FundRoom

1. **Settings → E-signature** → vendor **DocuSeal**.
2. **Base URL**:
   - empty for DocuSeal Cloud US (`https://api.docuseal.com`);
   - `https://api.docuseal.eu` for DocuSeal Cloud EU (a key is only valid in its own region);
   - the app's address for self-hosted, e.g. `https://docuseal.example.com` (the API is under `/api`).
3. **API key**: paste it. Save; FundRoom verifies it before storing it.
4. Copy the **callback URL** and the **callback secret** (shown once; **Rotate callback secret** gives a new one).

## 3. Add the webhook in DocuSeal

1. DocuSeal → **Settings → Webhooks** → add the callback URL.
2. Events: `form.viewed`, `form.completed`, `form.declined`, `submission.completed`, `submission.expired`, `submission.archived`.
3. Add a **secret header**: key **`X-Fundroom-Signature`**, value = the callback secret. (Newer DocuSeal releases also offer their own signing key; FundRoom does not use it — the header is what it checks.) A webhook set up before the rename sends `X-Seedhost-Signature`; that header is still accepted and will stay accepted, so there is no need to touch it until you next rotate the secret. Then rename it.
4. Save. DocuSeal retries failed deliveries for up to 48 hours; FundRoom accepts those retries.

## 4. Round closing: build the subscription template

1. Create a **template** from your subscription agreement.
2. Rename its signing party to match the round's **Template role** setting, default **`Signer`** (DocuSeal's default first party is "First Party").
3. Place signature, name and date fields for that party.
4. For each fact to prefill, add a **text** field assigned to the same party and give it a **name**, e.g. `investor_name`, `amount`. The prefill mapping's names are DocuSeal field names; values go to the signer's own fields.
5. Note the template's numeric **id** (in its URL).
6. In FundRoom, **Settings → Round** (`/admin/round/settings`), **Closing** card: set the subscription template reference to the id and map each field name to a source.

## 5. NDA ceremony (Cloud / Pro)

FundRoom renders the NDA to PDF and places the fields; the investor signs on DocuSeal's signing page and is returned to the portal. Set the legal document's ceremony to **E-signature** under **Legal**. Before relying on it, sign one NDA yourself and check that the signature, name and date land in the boxes on the last page: the unit DocuSeal expects for field positions on PDF submissions is not publicly documented (see the adapter's confidence notes).

## Good to know

- **Certificate**: DocuSeal's audit log is collected as a separate certificate document.
- **Voiding** archives the submission in DocuSeal.
- **Rotating the API key**: create the new key, paste it here and save, then revoke the old one. Rotating FundRoom's callback secret invalidates the old one at once: update the `X-Fundroom-Signature` header straight after.
