---
"@fundroom/integrations": minor
"@fundroom/integration-quickbooks": minor
"@fundroom/integration-xero": minor
"@fundroom/integration-stripe": minor
"@fundroom/integration-slack": minor
"@fundroom/integration-calendly": minor
"@fundroom/integration-calcom": minor
"@fundroom/module-captable": minor
"@fundroom/module-metrics": minor
"@fundroom/module-notify": minor
"@fundroom/module-crm": minor
"@fundroom/ports": minor
"@fundroom/config": minor
"@fundroom/db": minor
"@fundroom/audit": minor
"@fundroom/authz": minor
"@fundroom/compliance": minor
"@fundroom/portability": minor
"@fundroom/domain": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/sdk": minor
"@fundroom/queue-pgboss": patch
"@fundroom/server": minor
"@fundroom/web": minor
---

Add the integrations hub.

**Connections.** `/admin/integrations` lists every integration a workspace can use. A workspace holds at most one live connection per provider. Credentials are sealed per workspace and never shown again. Each connection reports its health (active, degraded, reconnect needed) with the last success and the last problem. QuickBooks Online, Xero and Slack connect over OAuth 2.0, using client credentials the operator registers once per deployment. The member who started a connection must confirm it from their own session before it is saved. Stripe connects with a restricted key (`rk_…`); secret keys are refused.

**KPI sources.** Monthly revenue, expenses, net income and cash come from QuickBooks or Xero. Gross volume, net volume, new customers, MRR and active subscriptions come from Stripe. A monthly metric is bound to one source series under **KPI sources**. A nightly sync backfills 24 months and then keeps the last 3 current. A synced value never silently replaces one typed by hand: it is flagged for review.

**Slack app.** Notification channels can post through the connected Slack app to a channel picked from a list, alongside the existing incoming-webhook channels. Staff are alerted when a connection stops working.

**Booking.** The investor portal shows "Book time" links (Calendly or Cal.com) to the audiences you choose. Bookings made through a connected account are recorded and logged as meetings on the CRM contact.

**Cap table.** New optional module `captable`. It imports read-only snapshots from our CSV template or from a Carta or Pulley export, and shows a fully diluted summary by class, the option pool and SAFEs/notes outstanding. Investors see a "Your holdings" card with their own lines under a disclaimer; published snapshots are immutable.

**Configuration.** New: `INTEGRATIONS_QUICKBOOKS_CLIENT_ID`/`_SECRET`/`_ENVIRONMENT`, `INTEGRATIONS_XERO_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_SLACK_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_ALLOW_PRIVATE_HOSTS`. Migrations: core `0020_integrations`, metrics `0005_kpi_source_kinds` and `0006_kpi_bindings`, notify `0011_slack_app_channels`, crm `0002_activity`, captable `0001_captable`. Operator guide in `docs/integrations/`.

**Fix.** Job workers no longer run more concurrent slots per queue than the database pool has connections (`DATABASE_POOL_MAX`), so a small pool is no longer starved by pollers ahead of requests.
