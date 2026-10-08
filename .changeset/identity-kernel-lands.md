---
"@fundroom/identity": minor
"@fundroom/ports": minor
"@fundroom/db": minor
"@fundroom/config": minor
---

Add the identity and session kernel. `@fundroom/db` gains migration `0001_identity`: `core."user"`, `user_identity`, `credential`, `device`, `session`, `rate_limit`, `auth_challenge`, `membership`, `group`, `group_member`, `invite`, `attestation`, with `global_fence` policies on the global tables and `withHost(fn, { userId })`. `@fundroom/ports` starts with `AuthPort`, `MailerPort`, `RateLimiterPort` and `OutboundHttpPort`. `@fundroom/identity` implements server-side sessions with per-population lifetimes, devices and new-device alerts, email OTP, magic link (POST-to-confirm + browser binding), passkeys, TOTP with recovery codes, password with HIBP, generic OIDC (PKCE), invites and the §13.2 revocation core, a Postgres sliding-window rate limiter, cookie recipes per deployment mode, and Hono middleware for sessions, CSRF and step-up. `@fundroom/config` gains `AUTH_PASSWORD_ENABLED`, `AUTH_HIBP_CHECK`, `AUTH_MAGIC_LINK_ENABLED`, `PASSKEY_RP_ID`, `PASSKEY_RP_NAME` and `OIDC_*`.
