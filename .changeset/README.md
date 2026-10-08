# Changesets

Every user-visible change ships with a changeset: `pnpm changeset`, pick the packages, pick the bump, write one or two lines for the changelog.

Versioning groups (see `config.json`):

- **Fixed** — the core: server, web, config, db, and every `@fundroom/*` package not listed below move together, so the image tag `1.4.2` means the same thing everywhere. That includes the two npm packages, `@fundroomhq/tokens` and `@fundroomhq/ui`: `@fundroomhq/ui@1.4.2` is the design system of release `1.4.2`.
- **Independent** — `@fundroom/embed` (the loader has its own compatibility promise) and the WordPress plugin (versioned by its own `readme.txt`; not managed by Changesets).

Every changeset must bump at least one package of the fixed group (`"@fundroom/server": patch` is enough). One that names only packages outside it (a module, `@fundroom/embed`, …) bumps nothing in `apps/server`, so nothing would release; CI refuses it (`node scripts/release/check-changesets.mjs`). An empty changeset is allowed and means "no release".

Release flow: merge to `main` → the release workflow opens a "version packages" PR → merging it tags `v<version>` (from `apps/server/package.json`) on the merge commit, drafts the GitHub release, builds, scans, signs and tags the image, then publishes the release, and then publishes `@fundroomhq/tokens` and `@fundroomhq/ui` to npm at the release version (the only public packages; both are in the fixed group). Details: `docs/runbooks/releasing.md`.

Maintenance note: Changesets refuses a `fixed` entry that matches no package, so `config.json` lists only packages that exist. When you add a core package (`@fundroom/server`, `@fundroom/web`, `@fundroom/db`, …) add it to the fixed group in the same PR. Do **not** add `@fundroom/embed`.
