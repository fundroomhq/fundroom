# Runbook: the managed-host control plane

The control plane is what turns a multi-tenant install into a managed host: platform operators who can
create, suspend and move workspaces from a browser, cells, plans with limits, daily usage, and — through
their own runbooks — [billing](billing.md), [sanctions screening](sanctions.md) and [central
auth](central-auth.md). This runbook is for whoever runs the install: turning it on, granting and revoking
operators, cells, suspending and unsuspending, plans, usage, and what the answers `404`, `421`, `423` and
`402` mean.

Reference material: `packages/control-plane`
(`workspaces/status.ts` is the one place a workspace's status changes), `apps/server/src/middleware/platform.ts`
(the operator boundary), `apps/server/src/middleware/workspace-status.ts` (what a suspended workspace
still serves) and `apps/server/src/routes/platform*.ts`.

## What has to be true first

- **A multi-tenant install.** `CONTROL_PLANE=on` requires `TENANCY_MODE=multi`; the config loader refuses
  anything else. A single-tenant install has exactly one workspace and nothing to operate.
- **The CLI and Postgres** as in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app <command>`
  (Helm: `kubectl exec deploy/<release>-server -- fundroom <command>`).
- **A passkey or authenticator app** on the account you will operate with. The operator session needs
  authentication level 2 (passkey or TOTP) proven within the last ten minutes.

With `CONTROL_PLANE=off` (the default) none of this exists: every route below answers 404, no quota
applies, no workspace is ever suspended by the product, and no control-plane job runs. Turning it off
again later does not unsuspend anything: a workspace suspended while the plane was on stays suspended
(the status guard runs in every mode) until you turn the plane back on and lift it.

## Turn it on

```
TENANCY_MODE=multi
CONTROL_PLANE=on
CELL_ID=default                            # this process's cell; `default` unless you run several
PLATFORM_OPERATOR_CIDRS=203.0.113.0/24     # optional: operator networks (client address as TRUST_PROXY derives it)
BILLING_DRIVER=none                        # manual | stripe — see billing.md
SANCTIONS_DRIVER=ofac                      # none | ofac | opensanctions — see sanctions.md
SIGNUP_MODE=off                            # open: self-service signup (needs SIGNUP_DEFAULT_PLAN)
TERMS_URL=https://www.example.com/terms    # before opening signup; also PRIVACY_URL, SUPPORT_URL, STATUS_URL
```

Restart every process (server and worker: the usage, billing and sanctions jobs register at start), then
check `fundroom doctor`. It prints the derived `controlPlane` row and warns when `CONTROL_PLANE=on` runs in
production with `SANCTIONS_DRIVER=none`. That is allowed, but every new workspace is then admitted
unscreened.

**`PLATFORM_OPERATOR_CIDRS` is worth setting.** It is checked on every operator request, and outside it the
whole operator surface is a 404. It uses the same client address as everything else, so behind a proxy it is
only as good as `TRUST_PROXY` / `TRUST_PROXY_HOPS` / `CLIENT_IP_HEADER` (and `CLOUDFLARE_TRUSTED_PROXY`,
[custom-domains.md](custom-domains.md#cloudflare-for-saas)). Check what address the install sees for you
before relying on it — a wrong hop count locks you out (every request 404s) or, worse, lets a client choose
its own address.

## Grant and revoke operators

```
fundroom operator enrol-link ops@example.com   # prints a one-time enrolment link (30 min)
fundroom operator grant ops@example.com        # needs an account with a passkey or TOTP
fundroom operator list [--json]
fundroom operator revoke ops@example.com       # ends that user's operator sessions at once
```

Only the CLI makes and unmakes operators; there is no web or API path. Everything is audited on the platform
chain (`operator.enrol_link`, `operator.enrol`, `operator.grant`, `operator.revoke`; `created_by = cli:<os user>`,
where `SUDO_USER` wins over the login name).

**`grant` refuses an account that does not exist, or that has no passkey and no confirmed authenticator app
(TOTP).** A mailbox alone must never be enough to reach the console. The onboarding is:

1. **Enrolment link.** Run `fundroom operator enrol-link <email>`. It prints a link
   `<BASE_URL>/platform/enrol?token=…` **once**; it is never emailed, and it is valid for 30 minutes and
   single use. A new link for the same address retires older ones. Give it to the person over a channel you
   trust. People who already have a passkey or TOTP on an existing account skip to step 3.
2. **Enrol.** They open the link, give their email address and enter the code mailed to it. The code is sent
   only when the link was made for that address, so both the link and the mailbox are needed. They then add
   **one** passkey or authenticator app; the account is created if it did not exist. This happens in a
   15-minute enrolment-only state (cookie `__Host-op_enrol`) that can do nothing else, and it ends as soon
   as a factor is added. TOTP recovery codes are shown once: store them.
3. **Grant.** Run `fundroom operator grant <email>`.
4. **Start the console.** They sign in on the **canonical host** (`BASE_URL`), open `/platform` and press
   **Start operator session**. The proof must be level 2 (passkey, or email code plus authenticator),
   younger than ten minutes, and made with a factor that already existed **when you granted** and when that
   sign-in began. Otherwise they are sent through step-up, or refused (`factor_too_new`). A factor enrolled
   after the grant does not count: re-enrolling means `revoke` and `grant` again.
5. **Run the console.** It runs on a separate cookie, `__Host-op_sid` (`SameSite=Strict`), for at most 1 hour
   idle and 12 hours absolute. **End operator session** ends only the operator session. Signing out of (or
   losing) the canonical session it was started from ends it too.

Use a dedicated account for operator work, one that belongs to no workspace. An SSO- or
central-auth-bound session can never start an operator session, and the operator session grants no
membership anywhere. Operator sessions have their own cap of three: a fourth signs the least recently used
operator session out, and never touches the user's ordinary sessions (each kind of session has its own cap).

### "The console says not found"

Everything the operator boundary refuses is the same plain 404, on purpose. Work down the list — the first
one that is false is the answer:

1. `CONTROL_PLANE=on` on the process that answered.
2. You are on the canonical host itself (`BASE_URL`), not a `<slug>.` host, a `/w/<slug>` path or a custom
   domain.
3. Your client address, as the install derives it, is inside `PLATFORM_OPERATOR_CIDRS` (when set).
4. The browser holds a live `__Host-op_sid` (idle 1 h, absolute 12 h).
5. `fundroom operator list` shows you, not revoked.

`POST /api/v1/platform/session` without any user session is a `401` (it needs a signed-in user before
anything else is looked at), which is the same answer every session route gives and says nothing about the
operator surface.

## The console

`/platform` on the canonical host:

| Screen | What it does |
|---|---|
| Workspaces | filter by text, status and plan; open one for status, plan, cell, subscription, 30 days of usage, custom-domain count, the latest sanctions screen and the owners' email addresses (reading those is audited `platform.workspace.owners_read`) |
| Workspaces → New workspace | a new workspace with its owner invited by email (below) |
| Workspace → actions | suspend, lift one hold at a time (a note is required), change plan, change cell, correct the legal name and country (re-screened when screening is on; audited `workspace.legal_change`), re-screen, and with the manual billing driver record the subscription |
| Plans | create, edit (optimistic: a stale edit is `409 version_conflict`), archive |
| Sanctions | the review queue — see [sanctions.md](sanctions.md) |
| Audit | the platform audit chain, newest first |
| Health | queue depths, the dead-letter count and adapter health — never payloads |
| Operators | read-only list |
| Cells | every cell: region, label, jurisdiction, origin, status, local or remote (another database, from the directory), heartbeat age, workspace count (local cells only) |
| Workspace → Move to another cell | with a cell directory: move the workspace to a cell in another region ([residency.md](residency.md#move-a-workspace-to-another-region)) |

Cell administration is CLI only. Anything the console does can also be done by API. Run the request
from the browser console on the `/platform` page: the operator cookie goes with it, and a same-origin
`fetch` passes the CSRF check. Prefix the path with `BASE_PATH` if you have one. Creating a workspace:

```js
await fetch("/api/v1/platform/workspaces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    slug: "acme", name: "Acme", legalName: "Acme Robotics, Inc.", country: "US",
    ownerEmail: "founder@acme.example", planId: "starter", // or null: unlimited
    // cellId: "eu-1",                                     // optional; default: this process's cell
  }),
}).then((r) => r.json());
```

The owner is invited by email. A plan's billing and the sanctions hold apply as they would for a signup: with
a sanctions driver the new workspace starts `pending_review` (the `sanctions_review` hold) until its screen clears.

The operator never sees tenant content: documents, updates, contacts, questions, analytics. Reaching those is
still [break-glass](break-glass.md), with a ticket, and the owners are told.

## Suspend and unsuspend

A workspace carries a set of **holds**, each owned by one party:

| Hold | Set by | Lifted by |
|---|---|---|
| `sanctions_review` | creation, with a sanctions driver | a clean screen, an operator's `cleared` decision, or an operator's release once the latest screening is clear or cleared (with no sanctions driver and no screening at all, an operator may release it; audited `noScreening`) |
| `operator` | an operator's **Suspend** | an operator's unsuspend |
| `billing` | the billing job, when grace runs out | payment (the subscription back in good standing), or an operator's override |
| `sanctions` | an operator's `confirmed` decision | only an operator's explicit unsuspend of this hold, by a **different** operator from the one who confirmed, once a screening **newer than the confirmation** is a clean screen or a potential match decided `cleared` (an error screening never counts) |
| `relocation` | a move to another region's cell ([residency.md](residency.md#move-a-workspace-to-another-region)), on the source and on the target while it imports | only the move itself: the target lifts its hold after the switch, the source's goes with its purge, and a failed or cancelled move lifts the source's. Unsuspend never lifts it (the API does not accept it as a hold to lift), and the workspace cannot be deleted or change cell while it is set (`409 conflict`, `reason: relocating`) |

The status everyone sees is derived from the holds:

- `suspended` while any of `operator`, `billing`, `sanctions` or `relocation` is set, with the highest as
  its reason (sanctions > operator > relocation > billing);
- `pending_review` while only `sanctions_review` is set;
- otherwise `active`.

Because each party lifts only its own hold, nothing undoes anybody else's decision. Your unsuspend leaves a
sanctions review in place, paying never lifts your suspension, and a clean re-screen never lifts a confirmed
sanctions suspension. The workspace page lists the holds, with one lift action each.

| Who sees what while it is not active | |
|---|---|
| Staff | the admin shell with a banner; every API call except sign-in, their own account, the bootstrap and (for `billing.read` holders) billing and usage answers **423 `workspace_unavailable`** |
| Owner / finance / admin (`billing.read`) | also **Billing** and **Usage**, so a billing suspension can be paid off |
| Investors, anonymous visitors, API keys | a single "portal unavailable" page; the API answers **404** — nothing about why |
| Outgoing mail, updates, notifications, outbound webhooks | deferred until the workspace is active again (not dropped); SCIM answers 403 |
| Vendor callbacks | the Stripe webhook is accepted and dropped (200); the older inbound callbacks (e-sign, accreditation, integrations, mail) are unchanged in v1 |

**Suspend** from the workspace page (a note is required). It sets the `operator` hold and takes effect on the
next request. The workspace's own audit log shows `workspace.suspend` by the host, with no name: your user
id, IP, session and note are on the platform chain only.

**Unsuspend** lifts one hold: `POST /api/v1/platform/workspaces/{id}/unsuspend` with `{ "hold": "operator" }`
(the default), `"billing"` (an override, audited; the billing job suspends again if grace has still passed
and nothing changed), `"sanctions_review"` or `"sanctions"`. The last two follow the rules in the table and
otherwise answer `409 sanctions_unresolved` (`reason: not_cleared`, or `four_eyes` when you confirmed the
match yourself). For a held
workspace, deciding the screening in the sanctions queue is usually the better path: `cleared` releases it.

## Cells

A cell is where a workspace is served. Every process serves the cell its `CELL_ID` names, and with the
control plane on, a request for a workspace on another cell gets **`421 wrong_cell`** with
`X-Fundroom-Cell: <cell>` — nothing else — so the edge in front can send it to the right place. (This
release also sends the pre-rename `X-Seedhost-Cell` with the same value; the next minor release drops it, so
an edge that routes on it must switch to `X-Fundroom-Cell` now.) With a
shared cell directory ([residency.md](residency.md)) the same answer covers a slug or custom hostname that
lives in another region's cell, and a workspace that has just moved away. The canonical
host (signup, `/platform`, central-auth authorize) answers on every cell. It serves no tenant pages: with the
control plane on, `/w/<slug>/…` there redirects (308) to `https://<slug>.<canonical>/…`, and `/w/<slug>/api/…`
is a 404.

