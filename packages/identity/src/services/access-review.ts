import { createHash } from "node:crypto";
import { type Gate, PolicyRepo, PrincipalRepo } from "@fundroom/authz";
import {
  type AccessReview,
  isPlatformWorkspace,
  type MembershipKind,
  type MembershipRole,
  type MembershipStatus,
  systemContext,
  type TenantContext,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { EntitlementsPort, JobDefinition, JsonObject } from "@fundroom/ports";
import { AuthError } from "../errors.js";
import {
  AccessReviewRepo,
  liveWorkspacesForReview,
  type ReviewAttestationRow,
  type ReviewMemberRow,
} from "../repos/access-review-repo.js";
import {
  type WorkspaceSessionActivity,
  workspaceSessionActivity,
} from "../repos/admin-session-repo.js";
import { MembershipRepo } from "../repos/membership-repo.js";
import type { IdentityDeps } from "./types.js";

/*
 * The periodic access review (E2.7 package B1, EXECUTION_PLAN §15 "access review report").
 *
 * One row per non-revoked membership: who they are, what they belong to, how many grants name
 * them directly, when they were last active *here*, what they signed, which attestation-bound
 * gates still hold them back, and a list of flags a reviewer should look at. Completing a review
 * stores the report itself (its evidence form, `accessReviewEvidence`) and the sha256 of its
 * canonical JSON in `core.access_review` (append-only). The reviewer attests to the report they
 * were shown: the web sends back its `reportSha256` and `generatedAt`, the server rebuilds the
 * report as of that instant and refuses (`report_changed`) when it no longer matches, so the
 * stored evidence is exactly what the reviewer saw.
 *
 * Facts are gathered in two transactions, never nested (the pool-deadlock rule): every tenant
 * fact first, then the session facts from the global `core.session` table under `withHost`,
 * restricted to sessions whose `last_workspace_id` is this workspace.
 *
 * **Accreditation divergence (ADR-0041's open question).** The `accredited` gate accepts an
 * attestation for `maxAgeDays` after `signed_at` (packages/authz `pendingGatesAtRebuild`), while
 * the attestation itself carries `expires_at` twelve calendar months after signing. They agree at
 * the default (365 days) to within a leap day and can drift apart once a gate is configured with
 * another window. Rather than changing what the gate reads, the report surfaces the disagreement:
 * `diverges` is true when the gate's lapse and `expires_at` differ by more than a day (or exactly
 * one of them is absent while a gate applies).
 */

/** No activity for this long → `stale`. */
export const ACCESS_REVIEW_STALE_DAYS = 90;
/** Membership expiry within this many days (or already past) → `expiring`. */
export const ACCESS_REVIEW_EXPIRING_DAYS = 14;
/** The next review is due this many days after the last completed one. */
export const ACCESS_REVIEW_INTERVAL_DAYS = 90;
/** Server-side bound on the rows one report carries; `summary.truncated` says when it bit. */
export const ACCESS_REVIEW_MAX_MEMBERS = 5000;
/** How far the gate's lapse and `attestation.expires_at` may differ before they "diverge". */
export const ACCREDITATION_DIVERGENCE_TOLERANCE_MS = 24 * 3600_000;
/** `pendingGatesAtRebuild`'s default for an `accredited` gate without `maxAgeDays`. */
const DEFAULT_ACCREDITED_MAX_AGE_DAYS = 365;
const DAY_MS = 24 * 3600_000;

export type AccessReviewFlag =
  | "stale"
  | "never_active"
  | "expiring"
  | "accreditation_lapsed"
  | "accreditation_diverges"
  | "pending_gates";

export interface AccessReviewRow {
  readonly membershipId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly kind: MembershipKind;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly groups: string[];
  readonly grantCount: number;
  readonly lastActiveAt: string | null;
  readonly expiresAt: string | null;
  readonly activeSessions: number;
  readonly nda: { kind: string; signedAt: string } | null;
  readonly accreditation: {
    signedAt: string;
    expiresAt: string | null;
    gateMaxAgeDays: number | null;
    gateLapsesAt: string | null;
    diverges: boolean;
  } | null;
  readonly pendingGates: string[];
  readonly flags: AccessReviewFlag[];
}

export interface AccessReviewSummary {
  readonly members: number;
  readonly flagged: number;
  readonly byFlag: Record<string, number>;
  readonly truncated: boolean;
}

export interface AccessReviewRecord {
  readonly id: string;
  readonly reviewerMembershipId: string;
  readonly reviewerName: string | null;
  readonly completedAt: string;
  readonly memberCount: number;
  readonly flaggedCount: number;
  readonly note: string | null;
  readonly reportSha256: string;
}

export interface AccessReviewReport {
  readonly generatedAt: string;
  readonly members: AccessReviewRow[];
  readonly summary: AccessReviewSummary;
  readonly lastReview: AccessReviewRecord | null;
  /**
   * `accessReviewDueAt`: the last completed review + 90 days or, never reviewed, the workspace's
   * creation + 90 days — the same instant the `access-review.overdue` job reminds at.
   */
  readonly nextReviewDueAt: string;
  /** `reportSha256` of this report: what a reviewer sends back to attest to it. */
  readonly reportSha256: string;
}

/** Everything the pure builder needs; gathered by the service, fabricated by unit tests. */
export interface AccessReviewFacts {
  readonly members: readonly ReviewMemberRow[];
  readonly truncated: boolean;
  readonly groups: ReadonlyMap<string, readonly { id: string; name: string }[]>;
  readonly grantCounts: ReadonlyMap<string, number>;
  readonly attestations: readonly ReviewAttestationRow[];
  readonly pending: readonly { membershipId: string; gates: unknown }[];
  /** Live gates (`PolicyRepo.listLiveGates`). */
  readonly gates: readonly Gate[];
  /** Live share-link bindings per membership (`Principal.linkIds`). */
  readonly linkIds: ReadonlyMap<string, readonly string[]>;
  /** Keyed by user id. */
  readonly sessions: ReadonlyMap<string, WorkspaceSessionActivity>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function isErasedIdentifier(v: string): boolean {
  return v.startsWith("erased+") && v.endsWith("@erased.invalid");
}

/** Mirrors `num(g.config["maxAgeDays"], 365)` in packages/authz evaluate.ts. */
export function accreditedMaxAgeDays(gate: Gate): number {
  const v = gate.config["maxAgeDays"];
  return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_ACCREDITED_MAX_AGE_DAYS;
}

/**
 * Whether a gate can bind this member. Workspace gates bind everybody; group, membership and
 * link gates bind whom they name; resource gates bind whoever reaches the resource, so they are
 * counted for everyone — the report errs towards showing the stricter window.
 */
function gateApplies(
  gate: Gate,
  membershipId: string,
  groupIds: ReadonlySet<string>,
  linkIds: readonly string[],
): boolean {
  switch (gate.target.kind) {
    case "workspace":
    case "resource":
      return true;
    case "group":
      return groupIds.has(gate.target.id);
    case "membership":
      return gate.target.id === membershipId;
    case "link":
      return linkIds.includes(gate.target.id);
    default:
      return false;
  }
}

/** Attestation-bound pending gates only; session-bound ones are settled per request. */
function pendingGateLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g !== "object" || g === null) continue;
    const kind = (g as { kind?: unknown }).kind;
    if (kind === "accredited") out.push("accredited");
    else if (kind === "nda") {
      const stamp = (g as { detail?: { stamp?: unknown } }).detail?.stamp;
      out.push(typeof stamp === "string" && stamp.length > 0 ? stamp : "nda");
    }
  }
  return out;
}

