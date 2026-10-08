---
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/identity": minor
"@fundroom/db": minor
"@fundroom/contracts": minor
"@fundroom/sdk": minor
"@fundroom/module-notify": minor
---

Add access requests and the approval queue. Workspaces can turn on a public "Request access" form (name, email, firm, reason) that verifies the address with an emailed code and answers every stranger identically: no membership oracle, budgets that look like success, a honeypot and a queue cap. Verified requests land in a new admin Requests screen. Approving creates an ordinary invite with groups, grants and expiry; a membership that comes from a request is recorded with `source=request`, and under Rule 506(b) approval requires an attested pre-existing relationship. Denying sends a neutral notice. Outside 506(b), requests can be auto-approved by email domain. Staff with `access.manage` are alerted through notify. Unverified challenges, expired requests and retired rows are swept on a schedule, and erasure, DSAR export and workspace portability cover the new data. Migrations: core `0016_access_requests`, notify `0006_access_request_event_types`.
