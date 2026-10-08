# @fundroom/module-captable

Optional cap-table module: read-only snapshots imported from
our CSV template, a Carta export or a Pulley export; a fully diluted summary by class, the option
pool and SAFEs/notes outstanding; an investor's own holdings card; immutable published snapshots.

Optional module (`captable` schema, `/api/v1/captable`): `defaultEnabled: false`,
`dependsOn: ["access"]`.

## Not the system of record

This module is a **mirror** of the company's cap table, never the cap table itself. The stock
ledger kept by the company (or its counsel, transfer agent or equity-management provider) governs;
a snapshot here is whatever was imported, as of the date it names. Every investor view carries a
disclaimer — the workspace may replace the wording (`PUT /captable/settings`, Markdown, ≤ 2000
characters) but not remove it. The default text (`DEFAULT_DISCLAIMER`):

> This summary is provided for information only. It is a snapshot imported from the company's
> records as of the date shown and is **not** the company's system of record: the stock ledger
> maintained by the company (or its transfer agent or equity-management provider) governs.
> Figures may be rounded, may not reflect later issuances, transfers, conversions or
> cancellations, and do not constitute legal, tax or investment advice. Contact the company to
> confirm your holdings.

Carta and Pulley are **file imports**: both vendors' APIs are partner-gated, so there is no live
sync (a deliberate deviation).

## Model (`migrations/0001_captable.sql`)

- `captable.snapshot` — one import, as of a date: `draft` → `published` → `superseded`. At most
  one `published` per workspace (partial unique index). `totals` holds the summary computed at
  import (numeric strings, schema version 1).
- `captable.security_class` — the snapshot's classes in display order; `kind` is one of
  `common`, `preferred`, `option_pool`, `option`, `warrant`, `safe`, `note`.
- `captable.holding` — one ledger line: holder, class, `shares` (numeric 24,6) and/or `amount`
  (numeric 20,6, SAFE/note principal, with `currency`), `issued_on`, and `membership_id` when the
  holder's address matched a live member at import.

Immutability is enforced by triggers: after insert a snapshot may only change `status` /
`published_at` along draft → published → superseded; a class never changes; a holding may only be
relinked (`membership_id`) or pseudonymised by erasure (`holder_name`/`holder_email` together with
`erased_at`). Only a draft (and its rows) may be deleted.

RLS: staff and system on every table. An external member may `SELECT` their own `holding` lines of
the **published** snapshot (`captable.snapshot_is_published`, SECURITY DEFINER); a delegate whose
scope admits the cap table (`all`) reads its live principal's lines. `snapshot` and
`security_class` have no external arm — `GET /captable/me` reads them as the workspace's `system`
actor and the member's lines in the member's own context, so RLS (not the route) decides which
lines exist.

## Routes

| Method | Path | Requires |
|---|---|---|
| GET | `/captable/snapshots` | `captable.read` |
| GET | `/captable/snapshots/{id}` | `captable.read` |
| POST | `/captable/import/dry-run` | `captable.manage` |
| POST | `/captable/import` | `captable.manage` |
| POST | `/captable/snapshots/{id}/publish` | `captable.manage` + step-up |
| DELETE | `/captable/snapshots/{id}` | `captable.manage` (drafts only) |
| GET | `/captable/settings` | `captable.manage` |
| PUT | `/captable/settings` | `captable.manage` + step-up (it can widen what investors see) |
| GET | `/captable/me` | member |

`GET /captable/me` answers 404 when the module is off, nothing is published, `investorView` is
`none`, or the caller is a delegate whose scope does not admit the cap table.

Settings live in the module's own enablement row (`core.module_enablement.config.settings`,
written with one `jsonb_set`, so a save never flips the switch): `investorView` —
`own_line` (default: the member's own lines and their % fully diluted), `summary` (adds class-level
bucket percentages, see below) or `none` — and `disclaimer` (`null` = the default text).

### What `summary` may disclose (ORCH R2-G1)

An earlier design (class rows with share counts, merged "Other" rows) was shown in review to leak
single holders by differencing, so the investor summary (`investorSummary` in `src/model.ts`) is
deliberately coarse:

- **Kind buckets only**: common, preferred, options (granted options **and** the pool as one
  bucket, so pool − granted never isolates an optionee), warrants, convertibles.
- **Only % of fully diluted, to 1 decimal place.** No share counts, no amounts, no fully diluted
  total; convertibles (0 % FD) are only flagged as present.
