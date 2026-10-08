# @fundroom/module-metrics

KPIs: the numbers a founder
publishes to investors — headcount, ARR, runway — entered by hand, imported from a CSV, synced
from a Google Sheet or derived from the others by formula, each with its own audience and a
history that records every restatement.

Optional module (`metrics` schema, `/api/v1/metrics`), and the first genuinely optional one of
Phase 2: `defaultEnabled: false`, because a workspace that never publishes a number should not
carry the tables. `dependsOn: ["access", "content"]` — `content` because the module registers
the `metric_grid` block hydrator.

## Required extension

`btree_gist`, the second extension this product needs after `ltree`. The
exclusion constraint that keeps two *live* points from claiming the same period needs uuid
equality inside a GiST index alongside the range-overlap test, and only `btree_gist` provides
that operator class. A self-hoster on stock PostgreSQL has it in `contrib`; the migration
creates it with `IF NOT EXISTS`.

## Model

- `metrics.definition` — what a number *is*. A stable machine `key` (`^[a-z][a-z0-9_]{0,62}$`,
  citext) that CSV columns and formula `ref`s address, a unit and — only for `currency` — an
  ISO 4217 code, how it aggregates, which direction is good, how many decimals to render, and
  the `audience`. A definition with a `formula` is derived and must aggregate `last`: a formula
  is evaluated per period, so summing its output across periods is arithmetic on something that
  was never a quantity. Soft-deleted, with the uniqueness on `(workspace_id, key)` scoped to
  live rows so a key can be reused.
- `metrics.source` — provenance of a write: one row per CSV run, Sheets sync or recompute, not
  one per point. `ref` says which.
- `metrics.point` — one `(definition, period)` value, and **append only**. A correction writes a
  new `revision` and points the old row's `superseded_by` at it. A trigger enforces that:
  `DELETE` is refused outright, and an `UPDATE` may set `superseded_by` and nothing else, once,
  from NULL, and only to a **higher revision of the same `(workspace, definition, period)`**
  (`0002_point_supersede_integrity.sql`). That last clause is what the trigger's messages
  always claimed and the bare `REFERENCES metrics.point (id)` never carried: without it a row
  could be superseded by a point of another definition or another workspace, and a two-row
  cycle made the period vanish from `point_current` altogether. `audit.event` can simply REVOKE
  both; we cannot, because superseding *is* an update. `period` is a half-open `tstzrange`;
  `period_start` is generated from it.
- `metrics.point_current` — the live series, `WITH (security_invoker = true)`. Without that the
  view would run as its owner and RLS would not bite.
- `metrics.import` — a CSV run and its per-row outcome, modelled on `core.invite_import`.
- `metrics.sheet_connection` — one per workspace. The service-account private key is
  envelope-encrypted under the workspace DEK exactly as `updates.sending_domain` keeps its DKIM
  key (purpose `metrics-sheets`), and `service_account_email` is shown to the admin so they know
  which address to share the sheet with.
- `metrics.source_binding` (`0006_kpi_bindings.sql`) — a definition fed by one series of a
  KPI integration; see below.

## KPI sources

QuickBooks Online, Xero and Stripe connections belong to the kernel (`/admin/integrations`,
`core.integration_connection`); this module only **binds** a metric to a series one of them
offers and pulls it through `ModuleServices.integrations`. `0005_kpi_source_kinds.sql` adds
`quickbooks`, `xero`, `stripe` to `metrics.source_kind` (alone in its file: a new enum label
cannot be used in the transaction that adds it); `SOURCE_KINDS` in `model.ts` mirrors it.

- **Binding** (`PUT /definitions/{id}/binding`, `metrics.settings` + fresh session): one per
  definition, `{provider, sourceMetric, enabled}`. Only a `month`, non-formula metric can be
  bound (422 `binding_period_unsupported`, also on a `PATCH` that would make a bound metric
  quarterly or derived); the series must be in the provider's catalogue and match the unit
  (money → a currency metric, a count → a count metric). No connection is needed to bind.
