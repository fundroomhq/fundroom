import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";

const { bookingLink, group } = core;

export type BookingLinkRow = typeof bookingLink.$inferSelect;
type NewBookingLink = Omit<typeof bookingLink.$inferInsert, "workspaceId">;
export type BookingLinkPatch = Partial<
  Pick<BookingLinkRow, "url" | "label" | "description" | "audience" | "position" | "enabled">
>;

/*
 * `core.booking_link` (0020). The 10-link cap is enforced here, under a per-workspace advisory
 * lock (`lockWorkspace`) so two concurrent creates cannot both count 9.
 */
export class BookingLinkRepo extends TenantRepo<typeof bookingLink> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(bookingLink, ctx, tx);
  }

  async lockWorkspace(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`integration.booking_links:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async list(): Promise<BookingLinkRow[]> {
    return this.tx
      .select()
      .from(bookingLink)
      .where(this.scope())
      .orderBy(asc(bookingLink.position), asc(bookingLink.id));
  }

  async listEnabled(): Promise<BookingLinkRow[]> {
    return this.tx
      .select()
      .from(bookingLink)
      .where(this.scope(eq(bookingLink.enabled, true)))
      .orderBy(asc(bookingLink.position), asc(bookingLink.id));
  }

  async count(): Promise<number> {
    const rows = await this.tx.select({ n: count() }).from(bookingLink).where(this.scope());
    return Number(rows[0]?.n ?? 0);
  }

  async byIdForUpdate(id: string): Promise<BookingLinkRow | undefined> {
    const rows = await this.tx
      .select()
      .from(bookingLink)
      .where(this.scope(eq(bookingLink.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async insert(values: NewBookingLink): Promise<BookingLinkRow> {
    return this.insertOne(values);
  }

  async update(id: string, patch: BookingLinkPatch): Promise<BookingLinkRow | undefined> {
    const rows = await this.tx
      .update(bookingLink)
      .set(patch)
      .where(this.scope(eq(bookingLink.id, id)))
      .returning();
    return rows[0];
  }

  async remove(id: string): Promise<number> {
    return this.deleteById(id);
  }

  /** Which of `ids` name a live group of this workspace. */
  async liveGroupIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.tx
      .select({ id: group.id })
      .from(group)
      .where(
        and(
          eq(group.workspaceId, this.ctx.workspaceId),
          inArray(group.id, [...ids]),
          isNull(group.deletedAt),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }
}
