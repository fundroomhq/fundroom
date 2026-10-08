import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  type NewPost,
  type NewPostVersion,
  type NewRecipient,
  type NewSend,
  type NewSendingDomain,
  type Post,
  type PostState,
  type PostVersion,
  post,
  postVersion,
  type Recipient,
  type RecipientStatus,
  type Reply,
  recipient,
  reply,
  type Send,
  type SendingDomain,
  type SendStatus,
  send,
  sendingDomain,
  type Unsubscribe,
  type UnsubscribeSource,
  unsubscribe,
} from "../schema/updates.js";

/*
 * Repositories over `updates.*` (design/06 §3: the only place drizzle is touched in this
 * module). Reads carry the workspace fence explicitly on top of RLS; writes force it.
 */
export class PostRepo extends TenantRepo<typeof post> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(post, ctx, tx);
  }

  async live(id: string): Promise<Post | undefined> {
    const rows = await this.findMany(and(eq(post.id, id), isNull(post.deletedAt)));
    return rows[0];
  }

  async bySlug(slug: string): Promise<Post | undefined> {
    const rows = await this.findMany(and(eq(post.slug, slug), isNull(post.deletedAt)));
    return rows[0];
  }

  async list(): Promise<Post[]> {
    return this.tx
      .select()
      .from(post)
      .where(this.scope(isNull(post.deletedAt)))
      .orderBy(desc(sql`COALESCE(${post.sentAt}, ${post.scheduledFor}, ${post.updatedAt})`));
  }

  /** Sent posts visible to the current actor (RLS filters the audience for externals). */
  async archive(): Promise<Post[]> {
    return this.tx
      .select()
      .from(post)
      .where(this.scope(and(isNull(post.deletedAt), eq(post.state, "sent"))))
      .orderBy(desc(post.sentAt));
  }

  /**
   * The newest sent posts, newest first (E3.12 AI draft: the caller picks the newest one whose
   * published version went to everyone — see `modules/updates/src/ai/task.ts`).
   */
  async recentSent(limit: number): Promise<Post[]> {
    return this.tx
      .select()
      .from(post)
      .where(this.scope(and(isNull(post.deletedAt), eq(post.state, "sent"))))
      .orderBy(sql`${post.sentAt} DESC NULLS LAST`)
      .limit(limit);
  }

  /** Scheduled posts whose time has come (the dispatcher runs as system per workspace). */
  async due(now: Date): Promise<Post[]> {
    return this.findMany(
      and(isNull(post.deletedAt), eq(post.state, "scheduled"), lte(post.scheduledFor, now)),
    );
  }

  create(values: Omit<NewPost, "workspaceId">): Promise<Post> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Post,
        | "title"
        | "slug"
        | "state"
        | "doc"
        | "docSchemaVersion"
        | "visibility"
        | "audience"
        | "scheduledFor"
        | "publishedVersionId"
        | "sentAt"
        | "savedAt"
        | "deletedAt"
      >
    >,
  ): Promise<Post | undefined> {
    const rows = await this.tx
      .update(post)
      .set(patch)
      .where(this.scope(eq(post.id, id)))
      .returning();
    return rows[0];
  }

  /** Compare-and-set on the state column so two workers cannot both start a send. */
  async transition(
    id: string,
    from: PostState,
    to: PostState,
    patch: Partial<Pick<Post, "sentAt" | "scheduledFor">> = {},
  ): Promise<Post | undefined> {
    const rows = await this.tx
      .update(post)
      .set({ state: to, ...patch })
      .where(this.scope(and(eq(post.id, id), eq(post.state, from))))
      .returning();
    return rows[0];
  }
}

export class VersionRepo extends TenantRepo<typeof postVersion> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(postVersion, ctx, tx);
  }

  byId(id: string): Promise<PostVersion | undefined> {
    return this.findById(id);
  }

  async forPost(postId: string): Promise<PostVersion[]> {
    return this.tx
      .select()
      .from(postVersion)
      .where(this.scope(eq(postVersion.postId, postId)))
      .orderBy(desc(postVersion.versionNo));
  }

  async nextNo(postId: string): Promise<number> {
    const rows = await this.tx
      .select({ max: sql<number>`COALESCE(MAX(${postVersion.versionNo}), 0)` })
      .from(postVersion)
      .where(this.scope(eq(postVersion.postId, postId)));
    return Number(rows[0]?.max ?? 0) + 1;
  }

  create(values: Omit<NewPostVersion, "workspaceId">): Promise<PostVersion> {
    return this.insertOne(values);
  }
}

