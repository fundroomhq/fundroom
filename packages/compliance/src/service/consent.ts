import type { ConsentEvent, ConsentPurpose, ConsentSource, TenantContext, Tx } from "@fundroom/db";
import type { LegalSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { z } from "zod";
import type { Actor } from "../errors.js";
import { ConsentEventRepo } from "../repos/compliance-repo.js";
import type { ComplianceDeps } from "./types.js";

/*
 * Consent for optional purposes (design/04 §3.2, R13).
 *
 * Deliberately separate from accepting a notice: GDPR requires consent to be unbundled from the
 * privacy notice, so a member who accepts the notice has not thereby agreed to engagement
 * analytics. The table is append-only; the effective answer is the newest row per
 * (membership, purpose), and a withdrawal is a new row saying `granted = false`, never a delete.
 */

/** The stored answer as the decision function sees it: granted, withdrawn, or never asked. */
export type StoredConsent = boolean | null;

export interface ConsentDecisionInput {
  readonly mode: LegalSettings["consentMode"];
  /** The newest stored answer; `null` when the member has never been asked. */
  readonly stored: StoredConsent;
  /** Whether the request carried a Global Privacy Control signal (`Sec-GPC: 1`). */
  readonly gpc?: boolean | undefined;
}

/**
 * The heart of R13, and the reason it is a pure function with its own exhaustive test: whether an
 * optional purpose is permitted for one member, right now.
 *
 * Three rules, in order.
 *
 * 1. **GPC always wins, and it always means no.** It is a legally recognised opt-out signal in
 *    several US states and an unambiguous objection everywhere else, and honouring it only in the
 *    modes where it is strictly required would be a choice to track people who asked us not to.
 *    It overrides even an explicit stored grant, because the browser signal is the more recent
 *    statement of the same person's wish.
 * 2. **`opt_in` needs a yes.** No stored grant means no — the EU rule, and the safe default.
 * 3. **`opt_out` and `notice_only` permit until the member objects.** They differ in how loudly
 *    the tenant tells people (a banner versus a notice), not in what the answer is, so they share
 *    a branch here rather than pretending to a distinction the data does not carry.
 */
export function consentAllows(input: ConsentDecisionInput): boolean {
  if (input.gpc === true) return false;
  if (input.mode === "opt_in") return input.stored === true;
  return input.stored !== false;
}

/** The purposes consent is recorded for. Mirrors the `core.consent_purpose` enum. */
export const ConsentPurposeSchema = z.enum(["analytics_engagement", "email_tracking"]);

/** How the answer was obtained. Mirrors `core.consent_source`. */
export const ConsentSourceSchema = z.enum(["gate", "settings", "gpc", "host_cmp", "admin"]);

export interface ConsentRecordInput {
  readonly membershipId: string;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly source: ConsentSource;
  /** The notice version the member was looking at when they answered, when there was one. */
  readonly noticeDocumentId?: string | undefined;
  readonly noticeVersionNo?: number | undefined;
  /** A browser family and a keyed hash, never a User-Agent string or an address (ADR-0036). */
  readonly uaFamily?: string | undefined;
  readonly ipHash?: Uint8Array | undefined;
  readonly actor?: Actor | undefined;
}

/** One purpose's effective answer, for the member's own privacy screen. */
export interface EffectiveConsent {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly source: ConsentSource;
  readonly recordedAt: Date;
}

export interface ConsentService {
  /** The newest answer per purpose. Purposes never answered are simply absent. */
  effectiveFor(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
  ): Promise<readonly EffectiveConsent[]>;
  /** The newest answer for one purpose as a bare fact: true, false, or null for never asked. */
  storedFor(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
    purpose: ConsentPurpose,
  ): Promise<StoredConsent>;
  record(ctx: TenantContext, tx: Tx, input: ConsentRecordInput): Promise<ConsentEvent>;
  /**
   * Makes a Global Privacy Control signal durable (E2.6): for each optional purpose whose newest
   * answer is not already a `gpc` refusal, appends `granted: false, source: "gpc"`. Returns the
   * purposes it wrote (empty when both were already refused by GPC — the common, write-free case).
   *
   * Why durable: most facts `allowsPurpose` judges arrive with no browser attached (an ESP open,
   * the hot-list rollup, a notification fan-out), so a header-only signal would never reach them.
   * A later explicit grant from a browser without GPC is newer and wins; the next GPC request
   * then records a newer refusal again.
   */
  recordGpcRefusal(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
    actor?: Actor | undefined,
  ): Promise<readonly ConsentPurpose[]>;
  /** The member's whole history, newest first (their privacy screen and the DSAR export). */
  history(ctx: TenantContext, tx: Tx, membershipId: string): Promise<readonly ConsentEvent[]>;
}

export function createConsentService(deps: ComplianceDeps): ConsentService {
  const service: ConsentService = {
    async effectiveFor(ctx, tx, membershipId) {
      const rows = await new ConsentEventRepo(ctx, tx).effectiveFor(membershipId);
      return rows.map((r) => ({
        purpose: r.purpose,
        granted: r.granted,
        source: r.source,
        recordedAt: r.recordedAt,
      }));
    },

    async storedFor(ctx, tx, membershipId, purpose) {
      const row = await new ConsentEventRepo(ctx, tx).latestFor(membershipId, purpose);
      return row === undefined ? null : row.granted;
    },

    async record(ctx, tx, input) {
      const row = await new ConsentEventRepo(ctx, tx).append({
        membershipId: input.membershipId,
        purpose: input.purpose,
        granted: input.granted,
        source: input.source,
        noticeDocumentId: input.noticeDocumentId ?? null,
        noticeVersionNo: input.noticeVersionNo ?? null,
        uaFamily: input.uaFamily ?? null,
        ipHash: input.ipHash === undefined ? null : Buffer.from(input.ipHash),
      });

      await deps.audit.record(tx, ctx, {
        action: "consent.recorded",
        resourceKind: "membership",
        resourceId: input.membershipId,
        subjectMembershipId: input.membershipId,
        ...(input.actor === undefined
          ? {}
          : {
              actorMembershipId: input.actor.membershipId,
              ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
            }),
        meta: { purpose: input.purpose, granted: input.granted, source: input.source },
      });
      // Ids and the answer only: who was asked and from where is already in the row above, and
      // the outbox is read by subscribers that have no business knowing it.
      await publish(tx, ctx, "consent.changed", {
        membershipId: input.membershipId,
        purpose: input.purpose,
        granted: input.granted,
        source: input.source,
      });

      return row;
    },

    async recordGpcRefusal(ctx, tx, membershipId, actor) {
      const repo = new ConsentEventRepo(ctx, tx);
      const written: ConsentPurpose[] = [];
      for (const purpose of ConsentPurposeSchema.options) {
        const newest = await repo.latestFor(membershipId, purpose);
        if (newest !== undefined && !newest.granted && newest.source === "gpc") continue;
        await service.record(ctx, tx, {
          membershipId,
          purpose,
          granted: false,
          source: "gpc",
          ...(actor === undefined ? {} : { actor }),
        });
        written.push(purpose);
      }
      return written;
    },

    history(ctx, tx, membershipId) {
      return new ConsentEventRepo(ctx, tx).listFor(membershipId);
    },
  };
  return service;
}
