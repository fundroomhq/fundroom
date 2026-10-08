import {
  type Database,
  findWorkspaceById,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  systemContext,
} from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { MailMessageRepo } from "./repos/mail-repo.js";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/*
 * `core.mail_message` retention (E2.6 follow-up). Every message sent on behalf of a workspace
 * leaves one row, so without this the table grows with every send forever.
 *
 * Why 400 days. The row exists for one reason: to turn an ESP webhook back into a workspace. The
 * delivery outcome (delivered, bounce, complaint) arrives within minutes to a few days, and the
 * providers stop retrying well inside a week. Opens and clicks are the long tail — a person can
 * reopen a quarterly update months later, and an annual report is typically reopened when the
 * next one lands — so a bound shorter than a year would drop real engagement on the documents
 * this product exists to send. Past a year plus a margin the signal is noise, and the row is only
 * a member-to-message linkage kept for no purpose (data minimisation). A webhook for a deleted row
 * is simply ignored, exactly like an id we never recorded. Suppression entries keep their
 * `message_ref` as a bare id (no FK), so they are unaffected.
 *
 * Skipped while the workspace is on `legal.legalHold`, like every other retention trim: which
 * member was sent which message is exactly the kind of fact a hold preserves. Batches of 1000
 * rows, one transaction each, per workspace.
 */
export const MAIL_MESSAGE_RETENTION_DAYS = 400;
const BATCH = 1000;

export interface MailJobOptions {
  readonly db: Database;
  readonly retentionDays?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

export interface MailSweepResult {
  readonly workspaces: number;
  readonly deleted: number;
  readonly held: number;
}

export async function sweepMailMessages(options: MailJobOptions): Promise<MailSweepResult> {
  const now = options.now ?? (() => new Date());
  const days = options.retentionDays ?? MAIL_MESSAGE_RETENTION_DAYS;
  const batch = options.batchSize ?? BATCH;
  const cutoff = new Date(now().getTime() - days * 24 * 3600_000);
  let workspaces = 0;
  let deleted = 0;
  let held = 0;
  for (const workspaceId of await listLiveWorkspaceIds(options.db)) {
    if (isPlatformWorkspace(workspaceId)) continue;
    const ws = await findWorkspaceById(options.db, workspaceId);
    if (ws === undefined) continue;
    if (parseWorkspaceSettings(ws.settings).legal.legalHold) {
      held += 1;
      continue;
    }
    workspaces += 1;
    const ctx = systemContext(workspaceId);
    for (;;) {
      const n = await options.db.withTenant(ctx, (tx) =>
        new MailMessageRepo(ctx, tx).deleteSentBefore(cutoff, batch),
      );
      deleted += n;
      if (n < batch) break;
    }
  }
  options.log?.("mail.messages_swept", { workspaces, deleted, held, retentionDays: days });
  return { workspaces, deleted, held };
}

export function createMailJobs(options: MailJobOptions): JobDefinition[] {
  return [
    {
      name: "mail.message_sweep",
      cron: "55 3 * * *",
      handler: async () => {
        await sweepMailMessages(options);
      },
    },
  ] satisfies JobDefinition<JsonObject>[];
}
