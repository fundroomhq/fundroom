import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";
import type {
  ActivityKind,
  OrganizationKind,
  StageSeed,
  SubjectKind,
  TransitionCause,
} from "../model.js";
import {
  activity,
  contact,
  note,
  organization,
  pipelineItem,
  pipelineStage,
  stageTransition,
  task,
} from "../schema/crm.js";

/*
 * Repositories over `crm.*` (design/06 §3: the only file in this module that touches drizzle or
 * SQL). Everything runs inside the caller's tenant transaction, so RLS decides what comes back
 * — and in this schema RLS admits staff and system and nobody else, which is why none of these
 * queries re-implement a visibility check in TypeScript.
 *
 * Reads are keyset-paginated on `id`. Ids are uuidv7, so ordering by id is ordering by creation
 * and a cursor is simply the last id of the previous page: no offset, no stable-sort column to
 * keep in step with a filter.
 */

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;

/**
 * `tx.execute()` bypasses drizzle's column mapping, and its raw query config hands timestamptz
 * back as Postgres text ("2026-09-12 10:15:30.123456+00"). Coerced here so nothing downstream
 * ever sees a driver value.
 */
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/** `text[]` comes back as a JS array already; a NULL would only mean a hand-written row. */
const asTags = (v: unknown): string[] => (Array.isArray(v) ? v.map((t) => String(t)) : []);

const nullableDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : asDate(v);

// --- stages -------------------------------------------------------------------------------------

export interface StageRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly isTerminal: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RawStage extends Omit<StageRow, "createdAt" | "updatedAt" | "position"> {
  readonly position: number | string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const hydrateStage = (r: RawStage): StageRow => ({
  id: r.id,
  key: r.key,
  name: r.name,
  position: Number(r.position),
  isTerminal: r.isTerminal,
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

const STAGE_COLUMNS = sql.raw(
  `id, key, name, position, is_terminal AS "isTerminal",
   created_at AS "createdAt", updated_at AS "updatedAt"`,
);

/** What `PUT /crm/stages` resolved one entry of the ladder to. */
export interface StageWrite {
  /** Present when the caller kept an existing row; absent when the stage is new. */
  readonly id?: string | undefined;
  readonly key: string;
  readonly name: string;
  readonly isTerminal: boolean;
  readonly position: number;
}

export class StageRepo extends TenantRepo<typeof pipelineStage> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pipelineStage, ctx, tx);
  }

  async list(): Promise<StageRow[]> {
    return rowsOf<RawStage>(
      await this.tx.execute(sql`
        SELECT ${STAGE_COLUMNS} FROM crm.pipeline_stage
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        ORDER BY position, key`),
    ).map(hydrateStage);
  }

