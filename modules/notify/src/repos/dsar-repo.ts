import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow, dsarRowsFor } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq, ne } from "drizzle-orm";
import {
  channelDelivery,
  digest,
  memberSettings,
  notification,
  preference,
} from "../schema/notify.js";

/**
 * Everything notify holds about one member (E2.7 DSAR export; see `../dsar.ts`). The same scope
 * as `eraseMember`: what they received, what they caused, their digests, preferences, settings
 * and channel posts about them.
 */
export async function readMemberNotify(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const received = await dsarRowsFor(
    tx,
    ctx,
    notification,
    notification.membershipId,
    membershipId,
    {
      omit: ["workspaceId", "membershipId", "payloadSchemaVersion", "dedupeKey", "lastError"],
      orderBy: [asc(notification.createdAt), asc(notification.id)],
    },
  );
  // Notifications the member caused, addressed to somebody else: the fact that they caused it
  // is theirs; who received it, and what it said to that person, is not.
  const causedRows = await tx
    .select({
      id: notification.id,
      eventType: notification.eventType,
      resourceKind: notification.resourceKind,
      resourceId: notification.resourceId,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .where(
      and(
        eq(notification.workspaceId, ctx.workspaceId),
        eq(notification.actorMembershipId, membershipId),
        ne(notification.membershipId, membershipId),
      ),
    )
    .orderBy(asc(notification.createdAt), asc(notification.id))
    .limit(50_000);
  const digests = await dsarRowsFor(tx, ctx, digest, digest.membershipId, membershipId, {
    omit: ["workspaceId", "membershipId"],
    orderBy: [asc(digest.periodStart), asc(digest.id)],
  });
  const preferences = await dsarRowsFor(
    tx,
    ctx,
    preference,
    preference.membershipId,
    membershipId,
    { omit: ["workspaceId", "membershipId"], orderBy: [asc(preference.eventType)] },
  );
  const settings = await dsarRowsFor(
    tx,
    ctx,
    memberSettings,
    memberSettings.membershipId,
    membershipId,
    { omit: ["workspaceId", "membershipId"] },
  );
  const channelPosts = await dsarRowsFor(
    tx,
    ctx,
    channelDelivery,
    channelDelivery.actorMembershipId,
    membershipId,
    {
      // Which channel, and its delivery bookkeeping, is workspace configuration.
      omit: [
        "workspaceId",
        "actorMembershipId",
        "channelId",
        "sourceKey",
        "payloadSchemaVersion",
        "attempts",
        "nextAttemptAt",
        "claimedAt",
        "lastError",
      ],
      orderBy: [asc(channelDelivery.createdAt), asc(channelDelivery.id)],
    },
  );
  return {
    version: 1,
    notificationsReceived: received.rows,
    notificationsCaused: causedRows.map((r) => dsarRow(r)),
    digests: digests.rows,
    preferences: preferences.rows,
    settings: settings.rows[0] ?? null,
    channelPosts: channelPosts.rows,
    truncated: received.truncated || digests.truncated || channelPosts.truncated,
  };
}
