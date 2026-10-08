import {
  type AccessGrant,
  type AccessPolicy,
  core,
  type EffectiveAccessRow,
  type EffectiveAccessState,
  type NewEffectiveAccessRow,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import type { Capability, GrantEffect, ResourceRef, SubjectRef } from "@fundroom/ports";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { withResolvedStamps } from "../evaluate.js";
import type {
  DelegateScopeName,
  Gate,
  Principal,
  PrincipalAttestation,
  Rule,
  StaffOnlyNode,
} from "../model.js";

const {
  accessGrant,
  accessPolicy,
  effectiveAccess,
  effectiveAccessState,
  legalDocument,
  legalDocumentVersion,
  membership,
  groupMember,
  attestation,
  shareLink,
  shareLinkVisit,
} = core;

/*
 * Tenant-context repositories over the access tables. `TenantRepo` scopes every read and
 * forces `workspace_id` on inserts; RLS is the second fence. The rebuild and the evaluator
 * work on plain `Rule` / `Gate` / `Principal` values, which these repos produce.
 */

/**
 * One `timestamptz` as Postgres prints it (DateStyle ISO): `2026-09-23 18:00:00.123456+00`,
 * `…+05:30`, `…-03`, historic `…+00:53:28`, or an ISO string with `Z`.
 *
 * Not `new Date(text)`: V8 rejects an hour-only offset (`+00`), which is exactly what Postgres
 * prints for UTC — so every grant's `validity` used to parse as unbounded, and a grant with an
 * end date never ended (review E2.10, found while proving R1-A6).
 */
const TIMESTAMPTZ_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?|Z)$/u;

export function parseTimestamptz(text: string): Date | undefined {
  const m = TIMESTAMPTZ_RE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec, frac, sign, oh, om, os] = m;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
    Number((frac ?? "").padEnd(3, "0").slice(0, 3)),
  );
  // `Date.UTC` rolls 2026-13-45 over into 2027; a field out of range is not a timestamp.
  const back = new Date(utc);
  if (
    back.getUTCMonth() !== Number(mo) - 1 ||
    back.getUTCDate() !== Number(d) ||
    back.getUTCHours() !== Number(h) ||
    back.getUTCMinutes() !== Number(mi)
  )
    return undefined;
  const offsetS =
    sign === undefined
      ? 0
      : (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om ?? "0") * 60 + Number(os ?? "0"));
  return new Date(utc - offsetS * 1000);
}

/** A bound that far out never starts; one at the epoch has always ended. */
const NEVER = new Date(8_640_000_000_000_000);
const LONG_AGO = new Date(0);

/**
 * `tstzrange` text → bounds. Postgres emits `["2026-…+00","2027-…+00")`, `["…",)` or `[-infinity,infinity)`.
 *
 * An empty or infinite bound is open (`undefined`). A bound that is present but unreadable fails
 * **closed** — a start that never comes, an end already past — rather than open: an access rule
 * whose window cannot be read must not become a rule with no window.
 */
export function parseTstzRange(text: string): { from: Date | undefined; until: Date | undefined } {
  const m = /^[[(]("?)([^",]*)\1,("?)([^",]*)\3[\])]$/u.exec(text.trim());
  if (!m) return { from: NEVER, until: LONG_AGO };
  const lo = m[2] ?? "";
  const hi = m[4] ?? "";
  return {
    from: lo === "" || lo === "-infinity" ? undefined : (parseTimestamptz(lo) ?? NEVER),
    until: hi === "" || hi === "infinity" ? undefined : (parseTimestamptz(hi) ?? LONG_AGO),
  };
}

export function toTstzRange(from: Date | undefined, until: Date | undefined): string {
  const lo = from ? `"${from.toISOString()}"` : "";
  const hi = until ? `"${until.toISOString()}"` : "";
  return `[${lo},${hi})`;
}

export function subjectOfRow(row: AccessGrant): SubjectRef {
  if (row.subjectKind === "role") return { kind: "role", role: row.subjectRole ?? "" };
  return { kind: row.subjectKind, id: row.subjectId ?? "" };
}

export function ruleOfRow(row: AccessGrant): Rule {
  const { from, until } = parseTstzRange(row.validity);
  return {
    grantId: row.id,
    subject: subjectOfRow(row),
    resource: {
      kind: row.resourceKind,
      id: row.resourceId,
      path: row.resourcePath ?? undefined,
    },
    capability: row.capability,
    effect: row.effect,
    validFrom: from,
    validUntil: until,
  };
}

