# @fundroom/integration-calcom

`IntegrationAdapter` for Cal.com signed booking webhooks. **Connection-less**:
there is no Cal.com credential (`credentialFields: []`); connecting only mints *our* webhook secret,
which the admin pastes into Cal.com together with the callback URL. The adapter makes no outbound
calls at all (`verify` answers `{accountLabel: "Cal.com webhook", externalAccountId: null}`).
Runtime dependency: `@fundroom/ports` only (+ `node:crypto`).

## Webhook verification

Header `X-Cal-Signature-256: <hex HMAC-SHA256(secret, raw body)>` (read case-insensitively; upper-
or lower-case hex; a `sha256=` prefix is tolerated). Compared with `crypto.timingSafeEqual` on the
32-byte digest; missing, empty, malformed or mismatched → `unauthorized`, and the body is not
parsed before that. Cal.com signs **no timestamp**, so there is no replay window: a replayed
delivery is harmless because the kernel dedupes by `(provider, external id)` and applies a later
status only when newer.

## Mapping notes

Envelope `{triggerEvent, createdAt, payload}`.

| Trigger | Result |
|---|---|
| `BOOKING_CREATED` | `payload.uid` → `booked` |
| `BOOKING_CANCELLED` | `payload.uid` → `cancelled` |
| `BOOKING_RESCHEDULED` | Cal.com creates a **new** booking (`uid`, new `startTime`) and retires the original (`rescheduleUid`, `rescheduleStartTime`, `rescheduleEndTime`). Two events, mirroring Calendly: the original → `rescheduled` (at its old time), the new uid → `booked`. If the original's uid/start is absent (older Cal.com), one event: the new uid → `rescheduled`. |
| anything else (`PING`, `BOOKING_REQUESTED`, `MEETING_ENDED`, …) | `{ok: true, value: []}` after verification |

Fields: `inviteeEmail`/`inviteeName` = `attendees[0].email`/`.name` (the booker; extra guests are
ignored), `startsAt`/`endsAt` = `startTime`/`endTime`, `eventName` = `eventTitle` (event type
title) ?? `title` (booking title, which includes names) ?? `type` (slug), trimmed to 200. A verified
body without `uid` (≤ 300), a valid attendee email or a `startTime` is `malformed`.

## Deviations / inferred

- **Link hosts** are `cal.com` and `app.cal.com` only. Self-hosted Cal.com and the EU instance
  (`cal.eu` / `app.cal.eu`) booking links are **not allowed yet** (webhooks from them verify fine —
  the webhook does not depend on the host).
- The two-event mapping for `BOOKING_RESCHEDULED` goes beyond "payload.uid as external id" in the
  integrations contract so the register never shows the original booking as still `booked`.
- `eventTitle` is inferred from Cal.com's payload (the docs list `title`, `type`; `eventTitle` is
  present in current deliveries); the fallbacks cover its absence. `rescheduleStartTime` /
  `rescheduleEndTime` are documented for `BOOKING_RESCHEDULED`.
- Sub-processor DPA link: Cal.com publishes no standalone DPA URL; `dpaUrl` points at
  <https://cal.com/privacy>, which references the DPA.

## Admin setup (vendor side)

1. In FundRoom, connect Cal.com: copy the webhook URL and the one-time secret.
2. Cal.com → **Settings → Developer → Webhooks → New**: Subscriber URL = the webhook URL; triggers
   **Booking created**, **Booking cancelled**, **Booking rescheduled**; Secret = the secret; leave
   the payload template empty (the default JSON payload is required).
3. Add booking links (`https://cal.com/<you>/<event>`) under Integrations → Booking links.

## Testing

`src/index.test.ts` (fixture payloads): valid / tampered / wrong key / empty secret / missing /
malformed / base64 / wrong header name, raw-byte signing, every trigger mapping including both
reschedule shapes, ignored triggers, event-name fallbacks, field validation and trimming, and that
`verify` makes no network call.
