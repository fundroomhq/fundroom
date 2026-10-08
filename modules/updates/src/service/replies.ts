import { systemContext, type TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, UpdatesError } from "../errors.js";
import { PostRepo, ReplyRepo } from "../repos/updates-repo.js";

/*
 * Reply threads (design/03 C1 "replies land in a thread visible to authors"; design/04
 * MNPI: no reply-all). One private thread per (post, investor): the investor sees their own
 * thread, staff see every thread. RLS enforces the investor side; the service adds names.
 */
export interface ThreadReply {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly authorName: string;
  readonly authorKind: "staff" | "external";
  readonly body: string;
  readonly createdAt: Date;
}

export interface Thread {
  readonly membershipId: string;
  readonly displayName: string;
  readonly replies: readonly ThreadReply[];
}

export function createReplyService(services: ModuleServices) {
  const { db } = services;

  return {
    async list(ctx: TenantContext, postId: string): Promise<Thread[]> {
      const rows = await db.withTenant(ctx, async (tx) => {
        const p = await new PostRepo(ctx, tx).live(postId);
        if (p === undefined) throw new UpdatesError("not_found", "no such update");
        return new ReplyRepo(ctx, tx).forPost(postId);
      });
      // A second transaction *after* the first closed: never hold one pool connection while
      // waiting for another (a burst of readers would deadlock the pool).
      const ids = [...new Set(rows.flatMap((r) => [r.threadMembershipId, r.authorMembershipId]))];
      const sys = systemContext(ctx.workspaceId);
      const names = await db.withTenant(sys, (t) => new MembershipRepo(sys, t).namesFor(ids));
      const threads = new Map<string, Thread>();
      for (const r of rows) {
        let thread = threads.get(r.threadMembershipId);
        if (thread === undefined) {
          thread = {
            membershipId: r.threadMembershipId,
            displayName: names.get(r.threadMembershipId)?.displayName ?? "Member",
            replies: [],
          };
          threads.set(r.threadMembershipId, thread);
        }
        const author = names.get(r.authorMembershipId);
        (thread.replies as ThreadReply[]).push({
          id: r.id,
          authorMembershipId: r.authorMembershipId,
          authorName: author?.displayName ?? "Member",
          authorKind: author?.kind ?? "external",
          body: r.body,
          createdAt: r.createdAt,
        });
      }
      return [...threads.values()];
    },

    async create(
      ctx: TenantContext,
      postId: string,
      input: { body: string; threadMembershipId?: string | undefined },
      actor: Actor & { kind: "staff" | "external" },
    ): Promise<ThreadReply> {
      const body = input.body.trim();
      if (body.length === 0 || body.length > 5000)
        throw new UpdatesError("validation_failed", "reply must be 1–5000 characters");
      const thread = actor.kind === "staff" ? input.threadMembershipId : actor.membershipId;
      if (thread === undefined)
        throw new UpdatesError("validation_failed", "threadMembershipId is required");
      const r = await db.withTenant(ctx, async (tx) => {
        // For an external actor RLS makes the post invisible unless they are in its audience.
        const p = await new PostRepo(ctx, tx).live(postId);
        if (p === undefined) throw new UpdatesError("not_found", "no such update");
        const r = await new ReplyRepo(ctx, tx).create({
          postId,
          threadMembershipId: thread,
          authorMembershipId: actor.membershipId,
          body,
        });
        await services.audit.record(tx, ctx, {
          action: "update.replied",
          resourceKind: "reply",
          resourceId: r.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          subjectMembershipId: thread,
          meta: { postId, chars: body.length },
        });
        await publish(tx, ctx, "update.replied", {
          postId,
          replyId: r.id,
          threadMembershipId: thread,
          authorMembershipId: actor.membershipId,
        });
        return r;
      });
      // The author's name is read in a second transaction *after* the reply tx committed:
      // opening it inside would hold one pool connection while waiting for another (E2.7 H3 —
      // a 1-connection pool deadlocks).
      const sys = systemContext(ctx.workspaceId);
      const names = await db.withTenant(sys, (t) =>
        new MembershipRepo(sys, t).namesFor([actor.membershipId]),
      );
      const me = names.get(actor.membershipId);
      return {
        id: r.id,
        authorMembershipId: r.authorMembershipId,
        authorName: me?.displayName ?? "Member",
        authorKind: actor.kind,
        body: r.body,
        createdAt: r.createdAt,
      };
    },
  };
}

export type ReplyService = ReturnType<typeof createReplyService>;
