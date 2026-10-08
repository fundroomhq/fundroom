# SOC 2 evidence map

What an operator of FundRoom can show a SOC 2 auditor, control by control, and the command or artefact that produces each piece of evidence. It covers the Trust Services Criteria (2017, revised points of focus 2022) **Common Criteria** that the software itself can evidence: logical access (CC6), system operations and monitoring (CC7) and change management (CC8). The organisational criteria — governance, HR, vendor management, risk assessment (CC1–CC5, CC9) — are the operator's, not the software's, and are out of scope here.

Two audiences, one list:

- **The FundRoom project** evidences change management of the code (CC8.1) from GitHub: `scripts/evidence/change-management.mjs`.
- **An organisation running FundRoom** evidences access and monitoring of its installation from the running instance: `fundroom evidence …`, `fundroom audit …`, the admin screens. Commands below run the image's CLI; in Compose, `docker compose run --rm app <command>` (see `docs/runbooks/break-glass.md` "Commands" for Kubernetes).

Collect evidence **for the whole audit period**, not the day before fieldwork: the access-review, break-glass and change-management commands all take `--since`, and the bundles are designed to be archived monthly (see "Collection schedule").

## Controls and evidence

### CC6.1 — Logical access: restricting access to information assets

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Tenant data is isolated | Row-level security on every tenant table (a `RESTRICTIVE` fence policy), enforced even for a superuser connection because every transaction switches to the non-owner `seedhost_app` role | `pnpm --filter @seed-host/db test:rls` (catalog check) against the production database; CI runs the behavioural RLS suite on every change (`packages/db/src/rls/rls.integration.test.ts`) |
| Who can do what inside a workspace | The authorization matrix, generated from `packages/authz/matrix/authz-matrix.yaml` | `docs/authz-matrix.md` (drift-checked in CI) |
| Access decisions are checked independently (optional) | With `AUTHZ_ENGINE=openfga`, an OpenFGA engine evaluates a projection of the data-room access rules; in `shadow` mode disagreements with Postgres are counted, in `enforce` mode external access needs both to allow (fails closed) | `fundroom doctor` (`authzEngine` row); the `fundroom_authz_shadow_mismatch_total` and `fundroom_authz_engine_errors_total` metrics over the period; `docs/runbooks/openfga.md` |
| Data is encrypted at rest with managed keys | Envelope encryption per workspace, key ring in the environment | `fundroom doctor` (key ring fingerprints), `docs/runbooks/rotate-keys.md` |
| Privileged (operator) access to tenant data is restricted and recorded | Break-glass: `seedhost_host` (NOLOGIN, BYPASSRLS) usable only through `fundroom break-glass`, ticketed, ≤ 1 h, read-only by default, audited in the tenant's chain and the platform chain, owners emailed | `fundroom evidence break-glass --since <period start>`; `docs/runbooks/break-glass.md` "Reviewing break-glass use" |
| Database roles with elevated rights are known | Roles with superuser / BYPASSRLS / LOGIN / CREATEROLE, and who may become `seedhost_app` / `seedhost_host` | `fundroom evidence operators` |

### CC6.2 — Registering and authorising new users; CC6.3 — Modifying and removing access

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Access is granted by invitation from an authorised person | `invite.created`, `membership.created`, `membership.role_changed`, `membership.revoked`, `grant.*`, `group.*` audit events (actor, subject, time) | Admin → Audit (filter by action), or the signed audit export (`POST /api/v1/audit/exports`; verify offline with `fundroom audit verify-export <zip>`) |
| Access is reviewed periodically (every 90 days) | `core.access_review`: one append-only row per completed review with the reviewer, the counts, and the sha256 of the canonical report (the report is stored alongside) | `fundroom evidence access-reviews --since <period start>` — per workspace: last review, reviewer, digest, next due date, `overdue`. Admin → Access review → history |
| Leavers lose access | Revocation events above; `auth.sessions_revoked_workspace` when a member's sessions in the workspace are revoked; stale / never-active / expiring flags on the access-review report | The access review report (CSV/JSON export from the review screen) |
| Administrators use strong authentication | A workspace can require a second factor (TOTP or passkey) for staff and for externals (access settings `requireMfaForStaff` / `requireMfaForExternal`); sensitive admin operations need a fresh step-up | Admin → Access settings (`access.settings_changed` events); `auth.mfa_enrolled`, `auth.step_up` audit events |

