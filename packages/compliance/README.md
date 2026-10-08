# @fundroom/compliance

Offering mode and the legal kernel: the
versioned offering status and what each status permits, the tenant legal-document library with
immutable published versions, click-wrap acceptance, consent for optional purposes, the
pre-existing-relationship heuristic, and the shipped template library.

**Nothing here is legal advice.** Every shipped template carries a counsel-review banner, and the
generator refuses to compile one that has lost it. Engineering owns the mechanism; counsel owns the
words.

## Wiring

```ts
import {
  createAcceptanceService,
  createConsentService,
  createDocumentService,
  createLegalPort,
  createOfferingService,
  createRelationshipService,
} from "@fundroom/compliance";

const deps = { db, audit, now: () => new Date(), log };
const offering = createOfferingService(deps);
const documents = createDocumentService(deps);
const acceptances = createAcceptanceService(deps);
const consent = createConsentService(deps);
const relationship = createRelationshipService(deps);

// `ModuleServices.legal`: what a module is allowed to know about legal texts and
// about accredited status. It delegates to `acceptances` for self-certification, so the two
// attestation rows, the audit row, the certificate and the ACL bump have exactly one writer.
const legal = createLegalPort(deps);
```

Every service method takes `(ctx, tx, …)` — the caller's tenant transaction, never its own. That is
the point: changing the offering status is one transaction that closes a period, opens another,
moves the column, writes audit and publishes an event; an acceptance is one transaction that writes
the attestation and bumps `acl_version` so the gate re-evaluates.

| Service | Answers |
|---|---|
| `offering` | `current`, `history`, `change` (one transaction, confirm-gated for 506(c)), `permits` |
| `documents` | `list`, `read`, `version`, `create` (optionally `from: <templateId>`), `update`, `publish`, `remove` |
| `acceptances` | `pendingFor(membership)`, `accept` (idempotent), `register(filter)` for the export |
| `consent` | `effectiveFor`, `storedFor`, `record`, `history` — plus the pure `consentAllows` |
| `legal` | the four above plus `accreditation`, `certifyAccreditation`, `recordVerifiedAccreditation`, `noteExposure` |
| `relationship` | `read`, `record` — plus the pure `relationshipWarning` |
| `legal` port | `resolveDisclaimer`, `stampFor`, `consentFor`, `allowsPurpose` |

## Offering status

`none | informational | 506b | 506c | non_us` is a column on `core.workspace` for the fast read and
an append-only `core.offering_period` history for the evidence. `permits(status)` returns the offering-status
permissions table as data, so the admin screen and the route guards read one source:

| | round/terms | public sections | share links | accreditation |
|---|---|---|---|---|
| `none` | – | – | – | – |
| `informational` | – | yes | – | – |
| `506b` | yes | factual only | yes | – |
| `506c` | yes | yes | yes | **required** |
| `non_us` | yes | – | yes | – |

Switching **to** `506c` returns `requiresConfirmation: true` and writes nothing until the caller
passes `confirmed: true` (the route layer turns that into a confirm-token). Switching **away from**
`506c` throws `ComplianceError("offering_irrevocable")`: reliance is irrevocable for that offering,
so falling back is a new offering, not a setting. A workspace with no period rows gets one opened
lazily on first read, starting now — pre-E1.6 workspaces get an honest history rather than a
backfilled date nobody can stand behind.

## Documents, versions and the `<slug>:v<n>` stamp

A `core.legal_document` is mutable metadata pointing at an immutable chain of
`core.legal_document_version` rows. Publishing computes the sha256 of the body, takes the next
version number, points `current_version_id`, audits, publishes `legal.document_published` and bumps
`acl_version` with cause `attestation`. Publishing a body byte-identical to the current version is
refused (`published: false`, existing version returned): a no-op version would invalidate every
acceptance on record and make every member click "I agree" again for nothing.

