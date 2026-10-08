import type { OfferingStatus, TenantContext, Tx } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { z } from "zod";
import { type Actor, ComplianceError } from "../errors.js";
import {
  readRelationship,
  readWorkspaceFacts,
  recordRelationship,
} from "../repos/compliance-repo.js";
import type { ComplianceDeps } from "./types.js";

/*
 * The pre-existing relationship (design/04 §1.6, EXECUTION_PLAN §11, R5).
 *
 * Rule 506(b) forbids general solicitation, which in practice means the company must be able to
 * show that it knew the investor before it made the offer. The product cannot adjudicate that —
 * only counsel can — so it does the two things software is actually good at: it records the facts
 * (when the relationship began, how, and a note), and it points out the combinations that would
 * be hard to defend. It never blocks. A warning that blocks becomes a warning admins route
 * around, and the facts stop being recorded at all.
 */

/** The sources design/04 §1.6 enumerates, plus the escape hatch the note exists for. */
export const RELATIONSHIP_SOURCES = [
  "founder_invite",
  "intro",
  "prior_investor",
  "event",
  "other",
] as const;

export const RelationshipSourceSchema = z.enum(RELATIONSHIP_SOURCES);
export type RelationshipSource = (typeof RELATIONSHIP_SOURCES)[number];

/** Plain-English labels, so the admin UI and the compliance export agree on the wording. */
export const RELATIONSHIP_SOURCE_LABELS: Readonly<Record<RelationshipSource, string>> =
  Object.freeze({
    founder_invite: "Founder or staff invited them directly",
    intro: "Introduced by a named person",
    prior_investor: "Existing or prior investor in the company",
    event: "Met at an event (Rule 148 demo day or similar)",
    other: "Other — described in the note",
  });

export const RELATIONSHIP_WARNING_CODES = [
  "no_source",
  "no_date",
  "access_too_soon",
  "exposure_before_relationship",
] as const;
export type RelationshipWarningCode = (typeof RELATIONSHIP_WARNING_CODES)[number];

export interface RelationshipWarning {
  readonly code: RelationshipWarningCode;
  /** Written for a founder, not a lawyer: what is thin, and what would fix it. */
  readonly message: string;
}

export interface RelationshipWarningInput {
  readonly offeringStatus: OfferingStatus;
  /** When the membership was created — the moment access was granted. */
  readonly membershipCreatedAt: Date;
  readonly relationshipEstablishedAt?: Date | null | undefined;
  readonly relationshipSource?: string | null | undefined;
  /** First time this member was served offering material. */
  readonly firstExposureAt?: Date | null | undefined;
  /** `legal.relationshipWarningDays`; 0 disables the "too soon" branch. */
  readonly warningDays: number;
}

const DAY_MS = 86_400_000;

/**
 * The heuristic, pure and exhaustively tested. It only fires under `506b`: under `506c` public
 * solicitation is permitted and a pre-existing relationship is beside the point, and under the
 * other statuses no securities are being offered at all, so there is nothing to pre-date.
 *
 * The four branches are ordered by how damning they are. A missing source is worst — there is no
 * story at all. A missing date is next. Then the two that are about timing: access granted within
 * the warning window of the relationship starting (the relationship is real but thin), and
 * offering material served *before* the relationship date, which is either a data-entry mistake
 * or exactly the sequence 506(b) forbids. Only the first applicable warning is returned: an admin
 * who is told four things at once fixes none of them.
 */
export function relationshipWarning(
  input: RelationshipWarningInput,
): RelationshipWarning | undefined {
  if (input.offeringStatus !== "506b") return undefined;

  const source = input.relationshipSource ?? "";
  if (source.trim().length === 0) {
    return {
      code: "no_source",
      message:
        "No relationship source is recorded. Rule 506(b) needs a story for how you knew this person before the offer — record how you met them.",
    };
  }

  const established = input.relationshipEstablishedAt ?? undefined;
  if (established === undefined) {
    return {
      code: "no_date",
      message:
        "No relationship date is recorded. Record roughly when the relationship began; an approximate date you can stand behind beats none.",
    };
  }

  const exposure = input.firstExposureAt ?? undefined;
  if (exposure !== undefined && exposure.getTime() < established.getTime()) {
    return {
      code: "exposure_before_relationship",
      message:
        "This member was shown offering material before the recorded relationship date. Either the date is wrong or the material went out before you knew them — check which.",
    };
  }

  const days = Math.max(0, input.warningDays);
  if (days > 0 && input.membershipCreatedAt.getTime() - established.getTime() < days * DAY_MS) {
    return {
      code: "access_too_soon",
      message: `Access was granted within ${days} days of the recorded relationship date. That is a thin pre-existing relationship for Rule 506(b); add a note explaining the substance of it.`,
    };
  }

  return undefined;
}