export function gateOfRow(row: AccessPolicy): Gate {
  const config = (row.config ?? {}) as Record<string, unknown>;
  switch (row.targetKind) {
    case "workspace":
      return { policyId: row.id, kind: row.kind, config, target: { kind: "workspace" } };
    case "group":
      return {
        policyId: row.id,
        kind: row.kind,
        config,
        target: { kind: "group", id: row.targetId ?? "" },
      };
    case "membership":
      return {
        policyId: row.id,
        kind: row.kind,
        config,
        target: { kind: "membership", id: row.targetId ?? "" },
      };
    case "link":
      return {
        policyId: row.id,
        kind: row.kind,
        config,
        target: { kind: "link", id: row.targetId ?? "" },
      };
    case "resource":
      return {
        policyId: row.id,
        kind: row.kind,
        config,
        target: {
          kind: "resource",
          resource: {
            kind: row.resourceKind ?? "",
            id: row.targetId ?? "",
            path: row.resourcePath ?? undefined,
          },
        },
      };
  }
}

export interface CreateGrantInput {
  readonly subject: SubjectRef;
  readonly resource: ResourceRef;
  readonly capability: Capability;
  readonly effect?: GrantEffect | undefined;
  readonly validFrom?: Date | undefined;
  readonly validUntil?: Date | undefined;
  readonly maxViews?: number | undefined;
  readonly note?: string | undefined;
  readonly createdBy?: string | undefined;
}

