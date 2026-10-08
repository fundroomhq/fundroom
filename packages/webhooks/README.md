# @fundroom/webhooks

Outbound webhooks: the Standard Webhooks signer and verifier, the endpoint and
delivery domain types, and the data access behind `core.webhook_endpoint` and
`core.webhook_delivery`. The fan-out subscriber, the delivery job and the routes live in
`apps/server`; the receiver-facing guide is [`docs/api/webhooks.md`](../../docs/api/webhooks.md).

It is a kernel package and not a module: delivery needs the `outbound` HTTP port, which is
kernel-only on purpose, and it fans out events from every module.

## Wire format: Standard Webhooks, not a house format

Deliveries follow <https://www.standardwebhooks.com> so receivers can use an off-the-shelf library
in any language instead of ours:

- headers `webhook-id` (the delivery id, stable across retries), `webhook-timestamp` (unix seconds
  at send), `webhook-signature` (`v1,<base64 HMAC-SHA256>`, space-separated — two during a secret
  rotation's overlap window, current first);
- signed content `${id}.${timestamp}.${body}`, keyed with the base64-decoded bytes of the
  `whsec_…` secret;
- body `{ id, eventId, type, timestamp, workspaceId, data, schemaVersion }`: `id` is the delivery
  (new on a manual redelivery), `eventId` the event (stable across redeliveries, `ping:<uuid>` for
  tests), and `data` the outbox event payload — ids only, as `EVENT_CATALOGUE` defines it, with
  internal identifiers removed by `projectWebhookData` (no `sessionId` or `userId` leaves the
  server; people are identified by `membershipId`).

## `signature.ts` has no imports, on purpose

WebCrypto, `btoa`/`atob` and `TextEncoder` only, so the same file runs in the server and in any
receiver (Node ≥ 20, Deno, Bun, edge runtimes). It is exported as `@fundroom/webhooks/signature`
and **vendored** into `@fundroom/sdk` as `packages/sdk/src/webhooks.ts`, because the SDK must not
depend on this package (it pulls in the database layer). The SDK's `webhooks.test.ts` fails when
the two files differ below their header comments: edit this one, then copy it over.

`signature.test.ts` pins the official Standard Webhooks test vector. Its secret is allowlisted by
exact value in `.gitleaks.toml`; real secrets (`whsec_` + 43 base64 characters + `=`) are caught by
the `fundroom-webhook-secret` rule.

## Layout

- `signature.ts` — `signPayload`, `verifyWebhook` (5-minute tolerance both ways),
  `mintWebhookSecret`, `webhookSecretBytes`, `WebhookVerificationError`.
- `types.ts` — records, views and the delivery policy: retries after 30 s, 2 min, 10 min, 30 min,
  1 h, 3 h, 6 h, 12 h, 24 h; `Retry-After` honoured up to 1 h; auto-disable after 20 exhausted
  deliveries in a row; 10 s timeout, 64 KiB response cap; 20 endpoints per workspace; 30-day
  delivery retention; the person-level (consent-gated) topics; the `webhook.ping` test topic.
- `policy.ts` — the pure half of delivery: the verdict of an answer (2xx succeeded, 410 gone,
  anything else failed), the next retry delay, `Retry-After` parsing, the sanitised response
  excerpt and error text (never the URL), the stored body and the request headers. No I/O.
- `errors.ts` — `WebhookError` (code + reason) for the routes to map onto the API envelope.
- `repos/` — `WebhookEndpointRepo`, `WebhookDeliveryRepo` and the one workspace-settings read
  delivery needs. Drizzle stays in `repos/`.

The endpoint URL and secrets are sealed with key purpose `webhook-secret`; the URL is never
returned by the API (only `urlHost` and a four-character `urlHint`), because a catch-hook URL is
frequently a credential in its own right.

The topic table in `docs/api/webhooks.md` is generated from the manifests and the catalogue by
`node scripts/render-webhook-topics.mjs` (`--check` in CI).