export class SendRepo extends TenantRepo<typeof send> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(send, ctx, tx);
  }

  byId(id: string): Promise<Send | undefined> {
    return this.findById(id);
  }

  async forPost(postId: string): Promise<Send[]> {
    return this.tx
      .select()
      .from(send)
      .where(this.scope(eq(send.postId, postId)))
      .orderBy(desc(send.createdAt));
  }

  /** Sends that never finished (worker died); the dispatcher re-enqueues them. */
  async stale(olderThan: Date): Promise<Send[]> {
    return this.findMany(
      and(inArray(send.status, ["queued", "running"]), lte(send.createdAt, olderThan)),
    );
  }

  create(values: Omit<NewSend, "workspaceId">): Promise<Send> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Send,
        "status" | "total" | "sent" | "failed" | "skipped" | "error" | "startedAt" | "finishedAt"
      >
    >,
  ): Promise<Send | undefined> {
    const rows = await this.tx
      .update(send)
      .set(patch)
      .where(this.scope(eq(send.id, id)))
      .returning();
    return rows[0];
  }

  async setStatus(
    id: string,
    from: SendStatus,
    to: SendStatus,
    patch: Partial<Pick<Send, "startedAt">> = {},
  ): Promise<Send | undefined> {
    const rows = await this.tx
      .update(send)
      .set({ status: to, ...patch })
      .where(this.scope(and(eq(send.id, id), eq(send.status, from))))
      .returning();
    return rows[0];
  }

  /**
   * Moves one recipient between the send's feedback buckets (E2.6): `-1` on the bucket it left
   * (when it was one of the three), `+1` on the one it entered. Deltas rather than a recount so
   * two events for two different recipients of one send cannot overwrite each other's count.
   */
  async shiftFeedback(id: string, from: RecipientStatus, to: RecipientStatus): Promise<void> {
    const delta = (bucket: "delivered" | "bounced" | "complained") =>
      (to === bucket ? 1 : 0) - (from === bucket ? 1 : 0);
    const d = delta("delivered");
    const b = delta("bounced");
    const c = delta("complained");
    if (d === 0 && b === 0 && c === 0) return;
    await this.tx
      .update(send)
      .set({
        delivered: sql`GREATEST(${send.delivered} + ${d}, 0)`,
        bounced: sql`GREATEST(${send.bounced} + ${b}, 0)`,
        complained: sql`GREATEST(${send.complained} + ${c}, 0)`,
      })
      .where(this.scope(eq(send.id, id)));
  }
}

