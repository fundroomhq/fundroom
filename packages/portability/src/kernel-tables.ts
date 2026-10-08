import { randomBytes } from "node:crypto";
import type { PortableTable } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { hexBytea } from "./format.js";

/*
 * The kernel's portability decisions (E2.8): one entry for EVERY tenant-scoped `core.*` /
 * `audit.*` table, in FK dependency order. `portability.integration.test.ts` compares this list
 * with the catalog, so a new kernel table without a decision fails CI.
 *
 * Beyond `PortableTable` (what modules get) the kernel may:
 *  - `special`: a table whose rows need kernel knowledge the generic engine does not have —
 *    the workspace row itself, a membership's global identity, a click-wrap certificate, the
 *    suppression list's keyed hashes;
 *  - `orderBy`: a row order other than the primary key (delegates after their principals, so a
 *    CHECK that ties `role = 'delegate'` to `principal_membership_id` never sees a deferred null);
 *  - `verbatimColumns`: columns kept byte-for-byte, outside the generic id remap, because a hash
 *    elsewhere in the row binds them (an access review's `report` ↔ `report_sha256`).
 */

export type KernelSpecial = "workspace" | "membership" | "attestation" | "mail_suppression";

export interface KernelTable extends PortableTable {
  readonly schema: "core" | "audit";
  /** One line: what happens to this table and why (README + `fundroom workspace import` output). */
  readonly note: string;
  readonly special?: KernelSpecial | undefined;
  /** SQL over alias `t`; default: the primary key. */
  readonly orderBy?: string | undefined;
  readonly verbatimColumns?: readonly string[] | undefined;
}

const randomTokenHash = (): string => hexBytea(randomBytes(32).toString("hex"));

function without(row: JsonObject, ...columns: string[]): JsonObject {
  const out: JsonObject = { ...row };
  for (const c of columns) delete out[c];
  return out;
}

