import {
  computeEffectiveRows,
  GrantRepo,
  isPendingGate,
  locatedDocumentIds,
  PolicyRepo,
  PrincipalRepo,
  pendingGatesAtRebuild,
  staffOnlyNodes,
} from "@fundroom/authz";
import {
  type ConsentEvent,
  type ConsentPurpose,
  core,
  type LegalDocument,
  type LegalDocumentKind,
  type LegalDocumentVersion,
  type NewConsentEvent,
  type NewLegalDocument,
  type NewLegalDocumentVersion,
  type OfferingPeriod,
  type OfferingStatus,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, desc, eq, isNull, max, type SQL, sql } from "drizzle-orm";
import type { RegisterKey } from "../service/register.js";

const { offeringPeriod, legalDocument, legalDocumentVersion, consentEvent } = core;

/*
 * Tenant-context repositories over the E1.6 tables (migration `core/0006_compliance.sql`).
 *
 * `TenantRepo` appends `workspace_id = ctx.workspaceId` to every read and forces it on inserts,
 * on top of RLS, so the planner uses the tenant indexes and a foreign workspace cannot even be
 * expressed. These are the only files in the package allowed to import drizzle (the
 * `only-repos-touch-drizzle` rule).
 *
 * Everything here goes through the query builder rather than `tx.execute`. That is not a style
 * preference: the raw path returns `timestamptz` as *text*, so a `Date`-typed field silently
 * becomes a string at runtime while the unit tests, which never touch a database, stay green
 * (ADR-0036, learned in E1.5). Three of these four tables are evidence tables whose timestamps
 * are the evidence.
 */

/** The append-only history behind `core.workspace.offering_status` (design/04 §2). */
export class OfferingPeriodRepo extends TenantRepo<typeof offeringPeriod> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(offeringPeriod, ctx, tx);
  }

  /** The open period — the one with no `ended_at`. A workspace has at most one (unique index). */
  async current(): Promise<OfferingPeriod | undefined> {
    const rows = await this.tx
      .select()
      .from(offeringPeriod)
      .where(this.scope(isNull(offeringPeriod.endedAt)))
      .limit(1);
    return rows[0];
  }

  /** Every period, newest first: the answer to "which status was in force at time T". */
  async history(): Promise<OfferingPeriod[]> {
    return this.tx
      .select()
      .from(offeringPeriod)
      .where(this.scope())
      .orderBy(desc(offeringPeriod.startedAt));
  }

  async open(values: {
    readonly status: OfferingStatus;
    readonly startedAt?: Date | undefined;
    readonly changedBy?: string | null | undefined;
    readonly reason?: string | null | undefined;
  }): Promise<OfferingPeriod> {
    return this.insertOne({
      status: values.status,
      ...(values.startedAt === undefined ? {} : { startedAt: values.startedAt }),
      changedBy: values.changedBy ?? null,
      reason: values.reason ?? null,
    });
  }

  /**
   * Opens the first period unless one is already open, and returns the open one either way.
   * `ON CONFLICT … DO NOTHING` on the one-open-period index (`offering_period_open_idx`) makes
   * concurrent first reads safe: the loser waits for the winner's commit, inserts nothing, and the
   * re-read (a fresh READ COMMITTED snapshot) sees the winner's row — rather than a unique
   * violation and a 500 (E3.2).
   */
  async openIfNone(values: {
    readonly status: OfferingStatus;
    readonly startedAt: Date;
    readonly reason: string;
  }): Promise<OfferingPeriod> {
    const rows = await this.tx
      .insert(offeringPeriod)
      .values({
        workspaceId: this.ctx.workspaceId,
        status: values.status,
        startedAt: values.startedAt,
        changedBy: null,
        reason: values.reason,
      })
      .onConflictDoNothing({ target: offeringPeriod.workspaceId, where: sql`ended_at IS NULL` })
      .returning();
    const inserted = rows[0] ?? (await this.current());
    if (inserted === undefined) throw new Error("offering period vanished while seeding it");
    return inserted;
  }

  /**
   * Closes the open period. The table's `offering_period_close_only` trigger allows exactly this
   * update and nothing else, so a caller that tries to rewrite history gets an error from the
   * database rather than a silent edit.
   */
  async close(id: string, endedAt: Date): Promise<OfferingPeriod | undefined> {
    const rows = await this.tx
      .update(offeringPeriod)
      .set({ endedAt })
      .where(this.scope(and(eq(offeringPeriod.id, id), isNull(offeringPeriod.endedAt))))
      .returning();
    return rows[0];
  }
}

