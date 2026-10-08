import { csvField } from "@fundroom/compliance";
import {
  ApiError,
  accessAdmin as aa,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import {
  type AccessReviewReport,
  type AdminActor,
  createAccessReviewService,
  createAdminSessionService,
  isAuthError,
} from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requirePermission } from "../middleware/authz.js";
import { requireFeature } from "../middleware/entitlements.js";
import { softDeleteWorkspace, WorkspaceLifecycleError } from "../workspace/lifecycle.js";
import type { ApiDeps } from "./deps.js";

/*
 * Access administration (E2.7 package B1): the access review report and its completions, a
 * member's sessions (list, revoke one, revoke all), ownership transfer, revoke-all-sessions and
 * workspace deletion (authz-matrix.yaml "access review, sessions admin, ownership and the danger
 * zone"). Contracts live in `@fundroom/contracts` `access-admin.ts`.
 *
 * Every danger-zone route demands step-up (`+fresh`) *and* the workspace slug typed back as
 * `confirm`; a mismatch is `validation_failed` with `reason: "confirmation_mismatch"`, checked
 * before anything is read or written.
 *
 * Sessions are global rows; only those whose `last_workspace_id` is this workspace are listed
 * or revocable here (see `@fundroom/identity` `createAdminSessionService`). An unknown session
 * and another workspace's session answer the same 404. Revoking one ends the sign-in itself, so
 * its holder is signed out of every workspace it served — kept deliberately and documented on
 * each route (E2.7 review R1#5).
 *
 * Plan entitlements (A-3, ADR-0063): completing a review needs the plan's `access_reviews`
 * feature (402 `plan_limit`, after the permission guard) — every completion is the feature itself.
 * The live report, past reviews and their stored evidence stay readable after a downgrade.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);
const TAGS = ["access"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function rethrow(error: unknown): never {
  if (isAuthError(error)) throw new ApiError(error.code as never, error.message, error.details);
  throw error;
}

function assertConfirmed(s: Signed, confirm: string): void {
  if (confirm !== s.workspace.slug)
    throw new ApiError("validation_failed", "type the workspace slug to confirm", {
      reason: "confirmation_mismatch",
    });
}

export const ACCESS_REVIEW_CSV_COLUMNS = [
  "membership_id",
  "name",
  "email",
  "kind",
  "role",
  "status",
  "groups",
  "grant_count",
  "last_active_at",
  "expires_at",
  "active_sessions",
  "nda_kind",
  "nda_signed_at",
  "accredited_signed_at",
  "accredited_expires_at",
  "gate_max_age_days",
  "gate_lapses_at",
  "accreditation_diverges",
  "pending_gates",
  "flags",
] as const;

/**
 * RFC 4180, CRLF, UTF-8 BOM, every field through `csvField` (the formula-injection guard: a
 * cell beginning `=`, `+`, `-`, `@`, tab or CR gets an apostrophe). Names, emails and group
 * names are tenant- and member-controlled text. Multi-valued cells are joined with `; `.
 */
