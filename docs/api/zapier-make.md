# Zapier and Make

FundRoom has no Zapier or Make app of its own, and does not need one: both platforms can receive a [webhook](webhooks.md), check its signature and call the [API](README.md) back with a key. The pattern is the same on both:

1. **Receive** the event on a catch-hook URL.
2. **Verify** the `webhook-signature` against the **raw body** — before anything else happens.
3. **Fetch details** with an API key, because payloads carry ids only.
4. Do the useful thing (a Slack message, a CRM row, a spreadsheet line).

Two facts shape the recipes:

- **A catch-hook URL is a secret.** Anyone who has it can post to your Zap or scenario. FundRoom encrypts the URL at rest and never shows it again after you save it (only the host and last four characters). You still verify the signature, because the URL can leak from the platform's side too.
- **The signature covers the exact bytes sent.** Verify the *raw* body. A step that parses the JSON and re-serialises it produces different bytes and the signature will never match.

Before you start, create:

- a **webhook endpoint** for the topics you want (Settings → Webhooks), pasting the platform's URL, and copy its `whsec_…` secret;
- an **API key** (Settings → API keys) with only the read scopes the recipe needs, e.g. `updates.read` to look up an update.

Keep both in the platform's secret storage where it has one, never in a step's visible notes.

## Zapier

### 1. Trigger: Webhooks by Zapier → Catch Raw Hook

Use **Catch Raw Hook**, not Catch Hook: Catch Hook parses the body and throws the original bytes away. Copy the hook URL into the FundRoom endpoint, then press **Send test** on the endpoint so Zapier has a sample (`webhook.ping`). The trigger's output has the body as **Raw Body** and the request headers, including `Webhook-Id`, `Webhook-Timestamp` and `Webhook-Signature` (Zapier capitalises header names).

### 2. Action: Code by Zapier → Run JavaScript

Input data (map each from the trigger):

| Name | Value |
|---|---|
| `body` | Raw Body |
| `id` | the `Webhook-Id` header |
| `timestamp` | the `Webhook-Timestamp` header |
| `signature` | the `Webhook-Signature` header |
| `secret` | your `whsec_…` secret |

Code:

```js
const crypto = require("crypto");

const { body, id, timestamp, signature, secret } = inputData;
const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

const verified =
  /^\d+$/.test(timestamp) &&
  ageSeconds <= 300 &&
  signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });

const event = verified ? JSON.parse(body) : {};
output = {
  verified,
  deliveryId: id,
  eventId: event.eventId ?? "",
  type: event.type ?? "",
  postId: event.data?.postId ?? "",
  membershipId: event.data?.membershipId ?? "",
};
```

Add the `data` fields your topic carries (see the [topic table](webhooks.md#topics)) to `output`.

### 3. Filter by Zapier

Only continue if **verified** is **(Boolean) is true**. Optionally also filter on **type** (one endpoint can carry several topics) and skip `webhook.ping`.

Zapier does not deduplicate for you: FundRoom delivers at least once, so if a duplicate would hurt (a second CRM row), look up the **`eventId`** in a Zapier Storage or Tables step first and stop when it is already there. `eventId` stays the same when an admin redelivers an event by hand; `deliveryId` (`webhook-id`) does not. See [deduplication](webhooks.md#responding-retries-and-the-dead-letter-list).

### 4. Action: Webhooks by Zapier → GET

- **URL**: `https://investors.acme.com/api/v1/updates/posts/{{postId}}` (or whichever key-callable route turns your ids into details — [Fetching details](webhooks.md#fetching-details) lists which topics have one; `access_request.submitted`, for example, has none).
- **Headers**: `Authorization` = `Bearer frk_…`.

The response fields are available to the following steps. A `401` with `api_key_not_allowed` means that route does not accept keys; `403 scope_missing` means the key lacks the scope. See the [errors table](README.md#errors).

## Make

### 1. Trigger: Webhooks → Custom webhook

Add a webhook, and under **Show advanced settings** turn on **Get request headers** and **JSON pass-through**, so the body arrives as the exact text that was signed instead of a parsed bundle. Paste the webhook address into the FundRoom endpoint and press **Send test** so Make can learn the structure.

### 2. Verify with a Filter

Make's `sha256` function computes an HMAC when given a key, which is all the check needs. On the link after the webhook, add a filter with two conditions (map the header values from the trigger's **Headers** array and the raw body from **value**):

1. Signature matches — **Text operators: Contains (case sensitive)**:
   - value: the `webhook-signature` header
   - contains: `v1,{{sha256(webhook-id + "." + webhook-timestamp + "." + value; "base64"; substring(SECRET; 6); "base64")}}`

   (`substring(SECRET; 6)` drops the `whsec_` prefix; the last argument says the key is base64. Build the first argument with Make's text concatenation of the three mapped values and the two dots.)
2. Fresh — **Numeric operators: Less than or equal to**:
   - value: `{{abs(formatDate(now; "X") - webhook-timestamp)}}`
   - 300

Store the secret in a Make data store or a scenario variable rather than typing it into the filter. A "contains" comparison is not constant-time; for a no-code scenario that is an accepted trade-off, and the timestamp check still limits replays.

### 3. Parse and fetch

- **JSON → Parse JSON** on **value** to get `type` and `data`.
- **HTTP → Make a request**: method `GET`, URL `https://investors.acme.com/api/v1/updates/posts/{{data.postId}}`, header `Authorization: Bearer frk_…`, **Parse response** on.

To deduplicate, keep the body's `eventId` in a data store and stop the route (a filter on "record exists") when it has been seen. Use `eventId` rather than the `webhook-id` header: it survives a manual redelivery, so a redelivered event is not processed twice.

## When deliveries stop

If your Zap or scenario is turned off, the platform usually answers with an error or `410 Gone`. A `410` disables the FundRoom endpoint at once; other errors are retried for about two days and then land in the endpoint's **Failed** list, and 20 failed deliveries in a row disable it. Turn the Zap back on, re-enable the endpoint, and **Redeliver** what you missed. A poller that must not miss anything can also reconcile on its own: `GET /webhooks/deliveries?status=failed` accepts an API key with the `webhooks.read` scope. Details: [webhooks — responding and retries](webhooks.md#responding-retries-and-the-dead-letter-list).