```
fundroom cell list [--json]
fundroom cell add eu-2 --region eu --origin https://eu-2.origin.example \
  [--label "European Union (Frankfurt, Germany)"] [--jurisdiction eu]
fundroom cell set-origin eu-2 https://eu-2.origin.example   # "" = this install
fundroom cell drain eu-2        # no new workspaces there; existing ones stay until moved
```

The process's own cell needs no `cell add`: at start-up, when `core.cell` has no row for `CELL_ID`, the
server creates it from `CELL_ID`, `DATA_REGION` (with its label and jurisdiction; the placeholder region
without one) and `BASE_URL`'s origin (none when `BASE_URL` is not https with a DNS name or IPv4 address),
audited `cell.add` with actor `system/boot` and logged `cell.own_created`; with a shared directory it is
published at once. `doctor` shows what the row will be (`ownCell`). An existing row is never changed by a
start:

- a region or origin that disagrees with the configuration is logged `cell.own_differs` (warn) and left
  as it is, since it may be your edit. Correct the origin with `fundroom cell set-origin <id> <origin>`
  (audited `cell.update`; a shared directory has it at the next heartbeat or after
  `fundroom directory sync`). A region never changes.
- a draining or closed own cell is logged `cell.own_not_active` (info): no new workspace is placed on it.

