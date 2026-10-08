import type { ModulePortability, PortableImportContext } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";

/*
 * Workspace export/import (E2.8). Every notify table travels as rows, in FK order, but a copy
 * of a workspace must never send mail or chat posts about the source's past, and it must never
 * carry a webhook credential:
 *
 *  * preference / member_settings — each member's cadences, timezone, digest hour and quiet
 *    hours. Carried as-is (`membership_id` is remapped generically: memberships are exported by
 *    the kernel).
 *  * digest / notification — the inbox and the record of what was emailed. Kept: it is what
 *    staff were told and when, and the inbox is user-visible state. Rows that were still
 *    unprocessed at export time (a claimed-but-unsent digest, an instant email not yet sent or
 *    deferred by quiet hours) are closed on import (`sent_at = now`, no retry): the source
 *    sends them if it is still running, the copy never does. `dedupe_key` embeds ids and is
 *    remapped so a burst straddling the move still collapses.
 *  * channel — the Slack webhook URL is a bearer credential: `url_enc` and its `encryption`
 *    descriptor are never exported. The channel arrives **disabled** with `disabled_reason =
 *    'invalid_url'` and an empty `url_enc` (a webhook row must carry one); the channel service already
 *    treats a descriptor without a key id as "the stored URL could not be read", and an admin
 *    reconnects by entering the URL again (PATCH url), which clears the reason. `url_hint`
 *    (last four characters, shown in the UI already) is kept so the admin recognises it.
 *    A `slack_app` channel (E3.6) holds no credential — but the Slack app connection it posts
 *    through is kernel state that is never exported, so it too arrives disabled, with
 *    `disabled_reason = 'not_connected'` and `url_enc` left NULL (the kind CHECK requires it).
 *    Connect Slack in the copy, then switch the channel back on.
 *  * channel_delivery — the post log (which investor facts went to which external channel is a
 *    data-egress record) and the retry queue. Kept; anything still pending/sending is dropped
 *    exactly as disabling a channel drops it, so nothing is posted from the copy.
 */

/** `last_error` written on queued chat posts that the import closed. */
export const IMPORT_DROPPED_REASON = "workspace imported";
/** `last_error` on an imported channel: its webhook URL was not exported. */
export const IMPORT_RECONNECT_ERROR =
  "reconnect required: the webhook URL is not part of a workspace export";
/** `last_error` on an imported Slack app channel (E3.6): the Slack connection was not exported. */
export const IMPORT_SLACK_APP_ERROR =
  "reconnect required: the Slack app connection is not part of a workspace export";

function remapKeyField(row: JsonObject, field: string, ctx: PortableImportContext): JsonObject {
  const v = row[field];
  return typeof v === "string" ? { ...row, [field]: ctx.remapKey(v) } : row;
}

export const notifyPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "preference", mode: "rows" },
    { table: "member_settings", mode: "rows" },
    {
      table: "digest",
      mode: "rows",
      importRow(row, ctx) {
        if (row["sent_at"] !== null && row["sent_at"] !== undefined) return row;
        return { ...row, sent_at: ctx.now.toISOString() };
      },
    },
    {
      table: "notification",
      mode: "rows",
      importRow(row, ctx) {
        const out = remapKeyField(row, "dedupe_key", ctx);
        if (out["sent_at"] !== null && out["sent_at"] !== undefined) return out;
        return {
          ...out,
          sent_at: ctx.now.toISOString(),
          next_attempt_at: null,
          deferred_until: null,
        };
      },
    },
    {
      table: "channel",
      mode: "rows",
      omitColumns: ["url_enc", "encryption"],
      importRow(row) {
        if (row["kind"] === "slack_app") {
          return {
            ...row,
            url_enc: null,
            enabled: false,
            disabled_reason: "not_connected",
            last_error: IMPORT_SLACK_APP_ERROR,
          };
        }
        return {
          ...row,
          url_enc: "\\x",
          enabled: false,
          disabled_reason: "invalid_url",
          last_error: IMPORT_RECONNECT_ERROR,
        };
      },
    },
    {
      table: "channel_delivery",
      mode: "rows",
      importRow(row, ctx) {
        const out = remapKeyField(row, "source_key", ctx);
        if (out["status"] !== "pending" && out["status"] !== "sending") return out;
        return { ...out, status: "dropped", claimed_at: null, last_error: IMPORT_DROPPED_REASON };
      },
    },
  ],
};