export interface LegalDocumentPatch {
  readonly title?: string | undefined;
  readonly kind?: LegalDocumentKind | undefined;
  readonly audience?: LegalDocument["audience"] | undefined;
  readonly requiresAcceptance?: boolean | undefined;
  /** E3.5: click-wrap or a vendor e-signature. */
  readonly ceremony?: LegalDocument["ceremony"] | undefined;
  readonly currentVersionId?: string | undefined;
}

export class LegalDocumentRepo extends TenantRepo<typeof legalDocument> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(legalDocument, ctx, tx);
  }

  async byId(id: string): Promise<LegalDocument | undefined> {
    const rows = await this.tx
      .select()
      .from(legalDocument)
      .where(this.scope(and(eq(legalDocument.id, id), isNull(legalDocument.deletedAt))))
      .limit(1);
    return rows[0];
  }

  /** Slugs are `citext`, so this is case-insensitive in the database, not here. */
  async bySlug(slug: string): Promise<LegalDocument | undefined> {
    const rows = await this.tx
      .select()
      .from(legalDocument)
      .where(this.scope(and(eq(legalDocument.slug, slug), isNull(legalDocument.deletedAt))))
      .limit(1);
    return rows[0];
  }

  async byKind(kind: LegalDocumentKind): Promise<LegalDocument[]> {
    return this.tx
      .select()
      .from(legalDocument)
      .where(this.scope(and(eq(legalDocument.kind, kind), isNull(legalDocument.deletedAt))))
      .orderBy(legalDocument.slug);
  }

  /** Live documents, alphabetically by slug (the admin list and the acceptance sweep). */
  async list(): Promise<LegalDocument[]> {
    return this.tx
      .select()
      .from(legalDocument)
      .where(this.scope(isNull(legalDocument.deletedAt)))
      .orderBy(legalDocument.slug);
  }

  /** Live documents that gate access: `pendingFor` starts from exactly this set. */
  async requiringAcceptance(): Promise<LegalDocument[]> {
    return this.tx
      .select()
      .from(legalDocument)
      .where(
        this.scope(
          and(eq(legalDocument.requiresAcceptance, true), isNull(legalDocument.deletedAt)),
        ),
      )
      .orderBy(legalDocument.slug);
  }

  async create(values: Omit<NewLegalDocument, "workspaceId">): Promise<LegalDocument> {
    return this.insertOne(values);
  }

  async update(id: string, patch: LegalDocumentPatch): Promise<LegalDocument | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set["title"] = patch.title;
    if (patch.kind !== undefined) set["kind"] = patch.kind;
    if (patch.audience !== undefined) set["audience"] = patch.audience;
    if (patch.requiresAcceptance !== undefined)
      set["requiresAcceptance"] = patch.requiresAcceptance;
    if (patch.ceremony !== undefined) set["ceremony"] = patch.ceremony;
    if (patch.currentVersionId !== undefined) set["currentVersionId"] = patch.currentVersionId;
    const rows = await this.tx
      .update(legalDocument)
      .set(set)
      .where(this.scope(and(eq(legalDocument.id, id), isNull(legalDocument.deletedAt))))
      .returning();
    return rows[0];
  }

  /**
   * Soft delete. The versions and the acceptances against them stay: an acceptance has to keep
   * evidencing what somebody agreed to long after the tenant stopped serving the document
   * (retention is six years after close, design/04 §7).
   */
  async softDelete(id: string, at = new Date()): Promise<boolean> {
    const rows = await this.tx
      .update(legalDocument)
      .set({ deletedAt: at, updatedAt: at })
      .where(this.scope(and(eq(legalDocument.id, id), isNull(legalDocument.deletedAt))))
      .returning({ id: legalDocument.id });
    return rows.length > 0;
  }
}

