import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow, dsarRowsFor } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq, ne } from "drizzle-orm";
import { post, recipient, reply, send, unsubscribe } from "../schema/updates.js";

/**
 * Everything updates holds about one member (E2.7 DSAR export; see `../dsar.ts`): the updates
 * mailed to them, their reply thread, and their opt-out.
 */
export async function readMemberUpdates(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const received = await tx
    .select({
      id: recipient.id,
      sendId: recipient.sendId,
      postId: send.postId,
      postTitle: post.title,
      email: recipient.email,
      status: recipient.status,
      sentAt: recipient.sentAt,
      lastEventAt: recipient.lastEventAt,
      createdAt: recipient.createdAt,
    })
    .from(recipient)
    .leftJoin(send, and(eq(send.id, recipient.sendId), eq(send.workspaceId, recipient.workspaceId)))
    .leftJoin(post, and(eq(post.id, send.postId), eq(post.workspaceId, send.workspaceId)))
    .where(
      and(eq(recipient.workspaceId, ctx.workspaceId), eq(recipient.membershipId, membershipId)),
    )
    .orderBy(asc(recipient.createdAt), asc(recipient.id))
    .limit(50_000);
  // Their thread with the company: their own replies and the staff answers addressed to them.
  const thread = await dsarRowsFor(tx, ctx, reply, reply.threadMembershipId, membershipId, {
    omit: ["workspaceId", "threadMembershipId"],
    orderBy: [asc(reply.createdAt), asc(reply.id)],
  });
  // Replies the member (as staff) wrote into *other* members' threads: that they wrote one,
  // and when — the body was addressed to, and is about, somebody else.
  const authoredElsewhere = await tx
    .select({
      id: reply.id,
      postId: reply.postId,
      createdAt: reply.createdAt,
      deletedAt: reply.deletedAt,
    })
    .from(reply)
    .where(
      and(
        eq(reply.workspaceId, ctx.workspaceId),
        eq(reply.authorMembershipId, membershipId),
        ne(reply.threadMembershipId, membershipId),
      ),
    )
    .orderBy(asc(reply.createdAt), asc(reply.id))
    .limit(50_000);
  const optOut = await dsarRowsFor(tx, ctx, unsubscribe, unsubscribe.membershipId, membershipId, {
    omit: ["workspaceId", "membershipId"],
  });
  return {
    version: 1,
    updatesReceived: received.map((r) => dsarRow(r)),
    replyThread: thread.rows,
    repliesWrittenElsewhere: authoredElsewhere.map((r) => dsarRow(r)),
    unsubscribe: optOut.rows[0] ?? null,
    truncated: received.length >= 50_000 || thread.truncated,
  };
}