export class GrantRepo extends TenantRepo<typeof accessGrant> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accessGrant, ctx, tx);
  }

  async byId(id: string): Promise<AccessGrant | undefined> {
    return this.findById(id);
  }

  /** Every live (not revoked) rule; validity is the evaluator's business. */
  async listLive(): Promise<AccessGrant[]> {
    return this.findMany(isNull(accessGrant.revokedAt));
  }

  async listLiveRules(): Promise<Rule[]> {
    return (await this.listLive()).map(ruleOfRow);
  }

  /** Live rules on a resource or on any node whose path is an ancestor (any kind, ADR-0034). */
  async listForResource(resource: ResourceRef): Promise<AccessGrant[]> {
    const onNode = and(
      eq(accessGrant.resourceKind, resource.kind),
      eq(accessGrant.resourceId, resource.id),
    );
    const where =
      resource.path === undefined
        ? onNode
        : or(onNode, sql`${accessGrant.resourcePath} @> ${resource.path}::ltree`);
    return this.findMany(and(isNull(accessGrant.revokedAt), where));
  }

  /**
   * A subtree moved: every rule (live or revoked, so history reads right) under `oldPath`
   * gets `newPath` as its new prefix. Returns how many rows changed. The caller bumps the
   * acl version.
   */
  async rewritePaths(oldPath: string, newPath: string): Promise<number> {
    const rows = await this.tx
      .update(accessGrant)
      .set({
        resourcePath: sql`CASE WHEN nlevel(${accessGrant.resourcePath}) = nlevel(${oldPath}::ltree) THEN ${newPath}::ltree ELSE ${newPath}::ltree || subpath(${accessGrant.resourcePath}, nlevel(${oldPath}::ltree)) END`,
      })
      .where(this.scope(sql`${accessGrant.resourcePath} <@ ${oldPath}::ltree`))
      .returning({ id: accessGrant.id });
    return rows.length;
  }

  /** Live rules whose subject is one of these (direct grants of a person, or of a group). */
  async listForSubjects(subjects: readonly SubjectRef[]): Promise<AccessGrant[]> {
    const ids = subjects.filter((s) => s.kind !== "role").map((s) => (s as { id: string }).id);
    const roles = subjects
      .filter((s) => s.kind === "role")
      .map((s) => (s as { role: string }).role);
    const parts = [];
    if (ids.length > 0) parts.push(inArray(accessGrant.subjectId, ids));
    if (roles.length > 0)
      parts.push(
        inArray(
          accessGrant.subjectRole,
          roles as (typeof accessGrant.subjectRole.enumValues)[number][],
        ),
      );
    if (parts.length === 0) return [];
    return this.findMany(and(isNull(accessGrant.revokedAt), or(...parts)));
  }

  /**
   * Creates or updates the live rule for (subject, resource, capability). A repeat with a
   * different effect/validity replaces the old rule (revoked + new row) so history stays.
   */
  async upsert(
    input: CreateGrantInput,
  ): Promise<{ grant: AccessGrant; replaced: string | undefined }> {
    const subjectId = input.subject.kind === "role" ? null : input.subject.id;
    const subjectRole = input.subject.kind === "role" ? input.subject.role : null;
    const existing = await this.findMany(
      and(
        isNull(accessGrant.revokedAt),
        eq(accessGrant.subjectKind, input.subject.kind),
        subjectId === null ? isNull(accessGrant.subjectId) : eq(accessGrant.subjectId, subjectId),
        subjectRole === null
          ? isNull(accessGrant.subjectRole)
          : eq(
              accessGrant.subjectRole,
              subjectRole as (typeof accessGrant.subjectRole.enumValues)[number],
            ),
        eq(accessGrant.resourceKind, input.resource.kind),
        eq(accessGrant.resourceId, input.resource.id),
        eq(accessGrant.capability, input.capability),
      ),
    );
    const prior = existing[0];
    if (prior !== undefined) {
      await this.tx
        .update(accessGrant)
        .set({ revokedAt: new Date(), revokedBy: input.createdBy ?? null })
        .where(this.scope(eq(accessGrant.id, prior.id)));
    }
    const grant = await this.insertOne({
      subjectKind: input.subject.kind,
      subjectId,
      subjectRole: subjectRole as (typeof accessGrant.subjectRole.enumValues)[number] | null,
      resourceKind: input.resource.kind,
      resourceId: input.resource.id,
      resourcePath: input.resource.path ?? null,
      capability: input.capability,
      effect: input.effect ?? "allow",
      validity: toTstzRange(input.validFrom, input.validUntil),
      maxViews: input.maxViews ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
    });
    return { grant, replaced: prior?.id };
  }

  async revoke(id: string, by?: string | undefined): Promise<AccessGrant | undefined> {
    const rows = await this.tx
      .update(accessGrant)
      .set({ revokedAt: new Date(), revokedBy: by ?? null })
      .where(this.scope(and(eq(accessGrant.id, id), isNull(accessGrant.revokedAt))))
      .returning();
    return rows[0];
  }

  /** Revocation cascade (§13.2): every live rule whose subject is one of these memberships. */
  async revokeForMemberships(
    membershipIds: readonly string[],
    by?: string | undefined,
  ): Promise<number> {
    if (membershipIds.length === 0) return 0;
    const rows = await this.tx
      .update(accessGrant)
      .set({ revokedAt: new Date(), revokedBy: by ?? null })
      .where(
        this.scope(
          and(
            isNull(accessGrant.revokedAt),
            eq(accessGrant.subjectKind, "membership"),
            inArray(accessGrant.subjectId, [...membershipIds]),
          ),
        ),
      )
      .returning({ id: accessGrant.id });
    return rows.length;
  }

  async revokeForGroup(groupId: string, by?: string | undefined): Promise<number> {
    const rows = await this.tx
      .update(accessGrant)
      .set({ revokedAt: new Date(), revokedBy: by ?? null })
      .where(
        this.scope(
          and(
            isNull(accessGrant.revokedAt),
            eq(accessGrant.subjectKind, "group"),
            eq(accessGrant.subjectId, groupId),
          ),
        ),
      )
      .returning({ id: accessGrant.id });
    return rows.length;
  }
}

export interface CreatePolicyInput {
  readonly kind: AccessPolicy["kind"];
  readonly config: Record<string, unknown>;
  readonly target:
    | { kind: "workspace" }
    | { kind: "group"; id: string }
    | { kind: "membership"; id: string }
    | { kind: "link"; id: string }
    | { kind: "resource"; resource: ResourceRef };
  readonly createdBy?: string | undefined;
}

