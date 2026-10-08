import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

const { integrationBooking } = core;

export type BookingRow = typeof integrationBooking.$inferSelect;
type NewBooking = Omit<typeof integrationBooking.$inferInsert, "workspaceId">;
export type BookingPatch = Partial<
  Pick<
    BookingRow,
    "status" | "startsAt" | "endsAt" | "inviteeName" | "eventName" | "membershipId" | "connectionId"
  >
>;

/*
 * `core.integration_booking` (0020). Written only by the verified booking webhook (system
 * context), read by the staff register, `crm` (`IntegrationServices.booking`) and DSAR, deleted by
 * erasure and the 400-day retention sweep.
 *
 * Lock order on every write: the workspace's booking advisory lock (`lockWorkspace`) → booking
 * rows (by id order) → outbox. Identity erasure takes the same advisory lock and the member's rows
 * BEFORE the audit chain (`../erasure.ts`), so no booking for the member is inserted between its
 * prelock and its delete.
 */
export class BookingRepo extends TenantRepo<typeof integrationBooking> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(integrationBooking, ctx, tx);
  }

  async lockWorkspace(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`integration.bookings:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async byExternalIdForUpdate(
    provider: string,
    externalId: string,
  ): Promise<BookingRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationBooking)
      .where(
        this.scope(
          and(
            eq(integrationBooking.provider, provider as BookingRow["provider"]),
            eq(integrationBooking.externalId, externalId),
          ),
        ),
      )
      .limit(1)
      .for("update");
    return rows[0];
  }

  async insert(values: NewBooking): Promise<BookingRow> {
    return this.insertOne(values);
  }

  async update(id: string, patch: BookingPatch): Promise<BookingRow | undefined> {
    const rows = await this.tx
      .update(integrationBooking)
      .set(patch)
      .where(this.scope(eq(integrationBooking.id, id)))
      .returning();
    return rows[0];
  }

  async byId(id: string): Promise<BookingRow | undefined> {
    return this.findById(id);
  }

  /** The staff register: newest meeting first (keyset on starts_at desc, id desc). */
  async page(
    limit: number,
    before: { startsAt: Date; id: string } | undefined,
  ): Promise<BookingRow[]> {
    return this.tx
      .select()
      .from(integrationBooking)
      .where(
        this.scope(
          before === undefined
            ? undefined
            : or(
                lt(integrationBooking.startsAt, before.startsAt),
                and(
                  eq(integrationBooking.startsAt, before.startsAt),
                  lt(integrationBooking.id, before.id),
                ),
              ),
        ),
      )
      .orderBy(desc(integrationBooking.startsAt), desc(integrationBooking.id))
      .limit(limit);
  }

  /** Rows naming the person: by membership, or by any of their addresses. Erased rows excluded. */
  private subject(membershipId: string, emails: readonly string[]) {
    const who =
      emails.length === 0
        ? eq(integrationBooking.membershipId, membershipId)
        : or(
            eq(integrationBooking.membershipId, membershipId),
            inArray(
              sql`lower(${integrationBooking.inviteeEmail}::text)`,
              emails.map((e) => e.toLowerCase()),
            ),
          );
    return and(who, isNull(integrationBooking.erasedAt));
  }

  /** Erasure pre-lock: the member's rows (by membership or address), in id order. */
  async lockOfSubject(membershipId: string, emails: readonly string[]): Promise<BookingRow[]> {
    return this.tx
      .select()
      .from(integrationBooking)
      .where(this.scope(this.subject(membershipId, emails)))
      .orderBy(asc(integrationBooking.id))
      .for("update");
  }

  async ofSubject(membershipId: string, emails: readonly string[]): Promise<BookingRow[]> {
    return this.tx
      .select()
      .from(integrationBooking)
      .where(this.scope(this.subject(membershipId, emails)))
      .orderBy(asc(integrationBooking.startsAt), asc(integrationBooking.id));
  }

  /**
   * Erasure: the address becomes `erased+<row id hex>@erased.invalid` (keyed on the row, never on
   * the address), the name, event title and membership are dropped, `erased_at` is set. The row
   * and its `external_id` stay, so a vendor retry of the same event dedupes instead of inserting
   * the person again.
   */
  async pseudonymiseOfSubject(
    membershipId: string,
    emails: readonly string[],
    at: Date,
  ): Promise<number> {
    const rows = await this.tx
      .update(integrationBooking)
      .set({
        inviteeEmail: sql`'erased+' || replace(${integrationBooking.id}::text, '-', '') || '@erased.invalid'`,
        inviteeName: null,
        eventName: null,
        membershipId: null,
        erasedAt: at,
      })
      .where(this.scope(this.subject(membershipId, emails)))
      .returning({ id: integrationBooking.id });
    return rows.length;
  }

  /** Retention: meetings that started before `before`. */
  async deleteStartedBefore(before: Date): Promise<number> {
    const rows = await this.tx
      .delete(integrationBooking)
      .where(this.scope(lt(integrationBooking.startsAt, before)))
      .returning({ id: integrationBooking.id });
    return rows.length;
  }
}
