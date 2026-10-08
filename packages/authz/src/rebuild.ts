import {
  type NewEffectiveAccessRow,
  readAclVersion,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type { ResourceRef } from "@fundroom/ports";
import {
  earliestOf,
  gateVerdictExpiry,
  nodesOf,
  pendingGatesAtRebuild,
  type ResolvedNode,
  resolveNode,
  rulesCovering,
  rulesFor,
} from "./evaluate.js";
import {
  type Gate,
  isAncestorOrSelf,
  type Principal,
  type Rule,
  type StaffOnlyNode,
  veiledBy,
} from "./model.js";
import {
  documentLocations,
  EffectiveAccessRepo,
  GrantRepo,
  PolicyRepo,
  PrincipalRepo,
  staffOnlyNodes,
} from "./repos/access-repo.js";

/*
 * Materialisation (ADR-0032 §2). For every active membership and every resource node named
 * by a rule that applies to it, resolve the capabilities and the pending gates and store one
 * row. Nodes with *no* capability left are stored too: `core.has_access()` answers from the
 * nearest node, so an exclude on a subfolder must be present to shadow the parent's allow.
 *
 * Gated nodes get rows too (review AZ): `check()` answers from the nearest row, so a gate on a
 * node BELOW the one a member's rule names — an NDA on a sub-folder of a granted folder, on one
 * document in it — must have a row of its own that carries the gate, or the granted ancestor's
 * row (which knows nothing of it) decides the gated subtree and the gate is never asked for.
 * Every resource-targeted gate's node that one of the member's rules reaches gets a row resolved
 * exactly as the node itself (same rules, same veil); the extra rows are bounded by the number of
 * gated nodes. A document's own row, and a gated document's row, is evaluated for gates at the
 * path it SITS at (its folder's), so a gate on the folder binds a document granted directly.
 */
export interface RebuildResult {
  readonly workspaceId: string;
  readonly aclVersion: number;
  readonly rows: number;
  readonly memberships: number;
  readonly durationMs: number;
}

/**
 * The rules that decide a delegate's row for a path-less node that nevertheless sits somewhere
 * (a document, at `location`): the rules on the node itself plus the delegate's OWN rules on the
 * folders above it. `resolveNode` resolves own and borrowed rules apart,
 * so an exclude the delegate carries on the folder denies the document even though the principal
 * was granted it directly, and an exclude the principal carries on the document still binds the
 * delegate whatever it was granted above. Borrowed ancestor rules are deliberately not added: they
 * would hand the delegate capabilities its principal's own row for the document does not have.
 */
function delegateNodeRules(
  mine: readonly Rule[],
  node: ResourceRef,
  location: string,
): { rules: Rule[]; target: ResourceRef } {
  const own = mine.filter(
    (r) =>
      r.borrowed !== true &&
      r.resource.path !== undefined &&
      isAncestorOrSelf(r.resource.path, location),
  );
  return { rules: [...rulesCovering(mine, node), ...own], target: { ...node, path: location } };
}

/**
 * The nodes resource-targeted gates sit on (review AZ), once each. A folder carries its own path; a
 * document none (a leaf is matched by id, ADR-0034 §4) — its location comes from `locations`.
 */
function gatedNodesOf(gates: readonly Gate[]): ResourceRef[] {
  const seen = new Map<string, ResourceRef>();
  for (const g of gates) {
    if (g.target.kind !== "resource") continue;
    const r = g.target.resource;
    // Two gates on one node name the same node: keeping either is the same.
    seen.set(`${r.kind}:${r.id}`, r);
  }
  return [...seen.values()];
}

/**
 * The documents whose location (`documentLocations`) the rebuild needs: every document a rule or a
 * gate names, when anything consults locations — a delegate (F4), a staff-only folder (E3.5), or a
 * resource-targeted gate (review AZ: a gate on a folder binds the documents in it, and a gated
 * document needs its folder to know which rules reach it). Empty otherwise: no lookup is made.
 * `ndaGateDocumentIds` (packages/compliance) calls this too, so both read the graph alike.
 */
export function locatedDocumentIds(
  principals: readonly Principal[],
  rules: readonly Rule[],
  gates: readonly Gate[],
  staffOnly: readonly StaffOnlyNode[],
): string[] {
  const gated = gatedNodesOf(gates);
  if (
    staffOnly.length === 0 &&
    gated.length === 0 &&
    !principals.some((p) => p.delegation !== undefined)
  )
    return [];
  const ids = new Set<string>();
  for (const r of rules) if (r.resource.kind === "document") ids.add(r.resource.id);
  for (const n of gated) if (n.kind === "document") ids.add(n.id);
  return [...ids];
}

/** Pure: rows for a workspace given its graph. */
export function computeEffectiveRows(
  principals: readonly Principal[],
  rules: readonly Rule[],
  gates: readonly Gate[],
  aclVersion: number,
  now: Date,
  /**
   * `kind:id` → where a path-less node sits (`documentLocations`, for `locatedDocumentIds`): decides
   * a delegate's document rows (F4), whether a document lies inside a staff-only folder (E3.5), and
   * which gates bind a document and which rules reach a gated one (review AZ).
   */
  locations: ReadonlyMap<string, string> = new Map(),
  /** Staff-only folders (E3.5, `staffOnlyNodes`): external principals are veiled from them. */
  staffOnly: readonly StaffOnlyNode[] = [],
): Omit<NewEffectiveAccessRow, "workspaceId">[] {
  const out: Omit<NewEffectiveAccessRow, "workspaceId">[] = [];
  const gated = gatedNodesOf(gates);
  for (const p of principals) {
    const mine = rulesFor(rules, p);
    if (mine.length === 0) continue;
    // E3.5 (ADR-0053): the veil. For an external principal every node at or below a staff-only
    // folder resolves to NO capability whatever the rules say — a grant on the node itself, on a
    // folder inside, or inherited from above — and each staff-only folder gets a zero row of its
    // own, so `core.has_access()` and `check()` (both: own row first, else the deepest ancestor
    // row) stop at it instead of reaching a grant further up. Staff are never veiled (their RBAC
    // decides regardless of rows).
    const veil = p.kind === "external" ? staffOnly : [];
    const emitted = new Set<string>();
    const emit = (node: ResourceRef, resolve: (at: ResourceRef) => ResolvedNode): void => {
      emitted.add(`${node.kind}:${node.id}`);
      // Where the node sits: its own path, else (a document) its folder's.
      const where = node.path ?? locations.get(`${node.kind}:${node.id}`);
      if (veiledBy(where, veil)) {
        out.push(veiledRow(p.membershipId, node, aclVersion, now));
        return;
      }
      // Gates are evaluated where the node sits (review AZ): a gate on a document's folder, or
      // above it, binds the document whatever rule reaches it. The stored row keeps the node's own
      // path (none for a document), so it never covers a sibling.
      const at: ResourceRef = { ...node, path: where };
      const resolved = resolve(at);
      out.push({
        membershipId: p.membershipId,
        resourceKind: node.kind,
        resourceId: node.id,
        resourcePath: node.path ?? null,
        capabilities: [...resolved.capabilities],
        pendingGates: pendingGatesAtRebuild(gates, p, at, now),
        // The row holds until a grant's validity, a satisfied gate's attestation or the
        // membership runs out, whichever is first (E2.10: time alone must trigger a rebuild).
        expiresAt: earliestOf(resolved.expiresAt, gateVerdictExpiry(gates, p, at, now)) ?? null,
        aclVersion,
        computedAt: now,
      });
    };
    for (const node of nodesOf(mine)) {
      emit(node, (at) => {
        // A path-less node that sits somewhere (a document at its folder's path) is resolved
        // WHERE IT SITS (E3.13 R3-2): a rule on the document itself must not hide what the folders
        // above grant for other capabilities — the same answer `explain` and the resolver give.
        if (node.path !== undefined || at.path === undefined) return resolveNode(mine, node, now);
        if (p.delegation === undefined) return resolveNode(mine, at, now);
        // A delegate's row for a path-less node that sits somewhere (F4): see `delegateNodeRules`.
        const d = delegateNodeRules(mine, node, at.path);
        return resolveNode(d.rules, d.target, now);
      });
    }
    // Review AZ: a gated node below a node the member's rules reach gets its own row, resolved as
    // the node itself — every rule that covers it, the same answer `check()` used to read off the
    // nearest ancestor row — but carrying the gate that ancestor row cannot know about. A gated
    // node no rule of the member reaches is left alone: there is nothing there for it to gate.
    for (const node of gated) {
      if (emitted.has(`${node.kind}:${node.id}`)) continue;
      // A document out of the tree (no location) is reached by id alone: already emitted if so.
      const at: ResourceRef = {
        ...node,
        path: node.path ?? locations.get(`${node.kind}:${node.id}`),
      };
      if (rulesCovering(mine, at).length === 0) continue;
      emit(node, () => resolveNode(mine, at, now));
    }
    for (const s of veil) {
      if (!emitted.has(`${s.kind}:${s.id}`))
        out.push(
          veiledRow(p.membershipId, { kind: s.kind, id: s.id, path: s.path }, aclVersion, now),
        );
    }
  }
  return out;
}

/** A row that grants nothing and never lapses (E3.5 veil): time cannot lift a staff-only veil. */
function veiledRow(
  membershipId: string,
  node: ResourceRef,
  aclVersion: number,
  now: Date,
): Omit<NewEffectiveAccessRow, "workspaceId"> {
  return {
    membershipId,
    resourceKind: node.kind,
    resourceId: node.id,
    resourcePath: node.path ?? null,
    capabilities: [],
    pendingGates: [],
    expiresAt: null,
    aclVersion,
    computedAt: now,
  };
}

/** Rebuilds inside the caller's `system` transaction for the workspace. */
export async function rebuildEffectiveAccess(
  tx: Tx,
  ctx: TenantContext,
  options: { readonly now?: Date | undefined } = {},
): Promise<RebuildResult> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const aclVersion = await readAclVersion(tx, ctx.workspaceId);
  const principals = await new PrincipalRepo(ctx, tx).listActive();
  const rules = await new GrantRepo(ctx, tx).listLiveRules();
  const gates = await new PolicyRepo(ctx, tx).listLiveGates();
  const staffOnly = await staffOnlyNodes(tx, ctx);
  // Every rule-named document needs its location (E3.13 R3-2: a document's own row is resolved
  // where it sits, so inherited capabilities survive a rule on the document), as do the documents
  // the veil and resource-targeted gates need (`locatedDocumentIds`).
  const locations = await documentLocations(tx, ctx, [
    ...new Set([
      ...locatedDocumentIds(principals, rules, gates, staffOnly),
      ...rules.filter((r) => r.resource.kind === "document").map((r) => r.resource.id),
    ]),
  ]);
  const rows = computeEffectiveRows(
    principals,
    rules,
    gates,
    aclVersion,
    now,
    locations,
    staffOnly,
  );
  const durationMs = Math.round(performance.now() - started);
  await new EffectiveAccessRepo(ctx, tx).replaceAll(rows, aclVersion, durationMs);
  return {
    workspaceId: ctx.workspaceId,
    aclVersion,
    rows: rows.length,
    memberships: principals.length,
    durationMs,
  };
}
