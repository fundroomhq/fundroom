import { bumpAcl, GrantRepo } from "@fundroom/authz";
import { core, type OfferingStatus, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { parseInviteGrants } from "@fundroom/domain";
import { and, count, desc, eq, gt, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import {
  LINK_POLICY_SCHEMA_VERSION,
  normalizeLinkPolicy,
  SHARE_LINK_STATUSES,
  type ShareLinkStatus,
} from "../policy.js";
import {
  type CreateShareLinkValues,
  type LinkRecord,
  type LinkSummary,
  type LinkVisit,
  type ListFilter,
  type ShareLinkStore,
  toLinkSummary,
  type ViewSessionKey,
  type VisitClaim,
  type WriteLinkGrantsInput,
} from "../service/types.js";

const { shareLink, shareLinkView, shareLinkVisit, workspace } = core;

/*
 * Data access over `core.share_link`, `core.share_link_visit` and `core.share_link_view`
 * (migration `core/0008_share_links.sql` — the SQL is authoritative).
 *
 * This is the only file in the package that imports drizzle (the `only-repos-touch-drizzle`
 * rule); everything else goes through `ShareLinkStore`.
 *
 * Four things this file exists to get right:
 *
 * 1. **Counters are claimed, never read-then-written.** `max_uses` and `max_views` are the two
 *    numbers an attacker wants to beat, and `SELECT uses; if (uses < max) UPDATE uses = uses + 1`
 *    loses the race whenever two redemptions arrive together — both read 4, both write 5, and a
 *    link capped at 5 has admitted six people. Every increment here is a single
 *    `UPDATE … SET uses = uses + 1 WHERE … uses < max_uses RETURNING uses`: the guard and the
 *    write are one statement under one row lock, and "no row returned" *is* the refusal. Nothing
 *    above this file may decide a cap from a snapshot it read earlier. `claimViewSession` is the
 *    same idiom in insert form — `INSERT … ON CONFLICT DO NOTHING RETURNING` against
 *    `core.share_link_view`, where a returned row means "this session had not been counted yet".
 *
 * 2. **The query builder, never `tx.execute`.** The raw path returns `timestamptz` as *text*
 *    (ADR-0036, learned in E1.5), and `expires_at` / `passcode_locked_until` are compared against
 *    a `Date` by the admission rules — a string there is a wrong verdict, not a formatting bug,
 *    and unit tests that never touch a database would stay green through it.
 *
 * 3. **The plaintext token never arrives here.** Callers pass `sha256(token)`; the column is
 *    `bytea` with a unique index, so the lookup is one indexed equality on
 *    `share_link_token_hash_idx` and no query log can ever hold the token itself.
 *
 * 4. **A row is mapped, not handed out.** The service works on `LinkRecord`, this package's own
 *    shape, so a column A adds is a change here and nowhere else — and so a `LinkSummary` cannot
 *    accidentally carry `token_hash` or `passcode_hash` to a route.
 *
 * `TenantRepo.scope()` adds `workspace_id = ctx.workspaceId` on top of RLS, so the planner uses
 * the workspace-leading indexes and a foreign workspace cannot even be expressed.
 */

type ShareLinkRow = typeof shareLink.$inferSelect;
type ShareLinkVisitRow = typeof shareLinkVisit.$inferSelect;

/**
 * Narrows a row's status into the union `policy.ts` declares, so the two cannot drift silently.
 * `core.share_link_status` is the source of the value; a status this package has never heard of
 * means the enum grew without the rules being told, and the only safe reading of an unknown
 * status is "not active".
 */
function statusOf(raw: string): ShareLinkStatus {
  return SHARE_LINK_STATUSES.find((s) => s === raw) ?? "revoked";
}

export function toLinkRecord(row: ShareLinkRow): LinkRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    status: statusOf(row.status),
    policy: normalizeLinkPolicy(row.policy),
    grants: parseInviteGrants(row.grants),
    groupIds: row.groupIds,
    passcodeHash: row.passcodeHash,
    passcodeAttempts: row.passcodeAttempts,
    passcodeLockedUntil: row.passcodeLockedUntil,
    maxUses: row.maxUses,
    uses: row.uses,
    maxViews: row.maxViews,
    views: row.views,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function toLinkVisit(row: ShareLinkVisitRow): LinkVisit {
  return {
    id: row.id,
    membershipId: row.membershipId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    views: row.views,
    revokedAt: row.revokedAt,
  };
}

export class ShareLinkRepo extends TenantRepo<typeof shareLink> implements ShareLinkStore {
  constructor(ctx: TenantContext, tx: Tx) {
    super(shareLink, ctx, tx);
  }

  async create(values: CreateShareLinkValues): Promise<LinkRecord> {
    const row = await this.insertOne({
      label: values.label,
      tokenHash: Buffer.from(values.tokenHash),
      status: "active",
      policy: values.policy,
      policySchemaVersion: LINK_POLICY_SCHEMA_VERSION,
      grants: values.grants,
      groupIds: [...values.groupIds],
      passcodeHash: values.passcodeHash === null ? null : Buffer.from(values.passcodeHash),
      maxUses: values.maxUses,
      maxViews: values.maxViews,
      expiresAt: values.expiresAt,
      createdBy: values.createdBy,
    });
    return toLinkRecord(row);
  }

  async byId(id: string): Promise<LinkRecord | undefined> {
    const rows = await this.tx
      .select()
      .from(shareLink)
      .where(this.scope(eq(shareLink.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toLinkRecord(row);
  }

  /**
   * The resolution lookup. Takes the **digest**, never the token: the plaintext must not reach a
   * bound parameter a slow-query log would keep, and there is nothing to compare in constant time
   * because the index does the comparison.
   */
  async byTokenHash(hash: Uint8Array): Promise<LinkRecord | undefined> {
    const rows = await this.tx
      .select()
      .from(shareLink)
      .where(this.scope(eq(shareLink.tokenHash, Buffer.from(hash))))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toLinkRecord(row);
  }

  async list(filter: ListFilter = {}): Promise<readonly LinkSummary[]> {
    const rows = await this.tx
      .select({ link: shareLink, visits: count(shareLinkVisit.id) })
      .from(shareLink)
      .leftJoin(
        shareLinkVisit,
        and(eq(shareLinkVisit.linkId, shareLink.id), isNull(shareLinkVisit.revokedAt)),
      )
      .where(
        this.scope(
          and(
            filter.status === undefined ? undefined : eq(shareLink.status, filter.status),
            filter.includeRevoked === true ? undefined : isNull(shareLink.revokedAt),
          ),
        ),
      )
      .groupBy(shareLink.id)
      .orderBy(desc(shareLink.createdAt))
      .limit(filter.limit ?? 200);
    return rows.map((r) => toLinkSummary(toLinkRecord(r.link), r.visits));
  }

  /**
   * **The use claim.** One statement: the cap is the `WHERE`, the increment is the `SET`, and the
   * returned row is the proof that this caller — and not the three others that arrived in the
   * same millisecond — got the seat. `undefined` means the link is spent, paused, revoked or
   * expired, all of which the service collapses into `not_found`.
   *
   * The liveness predicates are repeated here rather than trusted from the snapshot the caller
   * read: between `resolve()` and `redeem()` an admin may have revoked the link, and the whole
   * point of D8 is that one write stops everyone.
   */
  async claimUse(id: string, now: Date): Promise<number | undefined> {
    const rows = await this.tx
      .update(shareLink)
      .set({ uses: sql`${shareLink.uses} + 1` })
      .where(this.scope(and(eq(shareLink.id, id), liveAt(now), underUseCap())))
      .returning({ uses: shareLink.uses });
    return rows[0]?.uses;
  }

  /** The same claim for `max_views`. `undefined` = the view budget is spent. */
  async claimView(id: string, now: Date): Promise<number | undefined> {
    const rows = await this.tx
      .update(shareLink)
      .set({ views: sql`${shareLink.views} + 1` })
      .where(this.scope(and(eq(shareLink.id, id), liveAt(now), underViewCap())))
      .returning({ views: shareLink.views });
    return rows[0]?.views;
  }

  /**
   * Binds a membership to a link, or touches the binding that is already there.
   *
   * `inserted` is read from `xmax = 0`, Postgres's own answer to "did this `ON CONFLICT` insert or
   * update", because it is the only answer that stays correct under concurrency: a `SELECT` first
   * and an `INSERT` after is two statements and two chances to both decide "new". It is what
   * gates the use claim — `max_uses` counts **distinct memberships admitted**, so a visitor
   * returning on a second device must not spend a second seat.
   *
   * A revoked binding is *not* resurrected here; `revoked_at` comes back so the service can
   * refuse. Un-revoking on re-redemption would let a visitor an admin had individually removed
   * walk straight back in by re-opening the URL they still have.
   */
  async upsertVisit(input: {
    readonly linkId: string;
    readonly membershipId: string;
    readonly now: Date;
    readonly passcodeOkAt?: Date | null | undefined;
  }): Promise<VisitClaim> {
    const rows = await this.tx
      .insert(shareLinkVisit)
      .values({
        workspaceId: this.ctx.workspaceId,
        linkId: input.linkId,
        membershipId: input.membershipId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        passcodeOkAt: input.passcodeOkAt ?? null,
      })
      .onConflictDoUpdate({
        target: [shareLinkVisit.linkId, shareLinkVisit.membershipId],
        set: { lastSeenAt: input.now },
      })
      .returning({
        visitId: shareLinkVisit.id,
        revokedAt: shareLinkVisit.revokedAt,
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const row = rows[0];
    if (row === undefined) throw new Error("share_link_visit upsert returned no row");
    return { visitId: row.visitId, inserted: row.inserted, revokedAt: row.revokedAt };
  }

  /**
   * **The session claim** — the statement that makes `max_views` mean "unique sessions" rather
   * than "unique sessions since this process last started".
   *
   * `INSERT … ON CONFLICT DO NOTHING RETURNING`: a returned row means `(link, membership,
   * session)` was not in `core.share_link_view` and now is, so this view is the session's first
   * and the increment may proceed; no row means the session had already been counted. One
   * statement, so two concurrent requests of the same session cannot both be first — the loser's
   * insert conflicts rather than reading a row the winner has not written yet — and the answer
   * is a row, so a restart or a second node reads the same one.
   *
   * It runs in the caller's transaction with the increment it gates, which is what makes the
   * pair atomic: a rolled-back view un-claims its session too.
   */
  async claimViewSession(input: ViewSessionKey): Promise<boolean> {
    const rows = await this.tx
      .insert(shareLinkView)
      .values({
        workspaceId: this.ctx.workspaceId,
        linkId: input.linkId,
        membershipId: input.membershipId,
        sessionId: input.sessionId,
        firstSeenAt: input.now,
      })
      .onConflictDoNothing({
        target: [shareLinkView.linkId, shareLinkView.membershipId, shareLinkView.sessionId],
      })
      .returning({ sessionId: shareLinkView.sessionId });
    return rows.length > 0;
  }

  /**
   * `+1 view` on one membership's binding. The dedup is **not** here — it is `claimViewSession`
   * above, one statement earlier in the same transaction — because this counter is per binding
   * and the budget is per link, and only the first needs to be found by (link, membership).
   */
  async countVisitView(linkId: string, membershipId: string, now: Date): Promise<boolean> {
    const rows = await this.tx
      .update(shareLinkVisit)
      .set({ views: sql`${shareLinkVisit.views} + 1`, lastSeenAt: now })
      .where(
        and(
          eq(shareLinkVisit.workspaceId, this.ctx.workspaceId),
          eq(shareLinkVisit.linkId, linkId),
          eq(shareLinkVisit.membershipId, membershipId),
          isNull(shareLinkVisit.revokedAt),
        ),
      )
      .returning({ id: shareLinkVisit.id });
    return rows.length > 0;
  }

  /**
   * Writes the passcode's HMAC once the row — and therefore the id its scope contains — exists.
   * A second statement in the same transaction as `create`, so both commit or neither does.
   */
  async setPasscodeHash(id: string, hash: Uint8Array): Promise<LinkRecord | undefined> {
    const rows = await this.tx
      .update(shareLink)
      .set({ passcodeHash: Buffer.from(hash) })
      .where(this.scope(eq(shareLink.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toLinkRecord(row);
  }

  /**
   * Counts one passcode attempt, atomically, and returns the new total. Called **before** the
   * comparison, so a process that dies between the attempt and the verdict has still spent the
   * attempt — the opposite order gives an attacker a free guess per crash.
   */
  async recordPasscodeAttempt(id: string, now: Date): Promise<number | undefined> {
    const rows = await this.tx
      .update(shareLink)
      .set({ passcodeAttempts: sql`${shareLink.passcodeAttempts} + 1` })
      .where(this.scope(and(eq(shareLink.id, id), liveAt(now))))
      .returning({ attempts: shareLink.passcodeAttempts });
    return rows[0]?.attempts;
  }

  /**
   * Locks the link out of passcode checks until `until`, **and resets the counter**. The lock is
   * the punishment; a counter left at the ceiling would make the first attempt after the lock
   * expired instantly "locked" again, and the link would never accept its passcode a second time.
   */
  async lockPasscode(id: string, until: Date): Promise<void> {
    await this.tx
      .update(shareLink)
      .set({ passcodeLockedUntil: until, passcodeAttempts: 0 })
      .where(this.scope(eq(shareLink.id, id)));
  }

  /** A correct passcode clears the counter, so honest typos never accumulate into a lockout. */
  async clearPasscodeAttempts(id: string): Promise<void> {
    await this.tx
      .update(shareLink)
      .set({ passcodeAttempts: 0, passcodeLockedUntil: null })
      .where(this.scope(eq(shareLink.id, id)));
  }

  /**
   * `active|paused → revoked`. One write; `PrincipalRepo` stops emitting the `link` subject and
   * everyone the link admitted loses it (D8). The `WHERE` makes it idempotent — a second revoke
   * returns `undefined` rather than moving `revoked_at` forward and lying about when sharing
   * stopped.
   */
  async revoke(id: string, at: Date, by: string | null): Promise<LinkRecord | undefined> {
    const rows = await this.tx
      .update(shareLink)
      .set({ status: "revoked", revokedAt: at, revokedBy: by })
      .where(this.scope(and(eq(shareLink.id, id), isNull(shareLink.revokedAt))))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toLinkRecord(row);
  }

  /** `active ↔ paused`. Reversible, and deliberately indistinguishable from gone to a visitor. */
  async setPaused(id: string, paused: boolean): Promise<LinkRecord | undefined> {
    const from: ShareLinkStatus = paused ? "active" : "paused";
    const rows = await this.tx
      .update(shareLink)
      .set({ status: paused ? "paused" : "active" })
      .where(
        this.scope(
          and(eq(shareLink.id, id), eq(shareLink.status, from), isNull(shareLink.revokedAt)),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toLinkRecord(row);
  }

  /** Revokes one membership's binding without touching the link (§13.2's per-visitor removal). */
  async revokeVisit(linkId: string, membershipId: string, at: Date): Promise<boolean> {
    const rows = await this.tx
      .update(shareLinkVisit)
      .set({ revokedAt: at })
      .where(
        and(
          eq(shareLinkVisit.workspaceId, this.ctx.workspaceId),
          eq(shareLinkVisit.linkId, linkId),
          eq(shareLinkVisit.membershipId, membershipId),
          isNull(shareLinkVisit.revokedAt),
        ),
      )
      .returning({ id: shareLinkVisit.id });
    return rows.length > 0;
  }

  /** Every live binding of one link, oldest first: the "who came in through this" list. */
  async visits(linkId: string): Promise<readonly LinkVisit[]> {
    const rows = await this.tx
      .select()
      .from(shareLinkVisit)
      .where(
        and(
          eq(shareLinkVisit.workspaceId, this.ctx.workspaceId),
          eq(shareLinkVisit.linkId, linkId),
          isNull(shareLinkVisit.revokedAt),
        ),
      )
      .orderBy(shareLinkVisit.firstSeenAt);
    return rows.map(toLinkVisit);
  }

  /**
   * The workspace's offering status, for the shape rule in `linkPolicyPermitted` (D6).
   *
   * A read of `core.workspace` rather than a dependency on `@fundroom/compliance`: the rule this
   * package implements is stricter than `permits(status).shareLinks` and takes a `LinkPolicy`,
   * which compliance has no business knowing about. One column, one row, on the mint path only.
   */
  async offeringStatus(): Promise<OfferingStatus | undefined> {
    const rows = await this.tx
      .select({ offeringStatus: workspace.offeringStatus })
      .from(workspace)
      .where(and(eq(workspace.id, this.ctx.workspaceId), isNull(workspace.deletedAt)))
      .limit(1);
    return rows[0]?.offeringStatus;
  }

  /**
   * The link's grants, written **against the link** (contract §2).
   *
   * `GrantRepo` rather than a statement of our own, deliberately: `core.access_grant` carries a
   * partial unique index over (subject, resource, capability) for live rows, so a repeat is a
   * revoke **and** an insert rather than an update, and that rule belongs in the one class that
   * owns the table. A freshly minted link can have no prior live rule — its id did not exist a
   * statement ago — so in practice each call here is an insert; using the upsert anyway means a
   * future "edit a link's grants" reuses the rule instead of rediscovering it.
   *
   * This is the only place in the system that writes a `subject_kind = 'link'` grant, and it runs
   * exactly once per link.
   */
  async writeLinkGrants(input: WriteLinkGrantsInput): Promise<number> {
    const grants = new GrantRepo(this.ctx, this.tx);
    let written = 0;
    for (const g of input.grants) {
      for (const capability of g.capabilities) {
        await grants.upsert({
          subject: { kind: "link", id: input.linkId },
          resource: g.resource,
          capability,
          ...(g.validUntil === undefined ? {} : { validUntil: new Date(g.validUntil) }),
          note: input.note,
          ...(input.createdBy === null ? {} : { createdBy: input.createdBy }),
        });
        written += 1;
      }
    }
    return written;
  }

  /**
   * Bumps `core.workspace.acl_version` and publishes `acl.changed` in the caller's transaction
   * (E3.13 R3-6): the effective-access rebuild and the external engine's sync both follow the
   * event, so a pause/resume/revoke reaches them without waiting for a reconciler.
   */
  async bumpAcl(cause: string): Promise<void> {
    await bumpAcl(this.tx, this.ctx, cause);
  }
}

/** `status = 'active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`. */
function liveAt(now: Date): SQL | undefined {
  return and(
    eq(shareLink.status, "active"),
    isNull(shareLink.revokedAt),
    or(isNull(shareLink.expiresAt), gt(shareLink.expiresAt, now)),
  );
}

/** `max_uses IS NULL OR uses < max_uses`, column-to-column so the guard rides the row lock. */
function underUseCap(): SQL | undefined {
  return or(isNull(shareLink.maxUses), lt(shareLink.uses, shareLink.maxUses));
}

function underViewCap(): SQL | undefined {
  return or(isNull(shareLink.maxViews), lt(shareLink.views, shareLink.maxViews));
}

/**
 * E3.13: whether `membershipId` is bound (a non-revoked `share_link_visit`) to a non-revoked link
 * whose policy forces the visible watermark. Reads through the SECURITY DEFINER function
 * `core.share_link_forced_watermark` (0026) because the viewer's own external context cannot see
 * `core.share_link`; the function refuses any workspace but the transaction's current one, so the
 * caller's `tx` must be fenced to `workspaceId`. One boolean, no timestamps (the raw path is safe).
 */
export async function readForcedWatermark(
  tx: Tx,
  workspaceId: string,
  membershipId: string,
): Promise<boolean> {
  const result = await tx.execute<{ forced: boolean }>(
    sql`SELECT core.share_link_forced_watermark(${workspaceId}::uuid, ${membershipId}::uuid) AS forced`,
  );
  return result.rows[0]?.forced === true;
}