A workspace is never placed on `default` because the own row is missing or not active: the setup wizard,
`seed-demo` and `workspace import` refuse with "CELL_ID=… has no row in core.cell" (a database no server
has started on yet) or "CELL_ID=… is draining".

Live workspaces on `default` while this process's `CELL_ID` names another cell are reported at each start
(`cell.default_has_workspaces`, warn, with the count). One database may host several cells served by
different processes, so they are only a problem when no process serves `CELL_ID=default`: then they answer
`421 wrong_cell` (workspaces placed before cells were pinned). Move each one to `CELL_ID`: **Change cell** on its
console page, or `PATCH /api/v1/platform/workspaces/{id}` `{ "cellId": "<CELL_ID>" }`.

`--origin` is recorded for your edge's routing table (and, with a cell directory, offered to signups in
other regions); the app does not redirect to it. Move a workspace between the cells of this database with
**Change cell** on its page (or `PATCH /api/v1/platform/workspaces/{id}` `{ "cellId": "eu-2" }`); a draining
cell is refused as a target.

The cells of one install share **one database and one job queue**: such a cell separates routing, not
data, and the worker runs jobs for every cell of the database. Changing a workspace's cell moves which
processes answer for it, instantly, and nothing else. For the same reason **one database is one region**:
every cell of a database declares the same region (`--region` must equal `DATA_REGION` when it is set,
and a second region is refused with "one database = one region"), and a cell's region never changes.
Cells in other regions are separate installs with their own database, joined through a shared directory;
moving a workspace to one of them is a heavy, planned operation with downtime, not a cell change (the
cell select offers only this database's cells, and the API answers `409 move_unavailable`,
`reason: use_move`, for another). Declaring the region, cells in several regions and moves are in
[residency.md](residency.md).

