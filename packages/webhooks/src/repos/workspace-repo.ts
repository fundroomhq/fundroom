import { core, type Tx } from "@fundroom/db";
import { eq } from "drizzle-orm";

const { workspace } = core;

/*
 * The one workspace fact delivery needs from inside a transaction it already holds (the outbox
 * subscriber, the retention sweep): the raw `settings` jsonb, parsed by the caller with
 * `parseWorkspaceSettings`. A plain read (no row lock): nothing here decides under it.
 */
export async function readWorkspaceSettings(tx: Tx, workspaceId: string): Promise<unknown> {
  const rows = await tx
    .select({ settings: workspace.settings })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0]?.settings;
}
