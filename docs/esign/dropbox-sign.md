# Dropbox Sign

Connect [Dropbox Sign](https://sign.dropbox.com) (formerly HelloSign) as the workspace's e-signature vendor, through its API v3. General behaviour is in the [e-signature guide](README.md); endpoint-level detail is in the adapter's [README](../../packages/adapters/esign-dropbox-sign/README.md).

**No embedded signing.** A Dropbox Sign signing link only works inside Dropbox Sign's embedded iframe library on a domain registered to an API app, and FundRoom opens signing pages top-level. So every signer — NDA and round closing alike — receives the signing link **by email** from Dropbox Sign; the portal tells investors to check their inbox and opens the gate once the signature is recorded.

## 1. Copy the API key

Dropbox Sign → **Settings → API** → copy an API key (create one if there is none). Binding (non-test) requests need a paid API plan.

## 2. Connect in FundRoom

1. **Settings → E-signature** → vendor **Dropbox Sign**. There is no base URL: the API address is fixed, so the key can only ever be sent to Dropbox Sign.
2. **API key**: paste it.
3. **Mode**: `test` (non-binding, free; the default and what anything but `live` means) or `live` (legally binding).
4. Save; FundRoom verifies the key before storing it. There is no callback secret to copy: Dropbox Sign signs its callbacks with the API key. If the account has several API keys, use the one Dropbox Sign marks as primary — callbacks signed with a different key than the one stored here are refused (401), and only status sync keeps envelopes moving.

## 3. Set the account callback

1. On the same **Settings → API** page, set **Account callback** to the callback URL shown in FundRoom.
2. Dropbox Sign sends a test event; FundRoom answers it with `Hello API Event Received`, which Dropbox Sign requires.

The callback is **account-wide**: one Dropbox Sign account has one callback URL. If the account is also used by another integration, or by a second FundRoom workspace, only one of them receives callbacks; the other still converges through status sync (5 minutes, then backing off). Use one Dropbox Sign account per workspace if you can.

Dropbox Sign **clears the account callback URL after 10 consecutive failed deliveries**. FundRoom accepts retries for up to 72 hours, but if FundRoom was down for long, or the API key here no longer matches the account's, check that the callback URL is still set.

## 4. Round closing: build the subscription template

1. **Templates → Create a template** from your subscription agreement.
2. Add one signer role whose name matches the round's **Template role** setting (default **`Signer`**) — FundRoom sends that role name, and Dropbox Sign refuses a role the template does not have.
3. Place the signature, name and date fields for `Signer`.
4. For each fact to prefill, add a **text** field assigned to the **Sender** ("me, now") with a **merge field name**, e.g. `investor_name`, `amount`. The prefill mapping's names are those merge field names (sent as `custom_fields`).
5. Copy the **template id** (in the template's details).
6. In FundRoom, **Settings → Round** (`/admin/round/settings`), **Closing** card: set the subscription template reference to the id and map each merge field name to a source.

## 5. NDA ceremony

FundRoom renders the NDA to PDF and places the fields; Dropbox Sign emails the investor. Set the legal document's ceremony to **E-signature** under **Legal**. In `test` mode the signed NDA is marked as non-binding by Dropbox Sign — switch to `live` before inviting real investors.

## Good to know

- **Certificate**: Dropbox Sign appends its audit trail to the signed PDF; there is no separate certificate document.
- **Voiding** cancels the signature request in Dropbox Sign.
- **Rotating the API key** also changes how callbacks are signed: create the new key in Dropbox Sign, paste it here and save, then delete the old key. Callbacks signed with the old key in between are refused (401) and counted toward Dropbox Sign's 10-failure limit, so do both within minutes.