A `421` you did not expect: the process's `CELL_ID` does not match the workspace's cell. Either the edge
routed to the wrong pool or the process's `CELL_ID` is wrong — `fundroom doctor` on that process, and the
workspace's cell on its console page. With a directory, also `fundroom directory status`: the header may name
a cell in another database (the workspace lives there, or was moved there).

## Plans

A plan is a named set of limits: how much a workspace may use (seats, storage, domains) and what it may turn
on (optional modules and features, [below](#modules-and-features)). A workspace with no plan (`planId: null`,
every self-hosted workspace) is unlimited and may turn on everything. A limit left out of a plan is unlimited.

| Limit | Checked when | Counts |
|---|---|---|
| `staffSeats` | staff invitation (incl. CSV import, access-request approval), SCIM / SSO JIT provisioning | live staff memberships + pending staff invitations |
| `investorSeats` | investor invitation, access-request approval, share-link redemption | live investors + pending investor invitations (delegates are not counted) |
| `customDomains` | adding a custom domain | the workspace's non-failed domains |
| `storageBytes` | starting a data-room upload | the latest usage row's `storage_bytes` + the declared upload size |
| `emailsPerMonth` | never (v1) | reported in usage only |

Over a limit the action answers **`402 plan_limit`** `{ limit, max }`, and the admin sees a sentence saying
which limit. Known gaps, by design in v1: storage counts the last rollup plus unfinished uploads, so it lags
by what was stored since that rollup; SCIM reactivation, signup and host-side provisioning are not checked
(unsuspending a membership is); a batch invite that hits the limit half-way leaves the earlier addresses
invited.

```
fundroom plan list [--json]
fundroom plan upsert starter --name Starter \
  --limits '{"staffSeats":5,"investorSeats":250,"storageBytes":10000000000,"customDomains":1}' \
  --trial-days 14 --public --price price_1Q…      # --no-price: free; --no-public: operator-assigned only
fundroom plan upsert starter --trial-days 30      # on an existing plan: changes only the flags given
fundroom plan upsert growth --metered-price price_seats… --metered-price price_gb…   # replaces the list; --no-metered-price clears it
```

`--limits` **replaces** the numeric limits (a number left out becomes unlimited); the `modules` and
`features` lists it does not mention are kept (see below). `--public` offers the plan at signup and on the tenant billing page; `--price` is the provider's price id (Stripe `price_…`; see
[billing.md](billing.md)). `--metered-price` lists usage-billed prices added at checkout (at most 10). A price
is one plan's base price or a metered price, never both anywhere, so a clash is refused (`price_ref_conflict`).
Plan ids are `^[a-z0-9][a-z0-9_-]{0,40}$` and never change.