export function accessReviewCsv(report: Pick<AccessReviewReport, "members">): string {
  const lines = [ACCESS_REVIEW_CSV_COLUMNS.join(",")];
  for (const r of report.members) {
    lines.push(
      [
        r.membershipId,
        r.name ?? "",
        r.email ?? "",
        r.kind,
        r.role,
        r.status,
        r.groups.join("; "),
        String(r.grantCount),
        r.lastActiveAt ?? "",
        r.expiresAt ?? "",
        String(r.activeSessions),
        r.nda?.kind ?? "",
        r.nda?.signedAt ?? "",
        r.accreditation?.signedAt ?? "",
        r.accreditation?.expiresAt ?? "",
        r.accreditation?.gateMaxAgeDays?.toString() ?? "",
        r.accreditation?.gateLapsesAt ?? "",
        r.accreditation === null ? "" : String(r.accreditation.diverges),
        r.pendingGates.join("; "),
        r.flags.join("; "),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

const iso = (d: Date) => d.toISOString();

export function registerAccessAdminRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  _gate: AcceptanceGate,
): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });
  // Built on use, never at registration: `deps` is a throwing stub during OpenAPI generation.
  const reviews = () => createAccessReviewService(deps.identityDeps);
  const sessions = () => createAdminSessionService(deps.identityDeps);
  const actorOf = (s: Signed): AdminActor => ({
    membershipId: s.membership.id,
    userId: s.session.userId,
    role: s.membership.role,
    sessionId: s.session.sessionId,
    canManageStaff: deps.authz.hasPermission(s.membership, "access.manage_staff"),
  });

  // --- access review -------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/review",
      tags: TAGS,
      summary: "The access review report: every member, their access facts and review flags",
      description:
        "One row per non-revoked membership (bounded at 5000 rows; `summary.truncated` says when the bound bit): groups, direct grant count, last activity here (the later of `membership.last_seen_at` and this workspace's sessions), live sessions, the latest NDA and accreditation attestations, and the attestation-bound gates still pending in `effective_access`. Flags: `stale` (active, no activity for 90 days), `never_active`, `expiring` (membership expires within 14 days or already has), `accreditation_lapsed` (past its own `expires_at` or past the strictest applicable `accredited` gate's `maxAgeDays` window), `accreditation_diverges` (that window and `expires_at` disagree by more than a day — reported rather than changing behaviour) and `pending_gates`. `format=csv` downloads the same rows (formula-injection guarded) and is audited as `access.review_exported`. `reportSha256` is the digest of the report's evidence form (`{schemaVersion, generatedAt, members, summary}`, canonical JSON, `lastActiveAt` to the day); completing the review with it attests to this exact report. `Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { query: aa.AccessReviewQuery },
      responses: {
        200: {
          description: "The report",
          content: {
            "application/json": { schema: aa.AccessReviewReportSchema },
            "text/csv": { schema: z.string() },
          },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const report = await reviews().report(s.tenant);
      const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
      if (c.req.valid("query").format !== "csv") return c.json(report, 200, headers);
      const csv = accessReviewCsv(report);
      await deps.db.withTenant(s.tenant, (tx) =>
        deps.audit.record(tx, s.tenant, {
          action: "access.review_exported",
          resourceKind: "access_review",
          requestId: requestIdOf(c),
          meta: {
            format: "csv",
            rows: report.summary.members,
            flagged: report.summary.flagged,
            sha256: report.reportSha256,
          },
        }),
      );
      const stamp = report.generatedAt.slice(0, 10);
      return c.body(csv, 200, {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="access-review-${s.workspace.slug}-${stamp}.csv"`,
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/reviews",
      tags: TAGS,
      summary: "Completed access reviews, newest first (latest 20)",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      responses: { 200: jsonResponse(aa.AccessReviewListSchema, "Reviews"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      return c.json({ items: await reviews().list(s.tenant, 20) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/reviews",
      tags: TAGS,
      summary: "Mark the access review complete",
      description:
        'Recomputes the report, stores it (its evidence form: `{schemaVersion, generatedAt, members, summary}`, `lastActiveAt` to the day) with the sha256 of its canonical JSON (keys sorted at every depth) in the append-only `core.access_review`, and audits `access.review_completed`. The next review is due 90 days later.\n\nTo attest to the report the reviewer was shown, send its `reportSha256` and `generatedAt` (the web always does): the report is rebuilt *as of that `generatedAt`* (flags and live-session counts against that instant) and, if its digest differs — somebody\'s access changed in between — the answer is 409 `conflict` with `reason: "report_changed"`; reload the report and review again. A `generatedAt` more than a day old is `report_changed` too. Without them the report is built as of now.',
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true), requireFeature(deps, "access_reviews")] as const,
      request: { body: jsonBody(aa.CompleteReviewBody) },
      responses: { 201: jsonResponse(aa.AccessReviewRecordSchema, "Recorded"), ...GATED_ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      try {
        const { record } = await reviews().complete(s.tenant, {
          reviewerMembershipId: s.membership.id,
          note: body.note,
          requestId: requestIdOf(c),
          attest:
            body.reportSha256 === undefined || body.generatedAt === undefined
              ? undefined
              : { reportSha256: body.reportSha256, generatedAt: body.generatedAt },
        });
        return c.json(record, 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/reviews/{id}/report",
      tags: TAGS,
      summary: "Download the report a completed review attested to (evidence)",
      description:
        "The stored evidence of one completed review as a JSON attachment: exactly the canonical JSON whose sha256 is the review's `reportSha256` (also sent as `X-Content-SHA256`), so `sha256sum` of the file matches the record. Another workspace's review answers 404.",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: aa.ReviewParams },
      responses: {
        200: {
          description: "The stored report",
          content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const stored = await reviews().storedReport(s.tenant, c.req.valid("param").id);
        const stamp = stored.completedAt.slice(0, 10);
        return c.body(stored.body, 200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="access-review-${s.workspace.slug}-${stamp}-${stored.id.slice(0, 8)}.json"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Content-SHA256": stored.reportSha256,
        }) as never;
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- member sessions -----------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/people/{id}/sessions",
      tags: TAGS,
      summary: "A member's live sessions in this workspace",
      description:
        "Only sessions whose last workspace is this one: a session the same person is using in another workspace is that workspace's fact and is not listed.",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: aa.MemberParams },
      responses: { 200: jsonResponse(aa.MemberSessionsSchema, "Sessions"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const rows = await sessions().list(s.tenant, c.req.valid("param").id);
        return c.json(
          {
            sessions: rows.map((r) => ({
              id: r.id,
              deviceName: r.deviceName,
              device: r.device,
              ip: r.ip,
              createdAt: iso(r.createdAt),
              lastSeenAt: iso(r.lastSeenAt),
              authLevel: r.authLevel,
              idleExpiresAt: iso(r.idleExpiresAt),
              absoluteExpiresAt: iso(r.absoluteExpiresAt),
            })),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/people/{id}/sessions/{sessionId}",
      tags: TAGS,
      summary: "Revoke one of a member's sessions",
      description:
        "Staff targets also need `access.manage_staff`; an owner's sessions may be revoked only by an owner. A session that is unknown, not this member's, or last served another workspace answers 404. Audited as `access.session_revoked` (plus `access.view_as_ended` when the session was viewing as an investor). Sessions are global sign-ins, not per workspace: revoking one signs the person out everywhere they were using it, including other workspaces they belong to.",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: aa.MemberSessionParams },
      responses: { 204: { description: "Revoked" }, ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id, sessionId } = c.req.valid("param");
      try {
        await sessions().revoke(s.tenant, id, sessionId, actorOf(s), requestIdOf(c));
      } catch (error) {
        rethrow(error);
      }
      return c.body(null, 204) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/people/{id}/sessions/revoke",
      tags: TAGS,
      summary: "Revoke all of a member's sessions in this workspace",
      description:
        "Same target rules as revoking one. Also burns the member's outstanding sign-in codes and magic links for this workspace. Audited as `access.sessions_revoked`. Sessions are global sign-ins: a person who last used a session here is signed out of every workspace that session served.",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: aa.MemberParams },
      responses: { 200: jsonResponse(aa.RevokedCountSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const revoked = await sessions().revokeAllForMember(
          s.tenant,
          c.req.valid("param").id,
          actorOf(s),
          requestIdOf(c),
        );
        return c.json({ revoked }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- danger zone ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/access/ownership/transfer",
      tags: TAGS,
      summary: "Transfer ownership to another staff member",
      description:
        "Owner only, step-up, and `confirm` must equal the workspace slug. The target must be an active staff member (anything else is 404). The target becomes an owner; the caller becomes an admin unless `keepOwner`. Audited as `access.ownership_transferred` plus one `membership.role_changed` per role that moved.",
      security: sessionSecurity,
      "x-requires": "access.transfer+fresh",
      middleware: [perm("access.transfer", true)] as const,
      request: { body: jsonBody(aa.TransferOwnershipBody) },
      responses: { 200: jsonResponse(OkSchema, "Transferred"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      assertConfirmed(s, body.confirm);
      try {
        await deps.auth.memberships.transferOwnership(
          s.tenant,
          {
            toMembershipId: body.toMembershipId,
            keepOwner: body.keepOwner,
            requestId: requestIdOf(c),
          },
          { membershipId: s.membership.id, userId: s.session.userId, role: s.membership.role },
        );
      } catch (error) {
        rethrow(error);
      }
      deps.authz.invalidate(s.workspace.id);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/sessions/revoke-all",
      tags: TAGS,
      summary: "Sign every external member (and optionally staff) out of this workspace",
      description:
        "Owner only, step-up, `confirm` = workspace slug. Revokes every live session whose last workspace is this one held by an external member, and by staff too when `includeStaff`; the caller's current session always survives. Audited as `access.sessions_revoked_all`. Sessions are global sign-ins: people who belong to other workspaces too are signed out of those as well and sign in again there.",
      security: sessionSecurity,
      "x-requires": "access.transfer+fresh",
      middleware: [perm("access.transfer", true)] as const,
      request: { body: jsonBody(aa.RevokeAllSessionsBody) },
      responses: { 200: jsonResponse(aa.RevokedCountSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      assertConfirmed(s, body.confirm);
      try {
        const revoked = await sessions().revokeWorkspace(
          s.tenant,
          { includeStaff: body.includeStaff, requestId: requestIdOf(c) },
          actorOf(s),
        );
        return c.json({ revoked }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/workspace",
      tags: TAGS,
      summary: "Delete this workspace (soft delete; purged after 30 days)",
      description:
        'Owner only, step-up, `confirm` = workspace slug. Refused with 409 `conflict` and `reason: "legal_hold"` while the workspace is under legal hold, and with `reason: "last_workspace"` on a single-tenant instance when it is the only live workspace (the operator decommissions the instance instead). Sets `deleted_at` and `purge_after` (now + 30 days), audits `workspace.deleted`, revokes every session whose last workspace is this one (global sign-ins: their holders are signed out of any other workspace too), and drops the resolver and custom-domain caches so the portal stops resolving at once. Until `purge_after` an operator can undo it (`fundroom workspace restore`); after it the daily `workspace.purge` job crypto-shreds the workspace\'s data keys.',
      security: sessionSecurity,
      "x-requires": "access.delete_workspace+fresh",
      middleware: [perm("access.delete_workspace", true)] as const,
      request: { body: jsonBody(aa.DeleteWorkspaceBody) },
      responses: { 202: jsonResponse(aa.WorkspaceDeletedSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      assertConfirmed(s, c.req.valid("json").confirm);
      let purgeAfter: Date;
      try {
        ({ purgeAfter } = await softDeleteWorkspace(
          // E3.10: the provider subscription is canceled (outbox job) iff the delete commits.
          {
            db: deps.db,
            audit: deps.audit,
            onDeleted: deps.billing.cancelOnDelete,
            // E3.11 R2-3: the directory entry stops routing (slug still held for the restore).
            directory: deps.directory,
            log: deps.log,
          },
          s.tenant,
          {
            requestId: requestIdOf(c),
            refuseLast: deps.tenancy === "single",
          },
        ));
      } catch (error) {
        if (error instanceof WorkspaceLifecycleError) {
          if (
            error.code === "legal_hold" ||
            error.code === "last_workspace" ||
            error.code === "relocating"
          )
            throw new ApiError("conflict", error.message, { reason: error.code });
          throw new ApiError("not_found", error.message);
        }
        throw error;
      }
      // After the tenant transaction has committed — never inside it (pool-deadlock rule).
      const revoked = await sessions().revokeAllInWorkspace(
        s.workspace.id,
        "workspace_deleted",
        requestIdOf(c),
      );
      deps.resolver.invalidate();
      deps.domainLookup.invalidate();
      deps.authz.invalidate(s.workspace.id);
      deps.log("workspace.deleted", {
        workspaceId: s.workspace.id,
        purgeAfter: purgeAfter.toISOString(),
        sessionsRevoked: revoked,
      });
      return c.json({ purgeAfter: purgeAfter.toISOString() }, 202);
    },
  );
}
