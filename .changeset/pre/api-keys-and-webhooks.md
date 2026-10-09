---
"@fundroom/api-keys": minor
"@fundroom/webhooks": minor
"@fundroom/outbound-http": minor
"@fundroom/authz": minor
"@fundroom/audit": minor
"@fundroom/compliance": minor
"@fundroom/config": minor
"@fundroom/contracts": minor
"@fundroom/db": minor
"@fundroom/module-kit": minor
"@fundroom/ports": minor
"@fundroom/portability": minor
"@fundroom/identity": patch
"@fundroom/module-crm": minor
"@fundroom/module-data-room": minor
"@fundroom/module-metrics": minor
"@fundroom/module-round": minor
"@fundroom/module-updates": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Add API keys and outbound webhooks.

**API keys.** Owners and admins mint scoped `frk_` keys under `/admin/api-keys`. Each key acts as its creator, capped by its scopes, and only on routes whose matrix row is `apiKey: true`; 27 routes accept keys so far. Every other route answers 401 `api_key_not_allowed`. Tokens are stored as sha256 hashes. Rotation has a 0–168 h grace window. Each key is limited to 600 requests a minute, and a workspace can hold at most 50 live keys. Keys record when they were last used, and their creator's departure or erasure revokes them. Audit rows written with a key carry `meta.apiKeyId`. The SDK takes an `apiKey` option.

**Outbound webhooks.** Webhooks are managed under `/admin/webhooks` and cover 17 manifest-declared topics. Deliveries follow the Standard Webhooks format: bodies carry ids only, and session and user ids are stripped. Each delivery is fanned out from the outbox and retried ten times over about 47 h. Failed deliveries can be redelivered from a delivery log. An endpoint is disabled after a 410 or 20 exhausted deliveries.

**Webhook privacy and verification.** Person-level topics are gated by analytics consent, and consent, erasure and subscription are re-checked at every attempt. Signing secrets can be rotated with an overlap window. The SDK exports `verifyWebhook`.

**Configuration and supporting changes.**
- New config: `WEBHOOK_ALLOW_PRIVATE_HOSTS`.
- `@fundroom/outbound-http` gains `oversizeResponse: "truncate"`.
- Erasure now locks the member's key rows before the audit chain.
- Migration: core `0018_api_keys_webhooks`.
- Developer docs are in `docs/api/`.