- A bucket is shown only with **≥ 3 distinct holders other than the viewer whose fully diluted
  position is > 0** — distinct by member, else address (case-insensitive), else name (trimmed,
  whitespace collapsed, case-insensitive); pool lines are unallocated shares, not holders; a
  0-share line counts as nobody — **and only when not dominated** (ORCH R3-G1): the largest of
  those holders has ≤ 70 % of their combined fully diluted and the two largest ≤ 90 %. Anything
  else is omitted, never folded into another row. Convertibles show as present only with ≥ 3 other
  holders with an amount > 0.
- **Complementary suppression**: 100 − the shown buckets is the omitted buckets' share, so the other
  holders of the omitted share buckets, pooled, must pass the same count and dominance test (or
  hold nothing); otherwise the smallest shown bucket is omitted as well, repeatedly.
- **The viewer's own lines** are those linked to them **or unlinked under any of their email
  identities** (primary or not) — the same set erasure and the DSAR export use (R5). They are shown
  as the viewer's holdings and are never counted as, or pooled with, other holders.
- `summary: {buckets: []}` when no bucket can be shown (`summary` is `null` only in `own_line` mode). The viewer's own lines keep exact numbers; their
  own % FD is given to 2 dp.

**Aliasing limit:** one investor imported under two names *and* two addresses ("Lead Fund" and
"Lead Fund II LP", each with shares) counts as two holders; the dominance rule catches most such
cases (one real holder then dominates) but not an even split between aliases. Link lines to members
or use one name per holder.

**Residual risks (accepted, documented):** three or more holders of a bucket colluding can pool
their own positions and difference out the rest; a viewer comparing the same bucket across
successive published snapshots can learn the net change between them, which is one holder's
position when a single issuance happened in between. 1-dp rounding blurs small changes but does
not remove this. Workspaces for which that matters should keep `investorView: own_line` (the
default).

## Summary arithmetic

All quantities are `bigint` at scale 1e6 (`@fundroom/decimal`) and leave the server as decimal
strings; percentages are exact to four places, each rounded half away from zero **on its own**,
so a column of them need not add up to exactly 100.0000 — the API returns no correction row and
the UI shows a rounding note.

- **Fully diluted** = common + preferred (as converted **1:1** — conversion ratios are not
  modelled) + warrants + granted options + the option pool still **available**. An `option_pool`
  line states the plan's total pool; `option` lines are grants out of it, so the pool counts
  `pool − granted` (floored at 0) and no grant is counted twice.
- **Option pool**: `poolShares`, `granted`, `available` (`available` needs a pool).
- **SAFEs / notes** count no shares until they convert; they are reported as outstanding
  principal per currency (`convertiblesOutstanding`).

## Import

`POST /captable/import/dry-run` and `POST /captable/import` take
`{format: "template" | "carta" | "pulley", csv, asOf: "YYYY-MM-DD", note?}` and run the **same**
planner, so the preview is exactly what the import writes (the import response repeats it).
Limits: 2 MiB of UTF-8 (the server gives these two routes a larger JSON body limit,
`CAPTABLE_IMPORT_BODY_LIMIT_BYTES`), 5000 data rows, 200 classes.

Holders are matched to members by email — exact, case-insensitive, **live** memberships only
(`active`, not expired, not delegates; a member whose erasure is pending is never linked).

A file that cannot be imported is refused with 422 `captable_import_invalid`, `reason`
(`empty`, `too_large`, `too_many_rows`, `missing_columns`, `duplicate_column`, `invalid_rows`) and
up to 100 `problems` (`line`, `column`, `code`, `message`). Problems that refuse a row: missing
name or class, an unreadable or negative number, an invalid currency, a share class without shares,
a SAFE/note without an amount, a class used with two kinds, an invalid `kind` (template).
Warnings that do not: `email_unmatched` (once per address), `email_invalid` (address dropped),
`date_invalid` (date dropped), `currency_assumed` (USD), `zero_line_skipped`,
`total_row_skipped`, `kind_inferred` / `kind_assumed` (Carta/Pulley), `column_ignored`.

Header cells are normalised (lower case, every run of non-alphanumerics becomes `_`), so
`Quantity (Outstanding)` reads as `quantity_outstanding`. Numbers may carry currency symbols and
spaces; a comma is accepted **only** as a thousands separator (groups of exactly three digits, any
`.` fraction after the last group: `"$1,500,000.00"`). Anything else with a comma — European
`1.234,5`, `1,5` — is refused per row as `shares_ambiguous` / `amount_ambiguous`, never guessed.
Shares may have up to 18 integral digits (`numeric(24, 6)`), amounts 14 (`numeric(20, 6)`); more
than six fraction digits round. Dates may be `YYYY-MM-DD`, `YYYY/MM/DD` or US `M/D/YYYY`.

