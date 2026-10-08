import type { AuditRecorder } from "@fundroom/audit";
import { type Database, platformContext, systemContext } from "@fundroom/db";
import type { WorkspaceHold } from "@fundroom/ports";
import { findCell } from "../cells/repos/cell-repo.js";
import { auditPlatformChain, auditTenantChain } from "./chains.js";
import {
  latestConfirmedScreening,
  latestScreening,
  listPlatformWorkspaceRows,
  ownerEmails,
  type PlatformAuditRow,
  type PlatformWorkspaceRow,
  platformAuditRows,
  type ScreeningSummaryRow,
} from "./repos/platform-repo.js";
import { findPlanRow, lockPlacement, writePlacement } from "./repos/provisioning-repo.js";
import { type ControlPlaneActor, setWorkspaceHold, WorkspaceStatusError } from "./status.js";

/*
 * The operator API's workspace operations (E3.10, ADR-0058; owner: agent A), behind
 * `requirePlatformOperator()`: the keyset-paged list, one workspace (with its latest sanctions
 * screening and its owners' addresses — that read is audited `platform.workspace.owners_read`),
 * plan / cell changes, suspend / unsuspend, and the platform audit chain.
 *
 * Never tenant content: names, slugs, placement, status, the subscription summary, usage counters
 * and owners' email addresses (the billing contact) only.
 *
 * Writes audit the workspace's own chain (the tenant sees an operator — the host actor — changed
 * its plan or suspended it) and then the platform chain (with the operator's IP, user agent,
 * session and note). Hold changes go through `setWorkspaceHold`, which does both.
 */

export interface PlatformDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /**
   * A sanctions driver is configured (SANCTIONS_DRIVER != none). Without one, a `sanctions_review`
   * hold with no screening at all can never be cleared by a screen, so an operator may release it
   * (fix round 3). Default: true (the strict reading).
   */
  readonly sanctionsScreening?: boolean | undefined;
  /** `WorkspaceResolver.invalidate` (single-tenant cache); run after a committed change. */
  readonly invalidate: () => void;
  readonly now?: (() => Date) | undefined;
  /**
   * E3.11 (R2-8): after a committed cell change between two cells of THIS database, point the
   * workspace's directory entry at the new cell at once (other cells route by it). Best effort:
   * a failure is the caller's to log, and the directory's reconcile sweep repairs it.
   */
  readonly onCellChanged?:
    | ((input: {
        readonly workspaceId: string;
        readonly slug: string;
        readonly cellId: string;
      }) => Promise<void>)
    | undefined;
}

export type PlatformWorkspace = Omit<PlatformWorkspaceRow, "cursorCreatedAt">;

export interface PlatformWorkspaceDetail extends PlatformWorkspace {
  readonly sanctions: Omit<ScreeningSummaryRow, "id"> | null;
  readonly owners: readonly { readonly email: string }[];
}

export class PlatformError extends Error {
  override readonly name = "PlatformError";
  constructor(
    readonly reason:
      | "not_found"
      | "invalid_cursor"
      | "plan_unavailable"
      | "cell_unavailable"
      | "sanctions_unresolved"
      /** E3.11: the hold is not the operator's to lift (`relocation` belongs to the moves engine). */
      | "hold_not_liftable"
      /** E3.11 RR3-2: a move is relocating the workspace; its cell is the move's to change. */
      | "relocating",
    message: string,
    /** Why, for `sanctions_unresolved`: `not_cleared` | `four_eyes`. */
    readonly detail?: string | undefined,
  ) {
    super(message);
  }
}

// --- cursors ------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** `timestamptz::text` as Postgres prints it (`2026-09-27 10:11:12.123456+00`). */
const PG_TIMESTAMPTZ_RE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u;

/** Opaque keyset cursor: `created_at` at full precision (text) and the id. */
export function encodeWorkspaceCursor(row: { cursorCreatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.cursorCreatedAt, row.id]), "utf8").toString("base64url");
}

