/*
 * The kernel's audit action catalogue (design/02 §6 "what"). Modules add their own with the
 * same shape (`<resource>.<verb>`); the CHECK on audit.event enforces the shape, this list
 * types the kernel's and documents them for counsel-facing exports.
 */
export const KERNEL_AUDIT_ACTIONS = [
  // auth
  "auth.login",
  "auth.login_failed",
  "auth.step_up",
  "auth.session_revoked",
  "auth.sessions_revoked_all",
  "auth.sessions_revoked_workspace",
  "auth.device_revoked",
  "auth.mfa_enrolled",
  "auth.mfa_disabled",
  "auth.passkey_added",
  "auth.passkey_removed",
  "auth.password_changed",
  "auth.password_breach_check_skipped",
  "auth.recovery_code_used",
  "auth.recovery_codes_regenerated",
  // access (E1.1)
  "invite.created",
  "invite.resent",
  "invite.revoked",
  "invite_import.started",
  "invite_import.finished",
  "membership.created",
  "membership.updated",
  "membership.role_changed",
  "membership.revoked",
  "group.created",
  "group.updated",
  "group.deleted",
  "group.member_added",
  "group.member_removed",
  "grant.created",
  "grant.revoked",
  "policy.created",
  "policy.revoked",
  "access.settings_changed",
  // content page (E1.2)
  "page.created",
  "page.updated",
  "page.published",
  "page.visibility_changed",
  "page.deleted",
  "content.settings_changed",
  // data room (E1.3)
  "folder.created",
  "folder.updated",
  "folder.deleted",
  "folder.restored",
  "folder.template_applied",
  "document.created",
  "document.version_uploaded",
  "document.updated",
  "document.deleted",
  "document.restored",
  "document.purged",
  "document.legal_hold_set",
  "document.legal_hold_cleared",
  "document.scan_infected",
  "document.sanitized",
  "document.ingested",
  "document.viewed",
  "document.downloaded",
  // E3.5: a signed e-signature artifact filed into the data room (system; legal hold, staff-only).
  "document.vaulted",
  "upload.aborted",
  "data_room.settings_changed",
  // E3.13: a staff member tested a leaked page image against a version's forensic marks
  // (resource `document`; meta { versionId, page, candidatesTested, matches: [membershipId…],
  // inconclusive }). The image itself is never stored.
  "data_room.forensic_detection",
  // investor updates (E1.4)
  "update.created",
  "update.updated",
  "update.deleted",
  "update.scheduled",
  "update.unscheduled",
  "update.published",
  "update.sent",
  "update.test_sent",
  "update.replied",
  "update.unsubscribed",
  "update.resubscribed",
  "sending_domain.created",
  "sending_domain.verified",
  "sending_domain.deleted",
  "updates.settings_changed",
  // engagement analytics + notifications (E1.5)
  "analytics.settings_changed",
  "analytics.anonymised",
  "notification.sent",
  "notification.digest_sent",
  "notify.preferences_changed",
  // offering mode + legal documents (E1.6)
  "legal.document_created",
  "legal.document_updated",
  "legal.document_published",
  "legal.document_accepted",
  "legal.settings_changed",
  "consent.recorded",
  "membership.relationship_recorded",
  // share links & NDA engine (E2.3)
  "share_link.created",
  "share_link.revoked",
  "share_link.paused",
  "share_link.resumed",
  "share_link.redeemed",
  // Denied admission: audited with the system actor, because a refusal happens *before* any
  // membership exists to attribute it to (contract §7, D7).
  "share_link.admission_refused",
  "legal.certificate_issued",
  // custom portal domains (E2.1)
  "custom_domain.created",
  "custom_domain.verified",
  "custom_domain.activated",
  "custom_domain.failed",
  "custom_domain.deleted",
  // embed (E2.2)
  "embed.settings_changed",
  "embed.origin_rejected",
  "embed.handoff_accepted",
  "embed.handoff_rejected",
  // branding + module enablement (E1.7)
  "branding.settings_changed",
  "branding.logo_changed",
  "module.enablement_changed",
  // mail delivery feedback + DSAR erasure (E2.6)
  "mail.suppressed",
  "mail.unsuppressed",
  "dsar.erasure_requested",
  "dsar.erasure_step_completed",
  "dsar.erasure_completed",
  "dsar.erasure_cancelled",
  // admin surfaces (E2.7)
  "audit.exported",
  "access.review_exported",
  "access.review_completed",
  // E3.2: the daily reminder found the next review past due (system actor, once per ISO week).
  "access.review_overdue",
  // delegates (E3.2): added = the delegate invitation was issued; removed = revoked or withdrawn
  "membership.delegate_added",
  "membership.delegate_removed",
  // A self-service add answered "sent" that issued nothing (the address is
  // already a member, revoked, or invited); counted in the principal's daily add budget
  "membership.delegate_add_skipped",
  "access.session_revoked",
  "access.sessions_revoked",
  "access.sessions_revoked_all",
  "access.ownership_transferred",
  "access.view_as_started",
  "access.view_as_ended",
  "workspace.deleted",
  "workspace.restored",
  "workspace.purged",
  "compliance.dsar_requested",
  "compliance.dsar_completed",
  "compliance.dsar_exported",
  "compliance.identity_erased",
  "ops.dead_letter_retried",
  "ops.dead_letter_discarded",
  // search, export, i18n (E2.8)
  "workspace.export_requested",
  "workspace.export_completed",
  "workspace.export_failed",
  "workspace.export_downloaded",
  "workspace.export_deleted",
  "workspace.imported",
  "workspace.locale_changed",
  "search.reindex_requested",
  // access requests (E3.1): the public "request access" form and its approval queue. `submitted`,
  // `expired` and an auto-approval are the system's; approve/deny are staff decisions.
  "access_request.submitted",
  "access_request.approved",
  "access_request.denied",
  "access_request.expired",
  // API keys (E3.4). `auto_revoked` is the system's (hourly sweep: creator not live; erasure).
  // Meta never carries the token or its hash.
  "api_key.created",
  "api_key.updated",
  "api_key.rotated",
  "api_key.revoked",
  "api_key.auto_revoked",
  // outbound webhooks (E3.4). `endpoint_disabled` is the system's (410 Gone or 20 consecutive
  // failed deliveries), written once. Meta never carries the URL or a secret.
  "webhook.endpoint_created",
  "webhook.endpoint_updated",
  "webhook.endpoint_deleted",
  "webhook.secret_rotated",
  "webhook.endpoint_disabled",
  "webhook.redelivered",
  "webhook.tested",
  // e-signature (E3.5, ADR-0053). Meta never carries a credential, a callback secret or a
  // signing URL. `envelope_status_changed`, `envelope_completed` and `nda_version_superseded` are
  // the system's (sync/collect jobs); `consent_recorded` is the member's ESIGN consent.
  "esign.connection_saved",
  "esign.connection_verified",
  "esign.connection_deleted",
  "esign.callback_secret_rotated",
  "esign.envelope_requested",
  "esign.envelope_status_changed",
  "esign.envelope_completed",
  "esign.envelope_voided",
  "esign.artifact_downloaded",
  "esign.nda_version_superseded",
  "esign.consent_recorded",
  // accreditation vendor connections (E3.7, ADR-0055). Meta: ids, driver, environment, field
  // keys — never a credential. A rejected vendor callback is a security event, not an audit row.
  "accreditation.connection_saved",
  "accreditation.connection_verified",
  "accreditation.connection_deleted",
  // staff SSO + SCIM (E3.8, ADR-0056). Meta: ids, protocol, domain, role — never a secret, a token,
  // a certificate body or an IdP claim beyond the subject id. SCIM writes carry the system actor
  // `scim:<tokenId>`. A successful SSO sign-in is `auth.login` with `meta.method: "sso"`.
  "sso.connection_saved",
  "sso.connection_deleted",
  "sso.state_changed",
  "sso.test_completed",
  "sso.domain_added",
  "sso.domain_verified",
  "sso.domain_removed",
  "sso.jit_provisioned",
  "scim.token_created",
  "scim.token_revoked",
  "scim.user_created",
  "scim.user_updated",
  "scim.user_suspended",
  "scim.user_reactivated",
  "scim.user_deleted",
  "scim.group_created",
  "scim.group_updated",
  "scim.group_deleted",
  "scim.group_role_mapped",
  // membership suspension (E3.8: SCIM `active:false` and back)
  "membership.suspended",
  "membership.reactivated",
  // integrations hub (E3.6, ADR-0054)
  "integration.connected",
  "integration.disconnected",
  "integration.verified",
  "integration.account_selected",
  "integration.webhook_secret_rotated",
  "integration.health_changed",
  "integration.oauth_failed",
  "integration.booking_link_created",
  "integration.booking_link_updated",
  "integration.booking_link_deleted",
  // managed-host control plane (E3.10, ADR-0058). Operator actions are written to the platform
  // chain (PLATFORM_WORKSPACE_ID) and, where they concern a tenant, to that workspace's chain too
  // (actor_kind `host` + meta.operator = true; the operator's user id on the platform chain only).
  "operator.grant",
  "operator.revoke",
  "operator.session_start",
  "operator.session_end",
  "operator.enrol_link",
  "operator.enrol",
  // (creating a workspace reuses `workspace.created`, below)
  "workspace.suspend",
  "workspace.unsuspend",
  "workspace.hold",
  "workspace.release",
  "workspace.plan_change",
  "workspace.cell_change",
  "workspace.legal_change",
  "platform.workspace.owners_read",
  "plan.create",
  "plan.update",
  "plan.archive",
  "subscription.update",
  "billing.checkout_start",
  "billing.portal_open",
  "sanctions.screen",
  "sanctions.decision",
  "cell.add",
  "cell.update",
  "signup.complete",
  "session.central_handoff",
  // per-tenant data residency (E3.11, ADR-0059): a move between cells, on the platform chain and
  // the workspace's chain like `workspace.cell_change`.
  "workspace.move_request",
  "workspace.move_export",
  "workspace.move_import",
  "workspace.move_switch",
  "workspace.move_retire",
  "workspace.move_cancel",
  "workspace.move_fail",
  // AI assist (E3.12, ADR-0060). `ai.settings_updated` (resource `workspace`, meta: the `ai`
  // block before/after) and `ai.request_started` (resource `ai_request`, meta: feature,
  // subjectId). Never prompt or model text; the `ai.run` job writes no audit row.
  "ai.settings_updated",
  "ai.request_started",
  // workspace
  "workspace.created",
  "workspace.offering_status_changed",
  "workspace.settings_changed",
  // audit itself
  "audit.checkpoint_written",
  "audit.partition_dropped",
  "audit.verification_failed",
  // E3.13: one external anchoring run, on the PLATFORM chain only (resource `audit_anchor_batch`;
  // meta { batchId, leafCount, kinds: [...], failures: [...] }).
  "audit.anchored",
  // host / operator
  // Break-glass (E2.10, `fundroom break-glass`): each is written to the session's workspace chain
  // (tenant-visible) AND the platform chain. `host.break_glass` is the opening.
  "host.break_glass",
  "host.break_glass_notified",
  "host.break_glass_statement",
  "host.break_glass_result",
  "host.break_glass_closed",
] as const;