Archive a plan in the console (not the CLI): workspaces on it keep it, but it can no longer be assigned or
bought. Lowering a limit below what a workspace already uses blocks new additions only; nothing is removed.

### Modules and features

Two more keys say what a workspace on the plan may turn on. Both work like the numbers: left out
means all, and nothing is checked with `CONTROL_PLANE=off` or for a workspace without a plan.

- `modules`: the **optional** modules a workspace may have on — `analytics`, `captable`, `crm`, `data-room`,
  `metrics`, `notify`, `round`, `updates` on today's build. Required modules (`content` and the kernel) are
  always on and cannot be listed. `[]` means core modules only.
- `features`: any of `qa`, `api_keys`, `webhooks`, `integrations`, `esign`, `accreditation`, `sso`, `scim`,
  `forensic`, `anchoring`, `ai`, `access_reviews`. `[]` means none.

`GET /api/v1/platform/plans` returns the valid ids as `entitlementCatalog: { modules, features }`. Naming
anything else in `modules` (a typo, a required module) is **`400 validation_failed`** with
`{ reason: "unknown_module", module }`.

```
fundroom plan upsert starter --modules data-room,updates,notify,analytics --features qa,api_keys
fundroom plan upsert growth --features sso,scim,webhooks,api_keys,integrations,qa   # numbers untouched
fundroom plan upsert growth --limits '{"staffSeats":10,"investorSeats":1000}'      # lists untouched
fundroom plan upsert scale --modules all --features all     # remove both keys: no restriction
fundroom plan upsert starter --features none                # [] : no feature may be turned on
```

Ids are comma-separated; `all` removes the key, `none` stores `[]`. **The CLI changes only what you name**:
a list flag changes only that key, and `--limits` changes the numbers but keeps any list it does not mention
(a list inside the `--limits` JSON, or a flag, replaces it; a flag wins over the JSON). Unknown features and
duplicates are refused before anything is written; an unknown module exits 2 and prints the valid ones.
`fundroom plan list` shows `modules=[a b]`, `modules=[]` or `modules=all` (and the same for features) after
the numbers.

The **API is different**: `PATCH /api/v1/platform/plans/{id}` replaces the whole `limits` object, so a list
left out of the body becomes "all". Send the lists you read.

In the console, the plan form has a **Modules** and a **Features** fieldset, each with "All (no
restriction)" (ticked for a new plan); untick it for a checklist. An explicit list does not pick up modules or
features added by later versions. Editing a number keeps the lists as they are.

**What a downgrade does.** A plan, or a workspace's move to a smaller plan (operator, Stripe or manual
billing), takes effect on the workspace's next request. The configuration freezes: what is on stays on, can
be maintained and can be turned off, but nothing new can be added or turned on. Nothing is deleted or
switched off, and investors see what they saw before.

