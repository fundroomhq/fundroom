import { sql } from "drizzle-orm";
import { systemContext } from "../tenant/context.js";
import type { Database } from "../tenant/database.js";

/*
 * Read-only queries behind `fundroom evidence` (E2.10, SOC 2 evidence hooks). Host context for
 * the instance-wide workspace list, the workspace's own `system` context for its access reviews
 * (core.access_review admits only staff and system). Raw SQL: timestamps are coerced to ISO text.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

export interface EvidenceWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Live (not soft-deleted) workspaces, oldest first; `target` narrows to one slug or id. */
export async function listEvidenceWorkspaces(
  db: Database,
  target?: string,
): Promise<EvidenceWorkspace[]> {
  return db.withHost(async (tx) => {
    const filter =
      target === undefined
        ? sql`true`
        : UUID_RE.test(target)
          ? sql`id = ${target.toLowerCase()}::uuid`
          : sql`slug = ${target.toLowerCase()}`;
    const r = await tx.execute(sql`
      SELECT id::text AS id, slug::text AS slug, name, created_at
        FROM core.workspace WHERE deleted_at IS NULL AND ${filter}
       ORDER BY created_at, id`);
    return r.rows.map((row) => ({
      id: String(row["id"]),
      slug: String(row["slug"]),
      name: String(row["name"]),
      createdAt: iso(row["created_at"]),
    }));
  });
}

/** Every workspace's slug by id, deleted ones included (for labelling evidence rows). */
export async function workspaceSlugsById(db: Database): Promise<Map<string, string>> {
  return db.withHost(async (tx) => {
    const r = await tx.execute(sql`SELECT id::text AS id, slug::text AS slug FROM core.workspace`);
    return new Map(r.rows.map((row) => [String(row["id"]), String(row["slug"])]));
  });
}

export interface AccessReviewEvidence {
  readonly id: string;
  readonly completedAt: string;
  readonly reportSha256: string;
  readonly reviewerMembershipId: string;
  /** The reviewer's display name while their membership row exists; null after. */
  readonly reviewerName: string | null;
  readonly memberCount: number;
  readonly flaggedCount: number;
}

/** The workspace's latest completed access review, and those completed since `since`. */
export async function accessReviewEvidence(
  db: Database,
  workspaceId: string,
  since?: Date,
): Promise<{ last: AccessReviewEvidence | undefined; inPeriod: AccessReviewEvidence[] }> {
  return db.withTenant(systemContext(workspaceId), async (tx) => {
    const select = sql`
      SELECT r.id::text AS id, r.completed_at, r.report_sha256, r.member_count, r.flagged_count,
             r.reviewer_membership_id::text AS reviewer_membership_id, u.display_name
        FROM core.access_review r
        LEFT JOIN core.membership m ON m.id = r.reviewer_membership_id
        LEFT JOIN core."user" u ON u.id = m.user_id
       WHERE r.workspace_id = ${workspaceId}::uuid`;
    const map = (row: Record<string, unknown>): AccessReviewEvidence => ({
      id: String(row["id"]),
      completedAt: iso(row["completed_at"]),
      reportSha256: String(row["report_sha256"]),
      reviewerMembershipId: String(row["reviewer_membership_id"]),
      reviewerName: row["display_name"] == null ? null : String(row["display_name"]),
      memberCount: Number(row["member_count"]),
      flaggedCount: Number(row["flagged_count"]),
    });
    const last = await tx.execute(sql`${select} ORDER BY r.completed_at DESC, r.id DESC LIMIT 1`);
    const inPeriod =
      since === undefined
        ? []
        : (
            await tx.execute(
              sql`${select} AND r.completed_at >= ${since.toISOString()}::timestamptz
                  ORDER BY r.completed_at DESC, r.id DESC LIMIT 1000`,
            )
          ).rows.map(map);
    const lastRow = last.rows[0];
    return { last: lastRow === undefined ? undefined : map(lastRow), inPeriod };
  });
}
