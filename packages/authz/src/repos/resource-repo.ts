import type { TenantContext, Tx } from "@fundroom/db";
import { type SQL, sql } from "drizzle-orm";

/*
 * Does a grant's or gate's target resource exist **in this workspace** (pen test P1-03), and what
 * path must a rule on it carry (review R1-A1/A2)? The one resolver every writer of a resource
 * rule uses: the access routes' `canonicalResource`, an invitation's acceptance (E3.2 — the grants
 * it promised are re-derived, not copied from the stored JSON), and a workspace import's
 * `rederiveRulePaths`. Moved here from `apps/server` (E3.2) so identity and portability can reach
 * it without importing the server.
 *
 * The kernel writes grants and gates on resources that modules own, so it needs to know where
 * each kind lives. The table per kind is spelled here rather than imported because modules are
 * never kernel imports; a kind with no entry (a module added later without one) is reported as
 * `unchecked`, and the caller writes the grant without a path (it cannot tell a path it cannot
 * check from one that claims another module's subtree) — the gap is visible, not silent.
 * `found.path` is the path the rule must carry, derived here, never taken from the client.
 *
 * The lookup runs in the caller's tenant transaction: RLS hides every other workspace's rows,
 * and the explicit `workspace_id` predicate says the same thing a second time, so another
 * tenant's id and an id nobody ever minted are the same answer — `missing` — by construction.
 * Soft-deleted rows are missing too: a grant on a deleted folder would grant nothing.
 */
interface ResourceTable {
  readonly table: SQL;
  /**
   * The ltree column that is the resource's **own** node path, which a rule on it carries so it
   * covers everything below (ADR-0034 §4). Only a container has one. A document is a leaf: its
   * `folder_path` is where it *sits*, not a scope, and a document rule filed under it would cover
   * the folder, every sibling and every subfolder (review R1-A1) — so documents have none here,
   * and neither do flat kinds (`post`).
   */
  readonly path?: SQL | undefined;
}

const RESOURCE_TABLES: Readonly<Record<string, ResourceTable>> = {
  folder: { table: sql.raw("dataroom.folder"), path: sql.raw("path") },
  document: { table: sql.raw("dataroom.document") },
  post: { table: sql.raw("updates.post") },
};

export type ResourceLookup =
  | { readonly state: "found"; readonly path: string | null }
  | { readonly state: "missing" }
  | { readonly state: "unchecked" };

export function lookupResource(
  tx: Tx,
  ctx: TenantContext,
  kind: string,
  id: string,
): Promise<ResourceLookup> {
  return lookup(tx, ctx, kind, id, false);
}

async function lookup(
  tx: Tx,
  ctx: TenantContext,
  kind: string,
  id: string,
  includeDeleted: boolean,
): Promise<ResourceLookup> {
  const t = Object.hasOwn(RESOURCE_TABLES, kind) ? RESOURCE_TABLES[kind] : undefined;
  if (t === undefined) return { state: "unchecked" };
  const path = t.path === undefined ? sql`NULL` : sql`${t.path}::text`;
  const live = includeDeleted ? sql`` : sql` AND deleted_at IS NULL`;
  const result = await tx.execute(
    sql`SELECT ${path} AS path FROM ${t.table}
         WHERE id = ${id}::uuid AND workspace_id = ${ctx.workspaceId}::uuid${live}
         LIMIT 1`,
  );
  const row = (result.rows as { path: string | null }[])[0];
  return row === undefined ? { state: "missing" } : { state: "found", path: row.path };
}

/**
 * The path a rule on `(kind, id)` must carry, as `lookupResource` derives it: the container's own
 * path when found, and **none** otherwise — a leaf or flat kind is matched by id, a kind the kernel
 * cannot look up gets no scope it cannot check, and a resource that is gone gets no scope at all
 * (a stored path on it would still cover whatever now lives under that path).
 */
export function derivedRulePath(found: ResourceLookup): string | null {
  return found.state === "found" ? found.path : null;
}

