import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, arrayContains, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type Cadence,
  type Channel,
  type ChannelDelivery,
  type ChannelDisabledReason,
  channel,
  channelDelivery,
  type Digest,
  digest,
  type EmailOutcome,
  type MemberSettings,
  memberSettings,
  type NewChannel,
  type NewNotification,
  type Notification,
  notification,
  type Preference,
  preference,
} from "../schema/notify.js";

/*
 * Repositories over `notify.*` (design/06 §3: the only place drizzle is touched in this
 * module). Reads carry the workspace fence explicitly on top of RLS; writes force it.
 */
export class PreferenceRepo extends TenantRepo<typeof preference> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(preference, ctx, tx);
  }

  /** event type → cadence for one member (only stored rows; defaults are the caller's). */
  async forMember(membershipId: string): Promise<Map<string, Cadence>> {
    const rows = await this.findMany(eq(preference.membershipId, membershipId));
    return new Map(rows.map((r) => [r.eventType, r.cadence]));
  }

  /** membership id → (event type → cadence) for many members in one query. */
  async forMembers(membershipIds: readonly string[]): Promise<Map<string, Map<string, Cadence>>> {
    const out = new Map<string, Map<string, Cadence>>();
    if (membershipIds.length === 0) return out;
    const rows = await this.findMany(inArray(preference.membershipId, [...membershipIds]));
    for (const r of rows) {
      const m = out.get(r.membershipId) ?? new Map<string, Cadence>();
      m.set(r.eventType, r.cadence);
      out.set(r.membershipId, m);
    }
    return out;
  }

  async upsert(membershipId: string, eventType: string, value: Cadence): Promise<Preference> {
    const rows = await this.tx
      .insert(preference)
      .values({ workspaceId: this.ctx.workspaceId, membershipId, eventType, cadence: value })
      .onConflictDoUpdate({
        target: [preference.workspaceId, preference.membershipId, preference.eventType],
        set: { cadence: value, updatedAt: sql`now()` },
      })
      .returning();
    return rows[0] as Preference;
  }

  async deleteForMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .delete(preference)
      .where(this.scope(eq(preference.membershipId, membershipId)))
      .returning({ id: preference.membershipId });
    return rows.length;
  }
}

export interface SettingsPatch {
  readonly emailEnabled?: boolean | undefined;
  readonly timezone?: string | undefined;
  readonly digestHour?: number | undefined;
  readonly weeklyDay?: number | undefined;
  /** `null` clears quiet hours; both ends are written together. */
  readonly quiet?: { readonly start: number; readonly end: number } | null | undefined;
}

export class SettingsRepo extends TenantRepo<typeof memberSettings> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(memberSettings, ctx, tx);
  }

  async forMember(membershipId: string): Promise<MemberSettings | undefined> {
    const rows = await this.findMany(eq(memberSettings.membershipId, membershipId));
    return rows[0];
  }

  async forMembers(membershipIds: readonly string[]): Promise<Map<string, MemberSettings>> {
    if (membershipIds.length === 0) return new Map();
    const rows = await this.findMany(inArray(memberSettings.membershipId, [...membershipIds]));
    return new Map(rows.map((r) => [r.membershipId, r]));
  }

  async upsert(membershipId: string, patch: SettingsPatch): Promise<MemberSettings> {
    const set: Partial<
      Pick<
        MemberSettings,
        "emailEnabled" | "timezone" | "digestHour" | "weeklyDay" | "quietStart" | "quietEnd"
      >
    > = {};
    if (patch.emailEnabled !== undefined) set.emailEnabled = patch.emailEnabled;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.digestHour !== undefined) set.digestHour = patch.digestHour;
    if (patch.weeklyDay !== undefined) set.weeklyDay = patch.weeklyDay;
    if (patch.quiet !== undefined) {
      set.quietStart = patch.quiet === null ? null : patch.quiet.start;
      set.quietEnd = patch.quiet === null ? null : patch.quiet.end;
    }
    const rows = await this.tx
      .insert(memberSettings)
      .values({ workspaceId: this.ctx.workspaceId, membershipId, ...set })
      .onConflictDoUpdate({
        target: [memberSettings.workspaceId, memberSettings.membershipId],
        set: { ...set, updatedAt: sql`now()` },
      })
      .returning();
    return rows[0] as MemberSettings;
  }

  /** Stamps when this member was last served a digest of `kind` (creating the row if needed). */
  async markDigested(membershipId: string, kind: "daily" | "weekly", at: Date): Promise<void> {
    const set = kind === "daily" ? { lastDailyDigestAt: at } : { lastWeeklyDigestAt: at };
    await this.tx
      .insert(memberSettings)
      .values({ workspaceId: this.ctx.workspaceId, membershipId, ...set })
      .onConflictDoUpdate({
        target: [memberSettings.workspaceId, memberSettings.membershipId],
        set,
      });
  }

  async deleteForMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .delete(memberSettings)
      .where(this.scope(eq(memberSettings.membershipId, membershipId)))
      .returning({ id: memberSettings.membershipId });
    return rows.length;
  }
}