export class LegalDocumentVersionRepo extends TenantRepo<typeof legalDocumentVersion> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(legalDocumentVersion, ctx, tx);
  }

  async byId(id: string): Promise<LegalDocumentVersion | undefined> {
    const rows = await this.tx
      .select()
      .from(legalDocumentVersion)
      .where(this.scope(eq(legalDocumentVersion.id, id)))
      .limit(1);
    return rows[0];
  }

  async byNo(documentId: string, versionNo: number): Promise<LegalDocumentVersion | undefined> {
    const rows = await this.tx
      .select()
      .from(legalDocumentVersion)
      .where(
        this.scope(
          and(
            eq(legalDocumentVersion.documentId, documentId),
            eq(legalDocumentVersion.versionNo, versionNo),
          ),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async latest(documentId: string): Promise<LegalDocumentVersion | undefined> {
    const rows = await this.tx
      .select()
      .from(legalDocumentVersion)
      .where(this.scope(eq(legalDocumentVersion.documentId, documentId)))
      .orderBy(desc(legalDocumentVersion.versionNo))
      .limit(1);
    return rows[0];
  }

  async list(documentId: string): Promise<LegalDocumentVersion[]> {
    return this.tx
      .select()
      .from(legalDocumentVersion)
      .where(this.scope(eq(legalDocumentVersion.documentId, documentId)))
      .orderBy(desc(legalDocumentVersion.versionNo));
  }

  /** 1 for the first version. `legal_document_version_unique` is the real guard against a race. */
  async nextVersionNo(documentId: string): Promise<number> {
    const rows = await this.tx
      .select({ n: max(legalDocumentVersion.versionNo) })
      .from(legalDocumentVersion)
      .where(this.scope(eq(legalDocumentVersion.documentId, documentId)));
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async create(
    values: Omit<NewLegalDocumentVersion, "workspaceId">,
  ): Promise<LegalDocumentVersion> {
    return this.insertOne(values);
  }
}

export class ConsentEventRepo extends TenantRepo<typeof consentEvent> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(consentEvent, ctx, tx);
  }

  async append(values: Omit<NewConsentEvent, "workspaceId">): Promise<ConsentEvent> {
    return this.insertOne(values);
  }

  /** The newest answer for one purpose; `undefined` means the member has never been asked. */
  async latestFor(
    membershipId: string,
    purpose: ConsentPurpose,
  ): Promise<ConsentEvent | undefined> {
    const rows = await this.tx
      .select()
      .from(consentEvent)
      .where(
        this.scope(
          and(eq(consentEvent.membershipId, membershipId), eq(consentEvent.purpose, purpose)),
        ),
      )
      .orderBy(desc(consentEvent.recordedAt), desc(consentEvent.id))
      .limit(1);
    return rows[0];
  }

  /** The newest answer per purpose, in one round trip (`DISTINCT ON`, the Postgres idiom). */
  async effectiveFor(membershipId: string): Promise<ConsentEvent[]> {
    return this.tx
      .selectDistinctOn([consentEvent.purpose])
      .from(consentEvent)
      .where(this.scope(eq(consentEvent.membershipId, membershipId)))
      .orderBy(consentEvent.purpose, desc(consentEvent.recordedAt), desc(consentEvent.id));
  }

  /** The member's whole consent history, newest first (their own privacy screen, DSAR export). */
  async listFor(membershipId: string): Promise<ConsentEvent[]> {
    return this.tx
      .select()
      .from(consentEvent)
      .where(this.scope(eq(consentEvent.membershipId, membershipId)))
      .orderBy(desc(consentEvent.recordedAt));
  }
}

/**
 * The relationship fields on `core.membership` (design/04 §1.6). They live on the membership
 * rather than in a table of their own, so this is a narrow writer over identity's table rather
 * than a repo class: `MembershipRepo` owns the row, this owns four columns of it.
 */
export async function recordRelationship(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  values: {
    readonly establishedAt?: Date | null | undefined;
    readonly source?: string | null | undefined;
    readonly note?: string | null | undefined;
  },
): Promise<
  | {
      readonly id: string;
      readonly relationshipEstablishedAt: Date | null;
      readonly relationshipSource: string | null;
      readonly relationshipNote: string | null;
      readonly firstExposureAt: Date | null;
      readonly createdAt: Date;
    }
  | undefined
> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (values.establishedAt !== undefined) set["relationshipEstablishedAt"] = values.establishedAt;
  if (values.source !== undefined) set["relationshipSource"] = values.source;
  if (values.note !== undefined) set["relationshipNote"] = values.note;
  const rows = await tx
    .update(core.membership)
    .set(set)
    .where(
      and(
        eq(core.membership.workspaceId, ctx.workspaceId),
        eq(core.membership.id, membershipId),
        sql`${core.membership.status} <> 'revoked'`,
      ),
    )
    .returning({
      id: core.membership.id,
      relationshipEstablishedAt: core.membership.relationshipEstablishedAt,
      relationshipSource: core.membership.relationshipSource,
      relationshipNote: core.membership.relationshipNote,
      firstExposureAt: core.membership.firstExposureAt,
      createdAt: core.membership.createdAt,
    });
  return rows[0];
}