- **Sync** (`src/service/kpi-sources.ts`) runs only in the job `metrics.kpi_sync_provider`, one
  per **(workspace, provider)** (stately, 30-minute expiry, `work.concurrency` = 3 so a slow
  Stripe never holds up Xero or QuickBooks). The nightly cron `metrics.kpi_sync`
  (`55 4 * * *`) and `POST /sources/sync` (`metrics.manage`, 6/hour, answers **202
  `{queued, providers}`** and never reads inline) both enqueue it under
  `metrics.kpi_sync:<workspace>:<provider>`, so at most one is queued and one runs per key. The
  job's abort signal is passed into every `readKpi`; after 20 minutes no new vendor read starts
  and the remaining bindings get `last_error = "deferred to next sync"` (status untouched).
  Deferred bindings are read first on the next run. When a combined read fails:
  `too_large` on a 24-month backfill goes straight to the trailing 3 months for the group (with
  the history note); `unauthorized`, `forbidden`, `rate_limited` and `unavailable` fail the
  provider once (no fan-out); an aborted read is deferred; anything else (`malformed`, …) is
  re-read per series, and a series that still fails does not discard the ones already read.
  tx1 loads the enabled bindings and each provider's connection summary;
  `services.integrations.readKpi` runs **outside any transaction**; tx2 takes a per-workspace
  advisory lock, the bindings `FOR UPDATE` and their definitions `FOR SHARE`, drops any
  deleted/disabled/re-pointed while the vendor answered, writes through `applyCells` with
  `reviewPolicy: "when_manual"` (a synced value over a hand-typed one is a new revision flagged
  `needs_review`), announces the points, records each binding's health and audits
  `metrics.kpi_synced`. Windows are **per binding**: bindings that have synced before read the
  trailing 3 months, new ones the trailing 24 (two reads when both exist). A 24-month read
  refused `too_large` is retried **per series**; only a series still too large on its own drops
  to 3 months, and its binding's `history_note` says so. `history_from` is the earliest month a
  sync wrote; `history_note` survives later 3-month successes and is cleared only by a backfill
  that got the whole window. A `historical: false` series (Stripe `mrr`, `active_subscriptions`)
  writes only the current month. A currency the metric is not kept in fails that binding.
- **One source per metric**: a metric in the Google Sheet mapping cannot be bound, and `PUT
  /sheets` refuses a mapping naming a bound metric (409 `conflict`, `reason: source_overlap`).
- **Failure**: a refused read (`unauthorized`, `rate_limited`, …) or no connection records
  `status = failed`, `last_error` (`"not connected"` after a disconnect), `consecutive_failures`,
  an audit row (`metrics.kpi_sync_failed`) and a warn log on every binding of the provider — and
  sends no mail; the kernel's `integration.connection_unhealthy` event is what alerts a human.
- `GET /sources` (`metrics.settings`) lists the three providers (connected, health, series) and
  the bindings. No credential ever reaches this module.

## Periods, decimals, formulas

Three pure files carry the arithmetic, and each exists because the obvious version is wrong.

- `src/period.ts` — calendar periods, canonicalised in **UTC**, with no fiscal-year setting.
  A fiscal-year start re-buckets stored history the moment it changes: the `tstzrange` already
  written keeps its bounds while the label the UI derives from it moves, so a number published
  as Q1 silently becomes Q2 and nothing can tell which reading a reader saw. Companies whose
  year does not start in January use `custom` ranges, which say what they mean.