`stamp(slug, n)` → `"privacy-notice:v1"`. It is a *string*, not a foreign key, in three places: the
attestation kind, `post_version.disclaimer_version` and `page_revision.disclaimer_version`. An
auditor reading a snapshot six years later should not need a join, and the snapshot must stay
readable after the document is deleted.

## Acceptances reuse `core.attestation`

There is no acceptance table. An acceptance is an attestation with `kind = '<slug>:v<n>'`, so the
authz gate evaluator settles an accepted NDA with no new machinery and the People screen shows
legal acceptances beside every other one. `attestation.data` carries the document, the version, the
sha256 of the body the member was shown, the timestamp, a browser **family** and a **keyed hash** of
the address — never a raw IP, never a User-Agent string. Use `uaFamilyOf` and `ipHashOf`
to derive them. Re-accepting a version already held is a no-op that returns the existing row.

`AcceptInput` deliberately has **no client-supplied `bodySha256`**. The server records its own,
read from the stored version, because a hash the signer's browser computed is evidence of nothing —
the signer is the one party with an interest in what it says. What makes the bytes trustworthy is
that they travelled to the browser on the bootstrap from the same row the acceptance names.

`typedName` and `viaLinkId` are the other two evidence fields: the name the signer typed and the share link they came in through. Both land in `attestation.data` and
flow into the certificate.

### Re-acceptance on version change

`pendingStamps(...)` is the pure core of `pendingFor`, and it needs no special case for this: the
version lives in the stamp, so a member holding `nda:v1` simply does not hold `nda:v2`. Publishing a
version bumps `acl_version` in the same transaction (`DocumentService.publish`), the ACL rebuilds,
the gate re-reads the document's current stamp, and every holder of the old one is pending again.
Old acceptances stay on record; nothing rewrites a policy row.

### Certificates

`ComplianceDeps.certificates?: CertificateIssuer` is a **structural** interface this package
declares (`src/service/certificates.ts`); `@fundroom/clickwrap` implements it and the composition
root wires the two. Neither package imports the other, and there is no `ESignPort`: click-wrap is
synchronous and in-process, vendor e-sign is asynchronous envelopes with webhooks, and a port shaped
around the first would be the wrong shape for the second.

`accept()` calls the issuer **after** the `legal.document_accepted` audit row, passing that row's
`seq` and `hash`, then writes the returned reference into `attestation.evidence_ref`. That is what
binds the certificate to the audit chain in both directions with no cycle and no second hash chain.

**With no issuer wired, acceptance behaves exactly as it did before E2.3** — attestation row, audit
row, ACL bump, null `evidence_ref` — and `issueCertificate` does not so much as touch the
transaction. That is a contract, not a degraded mode.

### Accreditation self-certification writes TWO rows

Do not collapse them; they are different facts, read by different things.

| Row | Means | Expiry | Read by |
|---|---|---|---|
| `<slug>:v<n>` | "agreed to *this text*" | none | `pendingFor`, the certificate |
| `accredited` | "is accredited **as of this date**" | `signed_at + 12 months` | the `accredited` gate |

Collapsing them forces one row to mean both, and then either the click-wrap record expires — losing
evidence a tenant must keep for six years after close — or the accreditation never does, which is
the thing the form's own renewal clause promises will not happen.

