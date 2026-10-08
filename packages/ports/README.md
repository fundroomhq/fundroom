# @fundroom/ports

Interfaces only. Application code and modules import ports; adapters in
`packages/adapters/*` and kernel packages implement them; `apps/server/src/container.ts` wires
the chosen implementation from env. No runtime code lives here.

| Port | Default implementation |
|---|---|
| `AuthPort` | `@fundroom/identity` (`createAuthService`) |
| `RateLimiterPort` | `@fundroom/identity` Postgres sliding window |
| `JobQueuePort` (+ `JobDefinition`) | `@fundroom/queue-pgboss` |
| `AuditSinkPort` | none by default (Postgres `audit.event` is the record; sinks fan out via the outbox) |
| `MailerPort` (+ `MailDeliveryEvent`) | `@fundroom/email-smtp` (nodemailer); `@fundroom/mail` renders React Email templates |
| `OutboundHttpPort` | `@fundroom/outbound-http` (SSRF guard) |
| `ObjectStoragePort` | `@fundroom/storage-s3` / `@fundroom/storage-fs` |
| `KmsPort` | `@fundroom/kms-local` |
| `DocumentRenderPort` (+ `ForensicMarkSpec`, `GrayImageData`, `WatermarkSpec.traceId`) | `@fundroom/render-pdfium` (incl. `embedForensicMark` / `toGray`) |
| `AuditAnchorPort` (+ `AnchorReceipt`, `AnchorVerification` with `timeTrusted`: RFC 3161 time vs. Rekor presence) | none by default (`AUDIT_ANCHOR_DRIVERS` empty); `@fundroom/anchor-rfc3161`, `@fundroom/anchor-rekor` |
| `RelationshipEnginePort` (+ `RelationshipSnapshot`, `RelationshipResource` with unsynced `ancestors`, `RelationshipBatchResult`) | none by default (`AUTHZ_ENGINE=postgres`); `@fundroom/authz-openfga` |

Ports for search, documents, domains, e-sign and accreditation live with the packages that
first need them. Runtime exports are limited to what a port contract itself needs: `JOB_NAME_RE`
(job names are `<module>.<verb>` so the admin jobs page can group them), `OBJECT_KEY_RE` +
`assertObjectKey`, and the typed error classes (`StorageError`, `KmsError`,
`OutboundHttpError`, `AnchorError`, `RelationshipEngineError`) so callers can branch on `code` without importing an adapter.
