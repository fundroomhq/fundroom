# Compliance template library

Versioned Markdown templates for the legal and compliance documents FundRoom ships with. A generator merges tenant configuration into
them; the product renders the result, records acceptances against a specific version, and re-prompts when a
version changes.

**Nothing here is legal advice.** Every file carries a counsel-review banner and every file is expected to be
edited by a lawyer before a tenant relies on it. Engineering owns the mechanism; counsel owns the words.

## What is in here

| File | id | Audience | Acceptance |
|---|---|---|---|
| `tos.md` | `tos` | tenant-admin | yes |
| `privacy-notice.md` | `privacy-notice` | investor | yes |
| `cookie-notice.md` | `cookie-notice` | investor | no |
| `dpa.md` | `dpa` | tenant-admin | yes |
| `controller-checklist.md` | `controller-checklist` | tenant-admin | no |
| `nda-clickwrap.md` | `nda-clickwrap` | investor | yes |
| `accreditation-self-certification.md` | `accreditation-self-certification` | investor | yes |
| `legends.md` | `legends` | investor | no |
| `accessibility-statement.md` | `accessibility-statement` | public | no |
| `security-policy.md` | `security-policy` | public | no |
| `sub-processors.md` | `sub-processors` | public | no |
| `retention-schedule.md` | `retention-schedule` | tenant-admin | no |

`dpa.md` and `controller-checklist.md` are alternatives, not companions: a managed-host tenant gets the DPA,
a self-hoster gets the checklist, because a self-hosted deployment has no processor.

## Frontmatter contract

Every template starts with YAML frontmatter in exactly this shape. The loader validates it; a missing or
malformed field is a build error, not a warning.

```yaml
---
id: privacy-notice                 # kebab-case, stable, unique across the library
version: 1                         # integer, monotonically increasing
title: Investor privacy notice
audience: investor                 # investor | tenant-admin | host | public | repo
jurisdiction: [us, uk, eu]         # lowercase codes, or [global]
requiresAcceptance: true           # true when a member must click-accept it
mergeFields: [company.name, portal.url]   # the fields this template actually uses
---
```

- **`id`** never changes. It is the key acceptances and overrides are stored against. A renamed file with the
  same `id` is the same document; a new `id` is a new document with no acceptance history.
- **`audience`** decides where the document surfaces: `investor` in the portal, `tenant-admin` in admin,
  `host` for the operator's own agreements, `public` for unauthenticated pages, `repo` for files that live in
  the repository rather than in the product.
- **`jurisdiction`** is advisory metadata for the tenant and for jurisdiction-profile selection. `[global]`
  means "not jurisdiction-specific", not "valid everywhere".
- **`requiresAcceptance: true`** puts the document behind an acceptance gate. The acceptance record stores
  the subject, the `id`, the `version`, the rendered content hash, the timestamp, the IP and user agent.
- **`mergeFields`** must list exactly the merge fields used in the body — no more, no less. The loader
  cross-checks it against the `{{...}}` occurrences, so an unlisted field or an unused declaration fails.

Immediately after the frontmatter, every file repeats the counsel-review banner verbatim. It is part of the
contract: the generator can strip it only when the tenant has explicitly marked a template as reviewed.

## Merge-field contract

Fields use `{{field}}`. Only these exist:

| Field | Renders as |
|---|---|
| `company.name` | Short trading name |
| `company.legalName` | Full legal entity name |
| `company.jurisdiction` | Jurisdiction of incorporation |
| `company.address` | Registered address |
| `company.contactEmail` | General contact address |
| `company.dpoEmail` | Privacy contact, may be unset |
| `portal.url` | Canonical portal URL |
| `portal.name` | Portal display name |
| `workspace.dataRegion` | Where data is stored |
| `workspace.offeringStatus` | `none`, `informational`, `506b`, `506c`, `non_us` |
| `host.operator` | Who operates the deployment |
| `host.isManaged` | Whether this is the managed host |
| `subProcessors` | **Table**, generated from the adapters the operator configured (deployment scope — what the operator's DPA lists) |
| `workspaceSubProcessors` | **Table**, the vendors this workspace connected itself (e-sign, integrations, accreditation, Slack webhooks, Google Sheets) and, while the workspace has AI assist turned on, a third-party AI model provider — for the tenant's own notices, never the operator's DPA |
| `retention` | **Table**, generated from the retention policy |
| `dataLocation` | **Block**: one sentence stating the operator-declared data region (or, plainly, that none is declared) followed by a table of where each component — database, jobs, search, analytics, object storage, backups, email, telemetry, error reporting, virus scanning, AI model — keeps data |
| `aiAssist` | **Block**: one paragraph on AI assist in this workspace — plainly "not turned on" when it is off (or no model is configured); otherwise what the model is sent, that it only drafts for staff review and makes no decision, and where it runs (the operator's infrastructure, or a named third party with its location and retention, not used for training) |
| `effectiveDate` | Date this version took effect for this tenant |
| `version` | The template version, echoed into the body |

Two rules:

1. **Optional fields must degrade gracefully.** `company.dpoEmail` and `host.operator` are frequently unset.
   Write sentences that still read correctly when a field renders empty ("failing which
   {{company.contactEmail}}"), rather than sentences that collapse into nonsense. Never write a template that
   depends on a field being present for its meaning.
2. **`subProcessors`, `workspaceSubProcessors`, `retention` and `dataLocation` render as tables**, on their
   own line, with no surrounding prose that assumes a row count. The first three can legitimately be empty; the templates
   that use them say what an empty table means. `dataLocation` opens with its own sentence, which says plainly
   when the operator has declared no region — so a template never has to write "hosted in {{workspace.dataRegion}}"
   and risk an empty sentence. `workspace.dataRegion` is the declared region's label (else its code) and renders
   empty when none is declared.

Anything outside this list is not a merge field. If a template needs a new one, add it to the contract, to
the generator, and to this table in the same change.

## Tenant overrides

A tenant never edits these files. The library is the upstream; a tenant override is a separate stored
document keyed by `(workspace, templateId)` that records:

- the template `id` and the **base version** it was forked from,
- the tenant's body, and
- who edited it and when.

Resolution order at render time is: tenant override → library template. When the library version moves ahead
of a tenant's base version, the admin sees that their override is behind, with a diff of what changed
upstream between the base version and the current one; they choose whether to merge. The tenant's document
keeps serving until they do — an upstream change never silently rewrites a document a tenant has adopted.

An override inherits the upstream `id` and `audience`. It cannot change `requiresAcceptance` from `true` to
`false`: a document that gates access upstream gates access downstream.

## Versioning rule

**Bump `version` on any substantive change. Do not bump it for anything else.**

Substantive means: a change to a legal obligation, right, permission, period, jurisdiction, contact of record,
or category of data; adding or removing a clause; changing what a person is agreeing to. When in doubt, treat
it as substantive.

Not substantive: typography, spelling, formatting, heading levels, reordering that does not change meaning,
or a change to a `[BRACKETED]` instruction that is never rendered to an end user.

The consequence is the reason for the discipline: **a version bump on a template with
`requiresAcceptance: true` re-prompts every member whose acceptance is against an earlier version.** Until
they accept, the gate that template guards is closed to them — the privacy notice blocks portal access, the
confidentiality agreement blocks the data room, the self-certification blocks offering material. Earlier
acceptances are never deleted; they stay on record and continue to evidence what that person agreed to at the
time, which is exactly what counsel will ask for later.

Versions are integers and only ever increase. Never reuse a version number, never edit a published version in
place, and add a changeset describing what changed and why so that tenants reviewing the diff have the
rationale as well as the text.
