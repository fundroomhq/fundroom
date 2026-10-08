import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { formatFixed, parseFixed } from "@fundroom/decimal";
import { parseWorkspaceSettings, type RoundSettings } from "@fundroom/domain";
import { parseTerms, type Terms } from "@fundroom/round-terms";
import { sql } from "drizzle-orm";
import type {
  AccreditationPath,
  CommitmentStatus,
  InstrumentKind,
  InterestStatus,
  InterestSubject,
  RoundStage,
  RoundStatus,
  VerificationMethod,
  VerificationStatus,
} from "../model.js";
import {
  closingTask,
  commitment,
  interestSubmission,
  round,
  terms,
  verification,
} from "../schema/round.js";

/*
 * Repositories over `round.*` — the only file in this module that touches drizzle or SQL
 * (design/06 §3, dependency-cruiser `only-repos-touch-drizzle`). Everything runs inside the
 * caller's tenant transaction, so RLS decides what an external reader sees: the same
 * `InterestRepo.listForMember` serves an investor their own submissions and would return
 * nothing for somebody else's, without a second check in TypeScript.
 *
 * `tx.execute()` bypasses drizzle's column mapping, and its raw query config hands two types
 * back as Postgres text: timestamptz and numeric. Both are live here — every table has
 * timestamps and three carry money — so both are coerced in this file and nothing downstream
 * ever sees a driver value.
 */

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const asDateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : asDate(v);

/**
 * A `numeric(20, 6)` as the wire spells money: a decimal string with exactly two places.
 *
 * Two, not six, and the reason is that `allocation()` in `@fundroom/round-terms` renders its
 * buckets the same way. A target of `1000000.000000` beside a committed total of `250000.00`
 * would be the same currency written two ways in one payload, and the first thing anybody does
 * with the pair is compare them.
 *
 * A value this cannot read means the row was written by something that bypassed this module —
 * the column is `numeric(20, 6)` with a positive CHECK behind it — so it fails loudly rather
 * than quietly substituting a zero into a company's allocation tracker.
 */
function money(v: unknown): string {
  const parsed = parseFixed(String(v));
  if (parsed === undefined) throw new Error(`round: not a decimal amount: ${String(v)}`);
  return formatFixed(parsed, 2);
}

const moneyOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : money(v);

/** The workspace's round settings, read inside the tenant transaction. */
export async function readRoundSettings(tx: Tx, workspaceId: string): Promise<RoundSettings> {
  const rows = rowsOf<{ settings: unknown }>(
    await tx.execute(sql`SELECT settings FROM core.workspace WHERE id = ${workspaceId}::uuid`),
  );
  return parseWorkspaceSettings(rows[0]?.settings).round;
}

// --- rounds ---------------------------------------------------------------------------------

export interface RoundRecord {
  readonly id: string;
  readonly name: string;
  readonly stage: RoundStage;
  readonly instrumentKind: InstrumentKind;
  readonly status: RoundStatus;
  readonly targetAmount: string;
  readonly currency: string;
  readonly minimumInvestment: string | null;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly openedAt: Date | null;
  readonly closedAt: Date | null;
  readonly showProgress: boolean;
  readonly summary: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewRound {
  readonly name: string;
  readonly stage: RoundStage;
  readonly instrumentKind: InstrumentKind;
  readonly targetAmount: string;
  readonly currency: string;
  readonly minimumInvestment?: string | null | undefined;
  readonly opensAt?: Date | null | undefined;
  readonly closesAt?: Date | null | undefined;
  readonly showProgress?: boolean | undefined;
  readonly summary?: string | null | undefined;
  readonly createdBy?: string | null | undefined;
}

/** Fields `PATCH /round/rounds/{id}` may move. `status` is not one: open and close are routes. */
export interface RoundPatch {
  readonly name?: string | undefined;
  readonly stage?: RoundStage | undefined;
  readonly instrumentKind?: InstrumentKind | undefined;
  readonly targetAmount?: string | undefined;
  readonly currency?: string | undefined;
  readonly minimumInvestment?: string | null | undefined;
  readonly opensAt?: Date | null | undefined;
  readonly closesAt?: Date | null | undefined;
  readonly showProgress?: boolean | undefined;
  readonly summary?: string | null | undefined;
}

const ROUND_COLUMNS = sql.raw(
  `id, name, stage, instrument_kind AS "instrumentKind", status,
   target_amount::text AS "targetAmount", currency,
   minimum_investment::text AS "minimumInvestment",
   opens_at AS "opensAt", closes_at AS "closesAt", opened_at AS "openedAt",
   closed_at AS "closedAt", show_progress AS "showProgress", summary,
   created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
);

interface RawRound extends Omit<RoundRecord, "targetAmount" | "minimumInvestment"> {
  readonly targetAmount: string;
  readonly minimumInvestment: string | null;
}

const hydrateRound = (r: RawRound): RoundRecord => ({
  ...r,
  targetAmount: money(r.targetAmount),
  minimumInvestment: moneyOrNull(r.minimumInvestment),
  opensAt: asDateOrNull(r.opensAt),
  closesAt: asDateOrNull(r.closesAt),
  openedAt: asDateOrNull(r.openedAt),
  closedAt: asDateOrNull(r.closedAt),
  showProgress: r.showProgress === true,
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class RoundRepo extends TenantRepo<typeof round> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(round, ctx, tx);
  }

  /** Newest first. RLS hides `planning` rounds from an external reader. */
  async list(): Promise<RoundRecord[]> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        SELECT ${ROUND_COLUMNS} FROM round.round
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateRound);
  }

  /** Named `find`, not `findById`: `TenantRepo` already has a protected `findById`. */
  async find(id: string): Promise<RoundRecord | undefined> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        SELECT ${ROUND_COLUMNS} FROM round.round
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateRound(row);
  }

  /**
   * What an investor is shown: the open round, or the most recently closed one.
   *
   * The fallback is deliberate. A round that closed last week is still the thing an investor
   * came to read about — the terms they were shown, the figure they committed — and answering
   * "there is no round" the day after a close would delete the company's own history from its
   * own portal. `planning` is never returned, here or through RLS.
   */
  async currentForInvestor(): Promise<RoundRecord | undefined> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        SELECT ${ROUND_COLUMNS} FROM round.round
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND status IN ('open', 'closed')
        ORDER BY (status = 'open') DESC, COALESCE(closed_at, opened_at, created_at) DESC
        LIMIT 1`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateRound(row);
  }

  async insert(r: NewRound): Promise<RoundRecord> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        INSERT INTO round.round (
          workspace_id, name, stage, instrument_kind, target_amount, currency,
          minimum_investment, opens_at, closes_at, show_progress, summary, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${r.name}::text, ${r.stage}::round.stage,
          ${r.instrumentKind}::round.instrument_kind, ${r.targetAmount}::numeric,
          ${r.currency}::text, ${r.minimumInvestment ?? null}::numeric,
          ${r.opensAt ?? null}::timestamptz, ${r.closesAt ?? null}::timestamptz,
          ${r.showProgress ?? true}::boolean, ${r.summary ?? null}::text,
          ${r.createdBy ?? null}::uuid)
        RETURNING ${ROUND_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.round insert returned no row");
    return hydrateRound(row);
  }

