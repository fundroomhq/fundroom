# @fundroom/accreditation

## 0.1.0-rc.0

### Minor Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add accreditation vendor adapters: per-workspace VerifyInvestor.com and Parallel Markets connections, vendor-decided 506(c) verifications with stored certificates, and a verification lifecycle (polling, expiry, reminders, renewal).

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Plans can now say which optional modules and features a workspace may turn on. Nothing
  changes on an install with `CONTROL_PLANE=off` or for a workspace without a plan.
  
  - `PlanLimits` gains `modules` (optional module ids) and `features` (`qa`, `api_keys`, `webhooks`,
    `integrations`, `esign`, `accreditation`, `sso`, `scim`, `forensic`, `anchoring`, `ai`,
    `access_reviews`). Left out means all; `[]` means none. No migration: plans are written with
    `limits_schema_version` 2, and version 1 rows read as "all".
  - Turning on something the plan leaves out answers `402 plan_limit` with `limit: "module"` (and `module`)
    or `limit: "feature"` (and `feature`). The answer comes only after the route's own authentication and
    authorization, so it never reveals a plan to someone the route would not serve.
  - A downgrade freezes the configuration: what is on stays on, can be maintained (re-keying a connection,
    rotating secrets and tokens, removing webhook topics, re-verifying) and can be turned off, but nothing new
    can be added or turned on. A module that is on but outside the plan becomes read-only for staff: writes
    answer 402, DELETE and the withdraw routes keep working, restoring from the trash waits for an upgrade,
    investors are unaffected and jobs keep running. New AI requests and completing an access review stop.
  - Audit anchoring and verification are unchanged: every workspace is anchored and verified whatever its
    plan. On a plan without `anchoring`, downloading a proof (`GET /audit/anchors/{checkpointId}/proof`)
    answers 402, and `GET /audit/anchors` adds `planAllows`. After an upgrade every past proof is available.
  - Settings writers (branding, legal, access, embed, and the updates, content, metrics, round and analytics
    modules) now write only their own block of the workspace settings (`updateWorkspaceSettingsBlock` in
    `@fundroom/db`), so one can no longer put back a value another just changed.
  - Operators: `GET /platform/plans` returns `entitlementCatalog`. A module that is not an optional module
    of the build is `400 validation_failed` (`reason: "unknown_module"`). `fundroom plan upsert` takes
    `--modules` and `--features` (`ids`, `all` or `none`) and keeps any list a command does not mention,
    `--limits` included; `PATCH /platform/plans/{id}` still replaces the whole object. The plan editor in
    `/platform` has Modules and Features checklists.
  - Workspace UI: "Not on your plan" and "Read-only on your plan" on the modules page and in the setup wizard,
    a read-only banner on the module's admin pages, a notice on each feature's settings page, proof downloads
    disabled on the audit page, warnings on removals that can't be redone on the plan, and the plan's modules
    and features on the Billing page. `GET /modules/enablement` adds `planAllows` and `readOnly` (`lockedReason: "plan"`), the
    bootstrap adds `modules[].readOnly` and `entitlements` (staff only), and `GET /ai/status` adds
    `planAllows`.

### Patch Changes

- Updated dependencies [[`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b)]:
  - @fundroom/ports@1.0.0-rc.0
  - @fundroom/db@1.0.0-rc.0
  - @fundroom/domain@1.0.0-rc.0
  - @fundroom/audit@1.0.0-rc.0
  - @fundroom/module-kit@1.0.0-rc.0
  - @fundroom/events@1.0.0-rc.0
  - @fundroom/crypto@1.0.0-rc.0