export class RecipientRepo extends TenantRepo<typeof recipient> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(recipient, ctx, tx);
  }

  async forSend(sendId: string): Promise<Recipient[]> {
    return this.tx
      .select()
      .from(recipient)
      .where(this.scope(eq(recipient.sendId, sendId)))
      .orderBy(asc(recipient.email));
  }

  /**
   * The next `queued` rows of a send, leaving out `exclude` — the rows this run already tried
   * and left queued (a transient failure, or a row another run holds), so one run never spins
   * on them.
   */
  async queued(
    sendId: string,
    limit: number,
    exclude: readonly string[] = [],
  ): Promise<Recipient[]> {
    return this.tx
      .select()
      .from(recipient)
      .where(
        this.scope(
          and(
            eq(recipient.sendId, sendId),
            eq(recipient.status, "queued"),
            exclude.length > 0 ? notInArray(recipient.id, [...exclude]) : undefined,
          ),
        ),
      )
      .orderBy(asc(recipient.id))
      .limit(limit);
  }

  /**
   * Claims one recipient for sending: the row, **locked** for the rest of the transaction, if it
   * is still `queued` and no other transaction holds it (`SKIP LOCKED`); otherwise `undefined`.
   * The delivery path sends and records the outcome inside that transaction, so two runs of one
   * send (a pg-boss retry and the dispatcher's stale re-enqueue) can never both hand the same
   * recipient to the mailer: the loser skips it, and once the winner commits it is not `queued`.
   */
  async claimQueued(id: string): Promise<Recipient | undefined> {
    const rows = await this.tx
      .select()
      .from(recipient)
      .where(this.scope(and(eq(recipient.id, id), eq(recipient.status, "queued"))))
      .for("update", { skipLocked: true });
    return rows[0];
  }

  /** A row's committed status, without waiting on anyone's lock. */
  async statusOf(id: string): Promise<RecipientStatus | undefined> {
    const rows = await this.tx
      .select({ status: recipient.status })
      .from(recipient)
      .where(this.scope(eq(recipient.id, id)));
    return rows[0]?.status;
  }

  async counts(sendId: string): Promise<Record<RecipientStatus, number>> {
    const rows = await this.tx
      .select({ status: recipient.status, n: sql<number>`count(*)` })
      .from(recipient)
      .where(this.scope(eq(recipient.sendId, sendId)))
      .groupBy(recipient.status);
    const out: Record<RecipientStatus, number> = {
      queued: 0,
      sent: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      bounced: 0,
      complained: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  async createMany(values: readonly Omit<NewRecipient, "workspaceId">[]): Promise<number> {
    if (values.length === 0) return 0;
    const rows = await this.tx
      .insert(recipient)
      .values(values.map((v) => ({ ...v, workspaceId: this.ctx.workspaceId })))
      .onConflictDoNothing()
      .returning({ id: recipient.id });
    return rows.length;
  }

  async mark(
    id: string,
    patch: Partial<Pick<Recipient, "status" | "messageId" | "error" | "sentAt" | "lastEventAt">>,
  ): Promise<void> {
    await this.tx
      .update(recipient)
      .set(patch)
      .where(this.scope(eq(recipient.id, id)));
  }

  /**
   * The recipient rows a provider message id names, **locked** for the rest of the transaction
   * (E2.6). Two delivery events for one address (a `delivered` and a late `bounce`, delivered by
   * two workers) are serialised on this row lock, so the ladder decision and the send counter
   * delta that follows it are taken against a status nobody else is moving.
   */
  async lockByMessageId(messageId: string): Promise<Recipient[]> {
    return this.tx
      .select()
      .from(recipient)
      .where(this.scope(eq(recipient.messageId, messageId)))
      .for("update");
  }

  /** Moves a row's status and stamps `last_event_at`, never backwards in time. */
  async applyFeedback(
    id: string,
    patch: { readonly status?: RecipientStatus | undefined; readonly error?: string | undefined },
    at: Date,
  ): Promise<void> {
    await this.tx
      .update(recipient)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        lastEventAt: sql`GREATEST(COALESCE(${recipient.lastEventAt}, ${at}::timestamptz), ${at}::timestamptz)`,
      })
      .where(this.scope(eq(recipient.id, id)));
  }

  /**
   * DSAR erasure (E2.6 decision 5): replaces a member's recipient addresses with a
   * pseudonym unique per row (`recipient_unique` is `(send_id, email)`), and drops an error
   * string that quotes an address (an SMTP 550 often does). Rows, statuses and therefore every
   * send's counts are kept: that a message went to *somebody* is the workspace's record, who it
   * was is the member's. Rows already pseudonymised are left alone, so a redelivered request
   * reports zero the second time.
   */
  async pseudonymiseMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .update(recipient)
      .set({
        email: sql`'erased+' || ${recipient.id}::text || '@erased.invalid'`,
        error: sql`CASE WHEN ${recipient.error} LIKE '%@%' THEN 'redacted' ELSE ${recipient.error} END`,
      })
      .where(
        this.scope(
          and(
            eq(recipient.membershipId, membershipId),
            sql`${recipient.email}::text NOT LIKE '%@erased.invalid'`,
          ),
        ),
      )
      .returning({ id: recipient.id });
    return rows.length;
  }
}

