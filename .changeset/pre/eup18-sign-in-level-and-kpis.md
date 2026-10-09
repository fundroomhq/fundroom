---
"@fundroom/identity": patch
"@fundroom/contracts": patch
"@fundroom/sdk": patch
"@fundroom/server": patch
"@fundroom/web": patch
"@fundroom/module-metrics": patch
---

Central authentication carries a minimum level. `GET /auth/central/start` accepts `level=2`, and a re-authentication keeps the workspace session's current level as the minimum. `authorize` answers a step-up with `reason=level` when the canonical session is below the minimum, after the membership and SSO decisions and before the freshness check. `finish` still never raises a level. Passkey registration that the authenticator reports as user-verified raises the session to level 2, as TOTP enrolment does: the cookie is reissued and `auth.step_up` is audited with method `passkey_registration`. The response adds `authLevel` (`PasskeyRegistered`), and the SPA skips its second passkey ceremony when it is 2. The canonical step-up screen enrols a first factor in place instead of dead-ending, and tells the user when a key cannot confirm them. The investor KPIs page moves from `/metrics` to `/kpis`, so a reload or bookmark on a workspace host no longer reaches the ops Prometheus endpoint, which keeps `/metrics` on every host. In-app `/metrics` links redirect to `/kpis`. A guard test keeps module nav targets out of the ops tree.
