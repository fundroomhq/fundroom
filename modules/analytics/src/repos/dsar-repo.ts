import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRowsFor } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { asc } from "drizzle-orm";
import {
  event,
  hotLeadAlert,
  pageOpen,
  pageViewer,
  viewerResourceRollup,
  viewSession,
} from "../schema/analytics.js";

/**
 * Everything analytics holds about one member (E2.7 DSAR export; see `../dsar.ts` for what is
 * left out and why). The same tables `eraseMemberRows` deletes, read instead of deleted.
 */
export async function readMemberAnalytics(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const events = await dsarRowsFor(tx, ctx, event, event.membershipId, membershipId, {
    omit: ["workspaceId", "membershipId", "propsSchemaVersion"],
    orderBy: [asc(event.occurredAt), asc(event.id)],
  });
  const sessions = await dsarRowsFor(tx, ctx, viewSession, viewSession.membershipId, membershipId, {
    // `session_key` and `ip_hash` are keyed hashes: identifiers of the pipeline, not facts.
    omit: ["workspaceId", "membershipId", "sessionKey", "ipHash"],
    orderBy: [asc(viewSession.startedAt), asc(viewSession.id)],
  });
  const pageOpens = await dsarRowsFor(tx, ctx, pageOpen, pageOpen.membershipId, membershipId, {
    omit: ["workspaceId", "membershipId"],
    orderBy: [asc(pageOpen.firstAt), asc(pageOpen.resourceId), asc(pageOpen.pageNo)],
  });
  const rollups = await dsarRowsFor(
    tx,
    ctx,
    viewerResourceRollup,
    viewerResourceRollup.membershipId,
    membershipId,
    {
      omit: ["workspaceId", "membershipId"],
      orderBy: [asc(viewerResourceRollup.firstAt), asc(viewerResourceRollup.resourceId)],
    },
  );
  const pagesRead = await dsarRowsFor(tx, ctx, pageViewer, pageViewer.membershipId, membershipId, {
    omit: ["workspaceId", "membershipId"],
    orderBy: [asc(pageViewer.resourceId), asc(pageViewer.versionKey), asc(pageViewer.pageNo)],
  });
  const hotLead = await dsarRowsFor(
    tx,
    ctx,
    hotLeadAlert,
    hotLeadAlert.membershipId,
    membershipId,
    { omit: ["workspaceId", "membershipId"] },
  );
  return {
    version: 1,
    events: events.rows,
    viewSessions: sessions.rows,
    pageOpens: pageOpens.rows,
    resourceRollups: rollups.rows,
    pagesRead: pagesRead.rows,
    hotLeadAlerts: hotLead.rows,
    truncated:
      events.truncated ||
      sessions.truncated ||
      pageOpens.truncated ||
      rollups.truncated ||
      pagesRead.truncated,
  };
}