export function decodeWorkspaceCursor(
  cursor: string,
): { readonly createdAt: string; readonly id: string } | undefined {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    const [createdAt, id] = v as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string" || !UUID_RE.test(id)) {
      return undefined;
    }
    if (!PG_TIMESTAMPTZ_RE.test(createdAt)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

export function encodeAuditCursor(seq: number): string {
  return Buffer.from(`seq:${seq}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(cursor: string): number | undefined {
  const m = /^seq:(\d{1,15})$/u.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

// --- reads --------------------------------------------------------------------------------------

function view(row: PlatformWorkspaceRow): PlatformWorkspace {
  const { cursorCreatedAt: _cursor, ...rest } = row;
  return rest;
}

export interface WorkspacePageQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly plan?: string | undefined;
}

export async function listPlatformWorkspaces(
  db: Database,
  query: WorkspacePageQuery,
): Promise<{ items: PlatformWorkspace[]; nextCursor: string | null }> {
  const after = query.cursor === undefined ? undefined : decodeWorkspaceCursor(query.cursor);
  if (query.cursor !== undefined && after === undefined) {
    throw new PlatformError("invalid_cursor", "bad cursor");
  }
  const rows = await db.withHost((tx) =>
    listPlatformWorkspaceRows(
      tx,
      { q: query.q, status: query.status, plan: query.plan, after },
      query.limit + 1,
    ),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(view),
    nextCursor:
      rows.length > query.limit && last !== undefined ? encodeWorkspaceCursor(last) : null,
  };
}

/**
 * One workspace with its latest screening and its owners' addresses. Reading the owners is
 * audited on the platform chain (`platform.workspace.owners_read`) in the same transaction.
 * `owners: false` (the answer to an operator WRITE) skips the owners and their audit: only the
 * detail read discloses them, so a write is never recorded as an owners read.
 */
export async function getPlatformWorkspace(
  deps: PlatformDeps,
  workspaceId: string,
  actor: ControlPlaneActor,
  opts: { readonly owners?: boolean | undefined } = {},
): Promise<PlatformWorkspaceDetail | undefined> {
  const found = await deps.db.withHost(async (tx) => {
    const [row] = await listPlatformWorkspaceRows(tx, { id: workspaceId }, 1);
    if (row === undefined) return undefined;
    const screening = await latestScreening(tx, workspaceId);
    return { row, screening };
  });
  if (found === undefined) return undefined;
  const owners = opts.owners === false ? [] : await readOwnersAudited(deps, workspaceId, actor);
  const { screening } = found;
  return {
    ...view(found.row),
    sanctions:
      screening === undefined
        ? null
        : {
            outcome: screening.outcome,
            decision: screening.decision,
            createdAt: screening.createdAt,
          },
    owners: owners.map((email) => ({ email })),
  };
}

async function readOwnersAudited(
  deps: PlatformDeps,
  workspaceId: string,
  actor: ControlPlaneActor,
): Promise<string[]> {
  return deps.db.withTenant(systemContext(workspaceId), async (tx) => {
    const emails = await ownerEmails(tx);
    await auditPlatformChain(tx, deps.audit, actor, {
      action: "platform.workspace.owners_read",
      resourceKind: "workspace",
      resourceId: workspaceId,
      meta: { workspaceId, owners: emails.length },
    });
    return emails;
  });
}

/** The platform audit chain, newest first. */
export async function platformAuditPage(
  db: Database,
  query: { readonly cursor?: string | undefined; readonly limit: number },
): Promise<{ items: PlatformAuditRow[]; nextCursor: string | null }> {
  const beforeSeq = query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
  if (query.cursor !== undefined && beforeSeq === undefined) {
    throw new PlatformError("invalid_cursor", "bad cursor");
  }
  const rows = await db.withTenant(platformContext(), (tx) =>
    platformAuditRows(tx, { beforeSeq, limit: query.limit + 1 }),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      rows.length > query.limit && last !== undefined ? encodeAuditCursor(last.seq) : null,
  };
}

// --- writes -------------------------------------------------------------------------------------

/**
 * Moves a workspace to another plan and/or cell, and/or corrects its company's legal name and
 * country (last write wins). The plan must exist and not be archived, the cell must be `active` —
 * unless it is the one the workspace already has (an archived plan stays where it is). Audited
 * `workspace.plan_change` / `workspace.cell_change` / `workspace.legal_change` on both chains.
 * `subjectChanged`: the legal name or country moved — the caller asks for a sanctions re-screen
 * (which never takes a live portal down by itself). `undefined`: no such workspace.
 */
export async function changeWorkspacePlacement(
  deps: PlatformDeps,
  workspaceId: string,
  patch: {
    readonly planId?: string | null | undefined;
    readonly cellId?: string | undefined;
    readonly legalName?: string | undefined;
    readonly country?: string | undefined;
  },
  actor: ControlPlaneActor,
): Promise<{ readonly subjectChanged: boolean } | undefined> {
  return deps.db
    .withHost(async (tx) => {
      // The workspace row first (FOR NO KEY UPDATE — what the audit chain takes anyway).
      const current = await lockPlacement(tx, workspaceId);
      if (current === undefined) return undefined;
      const planChanges = patch.planId !== undefined && patch.planId !== current.planId;
      const cellChanges = patch.cellId !== undefined && patch.cellId !== current.cellId;
      // RR3-2: under a `relocation` hold the cell belongs to the move (its directory entry is
      // `moving`); a label change here would rebind the entry and lift the move's footing.
      if (cellChanges && current.holds.includes("relocation")) {
        throw new PlatformError(
          "relocating",
          "the workspace is being moved to another cell; its cell cannot change until the move ends",
        );
      }
      const legalName = patch.legalName?.trim();
      const legalChanges = legalName !== undefined && legalName !== current.legalName;
      const countryChanges = patch.country !== undefined && patch.country !== current.country;
      const subjectChanged = legalChanges || countryChanges;
      if (planChanges && patch.planId !== null && patch.planId !== undefined) {
        const plan = await findPlanRow(tx, patch.planId);
        if (plan === undefined || plan.archivedAt !== null) {
          throw new PlatformError("plan_unavailable", "no such plan, or it is archived");
        }
      }
      if (cellChanges && patch.cellId !== undefined) {
        const cell = await findCell(tx, patch.cellId);
        if (cell === undefined || cell.status !== "active") {
          throw new PlatformError(
            "cell_unavailable",
            "no such cell, or it takes no new workspaces",
          );
        }
      }
      if (!planChanges && !cellChanges && !subjectChanged) return { subjectChanged: false };
      await writePlacement(tx, workspaceId, {
        ...(planChanges ? { planId: patch.planId ?? null } : {}),
        ...(cellChanges && patch.cellId !== undefined ? { cellId: patch.cellId } : {}),
        ...(legalChanges ? { legalName } : {}),
        ...(countryChanges && patch.country !== undefined ? { country: patch.country } : {}),
      });
      const entries = [
        ...(planChanges
          ? [
              {
                action: "workspace.plan_change" as const,
                meta: { from: current.planId, to: patch.planId ?? null },
              },
            ]
          : []),
        ...(cellChanges
          ? [
              {
                action: "workspace.cell_change" as const,
                meta: { from: current.cellId, to: patch.cellId ?? null },
              },
            ]
          : []),
        ...(subjectChanged
          ? [
              {
                // The company's name and country (not a person's): the screening subject.
                action: "workspace.legal_change" as const,
                meta: {
                  ...(legalChanges ? { fromLegalName: current.legalName, legalName } : {}),
                  ...(countryChanges
                    ? { fromCountry: current.country, country: patch.country }
                    : {}),
                },
              },
            ]
          : []),
      ];
      // Tenant chain first, then the platform chain.
      for (const e of entries) {
        await auditTenantChain(tx, deps.audit, workspaceId, actor, {
          action: e.action,
          resourceKind: "workspace",
          resourceId: workspaceId,
          meta: e.meta,
        });
      }
      for (const e of entries) {
        await auditPlatformChain(tx, deps.audit, actor, {
          action: e.action,
          resourceKind: "workspace",
          resourceId: workspaceId,
          meta: { ...e.meta, workspaceId },
        });
      }
      return {
        subjectChanged,
        // A soft-deleted workspace's entry is not routed; the sweep keeps it in step.
        movedTo:
          cellChanges && patch.cellId !== undefined && current.deletedAt === null
            ? patch.cellId
            : undefined,
        slug: current.slug,
      };
    })
    .then(async (result) => {
      if (result === undefined) return undefined;
      deps.invalidate();
      if ("movedTo" in result && result.movedTo !== undefined) {
        try {
          await deps.onCellChanged?.({
            workspaceId,
            slug: result.slug,
            cellId: result.movedTo,
          });
        } catch {
          // Best effort by contract (see `onCellChanged`); the sweep repairs it.
        }
      }
      return { subjectChanged: result.subjectChanged };
    });
}

/** Sets the `operator` hold (any other hold stays as it is). `false`: no such workspace. */
export async function suspendWorkspace(
  deps: PlatformDeps,
  workspaceId: string,
  input: { readonly note: string },
  actor: ControlPlaneActor,
): Promise<boolean> {
  const change = await deps.db
    .withHost((tx) =>
      setWorkspaceHold(
        tx,
        { workspaceId, hold: "operator", on: true, actor, note: input.note },
        { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof WorkspaceStatusError && error.reason === "not_found") return undefined;
      throw error;
    });
  change?.afterCommit();
  return change !== undefined;
}

/**
 * Whether a screening lets the `sanctions_review` hold be released: decided `cleared` (a hit or an
 * error an operator reviewed), or a clean screen nobody had to decide. Applied to the workspace's
 * LATEST screening, so never while the latest one is open.
 */
export function screeningAllowsRelease(
  s: Pick<ScreeningSummaryRow, "outcome" | "decision"> | undefined,
): boolean {
  if (s === undefined) return false;
  return s.decision === "cleared" || (s.outcome === "clear" && s.decision === null);
}

/**
 * Whether a screening lifts a CONFIRMED sanctions match (the `sanctions` hold; fix round 3): it
 * must be a real finding that the name does not match — a clean screen, or a potential match an
 * operator decided `cleared`. An `error` screening (the list was unreachable) never does, cleared
 * or not: nothing was actually compared.
 */
export function screeningLiftsSanctions(
  s: Pick<ScreeningSummaryRow, "outcome" | "decision"> | undefined,
): boolean {
  if (s === undefined) return false;
  return (
    (s.outcome === "clear" && s.decision === null) ||
    (s.outcome === "potential_match" && s.decision === "cleared")
  );
}

/**
 * Which hold an operator's unsuspend lifts: never `relocation` (E3.11 R2-11) — that hold is the
 * moves engine's, set and lifted with the directory entry it guards; lifting it by hand would
 * serve a copy the directory may already route elsewhere.
 */
export type OperatorReleasableHold = Exclude<WorkspaceHold, "relocation">;

function unresolved(detail: "not_cleared" | "four_eyes", message: string): PlatformError {
  return new PlatformError("sanctions_unresolved", message, detail);
}

/**
 * Clears one hold — `operator` unless the operator names another. Every other hold stays.
 * `false`: no such workspace.
 *
 *  - `sanctions_review`: the latest screening is clear, or decided `cleared`. Exception: with no
 *    sanctions driver configured and NO screening on record at all, the hold can never clear by
 *    itself, so the operator may release it (audited `meta.noScreening: true`).
 *  - `sanctions` (a confirmed match): a screening LATER than the confirmed one must be a clean
 *    screen or a potential match decided `cleared` (never an `error`), and — four eyes — the
 *    operator lifting it must not be the one who confirmed it (409 `sanctions_unresolved`,
 *    `reason: four_eyes`).
 *  - `billing`: an audited override (the billing job sets it again while the subscription is past
 *    its grace). `operator`: always.
 */
export async function unsuspendWorkspace(
  deps: PlatformDeps,
  workspaceId: string,
  input: { readonly note?: string | undefined; readonly hold?: OperatorReleasableHold | undefined },
  actor: ControlPlaneActor,
): Promise<boolean> {
  const hold = input.hold ?? "operator";
  // The type says so; this says so to a caller that cast its way past the type.
  if ((hold as WorkspaceHold) === "relocation") {
    throw new PlatformError(
      "hold_not_liftable",
      "a relocation hold is lifted by the move that set it (cancel the move instead)",
    );
  }
  const change = await deps.db
    .withHost(async (tx) => {
      // Our own row (the screening) before `setWorkspaceHold` locks the workspace and audits.
      const screening = await latestScreening(tx, workspaceId, true);
      let noScreening = false;
      if (hold === "sanctions_review" || hold === "sanctions") {
        const [row] = await listPlatformWorkspaceRows(tx, { id: workspaceId }, 1);
        if (row === undefined) return undefined;
        // Refused only when there is something to lift (clearing an absent flag is a no-op).
        if (row.holds.includes(hold)) {
          if (hold === "sanctions_review") {
            noScreening = screening === undefined && deps.sanctionsScreening === false;
            if (!noScreening && !screeningAllowsRelease(screening)) {
              throw unresolved("not_cleared", "the latest sanctions screening is not cleared");
            }
          } else {
            const confirmed = await latestConfirmedScreening(tx, workspaceId);
            const later =
              screening !== undefined &&
              (confirmed === undefined ||
                (screening.id !== confirmed.id &&
                  screening.createdAt.getTime() >= confirmed.createdAt.getTime()));
            if (!later || !screeningLiftsSanctions(screening)) {
              throw unresolved(
                "not_cleared",
                "a later screening must be clear, or a potential match decided cleared",
              );
            }
            if (
              confirmed?.decidedBy !== null &&
              confirmed?.decidedBy !== undefined &&
              actor.kind === "operator" &&
              confirmed.decidedBy === actor.userId
            ) {
              throw unresolved(
                "four_eyes",
                "the operator who confirmed the match cannot lift it; ask another operator",
              );
            }
          }
        }
      }
      return setWorkspaceHold(
        tx,
        {
          workspaceId,
          hold,
          on: false,
          actor,
          ...(input.note === undefined ? {} : { note: input.note }),
          meta: {
            ...(screening === undefined ? {} : { screeningId: screening.id }),
            ...(noScreening ? { noScreening: true } : {}),
          },
        },
        { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
      );
    })
    .catch((error: unknown) => {
      if (error instanceof WorkspaceStatusError && error.reason === "not_found") return undefined;
      throw error;
    });
  if (change === undefined) return false;
  change.afterCommit();
  return true;
}
