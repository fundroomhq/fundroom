# @fundroom/sanctions

Kernel sanctions screening of tenant companies. Screening providers are
`SanctionsScreeningPort` adapters: [`@fundroom/sanctions-ofac`](../adapters/sanctions-ofac/README.md)
(local matching against the US lists) and
[`@fundroom/sanctions-opensanctions`](../adapters/sanctions-opensanctions/README.md). The operator API is
`apps/server/src/routes/platform-sanctions.ts`; the runbook is
[`docs/runbooks/sanctions.md`](../../docs/runbooks/sanctions.md).

- `service.ts` — `onWorkspaceCreated` holds a new workspace for review and enqueues its first screen in the
  same transaction (so it is never active unscreened). `screenWorkspace` calls the port **outside** any
  transaction and records `core.sanctions_screening` in a short host transaction. A clear screen releases the
  hold. An unscreenable name (for `ofac`: any word left in another script) is an `error` row that is not retried
  until the name or matcher changes. A potential match or an error keeps a *new* workspace held, and never changes a live one: it queues it
  for an operator. Operator decisions (note required) are the only way a live workspace is suspended for sanctions:
  `confirmed` sets the `sanctions` hold; `cleared` releases a `sanctions_review` hold and never lifts a
  `sanctions` suspension (only an operator's explicit unsuspend of that hold does).
- `matcher.ts` — `normalizeName` (NFKD, Cyrillic/Greek transliteration, diacritics, punctuation, legal-form
  suffixes), `nameVariants` (mixed-script look-alikes read by appearance), `isScreenable`, `jaroWinkler`,
  `nameScore` (compact equality, token-set Jaro-Winkler, containment, with guards against short tokens and
  common business words). `MATCHER_VERSION = "jw4"` goes into every list version: bump it with any rule change
  that can move a score.
- `jobs.ts` — `sanctions.screen` (retries 8×, one queued per workspace), `sanctions.refresh` (`0 6 * * *`),
  `sanctions.rescreen` (fan-out per list version).

`core.sanctions_screening` is host-context only; tenants never see it, and its audit rows are on the platform
chain. Rows are kept 5 years with no foreign key to the workspace (a legal record about a company, outside
DSAR).