### CC6.6 — Logical access from outside the system boundary; CC6.7 — Transmission

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Traffic is encrypted in transit | TLS at the bundled Caddy edge (ACME, HSTS) | `deploy/caddy/Caddyfile`; `docs/runbooks/acme-failures.md` |
| The web surface is hardened | Security headers and CSP on every response, rate limits on authentication, CSRF origin checks | `packages/http/src/security-headers.ts`; the ZAP baseline scan; `/.well-known/security.txt` |
| Vulnerabilities can be reported | `SECURITY.md`, `security.txt` (RFC 9116) | `curl https://<host>/.well-known/security.txt` |

### CC7.1 — Detecting configuration changes and vulnerabilities

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Dependencies and images are scanned | Per-PR, per-push and weekly `Security` workflow: pnpm audit, OSV-Scanner, CodeQL, Opengrep, gitleaks, Trivy (filesystem), hadolint, zizmor, actionlint; Trivy on every built image (`image.yml`); Dependabot weekly | GitHub → Actions → Security (run history); GitHub → Security → Code scanning alerts |
| What is deployed is what was built | Every release image is signed (cosign, keyless OIDC), carries an SPDX SBOM attestation and SLSA build provenance (`.github/workflows/image.yml`) | `cosign verify ghcr.io/fundroomhq/fundroom@<digest> --certificate-identity-regexp 'https://github.com/fundroomhq/fundroom/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`; `gh attestation verify oci://ghcr.io/fundroomhq/fundroom@<digest> --owner fundroomhq` |
| Configuration is validated | `fundroom doctor` prints the resolved (redacted) configuration and refuses invalid combinations (e.g. `RATE_LIMIT_MULTIPLIER ≠ 1` in production) | `fundroom doctor` output, archived per release |

### CC7.2 — Monitoring for anomalies; CC7.3 — Evaluating security events

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Security-relevant events are logged and cannot be silently altered | Per-workspace append-only audit chain (each row hashes the previous), a platform chain for operator events, daily HMAC-signed checkpoints keyed from the environment | `fundroom audit verify` (every chain, exit 0 = intact), `fundroom audit checkpoint` |
| The log cannot be rewritten even by whoever holds the database and the key ring | Optional external anchoring: the daily checkpoints of every chain are batched into a Merkle tree whose 32-byte root is time-stamped by an RFC 3161 TSA (trusted time) and optionally logged in Sigstore Rekor (public presence, no time); receipts verify offline against pinned certificates, keys and log origins | `fundroom doctor` (`auditAnchoring` row: anchors, origins, pinned fingerprints); `fundroom audit verify` (per workspace: verified with trusted time / late / present in log without trusted time / unverified origin / failed / missing); per checkpoint, the proof file from Admin → Audit log → External anchors verified by the auditor with `fundroom audit verify-anchor <proof.json> --anchor-cert <pins obtained independently> [--rekor-origin <origin>]` (exit 0 only for an on-time trusted time-stamp); for a period, the signed audit export with `fundroom audit verify-export <zip> --anchor-cert … --require-anchors` ("anchored through seq N at T"); `audit.anchored` rows on the platform chain; `docs/runbooks/audit-anchoring.md` |
| Operator access is monitored | Break-glass events in the tenant chain and the platform chain; the `seedhost_host` membership list | `fundroom evidence break-glass`, `fundroom evidence operators` |
| Browser-side attacks are visible | CSP violation reports (`docs/runbooks/csp-reports.md`) | CSP report logs |

### CC7.4 — Responding to incidents; CC7.5 — Recovery

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| There is an incident response procedure | `docs/runbooks/incident-response.md` (detect → triage → contain → assess via audit export → notify tenants → post-mortem) | The runbook, plus post-mortems of real incidents |
| Tenants are notified of access to their data | Break-glass owner notifications (transactional email) and the tenant-visible audit rows | `host.break_glass*` rows in the tenant's audit export |
| Leaks of confidential documents can be investigated | Optional per-document forensic watermarks; leak tracing restricted to owner, admin and legal with a fresh sign-in, rate limited and audited | `data_room.forensic_detection` rows in the workspace's audit export; `docs/runbooks/forensic-watermarking.md` |
| Backups are taken and restores are tested | pgBackRest / `pg_dump` tiers and the restore drill | `docs/runbooks/backup-and-restore.md` (drill log) |

