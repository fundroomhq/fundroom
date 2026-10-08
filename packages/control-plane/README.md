# @fundroom/control-plane

The managed-host control plane's kernel services: platform operators,
workspace provisioning and availability, cells and their declared region, self-service signup, plans, the
daily usage rollup and plan quotas, and moves of a workspace to a cell in another region.
The HTTP surface lives in `apps/server` (`routes/platform.ts`, `routes/platform-plans.ts`,
`routes/signup.ts`, `routes/signup-regions.ts`, `routes/platform-moves.ts`, the CLI's `operator`, `cell`,
`plan`, `workspace move` and `move` commands); the runbooks are
[`docs/runbooks/control-plane.md`](../../docs/runbooks/control-plane.md) and
[`docs/runbooks/residency.md`](../../docs/runbooks/residency.md). The shared cell directory the placement
hooks and moves talk to is [`@fundroom/directory`](../directory/README.md). Billing and sanctions screening
are their own packages ([`@fundroom/billing`](../billing/README.md),
[`@fundroom/sanctions`](../sanctions/README.md)) and reach the workspace through this one.

It is kernel, not a module: a workspace's status, cell and plan are read during tenant resolution, before
module enablement is known. Everything here is inert unless `CONTROL_PLANE=on` (which requires
`TENANCY_MODE=multi`); a workspace with no plan is unlimited everywhere.

| Directory | What |
|---|---|
| `operators/` | `core.platform_operator`: enrol-link / grant / revoke / list (CLI only; `grant` needs an existing account with a passkey or confirmed TOTP), the enrolment-only onboarding behind `/platform/enrol`, `isLiveOperator` (checked on every operator request), `operatorMintRefusal` (level 2, ≤ 10 min, never a bound session) and `operatorProofRefusal` (the proving factors predate both the grant and the session) |
| `workspaces/` | `status.ts` — `setWorkspaceHold`, **the one place a workspace's availability changes**: independent holds (`sanctions_review`, `operator`, `billing`, `sanctions`, which only a move sets and lifts and unsuspend never offers), each set and cleared only by its owner, with `status` / `suspended_reason` derived from them by a database trigger; audited on the tenant chain then the platform chain; `provisioning.ts` (one host transaction: workspace, hooks, owner, seeding); `platform.ts` (the operator API's reads and writes) |
| `cells/` | `core.cell`: list, add (`--label`, `--jurisdiction`; the region must be `DATA_REGION` — one database = one region, enforced by the `cell_single_region` trigger), set-origin, drain, `ensureOwnCell` (the start-up creation of the process's own `CELL_ID` row) and `localPlacementCell` (refuses a missing or non-active own cell), and `adoptDeclaredRegion` (the boot check: placeholder cells take `DATA_REGION`, cells in it take a changed label/jurisdiction, audited `cell.update`) |
| `workspaces/placement.ts` | the placement hooks: the workspace id is generated first, `claimSlug` in the directory **before** the local transaction (`taken` = `slug_taken`, never naming the holder; directory down = `503 directory_unavailable`), `activate` after commit and `release` on failure, both best effort (the directory's reconcile sweep repairs). No-ops in local mode |
| `moves/` | moves between cells in different databases: request / cancel / list for operators (`service.ts`), the engine — `move.export` on the source, `move.poll` every minute on every cell, `move.import` on the target, the switchover **by the source** under its workspace-row lock (so an erasure requested meanwhile wins), `move.retire` after `MOVE_SOURCE_RETENTION_HOURS` — and the bundle transfer (`transfer.ts`: the signed export encrypted under a per-move key, one bundle object per attempt, a 24-hour presigned link, sha256 and signature checked against the source cell's published export key with the bundle's key id). Any process of the database that serves the workspace's cell requests, cancels or drives its move (every local cell's moves are polled; a cell change is refused while `relocation` is set), and a workspace still in its first sanctions review cannot move. The switch refuses (fails and rolls back) a source that is deleted, no longer held or under legal hold; a copy is discarded only once the directory disowns it. A moved workspace keeps its plan, legal name, country, subscription record (re-read at the switch) and every hold but `relocation`; the source soft-deletes its copy and drops its subscription row at the switch, and the bundle link and key are erased from the directory at the switch, a failure or a cancel |
| `signup/` | `startSignup` / `verifySignup` / `signupSlugAvailable` / `listSignupPlans` (the public catalogue); budgets per address, IP and network (/24, /64, /48) before a 1 000/h ceiling, and 30/min per client for slug checks and the catalogue; reserved slugs and no `xn--`; the chosen plan when public and unarchived, else the default (`checkoutFirst` decides the billing-first landing); the terms version from `SignupDeps.termsVersion` (config `SIGNUP_TERMS_VERSION`; the exported constant is only its default) and the `platform-terms:v<n>` attestation |
| `plans/` | `core.plan` CRUD (base and metered Stripe price refs; a price is never both), `PlanLimits` parsing (the numeric limits and, the `modules` / `features` entitlement lists; `limits_schema_version` 2; a `modules` entry that is not an optional module of the build is `unknown_module`), `isPlanAssignable` |
| `usage/` | the `control-plane.usage-rollup` jobs over `core.tenant_usage_daily` (incl. the module `usage` hook), 400-day retention |
| `quotas/` | pure `checkQuota`, `createQuotaService` (the `ModuleServices.quota` implementation; takes the workspace row `FOR NO KEY UPDATE`), `PlanLimitError` → `402 plan_limit` `{ limit, max }`; `PlanEntitlementError` (`planLimitError`) → `402 plan_limit` `{ limit: "module" \| "feature" }` for entitlements |

Rules every caller follows: call the status function inside your transaction **before your own first
audit**, after locking your own rows (lock order: your rows → workspace row → workspace chain → platform
chain), and run the returned `afterCommit()` after commit. Drizzle is used only under `*/repos/`.
Operators are recorded as the `host` actor with `meta.operator: true`; only the platform chain carries their user id.
