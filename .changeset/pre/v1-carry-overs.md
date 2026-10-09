---
"@fundroom/authz": minor
"@fundroom/identity": minor
"@fundroom/db": minor
"@fundroom/contracts": minor
"@fundroom/sdk": minor
"@fundroom/config": minor
"@fundroom/http": minor
"@fundroom/compliance": minor
"@fundroom/portability": minor
"@fundroom/domain": minor
"@fundroom/audit": minor
"@fundroom/module-kit": minor
"@fundroomhq/ui": minor
"@fundroom/mail": minor
"@fundroom/module-notify": minor
"@fundroom/module-round": minor
"@fundroom/module-data-room": minor
"@fundroom/module-metrics": minor
"@fundroom/module-content": minor
"@fundroom/module-updates": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Close the v1.0 carry-overs. Investors can add delegates (scope: everything, data room only, or updates only) from portal settings, and admins can add or remove them from a person's page. A delegate borrows a scoped subset of its investor's access, is bound by both its investor's exclusions and its own, signs its own gates, and loses everything as soon as its investor's access ends. Sign-in now refuses a person whose every membership has expired (`membership_expired`, after the credential is proven). The last-owner floor counts only active, unexpired owners and every owner-removing path locks first. Invite grants and imported rule paths are re-derived from the resource, so a folder move or an old over-broad path can no longer widen access. A daily job reminds `access.manage` holders about overdue access reviews. Trusted Types is enforced by default (`CSP_TRUSTED_TYPES`), the HIBP check's failure mode is configurable and audited (`AUTH_HIBP_FAIL_MODE`), web source maps are no longer served, module raw routes run the kernel guards, and a behavioural authz sweep checks every route against the matrix. Fixes the post-sign-in "no access" screen caused by a stale bootstrap cache. Migrations: core `0017_delegates`; notify `0007`, `0008`; round `0003`; metrics `0004`; content `0003`; updates `0003`.