- **A module that is on but outside the plan becomes read-only for staff.** Staff can read everything, and
  every staff write to it answers 402, including writes through investor-facing routes (a staff Q&A
  question or update reply) and through API keys. DELETE always works, so anything can be withdrawn, and
  so do the exemptions in `READ_ONLY_EXEMPT` (`apps/server/src/module-read-only.ts`, each with its reason):
  import dry-runs, forensic detect, view telemetry, a person's own inbox, preferences and opt-out,
  unscheduling an update, archiving one (not un-archiving), declining or closing Q&A and round
  submissions, voiding a signature request, analytics erasure, and data-room legal holds. **Restoring from
  the trash is refused** until the plan includes the module again; the trash keeps items until its purge.
  Investors keep reading and keep doing what investors do (asking questions, registering interest,
  replying). Scheduled sends and other jobs keep running. Share links, grants and invitations are workspace
  access, not module content, so they keep working (within the investor-seat limit). An admin can switch the
  module off; switching it back on then needs a plan that includes it. A module that is off and outside the
  plan cannot be switched on.
- **A feature outside the plan keeps working and can be maintained**: re-keying the SSO connection,
  replacing a vendor's credentials or reconnecting an integration for the same vendor (even to another
  account of theirs), rotating API keys, SCIM tokens and secrets, re-verifying, removing webhook topics,
  re-enabling an endpoint the system disabled, disabling and deleting. What is refused is anything new: a
  first connection or one to another vendor or identity provider, a first SCIM token, a new API key or
  webhook endpoint, a new webhook topic or URL, SSO domains, turning a connection, enforcement, JIT
  provisioning or trusted-IdP MFA on, and switching a toggle (Q&A, forensic default, AI) on. Two stop
  outright, because using them is the feature: new AI requests (queued ones settle `refused`,
  `plan_limit`) and completing an access review (the overdue reminder stops, and
  `fundroom evidence access-reviews` reports `notOnPlan`).