export function buildAccessReviewRows(facts: AccessReviewFacts, now: Date): AccessReviewRow[] {
  const t = now.getTime();
  const accreditedGates = facts.gates.filter((g) => g.kind === "accredited");
  const attsBy = new Map<string, ReviewAttestationRow[]>();
  for (const a of facts.attestations)
    attsBy.set(a.membershipId, [...(attsBy.get(a.membershipId) ?? []), a]);
  const pendingBy = new Map<string, Set<string>>();
  for (const p of facts.pending) {
    const set = pendingBy.get(p.membershipId) ?? new Set<string>();
    for (const label of pendingGateLabels(p.gates)) set.add(label);
    pendingBy.set(p.membershipId, set);
  }

  return facts.members.map((m): AccessReviewRow => {
    const groups = facts.groups.get(m.membershipId) ?? [];
    const sessions = facts.sessions.get(m.userId);
    const lastActive = [m.lastSeenAt, sessions?.lastSeenAt ?? null]
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null);

    // Newest first (the repo orders by signed_at DESC).
    const atts = attsBy.get(m.membershipId) ?? [];
    const nda = atts.find((a) => a.kind.startsWith("nda:"));
    const accredited = atts.find((a) => a.kind === "accredited");

    let accreditation: AccessReviewRow["accreditation"] = null;
    if (accredited !== undefined) {
      const groupIds = new Set(groups.map((g) => g.id));
      const links = facts.linkIds.get(m.membershipId) ?? [];
      const windows = accreditedGates
        .filter((g) => gateApplies(g, m.membershipId, groupIds, links))
        .map(accreditedMaxAgeDays);
      const gateMaxAgeDays = windows.length === 0 ? null : Math.min(...windows);
      const lapses =
        gateMaxAgeDays === null
          ? null
          : new Date(accredited.signedAt.getTime() + gateMaxAgeDays * DAY_MS);
      const diverges =
        lapses !== null &&
        (accredited.expiresAt === null ||
          Math.abs(accredited.expiresAt.getTime() - lapses.getTime()) >
            ACCREDITATION_DIVERGENCE_TOLERANCE_MS);
      accreditation = {
        signedAt: accredited.signedAt.toISOString(),
        expiresAt: iso(accredited.expiresAt),
        gateMaxAgeDays,
        gateLapsesAt: iso(lapses),
        diverges,
      };
    }

    const pendingGates = [...(pendingBy.get(m.membershipId) ?? [])].sort();
    const flags: AccessReviewFlag[] = [];
    if (lastActive === null) flags.push("never_active");
    else if (m.status === "active" && t - lastActive.getTime() > ACCESS_REVIEW_STALE_DAYS * DAY_MS)
      flags.push("stale");
    if (m.expiresAt !== null && m.expiresAt.getTime() - t <= ACCESS_REVIEW_EXPIRING_DAYS * DAY_MS)
      flags.push("expiring");
    if (accreditation !== null) {
      const expired =
        accredited?.expiresAt != null && accredited.expiresAt.getTime() <= t
          ? true
          : accreditation.gateLapsesAt !== null && Date.parse(accreditation.gateLapsesAt) <= t;
      if (expired) flags.push("accreditation_lapsed");
      if (accreditation.diverges) flags.push("accreditation_diverges");
    }
    if (pendingGates.length > 0) flags.push("pending_gates");

    return {
      membershipId: m.membershipId,
      name: m.userErased || m.name.length === 0 ? null : m.name,
      email: m.userErased || m.email === null || isErasedIdentifier(m.email) ? null : m.email,
      kind: m.kind,
      role: m.role,
      status: m.status,
      groups: groups.map((g) => g.name),
      grantCount: facts.grantCounts.get(m.membershipId) ?? 0,
      lastActiveAt: iso(lastActive),
      expiresAt: iso(m.expiresAt),
      activeSessions: sessions?.liveSessions ?? 0,
      nda: nda === undefined ? null : { kind: nda.kind, signedAt: nda.signedAt.toISOString() },
      accreditation,
      pendingGates,
      flags,
    };
  });
}

