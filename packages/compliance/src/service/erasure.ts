import { type DsarRequest, type DsarStatus, type DsarStep, pgErrorCode } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { type Actor, ComplianceError } from "../errors.js";
import { readWorkspaceFacts } from "../repos/compliance-repo.js";
import { DsarRequestRepo, DsarStepRepo } from "../repos/dsar-repo.js";
import { listDataRequests } from "./dsar-common.js";
import { eraseIdentity, identityBlockedBy, prelockIdentityErasure } from "./identity-erasure.js";
import { erasureDueAt } from "./region.js";

export { decodeErasureCursor, encodeErasureCursor } from "./dsar-common.js";

import type { ErasureDeps, TenantContext, Tx } from "./types.js";

/*
 * DSAR erasure, kernel-orchestrated (E2.6 decision 5, design/04 §3.2).
 *
 * The kernel owns the request: who asked, the statutory clock, the legal hold that refuses it, and
 * which modules it is waiting for. It does **not** erase anything itself. Each module holding
 * personal data about the member subscribes to `member.erasure_requested`, erases or
 * pseudonymises its own rows, and reports through `LegalServices.completeErasureStep`
 * (`completeStep` below). A module reaching into another's schema to erase for it would be the
 * coupling ADR-0033 forbids.
 *
 * Deliberately retained (they are evidence, reference membership ids rather than names, or are a
 * legal obligation): `core.consent_event`, attestations, audit rows, round interest/commitments.
 *
 * E2.7: once the last expected module has reported (or at once, when none is expected) the kernel
 * runs its own final step, `core.identity` (`./identity-erasure.ts`) — membership profile,
 * invites, this workspace's sessions and, when this was the person's last live membership, the
 * global identity — in the same transaction, and only then completes the request. Every module
 * therefore still sees the address when its own step runs. This service handles `kind =
 * 'erasure'` rows only; access and rectification requests are `./data-requests.ts`.
 */

/** A module id as the registry spells it (kebab-case); the `dsar_step` CHECK repeats it. */
const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_COUNT_KEYS = 64;

export interface ErasureRequestInput {
  readonly membershipId: string;
  readonly note?: string | undefined;
  /**
   * Modules that must report before the request is complete: every compiled-in module whose
   * manifest handles `member.erasure_requested`, regardless of workspace enablement (a disabled
   * module's old rows are still personal data). Computed by the composition root (it has the
   * registry); frozen onto the row so a later deploy does not move the goalposts.
   */
  readonly expectedModules: readonly string[];
  readonly actor: Actor;
}

export interface ErasureRequestDetail {
  readonly request: DsarRequest;
  readonly steps: readonly DsarStep[];
}

export interface ErasureListInput {
  readonly status?: DsarStatus | undefined;
  readonly membershipId?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

export interface ErasureService {
  request(ctx: TenantContext, tx: Tx, input: ErasureRequestInput): Promise<ErasureRequestDetail>;
  get(ctx: TenantContext, tx: Tx, id: string): Promise<ErasureRequestDetail | undefined>;
  list(
    ctx: TenantContext,
    tx: Tx,
    input: ErasureListInput,
  ): Promise<{ readonly items: readonly ErasureRequestDetail[]; readonly nextCursor?: string }>;
  cancel(ctx: TenantContext, tx: Tx, id: string, actor: Actor): Promise<ErasureRequestDetail>;
  /**
   * Runs the kernel's identity step for a request every module has reported but which was left
   * open because the member was the workspace's last active owner at the time (see
   * `./identity-erasure.ts`). 409 `last_owner` while that is still so; 409 `self_completing` while
   * a module is still pending; 409 `request_closed` once it is no longer open.
   */
  finish(ctx: TenantContext, tx: Tx, id: string): Promise<ErasureRequestDetail>;
  /** `LegalServices.completeErasureStep`. Idempotent per (request, module); never throws for an unknown request. */
  completeStep(
    ctx: TenantContext,
    tx: Tx,
    requestId: string,
    module: string,
    counts: Readonly<Record<string, number>>,
  ): Promise<void>;
}

/** Whether every expected module has reported. An empty expectation is trivially met. */
export function erasureSatisfied(expected: readonly string[], reported: Iterable<string>): boolean {
  const done = new Set(reported);
  return expected.every((m) => done.has(m));
}

/** Numbers only, by key: non-negative integers, bounded key length and count. */
export function sanitizeErasureCounts(
  counts: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (Object.keys(out).length >= MAX_COUNT_KEYS) break;
    if (key.length === 0 || key.length > 64) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    out[key] = Math.floor(value);
  }
  return out;
}