### CC8.1 — Change management

| What the auditor asks | Evidence | How to produce it |
|---|---|---|
| Changes are authorised and reviewed | Branch protection on `main`: pull request required, **CODEOWNERS** review, two approvals on security-sensitive paths (`.github/CODEOWNERS` routes them to `@fundroomhq/security`) | `scripts/evidence/change-management.mjs` (below): approvers per PR, exceptions listed first |
| Changes are tested before release | The required `CI OK` check aggregates lint, typecheck, unit, integration (real Postgres), contract, migrations, e2e, accessibility and Helm jobs (`.github/workflows/ci.yml`) | The same bundle: `CI OK` conclusion on each merged head |
| Changes are documented | Changesets (`.changeset/*.md`) generate the changelog and version bumps; conventional commits (commitlint); DCO sign-off on every commit (`CONTRIBUTING.md`) | The bundle's `changesets` column; the release notes |
| Releases are traceable to source | Signed images with SBOM and SLSA provenance (CC7.1 row above) | `cosign verify`, `gh attestation verify` |
| Database changes are controlled | Hand-written, forward-only migrations reviewed under CODEOWNERS, Squawk-linted and tested up-from-empty and up-from-previous in CI; the runner refuses a changed checksum | `ci.yml` "Migrations" job; `fundroom migrate --dry-run` |

## The change-management bundle

```
node scripts/evidence/change-management.mjs --since 2026-07-01 --until 2026-09-30 --out evidence/
```

Needs Node 24 and an authenticated GitHub CLI (`gh auth login`, or `GH_TOKEN` in CI) with read access to pull requests, checks and contents. It writes `evidence/change-management-<since>_<until>.json` (every merged PR: author, merger, approvers by latest review state, security-sensitive per CODEOWNERS, `CI OK` conclusion on the head commit, changeset files) and a `.md` summary whose first table lists the exceptions:

- `no_approval` — merged without an approving review from someone other than the author;
- `security_needs_two_approvals` — touched a `@fundroomhq/security` path with fewer than two approvals;
- `ci_not_green` — the `CI OK` check is missing or not `success` on the merged head;
- `no_changeset` (informational only) — touched `packages/`, `apps/`, `modules/` or `plugins/` without a changeset; dependency bumps and internal changes legitimately have none.

Every exception needs a written explanation in the evidence folder (an emergency fix, an admin override and why). `--fail-on-exceptions` makes the script exit 3 so a scheduled run can open an issue.

## Collection schedule

| When | Who | What |
|---|---|---|
| Monthly | Security owner | `fundroom evidence break-glass --since <first of last month>`, `fundroom evidence operators`, `fundroom audit verify` (with anchoring on: no `failed`, no `missing`, nothing `late` after the first month); the change-management bundle for the month (the scheduled `evidence` workflow can do this) |
| Quarterly | Each workspace owner (product), checked by the security owner | Complete the access review in the admin screen; `fundroom evidence access-reviews --since <quarter start>` must show no `overdue` workspace |
| Per release | Release manager | Image digest, `cosign verify` and `gh attestation verify` output, `fundroom doctor` of the upgraded instance |
| Per incident | Incident lead | Timeline, audit export of the affected workspace(s), break-glass session ids and tickets, tenant notifications, post-mortem |

Store the JSON as produced; do not edit it. Each bundle states its generation time and period, and the break-glass and access-review evidence can be re-derived from the database and the verified audit chains at any time.

## Known gaps

- The access-review reminder is not automated: the "next due" date is shown in the admin screen and in `fundroom evidence access-reviews`, but no job emails owners when a review is overdue.
- External anchoring of audit checkpoints is optional and off by default (`AUDIT_ANCHOR_DRIVERS`). Without it, an operator who holds both the database and the key ring could re-chain and re-sign history: turn it on (`docs/runbooks/audit-anchoring.md`), or keep the key ring and database credentials with different people. With it, the events after the last anchored checkpoint (up to a day) are protected by the signed checkpoints only.
- `seedhost_host` cannot be created on managed Postgres services that do not grant `BYPASSRLS` to any administrator; break-glass is then unavailable, and operator access through the provider's console must be ticketed and recorded by hand (`docs/runbooks/break-glass.md` "Managed Postgres").
