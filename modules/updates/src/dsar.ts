import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberUpdates } from "./repos/dsar-repo.js";

/*
 * The updates part of a subject-access export (E2.7 DSAR, `modules/updates.json`).
 *
 * Exported:
 *   updatesReceived          every investor update mailed to the member: which post (id and
 *                            title), the address it went to, delivery status and times
 *   replyThread              the member's reply thread — their replies and the staff answers to
 *                            them (author ids only, never staff names)
 *   repliesWrittenElsewhere  for a staff member: that they replied in another member's thread,
 *                            and when — not the body, which was written to somebody else
 *   unsubscribe              their opt-out, if any (source and time)
 *
 * Left out: the provider message id and error text (delivery plumbing), send-level counts (the
 * workspace's record of a broadcast to everyone), and posts a staff member authored — company
 * content, not data about the author.
 */
export const updatesDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberUpdates(ctx, tx, membershipId),
};