export class ReplyRepo extends TenantRepo<typeof reply> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(reply, ctx, tx);
  }

  /** Every live reply on a post (RLS narrows an external actor to its own thread). */
  async forPost(postId: string): Promise<Reply[]> {
    return this.tx
      .select()
      .from(reply)
      .where(this.scope(and(eq(reply.postId, postId), isNull(reply.deletedAt))))
      .orderBy(asc(reply.createdAt));
  }

  create(values: {
    postId: string;
    threadMembershipId: string;
    authorMembershipId: string;
    body: string;
  }): Promise<Reply> {
    return this.insertOne(values);
  }

  /**
   * DSAR erasure (E2.6): every reply in the member's own threads — theirs, and staff's answers
   * to them, which are written *to* the person and routinely name them — plus anything they
   * wrote elsewhere, blanked and soft-deleted. The rows stay so thread counts and audit
   * references resolve; the words go. Already-erased rows are skipped (idempotent).
   */
  async eraseMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .update(reply)
      .set({ body: ERASED_REPLY_BODY, deletedAt: sql`COALESCE(${reply.deletedAt}, now())` })
      .where(
        this.scope(
          and(
            or(
              eq(reply.threadMembershipId, membershipId),
              eq(reply.authorMembershipId, membershipId),
            ),
            sql`${reply.body} <> ${ERASED_REPLY_BODY}`,
          ),
        ),
      )
      .returning({ id: reply.id });
    return rows.length;
  }
}

/** What an erased reply's body becomes (`reply_body_length` forbids an empty string). */
export const ERASED_REPLY_BODY = "[erased]";

/** What an erased member's opt-out records instead of their address (`email` is NOT NULL). */
export const ERASED_UNSUBSCRIBE_EMAIL = "erased@erased.invalid";

export class UnsubscribeRepo extends TenantRepo<typeof unsubscribe> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(unsubscribe, ctx, tx);
  }

  async byMembership(membershipId: string): Promise<Unsubscribe | undefined> {
    const rows = await this.findMany(eq(unsubscribe.membershipId, membershipId));
    return rows[0];
  }

  async membershipIds(): Promise<Set<string>> {
    const rows = await this.tx
      .select({ id: unsubscribe.membershipId })
      .from(unsubscribe)
      .where(this.scope());
    return new Set(rows.map((r) => r.id));
  }

  async add(membershipId: string, email: string, source: UnsubscribeSource): Promise<boolean> {
    const rows = await this.tx
      .insert(unsubscribe)
      .values({ workspaceId: this.ctx.workspaceId, membershipId, email, source })
      .onConflictDoNothing()
      .returning({ id: unsubscribe.membershipId });
    return rows.length > 0;
  }

  /**
   * DSAR erasure (E2.6): the opt-out stays (it is keyed and looked up by membership id), the
   * address it recorded goes. Already-pseudonymised rows are left alone (idempotent).
   */
  async pseudonymiseMember(membershipId: string): Promise<number> {
    const rows = await this.tx
      .update(unsubscribe)
      .set({ email: ERASED_UNSUBSCRIBE_EMAIL })
      .where(
        this.scope(
          and(
            eq(unsubscribe.membershipId, membershipId),
            sql`${unsubscribe.email} <> ${ERASED_UNSUBSCRIBE_EMAIL}::citext`,
          ),
        ),
      )
      .returning({ id: unsubscribe.membershipId });
    return rows.length;
  }

  async remove(membershipId: string): Promise<boolean> {
    const rows = await this.tx
      .delete(unsubscribe)
      .where(this.scope(eq(unsubscribe.membershipId, membershipId)))
      .returning({ id: unsubscribe.membershipId });
    return rows.length > 0;
  }
}

export class SendingDomainRepo extends TenantRepo<typeof sendingDomain> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(sendingDomain, ctx, tx);
  }

  async current(): Promise<SendingDomain | undefined> {
    const rows = await this.findMany();
    return rows[0];
  }

  create(values: Omit<NewSendingDomain, "workspaceId">): Promise<SendingDomain> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<SendingDomain, "status" | "checks" | "lastCheckedAt" | "lastError" | "verifiedAt">
    >,
  ): Promise<SendingDomain | undefined> {
    const rows = await this.tx
      .update(sendingDomain)
      .set(patch)
      .where(this.scope(eq(sendingDomain.id, id)))
      .returning();
    return rows[0];
  }

  remove(id: string): Promise<number> {
    return this.deleteById(id);
  }
}
