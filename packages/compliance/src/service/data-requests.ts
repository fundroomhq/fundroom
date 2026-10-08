import { type DsarKind, type DsarRequest, pgErrorCode } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { type Actor, ComplianceError } from "../errors.js";
import { readWorkspaceFacts } from "../repos/compliance-repo.js";
import { DsarRequestRepo, DsarStepRepo } from "../repos/dsar-repo.js";
import { SubjectRepo } from "../repos/subject-repo.js";
import {
  actorFields,
  type DataRequestDetail,
  type DataRequestListInput,
  listDataRequests,
  withBlockedReason,
} from "./dsar-common.js";
import { createErasureService } from "./erasure.js";

export type { DataRequestDetail, DataRequestListInput } from "./dsar-common.js";

import { erasureDueAt } from "./region.js";
import type { ErasureDeps, TenantContext, Tx } from "./types.js";

/*
 * Data-subject requests of every kind (E2.7 DSAR, contract §5).
 *
 * `core.dsar_request` carries three kinds since 0012. **Erasure** keeps its own service
 * (`./erasure.ts`): it fans out to modules and completes itself when the last one — and then the
 * kernel's `core.identity` step — has reported. **Access** (GDPR art. 15/20) and
 * **rectification** (art. 16) are records with a statutory clock that staff complete by hand:
 *
 *  - an access request is answered by the subject export (`GET /compliance/subjects/{id}/export`).
 *    The export itself changes nothing but its audit row (`compliance.dsar_exported`, carrying the
 *    zip's sha256): a download can be lost, and a GET that closed a statutory request on bytes
 *    nobody may have received would be a record of an answer that never arrived. Staff then
 *    complete the request by hand, passing the `exportSha256` they received (the export's
 *    `X-Content-SHA256` header); it must match a `compliance.dsar_exported` row for that member
 *    in this workspace (else 409 `export_unknown`) and is stamped on the request, so the register
 *    shows exactly which bytes were handed over. Completing without it (with a note — "sent by
 *    post") stays possible;
 *  - a rectification request is carried out on the People screen (the profile edit already
 *    exists and is audited there); the request is the clock and the completion note is the record.
 *
 * One open request per member **and kind** (0012's `dsar_request_open_idx`): an access request
 * and an erasure request for the same person are two clocks and may run side by side. The clock
 * is the erasure one (30 days; 45 under `us`): the same statutory rule for every right.
 */

export type ManualDataRequestKind = Exclude<DsarKind, "erasure">;

export interface DataRequestInput {
  readonly kind: ManualDataRequestKind;
  readonly membershipId: string;
  readonly note?: string | undefined;
  readonly actor: Actor;
}

export interface DataRequestService {
  create(ctx: TenantContext, tx: Tx, input: DataRequestInput): Promise<DataRequestDetail>;
  get(ctx: TenantContext, tx: Tx, id: string): Promise<DataRequestDetail | undefined>;
  list(
    ctx: TenantContext,
    tx: Tx,
    input: DataRequestListInput,
  ): Promise<{ readonly items: readonly DataRequestDetail[]; readonly nextCursor?: string }>;
  /**
   * Manual completion of an access/rectification request. An erasure request completes itself;
   * the one exception is an erasure left open because its member was the workspace's last owner
   * when the last module reported, which this finishes (see `ErasureService.finish`).
   */
  complete(
    ctx: TenantContext,
    tx: Tx,
    id: string,
    input: {
      readonly note?: string | undefined;
      /** Access only: the sha256 of the export handed over (`X-Content-SHA256`). */
      readonly exportSha256?: string | undefined;
      readonly actor: Actor;
    },
  ): Promise<DataRequestDetail>;
  /** The member's open request of `kind`, if any. */
  openFor(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
    kind: DsarKind,
  ): Promise<DsarRequest | undefined>;
}

const SHA256_RE = /^[0-9a-f]{64}$/u;

/** Whether a kind is completed by hand (true) or by its own module fan-out (erasure). */
export function isManualKind(kind: DsarKind): kind is ManualDataRequestKind {
  return kind === "access" || kind === "rectification";
}