export type KernelAuditAction = (typeof KERNEL_AUDIT_ACTIONS)[number];
/** Kernel actions get completion; modules pass any `resource.verb` string. */
export type AuditAction = KernelAuditAction | (string & {});

export const KERNEL_RESOURCE_KINDS = [
  "user",
  "session",
  "device",
  "credential",
  "membership",
  "invite",
  "group",
  "workspace",
  "legal_document",
  "audit",
  "document",
  "folder",
  "post",
  "grant",
  "policy",
  "invite_import",
  "page",
  "blob",
  "upload",
  "sending_domain",
  "view_session",
  "notification",
  "notification_preference",
  "reply",
  "module",
  "custom_domain",
  "share_link",
  "certificate",
  "mail_suppression",
  "dsar_request",
  // E2.7
  "access_review",
  "job",
  // E2.8
  "workspace_export",
  "workspace_import",
  "search_index",
  // E2.10
  "break_glass_session",
  // E3.1
  "access_request",
  // E3.4
  "api_key",
  "webhook_endpoint",
  "webhook_delivery",
  // E3.5
  "esign_connection",
  "esign_envelope",
  // E3.6
  "integration_connection",
  "booking_link",
  "integration_booking",
  // E3.7
  "accreditation_connection",
  // E3.8
  "sso_connection",
  "sso_domain",
  "scim_token",
  "scim_user",
  "scim_group",
  // E3.10
  "platform_operator",
  "plan",
  "subscription",
  "sanctions_screening",
  "cell",
  // E3.12
  "ai_request",
  // E3.13
  "audit_anchor_batch",
] as const;
export type AuditResourceKind = (typeof KERNEL_RESOURCE_KINDS)[number] | (string & {});