### CSV template (`format: "template"`)

| Column | Required | Meaning |
|---|---|---|
| `holder_name` | yes | Holder as it should appear (≤ 200) |
| `holder_email` | no | Used to link the line to a member |
| `class` | yes | Class name (≤ 120), e.g. `Common`, `Series Seed Preferred` |
| `kind` | yes | `common`, `preferred`, `option_pool`, `option`, `warrant`, `safe`, `note` |
| `shares` | for share kinds | Shares (or options/warrants; for `option_pool`, the total pool) |
| `amount` | for `safe` / `note` | Principal |
| `currency` | with `amount` | ISO 4217 (defaults to USD with a warning) |
| `issued_on` | no | Issue / grant date |

```csv
holder_name,holder_email,class,kind,shares,amount,currency,issued_on
Jane Founder,jane@acme.com,Common,common,8000000,,,2024-01-15
Seed Fund I,ops@seedfund.vc,Series Seed Preferred,preferred,1500000,1500000,USD,2025-03-01
Option pool,,2024 Stock Plan,option_pool,1000000,,,
Alex Engineer,alex@acme.com,Options,option,250000,,,2024-06-01
Angel Investor,angel@example.com,Post-money SAFE,safe,,250000,USD,2025-06-30
```

### Carta and Pulley (inferred — verify against a real export)

The column names below are **inferred** from the vendors' help articles and sample files, not
verified against a real export, and each field accepts a ranked list of aliases (first present
wins; any other matching column is reported as `column_ignored`). Before relying on either format,
run a real export through the dry-run and check the preview. If `kind` is absent or unknown, it is
inferred from the class name (`SAFE` → safe, `Convertible`/`Note` → note, `Warrant` → warrant,
`Pool`/`Available`/`Unallocated` → option_pool, `Option`/`Plan`/`ISO`/`NSO` → option,
`Preferred`/`Series`/`Seed` → preferred, `Common`/`Founder` → common; otherwise common with a
warning).

| Field | Carta ("Stakeholder / Securities ledger") | Pulley ("Cap table export") |
|---|---|---|
| holder_name | `Stakeholder Name`, `Stakeholder`, `Holder Name`, `Name` | `Stakeholder`, `Stakeholder Name`, `Investor Name`, `Holder Name`, `Name` |
| holder_email | `Stakeholder Email`, `Email`, `Email Address` | `Stakeholder Email`, `Email`, `Email Address` |
| class | `Share Class`, `Security Class`, `Share Class Name`, `Stock Class`, `Class` | `Share Class`, `Security Class`, `Share Class Name`, `Instrument`, `Class` |
| kind | `Security Type`, `Type`, `Class Type` | `Security Type`, `Instrument Type`, `Type` |
| shares | `Quantity Outstanding`, `Outstanding Quantity`, `Outstanding`, `Shares Outstanding`, `Outstanding Shares`, `Quantity`, `Shares`, `Quantity Issued` | `Shares`, `Number of Shares`, `Shares Outstanding`, `Outstanding Shares`, `Quantity` |
| amount | `Principal`, `Principal Amount`, `Investment Amount`, `Cash Paid`, `Amount` | `Investment Amount`, `Principal`, `Amount Invested`, `Cash Invested`, `Amount` |
| currency | `Currency`, `Currency Code` | `Currency`, `Currency Code` |
| issued_on | `Issue Date`, `Date Issued`, `Issued On`, `Grant Date` | `Issue Date`, `Grant Date`, `Issued On`, `Date` |

Rows whose holder (or class) cell reads `Total` / `Grand total` are skipped with a warning.

## Privacy

- **Erasure** (`member.erasure_requested`, not gated on enablement): the member's lines — linked,
  or unlinked but carrying any of their email addresses — get `holder_name = "Erased holder"`, no address, no
  member link and `erased_at`; the numbers stay (a cap table is a record, and removing a line would
  change every other holder's percentage). Serialised with imports by the per-workspace cap-table
  advisory lock; reported as the `captable` erasure step.
- **DSAR** (`modules/captable.json`): the member's own lines in every snapshot with class, date
  and status; never other holders or company totals.
- **Portability**: `snapshot`, `security_class`, `holding` travel as rows; membership ids are
  remapped by the engine; erased lines travel erased.

## Audit

`captable.snapshot_imported`, `captable.snapshot_published`, `captable.snapshot_deleted`
(resource `captable_snapshot`), `captable.settings_changed` (resource `workspace`),
`captable.holder_erased` (resource `membership`). Meta carries ids and counts, never names or
addresses.
