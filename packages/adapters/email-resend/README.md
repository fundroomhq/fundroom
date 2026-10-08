# @fundroom/email-resend

`MailerPort` over the [Resend](https://resend.com) HTTPS API. Selected with
`MAILER_DRIVER=resend`; the composition root gives it its own SSRF-guarded outbound instance
(10 s, 1 MiB, no redirects — the request carries the API key).

```ts
import { createResendMailer } from "@fundroom/email-resend";

const resend = createResendMailer({
  apiKey: config.raw.RESEND_API_KEY,                 // re_…
  from: { address: config.raw.MAIL_FROM, name: config.raw.MAIL_FROM_NAME },
  webhookSecret: config.raw.RESEND_WEBHOOK_SECRET,   // whsec_…; omit = no parseWebhook
  fetch: mailOutbound.fetch,                         // never global fetch
  log,
});
```

- **Send:** `POST https://api.resend.com/emails` (bearer key). `idempotencyKey` → the
  `Idempotency-Key` header (Resend dedupes for 24 h); `tags` → `[{ name, value: "1" }]` plus a
  `stream` tag; `from` / `replyTo` on the message override the defaults. Errors are
  `MailerError` with `unauthorized` / `rejected` / `rate_limited` / `connection_failed` and the
  HTTP status; only Resend's error `name` is kept, never its message (it can quote the address).
- **Tracking:** Resend switches opens/clicks per *domain*, so `capabilities.perMessageTracking`
  is `false` and `OutboundEmail.tracking` is ignored. The webhook ingress discards opens/clicks
  of recipients who did not consent.
- **Webhooks** (`POST /webhooks/email/resend`): Svix signature (`svix-id`, `svix-timestamp`,
  `svix-signature`; HMAC-SHA256 over `id.timestamp.body`, constant-time, any `v1,` entry of a
  rotated list), refused outside ±5 minutes. `email.delivered`, `email.bounced` (`Permanent` →
  hard, otherwise soft), `email.complained`, `email.delivery_delayed`, `email.opened` (Resend
  sends no user agent) and `email.clicked` (link + user agent) map to `MailDeliveryEvent`;
  `email.suppressed` (Resend refused the send: the address is on its account-level suppression
  list) maps to a hard bounce whose `reason` starts with `provider_suppressed:`, which the kernel
  records as a `provider` suppression rather than a delivery. Other types are skipped. A bad
  signature returns `undefined` (401).
- **Opens are never counted as human.** Resend's `email.opened` carries no user agent and no
  machine-open flag, so an Apple Mail Privacy Protection prefetch, a security scanner and a
  person reading the message are indistinguishable. `classifyEngagement` (`@fundroom/mail`)
  therefore marks every open without a user agent `automated: true` with reason `unverified`:
  Resend opens are stored (as evidence) but never count toward "human opens" or hot-list scores.
  Clicks carry a user agent and are classified normally. If human open counts matter, use
  Postmark or SES, whose open events include the user agent.
- **healthCheck:** `GET /domains`; a sending-only key's `restricted_api_key` answer counts as
  healthy, because it proves the key is live.
- Logs mask the recipient (`j***@example.com`) and never include the key, the secret, subjects
  or bodies.
