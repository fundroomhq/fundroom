# @fundroom/sanctions-ofac

`SanctionsScreeningPort` over the US OFAC Sanctions List Service. It downloads the SDN list
(`SDN.CSV` + `ALT.CSV`) and the consolidated non-SDN lists (`CONS_PRIM.CSV` + `CONS_ALT.CSV`) and matches
locally with [`@fundroom/sanctions`](../../sanctions/README.md)' matcher. Nothing about the screened company
leaves the host, so there is no sub-processor. Operations:
[`docs/runbooks/sanctions.md`](../../../docs/runbooks/sanctions.md).

Exports `createOfacScreening(deps, options?)`, `defaultOfacRedirectAllowed`, `OFAC_USER_AGENT`,
`OFAC_FILES`, `buildList`, `parseCsv` and `versionOf`.

- **The wire.** SLS answers 403 without a `User-Agent`, and 302-redirects every export to a pre-signed S3 URL
  (valid for an hour, never cached). Each download follows exactly one redirect, only to an https
  `*.amazonaws.com` host (`defaultOfacRedirectAllowed`, enforced by the outbound client's `redirectAllowed`
  before it follows). Each file is capped (64 MiB by default), and a body shorter than its
  `Content-Length` is refused.
- **Fail closed.** A failed, oversized, truncated (fewer than 1 000 SDN rows) or inconsistent download (an
  alias naming an unknown entry) keeps the previous snapshot. `screen()` refuses a snapshot older than 48 h,
  and `listVersion()` re-downloads once the snapshot is an hour old.
- **Cache.** `<cacheDir>/ofac/<hash>/` holds one snapshot, and `current.json` names the snapshot in force.
  Both are written under temporary names and renamed; older snapshots are deleted. A cache that no longer
  hashes to its version is ignored. An unwritable cache means memory only.
- **Version.** `ofac:<sha256-12>:<matcher version>`.
- **Scope.** Individuals and entities are screened. Vessels and aircraft are parsed (their aliases stay
  valid) but never matched.
