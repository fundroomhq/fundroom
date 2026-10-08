# Webhooks

FundRoom can POST an event to your server when something happens in a workspace: an investor opened a document, an update went out, a commitment was recorded. Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com) specification, so any of its libraries can verify them.; to call the API back, see [API keys](README.md); for no-code platforms, see [Zapier and Make](zapier-make.md).

## Subscribing

Owners and admins (permission `webhooks.manage`) add endpoints under **Settings → Webhooks** (`/admin/webhooks`), or with `POST /webhooks/endpoints` from a signed-in session. Creating and deleting an endpoint, changing its URL and rotating its secret are step-up actions.

- **URL**: `https://` only, on a public host. Private and loopback addresses are refused, and redirects are not followed (self-hosters testing a local receiver: see [below](#self-hosting-local-receivers)). The URL is encrypted at rest and never shown again: the admin screen shows only the host and its last four characters, because a URL (a Zapier catch hook, say) is often a credential on its own.
- **Topics**: pick at least one from the table below. Only topics of modules enabled for your workspace are offered (`GET /webhooks/topics`).
- **Secret**: shown **once**, as `whsec_` followed by base64. Store it next to your receiver; it verifies every delivery.
- A workspace can have at most **20 endpoints**.

Send a test with **Send test** (or `POST /webhooks/endpoints/{id}/test`, at most 10 per minute per endpoint): it delivers a `webhook.ping` event whose `data` is `{ "endpointId": "…" }`, signed like any other delivery. `webhook.ping` cannot be subscribed to.

## Topics

Generated from the code (the manifests' `webhooks`, `EVENT_CATALOGUE` and `PERSON_LEVEL_WEBHOOK_TOPICS`) by `node scripts/render-webhook-topics.mjs`; do not edit the table by hand. "`data` fields" are the keys of the event payload as delivered — ids and small enumerations only, never names, email addresses or document titles. Internal identifiers are removed before a webhook leaves — session ids (`sessionId`) and global user ids (`userId`) never reach your endpoint; people are identified by their workspace `membershipId`. The "When" text is the internal catalogue description and may mention internal details.

<!-- BEGIN GENERATED: webhook topics (node scripts/render-webhook-topics.mjs) -->
| Topic | Module | When | `data` fields | Person-level |
|---|---|---|---|---|
| `access_request.submitted` | `access` | A public access request was verified and entered the approval queue. Ids only: the requester's name and address stay on `core.access_request`. | `accessRequestId` | no |
| `membership.created` | `access` | A membership became active in a workspace (invite accepted, SSO auto-join, host). | `membershipId`, `kind`, `role`, `source`, `inviteId` | no |
| `membership.revoked` | `access` | Memberships were revoked; subscribers purge caches, renditions, access. | `membershipIds`, `byMembershipId`, `reason` | no |
| `document.downloaded` | `data-room` | A document version was downloaded (original or watermarked). | `documentId`, `versionId`, `membershipId`, `variant` | yes |
| `document.viewed` | `data-room` | An investor opened a document version (compact audit copy; analytics gets the rich one). | `documentId`, `versionId`, `membershipId` | yes |
| `qa.answer_released` | `data-room` | An answer was released: to the asker only (`asker`) or published to everyone who can view the target (`target`). | `questionId`, `visibility`, `askerMembershipId` | no |
| `qa.question_asked` | `data-room` | An investor asked a data-room question about a document or folder. Staff holding `data-room.qa_manage` are alerted. | `questionId`, `targetKind`, `targetId`, `askerMembershipId` | no |
| `esign.envelope_changed` | `esign` | An e-signature envelope changed status: sent, delivered, completed, declined, voided, expired or error, as pulled from the vendor (a callback is only a wake-up). `subject*` is the soft reference the requesting module gave; modules react to their own subjects only. `membershipId` is the signer's membership, when they are a member. | `envelopeId`, `status`, `purpose`, `subjectModule`, `subjectKind`, `subjectId`, `membershipId` | no |
| `esign.envelope_completed` | `esign` | An e-signature envelope was completed AND its signed artifacts were collected, scanned and stored by the kernel. `data-room` vaults the signed copy; `round` marks the commitment signed. Published once per envelope. | `envelopeId`, `purpose`, `subjectModule`, `subjectKind`, `subjectId`, `membershipId` | no |
| `integration.booking_recorded` | `integrations` | A verified booking webhook (Calendly / Cal.com) recorded or updated a meeting. `crm` reads it through `ModuleServices.integrations.booking` and logs contact activity. | `bookingId`, `provider`, `status` | no |
| `integration.connection_unhealthy` | `integrations` | A third-party connection became unhealthy: `reauth_required` after the vendor refused its token (and a forced refresh did not help), or `degraded` after 3 consecutive failures. Published once per transition. `notify` alerts owners/admins and opted-in channels. | `connectionId`, `provider`, `status` | no |
| `metric.points_changed` | `metrics` | Metric points were written, imported or restated. The module subscribes to its own topic and recomputes every derived definition whose formula reads one of these, in dependency order; `wouldCycle` is what makes that cascade terminate. | `definitionIds` | no |
| `round.closed` | `round` | A round was closed. Terms and commitments stay readable as history; nothing is deleted. | `roundId` | no |
| `round.commitment_changed` | `round` | A commitment moved between soft, verbal, signed, wired and withdrawn. `crm` maps the status onto a pipeline stage; the amount is deliberately not here. | `commitmentId`, `roundId`, `status` | no |
| `round.commitment_confirmed` | `round` | Staff confirmed a wired commitment: the money arrived and was reconciled. `notify` sends the investor a confirmation when the commitment names a member (`membershipId`). | `roundId`, `commitmentId`, `membershipId` | no |
| `round.commitment_created` | `round` | A commitment was recorded against a round. The subject is whichever of the four the commitment names — a member, a CRM contact, an organisation, or none of them (a display-name-only commitment, which carries no id at all). | `commitmentId`, `roundId`, `membershipId`, `contactId`, `organizationId` | no |
| `round.interest_submitted` | `round` | A member indicated interest in the open round. Staff are alerted through `notify`; `crm` ensures a contact and a pipeline card. | `submissionId`, `roundId`, `membershipId` | no |
| `round.opened` | `round` | A round was opened for interest. At most one round per workspace is open at a time. | `roundId` | no |
| `round.signature_completed` | `round` | A commitment's subscription agreement was signed through the workspace's e-sign vendor. Published by `round` after it mirrored the completed envelope and moved the commitment to `signed`; `notify` alerts staff. `membershipId` is the commitment's member, when it names one (as on `round.commitment_created`). | `roundId`, `commitmentId`, `envelopeId`, `membershipId` | no |
| `round.verification_decided` | `round` | An accreditation verification was settled. `verified` means the kernel now holds an `accredited` attestation for the member, written through `ModuleServices.legal`. | `verificationId`, `membershipId`, `status` | no |
| `round.verification_requested` | `round` | A 506(c) accreditation verification was opened for a member. Staff are alerted through `notify`; the evidence itself never leaves the round module. | `verificationId`, `membershipId`, `submissionId` | no |
| `update.published` | `updates` | An investor update was published / sent. | `postId`, `versionId`, `audienceGroupIds` | no |
| `update.sent` | `updates` | A send of an investor update finished fanning out (live or test). | `postId`, `sendId`, `kind`, `sent`, `failed` | no |
| `update.viewed` | `updates` | A member opened a sent investor update in the web archive. | `postId`, `versionId`, `membershipId` | yes |
<!-- END GENERATED: webhook topics -->

### Person-level topics and consent

`document.viewed`, `document.downloaded` and `update.viewed` describe what one identifiable person did. They are delivered only when person-level engagement tracking is allowed for that member at the moment the event is fanned out — the same rule the portal's own analytics apply (the workspace's tracking mode, and the member's consent where the workspace asks for it) — and never for a member whose data has been erased. When the rule says no, no delivery is created at all; nothing is queued for later. Your endpoint therefore sees fewer of these events than the portal records, by design: do not treat a missing `document.viewed` as "not opened".

If you forward these events to a CRM or a data warehouse, you become responsible for that copy (retention, erasure requests). Subscribe only to what you need.

### E-signature topics

`esign.envelope_changed` reports what FundRoom pulled from the e-sign vendor, not what the vendor's callback said, so it can arrive minutes after the signer acted (the vendor's callback only wakes a status pull; see the [e-signature guide](../esign/README.md)). `status` `error` is **not final**: it is sent when a status pull fails permanently (the envelope recovers on a later successful pull), and also when a completed envelope's signed copy could not be collected — the envelope still reads `completed` in the API, with an `errorCode` such as `artifact_too_large`. Treat `esign.envelope_completed` as the only "signed and stored" signal: it is published once per envelope, after the signed PDF was downloaded, scanned and encrypted. `round.signature_completed` follows it for subscription agreements.

## The request

```http
POST /your/endpoint HTTP/1.1
content-type: application/json
user-agent: FundRoom-Webhooks/1
webhook-id: 01929c5e-7b1a-7c3e-9f00-5a7d2c1b9e42
webhook-timestamp: 1759017600
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"id":"01929c5e-7b1a-7c3e-9f00-5a7d2c1b9e42","eventId":"8412","type":"update.published","timestamp":"2026-09-28T00:00:00.000Z","workspaceId":"0191f0c4-…","data":{"postId":"…","versionId":"…","audienceGroupIds":["…"]},"schemaVersion":1}
```

| Header | Value |
|---|---|
| `webhook-id` | The delivery id. The same on every automatic retry of this delivery. Equals the body's `id`. |
| `webhook-timestamp` | Unix seconds when this attempt was sent (changes on each retry). |
| `webhook-signature` | Space-separated `v1,<base64 signature>` entries — two while a rotated secret's overlap window is open. |

The body:

| Field | Meaning |
|---|---|
| `id` | The delivery id (= `webhook-id`). A manual redelivery gets a new one. |
| `eventId` | The event's id: the same on every delivery of this event to this endpoint, **including manual redeliveries**. An opaque string; test pings use `ping:<uuid>`. |
| `type` | The topic, e.g. `update.published`, or `webhook.ping`. |
| `timestamp` | ISO 8601 time the event happened (not when it was sent). |
| `workspaceId` | The workspace the event belongs to. |
| `data` | The event payload: the fields in the topic table (session and user identifiers removed). |
| `schemaVersion` | The version of the payload's shape. It only changes when a payload changes incompatibly; handle versions you know and log the rest. |

Payloads carry **ids only**. To turn `postId` into a title, or `membershipId` into a name, call the API with a key that has the right read scope (see [below](#fetching-details)).

## Verifying the signature

The signature is an HMAC-SHA256 over `"{webhook-id}.{webhook-timestamp}.{raw body}"`, keyed with the **base64-decoded** part of the secret after `whsec_`, base64-encoded. Verify every request before trusting it, and:

- verify the **raw body bytes** exactly as received — parsing and re-serialising the JSON changes them and the signature will not match;
- reject a `webhook-timestamp` more than **5 minutes** from your clock (either direction) to stop replays;
- accept the request if **any** `v1,` entry matches (secret rotation sends two), compare in constant time, ignore entries with other version prefixes.

### Node, with the SDK

`@fundroom/sdk` ships the verifier (WebCrypto only; runs on Node ≥ 20, Deno, Bun and edge runtimes such as Cloudflare Workers). It is also available alone as `@fundroom/sdk/webhooks`.

```ts
import { verifyWebhook, WebhookVerificationError, type FundRoomWebhookEvent } from "@fundroom/sdk";

// Any framework: read the raw body, then verify.
export async function handle(request: Request): Promise<Response> {
  const body = await request.text();
  try {
    await verifyWebhook({ headers: request.headers, body, secret: process.env.FUNDROOM_WEBHOOK_SECRET! });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response(e.reason, { status: 400 });
    throw e;
  }
  const event = JSON.parse(body) as FundRoomWebhookEvent;
  await enqueue(event); // do the work after answering
  return new Response(null, { status: 204 });
}
```

With Express, use `express.raw({ type: "application/json" })` on the webhook route and pass `req.body` (a `Buffer`) and `req.headers`. `verifyWebhook` resolves to `{ id, timestamp }` and throws `WebhookVerificationError` with a `reason` of `missing_headers`, `invalid_secret`, `invalid_timestamp`, `timestamp_too_old`, `timestamp_too_new` or `no_matching_signature`. `toleranceSeconds` (default 300) and `now` are optional. `signPayload({ id, timestamp, body, secrets })` produces a valid header for your own tests.

### Node, with `node:crypto` only

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody /* Buffer */, headers, secret) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];
  if (!id || !ts || !signatures) throw new Error("missing webhook headers");
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    throw new Error("webhook timestamp outside tolerance");
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.`).update(rawBody).digest();
  for (const entry of signatures.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return JSON.parse(rawBody.toString("utf8"));
    }
  }
  throw new Error("no matching webhook signature");
}
```

### Python

The official library: `pip install standardwebhooks`, then `Webhook(secret).verify(raw_body, headers)`. Without it:

```python
import base64, hashlib, hmac, json, time

def verify(raw_body: bytes, headers, secret: str) -> dict:
    msg_id = headers["webhook-id"]
    ts = headers["webhook-timestamp"]
    signatures = headers["webhook-signature"]
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        raise ValueError("webhook timestamp outside tolerance")
    key = base64.b64decode(secret.removeprefix("whsec_"))
    mac = hmac.new(key, f"{msg_id}.{ts}.".encode() + raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode()
    for entry in signatures.split(" "):
        version, _, sig = entry.partition(",")
        if version == "v1" and hmac.compare_digest(sig, expected):
            return json.loads(raw_body)
    raise ValueError("no matching webhook signature")
```

In Flask the raw body is `request.get_data()`; in Django, `request.body`; in FastAPI, `await request.body()`.

### PHP

The official library: `composer require standard-webhooks/standard-webhooks`, then `(new \StandardWebhooks\Webhook($secret))->verify($payload, $headers)`. Without it:

```php
<?php
$raw = file_get_contents('php://input');
$id = $_SERVER['HTTP_WEBHOOK_ID'] ?? '';
$ts = $_SERVER['HTTP_WEBHOOK_TIMESTAMP'] ?? '';
$signatures = $_SERVER['HTTP_WEBHOOK_SIGNATURE'] ?? '';

if ($id === '' || !ctype_digit($ts) || abs(time() - (int) $ts) > 300) {
    http_response_code(400);
    exit;
}
$key = base64_decode(preg_replace('/^whsec_/', '', getenv('FUNDROOM_WEBHOOK_SECRET')), true);
$expected = base64_encode(hash_hmac('sha256', "{$id}.{$ts}.{$raw}", $key, true));

$ok = false;
foreach (explode(' ', $signatures) as $entry) {
    [$version, $sig] = array_pad(explode(',', $entry, 2), 2, '');
    if ($version === 'v1' && hash_equals($expected, $sig)) {
        $ok = true;
        break;
    }
}
if (!$ok) {
    http_response_code(400);
    exit;
}
$event = json_decode($raw, true);
http_response_code(204);
```

## Responding, retries and the dead-letter list

Answer with any **2xx within 10 seconds**, then do the work (queue it). The status code is what counts: FundRoom reads at most 64 KiB of your response body (a longer body is simply ignored, and a 2xx is still a success) and keeps a short printable excerpt for the delivery log.

- **2xx**: delivered.
- **410 Gone**: the endpoint is **disabled at once** (reason `gone`) — the way to say "stop sending" without signing in.
- **Anything else** — another 4xx or 5xx, a 3xx (redirects are not followed), a timeout, a network or TLS error — is a failure and is retried after **30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h and 24 h** (ten attempts over about 47 hours). A `Retry-After` header on your response is honoured, up to one hour.
- After the last attempt the delivery is **failed**. Failed deliveries are the dead-letter list: **Settings → Webhooks → endpoint → Failed**, or `GET /webhooks/deliveries?status=failed` (callable with an API key that has the `webhooks.read` scope, so a script can reconcile). Each shows the status code, a short error, the response excerpt and the payload.
- **Redeliver** (`POST /webhooks/deliveries/{id}/redeliver`, 60 per hour per workspace, the endpoint must be enabled) sends the same `eventId`, `type` and `data` again as a **new delivery with a new `webhook-id`**. Whether it is processed again depends on what you deduplicate on (below). A redelivery is refused with `409 conflict` when it would no longer be sent today: reason `endpoint_disabled` (re-enable first), `topic_unavailable` (the endpoint is no longer subscribed, or the module is disabled), or, for person-level topics, `tracking_not_allowed` (consent withdrawn) or `subject_erased` (the member's data was erased).
- **Cancellation**: a pending delivery is cancelled rather than retried when it would no longer be sent — the endpoint stops subscribing to its topic, the module is disabled for the workspace, or, for person-level topics, the member withdraws tracking consent or their data is erased. Cancelled deliveries appear in the log with status `cancelled`.
- **Auto-disable**: when **20 deliveries in a row** end up failed, the endpoint is disabled (reason `failing`), its queued deliveries are cancelled and the change is audited. Fix the receiver, then re-enable the endpoint (which resets the count) and redeliver what you missed.

Delivery is **at least once** and **not ordered**: the same delivery can arrive twice (for instance when your 2xx was lost on the way back), and a retry of an older event can arrive after a newer one. When order matters, compare `timestamp` or fetch the current state from the API instead of trusting the event sequence. Delivery records are kept for **30 days**.

Deduplication — pick the key that matches what you want:

- **Dedupe on `eventId`** if you want **at-most-once processing** of each event, even when an admin redelivers it by hand. This is the right default for anything that creates records (a CRM row, a ticket, a Slack message).
- **Dedupe on `webhook-id`** (the Standard Webhooks convention) if a manual redelivery should be processed again — for example to repair a receiver that accepted the first delivery but lost the work.

## Rotating the secret

**Rotate secret** (or `POST /webhooks/endpoints/{id}/rotate-secret { "graceHours": 24 }`, 0–168) shows a new secret once. Until the grace period ends, every delivery carries two signatures — the new secret's first, the old one's second — so a receiver still configured with either secret verifies. Deploy the new secret within the window; with `graceHours: 0` the old secret stops at once.

Only one overlap window at a time: rotating again while the previous secret is still valid is refused with `409 conflict` (reason `rotation_in_progress`), because a third secret would silently drop the one your receiver may still use. Wait for the window to end, or rotate with `graceHours: 0` to end it now (only the newest secret then signs).

## Self-hosting: local receivers

A self-hosted install refuses webhook URLs that resolve to private, loopback or link-local addresses, and plain `http://`, because a workspace admin (not the operator) chooses the URL and could otherwise probe your internal network. The general outbound allow-list (`OUTBOUND_HTTP_ALLOW_PRIVATE`, `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS`) does **not** apply to webhooks.

To test against a receiver on your own network, name it in **`WEBHOOK_ALLOW_PRIVATE_HOSTS`** (comma-separated hostnames or IP literals, empty by default), e.g. `WEBHOOK_ALLOW_PRIVATE_HOSTS=hooks.internal,10.0.0.7`. Only the hosts listed may be reached on a private address, and over plain `http`. With `APP_ENV=prod` or `staging` the server refuses to start if the list contains `localhost`, a loopback or unspecified address, or a wildcard: a tenant could then point a webhook at the instance itself. For a receiver on the same machine during development, run with another `APP_ENV` (e.g. `dev`), or expose the receiver through a tunnel with a public https URL. A listed host skips **every** address check — whatever its name resolves to is reached — so never list a name that could resolve to a link-local or cloud-metadata address (`169.254.0.0/16`, `fe80::/10`, `169.254.169.254`); prefer IP literals you control.

## Fetching details

Payloads carry ids; a [workspace API key](README.md) turns some of them into records. Not every id has a route a key may call — keys reach only the routes marked in the "API key" column of [`docs/authz-matrix.md`](../authz-matrix.md), and routes that serve investors (document contents, folder listings) are deliberately not among them. As of this release:

| Topic | What a key can look up | What it cannot |
|---|---|---|
| `membership.created` | the person: `GET /access/people/{membershipId}` (`access.read`) | — |
| `membership.revoked` | each person: `GET /access/people/{id}` for `membershipIds` (`access.read`), while the record exists | a person whose data has since been erased |
| `access_request.submitted` | nothing | the request itself: approve or deny it in the portal (**People → Requests**) |
| `document.viewed`, `document.downloaded` | the document's versions: `GET /data-room/documents/{documentId}/versions` (`data-room.read`); the person: `GET /access/people/{membershipId}` (`access.read`) | the document's metadata and folder, and its contents (investor-facing routes) |
| `qa.question_asked`, `qa.answer_released` | the question: `GET /data-room/qa/inbox/{questionId}` (`data-room.read`) | the target document or folder by `targetId` beyond its versions |
| `update.published`, `update.sent`, `update.viewed` | the update: `GET /updates/posts/{postId}` (`updates.read`); for `update.viewed`, the person (`access.read`) | per-send delivery statistics (`sendId`) |
| `round.opened`, `round.closed` | `GET /round/rounds` (`round.read`), then pick `roundId` | a single round by id |
| `round.commitment_created`, `round.commitment_changed` | `GET /round/rounds/{roundId}/commitments` (`round.read`), then pick `commitmentId`; a linked contact: `GET /crm/contacts/{contactId}` (`crm.read`) | a single commitment by id; an organisation by `organizationId` |
| `round.interest_submitted` | `GET /round/rounds/{roundId}/interest` (`round.read`); the person (`access.read`) | a single submission by id |
| `round.signature_completed`, `round.commitment_confirmed` | the round's closing checklist: `GET /round/rounds/{roundId}/closing` (`round.read`), then pick `commitmentId`; for `round.signature_completed`, the envelope: `GET /esign/envelopes/{envelopeId}` (`esign.read`) | the signed PDF (download it in the portal: **Settings → E-signature**) |
| `esign.envelope_changed`, `esign.envelope_completed` | the envelope: `GET /esign/envelopes/{envelopeId}` (`esign.read`) — status, signer, `subject`; for `subjectModule` `round`, `subjectId` is the commitment (`round.read` as above); the person (`access.read`) | the signed PDF and certificate; `purpose` `nda` envelopes' legal document by id |
| `round.verification_requested`, `round.verification_decided` | the person: `GET /access/people/{membershipId}` (`access.read`) | the verification itself, its provider and its evidence (portal: **Round → Verifications**; see [accreditation](../accreditation/README.md)) |
| `metric.points_changed` | `GET /metrics/definitions/{id}/points` for each of `definitionIds` (`metrics.read`) | — |

```sh
curl -sS "https://investors.acme.com/api/v1/updates/posts/$POST_ID" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
```

If a lookup you need is missing, the event still tells you *that* something happened and *which* record it was; the portal shows the rest.
