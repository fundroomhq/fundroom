import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";
import type { SignatureRequestStatus } from "../model.js";
import { signatureRequest } from "../schema/round.js";

/*
 * `round.signature_request` (E3.5, 0004): the round's mirror of a kernel e-sign envelope sent for
 * one commitment. Like `round-repo.ts`, raw SQL with timestamps coerced here, so nothing
 * downstream ever sees a driver value (`tx.execute` returns timestamptz as text).
 *
 * Lock order (contract §0): envelope row (kernel) → **signature_request row** → commitment row →
 * audit chain → outbox. Every write path here locks the request row(s) first.
 */

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const asDateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : asDate(v);

export interface SignatureRequestRecord {
  readonly id: string;
  readonly roundId: string;
  readonly commitmentId: string;
  readonly envelopeId: string | null;
  readonly status: SignatureRequestStatus;
  readonly templateRef: string | null;
  readonly sentByMembershipId: string | null;
  readonly sentAt: Date;
  readonly completedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly signedDocumentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = sql.raw(
  `id, round_id AS "roundId", commitment_id AS "commitmentId", envelope_id AS "envelopeId",
   status, template_ref AS "templateRef", sent_by_membership_id AS "sentByMembershipId",
   sent_at AS "sentAt", completed_at AS "completedAt", terminal_at AS "terminalAt",
   signed_document_id AS "signedDocumentId", created_at AS "createdAt", updated_at AS "updatedAt"`,
);

const hydrate = (r: SignatureRequestRecord): SignatureRequestRecord => ({
  ...r,
  sentAt: asDate(r.sentAt),
  completedAt: asDateOrNull(r.completedAt),
  terminalAt: asDateOrNull(r.terminalAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

/** The unique index a second open request for one commitment trips (23505). */
export const SIGNATURE_REQUEST_OPEN_INDEX = "signature_request_open_idx";

export class SignatureRequestRepo extends TenantRepo<typeof signatureRequest> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(signatureRequest, ctx, tx);
  }

  async find(id: string): Promise<SignatureRequestRecord | undefined> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrate(row);
  }

  async lock(id: string): Promise<SignatureRequestRecord | undefined> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        FOR UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrate(row);
  }

  async lockByEnvelope(envelopeId: string): Promise<SignatureRequestRecord | undefined> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND envelope_id = ${envelopeId}::uuid
        FOR UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrate(row);
  }

  /** The open (pending/sent/delivered) requests of one commitment, locked — at most one. */
  async lockOpenForCommitment(commitmentId: string): Promise<SignatureRequestRecord[]> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND commitment_id = ${commitmentId}::uuid
          AND status IN ('pending', 'sent', 'delivered')
        ORDER BY created_at
        FOR UPDATE`),
    );
    return rows.map(hydrate);
  }

  /**
   * The newest claim of one commitment released as `error` with no envelope, created no later
   * than `notAfter`, locked (fix C2: the claim an orphaned envelope belongs to).
   */
  async lockReleasedForCommitment(
    commitmentId: string,
    notAfter: Date,
  ): Promise<SignatureRequestRecord | undefined> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND commitment_id = ${commitmentId}::uuid
          AND status = 'error' AND envelope_id IS NULL
          AND created_at <= ${notAfter}::timestamptz
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrate(row);
  }

  /**
   * The commitment's `error` requests that carry an envelope (fix C1: their kernel envelope may
   * still be live at the vendor). Read under the commitment row lock the caller holds.
   */
  async erroredWithEnvelope(commitmentId: string): Promise<SignatureRequestRecord[]> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND commitment_id = ${commitmentId}::uuid
          AND status = 'error' AND envelope_id IS NOT NULL
        ORDER BY created_at`),
    );
    return rows.map(hydrate);
  }

  /** The newest request per commitment of a round (the closing checklist). */
  async latestForRound(roundId: string): Promise<Map<string, SignatureRequestRecord>> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        SELECT DISTINCT ON (commitment_id) ${COLUMNS} FROM round.signature_request
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
        ORDER BY commitment_id, created_at DESC, id DESC`),
    );
    return new Map(rows.map((r) => [r.commitmentId, hydrate(r)]));
  }

  /** The claim taken before the vendor call. 23505 on the open index = a request is open. */
  async insertPending(input: {
    readonly roundId: string;
    readonly commitmentId: string;
    readonly templateRef: string;
    readonly sentByMembershipId: string;
    readonly at: Date;
  }): Promise<SignatureRequestRecord> {
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        INSERT INTO round.signature_request (
          workspace_id, round_id, commitment_id, status, template_ref, sent_by_membership_id,
          sent_at)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.roundId}::uuid, ${input.commitmentId}::uuid,
          'pending', ${input.templateRef}::text, ${input.sentByMembershipId}::uuid,
          ${input.at}::timestamptz)
        RETURNING ${COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.signature_request insert returned no row");
    return hydrate(row);
  }

  /**
   * Moves the mirror. `envelopeId` attaches the envelope to a `pending` (or released) claim
   * (never replaces one already attached); `completed_at` is stamped once; `terminal_at` is
   * stamped on the first final or `error` status and cleared when an `error` recovers.
   */
  async apply(
    id: string,
    input: {
      readonly status: SignatureRequestStatus;
      readonly envelopeId?: string | undefined;
      readonly at: Date;
    },
  ): Promise<SignatureRequestRecord | undefined> {
    const final = ["completed", "declined", "voided", "expired"].includes(input.status);
    const errored = input.status === "error";
    const rows = rowsOf<SignatureRequestRecord>(
      await this.tx.execute(sql`
        UPDATE round.signature_request SET
          status = ${input.status}::text,
          envelope_id = COALESCE(envelope_id, ${input.envelopeId ?? null}::uuid),
          sent_at = CASE WHEN status = 'pending' AND ${input.status}::text IN ('sent', 'delivered', 'completed')
            THEN ${input.at}::timestamptz ELSE sent_at END,
          completed_at = CASE WHEN ${input.status}::text = 'completed'
            THEN COALESCE(completed_at, ${input.at}::timestamptz) ELSE completed_at END,
          terminal_at = CASE
            -- Leaving a recoverable error for a final status: the end is now.
            WHEN ${final}::boolean AND status = 'error' THEN ${input.at}::timestamptz
            WHEN ${final}::boolean OR ${errored}::boolean
              THEN COALESCE(terminal_at, ${input.at}::timestamptz)
            -- Back to an open status (an error that recovered): not ended.
            ELSE NULL END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrate(row);
  }

  /**
   * First writer wins: the envelope's *signed* copy is vaulted before its certificate, and a
   * `document.vaulted` for the certificate (if the data room publishes one) must not replace it.
   */
  async setSignedDocument(id: string, documentId: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.signature_request SET signed_document_id = ${documentId}::uuid
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND signed_document_id IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /** `pending` claims older than `before` for one commitment → `error` (a crashed send). */
  async expireStalePending(commitmentId: string, before: Date, at: Date): Promise<number> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.signature_request SET status = 'error', terminal_at = ${at}::timestamptz
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND commitment_id = ${commitmentId}::uuid
          AND status = 'pending' AND created_at < ${before}::timestamptz
        RETURNING id`),
    );
    return rows.length;
  }
}
