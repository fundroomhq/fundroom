---
"@fundroom/server": minor
"@fundroom/config": minor
"@fundroom/contracts": minor
"@fundroom/sdk": minor
"@fundroom/web": minor
---

Platform packaging.
- **Helm chart** `deploy/helm/fundroom`:
  - server and worker Deployments, and a migrate Job that runs before install and upgrade;
  - optional CloudNativePG, Ingress with cert-manager, worker HPA, PDB and NetworkPolicy;
  - a restricted pod security context and a strict `values.schema.json`;
  - released by a `chart-v*` tag to GHCR as an OCI chart signed with cosign.
- **Render, Railway, Fly and Coolify templates** are rendered from one source (`deploy/platforms/source.mjs`, `pnpm gen:deploy`). CI checks that they are current, and a config test rejects any env name that is not a real config key.
- **Compose:**
  - `compose.backup.yaml` adds pgBackRest: WAL archiving, a weekly full and daily differential scheduler, an optional S3 repository and encryption, and a restore-drill profile.
  - The `worker` profile boots again.
  - The Tier-0 dump image matches Postgres 18.
- **SOPS + age** guide for committed env files.
- **Runbooks** for install and upgrade, backup and restore, key rotation, ACME failures, queue backlog, AV failure, tenant export and deletion, and incident response.
- **Update check:** `GET /api/v1/ops/update`, a card on the admin Health page, and a line in `fundroom doctor`.
  - It reads a static release index at `UPDATE_CHECK_URL` and sends no identifiers.
  - Opt out with `UPDATE_CHECK=false`.
  - Single-tenant installs only.
- **CLI:**
  - Every operator command now finds the master key that `serve` generated into `DATA_DIR`.
  - New `serve --roles <csv>` for platforms whose environment is app-wide.
