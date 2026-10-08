# Runbook: billing (Stripe and manual)

On a managed host, a workspace's plan can be paid for. The owner buys or changes it at **Settings → Billing**
through Stripe Checkout and the Stripe Customer Portal. If you invoice by hand, you record the subscription
yourself. A subscription that stops being paid gets a grace period and then suspends the workspace. This
runbook is for whoever runs the install: setting Stripe up (products, prices, meters, the webhook), test
mode, the manual driver, grace and suspension, and what to do when a payment does not show up.

Reference material: `packages/billing` (the service, the webhook ingest and the jobs), `packages/adapters/billing-stripe` (the wire)
and `apps/server/src/routes/billing*.ts`. Plans and their limits are in
[control-plane.md](control-plane.md#plans).

## What has to be true first

- **The control plane is on** (`CONTROL_PLANE=on`, [control-plane.md](control-plane.md)). `BILLING_DRIVER` is
  `none` by default, and then every billing route answers 404 and no billing job runs.
- **Plans exist.** A workspace with no plan has nothing to pay for. A plan is offered on the billing page (and
  at signup) only when it is `public`, and can be bought through Stripe only when it has a `billing_price_ref`.
- **Stripe is a sub-processor.** With `BILLING_DRIVER=stripe` the tenant company's name, the owner's email
  and payment details go to Stripe (US). Add it to the sub-processor list and the DPA you give your
  customers. The product does not do that for you.

## Stripe setup

### 1. Keys

| Key | Value |
|---|---|
| `BILLING_DRIVER` | `stripe` |
| `STRIPE_SECRET_KEY` (or `_FILE`) | a secret key `sk_…` or, better, a **restricted key** `rk_…` |
| `STRIPE_WEBHOOK_SECRET` (or `_FILE`) | the endpoint's signing secret `whsec_…` (step 4) |
| `BILLING_GRACE_DAYS` | days between "payment failed" and suspension, 0–60, default 14 |
| `BILLING_METER_SEATS_EVENT` | only with metered prices: the seat meter's event name (step 3), default `fundroom_staff_seats` |
| `BILLING_METER_STORAGE_EVENT` | only with metered prices: the storage meter's event name (step 3), default `fundroom_storage_gb` |

A restricted key needs write access to Customers, Checkout Sessions, Customer Portal sessions, Billing
Meter Events and Subscriptions (cancellation on workspace deletion or a confirmed sanctions match; see
below), and read access to Billing Meters (to learn which meter a metered price bills). That is everything
the adapter calls; it never changes a subscription's price or quantity itself.

Every request pins **`Stripe-Version: 2026-08-26.dahlia`**, whatever your account's default version is.
`STRIPE_API_BASE` exists for test fakes only; production refuses any value but `https://api.stripe.com`.

### 2. Products and prices

One Stripe Product per plan, with one **recurring, licensed (fixed-amount) Price**, monthly or yearly. Put
the price id on the plan:

```
fundroom plan upsert growth --name Growth --price price_1Q… --trial-days 14 --public
```

(or the plan editor in `/platform`). Checkout subscribes the workspace to that price, quantity 1, plus the
plan's metered prices (step 3).
Changing plans is done in the Customer Portal. When Stripe reports that a subscription's price **changed**
to one that belongs to exactly one unarchived plan, the workspace moves to that plan (`workspace.plan_change`,
system actor). A plan an operator assigned by hand is not overwritten by an event whose price did not change.

A plan with a trial (`--trial-days`) starts new workspaces on a local trial with no card. Checkout later grants
only the days the trial has left, never a second trial (an abandoned first checkout does not spend it). A plan with no price (`--no-price`) is free: no
subscription is created, and the plan's limits simply apply.

A plan change that leaves out a module or feature (a downgrade in the Customer Portal, say) deletes and
switches off nothing; it freezes the configuration. A module that is on becomes read-only for staff, and a
feature already set up keeps working and can be maintained, but nothing new can be turned on. AI requests
and completing access reviews stop, and audit anchor proofs can't be downloaded (the workspace is still
anchored). An upgrade resumes everything on the next request. See
[control-plane.md](control-plane.md#modules-and-features).

### 3. Meters and metered prices (optional: usage-based charges)

Every night (`billing.report-usage`, `45 0 * * *`) the install can report yesterday's figures for a workspace
as Stripe meter events:

| Meter event name (default) | Set by | Value | Unit |
|---|---|---|---|
| `fundroom_staff_seats` | `BILLING_METER_SEATS_EVENT` | live staff memberships that day | seats |
| `fundroom_storage_gb` | `BILLING_METER_STORAGE_EVENT` | stored bytes that day, in whole GB of 10⁹ bytes, rounded up | GB |

Before the FundRoom rename the event names were fixed at `seedhost_staff_seats` and `seedhost_storage_gb`.
If your Stripe meters already use those names, set `BILLING_METER_SEATS_EVENT=seedhost_staff_seats` and
`BILLING_METER_STORAGE_EVENT=seedhost_storage_gb`; otherwise create the meters with the new defaults. A meter
whose event name does not match receives nothing, and Stripe does not tell us. The job does notice when a
subscription bills on a meter whose event name is neither setting: it logs `billing.usage_meter_unknown`
(warn, with the workspace and the meter's event name) and reports nothing for that meter. Search the logs
for it after the first nightly run following an upgrade.

To bill on them:

1. Create a Billing Meter per figure with exactly that **event name**, value key `value` and customer mapping
   by id on `stripe_customer_id` (Stripe's defaults). Pick the aggregation to match what you charge for:
   `sum` bills seat-days and GB-days; `last` bills the last figure of the period.
2. Create a **metered** recurring price on each meter (`recurring[usage_type]=metered`, `recurring[meter]`).
3. List those prices on the plan: `fundroom plan upsert growth --metered-price price_… --metered-price price_…`,
   or the plan editor's metered price field. At most 10 per plan. A price may be a plan's base price or a
   metered price, never both, on any plan: a clash is refused (`409 conflict`, `price_ref_conflict`).

Checkout then subscribes the workspace to the base price (quantity 1) **plus** each metered price (no
quantity). The nightly job reports a figure only when a metered price on the workspace's subscription bills
that meter; everything else is skipped silently. It learns which prices bill which meters by reading the
subscription and each meter from Stripe. Plans without metered prices send nothing. A workspace that
subscribed before you added a metered price to its plan gets it only through the Customer Portal or the Stripe
Dashboard.

Each event's identifier is `<workspace id>:<day>:<meter>`, also sent as the idempotency key, so a retried job
cannot double-count. The timestamp is the last second of the day (Stripe accepts up to 35 days back).

### 4. The webhook endpoint

In the Stripe Dashboard (Developers → Webhooks), add an endpoint:

- **URL:** `<BASE_URL>/webhooks/billing/stripe`, e.g. `https://portal.example.com/webhooks/billing/stripe`.
  It answers only on the canonical host; never register a workspace or custom-domain URL. `BASE_URL`
  includes any base path.
- **API version:** `2026-08-26.dahlia`, the same as the requests, so events and re-reads have one shape.
- **Events:**
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.paused`
  - `customer.subscription.resumed`

  `customer.subscription.pending_update_applied` and `…pending_update_expired` are also understood if you
  select them. Invoice events are not needed: a failed or recovered payment changes the subscription's status,
  which arrives as `customer.subscription.updated`. Anything else is answered 200 and ignored.
- Copy the endpoint's **signing secret** into `STRIPE_WEBHOOK_SECRET` and restart.

Events are wake-ups, not facts. On each verified event the install re-reads the subscription from Stripe and
applies what it reads, so order, duplicates and replays do not matter (duplicates are dropped by event id;
event ids are kept 90 days).

### 5. The Customer Portal

Save your Customer Portal settings once in the Stripe Dashboard (Settings → Billing → Customer portal), in
test mode and again in live mode: Stripe refuses to open a portal session until they exist. Allow what you want
owners to do there (update the payment method, switch between your plans' prices, cancel). The return URL is
set per session by the install.

## Test mode

Use `sk_test_…` / `rk_test_…` keys and a test-mode endpoint with its own `whsec_…`. For a development machine
that Stripe cannot reach, the Stripe CLI forwards events:

```
stripe listen --forward-to http://localhost:3000/webhooks/billing/stripe
```

It prints a `whsec_…` for the session; use it as `STRIPE_WEBHOOK_SECRET`. Card `4242 4242 4242 4242`
succeeds; Stripe's test clocks and its failing-card numbers let you walk a subscription to `past_due`.

## What the owner sees

**Settings → Billing** (owners, admins and finance can see it; only the owner can act, after a fresh step-up):
the plan, its status and period end, a trial or grace countdown, usage against the plan's limits, **Choose a
plan** (Stripe Checkout) and **Manage billing** (the Stripe Customer Portal). Checkout and the portal always
return to the workspace's own `BASE_URL` address (`<slug>.<canonical>` or `/w/<slug>`), never a custom
domain. A subscription reads `incomplete` from the moment checkout starts until Stripe confirms it: that is
"checkout pending", not an error.

| Answer | Why |
|---|---|
| `409 billing_unavailable`, `reason: subscription_exists` | there is already a live Stripe subscription; change plans in the portal |
| `409 billing_unavailable`, `reason: no_customer` | portal before any checkout: nothing to manage yet |
| `409 billing_unavailable`, `reason: no_price` | the plan has no `billing_price_ref` (it is free) |
| `409 billing_unavailable`, `reason: no_plan` | the workspace has no plan |
| `409 billing_unavailable`, `reason: sanctions` | the workspace is suspended for sanctions |
| `409 billing_unavailable`, `reason: customer_changed` | two first checkouts raced; retry |
| `409 billing_manual` | the install uses the manual driver |
| `404` on checkout | the plan is not public, archived or unknown |

## Grace and suspension

| Subscription status | Effect |
|---|---|
| `trialing`, `active` | good standing; grace cleared; a **billing** suspension is lifted |
| `past_due`, `unpaid`, `paused` | grace starts now (`BILLING_GRACE_DAYS`); owners get the past-due email |
| `canceled` | the plan stays; grace runs from the end of the paid period |
| `incomplete` | checkout started, or a local trial ran out; an ended trial starts grace |

Stripe's `incomplete_expired` is recorded as `canceled`.

`billing.enforce` (hourly, `20 * * * *`) sets the `billing` hold on every workspace whose grace has passed
(suspended, reason `billing`) and emails the owners. It also clears the `billing` hold of subscriptions back
in good standing, in case the webhook that should have done it failed. A suspended owner can still reach
**Billing** and pay, and the hold is cleared when Stripe confirms it. Billing only ever touches its own hold:
paying never lifts an operator or sanctions suspension or a sanctions review, and a billing hold set on top
of those simply waits underneath ([control-plane.md](control-plane.md#suspend-and-unsuspend)). An operator can
override a billing suspension by hand (unsuspend with `hold: "billing"`); the next enforce run sets it again
if grace has still passed and nothing changed.

Deleting a workspace, or an operator confirming a sanctions match, cancels its Stripe subscription through a
`billing.cancel` job (idempotent, retried until Stripe answers). The job acts while the workspace is still
deleted or still holds `sanctions`. A second subscription that turns up on that customer is cancelled the same
way, but only once Stripe confirms it belongs to the customer we stored (else `billing.cancel_refused` is
logged). The cancelled row keeps a grace period from the end of the paid period, so a workspace restored
from deletion is suspended for billing once it runs out unless someone pays. While `sanctions` is held,
checkout and the portal answer `409 billing_unavailable` (`reason: sanctions`).

Events for a workspace that is held or suspended for another reason still update the subscription record
(so a cancellation made meanwhile is not lost), and payment still clears the `billing` hold, but no mail is sent. The
answer to Stripe is 200 either way.

## Manual driver

`BILLING_DRIVER=manual` is for hosts that invoice outside the product. Checkout and the portal answer
`409 billing_manual`; there is no webhook. A new workspace on a plan starts `trialing` (for the plan's trial
days) or `active`. You record changes on the workspace's page in `/platform` (**Subscription**: status and
period end), or with the API from the browser console there (see [control-plane.md](control-plane.md#the-console)):

```js
await fetch("/api/v1/platform/workspaces/<workspace id>/subscription", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "past_due", currentPeriodEnd: "2026-10-31T23:59:59Z" }), // planId optional
}).then((r) => r.json());
```

The same grace and suspension rules apply, so recording `past_due` starts the countdown and the owners get the
email. The write is audited on both chains (`subscription.update`). The route answers `409
billing_unavailable` (`reason: not_manual`) under the Stripe driver.

## Troubleshooting

**A payment went through but the workspace still says `incomplete` or past due.** The webhook is not arriving
or not verifying. In the Stripe Dashboard, open the endpoint's delivery log:

| Our answer | Means |
|---|---|
| `404` | billing is off, the driver is not `stripe`, or the URL is not the canonical host |
| `400 invalid_signature` | `STRIPE_WEBHOOK_SECRET` is not this endpoint's secret (test vs live, or an old one after a roll); the server clock is off by more than 5 minutes; or a proxy rewrote the body |
| `413` | the body passed 256 KiB (a real event never does: look for a proxy) |
| `500` | the event verified, but the re-read from Stripe or the database failed. Stripe retries for three days. Check the key's permissions and `billing.webhook_failed` in the logs |
| `200` | received; look for `billing.webhook_dropped` / `billing.webhook_unknown` in the logs |

`billing.webhook_unknown` means the subscription and customer match nothing we stored: a subscription made in
the Dashboard by hand, or one for a customer we did not create. The install binds a subscription to a workspace
only by ids it stored itself at checkout, never by metadata alone. `billing.webhook_dropped` with a mismatch
means the metadata named a different workspace from the one the customer belongs to, and was ignored on
purpose.

**Signature failures after a secret roll.** During a roll Stripe signs with both secrets for up to 24 hours,
and every `v1` signature is checked, so update `STRIPE_WEBHOOK_SECRET` before the old one expires.

**A workspace was suspended and should not have been.** Read its subscription on the console page (status,
grace until), then Stripe's view of the same subscription. If Stripe is right, the owner pays. If you are
forgiving, unsuspend it and fix the subscription in Stripe first, or enforce will suspend it again.

**Usage events fail.** `billing.usage_report_failed` names the workspace and meter. Stripe answers errors about
missing meters or customers asynchronously in the Dashboard, not to us. A retryable failure (429, 5xx) fails the
job, and pg-boss retries it; the identifiers make the retry harmless.

**Mail.** `billing.mail_failed` / `billing.notify_failed`: the past-due or suspended email did not send
(the status change itself stands). See the mail runbooks.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `BILLING_DRIVER` | `none` | `manual` or `stripe` require `CONTROL_PLANE=on` |
| `STRIPE_SECRET_KEY` | unset | required with `stripe`; `sk_…` or `rk_…` |
| `STRIPE_WEBHOOK_SECRET` | unset | required with `stripe`; `whsec_…` |
| `STRIPE_API_BASE` | `https://api.stripe.com` | test seam; any other value refused in production |
| `BILLING_GRACE_DAYS` | `14` | 0–60 |
| `BILLING_METER_SEATS_EVENT` | `fundroom_staff_seats` | Stripe meter event name: 1–100 letters, digits or `_` |
| `BILLING_METER_STORAGE_EVENT` | `fundroom_storage_gb` | Stripe meter event name: 1–100 letters, digits or `_` |
