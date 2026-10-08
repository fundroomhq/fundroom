# Authorization matrix

Generated from `packages/authz/matrix/authz-matrix.yaml` by `pnpm --filter @fundroom/authz matrix:docs`; do not edit by hand. Staff roles hold permissions (RBAC); external members (investor, delegate) hold none and see only what grants and gates allow.

## Permissions by staff role

| Permission | owner | admin | editor | viewer | finance | legal | Description |
|---|---|---|---|---|---|---|---|
| `access.delete_workspace` | ✓ | – | – | – | – | – | Delete the workspace (soft delete, purged after 30 days unless restored by an operator). |
| `access.manage` | ✓ | ✓ | – | – | – | – | Invite and revoke external members, manage groups, grants and policies. |
| `access.manage_staff` | ✓ | ✓ | – | – | – | – | Invite, re-role and revoke staff. Admins may not touch owners (enforced in the handler). |
| `access.read` | ✓ | ✓ | – | – | – | ✓ | People, groups, invitations, "who has access" and explain. |
| `access.settings` | ✓ | ✓ | – | – | – | – | Workspace access settings (MFA requirements, invite expiry). |
| `access.transfer` | ✓ | – | – | – | – | – | Transfer ownership, revoke an owner. |
| `accreditation.manage` | ✓ | ✓ | – | – | – | – | Connect, re-verify and disconnect the accreditation vendor. |
| `accreditation.read` | ✓ | ✓ | – | – | – | ✓ | The accreditation vendor connection (never its credentials) and the vendors on offer. |
| `ai.manage` | ✓ | ✓ | – | – | – | – | Turn AI assist and its features on or off, set the token budget, acknowledge the model provider. |
| `ai.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AI assist availability, the workspace's AI settings and usage, and one's own AI suggestions. |
| `analytics.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Engagement overview, who viewed a document, page dwell, a contact's timeline and the tracking settings. |
| `analytics.settings` | ✓ | ✓ | – | – | – | – | Change the tracking mode and retention, and erase one member's engagement history (DSAR). |
| `api-keys.manage` | ✓ | ✓ | – | – | – | – | Create, rename, rotate and revoke API keys. |
| `api-keys.read` | ✓ | ✓ | – | – | – | – | The workspace's API keys (never their tokens), their scopes, expiry and last use. |
| `audit.export` | ✓ | – | – | – | – | ✓ | Download a signed export of the audit log for a time range. |
| `audit.read` | ✓ | ✓ | – | – | – | ✓ | Search and read the workspace audit log, verify its hash chain, read the export signing keys. |
| `billing.manage` | ✓ | – | – | – | – | – | Start a checkout for a plan and open the billing provider's customer portal. |
| `billing.read` | ✓ | ✓ | – | – | ✓ | – | The workspace's plan, subscription status, grace period and usage against the plan's limits. |
| `branding.manage` | ✓ | ✓ | – | – | – | – | Change the brand, upload or import the logo, remove it. |
| `branding.read` | ✓ | ✓ | – | – | – | – | The workspace brand, its derived theme tokens and the contrast report. |
| `captable.manage` | ✓ | ✓ | – | – | ✓ | – | Import, publish and delete cap-table snapshots, and the module's settings. |
| `captable.read` | ✓ | ✓ | – | – | ✓ | ✓ | Cap-table snapshots (drafts and published), their summary and holders. |
| `compliance.manage` | ✓ | ✓ | – | – | – | ✓ | Create, edit, publish and remove legal documents, and change the workspace's legal settings. |
| `compliance.offering` | ✓ | ✓ | – | – | – | – | Change the offering status. Switching to 506(c) is irrevocable and needs an explicit confirmation. |
| `compliance.read` | ✓ | ✓ | – | – | – | ✓ | Offering mode and its history, the template library, legal documents and versions, the acceptance register, legal settings. |
| `content.manage` | ✓ | ✓ | ✓ | – | – | – | Create pages, edit drafts, set section visibility, restore revisions, delete custom pages. |
| `content.publish` | ✓ | ✓ | ✓ | – | – | – | Publish a draft as a new revision. |
| `content.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Read pages, drafts, revisions and the block registry; preview as an audience. |
| `content.settings` | ✓ | ✓ | – | – | – | – | Content settings (allow public sections). |
| `crm.manage` | ✓ | ✓ | ✓ | – | – | – | Create and edit CRM records and move pipeline items. |
| `crm.read` | ✓ | ✓ | ✓ | ✓ | – | – | Contacts, organisations, pipeline, notes and tasks. |
| `data-room.download` | ✓ | ✓ | ✓ | – | ✓ | ✓ | Download the original file (investors only ever get a watermarked copy). |
| `data-room.forensics` | ✓ | ✓ | – | – | – | ✓ | Trace a leaked page image to its recipient (forensic watermark detection) and list who was served a forensically marked version. |
| `data-room.legal_hold` | ✓ | ✓ | – | – | – | ✓ | Set or clear a legal hold on a document. |
| `data-room.manage` | ✓ | ✓ | ✓ | – | – | – | Create/move/delete folders and documents, upload, change protection, recycle bin. |
| `data-room.qa_answer` | ✓ | ✓ | ✓ | – | ✓ | ✓ | Q&A expert — write, edit and submit a draft answer to a data-room question. |
| `data-room.qa_approve` | ✓ | ✓ | – | – | – | ✓ | Q&A approver — approve or reject a submitted answer. |
| `data-room.qa_manage` | ✓ | ✓ | – | – | – | – | Q&A coordinator — assign, set due dates, release/publish/unpublish, close/reopen, edit public text, CSV import/export. |
| `data-room.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Browse the whole tree, open any document, list versions and templates. |
| `data-room.settings` | ✓ | ✓ | – | – | – | – | Data room settings (defaults, unscanned policy, recycle bin retention). |
| `domains.manage` | ✓ | ✓ | – | – | – | – | Add a custom portal domain, re-check its DNS, remove it. |
| `domains.read` | ✓ | ✓ | – | – | – | – | The workspace's custom portal domains, the DNS records to publish and the last resolver answer. |
| `embed.manage` | ✓ | ✓ | – | – | – | – | Change the embed origin allow-list, the builder-preview toggle, host-identity trust and the handoff keys. |
| `embed.read` | ✓ | ✓ | – | – | – | – | The embed settings, the derived frame-ancestors list and the snippet URLs. |
| `esign.manage` | ✓ | ✓ | – | – | – | – | Connect, verify, re-key and disconnect the e-sign vendor, and void or resync envelopes. |
| `esign.read` | ✓ | ✓ | – | – | – | ✓ | The e-sign vendor connection (never its credentials), the drivers on offer, and the envelope register with signed copies. |
| `integrations.manage` | ✓ | ✓ | – | – | – | – | Connect, verify, choose the account of, re-key and disconnect integrations, and manage booking links. |
| `integrations.read` | ✓ | ✓ | – | – | ✓ | – | Connected integrations (never their credentials), the providers on offer, booking links and the recorded bookings register. |
| `metrics.manage` | ✓ | ✓ | ✓ | – | ✓ | – | Define and remove metrics, save the grid, restate a point, run a CSV import, pull the sheet now. |
| `metrics.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Metric definitions, the period grid, restatement history and CSV import results. |
| `metrics.settings` | ✓ | ✓ | – | – | ✓ | – | Metric defaults (reporting currency, period) and the Google Sheets connection. |
| `notify.manage` | ✓ | ✓ | – | – | – | – | Add, change, test and remove the workspace's Slack channels for notifications. |
| `notify.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Manage my own notification preferences and read my own notification inbox. |
| `ops.manage` | ✓ | ✓ | – | – | – | – | Retry or discard the workspace's dead-lettered jobs. |
| `ops.read` | ✓ | ✓ | – | – | – | – | The workspace's dead letters, instance queue stats, health checks and update status (single-tenant mode), custom-domain certificate status. |
| `portability.export` | ✓ | – | – | – | – | – | Export the whole workspace (tables, files and audit trail) as a signed zip, download and delete exports. |
| `round.manage` | ✓ | ✓ | ✓ | – | ✓ | ✓ | Edit rounds and terms, decide interest submissions and verifications, manage commitments. |
| `round.publish` | ✓ | ✓ | – | – | – | – | Open and close a round, export commitments. |
| `round.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Rounds, terms, interest submissions, verifications and allocation. |
| `round.settings` | ✓ | ✓ | – | – | – | – | Round module settings (evidence retention, default currency). |
| `share-links.manage` | ✓ | ✓ | – | – | – | – | Mint, pause, resume and revoke share links, and choose whether revoking also cuts off the memberships a link created. |
| `share-links.read` | ✓ | ✓ | – | – | – | ✓ | The workspace's share links, their policies and caps, and who came in through each one. |
| `sso.manage` | ✓ | – | – | – | – | – | Configure, test, enable, enforce and delete the SSO connection; add, verify and remove domains; mint and revoke SCIM tokens; map SCIM groups to roles. |
| `sso.read` | ✓ | ✓ | – | – | – | – | The workspace's SSO connection, verified domains and SCIM provisioning (never secrets or tokens). |
| `updates.manage` | ✓ | ✓ | ✓ | – | – | – | Create and edit drafts, set audiences and section rules, archive, delete. |
| `updates.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | List updates, read drafts, sends, recipient status and every reply thread. |
| `updates.send` | ✓ | ✓ | ✓ | – | – | – | Test send, schedule, send now, publish to the archive. |
| `updates.settings` | ✓ | ✓ | – | – | – | – | Update email settings (sender, reply-to, footer) and the sending domain. |
| `webhooks.manage` | ✓ | ✓ | – | – | – | – | Add, change, test, re-key and remove webhook endpoints, and redeliver deliveries. |
| `webhooks.read` | ✓ | ✓ | – | – | – | – | The workspace's webhook endpoints (never their URLs or secrets), the topics on offer, and the delivery log with payloads. |

