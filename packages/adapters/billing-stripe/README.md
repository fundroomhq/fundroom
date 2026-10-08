# @fundroom/billing-stripe

`BillingPort` for [Stripe](https://stripe.com), over the REST API with the injected,
SSRF-guarded `deps.fetch` (no SDK, no redirects). Runtime dependency: `@fundroom/ports` only. Setup and
troubleshooting: [`docs/runbooks/billing.md`](../../../docs/runbooks/billing.md).

Exports `createStripeBilling(deps)`, `STRIPE_API_VERSION` and the pure helpers `verifyStripeSignature`,
`parseStripeEvent`, `subscriptionFact` and `formBody`.

| Port method | Stripe call |
|---|---|
| `createCheckout` | `POST /v1/customers` (when there is no customer yet), then `POST /v1/checkout/sessions` (`mode=subscription`, the base price with quantity 1 plus each metered price without one, `client_reference_id` + `metadata.workspace_id`, `subscription_data[trial_period_days]`; `ui_mode` never sent) |
| `createPortalSession` | `POST /v1/billing_portal/sessions` |
| `getSubscription` | `GET /v1/subscriptions/{id}` (`current_period_end` from the first item, as on basil and later; every item's price; items paged through `/v1/subscription_items` when `has_more`) |
| `meteredEvents` | the subscription's metered item prices → `GET /v1/billing/meters/{id}` (cached per meter) → the meter event names it bills |
| `reportUsage` | `POST /v1/billing/meter_events` (`payload[value]`, `payload[stripe_customer_id]`, `identifier`) |
| `parseWebhook` | `Stripe-Signature`: HMAC-SHA256 of `"<t>.<raw body>"` compared in constant time with **every** `v1=` value (never `v0`), 300 s tolerance; then `checkout.session.completed` and `customer.subscription.*` are mapped and everything else is `ignored` |

Every request sends `Stripe-Version: 2026-08-26.dahlia` and form-encoded bodies. Every POST carries an
`Idempotency-Key` derived from the caller's key. 429, 409 (an idempotent request still running), 5xx and
network failures are `BillingProviderError(retryable: true)`, and every other 4xx is not. Error messages name
Stripe's error `type`/`code` and the HTTP status, never Stripe's prose or the key. Stripe's
`incomplete_expired` maps to `canceled`.

`meta.subProcessor` names Stripe (United States) for the deployment's sub-processor list.