export const KERNEL_TABLES: readonly KernelTable[] = [
  {
    schema: "core",
    table: "workspace",
    mode: "rows",
    special: "workspace",
    note: "Name, settings (branding logo carried as a blob), offering status and default locale; the importer supplies the slug. Instance-local columns (KMS key ref, data region, ACL version, deletion state) are not carried.",
  },
  {
    schema: "core",
    table: "membership",
    mode: "rows",
    special: "membership",
    orderBy: "(t.role = 'delegate'), t.id",
    note: "Carried with the member's email and display name instead of the global user id; the importer matches an existing user by email or creates one. Sessions, credentials, passkeys and MFA never leave the source.",
  },
  { schema: "core", table: "group", mode: "rows", note: "Carried." },
  { schema: "core", table: "group_member", mode: "rows", note: "Carried." },
  {
    schema: "core",
    table: "invite",
    mode: "rows",
    note: "Carried without the token hash: a pending invitation keeps its status, but its link is dead until an admin resends it. Stored grant paths are stripped; acceptance re-derives them.",
    exportRow: (row) => without(row, "token_hash"),
    importRow: (row) => ({ ...row, token_hash: randomTokenHash() }),
  },
  {
    schema: "core",
    table: "access_request",
    mode: "rows",
    omitColumns: ["client_ip_hash"],
    note: "Carried without client_ip_hash (a keyed hash under a key that stays with the source). invite_id ↔ invite.access_request_id is a cycle the engine defers.",
  },
  {
    schema: "core",
    table: "access_request_challenge",
    mode: "skip",
    reason: "secret",
    note: "Not carried: an emailed code (keyed hash under the source's key ring) that lives ten minutes; a requester mid-verification simply submits the form again.",
  },
  {
    schema: "core",
    table: "invite_import",
    mode: "rows",
    note: "Carried as history; a batch still queued or running at export time is marked failed (its job does not travel).",
    importRow: (row, ctx) =>
      row["status"] === "queued" || row["status"] === "running"
        ? {
            ...row,
            status: "failed",
            finished_at: ctx.now.toISOString(),
            last_error: "interrupted: the workspace was exported while this import was running",
          }
        : row,
  },
  { schema: "core", table: "offering_period", mode: "rows", note: "Carried." },
  { schema: "core", table: "legal_document", mode: "rows", note: "Carried." },
  {
    schema: "core",
    table: "legal_document_version",
    mode: "rows",
    note: "Carried verbatim (body_sha256 still matches).",
  },
  {
    schema: "core",
    table: "attestation",
    mode: "rows",
    special: "attestation",
    note: "Carried; a click-wrap certificate (JSON + PDF) travels as two blobs and is re-sealed under the new workspace key.",
  },
  {
    schema: "core",
    table: "consent_event",
    mode: "rows",
    omitColumns: ["ip_hash"],
    note: "Carried without ip_hash (an HMAC under a key that stays with the source).",
  },
  {
    schema: "core",
    table: "access_grant",
    mode: "rows",
    note: "Carried; resource paths are remapped to the new folder ids, then re-derived from the imported folders.",
    importRow: (row, ctx) =>
      typeof row["resource_path"] === "string"
        ? { ...row, resource_path: ctx.remapLtree(row["resource_path"]) }
        : row,
  },
  {
    schema: "core",
    table: "access_policy",
    mode: "rows",
    note: "Carried; resource paths are remapped to the new folder ids, then re-derived from the imported folders.",
    importRow: (row, ctx) =>
      typeof row["resource_path"] === "string"
        ? { ...row, resource_path: ctx.remapLtree(row["resource_path"]) }
        : row,
  },
  {
    schema: "core",
    table: "access_review",
    mode: "rows",
    verbatimColumns: ["report"],
    note: "Carried; the report is kept verbatim (source ids) because report_sha256 binds it.",
  },
  {
    schema: "core",
    table: "dsar_request",
    mode: "rows",
    note: "Carried (open requests stay open).",
  },
  { schema: "core", table: "dsar_step", mode: "rows", note: "Carried." },
  {
    schema: "core",
    table: "share_link",
    mode: "rows",
    note: "Carried as history and REVOKED: the token and the passcode are secrets (the passcode an HMAC under the source's key ring); mint new links.",
    exportRow: (row) => without(row, "token_hash", "passcode_hash"),
    importRow: (row, ctx) => ({
      ...row,
      token_hash: randomTokenHash(),
      passcode_hash: null,
      passcode_attempts: 0,
      passcode_locked_until: null,
      status: "revoked",
      revoked_at: row["revoked_at"] ?? ctx.now.toISOString(),
    }),
  },
  { schema: "core", table: "share_link_visit", mode: "rows", note: "Carried." },
  { schema: "core", table: "share_link_view", mode: "rows", note: "Carried." },
  { schema: "core", table: "module_enablement", mode: "rows", note: "Carried." },
  {
    schema: "core",
    table: "booking_link",
    mode: "rows",
    note: "Carried (a booking link is just a URL; audience group ids are remapped). Recording bookings needs a booking connection, which does not travel.",
  },
  {
    schema: "core",
    table: "mail_suppression",
    mode: "rows",
    special: "mail_suppression",
    note: "Keyed hashes cannot move: the export recovers the plaintext of every suppressed address the workspace knows (member and invitation emails) and the import re-hashes it under the new key. Entries for any other address are dropped (counted in the manifest).",
  },
  // --- not carried ------------------------------------------------------------------------------
  {
    schema: "core",
    table: "effective_access",
    mode: "skip",
    reason: "derived",
    note: "Rebuilt from grants and policies during the import.",
  },
  {
    schema: "core",
    table: "effective_access_state",
    mode: "skip",
    reason: "derived",
    note: "Rebuilt with effective_access.",
  },
  {
    schema: "core",
    table: "custom_domain",
    mode: "skip",
    reason: "instance-local",
    note: "A hostname's DNS points at the source instance and its claim is unique there; re-add and re-verify the domain after import.",
  },
  {
    schema: "core",
    table: "workspace_key",
    mode: "skip",
    reason: "secret",
    note: "Data keys never leave the instance; the import mints new ones and re-encrypts every object.",
  },
  {
    schema: "core",
    table: "mail_message",
    mode: "skip",
    reason: "instance-local",
    note: "Provider message ids of mail sent from the source; delivery webhooks keep arriving there.",
  },
  {
    schema: "core",
    table: "outbox",
    mode: "skip",
    reason: "transient",
    note: "Undelivered events belong to the source's workers.",
  },
  {
    schema: "core",
    table: "idempotency_key",
    mode: "skip",
    reason: "transient",
    note: "Request replay protection, minutes long.",
  },
  {
    schema: "core",
    table: "auth_challenge",
    mode: "skip",
    reason: "transient",
    note: "Pending sign-in codes and links.",
  },
  {
    schema: "core",
    table: "search_entry",
    mode: "skip",
    reason: "derived",
    note: "Reindexed after the import.",
  },
  {
    schema: "core",
    table: "search_state",
    mode: "skip",
    reason: "derived",
    note: "Reindexed after the import.",
  },
  {
    schema: "core",
    table: "workspace_export",
    mode: "skip",
    reason: "instance-local",
    note: "The source's own export history.",
  },
  {
    schema: "core",
    table: "workspace_import",
    mode: "skip",
    reason: "instance-local",
    note: "The source's own import history.",
  },
  {
    schema: "core",
    table: "break_glass_session",
    mode: "skip",
    reason: "instance-local",
    note: "The source instance's operator break-glass sessions; the audit events that record them travel in audit/events.jsonl.",
  },
  {
    schema: "core",
    table: "api_key",
    mode: "skip",
    reason: "secret",
    note: "Not carried: a key is a credential (its hash authenticates requests) bound to its creator's membership here; admins mint new keys on the target and update their integrations.",
  },
  {
    schema: "core",
    table: "webhook_endpoint",
    mode: "skip",
    reason: "secret",
    note: "Not carried: the URL and signing secret are sealed under the source's `webhook-secret` workspace key; admins re-add endpoints on the target (receivers get a new secret).",
  },
  {
    schema: "core",
    table: "webhook_delivery",
    mode: "skip",
    reason: "transient",
    note: "Not carried: the delivery queue and 30-day log of the source's endpoints, which do not travel.",
  },
  {
    schema: "core",
    table: "esign_connection",
    mode: "skip",
    reason: "secret",
    note: "Not carried: the vendor credentials and callback secret are sealed under the source's `esign-credentials` workspace key; admins reconnect the e-sign vendor on the target.",
  },
  {
    schema: "core",
    table: "esign_envelope",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: envelopes are bound to the source's vendor connection and callback URL; the signed copies travel as vaulted data-room documents.",
  },
  {
    schema: "core",
    table: "accreditation_connection",
    mode: "skip",
    reason: "secret",
    note: "Not carried: the vendor credentials are sealed under the source's `accreditation-credentials` workspace key and the callback URL names this install; admins reconnect the accreditation vendor on the target.",
  },
  {
    schema: "core",
    table: "integration_connection",
    mode: "skip",
    reason: "secret",
    note: "Not carried: vendor tokens, keys and webhook signing secrets are sealed under the source's `integration-credentials` workspace key; admins reconnect integrations on the target.",
  },
  {
    schema: "core",
    table: "integration_oauth_state",
    mode: "skip",
    reason: "secret",
    note: "Not carried: in-flight OAuth handshakes (ten minutes, single use) bound to the source's host and browser.",
  },
  {
    schema: "core",
    table: "integration_booking",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: recorded bookings are bound to the source's booking connection and its webhook URL (they age out after 400 days).",
  },
  {
    schema: "core",
    table: "integration_booking_suppression",
    mode: "skip",
    reason: "secret",
    note: "Not carried: keyed hashes of erased people's addresses, under the source workspace's key (meaningless without it).",
  },
  {
    schema: "core",
    table: "sso_connection",
    mode: "skip",
    reason: "secret",
    note: "Not carried: the OIDC client secret is sealed under the source's `sso-credentials` workspace key and the IdP registration names this install's redirect/ACS URLs; admins reconnect SSO on the target.",
  },
  {
    schema: "core",
    table: "sso_domain",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: domain proofs are per install (a domain is verified by one workspace per install); admins re-verify their domains on the target.",
  },
  {
    schema: "core",
    table: "sso_assertion_replay",
    mode: "skip",
    reason: "transient",
    note: "Not carried: SAML assertion ids seen by the source's connection, minutes long.",
  },
  {
    schema: "core",
    table: "scim_token",
    mode: "skip",
    reason: "secret",
    note: "Not carried: a SCIM token is a credential (its hash authenticates the IdP); admins mint a new one on the target and update the IdP.",
  },
  {
    schema: "core",
    table: "scim_user",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: the IdP's provisioning projection is re-established by the IdP's next sync against the target; memberships themselves travel.",
  },
  {
    schema: "core",
    table: "scim_group",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: IdP groups are re-pushed by the IdP's next sync; admins re-map groups to roles on the target.",
  },
  {
    schema: "core",
    table: "scim_group_member",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: follows scim_group and scim_user.",
  },
  {
    schema: "core",
    table: "subscription",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: the host's billing record (provider customer and subscription ids belong to the source install's billing account); the target host assigns a plan.",
  },
  {
    schema: "core",
    table: "billing_event",
    mode: "skip",
    reason: "transient",
    note: "Not carried: provider webhook ids kept for dedupe, 90 days.",
  },
  {
    schema: "core",
    table: "tenant_usage_daily",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: metering rollups of the source install; the target's rollup job starts its own series.",
  },
  {
    schema: "core",
    table: "sanctions_screening",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: the host operator's screening record about the tenant (never tenant data); the target host screens on its own terms.",
  },
  {
    schema: "core",
    table: "ai_request",
    mode: "skip",
    reason: "transient",
    note: "Not carried: AI suggestions awaiting a staff member's review, deleted after AI_RESULT_RETENTION_HOURS; what staff applied lives in the product's own tables. The workspace's `settings.ai` block travels with the workspace (its acknowledgement binds to the source's provider identity — id, hosting, label, model, location and jurisdiction — so it stays valid on the target only when the target runs exactly that provider; any difference turns AI off there until an ai.manage holder acknowledges again).",
  },
  {
    schema: "core",
    table: "ai_usage_monthly",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: the source install's AI token metering; the target's budget starts its own series.",
  },
  {
    schema: "core",
    table: "authz_engine_state",
    mode: "skip",
    reason: "instance-local",
    note: "Not carried: which store/model this install's external authz engine holds; the target re-syncs from the imported rules.",
  },
  {
    schema: "audit",
    table: "event",
    mode: "skip",
    reason: "instance-local",
    note: "Carried as evidence in audit/events.jsonl, not re-inserted (new ids would change every hash); archived with the import, and the new chain starts with workspace.imported.",
  },
  {
    schema: "audit",
    table: "checkpoint",
    mode: "skip",
    reason: "instance-local",
    note: "Carried in audit/checkpoints.json with the events.",
  },
  {
    schema: "audit",
    table: "anchor",
    mode: "skip",
    reason: "instance-local",
    note: "External anchors of source checkpoints (Merkle inclusion proofs into the source's global anchor batches); they stay with the source.",
  },
  {
    schema: "audit",
    table: "chain_head",
    mode: "skip",
    reason: "derived",
    note: "The new workspace's chain head.",
  },
];

/** `core.workspace` columns the export carries. */
export const WORKSPACE_COLUMNS = [
  "id",
  "slug",
  "name",
  "offering_status",
  "settings",
  "settings_schema_version",
  "default_locale",
  "created_at",
] as const;