/**
 * Re-derives every stored resource-rule path in the workspace from the resources themselves
 * (E3.2 decision 5), on the caller's transaction. Run by a workspace import right before the
 * effective-access rebuild: an export carries `access_grant.resource_path` /
 * `access_policy.resource_path` as the source wrote them, and a row hand-edited (or written by an
 * older build) to an over-broad path such as the root `r` would otherwise arrive as a rule over
 * the whole data room. After this, a folder rule carries `dataroom.folder.path` of its folder, and
 * every other kind — or a folder that no longer exists — carries none. The folder paths themselves
 * are checked by the data-room module's import (`afterImport` refuses a tree whose paths do not
 * follow its parent links, E3.2 L-2), in the same transaction.
 *
 * A folder in the trash still exists here (unlike `lookupResource`, which refuses a new rule on
 * it): its rules keep their path, exactly as they did in the source, so a later restore brings
 * back the subtree they covered rather than a rule on the folder node alone (E3.2 L-2).
 *
 * Pending invitations' promised grants lose any stored `resource.path`: acceptance re-derives the
 * path at that moment (`applyPromises`), so a stored one is only ever stale or wrong.
 *
 * Returns how many rows changed (grants + policies + invitations).
 */
export async function rederiveRulePaths(tx: Tx, ctx: TenantContext): Promise<number> {
  const targets = await tx.execute(sql`
    SELECT DISTINCT resource_kind AS kind, resource_id::text AS id FROM core.access_grant
     WHERE workspace_id = ${ctx.workspaceId}::uuid
    UNION
    SELECT DISTINCT resource_kind AS kind, target_id::text AS id FROM core.access_policy
     WHERE workspace_id = ${ctx.workspaceId}::uuid AND target_kind = 'resource'`);
  let changed = await rederiveTargets(tx, ctx, targets.rows as { kind: string; id: string }[]);
  const invites = await tx.execute(sql`
    UPDATE core.invite i SET
           grants = (
         SELECT jsonb_agg(
                  CASE WHEN jsonb_typeof(g -> 'resource') = 'object'
                       THEN jsonb_set(g, '{resource}', (g -> 'resource') - 'path')
                       ELSE g END
                  ORDER BY n)
           FROM jsonb_array_elements(i.grants) WITH ORDINALITY AS e(g, n))
     WHERE i.workspace_id = ${ctx.workspaceId}::uuid AND i.status = 'pending'
       AND jsonb_typeof(i.grants) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.grants) AS x(g)
                    WHERE jsonb_typeof(g -> 'resource') = 'object' AND (g -> 'resource') ? 'path')
    RETURNING i.id`);
  changed += invites.rows.length;
  return changed;
}

/**
 * `rederiveRulePaths` for the rules on the given resources only — a data-room restore from the
 * trash calls it for every folder it brought back, so their grants and gates carry the path the
 * folder has now, whatever path (or none) they were left with (E3.2 L-2). Returns rows changed.
 */
export function rederiveRulePathsFor(
  tx: Tx,
  ctx: TenantContext,
  kind: string,
  ids: readonly string[],
): Promise<number> {
  return rederiveTargets(
    tx,
    ctx,
    ids.map((id) => ({ kind, id })),
  );
}

async function rederiveTargets(
  tx: Tx,
  ctx: TenantContext,
  targets: readonly { kind: string; id: string }[],
): Promise<number> {
  let changed = 0;
  for (const t of targets) {
    const path = derivedRulePath(await lookup(tx, ctx, t.kind, t.id, true));
    const grants = await tx.execute(sql`
      UPDATE core.access_grant SET resource_path = ${path}::ltree
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND resource_kind = ${t.kind} AND resource_id = ${t.id}::uuid
         AND resource_path IS DISTINCT FROM ${path}::ltree
      RETURNING id`);
    const policies = await tx.execute(sql`
      UPDATE core.access_policy SET resource_path = ${path}::ltree
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND target_kind = 'resource'
         AND resource_kind = ${t.kind} AND target_id = ${t.id}::uuid
         AND resource_path IS DISTINCT FROM ${path}::ltree
      RETURNING id`);
    changed += grants.rows.length + policies.rows.length;
  }
  return changed;
}
