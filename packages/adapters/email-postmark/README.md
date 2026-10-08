# @fundroom/email-postmark

`MailerPort` over the [Postmark](https://postmarkapp.com) HTTPS API. Selected with
`MAILER_DRIVER=postmark`; the composition root gives it its own SSRF-guarded outbound instance
(10 s, 1 MiB, no redirects).

```ts
import { createPostmarkMailer } from "@fundroom/email-postmark";

const postmark = createPostmarkMailer({
  serverToken: config.raw.POSTMARK_SERVER_TOKEN,
  from: { address: config.raw.MAIL_FROM, name: config.raw.MAIL_FROM_NAME },
  broadcastStream: config.raw.POSTMARK_BROADCAST_STREAM,          // default "broadcast"
  webhookBasicAuth: { user: "fundroom", password: "…16+ chars…" }, // omit = no parseWebhook
  fetch: mailOutbound.fetch,
});
```

- **Send:** `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`.
  `stream: "broadcast"` → `MessageStream` = the broadcast stream; everything else → `outbound`
  (transactional). Postmark adds its own unsubscribe footer to broadcast streams.
- **Tracking is per message** (`capabilities.perMessageTracking: true`): `TrackOpens` and
  `TrackLinks` (`HtmlAndText` / `None`) are always sent explicitly from `OutboundEmail.tracking`,
  so a server-wide "track by default" setting never tracks someone who did not consent.
- **Idempotency:** Postmark has none. A 32-hex digest of `idempotencyKey` is sent as
  `Metadata.idempotency_key` (and comes back on webhooks); dedupe stays with the job queue.
  The first `tags` entry becomes `Tag`.
- Errors: `MailerError` with the HTTP status and Postmark's numeric `ErrorCode`
  (`providerCode`), never Postmark's message text. A 200 with a non-zero `ErrorCode` is a
  rejection — except `ErrorCode` 406 (inactive recipient: Postmark's own suppression list),
  which throws `MailSuppressedError("provider")`; the kernel lists the address locally with
  reason `provider` and callers skip it without retrying.
- **Webhooks** (`POST /webhooks/email/postmark`): Postmark does not sign bodies, so the URL
  carries basic auth (`https://user:pass@host/webhooks/email/postmark`), compared in constant
  time over SHA-256 digests. There is no timestamp, so no replay window: keep the password
  long and rotate it if it leaks. `Delivery`, `Bounce` (`HardBounce` / `BadEmailAddress` /
  `ManuallyDeactivated` / `Inactive` → hard; auto-responders and subscription chatter skipped;
  everything else soft), `SpamComplaint`, `Open` and `Click` (user agent, `OriginalLink`) map to
  `MailDeliveryEvent`. Postmark sends no machine-open flag; `classifyEngagement` reads the UA.
  A `SubscriptionChange` with `SuppressSending: true` (hard bounce, spam complaint, an
  unsubscribe through Postmark's link, a manual suppression) becomes a hard bounce whose
  `reason` is `provider_suppressed:<SuppressionReason>`, which the kernel records as a
  `provider` suppression and does not publish as a delivery; a reactivation (`false`) is not
  mirrored — lifting the local entry stays an admin's call. A change without a `MessageID`
  cannot be tied to a workspace and is ignored (the 406 above catches the next send).
- **healthCheck:** `GET /server` with the token.
