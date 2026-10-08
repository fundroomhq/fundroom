# @fundroom/email-smtp

`MailerPort` over [nodemailer](https://nodemailer.com) SMTP. The zero-vendor default: dev talks to Mailpit, production to the company's relay or an
ESP's SMTP endpoint. ESP-native adapters (Resend, SES, Postmark) implement the same port
and add `parseWebhook` for bounces — SMTP has none, bounces come back as mail. A message may carry its own `from` (a verified per-workspace sending domain) and a `dkim` signer; both map straight onto nodemailer, the default `from` applies otherwise.

```ts
import { createSmtpMailer } from "@fundroom/email-smtp";
import { createTemplatedMailer } from "@fundroom/mail";

const smtp = createSmtpMailer({
  url: config.raw.SMTP_URL,                                   // smtp://localhost:1025 (Mailpit)
  from: { address: config.raw.MAIL_FROM, name: config.raw.MAIL_FROM_NAME },
  pool: config.roles.has("worker"),
  log,
});
const mailer = createTemplatedMailer(smtp, { brand: { productName: "FundRoom" } });
await mailer.send(otpEmail(to, { … }));                       // text + rendered HTML
await smtp.healthCheck();                                     // /readyz
```

- URL forms: `smtp://user:pass@host:587` (STARTTLS when the server offers it),
  `smtps://host:465` (implicit TLS). nodemailer maps query flags to transport options:
  `?requireTLS=true` refuses to send in the clear, `?pool=true` keeps connections open,
  `?tls.rejectUnauthorized=false` accepts a self-signed relay on a LAN (never in prod).
- `send` returns `{ messageId, acceptedAt }`; a rejected recipient or transport error becomes a
  `MailerError` (`connection_failed` for network/auth codes, `send_failed` otherwise, `cause`
  attached). Timeouts: 10 s connect/greeting, 30 s socket.
- Logs `mail.sent` / `mail.failed` with a masked recipient (`a***@example.com`), tags and
  duration — never subjects or bodies. `tags` are for logs/ESPs only and never go on the wire.
- `List-Unsubscribe` and other headers are passed through from `message.headers`.
- Integration test runs against `axllent/mailpit` (Testcontainers); pin with
  `FUNDROOM_TEST_MAILPIT_IMAGE`.