## Routes

| Method | Path | Requires | Step-up | API key |
|---|---|---|---|---|
| GET | `/modules` | public |  |  |
| GET | `/me` | session |  |  |
| GET | `/invites/{token}` | public |  |  |
| POST | `/auth/otp/start` | public |  |  |
| POST | `/auth/otp/verify` | public |  |  |
| POST | `/auth/magic-link/start` | public |  |  |
| GET | `/auth/magic-link/peek` | public |  |  |
| POST | `/auth/magic-link/confirm` | public |  |  |
| POST | `/auth/passkeys/login/begin` | public |  |  |
| POST | `/auth/passkeys/login/finish` | public |  |  |
| POST | `/auth/passkeys/step-up/finish` | session |  |  |
| POST | `/auth/passkeys/register/begin` | session | yes |  |
| POST | `/auth/passkeys/register/finish` | session |  |  |
| GET | `/auth/passkeys` | session |  |  |
| PATCH | `/auth/passkeys/{id}` | session |  |  |
| DELETE | `/auth/passkeys/{id}` | session | yes |  |
| GET | `/auth/totp` | session |  |  |
| DELETE | `/auth/totp` | session | yes |  |
| POST | `/auth/totp/enrol` | session | yes |  |
| POST | `/auth/totp/enrol/confirm` | session |  |  |
| POST | `/auth/totp/verify` | session |  |  |
| POST | `/auth/totp/recovery` | session |  |  |
| POST | `/auth/totp/recovery-codes` | session | yes |  |
| GET | `/auth/password` | session |  |  |
| PUT | `/auth/password` | session | yes |  |
| DELETE | `/auth/password` | session | yes |  |
| POST | `/auth/password/login` | public |  |  |
| POST | `/auth/password/reverify` | session |  |  |
| GET | `/auth/oidc/providers` | public |  |  |
| POST | `/auth/oidc/begin` | public |  |  |
| GET | `/auth/oidc/callback` | public |  |  |
| POST | `/auth/logout` | session |  |  |
| POST | `/auth/logout-everywhere` | session | yes |  |
| POST | `/auth/sessions/revoke-by-token` | public |  |  |
| GET | `/me/sessions` | session |  |  |
| DELETE | `/me/sessions/{id}` | session | yes |  |
| GET | `/me/devices` | session |  |  |
| PATCH | `/me/devices/{id}` | session |  |  |
| DELETE | `/me/devices/{id}` | session | yes |  |
| GET | `/setup/status` | public |  |  |
| POST | `/setup/token/verify` | public |  |  |
| POST | `/setup/owner` | public |  |  |
| POST | `/setup/probes/mail` | owner-or-admin |  |  |
| POST | `/setup/probes/storage` | owner-or-admin |  |  |
| GET | `/access/people` | access.read |  | yes |
| GET | `/access/people/{id}` | access.read |  | yes |
| PATCH | `/access/people/{id}` | access.manage | yes |  |
| POST | `/access/people/{id}/revoke` | access.manage | yes |  |
| PUT | `/access/people/{id}/groups` | access.manage |  |  |
| GET | `/access/invites` | access.read |  |  |
| POST | `/access/invites` | access.manage |  |  |
| POST | `/access/invites/{id}/resend` | access.manage |  |  |
| DELETE | `/access/invites/{id}` | access.manage |  |  |
| POST | `/access/invites/csv/dry-run` | access.manage |  |  |
| POST | `/access/invites/csv/import` | access.manage |  |  |
| GET | `/access/invites/csv/imports/{id}` | access.read |  |  |
| GET | `/access/groups` | access.read |  | yes |
| POST | `/access/groups` | access.manage |  |  |
| GET | `/access/groups/{id}` | access.read |  |  |
| PATCH | `/access/groups/{id}` | access.manage |  |  |
| DELETE | `/access/groups/{id}` | access.manage | yes |  |
| POST | `/access/groups/{id}/members` | access.manage |  |  |
| DELETE | `/access/groups/{id}/members/{membershipId}` | access.manage |  |  |
| GET | `/access/grants` | access.read |  |  |
| POST | `/access/grants` | access.manage | yes |  |
| DELETE | `/access/grants/{id}` | access.manage | yes |  |
| GET | `/access/policies` | access.read |  |  |
| POST | `/access/policies` | access.manage | yes |  |
| DELETE | `/access/policies/{id}` | access.manage | yes |  |
| GET | `/access/resources/{kind}/{id}/who` | access.read |  |  |
| GET | `/access/resources/{kind}/{id}/explain` | access.read |  |  |
| GET | `/access/settings` | access.read |  |  |
| PATCH | `/access/settings` | access.settings | yes |  |
| GET | `/access/my` | member |  |  |
| GET | `/access/my/delegates` | member |  |  |
| POST | `/access/my/delegates` | member | yes |  |
| DELETE | `/access/my/delegates/{id}` | member | yes |  |
| GET | `/access/people/{id}/delegates` | access.read |  |  |
| POST | `/access/people/{id}/delegates` | access.manage | yes |  |
| DELETE | `/access/people/{id}/delegates/{delegateId}` | access.manage | yes |  |
| GET | `/access/review` | access.read |  |  |
| GET | `/access/reviews` | access.read |  |  |
| POST | `/access/reviews` | access.manage | yes |  |
| GET | `/access/reviews/{id}/report` | access.read |  |  |
| GET | `/access/people/{id}/sessions` | access.read |  |  |
| DELETE | `/access/people/{id}/sessions/{sessionId}` | access.manage | yes |  |
| POST | `/access/people/{id}/sessions/revoke` | access.manage | yes |  |
| POST | `/access/ownership/transfer` | access.transfer | yes |  |
| POST | `/access/sessions/revoke-all` | access.transfer | yes |  |
| DELETE | `/workspace` | access.delete_workspace | yes |  |
| POST | `/access-requests/start` | public |  |  |
| POST | `/access-requests/verify` | public |  |  |
| GET | `/access/requests` | access.read |  |  |
| GET | `/access/requests/{id}` | access.read |  |  |
| POST | `/access/requests/{id}/approve` | access.manage |  |  |
| POST | `/access/requests/{id}/deny` | access.manage |  |  |
| POST | `/access/people/{id}/view-as` | access.manage | yes |  |
| GET | `/me/view-as` | session |  |  |
| DELETE | `/me/view-as` | session |  |  |
| GET | `/compliance/offering` | compliance.read |  |  |
| PATCH | `/compliance/offering` | compliance.offering | yes |  |
| GET | `/compliance/settings` | compliance.read |  |  |
| PATCH | `/compliance/settings` | compliance.manage | yes |  |
| GET | `/compliance/templates` | compliance.read |  |  |
| GET | `/compliance/templates/{templateId}` | compliance.read |  |  |
| GET | `/compliance/documents` | compliance.read |  |  |
| POST | `/compliance/documents` | compliance.manage |  |  |
| GET | `/compliance/documents/{id}` | compliance.read |  |  |
| PATCH | `/compliance/documents/{id}` | compliance.manage |  |  |
| DELETE | `/compliance/documents/{id}` | compliance.manage | yes |  |
| GET | `/compliance/documents/{id}/versions` | compliance.read |  |  |
| POST | `/compliance/documents/{id}/versions` | compliance.manage | yes |  |
| GET | `/compliance/acceptances` | compliance.read |  |  |
| GET | `/compliance/acceptances/export` | compliance.read |  |  |
| GET | `/compliance/acceptances/{membershipId}/certificate` | member |  |  |
| GET | `/compliance/gates` | member |  |  |
| POST | `/compliance/acceptances` | member |  |  |
| GET | `/compliance/consent` | member |  |  |
| PUT | `/compliance/consent` | member |  |  |
| POST | `/compliance/erasure-requests` | compliance.manage | yes |  |
| GET | `/compliance/erasure-requests` | compliance.read |  |  |
| GET | `/compliance/erasure-requests/{id}` | compliance.read |  |  |
| POST | `/compliance/erasure-requests/{id}/cancel` | compliance.manage | yes |  |
| GET | `/compliance/data-requests` | compliance.read |  |  |
| POST | `/compliance/data-requests` | compliance.manage | yes |  |
| POST | `/compliance/data-requests/{id}/complete` | compliance.manage | yes |  |
| GET | `/compliance/subjects/{membershipId}/export` | compliance.manage | yes |  |
| GET | `/audit/events` | audit.read |  | yes |
| GET | `/audit/verify` | audit.read |  |  |
| GET | `/audit/export-key` | audit.read |  |  |
| POST | `/audit/exports` | audit.export | yes |  |
| GET | `/audit/anchors` | audit.read |  |  |
| GET | `/audit/anchors/{checkpointId}/proof` | audit.export |  |  |
| GET | `/ops/jobs` | ops.read |  |  |
| POST | `/ops/jobs/dead-letters/{id}/retry` | ops.manage |  |  |
| DELETE | `/ops/jobs/dead-letters/{id}` | ops.manage | yes |  |
| GET | `/ops/health` | ops.read |  |  |
| GET | `/ops/update` | ops.read |  |  |
| GET | `/search` | member |  |  |
| GET | `/portability/exports` | portability.export |  |  |
| POST | `/portability/exports` | portability.export | yes |  |
| GET | `/portability/exports/{id}` | portability.export |  |  |
| GET | `/portability/exports/{id}/download` | portability.export | yes |  |
| DELETE | `/portability/exports/{id}` | portability.export |  |  |
| GET | `/portability/export-key` | portability.export |  |  |
| GET | `/compliance/accessibility-statement` | public |  |  |
| PUT | `/me/locale` | session |  |  |
| PUT | `/workspace/locale` | access.settings |  |  |
| GET | `/branding` | branding.read |  |  |
| PATCH | `/branding` | branding.manage |  |  |
| POST | `/branding/logo` | branding.manage |  |  |
| POST | `/branding/logo/fetch` | branding.manage |  |  |
| DELETE | `/branding/logo` | branding.manage |  |  |
| GET | `/branding/logo` | public |  |  |
| GET | `/branding/theme` | public |  |  |
| GET | `/domains` | domains.read |  |  |
| POST | `/domains` | domains.manage | yes |  |
| POST | `/domains/{id}/verify` | domains.manage | yes |  |
| DELETE | `/domains/{id}` | domains.manage | yes |  |
| GET | `/mail/status` | access.settings |  |  |
| GET | `/mail/suppressions` | access.settings |  |  |
| DELETE | `/mail/suppressions/{id}` | access.settings | yes |  |
| GET | `/embed/settings` | embed.read |  |  |
| PUT | `/embed/settings` | embed.manage | yes |  |
| POST | `/embed/handoff` | public |  |  |
| GET | `/links/{token}` | public |  |  |
| POST | `/links/{token}/start` | public |  |  |
| POST | `/links/{token}/verify` | public |  |  |
| GET | `/links` | share-links.read |  |  |
| POST | `/links` | share-links.manage | yes |  |
| GET | `/links/{id}/visits` | share-links.read |  |  |
| POST | `/links/{id}/pause` | share-links.manage |  |  |
| POST | `/links/{id}/resume` | share-links.manage |  |  |
| POST | `/links/{id}/revoke` | share-links.manage | yes |  |
| GET | `/api-keys` | api-keys.read |  |  |
| GET | `/api-keys/scopes` | api-keys.read |  |  |
| POST | `/api-keys` | api-keys.manage | yes |  |
| PATCH | `/api-keys/{id}` | api-keys.manage | yes |  |
| POST | `/api-keys/{id}/rotate` | api-keys.manage | yes |  |
| POST | `/api-keys/{id}/revoke` | api-keys.manage | yes |  |
| GET | `/webhooks/topics` | webhooks.read |  |  |
| GET | `/webhooks/endpoints` | webhooks.read |  |  |
| POST | `/webhooks/endpoints` | webhooks.manage | yes |  |
| GET | `/webhooks/endpoints/{id}` | webhooks.read |  |  |
| PATCH | `/webhooks/endpoints/{id}` | webhooks.manage |  |  |
| DELETE | `/webhooks/endpoints/{id}` | webhooks.manage | yes |  |
| POST | `/webhooks/endpoints/{id}/rotate-secret` | webhooks.manage | yes |  |
| POST | `/webhooks/endpoints/{id}/test` | webhooks.manage |  |  |
| GET | `/webhooks/deliveries` | webhooks.read |  | yes |
| GET | `/webhooks/deliveries/{id}` | webhooks.read |  | yes |
| POST | `/webhooks/deliveries/{id}/redeliver` | webhooks.manage |  |  |
| GET | `/esign/drivers` | esign.read |  |  |
| GET | `/esign/connection` | esign.read |  |  |
| PUT | `/esign/connection` | esign.manage | yes |  |
| POST | `/esign/connection/verify` | esign.manage |  |  |
| POST | `/esign/connection/rotate-callback-secret` | esign.manage | yes |  |
| DELETE | `/esign/connection` | esign.manage | yes |  |
| GET | `/esign/envelopes` | esign.read |  | yes |
| GET | `/esign/envelopes/{id}` | esign.read |  | yes |
| GET | `/esign/envelopes/{id}/signed.pdf` | esign.read |  |  |
| GET | `/esign/envelopes/{id}/certificate.pdf` | esign.read |  |  |
| POST | `/esign/envelopes/{id}/void` | esign.manage | yes |  |
| POST | `/esign/envelopes/{id}/sync` | esign.manage |  |  |
| GET | `/esign/me/envelopes` | member |  |  |
| GET | `/esign/me/envelopes/{id}/signed.pdf` | member |  |  |
| POST | `/esign/nda/start` | member |  |  |
| GET | `/esign/nda/status` | member |  |  |
| GET | `/accreditation/providers` | accreditation.read |  |  |
| GET | `/accreditation/connection` | accreditation.read |  |  |
| PUT | `/accreditation/connection` | accreditation.manage | yes |  |
| POST | `/accreditation/connection/verify` | accreditation.manage | yes |  |
| DELETE | `/accreditation/connection` | accreditation.manage | yes |  |
| GET | `/integrations/providers` | integrations.read |  |  |
| GET | `/integrations/connections` | integrations.read |  |  |
| POST | `/integrations/{provider}/connect` | integrations.manage | yes |  |
| POST | `/integrations/{provider}/oauth/begin` | integrations.manage | yes |  |
| POST | `/integrations/{provider}/oauth/complete` | integrations.manage | yes |  |
| POST | `/integrations/{provider}/verify` | integrations.manage |  |  |
| PUT | `/integrations/{provider}/account` | integrations.manage | yes |  |
| POST | `/integrations/{provider}/rotate-webhook-secret` | integrations.manage | yes |  |
| DELETE | `/integrations/{provider}` | integrations.manage | yes |  |
| GET | `/integrations/bookings` | integrations.read |  | yes |
| GET | `/integrations/booking-links` | integrations.read |  |  |
| POST | `/integrations/booking-links` | integrations.manage |  |  |
| PATCH | `/integrations/booking-links/{id}` | integrations.manage |  |  |
| DELETE | `/integrations/booking-links/{id}` | integrations.manage |  |  |
| GET | `/integrations/me/booking-links` | member |  |  |
| GET | `/modules/enablement` | owner-or-admin |  |  |
| PATCH | `/modules/{id}` | owner-or-admin |  |  |
| GET | `/content/render/{slug}` | public |  |  |
| GET | `/content/pages` | content.read |  |  |
| POST | `/content/pages` | content.manage |  |  |
| GET | `/content/pages/{id}` | content.read |  |  |
| PATCH | `/content/pages/{id}` | content.manage |  |  |
| DELETE | `/content/pages/{id}` | content.manage | yes |  |
| PUT | `/content/pages/{id}/draft` | content.manage |  |  |
| PUT | `/content/pages/{id}/visibility` | content.manage |  |  |
| POST | `/content/pages/{id}/publish` | content.publish |  |  |
| GET | `/content/pages/{id}/preview` | content.read |  |  |
| GET | `/content/pages/{id}/revisions` | content.read |  |  |
| GET | `/content/pages/{id}/revisions/{revisionId}` | content.read |  |  |
| POST | `/content/pages/{id}/revisions/{revisionId}/restore` | content.manage |  |  |
| GET | `/content/blocks` | content.read |  |  |
| GET | `/content/settings` | content.read |  |  |
| PATCH | `/content/settings` | content.settings | yes |  |
| GET | `/data-room/tree` | member |  |  |
| POST | `/data-room/folders` | data-room.manage |  |  |
| PATCH | `/data-room/folders/{id}` | data-room.manage |  |  |
| DELETE | `/data-room/folders/{id}` | data-room.manage |  |  |
| POST | `/data-room/folders/{id}/restore` | data-room.manage |  |  |
| GET | `/data-room/templates` | data-room.read |  |  |
| POST | `/data-room/templates/{id}/apply` | data-room.manage |  |  |
| GET | `/data-room/documents/{id}` | member |  |  |
| PATCH | `/data-room/documents/{id}` | data-room.manage |  |  |
| DELETE | `/data-room/documents/{id}` | data-room.manage |  |  |
| POST | `/data-room/documents/{id}/restore` | data-room.manage |  |  |
| DELETE | `/data-room/documents/{id}/purge` | data-room.manage | yes |  |
| PUT | `/data-room/documents/{id}/legal-hold` | data-room.legal_hold | yes |  |
| GET | `/data-room/documents/{id}/versions` | data-room.read |  | yes |
| GET | `/data-room/documents/{id}/thumbnail` | member |  |  |
| GET | `/data-room/documents/{id}/pages/{n}` | member |  |  |
| GET | `/data-room/documents/{id}/pages/{n}/text` | member |  |  |
| GET | `/data-room/documents/{id}/search` | member |  |  |
| GET | `/data-room/documents/{id}/download` | member |  |  |
| POST | `/data-room/documents/{id}/viewed` | member |  |  |
| POST | `/data-room/uploads` | data-room.manage |  |  |
| POST | `/data-room/uploads/{id}/complete` | data-room.manage |  |  |
| GET | `/data-room/uploads/{id}` | data-room.manage |  |  |
| DELETE | `/data-room/uploads/{id}` | data-room.manage |  |  |
| GET | `/data-room/trash` | data-room.manage |  |  |
| GET | `/data-room/settings` | data-room.read |  |  |
| PATCH | `/data-room/settings` | data-room.settings | yes |  |
| POST | `/data-room/documents/{id}/forensic/detect` | data-room.forensics | yes |  |
| GET | `/data-room/documents/{id}/forensic/recipients` | data-room.forensics |  |  |
| GET | `/data-room/qa/status` | member |  |  |
| GET | `/data-room/qa/questions` | member |  |  |
| POST | `/data-room/qa/questions` | member |  |  |
| GET | `/data-room/qa/questions/{id}` | member |  |  |
| POST | `/data-room/qa/questions/{id}/withdraw` | member |  |  |
| GET | `/data-room/qa/inbox` | data-room.read |  | yes |
| POST | `/data-room/qa/inbox` | data-room.qa_manage |  | yes |
| GET | `/data-room/qa/inbox/{id}` | data-room.read |  | yes |
| PATCH | `/data-room/qa/inbox/{id}` | data-room.qa_manage |  |  |
| POST | `/data-room/qa/inbox/{id}/assign` | data-room.qa_manage |  |  |
| PUT | `/data-room/qa/inbox/{id}/answer` | data-room.qa_answer |  |  |
| POST | `/data-room/qa/inbox/{id}/ai-suggestion` | data-room.qa_answer |  |  |
| POST | `/data-room/qa/inbox/{id}/submit` | data-room.qa_answer |  |  |
| POST | `/data-room/qa/inbox/{id}/approve` | data-room.qa_approve |  |  |
| POST | `/data-room/qa/inbox/{id}/reject` | data-room.qa_approve |  |  |
| POST | `/data-room/qa/inbox/{id}/release` | data-room.qa_manage |  |  |
| POST | `/data-room/qa/inbox/{id}/unpublish` | data-room.qa_manage |  |  |
| POST | `/data-room/qa/inbox/{id}/close` | data-room.qa_manage |  |  |
| POST | `/data-room/qa/inbox/{id}/reopen` | data-room.qa_manage |  |  |
| GET | `/data-room/qa/export` | data-room.qa_manage | yes |  |
| POST | `/data-room/qa/import` | data-room.qa_manage | yes |  |
| GET | `/updates/templates` | updates.read |  |  |
| GET | `/updates/posts` | updates.read |  | yes |
| POST | `/updates/posts` | updates.manage |  |  |
| POST | `/updates/ai/draft` | updates.manage |  |  |
| GET | `/updates/posts/{id}` | updates.read |  | yes |
| PUT | `/updates/posts/{id}/draft` | updates.manage |  |  |
| DELETE | `/updates/posts/{id}` | updates.manage | yes |  |
| POST | `/updates/posts/{id}/schedule` | updates.send |  |  |
| POST | `/updates/posts/{id}/unschedule` | updates.send |  |  |
| POST | `/updates/posts/{id}/send` | updates.send | yes |  |
| POST | `/updates/posts/{id}/test-send` | updates.send |  |  |
| POST | `/updates/posts/{id}/publish` | updates.send |  |  |
| PUT | `/updates/posts/{id}/archived` | updates.manage |  |  |
| GET | `/updates/posts/{id}/sends` | updates.read |  |  |
| GET | `/updates/sends/{sendId}/recipients` | updates.read |  |  |
| GET | `/updates/archive` | member |  |  |
| GET | `/updates/archive/{slug}` | member |  |  |
| GET | `/updates/posts/{id}/replies` | member |  |  |
| POST | `/updates/posts/{id}/replies` | member |  |  |
| GET | `/updates/subscription` | member |  |  |
| PUT | `/updates/subscription` | member |  |  |
| POST | `/updates/unsubscribe` | public |  |  |
| GET | `/updates/settings` | updates.settings |  |  |
| PATCH | `/updates/settings` | updates.settings | yes |  |
| GET | `/updates/sending-domain` | updates.settings |  |  |
| PUT | `/updates/sending-domain` | updates.settings | yes |  |
| POST | `/updates/sending-domain/verify` | updates.settings |  |  |
| DELETE | `/updates/sending-domain` | updates.settings | yes |  |
| POST | `/analytics/heartbeat` | member |  |  |
| POST | `/analytics/close` | member |  |  |
| GET | `/analytics/notice` | member |  |  |
| GET | `/analytics/overview` | analytics.read |  |  |
| GET | `/analytics/{kind}/{id}/viewers` | analytics.read |  |  |
| GET | `/analytics/{kind}/{id}/viewers/{membershipId}/pages` | analytics.read |  |  |
| GET | `/analytics/members/{membershipId}/timeline` | analytics.read |  |  |
| GET | `/analytics/{kind}/{id}/heatmap` | analytics.read |  |  |
| GET | `/analytics/hot-list` | analytics.read |  |  |
| GET | `/analytics/hot-list.csv` | analytics.read |  |  |
| GET | `/analytics/posts/{id}/email` | analytics.read |  |  |
| GET | `/analytics/settings` | analytics.read |  |  |
| PATCH | `/analytics/settings` | analytics.settings | yes |  |
| POST | `/analytics/members/{membershipId}/anonymise` | analytics.settings | yes |  |
| GET | `/metrics/definitions` | metrics.read |  | yes |
| POST | `/metrics/definitions` | metrics.manage |  |  |
| GET | `/metrics/definitions/{id}` | metrics.read |  |  |
| PATCH | `/metrics/definitions/{id}` | metrics.manage |  |  |
| DELETE | `/metrics/definitions/{id}` | metrics.manage | yes |  |
| GET | `/metrics/definitions/{id}/points` | metrics.read |  | yes |
| PUT | `/metrics/definitions/{id}/points` | metrics.manage |  | yes |
| GET | `/metrics/grid` | metrics.read |  | yes |
| PUT | `/metrics/grid` | metrics.manage |  | yes |
| GET | `/metrics/series` | member |  |  |
| POST | `/metrics/import/dry-run` | metrics.manage |  | yes |
| POST | `/metrics/import` | metrics.manage |  | yes |
| GET | `/metrics/import/{id}` | metrics.read |  | yes |
| GET | `/metrics/sheets` | metrics.settings |  |  |
| PUT | `/metrics/sheets` | metrics.settings | yes |  |
| DELETE | `/metrics/sheets` | metrics.settings | yes |  |
| POST | `/metrics/sheets/sync` | metrics.manage |  |  |
| GET | `/metrics/sources` | metrics.settings |  |  |
| POST | `/metrics/sources/sync` | metrics.manage |  |  |
| PUT | `/metrics/definitions/{id}/binding` | metrics.settings | yes |  |
| DELETE | `/metrics/definitions/{id}/binding` | metrics.settings | yes |  |
| GET | `/metrics/settings` | metrics.settings |  |  |
| PATCH | `/metrics/settings` | metrics.settings | yes |  |
| GET | `/metrics/chart/{token}.png` | public |  |  |
| GET | `/round/current` | member |  |  |
| GET | `/round/current/calculate` | member |  |  |
| GET | `/round/current/eligibility` | member |  |  |
| POST | `/round/current/interest` | member |  |  |
| GET | `/round/current/interest` | member |  |  |
| POST | `/round/current/interest/{id}/withdraw` | member |  |  |
| PUT | `/round/verifications/{id}/evidence` | member |  |  |
| GET | `/round/rounds` | round.read |  | yes |
| POST | `/round/rounds` | round.manage |  |  |
| GET | `/round/rounds/{id}` | round.read |  |  |
| PATCH | `/round/rounds/{id}` | round.manage |  |  |
| DELETE | `/round/rounds/{id}` | round.manage | yes |  |
| POST | `/round/rounds/{id}/open` | round.publish | yes |  |
| POST | `/round/rounds/{id}/close` | round.publish | yes |  |
| PUT | `/round/rounds/{id}/terms` | round.manage |  |  |
| GET | `/round/rounds/{id}/terms` | round.read |  |  |
| GET | `/round/rounds/{id}/allocation` | round.read |  |  |
| GET | `/round/rounds/{id}/export.csv` | round.publish | yes |  |
| GET | `/round/rounds/{id}/commitments` | round.read |  | yes |
| POST | `/round/rounds/{id}/commitments` | round.manage |  |  |
| PATCH | `/round/commitments/{id}` | round.manage |  |  |
| GET | `/round/rounds/{id}/interest` | round.read |  | yes |
| POST | `/round/interest/{id}/accept` | round.manage |  |  |
| POST | `/round/interest/{id}/decline` | round.manage |  |  |
| GET | `/round/verifications` | round.read |  |  |
| GET | `/round/verifications/{id}` | round.read |  |  |
| GET | `/round/verifications/{id}/evidence` | round.manage |  |  |
| POST | `/round/verifications/{id}/decide` | round.manage |  |  |
| GET | `/round/current/verification` | member |  |  |
| POST | `/round/current/verification` | member |  |  |
| GET | `/round/current/verification/handoff` | member |  |  |
| POST | `/round/verifications/{id}/check` | round.manage |  |  |
| GET | `/round/rounds/{id}/closing-tasks` | round.read |  |  |
| PUT | `/round/rounds/{id}/closing-tasks` | round.manage |  |  |
| POST | `/round/commitments/{id}/signature-request` | round.manage | yes |  |
| POST | `/round/signature-requests/{id}/void` | round.manage | yes |  |
| POST | `/round/commitments/{id}/confirm` | round.manage | yes |  |
| GET | `/round/rounds/{id}/closing` | round.read |  | yes |
| GET | `/round/current/closing` | member |  |  |
| GET | `/round/settings` | round.settings |  |  |
| PATCH | `/round/settings` | round.settings | yes |  |
| GET | `/crm/stages` | crm.read |  |  |
| PUT | `/crm/stages` | crm.manage |  |  |
| GET | `/crm/organizations` | crm.read |  |  |
| POST | `/crm/organizations` | crm.manage |  |  |
| GET | `/crm/organizations/{id}` | crm.read |  |  |
| PATCH | `/crm/organizations/{id}` | crm.manage |  |  |
| DELETE | `/crm/organizations/{id}` | crm.manage |  |  |
| GET | `/crm/contacts` | crm.read |  | yes |
| POST | `/crm/contacts` | crm.manage |  | yes |
| GET | `/crm/contacts/{id}` | crm.read |  | yes |
| PATCH | `/crm/contacts/{id}` | crm.manage |  | yes |
| DELETE | `/crm/contacts/{id}` | crm.manage |  |  |
| GET | `/crm/contacts/{id}/activity` | crm.read |  |  |
| GET | `/crm/pipeline` | crm.read |  |  |
| POST | `/crm/pipeline` | crm.manage |  |  |
| PATCH | `/crm/pipeline/{id}` | crm.manage |  |  |
| DELETE | `/crm/pipeline/{id}` | crm.manage |  |  |
| POST | `/crm/notes` | crm.manage |  |  |
| DELETE | `/crm/notes/{id}` | crm.manage |  |  |
| POST | `/crm/tasks` | crm.manage |  |  |
| PATCH | `/crm/tasks/{id}` | crm.manage |  |  |
| DELETE | `/crm/tasks/{id}` | crm.manage |  |  |
| GET | `/notify/preferences` | notify.read |  |  |
| PUT | `/notify/preferences` | notify.read |  |  |
| GET | `/notify/inbox` | notify.read |  |  |
| POST | `/notify/inbox/read` | notify.read |  |  |
| POST | `/notify/inbox/read-all` | notify.read |  |  |
| POST | `/notify/inbox/archive` | notify.read |  |  |
| GET | `/notify/channels` | notify.manage |  |  |
| POST | `/notify/channels` | notify.manage | yes |  |
| PATCH | `/notify/channels/{id}` | notify.manage |  |  |
| DELETE | `/notify/channels/{id}` | notify.manage | yes |  |
| POST | `/notify/channels/{id}/test` | notify.manage |  |  |
| GET | `/notify/slack/channels` | notify.manage |  |  |
| GET | `/captable/snapshots` | captable.read |  |  |
| GET | `/captable/snapshots/{id}` | captable.read |  |  |
| POST | `/captable/import/dry-run` | captable.manage |  |  |
| POST | `/captable/import` | captable.manage |  |  |
| POST | `/captable/snapshots/{id}/publish` | captable.manage | yes |  |
| DELETE | `/captable/snapshots/{id}` | captable.manage |  |  |
| GET | `/captable/me` | member |  |  |
| GET | `/captable/settings` | captable.manage |  |  |
| PUT | `/captable/settings` | captable.manage | yes |  |
| GET | `/sso/connection` | sso.read |  |  |
| PUT | `/sso/connection` | sso.manage | yes |  |
| DELETE | `/sso/connection` | sso.manage | yes |  |
| PUT | `/sso/connection/state` | sso.manage | yes |  |
| GET | `/sso/domains` | sso.read |  |  |
| POST | `/sso/domains` | sso.manage | yes |  |
| POST | `/sso/domains/{id}/verify` | sso.manage |  |  |
| DELETE | `/sso/domains/{id}` | sso.manage | yes |  |
| GET | `/sso/scim` | sso.read |  |  |
| POST | `/sso/scim/tokens` | sso.manage | yes |  |
| DELETE | `/sso/scim/tokens/{id}` | sso.manage | yes |  |
| GET | `/sso/scim/users` | sso.read |  |  |
| GET | `/sso/scim/groups` | sso.read |  |  |
| PUT | `/sso/scim/groups/{id}/role` | sso.manage | yes |  |
| GET | `/auth/sso` | public |  |  |
| POST | `/auth/sso/discover` | public |  |  |
| POST | `/auth/sso/begin` | public |  |  |
| GET | `/auth/sso/finish` | public |  |  |
| POST | `/platform/session` | session |  |  |
| DELETE | `/platform/session` | platform-operator |  |  |
| GET | `/platform/me` | platform-operator |  |  |
| GET | `/platform/workspaces` | platform-operator |  |  |
| POST | `/platform/workspaces` | platform-operator |  |  |
| GET | `/platform/workspaces/{id}` | platform-operator |  |  |
| PATCH | `/platform/workspaces/{id}` | platform-operator |  |  |
| POST | `/platform/workspaces/{id}/suspend` | platform-operator |  |  |
| POST | `/platform/workspaces/{id}/unsuspend` | platform-operator |  |  |
| GET | `/platform/cells` | platform-operator |  |  |
| GET | `/platform/operators` | platform-operator |  |  |
| GET | `/platform/audit` | platform-operator |  |  |
| GET | `/platform/health` | platform-operator |  |  |
| GET | `/platform/plans` | platform-operator |  |  |
| POST | `/platform/plans` | platform-operator |  |  |
| PATCH | `/platform/plans/{id}` | platform-operator |  |  |
| POST | `/platform/plans/{id}/archive` | platform-operator |  |  |
| GET | `/platform/workspaces/{id}/usage` | platform-operator |  |  |
| GET | `/usage` | billing.read |  |  |
| GET | `/billing` | billing.read |  |  |
| POST | `/billing/checkout` | billing.manage | yes |  |
| POST | `/billing/portal` | billing.manage | yes |  |
| POST | `/platform/workspaces/{id}/subscription` | platform-operator |  |  |
| GET | `/platform/sanctions` | platform-operator |  |  |
| GET | `/platform/sanctions/{id}` | platform-operator |  |  |
| POST | `/platform/sanctions/{id}/decision` | platform-operator |  |  |
| POST | `/platform/workspaces/{id}/rescreen` | platform-operator |  |  |
| POST | `/platform/enrol/start` | public |  |  |
| POST | `/platform/enrol/verify` | public |  |  |
| GET | `/platform/enrol/session` | public |  |  |
| DELETE | `/platform/enrol/session` | public |  |  |
| POST | `/platform/enrol/totp` | public |  |  |
| POST | `/platform/enrol/totp/confirm` | public |  |  |
| POST | `/platform/enrol/passkey/begin` | public |  |  |
| POST | `/platform/enrol/passkey/finish` | public |  |  |
| GET | `/signup/slug` | public |  |  |
| GET | `/signup/plans` | public |  |  |
| POST | `/signup/start` | public |  |  |
| POST | `/signup/verify` | public |  |  |
| GET | `/residency` | compliance.read |  |  |
| POST | `/platform/workspaces/{id}/move` | platform-operator |  |  |
| GET | `/platform/moves` | platform-operator |  |  |
| POST | `/platform/moves/{id}/cancel` | platform-operator |  |  |
| GET | `/signup/regions` | public |  |  |
| GET | `/ai/status` | ai.read |  |  |
| PUT | `/ai/settings` | ai.manage | yes |  |
| GET | `/ai/requests/{id}` | ai.read |  |  |
| DELETE | `/ai/requests/{id}` | ai.read |  |  |
