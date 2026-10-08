import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, eq, inArray } from "drizzle-orm";

const { integrationBookingSuppression: t } = core;

/** `core.integration_booking_suppression` (0020, fix round 2): keyed hashes only, no address. */
export class SuppressionRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  async add(hashes: readonly Buffer[]): Promise<void> {
    if (hashes.length === 0) return;
    await this.tx
      .insert(t)
      .values(hashes.map((emailHash) => ({ workspaceId: this.ctx.workspaceId, emailHash })))
      .onConflictDoNothing();
  }

  async anyOf(hashes: readonly Buffer[]): Promise<boolean> {
    if (hashes.length === 0) return false;
    const rows = await this.tx
      .select({ h: t.emailHash })
      .from(t)
      .where(and(eq(t.workspaceId, this.ctx.workspaceId), inArray(t.emailHash, [...hashes])))
      .limit(1);
    return rows.length > 0;
  }
}
