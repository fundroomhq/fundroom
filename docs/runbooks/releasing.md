# Releasing

For maintainers. How a release is cut, what it produces, and what to do when part of it fails. The workflows are `.github/workflows/release.yml`, `.github/workflows/image.yml` and `.github/workflows/release-index.yml`; the logic they run is `scripts/release/release-version.mjs`, for npm `scripts/release/publish-packages.mjs` (tested by `node --test scripts/release/*.test.mjs`), and for the release index `scripts/release/release-index.mjs prepare` and the publisher bundled from `@fundroom/update-check` (`dist/release-index.mjs`; tested with the package, and rehearsed by its `release-index.integration.test.ts`).

## What a release produces

| Output | Stable `X.Y.Z` | Release candidate `X.Y.Z-rc.N` |
|---|---|---|
| Git tag | `vX.Y.Z` (annotated, on the commit the image is built from) | `vX.Y.Z-rc.N` |
| GitHub release | notes from `apps/server/CHANGELOG.md` (cut before GitHub's 125,000-character body limit, ending with a link to the full section; the first release's section is longer than that), SBOM attached; a draft until the image is signed and tagged | the same, marked prerelease |
| Image tags (`ghcr.io/fundroomhq/fundroom`) | `X.Y.Z`; `X.Y` if it is the highest patch of `X.Y`; `X` if it is the highest `X.*` (never `0`); `latest` if it is the highest stable release | `X.Y.Z-rc.N` only |
| OCI label `org.opencontainers.image.version` | `X.Y.Z` | `X.Y.Z-rc.N` |
| Release index (`https://releases.fundroom.io/index.json`) | listed; becomes `latest` if it is the highest stable release | listed; `latest` unchanged (absent until the first stable release) |
| npm (`@fundroomhq/tokens`, `@fundroomhq/ui`) | `X.Y.Z` under dist-tag `latest` if it is the highest stable release, else `release-X.Y` | `X.Y.Z-rc.N` under dist-tag `next` (`next-X.Y` if a higher version is already on npm) |

**`latest` on the first release candidate.** npm's own client sends only the tag it was given (`next`), but the registry gives a brand-new package a `latest` tag as well, and `latest` cannot be removed, only moved. npm's documentation does not state this (`npm dist-tag`: "Publishing a package sets the `latest` tag to the published version unless the `--tag` option is used"); it is the registry's long-standing behaviour, not verifiable without publishing, so check `npm view @fundroomhq/ui dist-tags` after the first publish. Expect `latest` to stay on `1.0.0-rc.0` until the first stable release moves it: `npm install @fundroomhq/ui` without a version installs the release candidate until then. That is acceptable (there is nothing older to protect); do not move `latest` by hand.

`latest` moves for `0.x` releases too. That is deliberate: no `latest` existed before the first release, and the templates name it.

