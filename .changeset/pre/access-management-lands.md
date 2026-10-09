---
"@fundroom/authz": minor
"@fundroom/ports": minor
"@fundroom/db": minor
"@fundroom/domain": minor
"@fundroom/identity": minor
"@fundroom/audit": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/events": patch
---

Access management. New `@fundroom/authz`: the staff RBAC matrix as data (`matrix/authz-matrix.yaml`, rendered to `docs/authz-matrix.md`), the grants + policy-gates evaluator (nearest rule wins, then subject specificity, exclude wins ties), the `core.effective_access` rebuild (outbox subscriber, lazy on stale reads, hourly reconcile) and the `AuthzPort` implementation (`permissionsFor`, `check`, `listAccessible`, `whoHasAccess`, `explain`). `@fundroom/ports` gains `AuthzPort` and its types. `@fundroom/db` migration `0004_access`: `ltree`, `core.access_grant`, `core.access_policy`, `core.effective_access(+_state)`, `core.invite_import`, `core.has_access()` for module RLS, `invite.profile`; `bumpAclVersionInTx`, `readAclVersion`, `updateWorkspaceSettings`; `ResolvedWorkspace` carries `settings` and `aclVersion`. `@fundroom/domain`: `WorkspaceSettingsSchema` (`access.requireMfaForStaff/ForExternal/inviteExpiryDays/allowDelegates`), `InviteGrantSchema`, events `acl.changed` (now with `cause`), `membership.role_changed`, `invite_import.finished`. `@fundroom/identity`: `MembershipService` (people list/detail, role changes with owner rules, group sets, the full §13.2 revocation: delegates, group rows, grants, invites, sessions, audit, outbox, `acl_version`), `GroupService`, invitations with groups/grants/profile applied on acceptance, resend, CSV dry-run + `identity.invite_import` job; new audit actions. `@fundroom/contracts` `access.*` schemas; `@fundroom/module-kit` `required` modules, `resourceKinds`, `buildBootstrap` takes `permissions`. `@fundroom/server`: `/api/v1/access/*` (people, invites, CSV, groups, grants, policies, who/explain, settings, my), `requirePermission` / `requireMember` with the per-workspace MFA rule, `x-requires` on every operation and the generated matrix test, cross-tenant replay fuzz, the `access` manifest in `COMPILED_IN_MODULES`. `@fundroom/web`: People, person detail, Groups, group detail screens, invite and CSV import dialogs, the share sheet component.
