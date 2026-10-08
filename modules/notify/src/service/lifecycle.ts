import { findWorkspaceById, type TenantContext, type Tx } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import {
  ChannelDeliveryRepo,
  ChannelRepo,
  DigestRepo,
  NotificationRepo,
  PreferenceRepo,
  SettingsRepo,
} from "../repos/notify-repo.js";
import { DAY_MS } from "../rules.js";

/*
 * The two ways notify data leaves (E2.6): a DSAR erasure of one member, and age.
 */

/**
 * Erases everything this module holds about one member (`member.erasure_requested`): the
 * notifications addressed to them *and* the ones they caused (an investor's name is resolved
 * from `actor_membership_id` at render time, so the id is the personal datum), their digests,
 * preferences and settings, and channel posts about them. A channel they created stays — it is
 * workspace configuration — but forgets its creator. Runs inside the outbox transaction, then
 * reports to the kernel, which completes the request when every module has.
 */
export async function eraseMember(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  requestId: string,
  membershipId: string,
): Promise<Record<string, number>> {
  const notifications = await new NotificationRepo(ctx, tx).deleteForMember(membershipId);
  const counts = {
    notificationsReceived: notifications.recipient,
    notificationsCaused: notifications.actor,
    digests: await new DigestRepo(ctx, tx).deleteForMember(membershipId),
    preferences: await new PreferenceRepo(ctx, tx).deleteForMember(membershipId),
    settings: await new SettingsRepo(ctx, tx).deleteForMember(membershipId),
    channelDeliveries: await new ChannelDeliveryRepo(ctx, tx).deleteForActor(membershipId),
    channelsCreatedBy: await new ChannelRepo(ctx, tx).forgetCreator(membershipId),
  };
  await services.legal.completeErasureStep(tx, ctx, requestId, "notify", counts);
  services.log("notify.erased", { workspaceId: ctx.workspaceId, ...counts });
  return counts;
}

export interface RetentionOutcome {
  readonly skipped: "legal_hold" | null;
  readonly retentionDays: number;
  readonly notifications: number;
  readonly digests: number;
  readonly channelDeliveries: number;
}

const BATCH = 1000;

/**
 * Deletes this workspace's notifications, digests and finished channel posts older than
 * `notify.retentionDays`. Skipped entirely while the workspace is under legal hold: a hold
 * means "delete nothing", and an alert trail is exactly what a litigant asks for.
 */
export async function applyRetention(
  services: ModuleServices,
  ctx: TenantContext,
  now: Date,
): Promise<RetentionOutcome> {
  const ws = await findWorkspaceById(services.db, ctx.workspaceId);
  const settings = parseWorkspaceSettings(ws?.settings);
  const retentionDays = settings.notify.retentionDays;
  const none = { retentionDays, notifications: 0, digests: 0, channelDeliveries: 0 };
  if (settings.legal.legalHold) return { skipped: "legal_hold", ...none };
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let notifications = 0;
  for (;;) {
    const n = await services.db.withTenant(ctx, (tx) =>
      new NotificationRepo(ctx, tx).deleteOlderThan(cutoff, BATCH),
    );
    notifications += n;
    if (n < BATCH) break;
  }
  const { digests, channelDeliveries } = await services.db.withTenant(ctx, async (tx) => ({
    digests: await new DigestRepo(ctx, tx).deleteOlderThan(cutoff),
    channelDeliveries: await new ChannelDeliveryRepo(ctx, tx).deleteOlderThan(cutoff),
  }));
  return { skipped: null, retentionDays, notifications, digests, channelDeliveries };
}