export function summarize(rows: readonly AccessReviewRow[], truncated: boolean) {
  const byFlag: Record<string, number> = {};
  for (const r of rows) for (const f of r.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
  return {
    members: rows.length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
    byFlag,
    truncated,
  } satisfies AccessReviewSummary;
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Version of the evidence shape below; stored as `core.access_review.report_schema_version`. */
export const ACCESS_REVIEW_REPORT_SCHEMA_VERSION = 1;
/** How old the report a reviewer attests to may be (`POST /access/reviews` `generatedAt`). */
export const ACCESS_REVIEW_ATTEST_MAX_AGE_MS = 24 * 3600_000;

/** The evidence form of a report: what is hashed, stored and downloadable. */
export interface AccessReviewEvidence {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly members: AccessReviewRow[];
  readonly summary: AccessReviewSummary;
}

/** Midnight UTC of an ISO timestamp (`null` stays `null`). */
function toDay(v: string | null): string | null {
  return v === null ? null : `${v.slice(0, 10)}T00:00:00.000Z`;
}

/**
 * The evidence a completed review stores and hashes: `{ schemaVersion, generatedAt, members,
 * summary }` — the report without the review history around it (`lastReview`,
 * `nextReviewDueAt`, `reportSha256`).
 *
 * It has to be reproducible: the reviewer attests to the report they were shown by sending its
 * `reportSha256` (and its `generatedAt`) back, and the server rebuilds the report *as of that
 * `generatedAt`* and compares. Everything time-relative is computed against `generatedAt`, not
 * the wall clock (flags, live-session counts as of that instant). The one input that moves
 * without anybody changing access is activity: sessions touch `last_seen_at` every few minutes,
 * the reviewer's own included. So the evidence records `lastActiveAt` **to the day** (midnight
 * UTC); the full timestamp stays in the on-screen report. A member who becomes active for the
 * first time in days between the two calls — or the date rolling over — does change the
 * evidence, and the reviewer is asked to look again (`report_changed`).
 */
export function accessReviewEvidence(
  report: Pick<AccessReviewReport, "generatedAt" | "members" | "summary">,
): AccessReviewEvidence {
  return {
    schemaVersion: ACCESS_REVIEW_REPORT_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    members: report.members.map((r) => ({ ...r, lastActiveAt: toDay(r.lastActiveAt) })),
    summary: report.summary,
  };
}

/** sha256 (hex) of a canonical JSON string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The digest of a report: sha256 (hex) of the canonical JSON of its evidence form. */
export function reportSha256(
  report: Pick<AccessReviewReport, "generatedAt" | "members" | "summary">,
): string {
  return sha256Hex(canonicalJson(accessReviewEvidence(report)));
}

export interface CompleteReviewInput {
  readonly reviewerMembershipId: string;
  readonly note?: string | undefined;
  readonly requestId?: string | null | undefined;
  /**
   * What the reviewer attests to: the `reportSha256` and `generatedAt` of the report they were
   * shown. The report is rebuilt as of `generatedAt`; a different digest is `conflict` with
   * `reason: "report_changed"` (access changed since — look again). Without it the report is
   * built as of now and stored as is (API callers that never showed anybody a report).
   */
  readonly attest?: { readonly reportSha256: string; readonly generatedAt: string } | undefined;
}

export interface StoredAccessReviewReport {
  readonly id: string;
  readonly completedAt: string;
  readonly reportSha256: string;
  readonly schemaVersion: number;
  /** The canonical JSON of the stored evidence; its sha256 is `reportSha256`. */
  readonly body: string;
}

export interface AccessReviewService {
  report(ctx: TenantContext): Promise<AccessReviewReport>;
  /** Latest completed reviews, newest first (default 20). */
  list(ctx: TenantContext, limit?: number): Promise<AccessReviewRecord[]>;
  /** Recomputes the report, stores it and its digest, audits `access.review_completed`. */
  complete(
    ctx: TenantContext,
    input: CompleteReviewInput,
  ): Promise<{ record: AccessReviewRecord; report: AccessReviewReport }>;
  /** The evidence stored with a completed review; `not_found` for another workspace's or none. */
  storedReport(ctx: TenantContext, id: string): Promise<StoredAccessReviewReport>;
}

function recordOf(r: AccessReview, names: ReadonlyMap<string, { displayName: string }>) {
  const name = names.get(r.reviewerMembershipId)?.displayName ?? "";
  return {
    id: r.id,
    reviewerMembershipId: r.reviewerMembershipId,
    reviewerName: name.length > 0 ? name : null,
    completedAt: r.completedAt.toISOString(),
    memberCount: r.memberCount,
    flaggedCount: r.flaggedCount,
    note: r.note ?? null,
    reportSha256: r.reportSha256,
  } satisfies AccessReviewRecord;
}

/** Resolves the instant a completion rebuilds the report at (see `CompleteReviewInput.attest`). */
function attestedAt(attest: CompleteReviewInput["attest"], now: Date): Date {
  if (attest === undefined) return now;
  const at = new Date(attest.generatedAt);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== attest.generatedAt)
    throw new AuthError("invalid_request", "generatedAt is not the report's timestamp");
  if (at.getTime() > now.getTime() + 60_000)
    throw new AuthError("invalid_request", "generatedAt is in the future");
  if (now.getTime() - at.getTime() > ACCESS_REVIEW_ATTEST_MAX_AGE_MS)
    throw new AuthError(
      "conflict",
      "the report is more than a day old; reload it and review again",
      {
        reason: "report_changed",
      },
    );
  return at;
}

export function createAccessReviewService(
  deps: Pick<IdentityDeps, "db" | "audit" | "now">,
): AccessReviewService {
  const now = () => deps.now?.() ?? new Date();

  async function records(ctx: TenantContext, limit: number): Promise<AccessReviewRecord[]> {
    return deps.db.withTenant(ctx, async (tx) => {
      const rows = await new AccessReviewRepo(ctx, tx).latest(limit);
      const names = await new MembershipRepo(ctx, tx).namesFor([
        ...new Set(rows.map((r) => r.reviewerMembershipId)),
      ]);
      return rows.map((r) => recordOf(r, names));
    });
  }

  async function build(ctx: TenantContext, at: Date = now()): Promise<AccessReviewReport> {
    // 1. Every tenant fact, in one tenant transaction.
    const tenant = await deps.db.withTenant(ctx, async (tx) => {
      const repo = new AccessReviewRepo(ctx, tx);
      const fetched = await repo.members(ACCESS_REVIEW_MAX_MEMBERS + 1);
      const members = fetched.slice(0, ACCESS_REVIEW_MAX_MEMBERS);
      const ids = members.map((m) => m.membershipId);
      const principals = await new PrincipalRepo(ctx, tx).listActive();
      const latest = await repo.latest(1);
      const names = await new MembershipRepo(ctx, tx).namesFor(
        latest.map((r) => r.reviewerMembershipId),
      );
      return {
        members,
        truncated: fetched.length > ACCESS_REVIEW_MAX_MEMBERS,
        groups: await repo.groups(ids),
        grantCounts: await repo.directGrantCounts(ids),
        attestations: await repo.attestations(ids),
        pending: await repo.pendingGates(ids),
        gates: await new PolicyRepo(ctx, tx).listLiveGates(),
        linkIds: new Map(principals.map((p) => [p.membershipId, p.linkIds])),
        lastReview: latest[0] === undefined ? null : recordOf(latest[0], names),
        lastCompletedAt: latest[0]?.completedAt ?? null,
        workspaceCreatedAt: await repo.workspaceCreatedAt(),
      };
    });
    // 2. Then the session facts, in a separate host transaction (never inside the one above).
    const userIds = [...new Set(tenant.members.map((m) => m.userId))];
    const sessions = await deps.db.withHost((tx) =>
      workspaceSessionActivity(tx, userIds, ctx.workspaceId, at),
    );
    const members = buildAccessReviewRows({ ...tenant, sessions }, at);
    const last = tenant.lastReview;
    const generatedAt = at.toISOString();
    const summary = summarize(members, tenant.truncated);
    return {
      generatedAt,
      members,
      summary,
      reportSha256: reportSha256({ generatedAt, members, summary }),
      lastReview: last,
      // Same rule as the overdue job. (The workspace row is always visible to its own tenant.)
      nextReviewDueAt: accessReviewDueAt(
        tenant.lastCompletedAt,
        tenant.workspaceCreatedAt ?? at,
      ).toISOString(),
    };
  }

  return {
    report: build,
    list: (ctx, limit = 20) => records(ctx, limit),
    async complete(ctx, input) {
      const report = await build(ctx, attestedAt(input.attest, now()));
      const evidence = accessReviewEvidence(report);
      const sha = report.reportSha256;
      if (input.attest !== undefined && input.attest.reportSha256 !== sha)
        throw new AuthError(
          "conflict",
          "access changed since the report was generated; reload it and review again",
          { reason: "report_changed" },
        );
      const record = await deps.db.withTenant(ctx, async (tx) => {
        const row = await new AccessReviewRepo(ctx, tx).insert({
          reviewerMembershipId: input.reviewerMembershipId,
          memberCount: report.summary.members,
          flaggedCount: report.summary.flagged,
          note: input.note === undefined || input.note.length === 0 ? null : input.note,
          reportSha256: sha,
          report: evidence,
          reportSchemaVersion: evidence.schemaVersion,
        });
        await deps.audit.record(tx, ctx, {
          action: "access.review_completed",
          resourceKind: "access_review",
          resourceId: row.id,
          requestId: input.requestId ?? null,
          meta: {
            memberCount: row.memberCount,
            flaggedCount: row.flaggedCount,
            sha256: sha,
            generatedAt: report.generatedAt,
            attested: input.attest !== undefined,
            byFlag: report.summary.byFlag,
            hasNote: row.note !== null,
          },
        });
        const names = await new MembershipRepo(ctx, tx).namesFor([row.reviewerMembershipId]);
        return recordOf(row, names);
      });
      return { record, report };
    },

    async storedReport(ctx, id) {
      const row = await deps.db.withTenant(ctx, (tx) => new AccessReviewRepo(ctx, tx).byId(id));
      if (row === undefined) throw new AuthError("not_found", "no such review");
      return {
        id: row.id,
        completedAt: row.completedAt.toISOString(),
        reportSha256: row.reportSha256,
        schemaVersion: row.reportSchemaVersion,
        // jsonb reorders keys; the canonical form is what was hashed.
        body: canonicalJson(row.report),
      };
    },
  };
}

/*
 * The overdue-review reminder (E3.2, the E2.7 carry-over). A daily job walks every live,
 * non-platform workspace and asks one question: is the next access review due by now? Due is the
 * last completed review plus `ACCESS_REVIEW_INTERVAL_DAYS`; a workspace that has never been
 * reviewed is due that long after it was created. An overdue workspace gets the
 * `access.review_overdue` audit row (system actor) and the `access_review.overdue` event, which
 * the notify module turns into an alert for the `access.manage` holders. Without notify the audit
 * row is the whole effect.
 *
 * At most one reminder per ISO week (UTC) per workspace, whatever the number of runs: the daily
 * cron nags once a week, not seven times, and a rerun (a retried job, a second worker, an operator
 * running it by hand) is a no-op. The week's audit row (`meta.week`) is the marker — checked and written in one
 * tenant transaction under a per-workspace advisory lock, so two concurrent runs cannot both pass
 * the check. Notify buckets its rows by the same week as a second line of defence.
 *
 * Connections: one host transaction lists the workspaces and is closed before any tenant
 * transaction opens; each workspace is then one tenant transaction, never nested.
 *
 * Plan entitlements (A-3, ADR-0063): a workspace whose plan does not include `access_reviews` is
 * skipped (`not_on_plan`) — it cannot complete a review, so nagging it would be noise. The check
 * reads the plan on that workspace's own tenant transaction (no second connection) and is a no-op
 * unless entitlements are enforced (CONTROL_PLANE=on and a plan).
 */

/** Monday 00:00 UTC of the ISO week containing `at`. */
export function isoWeekStart(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

/** `2026-W39`: the ISO-8601 week (UTC) containing `at`. */
export function isoWeekKey(at: Date): string {
  const monday = isoWeekStart(at);
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * When the next access review is due: the last completed one plus the interval, or — never
 * reviewed — the workspace's creation plus the interval.
 */
export function accessReviewDueAt(lastCompletedAt: Date | null, workspaceCreatedAt: Date): Date {
  const from = lastCompletedAt ?? workspaceCreatedAt;
  return new Date(from.getTime() + ACCESS_REVIEW_INTERVAL_DAYS * DAY_MS);
}

export const ACCESS_REVIEW_OVERDUE_JOB = "access-review.overdue";

export type AccessReviewReminderOutcome =
  | "not_due"
  | "reminded"
  | "already_reminded"
  | "not_on_plan";

export interface AccessReviewReminderResult {
  readonly workspaces: number;
  readonly overdue: number;
  readonly reminded: number;
  /** Workspaces whose check threw; logged and skipped so the rest of the run still happens. */
  readonly failed: number;
  /** Workspaces skipped because their plan does not include `access_reviews`. */
  readonly notOnPlan: number;
}

type ReminderDeps = Pick<IdentityDeps, "db" | "audit" | "now" | "log"> & {
  /** Plan entitlements; absent = nothing is gated (every self-hosted install, most tests). */
  readonly entitlements?: EntitlementsPort | undefined;
};

/** One workspace, in one tenant transaction (see the block comment above). */
export async function remindWorkspaceIfOverdue(
  deps: ReminderDeps,
  workspace: { readonly id: string; readonly createdAt: Date },
  at: Date,
): Promise<AccessReviewReminderOutcome> {
  const ctx = systemContext(workspace.id);
  return deps.db.withTenant(ctx, async (tx) => {
    if (deps.entitlements !== undefined) {
      const e = await deps.entitlements.forWorkspace(tx, workspace.id);
      if (!e.allowsFeature("access_reviews")) return "not_on_plan";
    }
    const [last] = await new AccessReviewRepo(ctx, tx).latest(1);
    const dueAt = accessReviewDueAt(last?.completedAt ?? null, workspace.createdAt);
    if (at.getTime() < dueAt.getTime()) return "not_due";
    const repo = new AccessReviewRepo(ctx, tx);
    await repo.lockOverdueReminder();
    // Keyed on the week the job computed (`meta.week`), not on `occurred_at`: the database's
    // clock is not the job's, and a marker must mean the same week the reminder was sent for.
    const week = isoWeekKey(at);
    if (await repo.overdueReminderSent(week)) return "already_reminded";
    const lastReviewId = last?.id ?? null;
    await deps.audit.record(tx, ctx, {
      action: "access.review_overdue",
      resourceKind: "access_review",
      resourceId: lastReviewId,
      actorKind: "system",
      meta: { dueAt: dueAt.toISOString(), lastReviewId, week },
    });
    await publish(tx, ctx, "access_review.overdue", {
      dueAt: dueAt.toISOString(),
      lastReviewId,
    });
    return "reminded";
  });
}

/** Every live, non-platform workspace; see `remindWorkspaceIfOverdue`. */
export async function remindOverdueAccessReviews(
  deps: ReminderDeps,
  at?: Date,
): Promise<AccessReviewReminderResult> {
  const now = at ?? deps.now?.() ?? new Date();
  const live = await deps.db.withHost((tx) => liveWorkspacesForReview(tx));
  let workspaces = 0;
  let overdue = 0;
  let reminded = 0;
  let failed = 0;
  let notOnPlan = 0;
  for (const ws of live) {
    if (isPlatformWorkspace(ws.id)) continue;
    workspaces += 1;
    // One workspace per transaction, and one workspace's failure (a broken row, a lock timeout)
    // must not cost every workspace after it its reminder (E3.2 review): log, count, go on. The
    // weekly marker makes the next run (or a retry) remind the ones that failed, once.
    let outcome: AccessReviewReminderOutcome;
    try {
      outcome = await remindWorkspaceIfOverdue(deps, ws, now);
    } catch (error) {
      failed += 1;
      deps.log?.("auth.access_review_overdue_failed", {
        workspaceId: ws.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (outcome === "not_on_plan") {
      notOnPlan += 1;
      continue;
    }
    if (outcome !== "not_due") overdue += 1;
    if (outcome === "reminded") reminded += 1;
  }
  deps.log?.("auth.access_review_overdue_checked", {
    workspaces,
    overdue,
    reminded,
    failed,
    notOnPlan,
  });
  return { workspaces, overdue, reminded, failed, notOnPlan };
}

export interface AccessReviewJobOptions {
  readonly deps: ReminderDeps;
  readonly now?: (() => Date) | undefined;
  /** Plan entitlements (A-3): workspaces without `access_reviews` are skipped. Absent = none. */
  readonly entitlements?: EntitlementsPort | undefined;
}

/** `access-review.overdue`, daily at 06:41 UTC (kernel job; the composition root lists it). */
export function createAccessReviewJobs(options: AccessReviewJobOptions): JobDefinition[] {
  return [
    {
      name: ACCESS_REVIEW_OVERDUE_JOB,
      cron: "41 6 * * *",
      handler: async () => {
        const deps =
          options.entitlements === undefined
            ? options.deps
            : { ...options.deps, entitlements: options.entitlements };
        await remindOverdueAccessReviews(deps, options.now?.());
      },
    },
  ] satisfies JobDefinition<JsonObject>[];
}