export function createDataRequestService(deps: ErasureDeps): DataRequestService {
  // Millisecond precision: `requested_at` is a keyset column (see ./erasure.ts).
  const now = () => new Date(Math.floor((deps.now?.() ?? new Date()).getTime()));

  const openConflict = (kind: DsarKind, openId?: string) =>
    new ComplianceError("conflict", `an open ${kind} request for this member already exists`, {
      reason: "request_open",
      kind,
      ...(openId === undefined ? {} : { dataRequestId: openId }),
    });

  async function finish(
    ctx: TenantContext,
    tx: Tx,
    request: DsarRequest,
    facts: { readonly note?: string | undefined; readonly exportSha256?: string | undefined },
    actor: Actor,
  ): Promise<DsarRequest> {
    const done = await new DsarRequestRepo(ctx, tx).markCompleted(request.id, now(), {
      completionNote: facts.note ?? null,
      exportSha256: facts.exportSha256 ?? null,
    });
    if (done === undefined) throw new ComplianceError("conflict", "the request changed");
    await deps.audit.record(tx, ctx, {
      action: "compliance.dsar_completed",
      resourceKind: "dsar_request",
      resourceId: request.id,
      subjectMembershipId: request.membershipId,
      ...actorFields(actor),
      // The note is staff-authored free text about a person: it stays on the row, not the chain.
      meta: {
        kind: request.kind,
        hasNote: facts.note !== undefined,
        exportSha256: facts.exportSha256 ?? null,
        overdue: request.dueAt.getTime() < (done.completedAt ?? now()).getTime(),
      },
    });
    return done;
  }

  return {
    async create(ctx, tx, input) {
      if (!isManualKind(input.kind)) {
        throw new ComplianceError("validation_failed", "erasure requests have their own route");
      }
      const ws = await readWorkspaceFacts(tx, ctx);
      const legal = parseWorkspaceSettings(ws?.settings ?? {}).legal;
      const repo = new DsarRequestRepo(ctx, tx);
      const open = await repo.openFor(input.membershipId, input.kind);
      if (open !== undefined) throw openConflict(input.kind, open.id);
      const requestedAt = now();
      let row: DsarRequest;
      try {
        row = await repo.create({
          kind: input.kind,
          membershipId: input.membershipId,
          requestedBy: input.actor.membershipId,
          requestedAt,
          dueAt: erasureDueAt(legal.privacyRegion, requestedAt),
          expectedModules: [],
          note: input.note ?? null,
        });
      } catch (error) {
        // Two admins at once: the partial unique index is the arbiter.
        if (pgErrorCode(error) === "23505") throw openConflict(input.kind);
        throw error;
      }
      await deps.audit.record(tx, ctx, {
        action: "compliance.dsar_requested",
        resourceKind: "dsar_request",
        resourceId: row.id,
        subjectMembershipId: row.membershipId,
        ...actorFields(input.actor),
        meta: {
          kind: row.kind,
          dueAt: row.dueAt.toISOString(),
          privacyRegion: legal.privacyRegion,
        },
      });
      return { request: row, steps: [] };
    },

    async get(ctx, tx, id) {
      const request = await new DsarRequestRepo(ctx, tx).byId(id);
      if (request === undefined) return undefined;
      const steps = await new DsarStepRepo(ctx, tx).forRequests([id]);
      return withBlockedReason(ctx, tx, { request, steps }, now());
    },

    list: (ctx, tx, input) => listDataRequests(ctx, tx, { ...input, now: now() }),

    async complete(ctx, tx, id, input) {
      const repo = new DsarRequestRepo(ctx, tx);
      const current = await repo.lockById(id);
      if (current === undefined) throw new ComplianceError("not_found", "no such data request");
      if (!isManualKind(current.kind)) {
        if (input.exportSha256 !== undefined) {
          throw new ComplianceError("validation_failed", "exportSha256 is for access requests", {
            field: "exportSha256",
          });
        }
        // 409 `self_completing` unless every module has reported and only the identity step,
        // blocked by the last-owner rule at the time, is left.
        return createErasureService(deps).finish(ctx, tx, id);
      }
      if (current.status !== "requested") {
        throw new ComplianceError("conflict", `the data request is already ${current.status}`, {
          reason: "request_closed",
          status: current.status,
        });
      }
      const sha = input.exportSha256;
      if (sha !== undefined) {
        if (current.kind !== "access") {
          throw new ComplianceError("validation_failed", "exportSha256 is for access requests", {
            field: "exportSha256",
          });
        }
        if (!SHA256_RE.test(sha)) {
          throw new ComplianceError("validation_failed", "export digest must be sha256 hex", {
            field: "exportSha256",
          });
        }
        if (!(await new SubjectRepo(ctx, tx).wasExported(current.membershipId, sha))) {
          throw new ComplianceError(
            "conflict",
            "no subject export of this member with that sha256 was made in this workspace",
            { reason: "export_unknown" },
          );
        }
      }
      const done = await finish(
        ctx,
        tx,
        current,
        { note: input.note, exportSha256: sha },
        input.actor,
      );
      return { request: done, steps: [] };
    },

    openFor: (ctx, tx, membershipId, kind) =>
      new DsarRequestRepo(ctx, tx).openFor(membershipId, kind),
  };
}
