# Contributing to FundRoom

Thanks for helping build a portal that founders and investors can trust. This page covers the setup, the rules the tooling enforces and what a pull request needs.

## Prerequisites

- Node 24 (see `.nvmrc`; `mise install` sets it up) and pnpm 10 (activated automatically from `package.json#packageManager` via Corepack).
- Docker, for integration tests (Testcontainers) and the local Compose stack.
- Optional: `gitleaks` on your PATH so the pre-commit hook can scan for secrets locally.

```sh
pnpm install          # also installs git hooks via lefthook
pnpm lint             # Biome (format + lint)
pnpm typecheck        # tsc -b across project references
pnpm test             # Vitest unit project + jsdom projects (packages/ui, apps/web)
pnpm test:integration # Vitest integration project (needs Docker)
pnpm build            # Turborepo build
```

## Repository layout

`apps/` (server, web), `packages/` (kernel libraries and adapters), `modules/` (feature modules), `plugins/wordpress/` (PHP, built separately), `deploy/` (container image, Compose, Helm and PaaS templates), `docs/` (operator and integrator documentation), `e2e/` (Playwright end-to-end tests), `load/` (k6 load tests).

Rules the tooling enforces:

- ESM only, `NodeNext` resolution, explicit `.js` extensions on relative imports.
- `application/` imports only `ports/`. Modules never import another module's tables; they talk through domain events.
- No raw SQL outside repositories; no non-`LOCAL` `SET` in queries; every `workspace_id` table gets `tenant_fence` RLS.

## Making a change

1. Branch from `main`. Keep PRs small enough to review in one sitting.
2. Write the test first when the change is behaviour; the unit project must stay fast and I/O-free.
3. Run `pnpm lint && pnpm typecheck && pnpm test` before pushing. The pre-commit hook formats staged files and scans for secrets; the pre-push hook typechecks.
4. Add a changeset (`pnpm changeset`) for anything user-visible. Dependency bumps and CI-only changes use the `no-changeset` label.
5. Definition of done: OpenAPI updated, authz matrix entry (`packages/authz/matrix/authz-matrix.yaml`, rendered to `docs/authz-matrix.md`), audit events defined, migration Squawk-clean with RLS, tests, an accessibility check for UI, and docs or a runbook touched when the change is operator-facing.

### Commit messages

Conventional commits, enforced by commitlint: `feat(config): support SECRET_KEY_RING rotation`. Scopes are listed in `commitlint.config.mjs`. Versions come from changesets, not from commit prefixes.

### Developer Certificate of Origin

Every commit must be signed off (`git commit -s`), which adds a `Signed-off-by:` trailer certifying the DCO in the `DCO` file. Bots check this on every PR; an unsigned commit blocks merge until it is amended.

### Larger changes

For a change to the architecture, the data model, the security model or a public contract (API, embed loader, webhooks, configuration), open an issue to discuss the design before sending a pull request.

## Security-sensitive areas

Changes under the paths listed in `.github/CODEOWNERS` (auth, authz, sessions, crypto, audit, deploy) need two approving reviews. If you think you have found a vulnerability, do not open an issue: see `SECURITY.md`.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence in `LICENSE`. The WordPress plugin under `plugins/wordpress/` is GPLv2+.
