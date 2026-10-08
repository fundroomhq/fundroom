---
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroomhq/ui": minor
"@fundroom/audit": minor
"@fundroom/compliance": minor
"@fundroom/identity": minor
"@fundroom/db": minor
"@fundroom/contracts": minor
"@fundroom/ports": minor
"@fundroom/module-kit": minor
"@fundroom/authz": minor
"@fundroom/csv": minor
"@fundroom/sdk": minor
"@fundroom/queue-pgboss": minor
"@fundroom/module-analytics": minor
"@fundroom/module-crm": minor
"@fundroom/module-notify": minor
"@fundroom/module-updates": minor
"@fundroom/module-round": minor
"@fundroom/module-data-room": minor
"@fundroom/module-metrics": minor
"@fundroom/module-content": minor
---

Add the admin surfaces.

- **Audit log.** Filterable, paginated log with chain verification. The signed export is an Ed25519-signed zip holding JSONL, CSV and checkpoints, and `fundroom audit verify-export` checks it offline. That command exits 3 when the bundle's origin is not pinned to a trusted key.
- **Access review.** A report covering activity, gates and accreditation-window divergence. The reviewer attests to the report they saw, and its canonical JSON is stored as evidence.
- **Sessions admin.** Admins can list and revoke a member's sessions in this workspace.
- **View as investor.** A read-only view of the portal with a banner, audited start and end, and read-only database transactions.
- **Danger zones.** Transfer ownership, revoke all sessions and delete workspace, each needing typed confirmation and step-up. Delete is a soft delete with a 30-day restore window (`fundroom workspace restore`) and a nightly crypto-shred purge.
- **Data subject requests.** Access and rectification requests alongside erasure. A subject export bundle collects data through a per-module `dsar.export` hook. Identity erasure runs as the last step.
- **Settings and operations.** Module settings pages through a new `admin.settings` slot. A jobs/dead-letter page (`fundroom jobs dlq`) and `/api/v1/ops/health` with custom-domain certificate expiry.
- **Pool-deadlock fixes.** Removed three pool deadlocks: `legal.isErased`/`allowsPurpose` from an investor context, and two in the updates module (replies and the archive read).
