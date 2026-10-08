---
"@fundroom/compliance": minor
"@fundroom/db": minor
"@fundroom/domain": minor
"@fundroom/module-kit": minor
"@fundroom/audit": minor
"@fundroom/contracts": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/module-content": minor
"@fundroom/module-updates": minor
"@fundroom/module-analytics": minor
---

Offering mode and legal templates.

New `@fundroom/compliance`: the shipped legal-template library (12 counsel-review-headed Markdown templates compiled into the package by a committed codegen step), the offering/document/acceptance/consent/relationship services, and the `LegalServices` implementation. `@fundroom/db` migration `0006_compliance`: `core.offering_period` (append-only status history, one open row per workspace, closable but never rewritable), `core.legal_document` + `core.legal_document_version` (immutable, sha256-stamped published versions), `core.consent_event` (append-only, unbundled from notice acceptance), `core.membership.relationship_note` + `first_exposure_at`, and a **tightening of `core.attestation`'s RLS**, which shipped in E0.3 with a permissive policy that let any member of a workspace read another member's legal facts. `updateOfferingStatus` on the workspace accessors.

Acceptance of a legal document is a `core.attestation` row of kind `<slug>:v<n>`, which is the shape the NDA gate already matches, so an accepted NDA settles its own gate. The gate itself is enforced in `requireMember`, not in the SPA: an external member owing a required acceptance is refused everything but the routes that let them read and accept it.

`@fundroom/domain` gains the `legal` settings block (`consentMode`, `enforceAcceptance`, `relationshipWarningDays`, `defaultDisclaimerSlug`). **`analytics.mode` now defaults to `essential` rather than `engagement`** — a behaviour change for any workspace that never wrote the key, and the point of it: a tenant who has not thought about consent no longer measures page dwell by default. Together with the new consent capture this closes R13 and the risk E1.5 booked.

`@fundroom/module-kit`: `LegalServices` on `ModuleServices` (resolve a disclaimer, get a snapshot stamp, read consent, ask whether a purpose is permitted) and `offeringStatusRules.disabledWhen`, which switches a module off for staff too where `hiddenWhen` only hides it from investors. `modules/content` gains a `disclaimer` block hydrated through that port and stamps `page_revision.disclaimer_version` at publish (migration `0002`); `modules/updates` fills the `post_version.disclaimer_version` column reserved for this epic, and now hydrates reference blocks for emailed updates — previously an emailed disclaimer would have carried its slug and no text. `modules/analytics` asks the kernel whether it may record dwell: `GET /analytics/notice` returns one `dwell` boolean folding the workspace mode, the consent mode, the member's stored answer and their Global Privacy Control header, and the browser obeys only that.