One version names the release: `apps/server/package.json`. Every core package moves with it (Changesets' `fixed` group, `.changeset/config.json`). There is one git tag per release, not one per package. Two packages are public and published to npm at that version: `@fundroomhq/tokens` and `@fundroomhq/ui`; every other package is private, and `pnpm packages:pack-check` (CI) fails if that changes.

Every changeset must name at least one package of the fixed group. A changeset naming only, say, `@fundroom/embed` or a module would be consumed by the version PR without changing `apps/server`'s version, and nothing would release. CI refuses it (`node scripts/release/check-changesets.mjs`); add `"@fundroom/server": patch`. An empty changeset (nothing between the `---` lines) is allowed and means "no release".

`edge` is built by `image.yml` on every push to `main` that touches the code; its version label is `<package version>+git.<sha7>`. Edge runs queue per ref (a newer pending run replaces an older pending one), so `edge` never lands out of order; a release build has its own concurrency group. A manual run of `image.yml` tags `sha-<sha7>` and never a version.

## Cutting a release

1. Changesets land with feature PRs. On every push to `main`, the `Release` workflow's `version-pr` job keeps a "chore(release): version packages" PR up to date. That job is independent of the release jobs (a failure in one never blocks the other) and does not run on a re-run, so re-running an older commit's run can never reset the PR's branch backwards. The PR's commit is `pnpm version-packages`: `changeset version`, then `scripts/release/version-artifacts.mjs`, which regenerates every committed file that carries a version (the embed loader's `src/generated/{version,artifacts}.ts`, the OpenAPI document's `info.version`) so the version PR passes its own drift checks. A new version-bearing generated file belongs in that script.
2. Merge that PR. Its push changes `apps/server`'s version, which has no tag yet, so the workflow tags `v<version>` on the merge commit, pushes the tag and creates a **draft** GitHub release.
3. It then calls `image.yml`: build each architecture by digest, merge them into one index pushed **by digest with no tag**, SBOM, Trivy (fails on fixable CRITICAL/HIGH), cosign sign, SBOM attestation, SLSA provenance, and only then, as the last step, the tags. Nothing can pull the image by a name until it has been scanned and signed.
4. The `release-assets` job attaches the SBOM and publishes the draft release.
5. Then npm, in two jobs, so the npm credentials never meet an install or a build. `pack-packages` (only after the image job succeeded, so no package exists for a version whose image failed; no id-token, no secrets) checks out the release commit, reads both packages' versions from it and refuses unless they equal the release version, refuses if the checkout differs from the commit, packs both (the same tarball checks as `pnpm packages:pack-check`) and uploads the tarballs as the artifact `npm-packages-<version>`. `publish-packages` (`id-token: write`, `NPM_TOKEN` only for a first publish) installs nothing and builds nothing: it sets up Node, installs a pinned npm (11.20.0; trusted publishing needs ≥ 11.5.1 and the script refuses anything older, loudly), downloads the tarballs and runs `publish-packages.mjs publish`, which only calls `npm view` and `npm publish <tgz>`: it skips any `name@version` already on npm and publishes `@fundroomhq/tokens`, then `@fundroomhq/ui`, with provenance. Authentication is npm trusted publishing (OIDC, GitHub-hosted runner): no token.
6. In parallel with npm, also only after the image job succeeded: `release-index` (release-index.yml) rebuilds the release index from every published GitHub release and uploads it to R2 ([Release index](#release-index)).
7. Every later push with the same version finds the tag on another commit, or the release published, and releases nothing.

Release candidates: `pnpm changeset pre enter rc` on a branch, merge it, and the version PR then produces `X.Y.Z-rc.N` (the first is `rc.0`); `pnpm changeset pre exit` before the stable release.

## When something fails

The release is unfinished as long as its GitHub release is missing or a draft. Only a run of `Release` on the **tag's own commit** resumes it: it keeps the tag, creates the draft if it is missing, and builds the image again. A run on any later commit logs "nothing new to release" and does nothing.

- **The tag step failed after pushing the tag** (the release call failed): "Re-run all jobs". It resumes.
- **The image build, Trivy, signing or attestation failed** (before Apply tags, so no image is tagged under the version), and the fix needs no code change (a flaky step, a registry outage, a Trivy database that has since caught up): "Re-run all jobs" on that run. The tag and the draft stay; the resume rule rebuilds and finishes. Do not delete anything.
- **The same failure, but the fix needs a code change**: the fix ships as a new version. Delete the old version's draft release **and** its tag, `gh release delete vX.Y.Z --cleanup-tag --yes`, so a stray `vX.Y.Z` with no image never counts as released when later releases decide which moving tags (`X.Y`, `X`, `latest`) they take. After deleting a tag, **never** use "Re-run failed jobs" on that run: it would re-run only the image job with the old outputs. (The image job refuses anyway: it checks that `v<version>` is on origin, on the commit being built, before building.)
- **Apply tags failed with "refusing to move"**: `X.Y.Z` already names an earlier, signed digest (an earlier attempt got as far as tagging). A release tag never moves: downstream promotion pins `<version>@sha256:<digest>` and treats a moved tag as an alarm. Finish by hand on the digest `X.Y.Z` already names: `oras tag ghcr.io/fundroomhq/fundroom@<that digest> <the missing X.Y / X / latest>`, then publish the draft (`gh release upload vX.Y.Z sbom.spdx.json` from the earlier run's artifact, `gh release edit vX.Y.Z --draft=false`). Do not delete the tag in this case.
- **Only `release-assets` failed** (the tag still exists): "Re-run failed jobs".
- **`pack-packages` or `publish-packages` failed** (the image is tagged, the release published): fix the cause (an npm outage, a trusted-publisher setting, an expired first-publish token) and use **"Re-run failed jobs" only**. "Re-run all jobs" re-runs `tag`, which finds the GitHub release published, outputs `released=false`, and skips both npm jobs; later pushes skip them too, so the version would never be published. A package already published by the failed attempt is skipped (`npm view`), so the re-run publishes only what is missing. A failure that needs a code change ships as the next version; npm versions are immutable and an unpublished version number can never be reused, so do not `npm unpublish` to "retry".
- **`release-index` failed** (the release is published; the update check does not list it yet): fix the cause (the `releases` environment not configured, an R2 outage, a refused build, see below) and "Re-run failed jobs" (a failed `publish` re-runs on the artifact its `build` made). Or run the **Release index** workflow by hand on `main` (Actions → Release index → Run workflow): it rebuilds from every published release, so it also catches up any release whose index job never ran. Releases go on regardless; nothing else waits for the index.
- **The re-run window has passed** (GitHub re-runs a run for 30 days): publish by hand from the release commit's own tarballs. On a maintainer machine with Node 24 and npm ≥ 11.5.1, logged in to npm (`npm login`, with 2FA; a package set to "disallow tokens" still accepts an interactive 2FA publish), in a clean clone:

  ```sh
  git switch --detach vX.Y.Z
  pnpm install --frozen-lockfile
  node scripts/release/publish-packages.mjs pack --version X.Y.Z --out /tmp/npm-packages
  node scripts/release/publish-packages.mjs publish --version X.Y.Z --dir /tmp/npm-packages \
    --floating "latest" --no-provenance --dry-run   # check the plan, then again without --dry-run
  ```

  Pass `--floating "latest"` only if `X.Y.Z` is stable and the highest stable release (the image's rule; otherwise `--floating ""`, which tags `release-X.Y`); a prerelease always goes to `next` (or `next-X.Y`). `--no-provenance` is required outside Actions, where npm cannot attest provenance, so this version will lack the provenance badge; say so in the release notes.
- **The merge commit's run never ran** (a newer push superseded it while it was pending under the concurrency group): the next push tags the version on that later commit, the first `main` commit that still carries the version. The release then contains everything on `main` up to that commit; changesets merged in between are released again, properly, in the next version.
- **Never** delete and re-push a release tag, or re-tag `X.Y.Z`, after an image was pushed under it.
- **0.0.0**: nothing has been versioned yet, so nothing is tagged.

The version and the release notes are read from the commit (`git show <sha>:apps/server/package.json`), never from the checkout: in the same job changesets/action runs `changeset version`, which leaves the next version in the working tree while changesets are pending. The tag step also runs before it.

## Release index

`https://releases.fundroom.io/index.json` is what every install's update check reads ([install-and-upgrade.md](install-and-upgrade.md#the-update-notice); the format is `packages/update-check/src/release-index.ts`). It is an object in the public Cloudflare R2 bucket `fundroom-releases`, served on `releases.fundroom.io`, written only by `.github/workflows/release-index.yml`, never by hand.

```json
{
  "schemaVersion": 1,
  "latest": "1.0.1",
  "releases": [
    { "version": "1.0.1", "date": "2026-10-27", "url": "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.1", "security": true },
    { "version": "1.0.0", "date": "2026-10-20", "url": "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0", "security": false },
    { "version": "1.0.0-rc.1", "date": "2026-10-14", "url": "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0-rc.1", "security": false }
  ]
}
```

**How it is built.** In two jobs, so the R2 keys never meet an install (the same split as npm's pack and publish). `build` (no environment, no secrets) installs, builds `@fundroom/update-check`, whose build also bundles the publisher with its dependencies into one file (`dist/release-index.mjs`), lists the repository's GitHub releases (`gh api --paginate`) and attaches to each its section of apps/server/CHANGELOG.md at its tag (`release-index.mjs prepare`; full clone), and uploads both as an artifact. `publish` (environment `releases`) checks out nothing and installs nothing: it sets up Node, downloads the artifact and runs the bundle, which calls the runner's aws CLI. The bundle reads the current `index.json` from the bucket over the S3 API (not through the CDN, whose copy can be up to 5 minutes old), and writes the next one: every published release tagged `vX.Y.Z[-pre]` (drafts and `chart-v*` / `wp-v*` tags are skipped), newest first by SemVer; `date` is the GitHub publish date (UTC), `url` the GitHub release page, `latest` the highest stable release, **absent until 1.0.0 ships**. The result must pass the update check's own parser before anything is uploaded. The upload is `Content-Type: application/json`, `Cache-Control: public, max-age=300` (an unchanged index is not re-uploaded); then the job reads it back from the bucket and from `RELEASE_INDEX_URL` (a cache-busted GET must return the new bytes; the plain URL must return a valid index). Over 500 releases or 256 KiB, the oldest release candidates are dropped first; the build fails rather than drop a stable release. It refuses to drop a version GitHub no longer lists unless told to (`allow-removal`), so a short API answer can never shrink the index.

**Security releases.** The `security` flag makes every older install say SECURITY UPDATE, so it is set deterministically:

1. **At release time, by the changeset.** Start the changeset's summary with `**Security:**` (and name `"@fundroom/server"`; CI refuses a security changeset that does not, because only apps/server's CHANGELOG reaches the release notes). When a release first enters the index, it is flagged if its section of apps/server/CHANGELOG.md, read at its tag, has an entry whose summary starts with that marker (the marker anywhere else in an entry does not count, matching CI's check of the changeset). Not the GitHub release body: that is cut to fit GitHub's size limit, and the cut drops trailing entries, where a patch-level fix sits.
2. **After the fact, by dispatch.** Actions → Release index → Run workflow on `main` with `security` (versions to flag, e.g. `1.4.1, 1.3.7`) or `not-security` (versions to clear). Use it when a release turns out to have fixed a vulnerability, or to clear a wrong flag.
3. **Carried over.** Once a release is listed, its flag comes from the published index on every later run; its notes are not read again, so a later edit changes nothing.

Prereleases may be flagged; readers ignore them for stable installs. Publish the GitHub Security Advisory as well: the flag says "upgrade", the advisory says why.

**Dispatch inputs**, all optional: `security`, `not-security`, `allow-removal` (drop versions whose GitHub release was deleted on purpose), `ignore-current` (rebuild from GitHub alone: only if the published index is unreadable, which the job reports; flags set by dispatch are then lost, so pass them again in `security`, from the advisories), `first-publish` (the bucket is new and holds no index). A run that finds no `index.json` in the bucket fails unless `first-publish` is set, and `first-publish` fails if an index exists: an emptied or swapped bucket must never be refilled from GitHub alone without someone deciding to, since that drops every flag set by dispatch. Runs, by release or by hand, never overlap (one concurrency group); a run waiting behind another replaces an earlier waiting one, which then shows as cancelled: re-run a cancelled dispatch.

**Before 1.0.0.** With only release candidates the index has no `latest`: an rc install reports `unknown`, a stable build `current`. `1.0.0-rc.0` never reads this index: its default `UPDATE_CHECK_URL` is on the `.com` domain of the same name, which is not ours, so it reports `error`, and whoever holds that domain could serve it an index whose links its Health page would show. Tell rc.0 operators to upgrade or set `UPDATE_CHECK=false` ([install-and-upgrade.md](install-and-upgrade.md#the-update-notice)). Pointed at `releases.fundroom.io` by hand, rc.0 still reports `error`: its parser requires a stable `latest`. From `1.0.0-rc.1` installs read the index by default.

### First-time setup

Needed once, before the first release that publishes the index (`1.0.0-rc.1`). The bucket `fundroom-releases`, its public custom domain `releases.fundroom.io` and an R2 API token scoped to that bucket alone (Object Read & Write) are made by the hosted edition's tooling: fundroom-web runbook `releases.md`. Then, in this repository (Settings → Environments):

1. Create the environment **`releases`**. Deployment branches and tags: **selected branches, `main` only**. No reviewers (a release must not wait on a click).
2. Environment **secrets**: `R2_RELEASES_ACCESS_KEY_ID` and `R2_RELEASES_SECRET_ACCESS_KEY`, the token's S3 access key id and secret.
3. Environment **variables**: `R2_RELEASES_ENDPOINT` = `https://<account_id>.r2.cloudflarestorage.com`, `R2_RELEASES_BUCKET` = `fundroom-releases`, `RELEASE_INDEX_URL` = `https://releases.fundroom.io/index.json`.
4. Run **Release index** by hand on `main` once, with **`first-publish`** checked. It publishes the index for the releases already out (`1.0.0-rc.0`) and proves the setup; the job summary shows the file. Every later run, by release or by hand, runs without it.

Missing any of the five fails the job with ``The GitHub Environment `releases` is not configured: <names> unset``. (GitHub creates an empty `releases` environment the first time a job names it, so the error, not a missing environment, is what an unconfigured repository shows.) The R2 keys exist only in the `publish` job, which runs no install and no repository code: only Node, the bundle the `build` job made, and the aws CLI, which alone is given the keys. To rotate the token, replace both secrets and re-run Release index.

A dry run on a maintainer machine (a full clone with tags), uploading nothing: `pnpm --filter @fundroom/update-check build && gh api --paginate --slurp 'repos/fundroomhq/fundroom/releases?per_page=100' > /tmp/gh.json && node scripts/release/release-index.mjs prepare --releases /tmp/gh.json --out /tmp/releases.json && node packages/update-check/dist/release-index.mjs --releases /tmp/releases.json --dry-run --out /tmp/index.json` (with none of the five variables set it builds as if nothing were published, so dispatch-set flags are missing from the result).

## npm: first-time setup

Needed once, before the first release that publishes (A-7's `1.0.0-rc.0`). Nothing here is automated: it needs an npm account with 2FA.

1. **The scope.** The packages publish under `@fundroomhq`, the npm organisation `fundroomhq` the maintainer owns (free plan; public packages only). `@fundroom` belongs to someone else, so no package of ours may ever be published or depended on under it: the private workspace packages keep `@fundroom/*` names, are `workspace:` references inside the repository, and `pnpm packages:pack-check` refuses a published manifest that depends on any of them (amendment 2026-10-08).
2. **First publish.** A trusted publisher can only be configured on a package that already exists on the registry (`npm help trust`: "Package must exist"), so each package's first version goes up with a token:
   - Create a granular access token: packages and scopes → read and write on the `@fundroomhq` scope (it can create new packages there), shortest expiry, and allow it to bypass 2FA (a CI publish cannot answer a 2FA prompt).
   - Save it as the repository secret `NPM_TOKEN`. Only the `publish-packages` job sees it, as `NODE_AUTH_TOKEN`; `publish-packages.mjs` removes it from its own environment at start and hands it to `npm publish` alone, through a throwaway userconfig that references it. Provenance still comes from the job's OIDC token.
   - Merge the version PR. The release publishes both packages; check `npm view @fundroomhq/tokens@<version>` and `npm view @fundroomhq/ui@<version>`, and that npmjs.com shows the provenance badge for both.
   - (If the release has already gone out without the secret, `publish-packages` failed and nothing else did: add the secret and "Re-run failed jobs", never "Re-run all jobs".)
3. **Trusted publisher.** For each of `@fundroomhq/tokens` and `@fundroomhq/ui`, on npmjs.com → package → Settings → Trusted publishing, add GitHub Actions: owner `fundroomhq`, repository `fundroom`, workflow `release.yml`, no environment. Or from a shell with npm ≥ 11.15: `npm trust github @fundroomhq/tokens --repo fundroomhq/fundroom --file release.yml --allow-publish` (and the same for `@fundroomhq/ui`).
4. **Remove the token.** Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com. Then, per package, Settings → Publishing access → "Require two-factor authentication and disallow tokens", which npm recommends once a trusted publisher exists. From here on a publish is possible only from `release.yml` on this repository.

`repository.url` in both `package.json`s must stay exactly `git+https://github.com/fundroomhq/fundroom.git`: npm matches it against the workflow's repository for provenance and trusted publishing. `pnpm packages:pack-check` enforces it.

**Scope history.** The plan named `@fundroom`; it turned out to be taken, and on 2026-10-08 the two packages were renamed to `@fundroomhq/tokens` and `@fundroomhq/ui` (the `name`s, ui's dependency on the tokens package and its imports, the two names in `.changeset/config.json` and pending changesets, `PUBLISHED` in `scripts/release/pack-check.mjs`, and fundroom-web's `sync-tokens --package` spec). The other packages stay `@fundroom/*` (they are never published).

## Do not rename

The hosted edition verifies a release image by its signing certificate and provenance: workflow name `Release`, trigger `push`, SAN `…/.github/workflows/image.yml@refs/heads/main`, provenance workflow path `.github/workflows/release.yml`. Renaming `release.yml`, its `name: Release`, its trigger, or calling the image build any other way than `uses: ./.github/workflows/image.yml` breaks every promotion until the verifier changes with it.