export interface RelationshipInput {
  readonly establishedAt?: Date | null | undefined;
  readonly source?: RelationshipSource | null | undefined;
  readonly note?: string | null | undefined;
  /**
   * The staff member recording it, or `null` for the system — an attestation carried onto the
   * membership when an auto-approved access request's invitation is accepted (E3.1), which has no
   * approver. The audit row then says `actorKind: system`.
   */
  readonly actor: Actor | null;
}

export interface RelationshipRecord {
  readonly membershipId: string;
  readonly establishedAt: Date | null;
  readonly source: string | null;
  readonly note: string | null;
  readonly firstExposureAt: Date | null;
  /** Recomputed after the write, so the caller can show the admin what is still thin. */
  readonly warning: RelationshipWarning | undefined;
}

export interface RelationshipService {
  record(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
    input: RelationshipInput,
  ): Promise<RelationshipRecord>;
  /** The stored facts and the current warning for one member (the People screen's badge). */
  read(ctx: TenantContext, tx: Tx, membershipId: string): Promise<RelationshipRecord>;
}

export function createRelationshipService(deps: ComplianceDeps): RelationshipService {
  async function assess(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
  ): Promise<RelationshipRecord> {
    const [member, ws] = await Promise.all([
      readRelationship(tx, ctx, membershipId),
      readWorkspaceFacts(tx, ctx),
    ]);
    if (member === undefined) throw new ComplianceError("not_found", "no such member");
    const warningDays = parseWorkspaceSettings(ws?.settings ?? {}).legal.relationshipWarningDays;
    return {
      membershipId: member.id,
      establishedAt: member.relationshipEstablishedAt,
      source: member.relationshipSource,
      note: member.relationshipNote,
      firstExposureAt: member.firstExposureAt,
      warning:
        member.kind === "staff"
          ? undefined
          : relationshipWarning({
              offeringStatus: ws?.offeringStatus ?? "none",
              membershipCreatedAt: member.createdAt,
              relationshipEstablishedAt: member.relationshipEstablishedAt,
              relationshipSource: member.relationshipSource,
              firstExposureAt: member.firstExposureAt,
              warningDays,
            }),
    };
  }

  return {
    read: (ctx, tx, membershipId) => assess(ctx, tx, membershipId),

    async record(ctx, tx, membershipId, input) {
      const before = await readRelationship(tx, ctx, membershipId);
      if (before === undefined) throw new ComplianceError("not_found", "no such member");

      const row = await recordRelationship(tx, ctx, membershipId, {
        establishedAt: input.establishedAt,
        source: input.source,
        note: input.note,
      });
      if (row === undefined) {
        throw new ComplianceError("conflict", "member is revoked", { membershipId });
      }

      await deps.audit.record(tx, ctx, {
        action: "membership.relationship_recorded",
        resourceKind: "membership",
        resourceId: membershipId,
        subjectMembershipId: membershipId,
        ...(input.actor === null
          ? { actorKind: "system" as const, actorMembershipId: null }
          : {
              actorMembershipId: input.actor.membershipId,
              ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
            }),
        diff: {
          before: {
            relationshipEstablishedAt: before.relationshipEstablishedAt?.toISOString() ?? null,
            relationshipSource: before.relationshipSource,
          },
          after: {
            relationshipEstablishedAt: row.relationshipEstablishedAt?.toISOString() ?? null,
            relationshipSource: row.relationshipSource,
          },
        },
        // The note is free text an admin wrote about a person; the row carries it, audit meta
        // does not need to repeat it into a second, longer-lived store.
        meta: { source: row.relationshipSource, hasNote: (row.relationshipNote ?? "").length > 0 },
      });

      return assess(ctx, tx, membershipId);
    },
  };
}
