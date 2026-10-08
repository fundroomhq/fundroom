import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberNotify } from "./repos/dsar-repo.js";

/*
 * The notify part of a subject-access export (E2.7 DSAR, `modules/notify.json`).
 *
 * Exported — the scope of the erasure handler (`service/lifecycle.ts`):
 *   notificationsReceived  every in-app/email notification addressed to the member, with its
 *                          payload (ids and labels; names are resolved at render time) and
 *                          whether/how it was emailed
 *   notificationsCaused    notifications the member's actions produced for others — only the
 *                          event type, resource and time, never the recipient or payload (that
 *                          is the recipient's data)
 *   digests                digest emails sent to the member
 *   preferences, settings  their cadence choices, time zone, digest hour and quiet hours
 *   channelPosts           Slack posts about the member (event type, payload, status, times)
 *
 * Left out: dedupe keys, retry bookkeeping and provider error codes (pipeline internals), and
 * everything about channels themselves — the webhook URL is a credential, and a channel the
 * member created is workspace configuration, not data about them.
 */
export const notifyDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberNotify(ctx, tx, membershipId),
};