  async update(id: string, patch: RoundPatch): Promise<RoundRecord | undefined> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        UPDATE round.round SET
          name = COALESCE(${patch.name ?? null}::text, name),
          stage = COALESCE(${patch.stage ?? null}::round.stage, stage),
          instrument_kind = COALESCE(${patch.instrumentKind ?? null}::round.instrument_kind, instrument_kind),
          target_amount = COALESCE(${patch.targetAmount ?? null}::numeric, target_amount),
          currency = COALESCE(${patch.currency ?? null}::text, currency),
          minimum_investment = CASE WHEN ${patch.minimumInvestment !== undefined}::boolean
            THEN ${patch.minimumInvestment ?? null}::numeric ELSE minimum_investment END,
          opens_at = CASE WHEN ${patch.opensAt !== undefined}::boolean
            THEN ${patch.opensAt ?? null}::timestamptz ELSE opens_at END,
          closes_at = CASE WHEN ${patch.closesAt !== undefined}::boolean
            THEN ${patch.closesAt ?? null}::timestamptz ELSE closes_at END,
          show_progress = COALESCE(${patch.showProgress ?? null}::boolean, show_progress),
          summary = CASE WHEN ${patch.summary !== undefined}::boolean
            THEN ${patch.summary ?? null}::text ELSE summary END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${ROUND_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateRound(row);
  }

