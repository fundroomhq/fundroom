# @fundroom/email-ses

`MailerPort` over the [Amazon SES v2](https://docs.aws.amazon.com/ses/latest/APIReference-V2/)
API with a hand-rolled SigV4 signer. Selected with `MAILER_DRIVER=ses`; the composition
root gives it its own SSRF-guarded outbound instance (10 s, 1 MiB, no redirects). No AWS SDK:
it would bring a large dependency tree and a credential chain that probes the instance
metadata endpoint.

```ts
import { createSesMailer } from "@fundroom/email-ses";

const ses = createSesMailer({
  region: "eu-west-1",
  accessKeyId, secretAccessKey, sessionToken,          // AWS_* env
  from: { address: config.raw.MAIL_FROM, name: config.raw.MAIL_FROM_NAME },
  configurationSet: "fundroom",                        // publishes events to SNS
  allowedTopicArns: ["arn:aws:sns:eu-west-1:123456789012:fundroom-ses"], // omit = no parseWebhook
  fetch: mailOutbound.fetch,
});
```

- **Send:** SigV4-signed `POST https://email.<region>.amazonaws.com/v2/email/outbound-emails`
  with `Content.Simple` (subject, text, html, `Headers` for `List-Unsubscribe`), `EmailTags`
  (sanitised `tags`, `stream`, and a 32-hex digest of `idempotencyKey` — SES has no idempotency
  API) and `ConfigurationSetName`. Non-ASCII display names are RFC 2047 encoded. `sigv4.ts` is
  pinned to AWS's published test vectors (`get-vanilla`, query ordering, the signing-key example).
- **Tracking** is per configuration set in SES, so `perMessageTracking` is `false`.
- Errors: `MailerError` with the HTTP status and the AWS error type (`awsError`), never the
  message text. Throttling types map to `rate_limited`.
- **Webhooks** (`POST /webhooks/email/ses`): configuration set → SNS topic → HTTPS
  subscription. `sns.ts` verifies each message in this order: `TopicArn` in `allowedTopicArns`;
  `SigningCertURL` exactly `https://sns.<topic region>.amazonaws.com/SimpleNotificationService-<hex>.pem`
  (no port, userinfo, query or other path); `Timestamp` within an hour (5 minutes of future
  skew); the certificate (fetched once, kept in a 16-entry LRU, failures negative-cached for a
  minute, inside its validity window) verifies the signature (`SignatureVersion` 1 = SHA1,
  2 = SHA256). The fetch necessarily precedes the signature check, which is why the URL shape is
  this strict and why neither a flood of names nor repeated bad names can evict the real
  certificate or cause more than one fetch per name per minute. A `SubscriptionConfirmation` is confirmed by GETting its `SubscribeURL`, pinned to
  the same SNS host. Events: `Delivery`, `Bounce` (`Permanent` → hard), `Complaint`,
  `DeliveryDelay`, `Open`, `Click` (event publishing `eventType`, or classic `notificationType`),
  one event per affected recipient. A bounce with `bounceSubType` `OnAccountSuppressionList`
  (SES never tried: the address is on the account-level suppression list) is a hard bounce with
  `reason` `provider_suppressed:OnAccountSuppressionList`, recorded by the kernel as a `provider`
  suppression. SES accepts such a send (it does not refuse it synchronously), so the adapter never
  throws `MailSuppressedError`. Anything that fails verification returns `undefined` (401).
- **healthCheck:** signed `GET /v2/email/account`; `AccessDeniedException` (a send-only policy)
  still proves the credentials and counts as healthy, `SendingEnabled: false` does not.
- Tests mint the SNS signing certificate with `openssl` at run time; nothing is committed.
