# @fundroom/integration-calendly

`IntegrationAdapter` for Calendly booking webhooks over a personal access token.
Meetings booked, cancelled or rescheduled through the workspace's Calendly links are recorded in
`core.integration_booking` (and logged by CRM). Stateless: the kernel owns the connection and the
signing key. Runtime dependency: `@fundroom/ports` only (+ `node:crypto`); every call goes through
the injected, SSRF-guarded `deps.fetch` with `redirect: "manual"`; responses over 2 MiB are `too_large`.

## Endpoints used

API root `https://api.calendly.com`, `Authorization: Bearer <personal access token>`.

| Adapter method | Calendly call | Confidence |
|---|---|---|
| `verify` | `GET /users/me` → `resource.name` as the label, `resource.uri` as `externalAccountId` | verified (OpenAPI) |
| `booking.subscribe` | `GET /users/me` (for `current_organization`), then `POST /webhook_subscriptions` `{url, events: ["invitee.created","invitee.canceled"], organization, user, scope: "user", signing_key}` → `resource.uri` is the `subscriptionId` | verified (OpenAPI) |
| `booking.unsubscribe` | `DELETE /webhook_subscriptions/{uuid}` (uuid = last path segment of the stored uri; the URL is always rebuilt on our API root); 404 is success; best effort | verified (OpenAPI) |
| `booking.parseWebhook` | inbound `POST` with `Calendly-Webhook-Signature` | verified (webhook signature docs) |

Sources: Calendly's OpenAPI document (<https://developer.calendly.com/openapi/calendly-api.yaml>)
and the developer docs (webhook signatures).

## Webhook verification

Header `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing key, "<t>.<raw body>")>`
(read case-insensitively). The HMAC runs over the exact raw bytes; any `v1` entry (up to 5) may
match, compared with `crypto.timingSafeEqual`; unknown schemes are ignored; a malformed, missing
or oversized (> 1 000 chars) header, a mismatch, or `|now − t| > 5 min` is `unauthorized`. The
signature is checked before the timestamp, and nothing in the body is parsed before both pass.

## Mapping notes

- `invitee.created` → `booked`; `invitee.canceled` → `cancelled`, or `rescheduled` when
  `payload.rescheduled === true` (Calendly then sends `invitee.created` for the new invitee, which
  becomes a separate `booked` row). Other events (`invitee_no_show.*`, `routing_form_submission.*`,
  …) → `{ok: true, value: []}`.
- `externalId` = `payload.uri` (the invitee uri, ≤ 300), `inviteeEmail` = `payload.email` (≤ 320,
  must look like an email), `inviteeName` = `payload.name`, `startsAt`/`endsAt` =
  `payload.scheduled_event.start_time`/`end_time`, `eventName` = `payload.scheduled_event.name`.
  Names are trimmed to 200 characters. A verified body missing the uri, email or start time is
  `malformed`.
- Errors: 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 429 `rate_limited`, 5xx
  `unavailable`, other 4xx `malformed` (a 409 on subscribe: "a webhook subscription for this URL
  already exists"). A detail carries only Calendly's error `title` when it is plain words — never
  the token.

## Deviations / inferred

- **Paid plan**: Calendly only allows webhook subscriptions on paid plans (Standard and above); a
  403 on subscribe is reported as `forbidden` "paid plan and webhooks:write scope required".
- **Token scopes**: the OpenAPI lists required scopes per endpoint (`users:read`,
  `webhooks:write`, `scheduled_events:read` for invitee events); we infer that scoped personal
  access tokens need exactly these.
- `organization` is sent alongside `user` for `scope: "user"` (the OpenAPI marks only `url` and
  `events` required; Calendly's guides have always sent both).
- The test seam `createCalendlyAdapter(deps, {apiBaseUrl})` rebases the API root for
  `ContainerOptions.integrationAdapters`.

## Admin setup (vendor side)

1. Calendly → **Integrations & apps → API and webhooks → Personal access tokens** → generate a
   token (scopes above) and paste it into FundRoom's Calendly connect form.
2. FundRoom creates the webhook subscription itself; nothing to paste into Calendly.
3. Add booking links (`https://calendly.com/<you>/<event>`) under Integrations → Booking links.

## Testing

`src/index.test.ts` (fixture payloads, fake fetch): valid / tampered / wrong key / stale / future /
missing / malformed headers, raw-byte signing, multiple `v1`, status mapping (created, canceled,
rescheduled, ignored events), field validation and trimming, `verify` status mapping, subscribe
body, 403/409, unsubscribe URL pinning and best-effort behaviour.