/** Keyset position in an inbox: `created_at` at full (microsecond) precision plus the id. */
export interface InboxCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface InboxRow {
  readonly row: Notification;
  /** `created_at` as Postgres prints it in UTC with microseconds — the cursor's first half. */
  readonly key: string;
}

export class NotificationRepo extends TenantRepo<typeof notification> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(notification, ctx, tx);
  }

  async byId(id: string): Promise<Notification | undefined> {
    return this.findById(id);
  }

  /** Inserts unless the dedupe key already exists in the workspace; `undefined` = duplicate. */
  async createUnlessDuplicate(
    values: Omit<NewNotification, "workspaceId">,
  ): Promise<Notification | undefined> {
    const rows = await this.tx
      .insert(notification)
      .values({ ...values, workspaceId: this.ctx.workspaceId })
      .onConflictDoNothing({ target: [notification.workspaceId, notification.dedupeKey] })
      .returning();
    return rows[0];
  }

  /**
   * Unsent rows of one cadence; `before` bounds `created_at`, `readyAt` skips rows deferred by
   * quiet hours or waiting out a retry backoff past that instant, `unattached` skips rows already
   * claimed by a digest. Fewest attempts first, then oldest: rows that keep failing sink below
   * fresh ones, so a batch limit can never be filled by poison alone.
   */
  async pending(
    cadenceIs: Cadence,
    options: {
      before?: Date | undefined;
      readyAt?: Date | undefined;
      membershipId?: string | undefined;
      unattached?: boolean | undefined;
      limit: number;
    },
  ): Promise<Notification[]> {
    const conds = [eq(notification.cadence, cadenceIs), isNull(notification.sentAt)];
    if (options.before !== undefined) conds.push(lt(notification.createdAt, options.before));
    if (options.readyAt !== undefined) {
      const ready = or(
        isNull(notification.deferredUntil),
        lte(notification.deferredUntil, options.readyAt),
      );
      if (ready !== undefined) conds.push(ready);
      const due = or(
        isNull(notification.nextAttemptAt),
        lte(notification.nextAttemptAt, options.readyAt),
      );
      if (due !== undefined) conds.push(due);
    }
    if (options.membershipId !== undefined)
      conds.push(eq(notification.membershipId, options.membershipId));
    if (options.unattached) conds.push(isNull(notification.digestId));
    return this.tx
      .select()
      .from(notification)
      .where(this.scope(and(...conds)))
      .orderBy(asc(notification.attempts), asc(notification.createdAt), asc(notification.id))
      .limit(options.limit);
  }

  /** One row, locked for the rest of the transaction (the claim step of an instant send). */
  async lockById(id: string): Promise<Notification | undefined> {
    const rows = await this.tx
      .select()
      .from(notification)
      .where(this.scope(eq(notification.id, id)))
      .for("update");
    return rows[0];
  }

  /**
   * Claims an unsent row for one send attempt: counts the attempt and pushes `next_attempt_at`
   * out (the backoff, which is also the lease while the send is in flight).
   */
  async claimAttempt(id: string, attempts: number, nextAttemptAt: Date): Promise<boolean> {
    const rows = await this.tx
      .update(notification)
      .set({ attempts, nextAttemptAt })
      .where(this.scope(and(eq(notification.id, id), isNull(notification.sentAt))))
      .returning({ id: notification.id });
    return rows.length === 1;
  }

  /** Records a failed attempt's error code; `terminal` closes the row as `failed`. */
  async recordFailure(id: string, code: string, at: Date, terminal: boolean): Promise<void> {
    await this.tx
      .update(notification)
      .set(
        terminal
          ? { lastError: code, sentAt: at, emailOutcome: "failed", nextAttemptAt: null }
          : { lastError: code },
      )
      .where(this.scope(and(eq(notification.id, id), isNull(notification.sentAt))));
  }

  /** Attaches unsent, unattached rows to a claimed digest. */
  async attachToDigest(ids: readonly string[], digestId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .update(notification)
      .set({ digestId })
      .where(
        this.scope(
          and(
            inArray(notification.id, [...ids]),
            isNull(notification.sentAt),
            isNull(notification.digestId),
          ),
        ),
      )
      .returning({ id: notification.id });
    return rows.length;
  }

  /** The unsent rows a claimed digest carries. */
  async forDigest(digestId: string): Promise<Notification[]> {
    return this.tx
      .select()
      .from(notification)
      .where(this.scope(and(eq(notification.digestId, digestId), isNull(notification.sentAt))))
      .orderBy(asc(notification.createdAt), asc(notification.id));
  }

  /** Members holding unsent rows of a cadence, with their oldest waiting row's time. */
  async membersWithPending(cadenceIs: Cadence): Promise<{ membershipId: string; oldest: Date }[]> {
    const rows = await this.tx
      .select({
        membershipId: notification.membershipId,
        oldest: sql<Date>`min(${notification.createdAt})`.mapWith(notification.createdAt),
      })
      .from(notification)
      .where(this.scope(and(eq(notification.cadence, cadenceIs), isNull(notification.sentAt))))
      .groupBy(notification.membershipId);
    return rows.map((r) => ({ membershipId: r.membershipId, oldest: new Date(r.oldest) }));
  }

  /** Compare-and-set on `sent_at IS NULL`: two workers cannot both send the same row. */
  async markSent(
    id: string,
    at: Date,
    outcome: EmailOutcome,
    digestId: string | null = null,
  ): Promise<boolean> {
    const rows = await this.tx
      .update(notification)
      .set({
        sentAt: at,
        digestId,
        emailOutcome: outcome,
        deferredUntil: null,
        nextAttemptAt: null,
      })
      .where(this.scope(and(eq(notification.id, id), isNull(notification.sentAt))))
      .returning({ id: notification.id });
    return rows.length === 1;
  }

  async markManySent(
    ids: readonly string[],
    at: Date,
    outcome: EmailOutcome,
    digestId: string | null,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .update(notification)
      .set({ sentAt: at, digestId, emailOutcome: outcome, nextAttemptAt: null })
      .where(this.scope(and(inArray(notification.id, [...ids]), isNull(notification.sentAt))))
      .returning({ id: notification.id });
    return rows.length;
  }

  /** Holds an unsent instant row back until `until` (quiet hours). */
  async defer(id: string, until: Date): Promise<void> {
    await this.tx
      .update(notification)
      .set({ deferredUntil: until })
      .where(this.scope(and(eq(notification.id, id), isNull(notification.sentAt))));
  }

  /**
   * One member's inbox, newest first, keyset-paged on (created_at, id). The cursor's
   * `created_at` is the text Postgres printed, so microseconds survive the round trip — a JS
   * `Date` would truncate them and repeat or skip rows at a page boundary.
   */
  async inbox(
    membershipId: string,
    options: {
      limit: number;
      cursor?: InboxCursor | undefined;
      includeArchived?: boolean | undefined;
      unreadOnly?: boolean | undefined;
    },
  ): Promise<InboxRow[]> {
    const conds = [eq(notification.membershipId, membershipId)];
    if (!options.includeArchived) conds.push(isNull(notification.archivedAt));
    if (options.unreadOnly) conds.push(isNull(notification.readAt));
    if (options.cursor !== undefined) {
      conds.push(
        sql`(${notification.createdAt}, ${notification.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }
    const rows = await this.tx
      .select({
        row: notification,
        key: sql<string>`to_char(${notification.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(notification)
      .where(this.scope(and(...conds)))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(options.limit);
    return rows;
  }

  async unreadCount(membershipId: string): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(
        this.scope(
          and(
            eq(notification.membershipId, membershipId),
            isNull(notification.readAt),
            isNull(notification.archivedAt),
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * Marks the member's unread rows read — the given ids, or all of them (optionally only those
   * created at or before `upTo`, so a row that arrived after the screen was drawn stays unread).
   */
  async markRead(
    membershipId: string,
    at: Date,
    ids?: readonly string[],
    upTo?: Date | undefined,
  ): Promise<number> {
    if (ids !== undefined && ids.length === 0) return 0;
    const conds = [eq(notification.membershipId, membershipId), isNull(notification.readAt)];
    if (ids !== undefined) conds.push(inArray(notification.id, [...ids]));
    if (upTo !== undefined) conds.push(lte(notification.createdAt, upTo));
    const rows = await this.tx
      .update(notification)
      .set({ readAt: at })
      .where(this.scope(and(...conds)))
      .returning({ id: notification.id });
    return rows.length;
  }

  /** Archives (or un-archives) the member's own rows; archiving also marks them read. */
  async setArchived(
    membershipId: string,
    ids: readonly string[],
    archived: boolean,
    at: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .update(notification)
      .set(
        archived
          ? {
              archivedAt: at,
              readAt: sql`coalesce(${notification.readAt}, ${at.toISOString()}::timestamptz)`,
            }
          : { archivedAt: null },
      )
      .where(
        this.scope(
          and(eq(notification.membershipId, membershipId), inArray(notification.id, [...ids])),
        ),
      )
      .returning({ id: notification.id });
    return rows.length;
  }

  /** Erasure: every row addressed to the member or caused by them. */
  async deleteForMember(membershipId: string): Promise<{ recipient: number; actor: number }> {
    const recipient = await this.tx
      .delete(notification)
      .where(this.scope(eq(notification.membershipId, membershipId)))
      .returning({ id: notification.id });
    const actor = await this.tx
      .delete(notification)
      .where(this.scope(eq(notification.actorMembershipId, membershipId)))
      .returning({ id: notification.id });
    return { recipient: recipient.length, actor: actor.length };
  }

  /** Retention: rows created before `cutoff`, in batches. */
  async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
    const ids = this.tx
      .select({ id: notification.id })
      .from(notification)
      .where(this.scope(lt(notification.createdAt, cutoff)))
      .limit(limit);
    const rows = await this.tx
      .delete(notification)
      .where(this.scope(inArray(notification.id, ids)))
      .returning({ id: notification.id });
    return rows.length;
  }
}

export class DigestRepo extends TenantRepo<typeof digest> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(digest, ctx, tx);
  }

  /**
   * Claims the digest for (member, kind, slot): inserts it unsent, or `undefined` when a row for
   * that slot already exists (a racing run, or a slot already served).
   */
  async claim(values: {
    membershipId: string;
    kind: "daily" | "weekly";
    slot: string;
    periodStart: Date;
    periodEnd: Date;
    count: number;
  }): Promise<Digest | undefined> {
    const rows = await this.tx
      .insert(digest)
      .values({ ...values, workspaceId: this.ctx.workspaceId, sentAt: null })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }

  /** The member's oldest claimed-but-unsent digest of `kind`, locked. */
  async unsent(membershipId: string, kind: "daily" | "weekly"): Promise<Digest | undefined> {
    const rows = await this.tx
      .select()
      .from(digest)
      .where(
        this.scope(
          and(eq(digest.membershipId, membershipId), eq(digest.kind, kind), isNull(digest.sentAt)),
        ),
      )
      .orderBy(asc(digest.periodEnd))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async setAttempts(id: string, attempts: number, count: number): Promise<void> {
    await this.tx
      .update(digest)
      .set({ attempts, count })
      .where(this.scope(eq(digest.id, id)));
  }

  async markSent(id: string, sentAt: Date, messageId: string | null): Promise<boolean> {
    const rows = await this.tx
      .update(digest)
      .set({ sentAt, messageId })
      .where(this.scope(and(eq(digest.id, id), isNull(digest.sentAt))))
      .returning({ id: digest.id });
    return rows.length === 1;
  }

  async remove(id: string): Promise<void> {
    await this.tx.delete(digest).where(this.scope(eq(digest.id, id)));
  }

  async forMember(membershipId: string): Promise<Digest[]> {
    return this.tx
      .select()
      .from(digest)
      .where(this.scope(eq(digest.membershipId, membershipId)))
      .orderBy(desc(digest.sentAt));
  }

  async deleteForMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .delete(digest)
      .where(this.scope(eq(digest.membershipId, membershipId)))
      .returning({ id: digest.id });
    return rows.length;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.tx
      .delete(digest)
      .where(
        this.scope(
          sql`coalesce(${digest.sentAt}, ${digest.periodEnd}) < ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: digest.id });
    return rows.length;
  }
}

export class ChannelRepo extends TenantRepo<typeof channel> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(channel, ctx, tx);
  }

  list(): Promise<Channel[]> {
    return this.tx
      .select()
      .from(channel)
      .where(this.scope())
      .orderBy(asc(channel.createdAt), asc(channel.id));
  }

  byId(id: string): Promise<Channel | undefined> {
    return this.findById(id);
  }

  /** The Slack app channel posting to `slackChannelId` (E3.6; at most one per workspace). */
  async bySlackChannelId(slackChannelId: string): Promise<Channel | undefined> {
    const rows = await this.tx
      .select()
      .from(channel)
      .where(
        this.scope(and(eq(channel.kind, "slack_app"), eq(channel.slackChannelId, slackChannelId))),
      )
      .limit(1);
    return rows[0];
  }

  count(): Promise<number> {
    return this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(channel)
      .where(this.scope())
      .then((r) => r[0]?.n ?? 0);
  }

  create(values: Omit<NewChannel, "workspaceId">): Promise<Channel> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    set: Partial<
      Pick<
        Channel,
        | "name"
        | "urlEnc"
        | "encryption"
        | "urlHint"
        | "slackChannelId"
        | "slackChannelName"
        | "eventTypes"
        | "enabled"
        | "failureCount"
        | "disabledReason"
        | "lastError"
      >
    >,
  ): Promise<Channel | undefined> {
    const rows = await this.tx
      .update(channel)
      .set(set)
      .where(this.scope(eq(channel.id, id)))
      .returning();
    return rows[0];
  }

  async remove(id: string): Promise<boolean> {
    return (await this.deleteById(id)) === 1;
  }

  /** Enabled channels subscribed to `eventType`. */
  forEventType(eventType: string): Promise<Channel[]> {
    return this.tx
      .select()
      .from(channel)
      .where(
        this.scope(and(eq(channel.enabled, true), arrayContains(channel.eventTypes, [eventType]))),
      );
  }

  async recordSuccess(id: string, at: Date): Promise<void> {
    await this.tx
      .update(channel)
      .set({ lastSuccessAt: at, lastError: null, failureCount: 0 })
      .where(this.scope(eq(channel.id, id)));
  }

  /**
   * Counts a permanent failure; at `disableAfter` consecutive ones the channel switches itself
   * off. Returns whether *this* call disabled it (so the caller audits once).
   */
  async recordPermanentFailure(
    id: string,
    reason: ChannelDisabledReason,
    error: string,
    disableAfter: number,
  ): Promise<boolean> {
    const rows = await this.tx
      .update(channel)
      .set({ failureCount: sql`${channel.failureCount} + 1`, lastError: error })
      .where(this.scope(eq(channel.id, id)))
      .returning({ failureCount: channel.failureCount, enabled: channel.enabled });
    const r = rows[0];
    if (r === undefined || !r.enabled || r.failureCount < disableAfter) return false;
    await this.tx
      .update(channel)
      .set({ enabled: false, disabledReason: reason })
      .where(this.scope(eq(channel.id, id)));
    return true;
  }

  async recordTransientFailure(id: string, error: string): Promise<void> {
    await this.tx
      .update(channel)
      .set({ lastError: error })
      .where(this.scope(eq(channel.id, id)));
  }

  /** Erasure: forget who created a channel (the channel itself is workspace configuration). */
  async forgetCreator(membershipId: string): Promise<number> {
    const rows = await this.tx
      .update(channel)
      .set({ createdBy: null })
      .where(this.scope(eq(channel.createdBy, membershipId)))
      .returning({ id: channel.id });
    return rows.length;
  }
}

export class ChannelDeliveryRepo extends TenantRepo<typeof channelDelivery> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(channelDelivery, ctx, tx);
  }

  /** Queues a post unless this channel already has one for `sourceKey`; true when queued. */
  async enqueue(values: {
    channelId: string;
    sourceKey: string;
    eventType: string;
    actorMembershipId: string | null;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const rows = await this.tx
      .insert(channelDelivery)
      .values({ ...values, workspaceId: this.ctx.workspaceId })
      .onConflictDoNothing({
        target: [channelDelivery.workspaceId, channelDelivery.channelId, channelDelivery.sourceKey],
      })
      .returning({ id: channelDelivery.id });
    return rows.length === 1;
  }

  /**
   * Claims up to `limit` due deliveries (`pending` and due, or `sending` whose claim went stale
   * because a worker died mid-post) with SKIP LOCKED, so two workers never claim the same row.
   * At-least-once: a worker that dies after posting and before recording will be retried.
   */
  async claimDue(now: Date, staleBefore: Date, limit: number): Promise<ChannelDelivery[]> {
    const due = or(
      and(eq(channelDelivery.status, "pending"), lte(channelDelivery.nextAttemptAt, now)),
      and(eq(channelDelivery.status, "sending"), lt(channelDelivery.claimedAt, staleBefore)),
    );
    const ids = await this.tx
      .select({ id: channelDelivery.id })
      .from(channelDelivery)
      .where(this.scope(due))
      .orderBy(channelDelivery.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (ids.length === 0) return [];
    return this.tx
      .update(channelDelivery)
      .set({ status: "sending", claimedAt: now, attempts: sql`${channelDelivery.attempts} + 1` })
      .where(
        this.scope(
          inArray(
            channelDelivery.id,
            ids.map((r) => r.id),
          ),
        ),
      )
      .returning();
  }

  async finish(
    id: string,
    status: "sent" | "failed" | "dropped",
    at: Date,
    error: string | null,
  ): Promise<void> {
    await this.tx
      .update(channelDelivery)
      .set({
        status,
        lastError: error,
        claimedAt: null,
        ...(status === "sent" ? { sentAt: at } : {}),
      })
      .where(this.scope(eq(channelDelivery.id, id)));
  }

  async retryAt(id: string, next: Date, error: string): Promise<void> {
    await this.tx
      .update(channelDelivery)
      .set({ status: "pending", nextAttemptAt: next, lastError: error, claimedAt: null })
      .where(this.scope(eq(channelDelivery.id, id)));
  }

  /** Drops everything still queued for a channel (it was disabled or deleted). */
  async dropQueued(channelId: string, reason: string): Promise<number> {
    const rows = await this.tx
      .update(channelDelivery)
      .set({ status: "dropped", lastError: reason, claimedAt: null })
      .where(
        this.scope(
          and(
            eq(channelDelivery.channelId, channelId),
            inArray(channelDelivery.status, ["pending", "sending"]),
          ),
        ),
      )
      .returning({ id: channelDelivery.id });
    return rows.length;
  }

  async deleteForActor(membershipId: string): Promise<number> {
    const rows = await this.tx
      .delete(channelDelivery)
      .where(this.scope(eq(channelDelivery.actorMembershipId, membershipId)))
      .returning({ id: channelDelivery.id });
    return rows.length;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.tx
      .delete(channelDelivery)
      .where(
        this.scope(
          and(
            lt(channelDelivery.createdAt, cutoff),
            inArray(channelDelivery.status, ["sent", "failed", "dropped"]),
          ),
        ),
      )
      .returning({ id: channelDelivery.id });
    return rows.length;
  }
}
