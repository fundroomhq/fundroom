import { CUSTOM_DOMAIN_ISSUABLE_STATUSES, core, type Database } from "@fundroom/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

const { customDomain, workspace } = core;

/*
 * What the reconcile sweep reads from THIS cell's database (host context): the workspaces that
 * exist here and the custom hostnames verified here. Read-only.
 */

export interface LocalWorkspaceFact {
  readonly id: string;
  readonly slug: string;
  readonly cellId: string;
  readonly holds: readonly string[];
  /** Soft-deleted (restorable): the slug stays claimed in the directory until the purge. */
  readonly deleted: boolean;
  /** Crypto-shredded: gone for good, its entry should be released. */
  readonly purged: boolean;
}

export async function listLocalWorkspaceFacts(db: Database): Promise<LocalWorkspaceFact[]> {
  const rows = await db.withHost((tx) =>
    tx
      .select({
        id: workspace.id,
        slug: workspace.slug,
        cellId: workspace.cellId,
        holds: workspace.holds,
        deletedAt: workspace.deletedAt,
        purgedAt: workspace.purgedAt,
      })
      .from(workspace)
      .orderBy(asc(workspace.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    cellId: r.cellId,
    holds: r.holds,
    deleted: r.deletedAt !== null,
    purged: r.purgedAt !== null,
  }));
}

/** Verified (`dns_ok` / `active`) custom hostnames of live workspaces. */
export async function listLocalVerifiedHostnames(
  db: Database,
): Promise<{ readonly hostname: string; readonly workspaceId: string }[]> {
  return db.withHost((tx) =>
    tx
      .select({ hostname: customDomain.hostname, workspaceId: customDomain.workspaceId })
      .from(customDomain)
      .where(
        and(
          isNull(customDomain.deletedAt),
          inArray(customDomain.status, [...CUSTOM_DOMAIN_ISSUABLE_STATUSES]),
        ),
      )
      .orderBy(asc(customDomain.hostname)),
  );
}

/** One workspace's facts, re-read right before the sweep writes (R2-10). */
export async function readLocalWorkspaceFact(
  db: Database,
  id: string,
): Promise<LocalWorkspaceFact | undefined> {
  const rows = await db.withHost((tx) =>
    tx
      .select({
        id: workspace.id,
        slug: workspace.slug,
        cellId: workspace.cellId,
        holds: workspace.holds,
        deletedAt: workspace.deletedAt,
        purgedAt: workspace.purgedAt,
      })
      .from(workspace)
      .where(eq(workspace.id, id)),
  );
  const r = rows[0];
  return r === undefined
    ? undefined
    : {
        id: r.id,
        slug: r.slug,
        cellId: r.cellId,
        holds: r.holds,
        deleted: r.deletedAt !== null,
        purged: r.purgedAt !== null,
      };
}

/**
 * `pending` (not yet verified, not failed, not removed) custom hostnames: a copy that arrived by a
 * move re-verifies its domains, and the directory claim it carried is kept meanwhile (RR1-4).
 */
export async function listLocalPendingHostnames(db: Database): Promise<
  {
    readonly hostname: string;
    readonly workspaceId: string;
    readonly createdAt: Date;
    readonly firstAttemptAt: Date;
  }[]
> {
  return db.withHost((tx) =>
    tx
      .select({
        hostname: customDomain.hostname,
        workspaceId: customDomain.workspaceId,
        createdAt: customDomain.createdAt,
        firstAttemptAt: customDomain.firstAttemptAt,
      })
      .from(customDomain)
      .where(and(isNull(customDomain.deletedAt), eq(customDomain.status, "pending")))
      .orderBy(asc(customDomain.hostname)),
  );
}