/**
 * Stamps `first_exposure_at` the first time a member is shown offering material (E1.6, E2.5).
 *
 * `IS NULL` in the predicate is the whole function. Under 506(b) the fact counsel needs is
 * whether the substantive relationship *predated* the offering, so the useful timestamp is the
 * **earliest** exposure; a later page view overwriting it would quietly destroy the evidence the
 * column exists to hold. Written as one conditional UPDATE rather than read-then-write because
 * two tabs opening the terms page at once would otherwise race for it.
 *
 * Returns the instant that now stands (whether this call set it or an earlier one did), or
 * `undefined` for a membership that is gone — a caller cannot act on either, which is why a view
 * of the terms page must not fail on it.
 */
export async function noteFirstExposure(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  at: Date = new Date(),
): Promise<Date | undefined> {
  await tx
    .update(core.membership)
    .set({ firstExposureAt: at })
    .where(
      and(
        eq(core.membership.workspaceId, ctx.workspaceId),
        eq(core.membership.id, membershipId),
        isNull(core.membership.firstExposureAt),
      ),
    );
  const rows = await tx
    .select({ firstExposureAt: core.membership.firstExposureAt })
    .from(core.membership)
    .where(
      and(eq(core.membership.workspaceId, ctx.workspaceId), eq(core.membership.id, membershipId)),
    )
    .limit(1);
  return rows[0]?.firstExposureAt ?? undefined;
}

