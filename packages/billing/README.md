# @fundroom/billing

Kernel billing for the managed host: `core.subscription`, the provider webhook ingest,
grace and billing suspension, and usage reporting. Providers are `BillingPort` adapters:
[`@fundroom/billing-stripe`](../adapters/billing-stripe/README.md) and
[`@fundroom/billing-manual`](../adapters/billing-manual/README.md). The HTTP surface is
`apps/server/src/routes/billing.ts` (tenant `/api/v1/billing*`, the operator's manual subscription write)
and `routes/billing-webhook.ts` (`POST /webhooks/billing/stripe`); the runbook is
[`docs/runbooks/billing.md`](../../docs/runbooks/billing.md).

- `service.ts` — the `onWorkspaceCreated` hook (the first subscription row), checkout and portal (the customer
  is created and stored before the checkout URL is returned; the plan's metered prices ride along; both refused
  while the workspace holds `sanctions`), the manual write.
- `cancel.ts` — `billing.cancel`: cancels the provider subscription (and a second one on the same customer)
  of a deleted or sanctioned workspace, idempotent and retried, and leaves a grace period on the row.
- `webhook.ts` — verified events are **wake-ups**: dedupe on `core.billing_event.id`, re-read the
  subscription through the port, upsert under `FOR UPDATE` on the subscription row, ignore facts older than
  `last_event_at`. A workspace is found only through ids we stored ourselves; metadata is only cross-checked.
  Events for a held or otherwise-suspended workspace update the record and never act on the workspace.
- `effects.ts` — pure rules: which status starts, keeps or clears the grace period (`decideGrace`),
  staleness, the trial a checkout still grants, storage in whole GB.
- `jobs.ts` — `billing.enforce` (hourly: end local trials, suspend after grace, lift billing suspensions of
  subscriptions back in good standing), `billing.report-usage` (`45 0 * * *`: meters named by
  `BILLING_METER_SEATS_EVENT` / `BILLING_METER_STORAGE_EVENT`, default `fundroom_staff_seats` and
  `fundroom_storage_gb`, passed in as `BillingServiceDeps.meters`; only where a metered price on the subscription bills them), `billing.retention` (`core.billing_event` after 90 days).

Registered only when `CONTROL_PLANE=on` and `BILLING_DRIVER` is not `none`. Availability changes go through
`@fundroom/control-plane`, and billing sets and clears only the `billing` hold.
