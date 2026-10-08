# @fundroom/billing-manual

`BillingPort` for hosts that invoice outside the product. `createManualBilling()` has no
checkout, no portal and no webhook. The operator records each workspace's subscription status through
`POST /api/v1/platform/workspaces/{id}/subscription`, and the same grace and suspension rules as Stripe
apply ([`docs/runbooks/billing.md`](../../../docs/runbooks/billing.md#manual-driver)). Checkout and portal
requests answer `409 billing_manual` before they reach this adapter. `reportUsage` is a no-op, and there is
no sub-processor.
