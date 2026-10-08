import {
  DSAR_IDENTITY_STEP,
  type DsarKind,
  type DsarRequest,
  type DsarStatus,
  type DsarStep,
} from "@fundroom/db";
import { type Actor, ComplianceError } from "../errors.js";
import { DsarRequestRepo, DsarStepRepo } from "../repos/dsar-repo.js";
import { type IdentityBlockedReason, identityBlockedBy } from "./identity-erasure.js";
import type { TenantContext, Tx } from "./types.js";

/* Shared by the erasure service and the data-request service (E2.6/E2.7 DSAR). */

export interface DataRequestDetail {
  readonly request: DsarRequest;
  readonly steps: readonly DsarStep[];
  /**
   * Erasure only: every expected module has reported but the kernel's identity step could not
   * run, and why (computed on read — see `./identity-erasure.ts`). Absent otherwise.
   */
  readonly blockedReason?: IdentityBlockedReason | undefined;
}

/**
 * Adds `blockedReason` to an open erasure request that is waiting on nothing but the kernel's
 * identity step. Cheap for every other row: the membership is only read for a stalled request.
 */
export async function withBlockedReason(
  ctx: TenantContext,
  tx: Tx,
  detail: DataRequestDetail,
  now: Date,
): Promise<DataRequestDetail> {
  const r = detail.request;
  if (r.kind !== "erasure" || r.status !== "requested") return detail;
  const reported = new Set(detail.steps.map((s) => s.module));
  if (reported.has(DSAR_IDENTITY_STEP)) return detail;
  if (!r.expectedModules.every((m) => reported.has(m))) return detail;
  // A report, not an erase path: no owner lock (a read must not queue behind a revocation).
  const blockedReason = await identityBlockedBy(ctx, tx, r.membershipId, now, { lock: false });
  return blockedReason === undefined ? detail : { ...detail, blockedReason };
}

export interface DataRequestListInput {
  readonly kind?: DsarKind | undefined;
  readonly status?: DsarStatus | undefined;
  readonly membershipId?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
  /** The service's clock, for `blockedReason`'s "unexpired owner" test. */
  readonly now?: Date | undefined;
}

/** Wire cursor: `base64url("<iso>|<id>")`, carrying both ORDER BY columns. */
export function encodeErasureCursor(row: Pick<DsarRequest, "requestedAt" | "id">): string {
  return Buffer.from(`${row.requestedAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeErasureCursor(
  cursor: string,
): { readonly requestedAt: Date; readonly id: string } | undefined {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const bar = raw.indexOf("|");
  if (bar < 0) return undefined;
  const requestedAt = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (Number.isNaN(requestedAt.getTime())) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
    return undefined;
  return { requestedAt, id };
}

export function actorFields(actor: Actor | undefined) {
  if (actor === undefined) return {};
  return {
    actorMembershipId: actor.membershipId,
    ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
    ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
  };
}

/** Newest first across kinds, keyset on `(requested_at, id)`, each with its steps. */
export async function listDataRequests(
  ctx: TenantContext,
  tx: Tx,
  input: DataRequestListInput,
): Promise<{ readonly items: readonly DataRequestDetail[]; readonly nextCursor?: string }> {
  let after: { requestedAt: Date; id: string } | undefined;
  if (input.after !== undefined) {
    after = decodeErasureCursor(input.after);
    if (after === undefined) throw new ComplianceError("validation_failed", "bad cursor");
  }
  const rows = await new DsarRequestRepo(ctx, tx).page({
    after,
    kind: input.kind,
    status: input.status,
    membershipId: input.membershipId,
    limit: input.limit,
  });
  const pageRows = rows.slice(0, input.limit);
  const steps = await new DsarStepRepo(ctx, tx).forRequests(pageRows.map((r) => r.id));
  const byRequest = new Map<string, DsarStep[]>();
  for (const s of steps) byRequest.set(s.requestId, [...(byRequest.get(s.requestId) ?? []), s]);
  const last = pageRows.at(-1);
  // Sequential: one transaction, one connection.
  const items: DataRequestDetail[] = [];
  for (const request of pageRows) {
    items.push(
      await withBlockedReason(
        ctx,
        tx,
        { request, steps: byRequest.get(request.id) ?? [] },
        input.now ?? new Date(),
      ),
    );
  }
  return {
    items,
    ...(rows.length > input.limit && last !== undefined
      ? { nextCursor: encodeErasureCursor(last) }
      : {}),
  };
}