function actorFields(actor: Actor | undefined) {
  if (actor === undefined) return {};
  return {
    actorMembershipId: actor.membershipId,
    ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
    ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
  };
}

export function createErasureService(deps: ErasureDeps): ErasureService {
  /*
   * Millisecond precision on purpose: `requested_at` is a keyset column, and a microsecond
   * `now()` would not survive the round trip through a JS `Date` in the cursor.
   */
  const now = () => new Date(Math.floor((deps.now?.() ?? new Date()).getTime()));

  async function complete(
    ctx: TenantContext,
    tx: Tx,
    request: DsarRequest,
    meta: Record<string, string | number | boolean>,
  ): Promise<DsarRequest> {
    /*
     * Re-checked now, not only at request time: a co-owner may have stepped down since. A blocked
     * request stays open with every module step recorded; its detail says why
     * (`blockedReason`), and `finish` completes it once ownership has moved.
     */
    const blocked = await identityBlockedBy(ctx, tx, request.membershipId, now());
    if (blocked !== undefined) {
      deps.log?.("dsar.identity_blocked", { requestId: request.id, reason: blocked });
      return request;
    }
    // The kernel's identity step runs last, after every module has read what it needed.
    const identity = await eraseIdentity(deps, ctx, tx, request, now());
    const done = await new DsarRequestRepo(ctx, tx).markCompleted(request.id, now());
    if (done === undefined) return request;
    await deps.audit.record(tx, ctx, {
      action: "dsar.erasure_completed",
      resourceKind: "dsar_request",
      resourceId: request.id,
      subjectMembershipId: request.membershipId,
      meta: { expectedModules: [...request.expectedModules], ...meta, global: identity.global },
    });
    return done;
  }

  return {
    async request(ctx, tx, input) {
      // Before anything audits: with no module to wait for, the identity step runs in this
      // transaction, under the chain (E3.4 fix round 1, D1).
      await prelockIdentityErasure(ctx, tx, input.membershipId);
      const ws = await readWorkspaceFacts(tx, ctx);
      const legal = parseWorkspaceSettings(ws?.settings ?? {}).legal;
      if (legal.legalHold) {
        throw new ComplianceError(
          "legal_hold",
          "the workspace is under legal hold; erasure requests are refused until it is lifted",
        );
      }
      /*
       * The identity step revokes the membership. Erasing the workspace's last active owner
       * would leave nobody able to administer it (or to answer the next request), so it is
       * refused: ownership must be transferred first.
       */
      if ((await identityBlockedBy(ctx, tx, input.membershipId, now())) === "last_owner") {
        throw new ComplianceError(
          "conflict",
          "the workspace's last owner cannot be erased; transfer ownership first",
          { reason: "last_owner" },
        );
      }
      const repo = new DsarRequestRepo(ctx, tx);
      const open = await repo.openFor(input.membershipId, "erasure");
      if (open !== undefined) {
        throw new ComplianceError(
          "conflict",
          "an erasure request for this member is already open",
          {
            reason: "erasure_open",
            // Not `requestId`: the error envelope already uses that name for the HTTP request.
            erasureRequestId: open.id,
          },
        );
      }

      const requestedAt = now();
      const expected = [...new Set(input.expectedModules)].sort();
      for (const m of expected) {
        if (!MODULE_ID_RE.test(m)) throw new ComplianceError("validation_failed", "bad module id");
      }
      let row: DsarRequest;
      try {
        row = await repo.create({
          membershipId: input.membershipId,
          requestedBy: input.actor.membershipId,
          requestedAt,
          dueAt: erasureDueAt(legal.privacyRegion, requestedAt),
          expectedModules: expected,
          note: input.note ?? null,
        });
      } catch (error) {
        // Two admins at once: the partial unique index is the arbiter.
        if (pgErrorCode(error) === "23505") {
          throw new ComplianceError(
            "conflict",
            "an erasure request for this member is already open",
            {
              reason: "erasure_open",
            },
          );
        }
        throw error;
      }

      await deps.audit.record(tx, ctx, {
        action: "dsar.erasure_requested",
        resourceKind: "dsar_request",
        resourceId: row.id,
        subjectMembershipId: row.membershipId,
        ...actorFields(input.actor),
        meta: {
          dueAt: row.dueAt.toISOString(),
          privacyRegion: legal.privacyRegion,
          expectedModules: expected,
        },
      });
      // Ids only: every subscriber reads what it needs from its own tables.
      await publish(tx, ctx, "member.erasure_requested", {
        requestId: row.id,
        membershipId: row.membershipId,
      });

      // Nothing to wait for: the request is answered the moment it is recorded.
      if (expected.length === 0) row = await complete(ctx, tx, row, { immediate: true });
      return { request: row, steps: [] };
    },

    async get(ctx, tx, id) {
      const request = await new DsarRequestRepo(ctx, tx).byId(id);
      if (request === undefined || request.kind !== "erasure") return undefined;
      return { request, steps: await new DsarStepRepo(ctx, tx).forRequests([id]) };
    },

    list: (ctx, tx, input) => listDataRequests(ctx, tx, { ...input, kind: "erasure", now: now() }),

    async cancel(ctx, tx, id, actor) {
      const repo = new DsarRequestRepo(ctx, tx);
      const current = await repo.lockById(id);
      if (current === undefined || current.kind !== "erasure")
        throw new ComplianceError("not_found", "no such erasure request");
      if (current.status !== "requested") {
        throw new ComplianceError("conflict", `the erasure request is already ${current.status}`, {
          reason: "erasure_closed",
          status: current.status,
        });
      }
      const row = await repo.markCancelled(id, now(), actor.membershipId);
      if (row === undefined) throw new ComplianceError("conflict", "the request changed");
      const steps = await new DsarStepRepo(ctx, tx).forRequests([id]);
      await deps.audit.record(tx, ctx, {
        action: "dsar.erasure_cancelled",
        resourceKind: "dsar_request",
        resourceId: id,
        subjectMembershipId: row.membershipId,
        ...actorFields(actor),
        // Modules that already reported have already erased: cancelling does not bring it back,
        // and the audit row says so rather than implying it does.
        meta: { stepsReported: steps.map((s) => s.module) },
      });
      return { request: row, steps };
    },

    async finish(ctx, tx, id) {
      const repo = new DsarRequestRepo(ctx, tx);
      const current = await repo.lockById(id);
      if (current === undefined || current.kind !== "erasure")
        throw new ComplianceError("not_found", "no such erasure request");
      if (current.status !== "requested") {
        throw new ComplianceError("conflict", `the erasure request is already ${current.status}`, {
          reason: "request_closed",
          status: current.status,
        });
      }
      const stepRepo = new DsarStepRepo(ctx, tx);
      const reported = (await stepRepo.forRequests([id])).map((s) => s.module);
      if (!erasureSatisfied(current.expectedModules, reported)) {
        throw new ComplianceError(
          "conflict",
          "an erasure request completes itself once every module has reported",
          { reason: "self_completing", kind: current.kind },
        );
      }
      if ((await identityBlockedBy(ctx, tx, current.membershipId, now())) === "last_owner") {
        throw new ComplianceError(
          "conflict",
          "the member is the workspace's last owner; transfer ownership first",
          { reason: "last_owner" },
        );
      }
      const done = await complete(ctx, tx, current, { resumed: true });
      return { request: done, steps: await stepRepo.forRequests([id]) };
    },

    async completeStep(ctx, tx, requestId, module, counts) {
      if (!MODULE_ID_RE.test(module)) {
        throw new ComplianceError("validation_failed", `bad module id ${JSON.stringify(module)}`);
      }
      const repo = new DsarRequestRepo(ctx, tx);
      // Locked: two modules reporting at once must not both see "one still missing".
      const request = await repo.lockById(requestId);
      if (request === undefined || request.kind !== "erasure") {
        deps.log?.("dsar.step_unknown_request", { requestId, module });
        return;
      }
      const clean = sanitizeErasureCounts(counts);
      const step = await new DsarStepRepo(ctx, tx).record({
        requestId,
        module,
        completedAt: now(),
        counts: clean,
      });
      // Already reported: the first report stands, and there is nothing new to audit.
      if (step === undefined) return;

      await deps.audit.record(tx, ctx, {
        action: "dsar.erasure_step_completed",
        resourceKind: "dsar_request",
        resourceId: requestId,
        subjectMembershipId: request.membershipId,
        meta: { module, counts: clean, expected: request.expectedModules.includes(module) },
      });

      if (request.status !== "requested") return;
      const reported = (await new DsarStepRepo(ctx, tx).forRequests([requestId])).map(
        (s) => s.module,
      );
      if (erasureSatisfied(request.expectedModules, reported)) {
        await complete(ctx, tx, request, { lastModule: module });
      }
    },
  };
}
