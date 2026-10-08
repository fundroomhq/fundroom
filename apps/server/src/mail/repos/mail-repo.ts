import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, desc, eq, inArray, lt } from "drizzle-orm";

const { mailMessage, mailSuppression } = core;

/*
 * Data access over `core.mail_message` and `core.mail_suppression`
 * (migration `core/0010_mail_feedback.sql`). The only file in `src/mail/` that imports drizzle
 * (`only-repos-touch-drizzle`). Query builder only, never `tx.execute`: the raw path returns
 * `timestamptz` as text, and `sent_at` feeds the too-fast-click classifier.
 */

export type MailMessageRow = core.MailMessage;
export type MailSuppressionRow = core.MailSuppression;

export interface NewMessageFacts {
  readonly provider: string;
  readonly providerMessageId: string;
  readonly stream: core.MailStreamValue;
  readonly refKind: string | null;
  readonly refId: string | null;
  readonly membershipId: string | null;
  readonly trackingOpens: boolean;
  readonly trackingClicks: boolean;
  readonly sentAt: Date;
}

export class MailMessageRepo extends TenantRepo<typeof mailMessage> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(mailMessage, ctx, tx);
  }

  /**
   * Deletes up to `limit` of the workspace's rows sent before `cutoff`, oldest first; answers how
   * many went. The retention job calls it until it answers less than `limit`, one transaction per
   * batch, so a backlog never holds one long lock. `mail_message_ws_sent_idx` serves the scan.
   */
  async deleteSentBefore(cutoff: Date, limit: number): Promise<number> {
    const victims = this.tx
      .select({ id: mailMessage.id })
      .from(mailMessage)
      .where(this.scope(lt(mailMessage.sentAt, cutoff)))
      .orderBy(mailMessage.sentAt)
      .limit(limit);
    const rows = await this.tx
      .delete(mailMessage)
      .where(this.scope(inArray(mailMessage.id, victims)))
      .returning({ id: mailMessage.id });
    return rows.length;
  }

  /** Idempotent on (provider, provider_message_id): a second write for the same id is a no-op. */
  async record(facts: NewMessageFacts): Promise<void> {
    await this.tx
      .insert(mailMessage)
      .values({ ...facts, workspaceId: this.ctx.workspaceId })
      .onConflictDoNothing({ target: [mailMessage.provider, mailMessage.providerMessageId] });
  }
}

/**
 * THE cross-tenant read, and the only one: provider message id → the row naming its workspace.
 * Must run inside `db.withHost(...)`; the fence admits the host actor for SELECT only, so this
 * can find a row but never write one. Everything after it runs in that workspace's own context.
 */
export async function findMailMessageForWebhook(
  tx: Tx,
  provider: string,
  providerMessageId: string,
): Promise<MailMessageRow | undefined> {
  const rows = await tx
    .select()
    .from(mailMessage)
    .where(
      and(eq(mailMessage.provider, provider), eq(mailMessage.providerMessageId, providerMessageId)),
    )
    .limit(1);
  return rows[0];
}

/**
 * Keyset on the row's uuidv7 `id` alone, which is time-ordered. Deliberately not `created_at`:
 * Postgres keeps microseconds and a JS `Date` milliseconds, so a timestamp cursor would silently
 * skip rows created within the same millisecond as the last one on a page.
 */
export interface SuppressionCursor {
  readonly id: string;
}

export class MailSuppressionRepo extends TenantRepo<typeof mailSuppression> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(mailSuppression, ctx, tx);
  }

  /**
   * The entry matching any of `addressHashes` — one per data key the workspace holds for the
   * purpose, because an entry keeps the hash it was written with across a key rotation.
   */
  async find(addressHashes: readonly Buffer[]): Promise<MailSuppressionRow | undefined> {
    if (addressHashes.length === 0) return undefined;
    const rows = await this.tx
      .select()
      .from(mailSuppression)
      .where(this.scope(inArray(mailSuppression.addressHash, [...addressHashes])))
      .orderBy(mailSuppression.id)
      .limit(1);
    return rows[0];
  }

  /** Inserts when absent; answers the new row, or `undefined` when the address was already listed. */
  async insertIfAbsent(values: {
    readonly addressHash: Buffer;
    readonly keyId: string;
    readonly addressMasked: string;
    readonly reason: core.MailSuppressionReason;
    readonly messageRef: string | null;
    readonly createdBy: string | null;
  }): Promise<MailSuppressionRow | undefined> {
    const rows = await this.tx
      .insert(mailSuppression)
      .values({ ...values, workspaceId: this.ctx.workspaceId })
      .onConflictDoNothing({ target: [mailSuppression.workspaceId, mailSuppression.addressHash] })
      .returning();
    return rows[0];
  }

  /** Newest first; the ORDER BY column is the whole cursor. */
  async page(limit: number, after: SuppressionCursor | undefined): Promise<MailSuppressionRow[]> {
    return this.tx
      .select()
      .from(mailSuppression)
      .where(this.scope(after === undefined ? undefined : lt(mailSuppression.id, after.id)))
      .orderBy(desc(mailSuppression.id))
      .limit(limit);
  }

  async removeById(id: string): Promise<MailSuppressionRow | undefined> {
    const rows = await this.tx
      .delete(mailSuppression)
      .where(this.scope(eq(mailSuppression.id, id)))
      .returning();
    return rows[0];
  }
}