export class PolicyRepo extends TenantRepo<typeof accessPolicy> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accessPolicy, ctx, tx);
  }

  async byId(id: string): Promise<AccessPolicy | undefined> {
    return this.findById(id);
  }

  async listLive(): Promise<AccessPolicy[]> {
    return this.findMany(isNull(accessPolicy.revokedAt));
  }

  /** Same as `GrantRepo.rewritePaths` for resource-targeted gates. */
  async rewritePaths(oldPath: string, newPath: string): Promise<number> {
    const rows = await this.tx
      .update(accessPolicy)
      .set({
        resourcePath: sql`CASE WHEN nlevel(${accessPolicy.resourcePath}) = nlevel(${oldPath}::ltree) THEN ${newPath}::ltree ELSE ${newPath}::ltree || subpath(${accessPolicy.resourcePath}, nlevel(${oldPath}::ltree)) END`,
      })
      .where(this.scope(sql`${accessPolicy.resourcePath} <@ ${oldPath}::ltree`))
      .returning({ id: accessPolicy.id });
    return rows.length;
  }

  /**
   * Live gates with every `nda` gate's stamp resolved (E2.3 decision D4).
   *
   * The gate stores `{ documentId }`, not a version string, and *this* is where the current
   * `<slug>:v<n>` is read — from the document's `current_version_id`. That is what makes
   * re-acceptance on version change automatic with no policy rewrite: publishing a version
   * bumps `acl_version`, the rebuild calls this again, the stamp moves, and everyone holding
   * the old one is pending again on the next materialisation. The evaluator stays pure and
   * only compares strings.
   *
   * A gate that still carries a legacy `{ version: "v3" }` is left exactly as it was and
   * `ndaStamp()` reads it; a `documentId` with no live document or no published version gets
   * no stamp, and the gate falls back to a stamp nobody holds rather than opening.
   */
  async listLiveGates(): Promise<Gate[]> {
    const gates = (await this.listLive()).map(gateOfRow);
    return withResolvedStamps(gates, await this.currentStamps(gates));
  }

  /** `documentId → '<slug>:v<n>'` for the documents the `nda` gates name. */
  private async currentStamps(gates: readonly Gate[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        gates
          .filter((g) => g.kind === "nda")
          .map((g) => g.config["documentId"])
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({
        documentId: legalDocument.id,
        slug: legalDocument.slug,
        versionNo: legalDocumentVersion.versionNo,
      })
      .from(legalDocument)
      // INNER, not LEFT: a document with no published version must yield no stamp at all.
      .innerJoin(legalDocumentVersion, eq(legalDocumentVersion.id, legalDocument.currentVersionId))
      .where(
        and(
          eq(legalDocument.workspaceId, this.ctx.workspaceId),
          inArray(legalDocument.id, ids),
          isNull(legalDocument.deletedAt),
        ),
      );
    for (const r of rows) out.set(r.documentId, `${r.slug}:v${r.versionNo}`);
    return out;
  }

  async create(input: CreatePolicyInput): Promise<AccessPolicy> {
    const t = input.target;
    return this.insertOne({
      targetKind: t.kind,
      targetId: t.kind === "workspace" ? null : t.kind === "resource" ? t.resource.id : t.id,
      resourceKind: t.kind === "resource" ? t.resource.kind : null,
      resourcePath: t.kind === "resource" ? (t.resource.path ?? null) : null,
      kind: input.kind,
      config: input.config,
      createdBy: input.createdBy ?? null,
    });
  }

  async revoke(id: string, by?: string | undefined): Promise<AccessPolicy | undefined> {
    const rows = await this.tx
      .update(accessPolicy)
      .set({ revokedAt: new Date(), revokedBy: by ?? null })
      .where(this.scope(and(eq(accessPolicy.id, id), isNull(accessPolicy.revokedAt))))
      .returning();
    return rows[0];
  }
}