- **Anchoring.** Every workspace is anchored and verified whatever its plan. Without `anchoring`, only
  downloading a proof (`GET /api/v1/audit/anchors/{checkpointId}/proof`) answers 402; after an upgrade every
  past proof is available at once ([audit-anchoring.md](audit-anchoring.md#plans-managed-host)).


**Telling a customer why something is read-only.** They see it already: the modules page and setup wizard
badge the module "Read-only on your plan" or "Not on your plan", every admin page of a read-only module
carries a banner, each feature's settings page says "Your plan doesn't include …", and Billing lists the
plan's modules and features and any read-only modules. To confirm from your side: the workspace's plan in the
console, then that plan's Modules and Features (`fundroom plan list`). The fix is a plan that includes it;
the product never says which plan that is, because it does not know your tiers' order or prices. Once the
plan includes it, everything resumes on the next request.

The refusals:

```
402 { "code": "plan_limit", "limit": "module",  "module": "metrics", "message": "the workspace's plan does not include the metrics module", "requestId": "…" }
402 { "code": "plan_limit", "limit": "feature", "feature": "sso",    "message": "the workspace's plan does not include the sso feature",    "requestId": "…" }
```

A 402 only ever reaches someone the route would otherwise have served: an anonymous caller, an investor or
staff without the permission get the same 401/403/404 as before, so the answer never reveals a plan.

## Usage

Every workspace gets one `core.tenant_usage_daily` row per UTC day: staff seats, investor seats, custom
domains, emails sent, storage bytes and documents viewed. Two jobs keep it current:
`control-plane.usage-rollup` (`15 0 * * *`, finalises yesterday) and `control-plane.usage-rollup-today`
(`5 * * * *`, today so far). Rows older than 400 days are deleted by the same job.

- Operators: the workspace page (30 days), or `GET /api/v1/platform/workspaces/{id}/usage`.
- Tenants: owners, admins and finance see their own at **Settings → Billing** (`GET /api/v1/usage`).

Storage comes from the data-room module and documents viewed from analytics, whether the module is enabled or
not. A module whose hook fails contributes 0 for that day and logs `control-plane.usage_hook_failed`; the next
hourly run tries again. A day that looks wrong: check that log line, then that the worker ran the jobs
([queue-backlog.md](queue-backlog.md)).

## Signup

With `SIGNUP_MODE=open` (and `SIGNUP_DEFAULT_PLAN` naming an existing, unarchived plan), `/signup` on the
canonical host lets anyone create a workspace:

1. company, legal name, country and a slug;
2. an emailed code;
3. an active owner account, signed in on the canonical host.

The person must tick acceptance of your terms. The version is `SIGNUP_TERMS_VERSION` (default 1), sent to
the page in its config (`signupTerms`); the attestation `platform-terms:v<version>` records exactly what was
accepted. No terms document ships with the product: publish yours, set `TERMS_URL` (the form then links
"Read the terms of service" next to the checkbox) and only then open signup; `fundroom doctor` warns while
`SIGNUP_MODE=open` has no `TERMS_URL`. When the document changes materially, raise `SIGNUP_TERMS_VERSION` on
every replica in the same rollout: new signups accept the new version, existing owners are not asked again,
and a replica still on the other value answers applicants `409 conflict` `reason: terms_version` until they
agree.

### Plans at signup

`GET /api/v1/signup/plans` is the public catalogue a signup chooses from (and what FundRoom's site checks its
pricing against): your `--public`, unarchived plans in catalogue order, as `{ plans: [{ id, name, limits,
trialDays, paid }] }`. It answers only while signup is open (404 otherwise and on tenant hosts), 30 times a
minute per client (an IPv6 client is its /64), and may be cached for 60 seconds. It carries no prices: the
product stores only the provider's price ids, so show prices on your own site. `paid` is true for a plan with
`--price` when workspaces subscribe themselves (`BILLING_DRIVER=stripe`); with `manual` or no billing nothing is
`paid`.

Link to `/signup?plan=<id>` to preselect a plan. The applicant can pick any plan in the catalogue; with no
`?plan=` the form preselects the first free or trial plan. The choice is sent on verify, and the server uses
it only when the plan is still public and unarchived; anything else (a private, archived or unknown id)
silently gets `SIGNUP_DEFAULT_PLAN`. `signup.complete` then records the plan the workspace got as `planId`
and, when it differed, the one asked for as `requestedPlanId`. A plan you archive while someone is signing up
falls back to the default the same way. Making a plan private does not: a signup that already read it still
gets it.

Where the new owner lands, on the workspace's own address:

- `/admin/billing?plan=<id>` when the plan needs a subscription before anything else: public, with a price,
  no trial, and `BILLING_DRIVER=stripe`. The page shows "Finish subscribing to {plan}" with a checkout button;
  nothing goes to Stripe without that click.
- `/setup` otherwise: the setup wizard. Under the control plane it skips the setup token, the mail check
  and the storage check, which are yours, and its last step shows the workspace's own address. There is no
  first-run wizard on the canonical host either, not even before the first workspace exists: no setup
  token is generated or logged, `SETUP_TOKEN` is ignored, and `doctor` shows `firstRunSetup off`. The
  first workspace comes from signup or the operator API.

The signup session is level 1 (an email code), and owners need level 2 on staff routes. So the signup's
last screen asks the new owner to add a passkey or an authenticator app before **Continue**, while that
session can still add one. A new passkey is confirmed there at once (a second browser prompt); a key that
does not check a PIN or biometric leaves the session at level 1, and the screen offers an authenticator app,
or "Continue anyway" (the workspace will ask again).

Signup signs the owner in on the canonical host only, so the workspace host first shows its sign-in page
(with `CENTRAL_AUTH=on` that is one "Continue", no new code, and the session arrives at the level it had).
An owner who still lacks level 2 there is asked by billing and the wizard to add or confirm a factor, then
returned to the same page. A session handed over by central auth cannot add a factor, so it is offered
"Sign in with an email code" on the workspace host first.

Budgets, per hour, checked per client first:

- starts: 5 per email address, 10 per IP, 30 per /24 (IPv4) or /64 (IPv6), and 60 per IPv6 /48;
- verifies: 30 per IP and 90 per network.

A last-resort ceiling of 1 000 starts and 1 000 completions an hour covers the whole install; hitting it logs
`control_plane.signup_ceiling_hit` at error level, which is worth an alert. Slugs that read as the service's
own (`www`, `api`, `admin`, `platform`, `auth`, `sso`, `mail`, `ns1`, `portals`, `fallback`, …) and `xn--`
labels are refused.

A signed-up workspace is held for its sanctions screen like any other (with a driver), and gets its plan's
billing (trial or checkout). While it is held, its owner is told "We are running a standard check on new
workspaces" (the screen is never named), can add a second factor and open billing, and the wizard offers
**Check again**.

### Footer links

`TERMS_URL`, `PRIVACY_URL`, `SUPPORT_URL` and `STATUS_URL` (any install, control plane or not) put Terms,
Privacy, Support and Status links before Accessibility in the footer of the pages that are yours to your
customers: the admin area, signup, setup, the operator console, and sign-in on the canonical host. The
investor portal and a workspace host's sign-in pages show only Accessibility: for a tenant's investors the
tenant, not you, is the controller, and the tenant publishes its own privacy notice.

## Reading the audit trail

| Action | Chain | What |
|---|---|---|
| `operator.enrol_link`, `operator.grant`, `operator.revoke` | platform | CLI |
| `operator.enrol` | platform | the enrolment link: session started, factor added, session ended |
| `operator.session_start`, `operator.session_end` | platform | console sign-in / sign-out |
| `workspace.created` | tenant + platform | operator API or signup |
| `workspace.suspend`, `workspace.unsuspend`, `workspace.hold`, `workspace.release` | tenant + platform | status changes, whoever made them |
| `workspace.plan_change`, `workspace.cell_change`, `workspace.legal_change` | tenant + platform | operator (or billing, for a plan change a Stripe price implies) |
| `workspace.move_request`, `…move_export`, `…move_import`, `…move_switch`, `…move_retire`, `…move_cancel`, `…move_fail` | tenant + platform | a move between cells ([residency.md](residency.md)) |
| `platform.workspace.owners_read` | platform | an operator opened a workspace's detail with owners |
| `plan.create`, `plan.update`, `plan.archive`, `cell.add`, `cell.update` | platform | console or CLI |
| `signup.complete` | platform | self-service signup |

An operator is recorded as actor kind `host` with `meta.operator: true`; only the platform chain carries the
operator's user id. The
tenant's chain says *that* the host acted; the platform chain also says who, from where and why.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `CONTROL_PLANE` | `off` | `on` requires `TENANCY_MODE=multi` |
| `CELL_ID` | `default` | `^[a-z0-9][a-z0-9-]{0,30}$`; unique across all cells when a directory is shared |
| `DATA_REGION`, `DATA_REGION_LABEL`, `DATA_REGION_JURISDICTION`, `BACKUP_LOCATION`, `DIRECTORY_DATABASE_URL`, `MOVE_*` | unset | [residency.md](residency.md) |
| `PLATFORM_OPERATOR_CIDRS` | unset (any network) | comma list of CIDRs or addresses |
| `SIGNUP_MODE` | `off` | `open` requires `CONTROL_PLANE=on` and `SIGNUP_DEFAULT_PLAN` |
| `SIGNUP_DEFAULT_PLAN` | unset | a plan id; signup answers 404 until the plan exists and is not archived |
| `SIGNUP_TERMS_VERSION` | `1` | 1–10000; the terms version a signup accepts, recorded as `platform-terms:v<n>`; raise it when the document at `TERMS_URL` changes materially. It affects new signups only (existing owners are not re-prompted). Roll every replica together: while replicas disagree, applicants get 409 `terms_version` from the ones on the other value |
| `TERMS_URL` | unset | your terms of service (an `https://` URL, `http://` only for localhost; no credentials; served normalised): linked in the host's footer (see [Footer links](#footer-links)) and next to the signup terms checkbox; `doctor` warns when `SIGNUP_MODE=open` has none |
| `PRIVACY_URL`, `STATUS_URL` | unset | https (http only for localhost); linked in the host's footer when set |
| `SUPPORT_URL` | unset | an `https://` URL or a bare `mailto:` address (no `?cc=`/`?body=`); linked in the host's footer when set |
| `BILLING_DRIVER`, `BILLING_GRACE_DAYS`, `BILLING_METER_*_EVENT`, `STRIPE_*` | `none`, `14`, `fundroom_*` | [billing.md](billing.md) |
| `SANCTIONS_*` | `none` | [sanctions.md](sanctions.md) |
| `CENTRAL_AUTH` | `off` | [central-auth.md](central-auth.md) |