- `src/decimal.ts` — every number is a `bigint` at scale 1e6. `pg` returns `numeric` as a
  **string**, and a `Number()` anywhere on that path loses the last places of a
  `numeric(20, 6)` while still reading plausibly. Same class of bug as the timestamptz-as-text
  trap in `modules/analytics/src/repos/analytics-repo.ts:28-34`; same answer, coerce once in the
  repo. Rounding is half away from zero, which is what a founder's spreadsheet does.
  `quantize(v, decimals)` is the single point of truth for what a metric's value *is* at its
  declared precision: `applyCells` compares **and** stores it, so a figure that renders
  unchanged writes no revision. Comparing at full scale while storing at `decimals` — which is
  what this did — made the no-op rule false for every metric with `decimals < 6`, and 0 is the
  column's default. `fits(v)` is the other half: a value that would overflow `numeric(20, 6)`
  after rounding is a 400 naming the cell, not a `22003` arriving at the caller as a 500.
- `src/formula.ts` — derived metrics as a small expression tree (depth ≤ 6, ≤ 8 distinct refs),
  not an expression string: a string invites `eval`, a hand-rolled tokeniser or a dependency,
  and all three make the stored jsonb something a reviewer has to execute in their head.
  `evaluate` answers `undefined` — never zero, never `Infinity` — for a missing input or a
  division by zero, so `runway = cash / net_burn` with no burn is a gap in the chart rather
  than a claim that the company has run out of money.

## Audience, not grant

Per-metric gating is an `audience` jsonb (`staff_only | all | groups`), copied from
`modules/updates` rather than from the data room's `core.has_access`. A metric is not something
an investor requests access to, it is a number that is shown or not shown; grants would put
every metric row into `effective_access`, `whoHasAccess`, `explain` and the access-management
screens, and would bump `acl_version` — invalidating every principal's access cache — to publish
a headcount. It is a deliberate choice over an `is_public_to_groups uuid[]` column: a
bare uuid array cannot say "everyone" or "staff only" without overloading the empty array.

The default is `staff_only`, where updates' is `all`. An update's audience is chosen at the
moment it is sent; a metric definition exists for weeks before anybody decides who should see
it, and an open default would publish it during that window.

Both halves of the rule fail closed on an arm they do not recognise:
`metrics.audience_admits_current`'s `ELSE false` in SQL, `parseAudience`'s fallback to
`DEFAULT_AUDIENCE` in TypeScript.

## RLS

Tenant fence plus staff/system policies on every table. External actors read live definitions
their audience admits (`definition_external_read`) and the points of those definitions
(`point_external_read`, joined to the definition — there is no per-point gating, because one
visible period beside an invisible one reads to an investor as a gap in the company's history
rather than as a permission). `source`, `import`, `sheet_connection` and `source_binding` are staff-only: an
investor must not learn that a number came from a spreadsheet, or what it was called.

## Testing

`period.ts`, `decimal.ts`, `formula.ts` and `model.ts` are pure and unit-tested beside their
sources — month/quarter/year boundaries including leap years and year rollovers, key
round-trips and refusals, the half-up rounding boundaries and a parse→format property at every
`decimals` setting, cycle detection in both the direct and transitive form, and `parseAudience`
never widening. The RLS halves are pinned by the integration suite, which reads a `groups`
metric both through the API as a non-member investor and with a raw `SELECT` under an external
tenant context.

## Portability

`src/portability.ts`: `definition`, `source`, `point`, `import`, `sheet_connection` — all rows,
in FK order (`point_current` is a view). Migration `0003_portable_supersede_fk.sql` makes
`point.superseded_by` `DEFERRABLE INITIALLY DEFERRED`, so the restatement chain (which points at
later rows) is inserted as exported and checked at COMMIT; the append-only trigger does not fire
on INSERT. A CSV `import` still `pending`/`running` comes back `failed` (its job does not travel).
`sheet_connection` travels **without its credential**: `exportRow` blanks `credential_enc` (empty
bytea — the column is NOT NULL) and the envelope descriptor, and `importRow` disables the
connection with `status = failed` and an error asking for the service-account JSON again;
spreadsheet, range and mapping survive.
`source_binding` travels as rows with its health cleared (`status = idle`, no
`last_success_at`), so the copy's first sync — once it connects the provider; connections are
never exported — backfills 24 months, and until then records "not connected".