/** The membership facts the R5 warning heuristic needs, without pulling the whole row through. */
export async function readRelationship(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<
  | {
      readonly id: string;
      readonly kind: "staff" | "external";
      readonly createdAt: Date;
      readonly relationshipEstablishedAt: Date | null;
      readonly relationshipSource: string | null;
      readonly relationshipNote: string | null;
      readonly firstExposureAt: Date | null;
    }
  | undefined
> {
  const rows = await tx
    .select({
      id: core.membership.id,
      kind: core.membership.kind,
      createdAt: core.membership.createdAt,
      relationshipEstablishedAt: core.membership.relationshipEstablishedAt,
      relationshipSource: core.membership.relationshipSource,
      relationshipNote: core.membership.relationshipNote,
      firstExposureAt: core.membership.firstExposureAt,
    })
    .from(core.membership)
    .where(
      and(eq(core.membership.workspaceId, ctx.workspaceId), eq(core.membership.id, membershipId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * The workspace's own row, read inside the tenant transaction. `core.workspace`'s fence admits a
 * workspace's own row, so this needs no host context — and the services must read the status and
 * the settings from the same snapshot they are about to write into.
 */
export async function readWorkspaceFacts(
  tx: Tx,
  ctx: TenantContext,
): Promise<
  | {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
      readonly offeringStatus: OfferingStatus;
      readonly settings: Record<string, unknown>;
    }
  | undefined
> {
  const rows = await tx
    .select({
      id: core.workspace.id,
      slug: core.workspace.slug,
      name: core.workspace.name,
      offeringStatus: core.workspace.offeringStatus,
      settings: core.workspace.settings,
    })
    .from(core.workspace)
    .where(eq(core.workspace.id, ctx.workspaceId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { ...row, settings: (row.settings ?? {}) as Record<string, unknown> };
}

/**
 * Acceptance rows read across members, for the acceptance register (design/04 §7). Identity's
 * `AttestationRepo` answers "what does this member hold", which is the wrong shape for an export
 * that asks "who accepted this document"; rather than widening a repo another package owns, this
 * reads the same table from the other direction.
 */
export interface AcceptanceRow {
  readonly membershipId: string;
  readonly kind: string;
  readonly signedAt: Date;
  readonly evidenceRef: string | null;
  readonly data: unknown;
}

/**
 * The ceiling on an unpaged read. Not a page size: a workspace with more acceptances than this
 * must page, and the service says so rather than silently truncating an evidence export.
 */
export const MAX_REGISTER_ROWS = 10_000;

export class AcceptanceRegisterRepo extends TenantRepo<typeof core.attestation> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(core.attestation, ctx, tx);
  }

  /**
   * The keyset predicate: strictly *after* the cursor in the register's order.
   *
   * Written as a **row-wise comparison** — `(signed_at, membership_id, kind) < (:a, :b, :c)` —
   * and not as a chain of ORs, because that is what makes a tie safe. Postgres compares row
   * constructors lexicographically, so two acceptances sharing a `signed_at` to the microsecond
   * (exactly what happens the moment a version is published and everyone clicks through the gate
   * at once) are still strictly ordered by `membership_id`, then `kind`. A predicate on
   * `signed_at` alone either skips the second of a tied pair or returns the first for ever.
   *
   * Exported so its shape can be asserted without a database.
   */
  static keysetBefore(key: RegisterKey): SQL {
    return sql`(${core.attestation.signedAt}, ${core.attestation.membershipId}, ${core.attestation.kind}) < (${key.signedAt}, ${key.membershipId}::uuid, ${key.kind})`;
  }

  /** The ORDER BY, matching `keysetBefore` column for column. Both change together or neither. */
  static keysetOrder(): SQL[] {
    return [
      desc(core.attestation.signedAt),
      desc(core.attestation.membershipId),
      desc(core.attestation.kind),
    ];
  }

  /**
   * One page of live acceptances whose kind is `<slug>:v<n>` for one of `slugs`, newest first.
   *
   * Paginates in the database (E1.6 as-built: "worth pushing into the repo when that package is
   * next opened"). `limit` is the number of *rows read*, not the number of entries the service
   * emits — the service drops rows whose kind does not parse — so the cursor is always derived
   * from the last row this method returned, never from the last entry the caller kept. Otherwise
   * a page whose tail was all unparseable would restart from the wrong place.
   */
  async page(input: {
    readonly slugs: readonly string[];
    readonly membershipId?: string | undefined;
    readonly after?: RegisterKey | undefined;
    readonly limit: number;
  }): Promise<AcceptanceRow[]> {
    if (input.slugs.length === 0) return [];
    const patterns = input.slugs.map((s) => sql`${core.attestation.kind} LIKE ${`${s}:v%`}`);
    const anySlug = patterns.reduce((acc, p) => sql`${acc} OR ${p}`);
    const where = and(
      isNull(core.attestation.revokedAt),
      sql`(${anySlug})`,
      input.membershipId === undefined
        ? undefined
        : eq(core.attestation.membershipId, input.membershipId),
      input.after === undefined ? undefined : AcceptanceRegisterRepo.keysetBefore(input.after),
    );
    return this.tx
      .select({
        membershipId: core.attestation.membershipId,
        kind: core.attestation.kind,
        signedAt: core.attestation.signedAt,
        evidenceRef: core.attestation.evidenceRef,
        data: core.attestation.data,
      })
      .from(core.attestation)
      .where(this.scope(where))
      .orderBy(...AcceptanceRegisterRepo.keysetOrder())
      .limit(input.limit);
  }

  /** Every live acceptance for these slugs, unpaged. Kept for callers that want the lot. */
  async list(slugs: readonly string[], membershipId?: string): Promise<AcceptanceRow[]> {
    return this.page({
      slugs,
      ...(membershipId === undefined ? {} : { membershipId }),
      limit: MAX_REGISTER_ROWS,
    });
  }
}

/**
 * The legal documents named by live `nda` access-policy gates that stand, right now, between this
 * membership and something it could otherwise reach (E3.5 fixes A7/B3; FX2A). The answer is the
 * authorization kernel's own, never a parallel reading of the grant tables: the member's access is
 * evaluated with `computeEffectiveRows` — the function `authz.rebuild` materialises — over the
 * live principals, rules and gates, in this transaction, so it is never behind a pending rebuild.
 *
 * A gate counts when:
 *  - it targets the member rather than a node — `workspace`, `membership`, a live `group` they are
 *    in, or a `link` that still binds them (the kernel's `Principal.linkIds`: a live visit on a link
 *    that is `active`, not revoked and not expired) — and its stamp is not held; or
 *  - it targets a `resource` and one of the member's evaluated nodes that still carries a
 *    capability lists it as pending: the member reaches that node (a live allow as themselves, a
 *    group, a live link, their role — resolved with excludes, depth and specificity, and the
 *    staff-only veil) and the NDA is what blocks them. An exclude that removes every capability
 *    at the gated node, a dead link grant, or no grant at all means the NDA is not theirs to read
 *    or to start (its text is not theirs, and each start costs a vendor envelope).
 *
 * The kernel also materialises a row for every gated node one of the member's rules reaches (review
 * AZ), so a gate on a sub-folder of a folder the member was granted — or on one document inside it —
 * blocks them (`AuthzPort.check` answers from that row) and is listed here. Workspaces with no live
 * `nda` gate answer from one indexed probe. Ids only, lower-cased, deduplicated.
 */
export async function ndaGateDocumentIds(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<string[]> {
  const probe = await tx.execute(sql`
    SELECT 1 FROM core.access_policy
     WHERE workspace_id = ${ctx.workspaceId}::uuid AND kind = 'nda' AND revoked_at IS NULL
     LIMIT 1`);
  if (probe.rows.length === 0) return [];
  const gates = (await new PolicyRepo(ctx, tx).listLiveGates()).filter((g) => g.kind === "nda");
  if (gates.length === 0) return [];
  const principal = (await new PrincipalRepo(ctx, tx).listActive()).find(
    (p) => p.membershipId === membershipId,
  );
  if (principal === undefined) return [];
  const now = new Date();
  const ids = new Set<string>();
  const add = (pending: unknown): void => {
    if (!isPendingGate(pending) || pending.kind !== "nda") return;
    const id = pending.detail["documentId"];
    if (typeof id === "string" && UUID_RE.test(id.toLowerCase())) ids.add(id.toLowerCase());
  };
  // Gates on the member (workspace / membership / group / link): `gatesFor` ignores the node.
  const onMember = gates.filter((g) => g.target.kind !== "resource");
  for (const pending of pendingGatesAtRebuild(
    onMember,
    principal,
    { kind: "workspace", id: ctx.workspaceId },
    now,
  ))
    add(pending);
  // Gates on nodes: only where the kernel's evaluation lets the member in but for a gate.
  if (gates.some((g) => g.target.kind === "resource")) {
    const rules = await new GrantRepo(ctx, tx).listLiveRules();
    const staffOnly = await staffOnlyNodes(tx, ctx);
    const locations = await documentFolderPaths(
      tx,
      ctx,
      locatedDocumentIds([principal], rules, gates, staffOnly),
    );
    const rows = computeEffectiveRows([principal], rules, gates, 0, now, locations, staffOnly);
    for (const row of rows) {
      if (row.capabilities.length === 0) continue;
      const pending = Array.isArray(row.pendingGates) ? (row.pendingGates as unknown[]) : [];
      for (const p of pending) add(p);
    }
  }
  return [...ids];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * `kind:id` → the folder path a data-room document sits at — the same lookup the authz rebuild
 * makes (`documentLocations`, not exported by the kernel) so a delegate's document rows and the
 * staff-only veil over documents resolve here exactly as they do there.
 */
async function documentFolderPaths(
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
