---
"@fundroom/update-check": patch
"@fundroom/server": patch
---

The update check's release index is now published with every release, at `https://releases.fundroom.io/index.json`, and it can describe the time before the first stable release. `latest` is optional in index v1: an index listing only release candidates has none, a release-candidate or development build then reports `unknown` (with no latest version), a stable build reports `current`, and security releases are still taken from the listed releases. Every index accepted before still parses the same.

If you run `1.0.0-rc.0`: upgrade, or set `UPDATE_CHECK=false`. That build's default `UPDATE_CHECK_URL` is on the `.com` domain of the same name, which FundRoom does not own: it reports `error` today, and whoever controls that domain could serve an index whose release links the admin Health page would show. Pointing it at `https://releases.fundroom.io/index.json` does not help before 1.0.0 either: its parser requires a stable `latest`, so it reports `error` until a stable release is listed.

For maintainers: the `Release` workflow's new `release-index` job (and the `Release index` workflow, which also runs by hand) rebuilds the index from the published GitHub releases: a job with no secrets builds a bundled publisher and the release list, and a job in the GitHub Environment `releases` that installs nothing uploads it to R2 (docs/runbooks/releasing.md, "Release index"). A release is flagged as a security release when a changeset's summary starts with the bold `Security:` marker (read from apps/server's CHANGELOG at the release tag; CI requires such a changeset to bump `@fundroom/server`), or later by a manual run with `security`.