The category answers are **data, never a code enum**: `ACCREDITATION_CATEGORIES` is a frozen list of
`{ id, section, subject, label }`, `AccreditationAnswersSchema` accepts an id the shipped set does
not know (a tenant's counsel may add one), and `ACCREDITATION_QUESTIONNAIRE_VERSION` versions the
question set independently of the tenant's document version. Rule 501(a)'s list has been amended
twice in five years; a TypeScript union would make each amendment a migration and a release.

This package owns **self-certification only**. E2.5 owns the vendor path — the `verification`
record and `AccreditationVerificationPort` — and the difference matters: under Rule 506(c) an issuer
must take *reasonable steps to verify*, which needs evidence beyond the investor's word.

### The register, its cursor, and the export

Keyset pagination lives in `AcceptanceRegisterRepo.page(...)`, not in the caller (E1.6 flagged the
in-memory version as debt; this is that debt paid). The cursor carries **every column of the ORDER
BY** — `(signed_at, membership_id, kind)` — and the predicate is a row-wise comparison, because two
people accepting the same version in the same microsecond is precisely what a publish causes, and a
`signed_at`-only cursor either skips the second of a tied pair or returns the first for ever.
`decodeRegisterCursor` refuses a partial cursor rather than half-honouring it. The wire format is
unchanged, so cursors clients already hold keep working.

`registerCsv(entries)` and `registerJson(entries, meta)` are pure. The CSV does two escaping jobs:
RFC 4180 quoting (comma, quote, CR/LF; quotes doubled) so the file *parses*, and an apostrophe
prefix on any field starting `=`, `+`, `-`, `@`, tab or CR so counsel's spreadsheet does not
*execute* it — slugs and evidence refs are tenant-controlled, and `=HYPERLINK(...)` in a cell runs
on open in Excel, LibreOffice and Sheets alike. Both serialisers re-sort by the register's own total
order, so a file assembled from pages in any order comes out byte-identical.

The **PDF half** of a "signed PDF/CSV bundle" is deliberately not here: a signed
bundle needs the audit chain's own signature over it, which is the signed audit export.

## Consent (R13)

`consentAllows({ mode, stored, gpc })` is pure, exported and exhaustively tested — every mode ×
stored yes/no/absent × GPC on/off:

- **GPC always wins and always means no**, in every mode, even over an explicit stored grant.
- `opt_in` permits only on an explicit grant.
- `opt_out` and `notice_only` permit until the member explicitly withdraws.

`modules/analytics` asks through `ModuleServices.legal.allowsPurpose(...)` rather than reading
`core.consent_event` itself; `consentFor(...)` reports the bare stored answer for the portal screen
that explains a person's own choice back to them.

**GPC is durable.** Most facts `allowsPurpose` judges arrive with no browser attached — an
ESP open webhook, the hot-list rollup, a notification fan-out — so a header-only signal would never
reach them. The kernel's GPC middleware (`apps/server/src/middleware/gpc.ts`) therefore calls
`ConsentService.recordGpcRefusal` the first time a signed-in member's request carries
`Sec-GPC: 1`: it appends `granted: false, source: "gpc"` for **both** purposes, but only for a
purpose whose newest answer is not already a GPC refusal, and caches the settled answer
in-process (10-minute TTL, dropped when this process records a consent answer), so a steady GPC
browser costs no write and usually no read. After that, `allowsPurpose` *without* signals denies
in every mode. **A later explicit grant made from a browser without GPC is a newer fact and wins**
(the person changed their mind somewhere the signal is off); the next GPC request records a newer
refusal again. A grant *sent with* GPC contradicts itself and `PUT /compliance/consent` refuses it
(409 `conflict`, `reason: "gpc"`).

**Erased members.** `isErased(tx, ctx, membershipId)` is true while the member has an **erasure**
request that is not cancelled (`requested` or `completed`) — an access or rectification request never makes anybody read as erased — and `allowsPurpose` answers false for them in
every mode. `core.dsar_request` is readable by staff/system only, so for a member's own context the
port does not silently see "no request": it switches the transaction-local `app.actor_kind` to
`system` for that one read **on the caller's transaction** and restores it straight after
(`DsarRequestRepo.hasLiveForInOwnTx`). It never opens a second transaction: analytics' tracking and
ingest call this while holding their own, and a second pool connection there deadlocks under load
(`dsar.integration.test.ts` runs with `DATABASE_POOL_MAX=1` to keep it that way). The workspace
fence is untouched, and it works in a read-only (view-as) transaction.

## DSAR erasure requests

`createErasureService` records the request with its statutory due date, freezes the modules it
waits for and publishes `member.erasure_requested` in the same transaction; each module reports
through `LegalServices.completeErasureStep`, and the request completes when every expected module
has reported. Two limits worth stating plainly:

- **Cancel stops tracking; it does not recall.** The event is already on the outbox when the request
  is accepted, so every module that has received it — including one that has not reported yet —
  may still erase, and nothing erased is restored. After a cancel, late step reports are still
  recorded as evidence but no longer complete the request; the cancel audit row lists the modules
  that had already reported.
- **A legal hold must be in place before the request.** `legal.legalHold` refuses *new* requests;
  setting it after a request was accepted does not recall that request or stop modules erasing.

### The identity step, `core.identity`

When the last expected module reports (or at once, when none is expected) the kernel runs its own
final step **in the same transaction** — so every module has already read what it needed; the CRM,
for instance, matches hand-made contacts by the member's email — and only then completes the
request (`service/identity-erasure.ts`, `repos/identity-erasure-repo.ts`):

1. membership `profile` → `{}`, `relationship_note` → null;
2. membership → `revoked` (reason `erased`) with its delegates, groups, grants and the invites it
   issued, `membership.revoked` published and `acl_version` bumped;
3. invites that carried the address → `erased+<the invite row's id, hex>@erased.invalid` (keyed on
   the row, never a digest of the address: a digest is reversible from a list of candidate
   addresses, and an address erased, re-registered and erased again must not collide), message
   dropped, pending ones revoked; this workspace's login challenges for the person deleted;
4. the person's sessions that last served this workspace (or none) → revoked (`erased`), ip and user
   agent scrubbed. `core.session` is global and admits only the host or the session's own user, so
   the transaction-local `app.user_id` is pointed at the subject for that one statement and restored
   — on the same connection. Opening a host transaction instead would take a second pool connection
   inside a module's outbox transaction;
5. `core.erase_user_identity` (0012): pseudonymises the global user (display name `''`, every
   identifier, credentials, devices, every session) **only** when the person holds no other live
   membership anywhere; otherwise the per-workspace erasure above is all there is.

The step is recorded with counts (`profiles`, `memberships`, `grants`, `invites`, `challenges`,
`sessions`, `global`) and audited as `compliance.identity_erased` with `meta.global`. Identities are
pseudonymised by 0012 the same way, keyed on the identity row: `erased+<id hex>@erased.invalid`.

**The last active owner is never erased.** The request route refuses one (409 `reason:
"last_owner"`), and because a co-owner can step down between the request and the last module's
report, `identityBlockedBy` is checked again at completion. A blocked request **stays `requested`**
with every module step recorded, and nothing about the identity is touched — no profile scrub, no
membership or session revoke, no `erase_user_identity`. The request detail says why
(`blockedReason: "last_owner"`, computed on read by `withBlockedReason`: `dsar_step` is insert-only,
so a stored "blocked" step would stand in for the real one forever). Once ownership has moved,
`POST /compliance/data-requests/{id}/complete` (`ErasureService.finish`) runs the step and
completes the request (409 `last_owner` while it has not; `self_completing` while a module is still
pending). `eraseIdentity` itself refuses a last owner as a backstop.

## Access and rectification requests, and the subject export

`createDataRequestService` handles the other two kinds on the same table: one open request per
member **and kind** (0012's index), the same statutory clock as erasure (30 days; 45 under `us`),
audited as `compliance.dsar_requested` / `compliance.dsar_completed` (the completion note stays on
the row, never on the chain). Neither kind fans out: **access** is answered by the subject export,
then completed by hand with the `exportSha256` the admin received (the export's `X-Content-SHA256`
header), which must match a `compliance.dsar_exported` audit row for that member in this workspace
(409 `reason: "export_unknown"` otherwise) and is stored on the request — or with a note alone
("sent by post"); **rectification** is carried out on the People screen and completed here with a
note. The export itself is side-effect free except for its audit row: a download can be lost, and a
GET that closed a statutory request on bytes nobody may have received would record an answer that
never arrived. Erasure requests complete themselves (409 `self_completing`), except the blocked
last-owner case above. `listDataRequests` lists every kind.

The export (`service/subject-export.ts`) is a zip of `manifest.json` (`kind:
"seed-host.dsar-export"`, the sha256 of every other file), `README.txt`, `profile.json` (without the
staff-only `relationship_note`), `attestations.json`, `consent.json` (never the ip hash),
`acceptances.json` (`registerJson`), `sessions.json` (this workspace's sessions of the person: device
name, ip, user agent, sign-in level, times — read on the same transaction with `app.user_id` pointed
at the subject, as the identity step does), `share-links.json` (`share_link_visit` and
`share_link_view` rows), `mail.json` (`mail_message` rows: ids, stream, reference, tracking flags,
time — no body is stored), `access.json` (grants naming the member directly, without the staff
note), `requests.json` (their own data requests: kind, clock, outcome, export digest — not the staff
notes), `audit.jsonl` (below) and `modules/<id>.json` from each module's `dsar.export` hook.

`audit.jsonl` holds the events where the member is actor, subject or acted-for, as `{seq,
canonical, hash}`, capped at 100 000 lines (flagged in the manifest). A line the member wrote
is the chain's own text and re-hashes to its `hash`. A line somebody else wrote (staff, the system)
is **redacted** (`subjectAuditLine`): `actor_user_id`, `session_id`, `ip` and `user_agent` → null, and
typed free text in `meta`/`diff` (`reason`, `note`, `message`, `relationshipNote`, …) →
`"[redacted]"`; the line lists what was removed in `redacted`. **A redacted line does not re-hash**:
`seq` and `hash` still place it in the chain, and the verifiable artefact for counsel is the signed
audit export (`POST /audit/exports`), not the subject's copy. The acting staff member's membership
id stays (who handled their data is the subject's to know; a name never is).

Module exporters run by module id, each in its own system transaction, sequentially — except that a
module runs after those it names in `dsar.after` and receives their exports as `related`
(`dsarOrder`). That is how round exports `contactCommitments` — commitments recorded against the
member's CRM contacts, with amount, status, wire date and note — without reading `crm.*`: it takes
the contact ids from the CRM's export (`after: ["crm"]`). The route runs the kernel's reads in one
system transaction, each module's exporter in its own, then the `compliance.dsar_exported` audit
row — never nested. `buildSubjectExport` is pure and byte-stable for a given `generatedAt`;
`verifySubjectExport` checks an archive against its own manifest. Uploaded documents appear as
**metadata only** (the bytes stay in the data room).

## The pre-existing relationship warns, never blocks (R5)

`relationshipWarning({...})` fires only under `506b` and returns the single worst problem:
`no_source` → `no_date` → `exposure_before_relationship` → `access_too_soon`. An admin told four
things at once fixes none of them, and a warning that blocks becomes a warning admins route around
— at which point the facts stop being recorded, which is the only thing the product can actually
contribute here.

## Residency facts

`src/residency.ts` is the one place that turns what the deployment knows about where data lives into
what tenants read: **Settings → Data residency** (`GET /api/v1/residency`, `apps/server/src/routes/residency.ts`)
and the templates' `{{workspace.dataRegion}}`, `{{subProcessors}}` and `{{dataLocation}}` fields. It is
pure: the server reads config and the workspace's vendor connections, this module decides.

- `normaliseSubProcessor(source)` maps every adapter's sub-processor metadata — the older e-sign,
  integrations, accreditation, billing and sanctions shapes, and the E3.11 `SubProcessorMeta` the email,
  S3 and Cloudflare-for-SaaS adapters declare — to one `SubProcessorMeta` (name, purpose, data processed,
  location, jurisdiction or `varies`, transfer mechanism, DPA link, certifications). A location without an
  explicit jurisdiction is inferred from its text (`inferJurisdiction`), `varies` when unknown.
- `collectDeploymentSubProcessors(facts)` lists what the operator configured (mailer — an SMTP relay on
  a public host as "Email relay (SMTP, not identified)", never its hostname —, object storage when it is
  a third party, Cloudflare for SaaS, billing, hosted sanctions screening); the workspace's own vendors
  (e-sign, integrations, accreditation, Slack incoming webhooks, the metrics Google Sheets connector)
  are added with scope `workspace`.
- `residencyComponents(facts)` builds the component table (database, jobs, search, analytics — all in
  the cell's database —, object storage, backups from `BACKUP_LOCATION`, email, telemetry when an OTLP
  endpoint is configured, and `virusScan` with `AV_DRIVER=clamd`). Error reporting is not emitted:
  nothing consumes `ERROR_REPORTING_DSN` yet.
- `renderDataLocation` renders the `{{dataLocation}}` block (a sentence on the declared region — or,
  plainly, that none is declared — and the component table), used by `dpa` v2 ("Annex: Data
  location") and `sub-processors` v2. The DPA's `{{subProcessors}}` is **deployment** scope only (a
  vendor one workspace connected is not in the operator's DPA); the investor privacy notice (v2) also
  gets `{{workspaceSubProcessors}}`, the vendors the workspace connected itself. A vendor outside the
  region says so in its location cell (`subProcessorRowsOf`).
- `inDeclaredRegion` compares jurisdictions: `null` (no flag) when no region is declared, its
  jurisdiction is `other`, or a vendor's is `varies`. `standardTransferMechanism` names the
  safeguard only where the software can know it: a US vendor seen from an `eu`, `uk` or `ch` region
  gets the SCC wording "(or the EU-US Data Privacy Framework — operator to confirm)", EU↔UK↔CH gets
  "Adequacy decision", anything else none (templates render "Not stated"). Jurisdiction `varies`
  reads "Varies / not identified".

**Every location is operator-declared.** The product cannot verify where a database or bucket
physically is; each sentence rendered from these facts says the region is declared by the host.
The workspace's privacy regime (`legal.privacyRegion`) is a separate setting and never derived from
the region. The operator runbook is [`docs/runbooks/residency.md`](../../docs/runbooks/residency.md).

## Templates

`templates/*.md` are the upstream library: YAML frontmatter, the counsel-review banner verbatim,
`{{merge.field}}` placeholders. `scripts/build-templates.mjs` parses and validates them and writes
the committed `src/generated/templates.ts`; `templates.test.ts` regenerates in memory and fails on
drift. Run it with `pnpm --filter @fundroom/compliance codegen` (or `turbo run codegen`) after
editing a template.

Validation is a build error, not a warning: missing frontmatter keys, an unknown audience, a lost
banner, a `{{field}}` outside the contract, a field used but not declared, or a field declared but
never used all fail the build. `renderTemplate(template, context)` substitutes the fields;
`subProcessors` and `retention` render as Markdown tables (including when empty) and an unset
optional scalar renders as nothing, never as `undefined` or a leftover `{{…}}`.

`seedDefaults(deps, ctx, tx, { context, actor })` creates the two documents a new workspace cannot
sensibly start without — the privacy notice and a default disclaimer — and is idempotent. It
deliberately does **not** seed an NDA or the accreditation questionnaire, including under E2.3:
seeding a legal document nobody asked for teaches admins to skim legal documents, which is the
opposite of what any of this is for. Both stay opt-in from the shipped library. It is
called by `seedLegalDefaults()` in `apps/server/src/routes/setup.ts` when the owner account is
created, in its own transaction *outside* that route's owner-creation rollback: an un-seeded
workspace is the state every workspace created before this epic is in and a later run repairs it, while
rolling back would let a template bug delete a good workspace and its owner. Seeding is therefore
allowed to fail, loudly in the log and nowhere else.