export class EffectiveAccessRepo extends TenantRepo<typeof effectiveAccess> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(effectiveAccess, ctx, tx);
  }

  async state(): Promise<EffectiveAccessState | undefined> {
    const rows = await this.tx
      .select()
      .from(effectiveAccessState)
      .where(eq(effectiveAccessState.workspaceId, this.ctx.workspaceId))
      .limit(1);
    return rows[0];
  }

  /** Replaces every row of the workspace in one statement pair; serialised per workspace. */
  async replaceAll(
    rows: readonly Omit<NewEffectiveAccessRow, "workspaceId">[],
    aclVersion: number,
    durationMs: number,
  ): Promise<number> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(24302, hashtext(${this.ctx.workspaceId}))`,
    );
    await this.tx.delete(effectiveAccess).where(this.scope());
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      await this.tx
        .insert(effectiveAccess)
        .values(rows.slice(i, i + chunk).map((r) => ({ ...r, workspaceId: this.ctx.workspaceId })));
    }
    await this.tx
      .insert(effectiveAccessState)
      .values({
        workspaceId: this.ctx.workspaceId,
        aclVersion,
        builtAt: new Date(),
        rowCount: rows.length,
        durationMs,
      })
      .onConflictDoUpdate({
        target: effectiveAccessState.workspaceId,
        set: { aclVersion, builtAt: new Date(), rowCount: rows.length, durationMs },
      });
    return rows.length;
  }

  async listForMembership(membershipId: string): Promise<EffectiveAccessRow[]> {
    return this.findMany(eq(effectiveAccess.membershipId, membershipId));
  }

  async listForMembershipKind(membershipId: string, kind: string): Promise<EffectiveAccessRow[]> {
    return this.findMany(
      and(eq(effectiveAccess.membershipId, membershipId), eq(effectiveAccess.resourceKind, kind)),
    );
  }
}

/** Reads what the rebuild needs about people: live memberships, their groups, their attestations. */
export class PrincipalRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  /**
   * Active memberships only: dormant/suspended/invited/revoked members hold no access (design/05 §5).
   *
   * A delegate (E3.2) is loaded only while its principal is live too — an `active`, unexpired
   * external investor of this workspace — and then carries the principal's membership and live
   * groups as `delegation`, with `expiresAt` the earlier of the two expiries. A delegate whose
   * principal is suspended, dormant, revoked or expired is not loaded at all: it materialises no
   * rows, its own direct grants included.
   */
  async listActive(): Promise<Principal[]> {
    const ws = this.ctx.workspaceId;
    const members = await this.tx
      .select({
        id: membership.id,
        kind: membership.kind,
        role: membership.role,
        expiresAt: membership.expiresAt,
        principalMembershipId: membership.principalMembershipId,
        delegateScope: membership.delegateScope,
      })
      .from(membership)
      .where(and(eq(membership.workspaceId, ws), eq(membership.status, "active")))
      .orderBy(asc(membership.createdAt));
    if (members.length === 0) return [];
    const now = new Date();
    const unexpired = members.filter((m) => m.expiresAt === null || m.expiresAt > now);
    const byId = new Map(unexpired.map((m) => [m.id, m]));
    const principalOf = (m: (typeof unexpired)[number]) => {
      // No scope is impossible (CHECK membership_delegate_scope); refuse rather than guess one.
      if (m.role !== "delegate" || m.delegateScope === null) return undefined;
      const p = m.principalMembershipId === null ? undefined : byId.get(m.principalMembershipId);
      return p !== undefined && p.kind === "external" && p.role === "investor" ? p : undefined;
    };
    const live = unexpired.filter((m) => m.role !== "delegate" || principalOf(m) !== undefined);
    const ids = live.map((m) => m.id);
    const groups = await this.tx
      .select({ membershipId: groupMember.membershipId, groupId: groupMember.groupId })
      .from(groupMember)
      .where(
        and(
          eq(groupMember.workspaceId, ws),
          isNull(groupMember.revokedAt),
          inArray(groupMember.membershipId, ids),
        ),
      );
    const atts = await this.tx
      .select({
        membershipId: attestation.membershipId,
        kind: attestation.kind,
        signedAt: attestation.signedAt,
        expiresAt: attestation.expiresAt,
      })
      .from(attestation)
      .where(
        and(
          eq(attestation.workspaceId, ws),
          isNull(attestation.revokedAt),
          inArray(attestation.membershipId, ids),
          sql`(${attestation.expiresAt} IS NULL OR ${attestation.expiresAt} > now())`,
        ),
      );
    /*
     * The `link` subjects (E2.3). A live `share_link_visit` row binds a membership to a link,
     * and the link's own state decides whether that binding still counts: `active` only, not
     * revoked, not past `expires_at`. `paused` and `revoked` both stop emitting the subject, so
     * pausing a link suspends everyone it admitted and revoking it removes them — one write
     * either way, because the grant was written against the link and never copied per visitor.
     *
     * `uses`/`max_uses` are deliberately *not* consulted: an exhausted link admits nobody new
     * (E2.3 decision D3, admission) but must keep working for the people it already admitted.
     *
     * Newest binding first, which is the order `Principal.linkIds` documents and the order a
     * UI would list "how this person got in".
     */
    const links = await this.tx
      .select({ membershipId: shareLinkVisit.membershipId, linkId: shareLinkVisit.linkId })
      .from(shareLinkVisit)
      .innerJoin(shareLink, eq(shareLink.id, shareLinkVisit.linkId))
      .where(
        and(
          eq(shareLinkVisit.workspaceId, ws),
          isNull(shareLinkVisit.revokedAt),
          inArray(shareLinkVisit.membershipId, ids),
          eq(shareLink.workspaceId, ws),
          eq(shareLink.status, "active"),
          isNull(shareLink.revokedAt),
          or(isNull(shareLink.expiresAt), gt(shareLink.expiresAt, now)),
        ),
      )
      .orderBy(desc(shareLinkVisit.firstSeenAt));
    const linksBy = new Map<string, string[]>();
    for (const l of links)
      linksBy.set(l.membershipId, [...(linksBy.get(l.membershipId) ?? []), l.linkId]);
    const groupsBy = new Map<string, string[]>();
    for (const g of groups)
      groupsBy.set(g.membershipId, [...(groupsBy.get(g.membershipId) ?? []), g.groupId]);
    const attsBy = new Map<string, PrincipalAttestation[]>();
    for (const a of atts)
      attsBy.set(a.membershipId, [
        ...(attsBy.get(a.membershipId) ?? []),
        { kind: a.kind, signedAt: a.signedAt, expiresAt: a.expiresAt ?? undefined },
      ]);
    return live.map((m): Principal => {
      const p = principalOf(m);
      const base = {
        membershipId: m.id,
        kind: m.kind,
        role: m.role,
        groupIds: groupsBy.get(m.id) ?? [],
        linkIds: linksBy.get(m.id) ?? [],
        attestations: attsBy.get(m.id) ?? [],
      };
      if (p === undefined) return { ...base, expiresAt: m.expiresAt ?? undefined };
      const until =
        m.expiresAt === null
          ? p.expiresAt
          : p.expiresAt === null || m.expiresAt <= p.expiresAt
            ? m.expiresAt
            : p.expiresAt;
      return {
        ...base,
        expiresAt: until ?? undefined,
        delegation: {
          principalMembershipId: p.id,
          principalGroupIds: groupsBy.get(p.id) ?? [],
          scope: m.delegateScope as DelegateScopeName,
        },
      };
    });
  }

  async byId(membershipId: string): Promise<Principal | undefined> {
    const all = await this.listActive();
    return all.find((p) => p.membershipId === membershipId);
  }
}

/**
 * Where each of these documents *sits* (its folder's path), by id. A document
 * rule carries no path — a document is a leaf, and a rule filed under its folder's path would cover
 * every sibling (ADR-0034 §4, R1-A1) — so a delegate's row for a document its principal was granted
 * directly could not see the exclude an admin wrote against the delegate on the folder above. The
 * rebuild uses this location to let the delegate's OWN rules on ancestor folders decide that row;
 * the stored row keeps no path. Documents that are gone are simply absent.
 */
export async function documentLocations(
  tx: Tx,
  ctx: TenantContext,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await tx.execute(
    sql`SELECT id::text AS id, folder_path::text AS path FROM dataroom.document
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id IN (${idList})`,
  );
  for (const r of result.rows as { id: string; path: string | null }[])
    if (r.path !== null) out.set(`document:${r.id}`, r.path);
  return out;
}

/**
 * Every staff-only data-room folder of the workspace (E3.5, ADR-0053), trashed ones included — a
 * restore brings the subtree back veiled, never exposed until the next rebuild. The kernel names the
 * table for the reason `resource-repo.ts` does (modules are never kernel imports); an install whose
 * database has no data-room schema has no staff-only folders.
 */
export async function staffOnlyNodes(tx: Tx, ctx: TenantContext): Promise<StaffOnlyNode[]> {
  const present = await tx.execute(
    sql`SELECT to_regclass('dataroom.folder') IS NOT NULL AS present`,
  );
  if ((present.rows[0] as { present?: boolean } | undefined)?.present !== true) return [];
  const result = await tx.execute(
    sql`SELECT id::text AS id, path::text AS path FROM dataroom.folder
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND staff_only
         ORDER BY path`,
  );
  return (result.rows as { id: string; path: string }[]).map((r) => ({
    kind: "folder",
    id: r.id,
    path: r.path,
  }));
}

/**
 * Where a data-room node sits for the staff-only veil (E3.5): a folder's own path, a document's
 * folder path, read from the row (trashed rows included) — never from a client-sent path.
 * `undefined` for any other kind, or a node that does not exist.
 */
export async function veilLocation(
  tx: Tx,
  ctx: TenantContext,
  resource: ResourceRef,
): Promise<string | undefined> {
  if (resource.kind === "document") {
    return (await documentLocations(tx, ctx, [resource.id])).get(`document:${resource.id}`);
  }
  if (resource.kind !== "folder") return undefined;
  const result = await tx.execute(
    sql`SELECT path::text AS path FROM dataroom.folder
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${resource.id}::uuid`,
  );
  return (result.rows as { path: string }[])[0]?.path;
}