  async findByKey(key: string): Promise<StageRow | undefined> {
    const rows = rowsOf<RawStage>(
      await this.tx.execute(sql`
        SELECT ${STAGE_COLUMNS} FROM crm.pipeline_stage
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND key = ${key}::text`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateStage(row);
  }

  async find(id: string): Promise<StageRow | undefined> {
    const rows = rowsOf<RawStage>(
      await this.tx.execute(sql`
        SELECT ${STAGE_COLUMNS} FROM crm.pipeline_stage
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateStage(row);
  }

  /**
   * Writes the default ladder, once.
   *
   * `ON CONFLICT (workspace_id, key) DO NOTHING` rather than a read-then-write, because two
   * requests can reach an unseeded workspace at the same moment — a staff member opening the
   * board while an outbox handler processes an interest submission is the ordinary case, not a
   * race worth calling rare. The loser of that race inserts nothing and reads the winner's rows.
   */
  async seed(stages: readonly StageSeed[]): Promise<void> {
    if (stages.length === 0) return;
    const values = stages.map(
      (s, i) =>
        sql`(${this.ctx.workspaceId}::uuid, ${s.key}::text, ${s.name}::text, ${i + 1}::integer, ${s.isTerminal}::boolean)`,
    );
    await this.tx.execute(sql`
      INSERT INTO crm.pipeline_stage (workspace_id, key, name, position, is_terminal)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (workspace_id, key) DO NOTHING`);
  }

  /** One row of a ladder replacement; `position` is the caller's 1..n. */
  async upsert(write: StageWrite): Promise<StageRow> {
    const rows =
      write.id === undefined
        ? rowsOf<RawStage>(
            await this.tx.execute(sql`
              INSERT INTO crm.pipeline_stage (workspace_id, key, name, position, is_terminal)
              VALUES (${this.ctx.workspaceId}::uuid, ${write.key}::text, ${write.name}::text,
                      ${write.position}::integer, ${write.isTerminal}::boolean)
              RETURNING ${STAGE_COLUMNS}`),
          )
        : rowsOf<RawStage>(
            await this.tx.execute(sql`
              UPDATE crm.pipeline_stage SET name = ${write.name}::text, position = ${write.position}::integer, is_terminal = ${write.isTerminal}::boolean
              WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${write.id}::uuid
              RETURNING ${STAGE_COLUMNS}`),
          );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.pipeline_stage write returned no row");
    return hydrateStage(row);
  }

  /**
   * Moves the given stages' keys out of the way before a replacement claims them.
   *
   * `(workspace_id, key)` is unique and — unlike `position` — not deferrable, so a tenant who
   * removes `meeting` and adds a new stage also called `meeting` in the same request would
   * collide on the insert before the delete ran. `tmp_<32 hex>` is derived from the row's own
   * id, so it is unique, it satisfies `pipeline_stage_key_format`, and it exists for the few
   * statements between the park and the delete.
   */
  async parkForRemoval(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.tx.execute(sql`
      UPDATE crm.pipeline_stage SET key = 'tmp_' || replace(id::text, '-', '')
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        AND id = ANY(${sql.param([...ids])}::uuid[])`);
  }

  async deleteByIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM crm.pipeline_stage
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND id = ANY(${sql.param([...ids])}::uuid[])
        RETURNING id`),
    );
    return rows.length;
  }

  /** How many live cards sit in each of these stages; the key of the "in use" refusal. */
  async liveItemCounts(stageIds: readonly string[]): Promise<Map<string, number>> {
    if (stageIds.length === 0) return new Map();
    const rows = rowsOf<{ stageId: string; n: number | string }>(
      await this.tx.execute(sql`
        SELECT stage_id AS "stageId", count(*)::int AS n FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND stage_id = ANY(${sql.param([...stageIds])}::uuid[])
        GROUP BY stage_id`),
    );
    return new Map(rows.map((r) => [r.stageId, Number(r.n)]));
  }
}

// --- organisations ------------------------------------------------------------------------------

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly website: string | null;
  readonly kind: OrganizationKind | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewOrganization {
  readonly name: string;
  readonly domain?: string | null | undefined;
  readonly website?: string | null | undefined;
  readonly kind?: OrganizationKind | null | undefined;
  readonly notes?: string | null | undefined;
  readonly createdBy?: string | null | undefined;
}

export interface OrganizationPatch {
  readonly name?: string | undefined;
  readonly domain?: string | null | undefined;
  readonly website?: string | null | undefined;
  readonly kind?: OrganizationKind | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

const ORGANIZATION_COLUMNS = sql.raw(
  `id, name, domain::text AS domain, website, kind, notes,
   created_at AS "createdAt", updated_at AS "updatedAt"`,
);

interface RawOrganization extends Omit<OrganizationRow, "createdAt" | "updatedAt"> {
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const hydrateOrganization = (r: RawOrganization): OrganizationRow => ({
  ...r,
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

/** `%` and `_` escaped so a caller's literal underscore is not a wildcard. */
const likeNeedle = (q: string): string => `%${q.trim().replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;

export class OrganizationRepo extends TenantRepo<typeof organization> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(organization, ctx, tx);
  }

  async list(filter: {
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<OrganizationRow>> {
    const q = filter.q?.trim();
    const rows = rowsOf<RawOrganization>(
      await this.tx.execute(sql`
        SELECT ${ORGANIZATION_COLUMNS} FROM crm.organization
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND (${filter.cursor ?? null}::uuid IS NULL OR id > ${filter.cursor ?? null}::uuid)
          AND (${q === undefined || q === "" ? null : likeNeedle(q)}::text IS NULL
               OR name ILIKE ${q === undefined || q === "" ? null : likeNeedle(q)}::text
               OR domain::text ILIKE ${q === undefined || q === "" ? null : likeNeedle(q)}::text)
        ORDER BY id
        LIMIT ${filter.limit + 1}`),
    );
    const page = rows.slice(0, filter.limit).map(hydrateOrganization);
    return {
      items: page,
      nextCursor: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async find(id: string): Promise<OrganizationRow | undefined> {
    const rows = rowsOf<RawOrganization>(
      await this.tx.execute(sql`
        SELECT ${ORGANIZATION_COLUMNS} FROM crm.organization
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateOrganization(row);
  }

  async byIds(ids: readonly string[]): Promise<OrganizationRow[]> {
    if (ids.length === 0) return [];
    return rowsOf<RawOrganization>(
      await this.tx.execute(sql`
        SELECT ${ORGANIZATION_COLUMNS} FROM crm.organization
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND id = ANY(${sql.param([...ids])}::uuid[])`),
    ).map(hydrateOrganization);
  }

  async insert(o: NewOrganization): Promise<OrganizationRow> {
    const rows = rowsOf<RawOrganization>(
      await this.tx.execute(sql`
        INSERT INTO crm.organization (workspace_id, name, domain, website, kind, notes, created_by)
        VALUES (${this.ctx.workspaceId}::uuid, ${o.name}::text, ${o.domain ?? null}::citext,
                ${o.website ?? null}::text, ${o.kind ?? null}::text, ${o.notes ?? null}::text,
                ${o.createdBy ?? null}::uuid)
        RETURNING ${ORGANIZATION_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.organization insert returned no row");
    return hydrateOrganization(row);
  }

  async update(id: string, patch: OrganizationPatch): Promise<OrganizationRow | undefined> {
    const rows = rowsOf<RawOrganization>(
      await this.tx.execute(sql`
        UPDATE crm.organization SET
          name = COALESCE(${patch.name ?? null}::text, name),
          domain = CASE WHEN ${patch.domain !== undefined}::boolean THEN ${patch.domain ?? null}::citext ELSE domain END,
          website = CASE WHEN ${patch.website !== undefined}::boolean THEN ${patch.website ?? null}::text ELSE website END,
          kind = CASE WHEN ${patch.kind !== undefined}::boolean THEN ${patch.kind ?? null}::text ELSE kind END,
          notes = CASE WHEN ${patch.notes !== undefined}::boolean THEN ${patch.notes ?? null}::text ELSE notes END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING ${ORGANIZATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateOrganization(row);
  }

  async softDelete(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.organization SET deleted_at = now()
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- contacts -----------------------------------------------------------------------------------

export interface ContactRow {
  readonly id: string;
  readonly organizationId: string | null;
  readonly membershipId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly title: string | null;
  readonly tags: string[];
  readonly notes: string | null;
  readonly ownerMembershipId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewContact {
  readonly displayName: string;
  readonly organizationId?: string | null | undefined;
  readonly membershipId?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly notes?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly createdBy?: string | null | undefined;
}

export interface ContactPatch {
  readonly displayName?: string | undefined;
  readonly organizationId?: string | null | undefined;
  readonly membershipId?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly notes?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
}

const CONTACT_COLUMNS = sql.raw(
  `id, organization_id AS "organizationId", membership_id AS "membershipId",
   display_name AS "displayName", email::text AS email, title, tags, notes,
   owner_membership_id AS "ownerMembershipId", created_at AS "createdAt",
   updated_at AS "updatedAt"`,
);

interface RawContact extends Omit<ContactRow, "createdAt" | "updatedAt" | "tags"> {
  readonly tags: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const hydrateContact = (r: RawContact): ContactRow => ({
  ...r,
  tags: asTags(r.tags),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class ContactRepo extends TenantRepo<typeof contact> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(contact, ctx, tx);
  }

  /**
   * The contacts list.
   *
   * `q` is answered two ways at once, deliberately (§C): the generated `search_tsv` for whole
   * words — which is what the GIN index serves and what makes "ada lovelace" find a row whose
   * columns hold the two words apart — and an ILIKE prefix for the half-typed case, because a
   * `plainto_tsquery` of "lov" matches nothing and a search box that goes blank while somebody
   * is still typing reads as "no such person".
   */
  async list(filter: {
    q?: string | undefined;
    organizationId?: string | undefined;
    tag?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<ContactRow>> {
    const q = filter.q?.trim();
    const needle = q === undefined || q === "" ? null : likeNeedle(q);
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND (${filter.cursor ?? null}::uuid IS NULL OR id > ${filter.cursor ?? null}::uuid)
          AND (${filter.organizationId ?? null}::uuid IS NULL
               OR organization_id = ${filter.organizationId ?? null}::uuid)
          AND (${filter.tag ?? null}::text IS NULL OR tags @> ARRAY[${filter.tag ?? null}::text])
          AND (${needle}::text IS NULL
               OR search_tsv @@ plainto_tsquery('simple', ${q ?? ""}::text)
               OR display_name ILIKE ${needle}::text
               OR email::text ILIKE ${needle}::text)
        ORDER BY id
        LIMIT ${filter.limit + 1}`),
    );
    const page = rows.slice(0, filter.limit).map(hydrateContact);
    return {
      items: page,
      nextCursor: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async find(id: string): Promise<ContactRow | undefined> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateContact(row);
  }

  async byIds(ids: readonly string[]): Promise<ContactRow[]> {
    if (ids.length === 0) return [];
    return rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND id = ANY(${sql.param([...ids])}::uuid[])`),
    ).map(hydrateContact);
  }

  /** The link an event handler upserts on: at most one live contact per member. */
  async findByMembership(membershipId: string): Promise<ContactRow | undefined> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${membershipId}::uuid AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateContact(row);
  }

  /**
   * The oldest live contact carrying `email` (citext, so case-insensitively) — how a booking by
   * somebody who is not a live member finds the contact staff typed in by hand (E3.6). Never
   * creates anything: a stranger's booking has no contact to land on.
   */
  async findByEmail(email: string): Promise<ContactRow | undefined> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND email = ${email}::citext AND deleted_at IS NULL
        ORDER BY id
        LIMIT 1`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateContact(row);
  }

  /**
   * Re-reads one live contact under `FOR NO KEY UPDATE` (E3.6). Erasure locks the contacts it
   * pseudonymises `FOR UPDATE` (`ErasureRepo.contactIdsFor`), so a writer that locks first either
   * commits before the erasure reads (and the erasure then removes what it wrote), or waits for it
   * and sees the pseudonymised row.
   */
  async lockLive(id: string): Promise<ContactRow | undefined> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        SELECT ${CONTACT_COLUMNS} FROM crm.contact
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL
        FOR NO KEY UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateContact(row);
  }

  async insert(c: NewContact): Promise<ContactRow> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        INSERT INTO crm.contact (
          workspace_id, organization_id, membership_id, display_name, email, title, tags,
          notes, owner_membership_id, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${c.organizationId ?? null}::uuid,
          ${c.membershipId ?? null}::uuid, ${c.displayName}::text, ${c.email ?? null}::citext,
          ${c.title ?? null}::text, ${sql.param([...(c.tags ?? [])])}::text[],
          ${c.notes ?? null}::text, ${c.ownerMembershipId ?? null}::uuid,
          ${c.createdBy ?? null}::uuid)
        RETURNING ${CONTACT_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.contact insert returned no row");
    return hydrateContact(row);
  }

  async update(id: string, patch: ContactPatch): Promise<ContactRow | undefined> {
    const rows = rowsOf<RawContact>(
      await this.tx.execute(sql`
        UPDATE crm.contact SET
          display_name = COALESCE(${patch.displayName ?? null}::text, display_name),
          organization_id = CASE WHEN ${patch.organizationId !== undefined}::boolean THEN ${patch.organizationId ?? null}::uuid ELSE organization_id END,
          membership_id = CASE WHEN ${patch.membershipId !== undefined}::boolean THEN ${patch.membershipId ?? null}::uuid ELSE membership_id END,
          email = CASE WHEN ${patch.email !== undefined}::boolean THEN ${patch.email ?? null}::citext ELSE email END,
          title = CASE WHEN ${patch.title !== undefined}::boolean THEN ${patch.title ?? null}::text ELSE title END,
          tags = CASE WHEN ${patch.tags !== undefined}::boolean THEN ${sql.param([...(patch.tags ?? [])])}::text[] ELSE tags END,
          notes = CASE WHEN ${patch.notes !== undefined}::boolean THEN ${patch.notes ?? null}::text ELSE notes END,
          owner_membership_id = CASE WHEN ${patch.ownerMembershipId !== undefined}::boolean THEN ${patch.ownerMembershipId ?? null}::uuid ELSE owner_membership_id END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING ${CONTACT_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateContact(row);
  }

  async softDelete(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.contact SET deleted_at = now()
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- pipeline -----------------------------------------------------------------------------------

export interface PipelineItemRow {
  readonly id: string;
  readonly roundId: string | null;
  readonly contactId: string | null;
  readonly organizationId: string | null;
  readonly stageId: string;
  /** Decimal text straight from `numeric(20, 6)`; a **forecast**, never the committed figure. */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly ownerMembershipId: string | null;
  readonly commitmentId: string | null;
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewPipelineItem {
  readonly stageId: string;
  readonly roundId?: string | null | undefined;
  readonly contactId?: string | null | undefined;
  readonly organizationId?: string | null | undefined;
  readonly amount?: string | null | undefined;
  readonly currency?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly commitmentId?: string | null | undefined;
  readonly position?: number | undefined;
  readonly createdBy?: string | null | undefined;
}

export interface PipelineItemPatch {
  readonly stageId?: string | undefined;
  readonly amount?: string | null | undefined;
  readonly currency?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly commitmentId?: string | null | undefined;
  readonly position?: number | undefined;
  readonly organizationId?: string | null | undefined;
}

const ITEM_COLUMNS = sql.raw(
  `id, round_id AS "roundId", contact_id AS "contactId",
   organization_id AS "organizationId", stage_id AS "stageId", amount::text AS amount,
   currency, owner_membership_id AS "ownerMembershipId", commitment_id AS "commitmentId",
   position, created_at AS "createdAt", updated_at AS "updatedAt"`,
);

interface RawItem extends Omit<PipelineItemRow, "createdAt" | "updatedAt" | "position"> {
  readonly position: number | string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const hydrateItem = (r: RawItem): PipelineItemRow => ({
  ...r,
  position: Number(r.position),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

/** `roundId` filter: absent = every card, `null` = the cards attached to no round. */
export type RoundFilter =
  | { readonly kind: "all" }
  | { readonly kind: "one"; readonly id: string | null };

export class PipelineRepo extends TenantRepo<typeof pipelineItem> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pipelineItem, ctx, tx);
  }

  async list(filter: RoundFilter): Promise<PipelineItemRow[]> {
    const all = filter.kind === "all";
    const one = filter.kind === "one" ? filter.id : null;
    return rowsOf<RawItem>(
      await this.tx.execute(sql`
        SELECT ${ITEM_COLUMNS} FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND (${all}::boolean
               OR (${one}::uuid IS NULL AND round_id IS NULL)
               OR round_id = ${one}::uuid)
        ORDER BY position, id`),
    ).map(hydrateItem);
  }

  async find(id: string): Promise<PipelineItemRow | undefined> {
    const rows = rowsOf<RawItem>(
      await this.tx.execute(sql`
        SELECT ${ITEM_COLUMNS} FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateItem(row);
  }

  async listForContact(contactId: string): Promise<PipelineItemRow[]> {
    return rowsOf<RawItem>(
      await this.tx.execute(sql`
        SELECT ${ITEM_COLUMNS} FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND contact_id = ${contactId}::uuid
          AND deleted_at IS NULL
        ORDER BY id`),
    ).map(hydrateItem);
  }

  /** The card an event handler upserts on: one per (round, contact) among live rows. */
  async findForRoundContact(
    roundId: string,
    contactId: string,
  ): Promise<PipelineItemRow | undefined> {
    const rows = rowsOf<RawItem>(
      await this.tx.execute(sql`
        SELECT ${ITEM_COLUMNS} FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
          AND contact_id = ${contactId}::uuid AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateItem(row);
  }

  async findByCommitment(commitmentId: string): Promise<PipelineItemRow | undefined> {
    const rows = rowsOf<RawItem>(
      await this.tx.execute(sql`
        SELECT ${ITEM_COLUMNS} FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND commitment_id = ${commitmentId}::uuid AND deleted_at IS NULL
        ORDER BY id
        LIMIT 1`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateItem(row);
  }

  /** Next free slot at the bottom of a column, so a new card never lands on top of another. */
  async nextPosition(stageId: string): Promise<number> {
    const rows = rowsOf<{ next: number | string }>(
      await this.tx.execute(sql`
        SELECT COALESCE(max(position), 0) + 1 AS next FROM crm.pipeline_item
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND stage_id = ${stageId}::uuid
          AND deleted_at IS NULL`),
    );
    return Number(rows[0]?.next ?? 1);
  }

  async insert(i: NewPipelineItem): Promise<PipelineItemRow> {
    const rows = rowsOf<RawItem>(
      await this.tx.execute(sql`
        INSERT INTO crm.pipeline_item (
          workspace_id, round_id, contact_id, organization_id, stage_id, amount, currency,
          owner_membership_id, commitment_id, position, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${i.roundId ?? null}::uuid, ${i.contactId ?? null}::uuid,
          ${i.organizationId ?? null}::uuid, ${i.stageId}::uuid, ${i.amount ?? null}::numeric,
          ${i.currency ?? null}::text, ${i.ownerMembershipId ?? null}::uuid,
          ${i.commitmentId ?? null}::uuid, ${i.position ?? 0}::integer,
          ${i.createdBy ?? null}::uuid)
        RETURNING ${ITEM_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.pipeline_item insert returned no row");
    return hydrateItem(row);
  }

  async update(id: string, patch: PipelineItemPatch): Promise<PipelineItemRow | undefined> {
    const rows = rowsOf<RawItem>(
      await this.tx.execute(sql`
        UPDATE crm.pipeline_item SET
          stage_id = COALESCE(${patch.stageId ?? null}::uuid, stage_id),
          position = COALESCE(${patch.position ?? null}::integer, position),
          amount = CASE WHEN ${patch.amount !== undefined}::boolean THEN ${patch.amount ?? null}::numeric ELSE amount END,
          currency = CASE WHEN ${patch.currency !== undefined}::boolean THEN ${patch.currency ?? null}::text ELSE currency END,
          owner_membership_id = CASE WHEN ${patch.ownerMembershipId !== undefined}::boolean THEN ${patch.ownerMembershipId ?? null}::uuid ELSE owner_membership_id END,
          commitment_id = CASE WHEN ${patch.commitmentId !== undefined}::boolean THEN ${patch.commitmentId ?? null}::uuid ELSE commitment_id END,
          organization_id = CASE WHEN ${patch.organizationId !== undefined}::boolean THEN ${patch.organizationId ?? null}::uuid ELSE organization_id END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING ${ITEM_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateItem(row);
  }

  /**
   * Re-points **archived** cards off stages that are about to be deleted.
   *
   * `stage_id` is ON DELETE RESTRICT and the restriction does not know about `deleted_at`, so
   * a stage that once held a card the staff have since archived would be undeletable forever.
   * The tombstone keeps its row; only its column changes, and `crm.stage_transition` still
   * holds the key it was actually in — which is where that history belongs anyway. Live cards
   * are never touched: `PUT /crm/stages` refuses outright while any of them are in the way.
   */
  async repointArchived(fromStageIds: readonly string[], toStageId: string): Promise<number> {
    if (fromStageIds.length === 0) return 0;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.pipeline_item SET stage_id = ${toStageId}::uuid
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NOT NULL
          AND stage_id = ANY(${sql.param([...fromStageIds])}::uuid[])
        RETURNING id`),
    );
    return rows.length;
  }

  async softDelete(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.pipeline_item SET deleted_at = now()
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- stage history ------------------------------------------------------------------------------

export interface TransitionRow {
  readonly id: string;
  readonly pipelineItemId: string;
  readonly fromStageId: string | null;
  readonly fromStageKey: string | null;
  readonly toStageId: string;
  readonly toStageKey: string;
  readonly actorMembershipId: string | null;
  readonly cause: TransitionCause;
  readonly createdAt: Date;
}

export interface NewTransition {
  readonly pipelineItemId: string;
  readonly fromStageId?: string | null | undefined;
  readonly fromStageKey?: string | null | undefined;
  readonly toStageId: string;
  readonly toStageKey: string;
  readonly actorMembershipId?: string | null | undefined;
  readonly cause: TransitionCause;
}

const TRANSITION_COLUMNS = sql.raw(
  `id, pipeline_item_id AS "pipelineItemId", from_stage_id AS "fromStageId",
   from_stage_key AS "fromStageKey", to_stage_id AS "toStageId", to_stage_key AS "toStageKey",
   actor_membership_id AS "actorMembershipId", cause, created_at AS "createdAt"`,
);

export class TransitionRepo extends TenantRepo<typeof stageTransition> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(stageTransition, ctx, tx);
  }

  async insert(t: NewTransition): Promise<TransitionRow> {
    const rows = rowsOf<TransitionRow & { createdAt: unknown }>(
      await this.tx.execute(sql`
        INSERT INTO crm.stage_transition (
          workspace_id, pipeline_item_id, from_stage_id, from_stage_key, to_stage_id,
          to_stage_key, actor_membership_id, cause)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${t.pipelineItemId}::uuid,
          ${t.fromStageId ?? null}::uuid, ${t.fromStageKey ?? null}::text, ${t.toStageId}::uuid,
          ${t.toStageKey}::text, ${t.actorMembershipId ?? null}::uuid, ${t.cause}::text)
        RETURNING ${TRANSITION_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.stage_transition insert returned no row");
    return { ...row, createdAt: asDate(row.createdAt) };
  }

  async listForItem(pipelineItemId: string, limit = 50): Promise<TransitionRow[]> {
    return rowsOf<TransitionRow & { createdAt: unknown }>(
      await this.tx.execute(sql`
        SELECT ${TRANSITION_COLUMNS} FROM crm.stage_transition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND pipeline_item_id = ${pipelineItemId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}`),
    ).map((r) => ({ ...r, createdAt: asDate(r.createdAt) }));
  }
}

// --- notes and tasks ----------------------------------------------------------------------------

export interface NoteRow {
  readonly id: string;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly body: string;
  readonly authorMembershipId: string | null;
  readonly createdAt: Date;
}

const NOTE_COLUMNS = sql.raw(
  `id, subject_kind AS "subjectKind", subject_id AS "subjectId", body,
   author_membership_id AS "authorMembershipId", created_at AS "createdAt"`,
);

export class NoteRepo extends TenantRepo<typeof note> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(note, ctx, tx);
  }

  async listFor(subjectKind: SubjectKind, subjectId: string, limit = 200): Promise<NoteRow[]> {
    return rowsOf<NoteRow & { createdAt: unknown }>(
      await this.tx.execute(sql`
        SELECT ${NOTE_COLUMNS} FROM crm.note
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND subject_kind = ${subjectKind}::text AND subject_id = ${subjectId}::uuid
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit}`),
    ).map((r) => ({ ...r, createdAt: asDate(r.createdAt) }));
  }

  async find(id: string): Promise<NoteRow | undefined> {
    const rows = rowsOf<NoteRow & { createdAt: unknown }>(
      await this.tx.execute(sql`
        SELECT ${NOTE_COLUMNS} FROM crm.note
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : { ...row, createdAt: asDate(row.createdAt) };
  }

  async insert(n: {
    subjectKind: SubjectKind;
    subjectId: string;
    body: string;
    authorMembershipId?: string | null | undefined;
  }): Promise<NoteRow> {
    const rows = rowsOf<NoteRow & { createdAt: unknown }>(
      await this.tx.execute(sql`
        INSERT INTO crm.note (workspace_id, subject_kind, subject_id, body, author_membership_id)
        VALUES (${this.ctx.workspaceId}::uuid, ${n.subjectKind}::text, ${n.subjectId}::uuid,
                ${n.body}::text, ${n.authorMembershipId ?? null}::uuid)
        RETURNING ${NOTE_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.note insert returned no row");
    return { ...row, createdAt: asDate(row.createdAt) };
  }

  /** Soft: a note somebody wrote and somebody else read did not stop having been written. */
  async softDelete(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.note SET deleted_at = now()
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid AND deleted_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

export interface TaskRow {
  readonly id: string;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly title: string;
  readonly dueAt: Date | null;
  readonly assigneeMembershipId: string | null;
  readonly doneAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TaskPatch {
  readonly title?: string | undefined;
  readonly dueAt?: Date | null | undefined;
  readonly assigneeMembershipId?: string | null | undefined;
  readonly done?: boolean | undefined;
}

const TASK_COLUMNS = sql.raw(
  `id, subject_kind AS "subjectKind", subject_id AS "subjectId", title, due_at AS "dueAt",
   assignee_membership_id AS "assigneeMembershipId", done_at AS "doneAt",
   created_at AS "createdAt", updated_at AS "updatedAt"`,
);

interface RawTask extends Omit<TaskRow, "dueAt" | "doneAt" | "createdAt" | "updatedAt"> {
  readonly dueAt: unknown;
  readonly doneAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const hydrateTask = (r: RawTask): TaskRow => ({
  ...r,
  dueAt: nullableDate(r.dueAt),
  doneAt: nullableDate(r.doneAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class TaskRepo extends TenantRepo<typeof task> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(task, ctx, tx);
  }

  async listFor(subjectKind: SubjectKind, subjectId: string, limit = 200): Promise<TaskRow[]> {
    return rowsOf<RawTask>(
      await this.tx.execute(sql`
        SELECT ${TASK_COLUMNS} FROM crm.task
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND subject_kind = ${subjectKind}::text AND subject_id = ${subjectId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}`),
    ).map(hydrateTask);
  }

  async find(id: string): Promise<TaskRow | undefined> {
    const rows = rowsOf<RawTask>(
      await this.tx.execute(sql`
        SELECT ${TASK_COLUMNS} FROM crm.task
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateTask(row);
  }

  async insert(t: {
    subjectKind: SubjectKind;
    subjectId: string;
    title: string;
    dueAt?: Date | null | undefined;
    assigneeMembershipId?: string | null | undefined;
    createdBy?: string | null | undefined;
  }): Promise<TaskRow> {
    const rows = rowsOf<RawTask>(
      await this.tx.execute(sql`
        INSERT INTO crm.task (
          workspace_id, subject_kind, subject_id, title, due_at, assignee_membership_id, created_by)
        VALUES (${this.ctx.workspaceId}::uuid, ${t.subjectKind}::text, ${t.subjectId}::uuid,
                ${t.title}::text, ${t.dueAt ?? null}::timestamptz,
                ${t.assigneeMembershipId ?? null}::uuid, ${t.createdBy ?? null}::uuid)
        RETURNING ${TASK_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("crm.task insert returned no row");
    return hydrateTask(row);
  }

  async update(id: string, patch: TaskPatch): Promise<TaskRow | undefined> {
    const rows = rowsOf<RawTask>(
      await this.tx.execute(sql`
        UPDATE crm.task SET
          title = COALESCE(${patch.title ?? null}::text, title),
          due_at = CASE WHEN ${patch.dueAt !== undefined}::boolean THEN ${patch.dueAt ?? null}::timestamptz ELSE due_at END,
          assignee_membership_id = CASE WHEN ${patch.assigneeMembershipId !== undefined}::boolean THEN ${patch.assigneeMembershipId ?? null}::uuid ELSE assignee_membership_id END,
          done_at = CASE WHEN ${patch.done === undefined}::boolean THEN done_at
                         WHEN ${patch.done === true}::boolean THEN COALESCE(done_at, now())
                         ELSE NULL END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${TASK_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateTask(row);
  }

  /** Hard: a task is a reminder, and `crm.task` carries no `deleted_at` for that reason. */
  async remove(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM crm.task
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- DSAR erasure (E2.6) ------------------------------------------------------------------------

/** What an erased contact is called: `contact_display_name_length` forbids an empty name. */
export const ERASED_CONTACT_NAME = "Erased contact";

export interface ErasureCounts {
  readonly contacts: number;
  readonly notes: number;
  readonly tasks: number;
  /** Meeting activities (E3.6): when the person met the company is about them, like a note. */
  readonly activities: number;
}

/**
 * Erasure of one member's CRM footprint (E2.6 decision 5, design/04 §3.2).
 *
 * The contact linked to the membership — live or soft-deleted, since a deleted row still holds
 * the name — is **pseudonymised in place and detached**: name replaced, email, title, notes,
 * tags and organisation cleared, `membership_id` set NULL. In place, because the pipeline cards
 * and their stage history hang off it (`pipeline_item_subject` needs a subject, and the history
 * of a raise is the workspace's record, not the investor's); detached, because the link is what
 * made the pseudonym a person again. What staff *wrote about* them goes entirely: notes and
 * tasks against the contact and against its cards, hard-deleted (a soft delete keeps the words),
 * and (E3.6) the contact's meeting activities — when they met the company is about them too.
 *
 * Idempotent by construction: the second run finds no contact linked to the membership and
 * reports zeros.
 */
export class ErasureRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  /**
   * The contacts that are about `membershipId`, soft-deleted ones included, locked: every contact
   * linked to the membership, plus every **unlinked** contact whose email equals (citext, so
   * case-insensitively) the member's current address or an address on one of their linked
   * contacts. Staff routinely create a contact by hand before (or without) the investor joining,
   * and that row is the same person's data even though nothing links it.
   *
   * A contact linked to a *different* membership is never matched by email: it is that member's.
   */
  async contactIdsFor(membershipId: string, email: string | null): Promise<string[]> {
    return rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        SELECT c.id::text AS id FROM crm.contact c
        WHERE c.workspace_id = ${this.ctx.workspaceId}::uuid
          AND (
            c.membership_id = ${membershipId}::uuid
            OR (
              c.membership_id IS NULL
              AND c.email IS NOT NULL
              AND (
                c.email = ${email}::citext
                OR c.email IN (
                  SELECT l.email FROM crm.contact l
                  WHERE l.workspace_id = ${this.ctx.workspaceId}::uuid
                    AND l.membership_id = ${membershipId}::uuid
                    AND l.email IS NOT NULL
                )
              )
            )
          )
        ORDER BY c.id
        FOR UPDATE OF c`),
    ).map((r) => r.id);
  }

  async eraseContacts(contactIds: readonly string[]): Promise<ErasureCounts> {
    if (contactIds.length === 0) return { contacts: 0, notes: 0, tasks: 0, activities: 0 };
    const ids = sql.param([...contactIds]);
    const itemIds = sql`(
      SELECT id FROM crm.pipeline_item
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND contact_id = ANY(${ids}::uuid[]))`;
    const notes = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM crm.note
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND ((subject_kind = 'contact' AND subject_id = ANY(${ids}::uuid[]))
            OR (subject_kind = 'pipeline_item' AND subject_id IN ${itemIds}))
        RETURNING id`),
    ).length;
    const tasks = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM crm.task
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND ((subject_kind = 'contact' AND subject_id = ANY(${ids}::uuid[]))
            OR (subject_kind = 'pipeline_item' AND subject_id IN ${itemIds}))
        RETURNING id`),
    ).length;
    const activities = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM crm.activity
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND contact_id = ANY(${ids}::uuid[])
        RETURNING id`),
    ).length;
    const contacts = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE crm.contact SET
          display_name = ${ERASED_CONTACT_NAME}::text,
          email = NULL,
          title = NULL,
          notes = NULL,
          tags = '{}',
          organization_id = NULL,
          membership_id = NULL
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ANY(${ids}::uuid[])
        RETURNING id`),
    ).length;
    return { contacts, notes, tasks, activities };
  }
}

// --- activity (E3.6) ----------------------------------------------------------------------------

export interface ActivityRow {
  readonly id: string;
  readonly contactId: string;
  readonly kind: ActivityKind;
  readonly occurredAt: Date;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly title: string | null;
  readonly bookingId: string | null;
  readonly provider: "calendly" | "calcom" | null;
}

export interface NewBookingActivity {
  readonly contactId: string;
  readonly kind: ActivityKind;
  readonly occurredAt: Date;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly title: string | null;
  readonly bookingId: string;
  readonly provider: "calendly" | "calcom";
}

const ACTIVITY_COLUMNS = sql.raw(
  `id, contact_id AS "contactId", kind, occurred_at AS "occurredAt", starts_at AS "startsAt",
   ends_at AS "endsAt", title, booking_id AS "bookingId", provider`,
);

interface RawActivity extends Omit<ActivityRow, "occurredAt" | "startsAt" | "endsAt"> {
  readonly occurredAt: unknown;
  readonly startsAt: unknown;
  readonly endsAt: unknown;
}

const hydrateActivity = (r: RawActivity): ActivityRow => ({
  ...r,
  occurredAt: asDate(r.occurredAt),
  startsAt: asDate(r.startsAt),
  endsAt: nullableDate(r.endsAt),
});

export class ActivityRepo extends TenantRepo<typeof activity> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(activity, ctx, tx);
  }

  /**
   * One row per (booking, kind). A second delivery of the same fact — a redelivered event, the
   * vendor repeating itself, a meeting rescheduled twice — refreshes the meeting's times and
   * title and re-points the row at the contact now matched, but never adds a row. Returns whether
   * a row was *inserted*.
   */
  async upsertForBooking(a: NewBookingActivity): Promise<boolean> {
    const rows = rowsOf<{ inserted: boolean }>(
      await this.tx.execute(sql`
        INSERT INTO crm.activity (
          workspace_id, contact_id, kind, occurred_at, starts_at, ends_at, title, booking_id, provider)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${a.contactId}::uuid, ${a.kind}::text,
          ${a.occurredAt.toISOString()}::timestamptz, ${a.startsAt.toISOString()}::timestamptz,
          ${a.endsAt === null ? null : a.endsAt.toISOString()}::timestamptz, ${a.title}::text,
          ${a.bookingId}::uuid, ${a.provider}::text)
        ON CONFLICT ON CONSTRAINT activity_booking_kind DO UPDATE SET
          contact_id = EXCLUDED.contact_id,
          starts_at = EXCLUDED.starts_at,
          ends_at = EXCLUDED.ends_at,
          title = EXCLUDED.title
        RETURNING (xmax = 0) AS inserted`),
    );
    return rows[0]?.inserted === true;
  }

  /** A contact's timeline, newest first. */
  async listForContact(contactId: string, limit: number): Promise<ActivityRow[]> {
    return rowsOf<RawActivity>(
      await this.tx.execute(sql`
        SELECT ${ACTIVITY_COLUMNS} FROM crm.activity
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND contact_id = ${contactId}::uuid
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limit}`),
    ).map(hydrateActivity);
  }
}