  /** Moves the status and stamps whichever of `opened_at` / `closed_at` the move implies. */
  async setStatus(id: string, status: RoundStatus, at: Date): Promise<RoundRecord | undefined> {
    const rows = rowsOf<RawRound>(
      await this.tx.execute(sql`
        UPDATE round.round SET
          status = ${status}::round.status,
          opened_at = CASE WHEN ${status}::text = 'open' THEN ${at}::timestamptz ELSE opened_at END,
          closed_at = CASE WHEN ${status}::text = 'closed' THEN ${at}::timestamptz ELSE closed_at END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${ROUND_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateRound(row);
  }

  /** Hard delete; the service refuses it for anything but an untouched `planning` round. */
  async remove(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM round.round
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'planning'
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- terms ----------------------------------------------------------------------------------

export interface TermsRecord {
  readonly id: string;
  readonly roundId: string;
  readonly revision: number;
  readonly terms: Terms;
  readonly termsSchemaVersion: number;
  readonly asOf: Date;
  readonly disclaimerStamp: string | null;
  readonly supersededBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

const TERMS_COLUMNS = sql.raw(
  `id, round_id AS "roundId", revision, terms,
   terms_schema_version AS "termsSchemaVersion", as_of AS "asOf",
   disclaimer_stamp AS "disclaimerStamp", superseded_by AS "supersededBy",
   created_by AS "createdBy", created_at AS "createdAt"`,
);

interface RawTerms extends Omit<TermsRecord, "terms"> {
  readonly terms: unknown;
}

/**
 * A revision whose body no longer validates comes back with `terms: null` rather than throwing.
 *
 * One unreadable row must not take down the round page for everybody, and it is unreadable
 * exactly when somebody needs the screen in order to fix it — the same bias
 * `modules/metrics` takes for a formula it cannot parse.
 */
function hydrateTerms(r: RawTerms, instrument: InstrumentKind): TermsRecord | undefined {
  let parsed: Terms;
  try {
    parsed = parseTerms(instrument, r.terms);
  } catch {
    return undefined;
  }
  return {
    ...r,
    terms: parsed,
    revision: Number(r.revision),
    termsSchemaVersion: Number(r.termsSchemaVersion),
    asOf: asDate(r.asOf),
    createdAt: asDate(r.createdAt),
  };
}

export class TermsRepo extends TenantRepo<typeof terms> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(terms, ctx, tx);
  }

  /** The live revision (`superseded_by IS NULL`), or `undefined` when the round has no terms. */
  async current(roundId: string, instrument: InstrumentKind): Promise<TermsRecord | undefined> {
    const rows = rowsOf<RawTerms>(
      await this.tx.execute(sql`
        SELECT ${TERMS_COLUMNS} FROM round.terms
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
          AND superseded_by IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateTerms(row, instrument);
  }

  /** Every revision, newest first — the change history EXECUTION_PLAN :471 asks for. */
  async history(roundId: string, instrument: InstrumentKind): Promise<TermsRecord[]> {
    const rows = rowsOf<RawTerms>(
      await this.tx.execute(sql`
        SELECT ${TERMS_COLUMNS} FROM round.terms
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
        ORDER BY revision DESC`),
    );
    return rows.flatMap((r) => {
      const t = hydrateTerms(r, instrument);
      return t === undefined ? [] : [t];
    });
  }

  async find(id: string, instrument: InstrumentKind): Promise<TermsRecord | undefined> {
    const rows = rowsOf<RawTerms>(
      await this.tx.execute(sql`
        SELECT ${TERMS_COLUMNS} FROM round.terms
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateTerms(row, instrument);
  }

  /** Appends the next revision. The caller supersedes the previous one in the same transaction. */
  async insert(input: {
    readonly roundId: string;
    readonly revision: number;
    readonly terms: Terms;
    readonly schemaVersion: number;
    readonly asOf: Date;
    readonly disclaimerStamp?: string | null | undefined;
    readonly createdBy?: string | null | undefined;
  }): Promise<TermsRecord> {
    const rows = rowsOf<RawTerms>(
      await this.tx.execute(sql`
        INSERT INTO round.terms (
          workspace_id, round_id, revision, terms, terms_schema_version, as_of,
          disclaimer_stamp, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.roundId}::uuid, ${input.revision}::integer,
          ${JSON.stringify(input.terms)}::jsonb, ${input.schemaVersion}::integer,
          ${input.asOf}::timestamptz, ${input.disclaimerStamp ?? null}::text,
          ${input.createdBy ?? null}::uuid)
        RETURNING ${TERMS_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.terms insert returned no row");
    const hydrated = hydrateTerms(row, input.terms.kind);
    if (hydrated === undefined) throw new Error("round.terms insert produced unreadable terms");
    return hydrated;
  }

  /** The one UPDATE the append-only trigger allows. */
  async supersede(id: string, bySucessorId: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.terms SET superseded_by = ${bySucessorId}::uuid
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        AND superseded_by IS NULL`);
  }

  async nextRevision(roundId: string): Promise<number> {
    const rows = rowsOf<{ next: number }>(
      await this.tx.execute(sql`
        SELECT COALESCE(max(revision), 0)::int + 1 AS next FROM round.terms
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid`),
    );
    return Number(rows[0]?.next ?? 1);
  }
}

// --- interest submissions -------------------------------------------------------------------

export interface InterestRecord {
  readonly id: string;
  readonly roundId: string;
  readonly membershipId: string;
  readonly amount: string;
  readonly currency: string;
  readonly subject: InterestSubject;
  readonly entityName: string | null;
  readonly note: string | null;
  readonly accreditationPath: AccreditationPath;
  readonly nonAccredited: boolean;
  readonly accreditationStamp: string | null;
  readonly disclaimerStamp: string | null;
  readonly offeringStatus: string;
  readonly status: InterestStatus;
  readonly verificationId: string | null;
  readonly commitmentId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const INTEREST_COLUMNS = sql.raw(
  `id, round_id AS "roundId", membership_id AS "membershipId", amount::text AS amount,
   currency, subject, entity_name AS "entityName", note,
   accreditation_path AS "accreditationPath", non_accredited AS "nonAccredited",
   accreditation_stamp AS "accreditationStamp", disclaimer_stamp AS "disclaimerStamp",
   offering_status AS "offeringStatus", status, verification_id AS "verificationId",
   commitment_id AS "commitmentId", decided_by AS "decidedBy", decided_at AS "decidedAt",
   decision_note AS "decisionNote", created_at AS "createdAt", updated_at AS "updatedAt"`,
);

const hydrateInterest = (r: InterestRecord): InterestRecord => ({
  ...r,
  amount: money(r.amount),
  nonAccredited: r.nonAccredited === true,
  decidedAt: asDateOrNull(r.decidedAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class InterestRepo extends TenantRepo<typeof interestSubmission> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(interestSubmission, ctx, tx);
  }

  /** The staff queue for one round, optionally narrowed to one status. */
  async listForRound(roundId: string, status?: InterestStatus): Promise<InterestRecord[]> {
    const rows = rowsOf<InterestRecord>(
      await this.tx.execute(sql`
        SELECT ${INTEREST_COLUMNS} FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
          AND (${status ?? null}::text IS NULL OR status::text = ${status ?? null}::text)
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateInterest);
  }

  /** One member's own submissions across every round; RLS makes the filter belt-and-braces. */
  async listForMember(membershipId: string): Promise<InterestRecord[]> {
    const rows = rowsOf<InterestRecord>(
      await this.tx.execute(sql`
        SELECT ${INTEREST_COLUMNS} FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${membershipId}::uuid
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateInterest);
  }

  async find(id: string): Promise<InterestRecord | undefined> {
    const rows = rowsOf<InterestRecord>(
      await this.tx.execute(sql`
        SELECT ${INTEREST_COLUMNS} FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateInterest(row);
  }

  /** Accepted submissions whose questionnaire named no category (E2.5 D7's population). */
  async nonAccreditedAcceptedCount(roundId: string): Promise<number> {
    const rows = rowsOf<{ n: number }>(
      await this.tx.execute(sql`
        SELECT count(*)::int AS n FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
          AND status = 'accepted' AND non_accredited = true`),
    );
    return Number(rows[0]?.n ?? 0);
  }

  async countsFor(roundId: string): Promise<{ submitted: number; accepted: number }> {
    const rows = rowsOf<{ submitted: number; accepted: number }>(
      await this.tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
          count(*) FILTER (WHERE status = 'accepted')::int AS accepted
        FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid`),
    );
    return {
      submitted: Number(rows[0]?.submitted ?? 0),
      accepted: Number(rows[0]?.accepted ?? 0),
    };
  }

  async insert(input: {
    readonly roundId: string;
    readonly membershipId: string;
    readonly amount: string;
    readonly currency: string;
    readonly subject: InterestSubject;
    readonly entityName?: string | null | undefined;
    readonly note?: string | null | undefined;
    readonly accreditationPath: AccreditationPath;
    readonly nonAccredited: boolean;
    readonly accreditationStamp?: string | null | undefined;
    readonly disclaimerStamp?: string | null | undefined;
    readonly offeringStatus: string;
  }): Promise<InterestRecord> {
    const rows = rowsOf<InterestRecord>(
      await this.tx.execute(sql`
        INSERT INTO round.interest_submission (
          workspace_id, round_id, membership_id, amount, currency, subject, entity_name, note,
          accreditation_path, non_accredited, accreditation_stamp, disclaimer_stamp,
          offering_status)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.roundId}::uuid, ${input.membershipId}::uuid,
          ${input.amount}::numeric, ${input.currency}::text, ${input.subject}::text,
          ${input.entityName ?? null}::text, ${input.note ?? null}::text,
          ${input.accreditationPath}::round.accreditation_path,
          ${input.nonAccredited}::boolean, ${input.accreditationStamp ?? null}::text,
          ${input.disclaimerStamp ?? null}::text, ${input.offeringStatus}::text)
        RETURNING ${INTEREST_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.interest_submission insert returned no row");
    return hydrateInterest(row);
  }

  async attachVerification(id: string, verificationId: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.interest_submission SET verification_id = ${verificationId}::uuid
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`);
  }

  /** Accept, decline or withdraw. `submitted` is the only status a decision may move. */
  async decide(
    id: string,
    input: {
      readonly status: InterestStatus;
      readonly decidedBy?: string | null | undefined;
      readonly decidedAt: Date;
      readonly decisionNote?: string | null | undefined;
      readonly commitmentId?: string | null | undefined;
    },
  ): Promise<InterestRecord | undefined> {
    const rows = rowsOf<InterestRecord>(
      await this.tx.execute(sql`
        UPDATE round.interest_submission SET
          status = ${input.status}::round.interest_status,
          decided_by = ${input.decidedBy ?? null}::uuid,
          decided_at = ${input.decidedAt}::timestamptz,
          decision_note = ${input.decisionNote ?? null}::text,
          commitment_id = COALESCE(${input.commitmentId ?? null}::uuid, commitment_id)
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'submitted'
        RETURNING ${INTEREST_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateInterest(row);
  }
}

// --- verifications --------------------------------------------------------------------------

/** The envelope descriptor of an evidence object, the shape data-room and metrics store. */
export interface EvidenceEncryption {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

export interface VerificationRecord {
  readonly id: string;
  readonly membershipId: string;
  readonly interestSubmissionId: string | null;
  readonly provider: string;
  readonly providerRef: string | null;
  readonly method: VerificationMethod | null;
  readonly status: VerificationStatus;
  readonly evidenceKey: string | null;
  readonly evidenceSha256: string | null;
  readonly evidenceContentType: string | null;
  readonly evidenceBytes: number | null;
  readonly evidenceNote: string | null;
  readonly evidenceUploadedAt: Date | null;
  readonly evidencePurgedAt: Date | null;
  /** `{format:"she1", keyId, keyRef}` (0002); `null` for objects sealed before it. */
  readonly evidenceEncryption: EvidenceEncryption | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly expiresAt: Date | null;
  // --- E3.7 (0005): the vendor side ---
  readonly vendorStatus: string | null;
  readonly vendorError: string | null;
  readonly vendorCheckedAt: Date | null;
  /** When the vendor certified the accreditation this row was decided on (E3.7 fix round 2). */
  readonly vendorDecidedAt: Date | null;
  readonly nextCheckAt: Date | null;
  readonly checkAttempts: number;
  /** The stored `AccreditationHandoff` (never `upload`); `null` for manual rows. */
  readonly handoff: unknown;
  readonly decidedByProvider: string | null;
  readonly reverificationOf: string | null;
  readonly reminderSentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const VERIFICATION_COLUMNS = sql.raw(
  `id, membership_id AS "membershipId", interest_submission_id AS "interestSubmissionId",
   provider, provider_ref AS "providerRef", method, status,
   evidence_key AS "evidenceKey", evidence_sha256 AS "evidenceSha256",
   evidence_content_type AS "evidenceContentType", evidence_bytes AS "evidenceBytes",
   evidence_note AS "evidenceNote", evidence_uploaded_at AS "evidenceUploadedAt",
   evidence_purged_at AS "evidencePurgedAt", evidence_encryption AS "evidenceEncryption",
   decided_by AS "decidedBy",
   decided_at AS "decidedAt", decision_note AS "decisionNote", expires_at AS "expiresAt",
   vendor_status AS "vendorStatus", vendor_error AS "vendorError",
   vendor_checked_at AS "vendorCheckedAt", vendor_decided_at AS "vendorDecidedAt",
   next_check_at AS "nextCheckAt",
   check_attempts AS "checkAttempts", handoff,
   decided_by_provider AS "decidedByProvider", reverification_of AS "reverificationOf",
   reminder_sent_at AS "reminderSentAt",
   created_at AS "createdAt", updated_at AS "updatedAt"`,
);

const hydrateVerification = (r: VerificationRecord): VerificationRecord => ({
  ...r,
  evidenceBytes: r.evidenceBytes === null ? null : Number(r.evidenceBytes),
  evidenceUploadedAt: asDateOrNull(r.evidenceUploadedAt),
  evidencePurgedAt: asDateOrNull(r.evidencePurgedAt),
  decidedAt: asDateOrNull(r.decidedAt),
  expiresAt: asDateOrNull(r.expiresAt),
  vendorCheckedAt: asDateOrNull(r.vendorCheckedAt),
  vendorDecidedAt: asDateOrNull(r.vendorDecidedAt),
  nextCheckAt: asDateOrNull(r.nextCheckAt),
  checkAttempts: Number(r.checkAttempts ?? 0),
  reminderSentAt: asDateOrNull(r.reminderSentAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

/**
 * `n` supersedes `v` (both aliases of `round.verification`): another verification of the same
 * member that is newer and pending or verified, or verified until the same or a later instant.
 */
const SUPERSEDED_BY_N = sql.raw(`n.workspace_id = v.workspace_id
  AND n.membership_id = v.membership_id AND n.id <> v.id
  AND ((n.created_at > v.created_at AND n.status IN ('pending', 'verified'))
    OR (n.status = 'verified' AND n.expires_at IS NOT NULL
      AND (n.expires_at > v.expires_at
        OR (n.expires_at = v.expires_at AND n.created_at > v.created_at))))`);

export class VerificationRepo extends TenantRepo<typeof verification> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(verification, ctx, tx);
  }

  async list(status?: VerificationStatus): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND (${status ?? null}::text IS NULL OR status::text = ${status ?? null}::text)
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateVerification);
  }

  async find(id: string): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  async insert(input: {
    readonly membershipId: string;
    readonly interestSubmissionId?: string | null | undefined;
    readonly provider: string;
    /** E3.7: what the investor is shown to continue (`{kind:"upload"}` for manual). */
    readonly handoff?: Readonly<Record<string, unknown>> | null | undefined;
    /** E3.7: the verification this one renews. */
    readonly reverificationOf?: string | null | undefined;
  }): Promise<VerificationRecord> {
    const handoff = input.handoff == null ? null : JSON.stringify(input.handoff);
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        INSERT INTO round.verification (
          workspace_id, membership_id, interest_submission_id, provider, handoff,
          reverification_of)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.membershipId}::uuid,
          ${input.interestSubmissionId ?? null}::uuid, ${input.provider}::text,
          ${handoff}::jsonb, ${input.reverificationOf ?? null}::uuid)
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.verification insert returned no row");
    return hydrateVerification(row);
  }

  // --- E3.7: vendor verifications ---------------------------------------------------------------

  /**
   * Serialises the verification writes of ONE member (the investor's start, an interest
   * submission opening one, the lifecycle's auto-start): a transaction-scoped advisory lock,
   * taken before the audit chain (a feature lock, like the e-sign claim). Two tabs cannot open two
   * pending verifications.
   */
  async lockMember(membershipId: string): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`round.verification:${membershipId}`}::text, 0))`,
    );
  }

  /**
   * The same lock without waiting; `false` when somebody holds it. For a caller that already holds
   * the audit chain (the lifecycle sweep) — waiting there would close a cycle with a starter that
   * holds this lock and is about to audit.
   */
  async tryLockMember(membershipId: string): Promise<boolean> {
    const rows = rowsOf<{ ok: boolean }>(
      await this.tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`round.verification:${membershipId}`}::text, 0)) AS ok`,
      ),
    );
    return rows[0]?.ok === true;
  }

  /** The member's newest verification, any status. */
  async latestForMember(membershipId: string): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${membershipId}::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 1`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** The member's newest pending verification. */
  async pendingForMember(membershipId: string): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${membershipId}::uuid AND status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** The row, locked `FOR UPDATE`: the first lock of every decision (row → audit chain → outbox). */
  async lock(id: string): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        FOR UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** A vendor start succeeded: its ref, the handoff, the first check in five minutes. */
  async recordStart(
    id: string,
    input: {
      readonly providerRef: string;
      readonly handoff: Readonly<Record<string, unknown>>;
      readonly vendorStatus: string | null;
      readonly checkedAt: Date;
      readonly nextCheckAt: Date;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          provider_ref = ${input.providerRef}::text,
          handoff = ${JSON.stringify(input.handoff)}::jsonb,
          vendor_status = ${input.vendorStatus}::text,
          vendor_error = NULL,
          vendor_checked_at = ${input.checkedAt}::timestamptz,
          next_check_at = ${input.nextCheckAt}::timestamptz,
          check_attempts = 0
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending' AND provider_ref IS NULL
          AND vendor_error IS DISTINCT FROM 'member_erased'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /**
   * A vendor call failed. `attempt` counts it in `check_attempts`; `stop` ends polling
   * (`next_check_at` NULL); `nextCheckAt` reschedules; `vendorStatus` replaces the raw status
   * (`start_failed` when a start gives up).
   */
  async recordVendorError(
    id: string,
    input: {
      readonly vendorError: string;
      readonly attempt: boolean;
      readonly nextCheckAt: Date | null;
      readonly vendorStatus?: string | undefined;
      readonly checkedAt?: Date | undefined;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          vendor_error = ${input.vendorError.slice(0, 500)}::text,
          check_attempts = check_attempts + ${input.attempt ? 1 : 0}::integer,
          next_check_at = ${input.nextCheckAt}::timestamptz,
          vendor_status = COALESCE(${input.vendorStatus ?? null}::text, vendor_status),
          vendor_checked_at = COALESCE(${input.checkedAt ?? null}::timestamptz, vendor_checked_at)
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending'
          AND (vendor_error IS DISTINCT FROM 'member_erased'
            OR ${input.vendorError}::text = 'member_erased')
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** A check that did not settle anything: the raw status, the upgraded ref, the next check. */
  async recordCheck(
    id: string,
    input: {
      readonly vendorStatus: string;
      readonly providerRef?: string | undefined;
      readonly checkedAt: Date;
      readonly nextCheckAt: Date | null;
      readonly vendorError?: string | null | undefined;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          vendor_status = ${input.vendorStatus.slice(0, 100)}::text,
          provider_ref = COALESCE(${input.providerRef ?? null}::text, provider_ref),
          vendor_checked_at = ${input.checkedAt}::timestamptz,
          next_check_at = ${input.nextCheckAt}::timestamptz,
          vendor_error = ${input.vendorError ?? null}::text,
          check_attempts = check_attempts + 1
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending' AND vendor_error IS DISTINCT FROM 'member_erased'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** Just the next check (an aborted sync puts its row back a little later). */
  async setNextCheck(id: string, at: Date | null): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.verification SET next_check_at = ${at}::timestamptz
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        AND status = 'pending' AND vendor_error IS DISTINCT FROM 'member_erased'`);
  }

  /** An admin retrying a start that gave up: clears the failure so the start job runs again. */
  async resetStart(id: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.verification SET
        vendor_error = NULL, vendor_status = NULL, check_attempts = 0, next_check_at = NULL
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        AND status = 'pending' AND provider_ref IS NULL`);
  }

  /**
   * The vendor settled it (E3.7). No person decided: `decided_by` stays NULL and
   * `decided_by_provider` names the driver — the CHECK then needs the ref. `evidence` is the
   * stored certificate; without one `evidenceNote` (`vendor:<driver>:<ref>`) is what was read.
   * Only a still-pending row moves: an admin who decided first wins.
   */
  async decideByProvider(
    id: string,
    input: {
      readonly status: "verified" | "rejected" | "expired";
      readonly method: VerificationMethod | null;
      readonly provider: string;
      readonly providerRef: string;
      readonly vendorStatus: string;
      readonly decidedAt: Date;
      /** The vendor's certification date, when it gave one. */
      readonly vendorDecidedAt?: Date | undefined;
      readonly expiresAt: Date | null;
      readonly decisionNote?: string | null | undefined;
      readonly evidenceNote?: string | null | undefined;
      readonly evidence?:
        | {
            readonly key: string;
            readonly sha256: string;
            readonly contentType: string;
            readonly bytes: number;
            readonly encryption: EvidenceEncryption;
          }
        | undefined;
    },
  ): Promise<VerificationRecord | undefined> {
    const e = input.evidence;
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          status = ${input.status}::round.verification_status,
          method = ${input.method}::round.verification_method,
          decided_by = NULL,
          decided_by_provider = ${input.provider}::text,
          provider_ref = ${input.providerRef}::text,
          vendor_status = ${input.vendorStatus.slice(0, 100)}::text,
          vendor_error = NULL,
          vendor_checked_at = ${input.decidedAt}::timestamptz,
          vendor_decided_at = ${input.vendorDecidedAt ?? null}::timestamptz,
          next_check_at = NULL,
          handoff = CASE WHEN handoff IS NULL THEN NULL ELSE jsonb_build_object('kind', handoff->'kind') END,
          decided_at = ${input.decidedAt}::timestamptz,
          decision_note = ${input.decisionNote ?? null}::text,
          evidence_note = COALESCE(${input.evidenceNote ?? null}::text, evidence_note),
          expires_at = ${input.expiresAt}::timestamptz,
          evidence_key = COALESCE(${e?.key ?? null}::text, evidence_key),
          evidence_sha256 = COALESCE(${e?.sha256 ?? null}::text, evidence_sha256),
          evidence_content_type = COALESCE(${e?.contentType ?? null}::text, evidence_content_type),
          evidence_bytes = COALESCE(${e?.bytes ?? null}::integer, evidence_bytes),
          evidence_uploaded_at = CASE WHEN ${e?.key ?? null}::text IS NULL
            THEN evidence_uploaded_at ELSE ${input.decidedAt}::timestamptz END,
          evidence_encryption = COALESCE(${e === undefined ? null : JSON.stringify(e.encryption)}::jsonb, evidence_encryption),
          evidence_purged_at = CASE WHEN ${e?.key ?? null}::text IS NULL
            THEN evidence_purged_at ELSE NULL END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending' AND vendor_error IS DISTINCT FROM 'member_erased'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /**
   * Pending vendor rows whose next check is due, claimed for the sync job: row-locked `FOR
   * UPDATE SKIP LOCKED` (a row a decision holds is skipped, never waited for) and leased — their
   * `next_check_at` moves to `leaseUntil`, so a sync job that dies re-queues them then.
   */
  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<string[]> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        WITH due AS (
          SELECT id FROM round.verification
          WHERE workspace_id = ${this.ctx.workspaceId}::uuid
            AND status = 'pending' AND next_check_at IS NOT NULL
            AND next_check_at <= ${now}::timestamptz
            AND provider_ref IS NOT NULL AND vendor_error IS DISTINCT FROM 'imported'
          ORDER BY next_check_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        UPDATE round.verification v SET next_check_at = ${leaseUntil}::timestamptz
        FROM due WHERE v.id = due.id AND v.workspace_id = ${this.ctx.workspaceId}::uuid
        RETURNING v.id`),
    );
    return rows.map((r) => r.id);
  }

  /** Pending rows of `provider` naming one of `refs` (a vendor callback's wake-up). */
  async pendingByRefs(provider: string, refs: readonly string[]): Promise<VerificationRecord[]> {
    if (refs.length === 0) return [];
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND provider = ${provider}::text AND status = 'pending'
          AND vendor_error IS DISTINCT FROM 'imported'
          AND provider_ref = ANY(${sql.param([...refs])}::text[])`),
    );
    return rows.map(hydrateVerification);
  }

  /** Pending rows of `provider` whose ref starts with `prefix` (VerifyInvestor's `inv:` rows), newest first. */
  async pendingWithRefPrefix(
    provider: string,
    prefix: string,
    limit: number,
  ): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND provider = ${provider}::text AND status = 'pending'
          AND starts_with(provider_ref, ${prefix}::text)
          AND vendor_error IS DISTINCT FROM 'imported'
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`),
    );
    return rows.map(hydrateVerification);
  }

  /**
   * Verified rows past their expiry, locked `FOR UPDATE SKIP LOCKED` (the lifecycle sweep), each
   * with whether another VERIFIED verification of the same member standing at least as long
   * supersedes it (a pending renewal does not: the investor still needs to hear it ran out).
   */
  async lockExpired(
    now: Date,
    limit: number,
  ): Promise<{ readonly row: VerificationRecord; readonly superseded: boolean }[]> {
    const rows = rowsOf<VerificationRecord & { superseded: boolean }>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS},
          EXISTS (
            SELECT 1 FROM round.verification n
            WHERE n.workspace_id = v.workspace_id AND n.membership_id = v.membership_id
              AND n.id <> v.id AND n.status = 'verified'
              AND n.expires_at IS NOT NULL AND n.expires_at >= v.expires_at) AS superseded
        FROM round.verification v
        WHERE v.workspace_id = ${this.ctx.workspaceId}::uuid
          AND v.status = 'verified' AND v.expires_at IS NOT NULL
          AND v.expires_at <= ${now}::timestamptz
        ORDER BY v.expires_at, v.id
        LIMIT ${limit}
        FOR UPDATE OF v SKIP LOCKED`),
    );
    return rows.map(({ superseded, ...r }) => ({
      row: hydrateVerification(r as VerificationRecord),
      superseded: superseded === true,
    }));
  }

  /**
   * Verified rows inside the reminder window that were never reminded and have not been
   * superseded (the member has no newer pending or verified verification), locked `FOR UPDATE
   * SKIP LOCKED`.
   */
  async lockReminderDue(now: Date, until: Date, limit: number): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification v
        WHERE v.workspace_id = ${this.ctx.workspaceId}::uuid
          AND v.status = 'verified' AND v.reminder_sent_at IS NULL
          AND v.expires_at > ${now}::timestamptz AND v.expires_at <= ${until}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM round.verification n WHERE ${SUPERSEDED_BY_N})
        ORDER BY v.expires_at, v.id
        LIMIT ${limit}
        FOR UPDATE OF v SKIP LOCKED`),
    );
    return rows.map(hydrateVerification);
  }

  /**
   * Reminded, still-verified rows inside the window that auto-start may renew (E3.7): not
   * superseded, not already renewed by any row (`reverification_of`), and — when the row is itself
   * a renewal — later-expiring than the row it renewed (a renewal the vendor answered with the old
   * accreditation must not start another). Locked `FOR UPDATE SKIP LOCKED`.
   */
  async lockAutoStartDue(now: Date, until: Date, limit: number): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification v
        WHERE v.workspace_id = ${this.ctx.workspaceId}::uuid
          AND v.status = 'verified' AND v.reminder_sent_at IS NOT NULL
          AND v.expires_at > ${now}::timestamptz AND v.expires_at <= ${until}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM round.verification n WHERE ${SUPERSEDED_BY_N})
          AND NOT EXISTS (
            SELECT 1 FROM round.verification r
            WHERE r.workspace_id = v.workspace_id AND r.reverification_of = v.id)
          AND NOT EXISTS (
            SELECT 1 FROM round.verification p
            WHERE p.workspace_id = v.workspace_id AND p.id = v.reverification_of
              AND p.expires_at IS NOT NULL AND p.expires_at >= v.expires_at)
        ORDER BY v.expires_at, v.id
        LIMIT ${limit}
        FOR UPDATE OF v SKIP LOCKED`),
    );
    return rows.map(hydrateVerification);
  }

  /**
   * What this row renews (E3.7 fix round 3), in two parts:
   *  - `sameRef`: the member's EARLIER verified/expired verifications of the SAME provider that
   *    share one of `refs` — the vendor may be repeating the very accreditation they were decided
   *    on (Parallel reuses its record): their latest expiry and latest vendor certification date;
   *  - `renewed`: the row named by `reverification_of`, whatever its provider: expiry and status.
   */
  async previousDecision(
    row: Pick<
      VerificationRecord,
      "id" | "membershipId" | "provider" | "reverificationOf" | "createdAt"
    >,
    refs: readonly string[],
  ): Promise<{
    readonly sameRef?: { readonly expiresAt: Date; readonly vendorDecidedAt: Date | null };
    readonly renewed?: { readonly expiresAt: Date | null; readonly status: VerificationStatus };
  }> {
    const same = rowsOf<{ at: Date | string | null; vd: Date | string | null }>(
      await this.tx.execute(sql`
        SELECT max(expires_at) AS at, max(vendor_decided_at) AS vd FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${row.membershipId}::uuid AND id <> ${row.id}::uuid
          AND status IN ('verified', 'expired') AND expires_at IS NOT NULL
          AND created_at < ${row.createdAt}::timestamptz AND provider = ${row.provider}::text
          AND provider_ref = ANY(${sql.param([...refs])}::text[])`),
    )[0];
    const renewed =
      row.reverificationOf === null
        ? undefined
        : rowsOf<{ expiresAt: Date | string | null; status: VerificationStatus }>(
            await this.tx.execute(sql`
              SELECT expires_at AS "expiresAt", status FROM round.verification
              WHERE workspace_id = ${this.ctx.workspaceId}::uuid
                AND id = ${row.reverificationOf}::uuid`),
          )[0];
    const date = (v: Date | string | null | undefined) =>
      v === null || v === undefined ? null : new Date(v);
    const sameAt = date(same?.at);
    return {
      ...(sameAt === null
        ? {}
        : { sameRef: { expiresAt: sameAt, vendorDecidedAt: date(same?.vd) } }),
      ...(renewed === undefined
        ? {}
        : { renewed: { expiresAt: date(renewed.expiresAt), status: renewed.status } }),
    };
  }

  /** A membership's status (`active`, `invited`, `dormant`, …); undefined when there is none. */
  async memberStatus(membershipId: string): Promise<string | undefined> {
    const rows = rowsOf<{ status: string }>(
      await this.tx.execute(sql`
        SELECT status::text AS status FROM core.membership
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${membershipId}::uuid`),
    );
    return rows[0]?.status;
  }

  /**
   * Vendor rows whose start never recorded anything (the job crashed or timed out every time):
   * pending, no ref, not given up, older than `before`, their lease (`next_check_at`) run out.
   * Locked `FOR UPDATE SKIP LOCKED`.
   */
  async lockStaleStarts(now: Date, before: Date, limit: number): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND status = 'pending' AND provider <> 'manual' AND provider_ref IS NULL
          AND vendor_status IS DISTINCT FROM 'start_failed'
          AND vendor_error IS DISTINCT FROM 'imported'
          AND created_at < ${before}::timestamptz
          AND (next_check_at IS NULL OR next_check_at <= ${now}::timestamptz)
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`),
    );
    return rows.map(hydrateVerification);
  }

  /**
   * The start job is about to call the vendor: one attempt counted, and the row leased until
   * `leaseUntil` (a start that dies mid-call is re-queued by the sweep after that, not before).
   * Refused (false) while another attempt's lease is live — a redelivered job must not start the
   * vendor a second time — and once `maxAttempts` attempts have run.
   */
  async beginStart(
    id: string,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly maxAttempts: number },
  ): Promise<boolean> {
    const { now, leaseUntil, maxAttempts } = input;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          check_attempts = check_attempts + 1, next_check_at = ${leaseUntil}::timestamptz
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending' AND provider_ref IS NULL
          AND vendor_error IS DISTINCT FROM 'member_erased'
          AND (next_check_at IS NULL OR next_check_at <= ${now}::timestamptz)
          AND check_attempts < ${maxAttempts}::integer
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * The workspace's vendor-start budget (E3.7 fix round 2): a transaction-scoped advisory lock per
   * workspace, taken AFTER the member's lock and before the audit chain, so two openers serialise
   * on the count below.
   */
  async lockWorkspaceStarts(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`round.verification_starts:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  /** Vendor verifications opened since `since`, and the oldest of them. */
  async vendorOpenedSince(since: Date): Promise<{ count: number; oldest: Date | null }> {
    const rows = rowsOf<{ n: number; oldest: Date | string | null }>(
      await this.tx.execute(sql`
        SELECT count(*)::int AS n, min(created_at) AS oldest FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND provider <> 'manual'
          AND created_at >= ${since}::timestamptz`),
    );
    const oldest = rows[0]?.oldest;
    return {
      count: Number(rows[0]?.n ?? 0),
      oldest: oldest === null || oldest === undefined ? null : new Date(oldest),
    };
  }

  /**
   * Erasure (E3.7): every verification of the member keeps only the kind of its handoff (a widget
   * config carries their email and name), and a pending one stops being polled.
   */
  async eraseMember(membershipId: string): Promise<number> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          handoff = CASE WHEN handoff IS NULL THEN NULL ELSE jsonb_build_object('kind', handoff->'kind') END,
          next_check_at = CASE WHEN status = 'pending' THEN NULL ELSE next_check_at END,
          vendor_error = CASE WHEN status = 'pending' AND provider <> 'manual'
            THEN 'member_erased' ELSE vendor_error END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND membership_id = ${membershipId}::uuid
        RETURNING id`),
    );
    return rows.length;
  }

  /** Vendor-verified rows nearing expiry whose vendor was not asked in the last `checkedBefore`. */
  async recheckCandidates(
    now: Date,
    until: Date,
    checkedBefore: Date,
    limit: number,
  ): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND status = 'verified' AND decided_by_provider IS NOT NULL
          AND provider <> 'manual' AND provider_ref IS NOT NULL
          AND expires_at > ${now}::timestamptz AND expires_at <= ${until}::timestamptz
          AND (vendor_checked_at IS NULL OR vendor_checked_at < ${checkedBefore}::timestamptz)
          AND vendor_error IS DISTINCT FROM 'imported'
        ORDER BY expires_at, id
        LIMIT ${limit}`),
    );
    return rows.map(hydrateVerification);
  }

  /** `verified` → `expired`. */
  async markExpired(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.verification SET status = 'expired'
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'verified'
        RETURNING id`),
    );
    return rows.length > 0;
  }

  async stampReminder(id: string, at: Date): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE round.verification SET reminder_sent_at = ${at}::timestamptz
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'verified' AND reminder_sent_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /** A vendor re-check that changed nothing: when it was asked and what it said. */
  async noteRecheck(id: string, vendorStatus: string, at: Date): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.verification SET
        vendor_status = ${vendorStatus.slice(0, 100)}::text, vendor_checked_at = ${at}::timestamptz
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`);
  }

  /** Renewed in place: the vendor still says accredited, until later. The reminder re-arms. */
  async renew(
    id: string,
    input: {
      readonly expiresAt: Date;
      readonly vendorStatus: string;
      readonly at: Date;
      readonly vendorDecidedAt?: Date | undefined;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          expires_at = ${input.expiresAt}::timestamptz,
          vendor_status = ${input.vendorStatus.slice(0, 100)}::text,
          vendor_checked_at = ${input.at}::timestamptz,
          vendor_decided_at = COALESCE(${input.vendorDecidedAt ?? null}::timestamptz, vendor_decided_at),
          reminder_sent_at = NULL
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'verified' AND expires_at < ${input.expiresAt}::timestamptz
          AND vendor_error IS DISTINCT FROM 'member_erased'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /** The subject (and entity name) of the submission that opened a verification. */
  async submissionSubject(
    submissionId: string,
  ): Promise<{ subject: InterestSubject; entityName: string | null } | undefined> {
    const rows = rowsOf<{ subject: InterestSubject; entityName: string | null }>(
      await this.tx.execute(sql`
        SELECT subject, entity_name AS "entityName" FROM round.interest_submission
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${submissionId}::uuid`),
    );
    return rows[0];
  }

  /** The workspace's display name: the vendor's portal name for the investor. */
  async workspaceName(): Promise<string | undefined> {
    const rows = rowsOf<{ name: string }>(
      await this.tx.execute(
        sql`SELECT name FROM core.workspace WHERE id = ${this.ctx.workspaceId}::uuid`,
      ),
    );
    return rows[0]?.name;
  }

  async setProviderRef(id: string, providerRef: string | null): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.verification SET provider_ref = ${providerRef}::text
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`);
  }

  /** Records an uploaded evidence object. Replacing one keeps the same storage key. */
  async recordEvidence(
    id: string,
    input: {
      readonly key: string;
      readonly sha256: string;
      readonly contentType: string;
      readonly bytes: number;
      readonly uploadedAt: Date;
      readonly encryption: EvidenceEncryption;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          evidence_key = ${input.key}::text,
          evidence_sha256 = ${input.sha256}::text,
          evidence_content_type = ${input.contentType}::text,
          evidence_bytes = ${input.bytes}::integer,
          evidence_uploaded_at = ${input.uploadedAt}::timestamptz,
          evidence_encryption = ${JSON.stringify(input.encryption)}::jsonb,
          evidence_purged_at = NULL
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  async decide(
    id: string,
    input: {
      readonly status: VerificationStatus;
      readonly method: VerificationMethod | null;
      readonly decidedBy: string;
      readonly decidedAt: Date;
      readonly decisionNote?: string | null | undefined;
      readonly evidenceNote?: string | null | undefined;
      readonly expiresAt: Date | null;
    },
  ): Promise<VerificationRecord | undefined> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        UPDATE round.verification SET
          status = ${input.status}::round.verification_status,
          method = ${input.method}::round.verification_method,
          decided_by = ${input.decidedBy}::uuid,
          decided_at = ${input.decidedAt}::timestamptz,
          decision_note = ${input.decisionNote ?? null}::text,
          evidence_note = COALESCE(${input.evidenceNote ?? null}::text, evidence_note),
          expires_at = ${input.expiresAt}::timestamptz,
          -- E3.7: a person decided, so a vendor row stops being polled, and the vendor handoff
          -- (the investor's email and name in a widget config) is reduced to its kind.
          next_check_at = NULL,
          handoff = CASE WHEN handoff IS NULL THEN NULL ELSE jsonb_build_object('kind', handoff->'kind') END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND status = 'pending'
        RETURNING ${VERIFICATION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateVerification(row);
  }

  /**
   * Decided verifications whose evidence is older than the retention window and still on disk.
   *
   * `decided_at` is the clock, not `evidence_uploaded_at`: design/04 §102 says the file expires
   * "after the decision", and a file uploaded in January against a decision taken in June must
   * be readable while the decision is being made.
   */
  async duePurge(before: Date, limit = 200): Promise<VerificationRecord[]> {
    const rows = rowsOf<VerificationRecord>(
      await this.tx.execute(sql`
        SELECT ${VERIFICATION_COLUMNS} FROM round.verification
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
          AND evidence_key IS NOT NULL AND evidence_purged_at IS NULL
          AND decided_at IS NOT NULL AND decided_at < ${before}::timestamptz
        ORDER BY decided_at
        LIMIT ${limit}`),
    );
    return rows.map(hydrateVerification);
  }

  /** The file is gone; the decision and the sha256 that identifies what was read are not. */
  async markPurged(id: string, at: Date): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.verification SET
        evidence_key = NULL, evidence_encryption = NULL, evidence_purged_at = ${at}::timestamptz
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`);
  }
}

// --- commitments ----------------------------------------------------------------------------

export interface CommitmentRecord {
  readonly id: string;
  readonly roundId: string;
  readonly membershipId: string | null;
  readonly organizationId: string | null;
  readonly contactId: string | null;
  readonly displayName: string | null;
  readonly amount: string;
  readonly status: CommitmentStatus;
  readonly note: string | null;
  readonly interestSubmissionId: string | null;
  readonly signedDocumentId: string | null;
  readonly wiredAt: Date | null;
  /** E3.5: the subscription agreement was signed (a completed signature request). */
  readonly signedAt: Date | null;
  /** E3.5: staff confirmed the wired money arrived and reconciled. */
  readonly confirmedAt: Date | null;
  readonly confirmedBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COMMITMENT_COLUMNS = sql.raw(
  `id, round_id AS "roundId", membership_id AS "membershipId",
   organization_id AS "organizationId", contact_id AS "contactId",
   display_name AS "displayName", amount::text AS amount, status, note,
   interest_submission_id AS "interestSubmissionId", signed_document_id AS "signedDocumentId",
   wired_at AS "wiredAt", signed_at AS "signedAt", confirmed_at AS "confirmedAt",
   confirmed_by AS "confirmedBy", created_by AS "createdBy", created_at AS "createdAt",
   updated_at AS "updatedAt"`,
);

const hydrateCommitment = (r: CommitmentRecord): CommitmentRecord => ({
  ...r,
  amount: money(r.amount),
  wiredAt: asDateOrNull(r.wiredAt),
  signedAt: asDateOrNull(r.signedAt),
  confirmedAt: asDateOrNull(r.confirmedAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class CommitmentRepo extends TenantRepo<typeof commitment> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(commitment, ctx, tx);
  }

  async listForRound(roundId: string): Promise<CommitmentRecord[]> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        SELECT ${COMMITMENT_COLUMNS} FROM round.commitment
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateCommitment);
  }

  async find(id: string): Promise<CommitmentRecord | undefined> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        SELECT ${COMMITMENT_COLUMNS} FROM round.commitment
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateCommitment(row);
  }

  /**
   * The row, locked `FOR UPDATE` (E3.5): the closing writes (send, confirm, the signed handler)
   * serialise on it. Lock order: signature_request rows → this row → audit chain → outbox.
   */
  async lock(id: string): Promise<CommitmentRecord | undefined> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        SELECT ${COMMITMENT_COLUMNS} FROM round.commitment
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        FOR UPDATE`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateCommitment(row);
  }

  /** One member's commitments against one round (the investor's closing card). */
  async listForMember(roundId: string, membershipId: string): Promise<CommitmentRecord[]> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        SELECT ${COMMITMENT_COLUMNS} FROM round.commitment
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
          AND membership_id = ${membershipId}::uuid
        ORDER BY created_at DESC`),
    );
    return rows.map(hydrateCommitment);
  }

  /**
   * A completed signature (E3.5). `status` moves only when the caller says so (soft/verbal →
   * signed); `signed_at` is stamped once and never overwritten.
   */
  async markSigned(
    id: string,
    input: { readonly status: CommitmentStatus | undefined; readonly at: Date },
  ): Promise<CommitmentRecord | undefined> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        UPDATE round.commitment SET
          status = COALESCE(${input.status ?? null}::round.commitment_status, status),
          signed_at = COALESCE(signed_at, ${input.at}::timestamptz)
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${COMMITMENT_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateCommitment(row);
  }

  /** Staff confirmed the money (E3.5). Idempotent: a confirmed row keeps its first stamp. */
  async confirm(id: string, by: string, at: Date): Promise<CommitmentRecord | undefined> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        UPDATE round.commitment SET
          confirmed_at = COALESCE(confirmed_at, ${at}::timestamptz),
          confirmed_by = COALESCE(confirmed_by, ${by}::uuid)
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${COMMITMENT_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateCommitment(row);
  }

  /** Links the vaulted signed copy (a soft reference into the data room); first writer wins. */
  async setSignedDocument(id: string, documentId: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE round.commitment SET signed_document_id = ${documentId}::uuid
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        AND signed_document_id IS NULL`);
  }

  async countForRound(roundId: string): Promise<number> {
    const rows = rowsOf<{ n: number }>(
      await this.tx.execute(sql`
        SELECT count(*)::int AS n FROM round.commitment
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid`),
    );
    return Number(rows[0]?.n ?? 0);
  }

  async insert(input: {
    readonly roundId: string;
    readonly membershipId?: string | null | undefined;
    readonly organizationId?: string | null | undefined;
    readonly contactId?: string | null | undefined;
    readonly displayName?: string | null | undefined;
    readonly amount: string;
    readonly status?: CommitmentStatus | undefined;
    readonly note?: string | null | undefined;
    readonly interestSubmissionId?: string | null | undefined;
    readonly createdBy?: string | null | undefined;
  }): Promise<CommitmentRecord> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        INSERT INTO round.commitment (
          workspace_id, round_id, membership_id, organization_id, contact_id, display_name,
          amount, status, note, interest_submission_id, created_by,
          wired_at)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.roundId}::uuid,
          ${input.membershipId ?? null}::uuid, ${input.organizationId ?? null}::uuid,
          ${input.contactId ?? null}::uuid, ${input.displayName ?? null}::text,
          ${input.amount}::numeric, ${input.status ?? "soft"}::round.commitment_status,
          ${input.note ?? null}::text, ${input.interestSubmissionId ?? null}::uuid,
          ${input.createdBy ?? null}::uuid,
          CASE WHEN ${input.status ?? "soft"}::text = 'wired' THEN now() ELSE NULL END)
        RETURNING ${COMMITMENT_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("round.commitment insert returned no row");
    return hydrateCommitment(row);
  }

  /** `wired_at` is stamped by the move to `wired` and never cleared by a later move away. */
  async update(
    id: string,
    patch: {
      readonly amount?: string | undefined;
      readonly status?: CommitmentStatus | undefined;
      readonly note?: string | null | undefined;
      readonly organizationId?: string | null | undefined;
      readonly contactId?: string | null | undefined;
    },
  ): Promise<CommitmentRecord | undefined> {
    const rows = rowsOf<CommitmentRecord>(
      await this.tx.execute(sql`
        UPDATE round.commitment SET
          amount = COALESCE(${patch.amount ?? null}::numeric, amount),
          status = COALESCE(${patch.status ?? null}::round.commitment_status, status),
          note = CASE WHEN ${patch.note !== undefined}::boolean
            THEN ${patch.note ?? null}::text ELSE note END,
          organization_id = CASE WHEN ${patch.organizationId !== undefined}::boolean
            THEN ${patch.organizationId ?? null}::uuid ELSE organization_id END,
          contact_id = CASE WHEN ${patch.contactId !== undefined}::boolean
            THEN ${patch.contactId ?? null}::uuid ELSE contact_id END,
          wired_at = CASE WHEN ${patch.status ?? null}::text = 'wired' AND wired_at IS NULL
            THEN now() ELSE wired_at END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        RETURNING ${COMMITMENT_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateCommitment(row);
  }
}

// --- closing tasks --------------------------------------------------------------------------

export interface ClosingTaskRecord {
  readonly id: string;
  readonly roundId: string;
  readonly title: string;
  readonly doneAt: Date | null;
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CLOSING_TASK_COLUMNS = sql.raw(
  `id, round_id AS "roundId", title, done_at AS "doneAt", position,
   created_at AS "createdAt", updated_at AS "updatedAt"`,
);

const hydrateTask = (r: ClosingTaskRecord): ClosingTaskRecord => ({
  ...r,
  position: Number(r.position),
  doneAt: asDateOrNull(r.doneAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class ClosingTaskRepo extends TenantRepo<typeof closingTask> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(closingTask, ctx, tx);
  }

  async listForRound(roundId: string): Promise<ClosingTaskRecord[]> {
    const rows = rowsOf<ClosingTaskRecord>(
      await this.tx.execute(sql`
        SELECT ${CLOSING_TASK_COLUMNS} FROM round.closing_task
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
        ORDER BY position, created_at`),
    );
    return rows.map(hydrateTask);
  }

  /**
   * Replaces the whole list in one transaction: `PUT` semantics, because the admin screen edits
   * the checklist as a list and a per-row API would need an ordering dance the screen does not
   * do. Rows the caller kept (by id) keep their `created_at`.
   */
  async replace(
    roundId: string,
    items: readonly { id?: string | undefined; title: string; done: boolean }[],
    now: Date,
  ): Promise<ClosingTaskRecord[]> {
    const keep = items.flatMap((i) => (i.id === undefined ? [] : [i.id]));
    await this.tx.execute(sql`
      DELETE FROM round.closing_task
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND round_id = ${roundId}::uuid
        AND NOT (id = ANY(${sql.param([...keep])}::uuid[]))`);
    let position = 0;
    for (const item of items) {
      const at = position;
      position += 1;
      if (item.id === undefined) {
        await this.tx.execute(sql`
          INSERT INTO round.closing_task (workspace_id, round_id, title, position, done_at)
          VALUES (${this.ctx.workspaceId}::uuid, ${roundId}::uuid, ${item.title}::text,
                  ${at}::integer, ${item.done ? now : null}::timestamptz)`);
        continue;
      }
      await this.tx.execute(sql`
        UPDATE round.closing_task SET
          title = ${item.title}::text,
          position = ${at}::integer,
          done_at = CASE WHEN ${item.done}::boolean THEN COALESCE(done_at, ${now}::timestamptz) ELSE NULL END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${item.id}::uuid
          AND round_id = ${roundId}::uuid`);
    }
    return this.listForRound(roundId);
  }
}
