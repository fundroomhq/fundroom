---
"@fundroom/server": patch
"@fundroom/ports": patch
"@fundroom/email-resend": patch
"@fundroom/config": patch
---

Mail webhooks: with the new `MAIL_IGNORE_FOREIGN_SENDERS=true` (default false), an event for a message this deployment never recorded, sent from another address on the `MAIL_FROM` domain (a staging stack sharing the provider account), is answered 200 and counted `foreign` instead of being retried for ten minutes; left false, such events are retried as before. Mail delivery events carry the sender (`MailDeliveryEvent.from`, parsed from Resend's `data.from`), and `fundroom.mail.webhook_events{outcome}` counts webhook events by outcome.
