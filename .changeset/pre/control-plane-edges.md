---
"@fundroom/server": patch
"@fundroom/control-plane": patch
---

Control-plane edges: signup answers 404 on every route, reads included, while the default plan is unset, missing or archived (`signupDefaultPlanLive`); the operator enrolment routes and the signup routes check that they exist before validating the request, so a malformed body from outside gets the same 404 as a well-formed one; `GET /api/v1/setup/status` answers on a held or suspended workspace (423 `workspace_unavailable` to its staff, `{ required: false }` to everybody else) instead of a plain 404; the container image no longer prints Node's `ExperimentalWarning` on every start.
