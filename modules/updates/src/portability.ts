import type { ModulePortability } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { SEARCH_MODULE } from "./search.js";

/*
 * Workspace export/import (E2.8).
 *
 * The rule every decision below follows: **an import never sends mail by itself.** A workspace
 * is imported as a copy (a move between instances, a restore into a fresh slug), and the source
 * may still be running; a schedule or a half-finished fan-out that resumed on the target would
 * mail the same investors twice. So:
 *
 *  - `post`: `scheduled` comes back as `draft` (the schedule is cleared; staff re-schedule), and a
 *    post caught `sending` comes back `sent` when it had already gone out once (a re-send) and
 *    `draft` otherwise. Its published version pointer is kept either way — that is history.
 *  - `send`: `queued`/`running` come back `failed` with the reason, so neither the `updates.send`
 *    retry nor the dispatcher's stale-send sweep picks them up; `recipient` rows still `queued`
 *    come back `failed` too.
 *  - `sending_domain` is skipped (`secret`): its whole point is the DKIM private key, which is
 *    NOT NULL and envelope-encrypted under the source workspace's key, and a row without it would
 *    be a verified-looking domain that cannot sign. The target re-adds its domain, which mints a
 *    fresh key pair and DNS records (the old selector's record can then be removed).
 *
 * Unsubscribe links in mail sent before the export do not work against the imported workspace:
 * the token is an HMAC under the workspace's own key and names the workspace id (tokens.ts). The
 * opt-outs themselves (`unsubscribe` rows) travel, so nobody who opted out is mailed again.
 *
 * FK order: post → post_version (→ post) → send (→ post, post_version) → recipient (→ send) →
 * reply (→ post) → unsubscribe (→ core.membership). `post.published_version_id` points forward
 * and is DEFERRABLE INITIALLY DEFERRED (0001); versions are immutable only to UPDATE.
 * `post.search_tsv` is GENERATED and stripped by the engine.
 */
export const IMPORT_INTERRUPTED = "interrupted by a workspace export/import; not resumed";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function importPostRow(row: JsonObject): JsonObject {
  const state = str(row["state"]);
  if (state === "scheduled") return { ...row, state: "draft", scheduled_for: null };
  if (state === "sending") {
    const wasSent = str(row["sent_at"]) !== null && row["published_version_id"] != null;
    return { ...row, state: wasSent ? "sent" : "draft", scheduled_for: null };
  }
  return row;
}

export function importSendRow(row: JsonObject, now: Date): JsonObject {
  const status = str(row["status"]);
  if (status !== "queued" && status !== "running") return row;
  return {
    ...row,
    status: "failed",
    error: IMPORT_INTERRUPTED,
    finished_at: str(row["finished_at"]) ?? now.toISOString(),
  };
}

export function importRecipientRow(row: JsonObject): JsonObject {
  if (str(row["status"]) !== "queued") return row;
  return { ...row, status: "failed", error: IMPORT_INTERRUPTED };
}

export const updatesPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "post", mode: "rows", importRow: (row) => importPostRow(row) },
    { table: "post_version", mode: "rows" },
    { table: "send", mode: "rows", importRow: (row, ctx) => importSendRow(row, ctx.now) },
    { table: "recipient", mode: "rows", importRow: (row) => importRecipientRow(row) },
    { table: "reply", mode: "rows" },
    { table: "unsubscribe", mode: "rows" },
    { table: "sending_domain", mode: "skip", reason: "secret" },
  ],
  async afterImport({ tx, ctx, services }) {
    await services.search.requestReindex(tx, ctx, SEARCH_MODULE);
  },
};
