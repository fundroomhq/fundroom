import { readAclVersion, type TenantContext, type Tx } from "@fundroom/db";
import type {
  RelationshipMember,
  RelationshipNode,
  RelationshipRule,
  RelationshipSnapshot,
} from "@fundroom/ports";
import { sql } from "drizzle-orm";
import { GrantRepo, PrincipalRepo, parseTstzRange, subjectOfRow } from "./access-repo.js";

/*
 * The projection an external relationship engine receives (E3.13, ADR-0061 §3): the RAW rules of
 * one workspace, the node tree they resolve over and the members they may name — never
 * `effective_access` (gates, the staff-only veil, delegates and staff RBAC stay in Postgres).
 *
 * Runs on the caller's `system` transaction for the workspace; keep that transaction short (the
 * `authz.engine_sync` job reads this, commits, and only then talks to the engine).
 *
 * The tree mirrors how the Postgres resolver reaches ancestors. A rule covers a node through
 * ltree paths (ADR-0034): a folder rule carries the folder's own `path`, and a document is covered
 * by every rule whose path is an ancestor-or-self of the path the document SITS at (its
 * `folder_path`). So a folder's parent is the folder whose path is its own minus the last label,
 * and a document's parent is the folder whose path equals its `folder_path` — derived from the
 * paths, not `parent_id`/`folder_id`, because the paths are what the resolver reads (they agree
 * unless a row is corrupt; then `parent_id`/`folder_id` is the fallback). Trashed folders and
 * documents are included, as the resolver's paths include them (a restore brings the subtree back
 * under the same rules). Any other resource a rule names (`post`, …) is a flat node.
 */

/** A bound that far out never starts; one at the epoch has always ended (`parseTstzRange`). */
const NEVER_MS = 8_640_000_000_000_000;

export async function buildRelationshipSnapshot(
  tx: Tx,
  ctx: TenantContext,
  options: {
    /** Resource kinds the install can ask about (module registry), declared even if unused yet. */
    readonly kinds?: Iterable<string> | undefined;
  } = {},
): Promise<RelationshipSnapshot> {
  const aclVersion = await readAclVersion(tx, ctx.workspaceId);
  const members: RelationshipMember[] = (await new PrincipalRepo(ctx, tx).listActive())
    // External, active, unexpired, not a delegate (delegate F4 resolution stays in Postgres).
    .filter((p) => p.kind === "external" && p.role !== "delegate" && p.delegation === undefined)
    .map((p) => ({
      membershipId: p.membershipId,
      role: p.role,
      groupIds: [...p.groupIds],
      linkIds: [...p.linkIds],
    }));
  const rules: RelationshipRule[] = [];
  for (const row of await new GrantRepo(ctx, tx).listLive()) {
    const { from, until } = parseTstzRange(row.validity);
    // A window that can never be open (unreadable start, end before start) is a rule the resolver
    // never counts: leave it out rather than ship a timestamp the engine cannot represent.
    if (from !== undefined && from.getTime() >= NEVER_MS) continue;
    if (from !== undefined && until !== undefined && until.getTime() <= from.getTime()) continue;
    rules.push({
      id: row.id,
      subject: subjectOfRow(row),
      resource: { kind: row.resourceKind, id: row.resourceId },
      capability: row.capability,
      effect: row.effect,
      validFrom: from?.toISOString() ?? null,
      validUntil: until?.toISOString() ?? null,
    });
  }
  const room = await dataRoomNodes(tx, ctx);
  const nodes = room.nodes;
  const known = new Set(nodes.map((n) => `${n.kind}:${n.id}`));
  for (const r of rules) {
    const key = `${r.resource.kind}:${r.resource.id}`;
    if (known.has(key)) continue;
    known.add(key);
    nodes.push({ kind: r.resource.kind, id: r.resource.id, parent: null });
  }
  // FIX3 RR2-1: every askable kind, so the first document of a room synced with folders only is
  // decided by the engine rather than refused as an unknown type.
  const kinds = new Set(options.kinds ?? []);
  if (room.present) {
    kinds.add("folder");
    kinds.add("document");
  }
  return {
    workspaceId: ctx.workspaceId,
    aclVersion,
    nodes,
    members,
    rules,
    kinds: [...kinds].sort(),
  };
}

/** Folders and documents with their parents (empty when the data-room schema is absent). */
async function dataRoomNodes(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ present: boolean; nodes: RelationshipNode[] }> {
  const present = await tx.execute(
    sql`SELECT to_regclass('dataroom.folder') IS NOT NULL AS present`,
  );
  if ((present.rows[0] as { present?: boolean } | undefined)?.present !== true)
    return { present: false, nodes: [] };
  const folders = (
    await tx.execute(
      sql`SELECT id::text AS id, parent_id::text AS parent_id, path::text AS path
            FROM dataroom.folder WHERE workspace_id = ${ctx.workspaceId}::uuid`,
    )
  ).rows as { id: string; parent_id: string | null; path: string }[];
  const documents = (
    await tx.execute(
      sql`SELECT id::text AS id, folder_id::text AS folder_id, folder_path::text AS folder_path
            FROM dataroom.document WHERE workspace_id = ${ctx.workspaceId}::uuid`,
    )
  ).rows as { id: string; folder_id: string; folder_path: string }[];
  const byPath = new Map(folders.map((f) => [f.path, f.id]));
  const folderIds = new Set(folders.map((f) => f.id));
  const folderRef = (id: string | null | undefined) =>
    id !== null && id !== undefined && folderIds.has(id) ? { kind: "folder", id } : null;
  const nodes: RelationshipNode[] = [];
  for (const f of folders) {
    const cut = f.path.lastIndexOf(".");
    const parentId = cut < 0 ? null : (byPath.get(f.path.slice(0, cut)) ?? f.parent_id);
    nodes.push({
      kind: "folder",
      id: f.id,
      parent: parentId === f.id ? null : folderRef(parentId),
    });
  }
  for (const d of documents) {
    nodes.push({
      kind: "document",
      id: d.id,
      parent: folderRef(byPath.get(d.folder_path) ?? d.folder_id),
    });
  }
  return { present: true, nodes };
}
