# DocuSign

Connect [DocuSign eSignature](https://www.docusign.com) as the workspace's e-signature vendor. FundRoom uses the eSignature REST API v2.1 with the **OAuth JWT grant** (a service integration that acts as one DocuSign user), and DocuSign Connect with HMAC for callbacks. General behaviour is in the [e-signature guide](README.md); endpoint-level detail is in the adapter's [README](../../packages/adapters/esign-docusign/README.md).

Start in the **developer sandbox** (environment `demo`, `account-d.docusign.com`); production needs DocuSign's go-live review and has its own keys and user ids.

## 1. Create the integration (Apps and Keys)

1. DocuSign (developer account for `demo`) → **Settings → Apps and Keys** → **Add App and Integration Key**.
2. Note the **Integration Key**.
3. Under **Authentication**, choose a service integration and **Generate RSA**. Copy the **private key** (the whole PEM block, `-----BEGIN RSA PRIVATE KEY-----` …) — DocuSign shows it once.
4. Add a **Redirect URI** (any URL you control, e.g. the portal's address): it is only used for the one-time consent below.
5. On the same page note the **User ID** (a GUID) of the user the integration acts as, and optionally the **API Account ID** (without it, that user's default account is used). Envelopes are sent in that user's name; use a dedicated user if you can.

## 2. Grant consent once

Signed in to DocuSign as that user, open (one line; use `account.docusign.com` for production):

```
https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<integration key>&redirect_uri=<the redirect URI>
```

Accept. Until this is done, saving the connection fails with `esign_credentials_rejected` (`unauthorized`; DocuSign says `consent_required`).

## 3. Set up Connect (callbacks)

1. **Settings → Connect → Connect Keys** (HMAC keys) → **Add Secret Key**. Copy it — you paste it into FundRoom in the next step.
2. **Settings → Connect → Add Configuration → Custom**:
   - **URL to publish**: the callback URL from FundRoom (**Settings → E-signature**; it appears after the first save — you can save with the HMAC key first and add this configuration right after);
   - **data format**: JSON (REST v2.1);
   - **events**: envelope sent, delivered, completed, declined, voided (recipient events optional);
   - **Include HMAC signature**: on;
   - apply it to all users of the account.

The configuration is account-wide, not per envelope. If several FundRoom workspaces share one DocuSign account, each needs its own Connect configuration (each has its own callback URL); callbacks about another workspace's envelopes are answered 200 and ignored.

## 4. Connect in FundRoom

**Settings → E-signature** → vendor **DocuSign**:

| Field | Value |
|---|---|
| Environment | `demo` (sandbox) or `production` |
| Integration key | from step 1 |
| User ID | from step 1 |
| Private key | the RSA private key PEM |
| Account ID | optional; the API Account ID to use |
| Connect HMAC key | the key from step 3 |
| Connect HMAC key (secondary) | optional; see rotation below |

Save. FundRoom requests a token, reads the account's base URI (it must be an `https://*.docusign.net` address) and verifies access before storing anything. There is no callback secret to copy: the HMAC key is DocuSign's.

## 5. Round closing: build the subscription template

1. **Templates → New** from your subscription agreement.
2. Add one recipient role whose name matches the round's **Template role** setting (default **`Signer`**; DocuSign refuses an unknown role), type *Needs to sign*, leaving name and email empty.
3. Place *Sign Here*, *Full Name* and *Date Signed* tabs for that role.
4. For each fact to prefill, add a **Text** tab for the `Signer` role and set its **Data Label** to the prefill name (e.g. `investor_name`, `amount`); make it read-only if the investor must not change it.
5. Copy the **Template ID** (a GUID, in the template's details).
6. In FundRoom, **Settings → Round** (`/admin/round/settings`), **Closing** card: set the subscription template reference to the Template ID and map each Data Label to a source.

## 6. NDA ceremony

FundRoom renders the NDA to PDF and places the tabs. With embedded signing the investor is a captive recipient: DocuSign sends no email, and the portal opens DocuSign's signing page and receives the investor back afterwards. Set the legal document's ceremony to **E-signature** under **Legal**.

## Going to production

Complete DocuSign's go-live review for the integration key, then in the production account repeat steps 1–4 (new integration key, keypair, user id, consent on `account.docusign.com`, Connect configuration and key) and save the connection with environment `production`. Changing credentials on the same vendor keeps the connection and its callback URL, but envelopes sent from the sandbox cannot be followed with production credentials: finish or void them first.

## Rotating the Connect HMAC key

DocuSign signs each callback with every active key, and FundRoom accepts a match with either of its two fields:

1. Add a new key in DocuSign (**Connect Keys → Add Secret Key**).
2. Paste it into *Connect HMAC key (secondary)* here and save (leave the other secret fields blank to keep them).
3. Move it into *Connect HMAC key*, clear the secondary field, save.
4. Delete the old key in DocuSign.

The RSA keypair rotates the same way on the DocuSign side: generate a second keypair on the app, paste the new private key here, save, then remove the old one.

## Good to know

- **Certificate**: DocuSign's certificate of completion is collected as a separate document.
- **Expiry**: DocuSign voids an envelope when it expires; FundRoom records that as `expired`.
- Several details (tab sizes on name/date tabs, the exact expiry reason text) are inferred from DocuSign's documentation and were not exercised against a live account before this release: test in the sandbox first.
