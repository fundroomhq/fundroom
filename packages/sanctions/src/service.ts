import type { AuditRecorder } from "@fundroom/audit";
import {
  type ControlPlaneActor,
  setWorkspaceHold,
  type WorkspaceHoldChange,
  WorkspaceStatusError,
} from "@fundroom/control-plane";
import {
  type Database,
  platformContext,
  type SanctionsDecision,
  type SanctionsOutcome,
  type Tx,
} from "@fundroom/db";
import type {
  ControlPlaneHooks,
  JobQueuePort,
  SanctionsMatch,
  SanctionsScreeningPort,
} from "@fundroom/ports";
import { isScreenable, MATCHER_VERSION, normalizeName } from "./matcher.js";
import {
  enterPlatformContext,
  getScreening,
  insertScreening,
  isOpenScreening,
  latestScreening,
  listScreenings,
  readTxContext,
  readWorkspaceSubject,
  restoreTxContext,
  type ScreeningListRow,
  SUBJECT_NAME_MAX,
  workspacesToRescreen,
  writeDecision,
} from "./repos/screening-repo.js";

/*
 * The sanctions service (E3.10, ADR-0058; owner: agent S). `screenWorkspace` runs the port
 * OUTSIDE any transaction (network), then records `core.sanctions_screening` in a short host
 * transaction. `onWorkspaceCreated` (in-tx) only enqueues `sanctions.screen` and holds the new
 * workspace when a driver is configured, so a workspace is never active before its first screen.
 * Status changes go through `setWorkspaceHold` (flags `sanctions_review` and `sanctions` only). Tenants never see screening data (host-only
 * table, platform audit chain only); rows are kept 5 years (no FK to the workspace).
 *
 * What a screen does to the workspace:
 *
 *   outcome           held (pending_review)          active / suspended
 *   clear             release → active               nothing
 *   potential_match   stays held → operator queue    nothing → operator queue
 *   error             stays held, job retries        nothing, job retries
 *
 * A hit or an error on a workspace that is ALREADY live (the daily re-screen after a list change,
 * an operator's re-screen) never takes the portal down by itself: a fuzzy name match or a provider
 * outage is not a finding, and taking every customer offline because OFAC was unreachable would be
 * worse than the risk it guards. It is recorded and queued; only an operator's `confirmed`
 * suspends (`sanctions`). The fail-closed hold applies where nothing is live yet: a new workspace
 * is held from creation and released only by a `clear` screen or an operator's `cleared`.
 *
 * Decisions: `cleared` clears the `sanctions_review` hold only; `confirmed` sets the `sanctions`
 * hold (a suspension that outranks every other reason). Clearing a later screening NEVER lifts a
 * `sanctions` suspension: that takes an operator's explicit unsuspend (`hold: "sanctions"`), which
 * needs the workspace's latest screening clear or cleared (F1, fix round 1 — a clear decision on
 * one screening must not undo a confirmation of another).
 * Only an open screening (see the repo) can be decided. The operator's note is stored on the row
 * and on the platform chain's status entry.
 *
 * Lock order: the screening row (host-only, `FOR UPDATE` on a decision) → `setWorkspaceHold`
 * (workspace row → workspace chain → platform chain) → this service's own platform audit.
 */

export interface SanctionsServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  /** `null` with SANCTIONS_DRIVER=none (or CONTROL_PLANE=off). */
  readonly port: SanctionsScreeningPort | null;
  readonly threshold: number;
  readonly now: () => Date;
  /** Drops cached `ResolvedWorkspace` rows after a status change commits. Default: nothing. */
  readonly invalidate?: (() => void) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /**
   * In the transaction of a `confirmed` decision, after its audit rows: the wiring enqueues
   * billing's `billing.cancel` (Stripe only). Default: nothing.
   */
  readonly onConfirmed?: ((tx: Tx, workspaceId: string) => Promise<void>) | undefined;
}

export const JOB_SCREEN = "sanctions.screen";
export const JOB_REFRESH = "sanctions.refresh";
export const JOB_RESCREEN = "sanctions.rescreen";

/** Why a screen was run (job data; recorded in the audit meta). */
export type ScreenReason = "created" | "rescreen" | "operator";

export type ScreenOutcome =
  | { readonly outcome: "skipped"; readonly why: "disabled" | "no_workspace" | "deleted" }
  | {
      readonly outcome: SanctionsOutcome;
      /** `null` when an error repeated one already on record (nothing new written). */
      readonly screeningId: string | null;
      readonly listVersion: string;
      /** The hold was lifted by this screen. */
      readonly released: boolean;
      /** The provider's failure (`outcome: "error"` only). */
      readonly error?: unknown;
    };

/** The operator's request facts, for both audit chains. */
export interface OperatorActor {
  readonly userId: string;
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * The subject's name has no screenable tokens (R3-L8): an `error` screening that no retry can
 * fix — the job does not retry it; the operator decides it (or the name is corrected and
 * re-screened).
 */
export class UnscreenableNameError extends Error {
  override readonly name = "UnscreenableNameError";
  constructor() {
    super("name has no screenable tokens");
  }
}

export class SanctionsDecisionError extends Error {
  override readonly name = "SanctionsDecisionError";
  constructor(
    readonly reason: "not_found" | "not_open",
    message: string,
  ) {
    super(message);
  }
}

export interface SanctionsService {
  /** A driver is configured (the port is not null). */
  readonly enabled: boolean;
  readonly hooks: ControlPlaneHooks;
  /** Screens one workspace now (the `sanctions.screen` job's body). */
  screenWorkspace(input: {
    readonly workspaceId: string;
    readonly reason?: ScreenReason | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ScreenOutcome>;
  /** Fetches the current list version and enqueues the re-screen for it (the daily job). */
  refresh(signal?: AbortSignal): Promise<{ readonly listVersion: string }>;
  /** Enqueues one `sanctions.screen` per live workspace not yet screened against `listVersion`. */
  rescreenAll(input: {
    readonly listVersion: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly enqueued: number }>;
  /** An operator's re-screen of one workspace; `false` when there is no such (live) workspace. */
  requestRescreen(input: {
    readonly workspaceId: string;
    readonly operator: OperatorActor;
  }): Promise<boolean>;
  list(input: { readonly status: "open" | "all" }): Promise<ScreeningListRow[]>;
  get(id: string): Promise<ScreeningListRow | null>;
  decide(input: {
    readonly id: string;
    readonly decision: SanctionsDecision;
    readonly note: string;
    readonly operator: OperatorActor;
  }): Promise<ScreeningListRow>;
}

/** Rows the `all` listing returns at most. */
export const SANCTIONS_LIST_LIMIT = 200;
/** The open queue is small by construction; this only bounds a pathological one. */
const OPEN_LIST_LIMIT = 1000;
/** Workspaces per re-screen page (one short host transaction each). */
export const RESCREEN_PAGE = 200;

/** The list version an unscreenable name's `error` row carries (matcher-versioned: RR2-3). */
function unscreenableVersion(driver: string): string {
  return `${driver}:unscreenable:${MATCHER_VERSION}`;
}

function screenKey(workspaceId: string): string {
  return `screen:${workspaceId}`;
}

/** Builds the service. With `port: null` it has no hooks and screens nothing. */
export function createSanctionsService(deps: SanctionsServiceDeps): SanctionsService {
  const log = deps.log ?? (() => {});
  const invalidate = deps.invalidate ?? (() => {});
  const statusDeps = { audit: deps.audit, invalidate, now: deps.now };
  const port = deps.port;

  /** Audits on the platform chain, restoring the caller's context afterwards. */
  async function auditPlatform(
    tx: Tx,
    input: Parameters<AuditRecorder["record"]>[2],
  ): Promise<void> {
    const saved = await readTxContext(tx);
    await enterPlatformContext(tx);
    await deps.audit.record(tx, platformContext(), input);
    await restoreTxContext(tx, saved);
  }

  const hooks: ControlPlaneHooks =
    port === null
      ? {}
      : {
          async onWorkspaceCreated(handle, ws) {
            const tx = handle as Tx;
            // Held until the first screen clears it. Multi-tenant resolution reads the row per
            // request, so there is no cache to drop (`afterCommit` is for the single-mode one).
            await setWorkspaceHold(
              tx,
              {
                workspaceId: ws.id,
                hold: "sanctions_review",
                on: true,
                actor: { kind: "system", source: "sanctions" },
              },
              statusDeps,
            );
            await deps.queue.sendInTransaction(
              tx,
              JOB_SCREEN,
              { workspaceId: ws.id, reason: "created" },
              { idempotencyKey: screenKey(ws.id) },
            );
          },
        };

  async function screenWorkspace(input: {
    readonly workspaceId: string;
    readonly reason?: ScreenReason | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ScreenOutcome> {
    if (port === null) return { outcome: "skipped", why: "disabled" };
    const subject = await deps.db.withHost((tx) => readWorkspaceSubject(tx, input.workspaceId));
    if (subject === undefined) return { outcome: "skipped", why: "no_workspace" };
    if (subject.deletedAt !== null) return { outcome: "skipped", why: "deleted" };
    // Cut by code points, as SQL `left()` does (the re-screen fan-out compares with it).
    const name = Array.from((subject.legalName ?? subject.name).trim())
      .slice(0, SUBJECT_NAME_MAX)
      .join("");

    // The network call, outside any transaction.
    let result:
      | {
          ok: true;
          outcome: "clear" | "potential_match";
          listVersion: string;
          matches: readonly SanctionsMatch[];
        }
      | { ok: false; error: unknown };
    // A name with nothing to compare (only punctuation or symbols, or a script the matcher cannot
    // read) would score 0 against every entry — "clear" by default. It is an error instead
    // (R3-L8, RR2-4): held, and in the operator queue; the fan-out skips it until it is renamed.
    // The local matcher reads Latin (and transliterated Cyrillic/Greek) only; OpenSanctions
    // matches other scripts itself, so for it only a name with no letters or digits at all is.
    const unscreenable =
      port.driver === "ofac" ? !isScreenable(name) : normalizeName(name).length === 0;
    try {
      if (unscreenable) throw new UnscreenableNameError();
      const r = await port.screen(
        { name, country: subject.country, kind: "organization" },
        { threshold: deps.threshold, signal: input.signal },
      );
      result = { ok: true, outcome: r.outcome, listVersion: r.listVersion, matches: r.matches };
    } catch (error) {
      result = { ok: false, error };
    }
    const outcome: SanctionsOutcome = result.ok ? result.outcome : "error";
    const listVersion = result.ok
      ? result.listVersion
      : unscreenable
        ? unscreenableVersion(port.driver)
        : `${port.driver}:unavailable`;
    if (!result.ok) {
      log("sanctions.screen_failed", {
        level: "warn",
        workspaceId: subject.id,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }

    let change: WorkspaceHoldChange | undefined;
    const written = await deps.db.withHost(async (tx) => {
      if (!result.ok) {
        // One error on record per outage, not one per retry.
        const last = await latestScreening(tx, subject.id);
        if (last !== undefined && last.outcome === "error" && last.decision === null) return null;
      }
      const at = deps.now();
      const row = await insertScreening(tx, {
        workspaceId: subject.id,
        subjectName: name,
        subjectCountry: subject.country,
        provider: port.driver,
        listVersion,
        outcome,
        matches: result.ok
          ? result.matches.map((m) => ({
              listEntryId: m.listEntryId,
              name: m.name,
              score: m.score,
              programs: [...m.programs],
              source: m.source,
            }))
          : [],
        createdAt: at,
      });
      if (outcome === "clear") {
        change = await setWorkspaceHold(
          tx,
          {
            workspaceId: subject.id,
            hold: "sanctions_review",
            on: false,
            actor: { kind: "system", source: "sanctions" },
          },
          statusDeps,
        ).catch((error: unknown) => {
          // Purged between the read and now: nothing to release.
          if (error instanceof WorkspaceStatusError && error.reason === "not_found")
            return undefined;
          throw error;
        });
      }
      await auditPlatform(tx, {
        action: "sanctions.screen",
        resourceKind: "sanctions_screening",
        resourceId: row.id,
        actorKind: "system",
        actorMembershipId: null,
        actorUserId: null,
        occurredAt: at,
        meta: {
          workspaceId: subject.id,
          outcome,
          listVersion,
          matchCount: row.matches.length,
          reason: input.reason ?? "created",
        },
      });
      return row;
    });
    change?.afterCommit();
    return {
      outcome,
      screeningId: written?.id ?? null,
      listVersion,
      released: change?.changed === true,
      ...(result.ok ? {} : { error: result.error }),
    };
  }

  async function refresh(signal?: AbortSignal): Promise<{ listVersion: string }> {
    if (port === null) throw new Error("sanctions screening is not configured");
    const listVersion = await port.listVersion({ signal });
    // Keyed on the version: one re-screen per list snapshot however often this runs.
    await deps.queue.send(JOB_RESCREEN, { listVersion }, { idempotencyKey: listVersion });
    log("sanctions.refreshed", { listVersion });
    return { listVersion };
  }

  async function rescreenAll(input: {
    readonly listVersion: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ enqueued: number }> {
    let after: string | null = null;
    let enqueued = 0;
    for (;;) {
      if (input.signal?.aborted === true) break;
      const cursor: string | null = after;
      const ids: string[] = await deps.db.withHost((tx) =>
        workspacesToRescreen(tx, {
          listVersion: input.listVersion,
          unscreenableVersion: unscreenableVersion(port?.driver ?? "none"),
          after: cursor,
          limit: RESCREEN_PAGE,
        }),
      );
      for (const workspaceId of ids) {
        const id = await deps.queue.send(
          JOB_SCREEN,
          { workspaceId, reason: "rescreen" },
          { idempotencyKey: screenKey(workspaceId) },
        );
        if (id !== null) enqueued++;
      }
      if (ids.length < RESCREEN_PAGE) break;
      after = ids[ids.length - 1] ?? null;
    }
    log("sanctions.rescreen_enqueued", { listVersion: input.listVersion, enqueued });
    return { enqueued };
  }

  function operatorStatusActor(op: OperatorActor): ControlPlaneActor {
    return {
      kind: "operator",
      userId: op.userId,
      sessionId: op.sessionId,
      requestId: op.requestId,
      ip: op.ip,
      userAgent: op.userAgent,
    };
  }

  function operatorAudit(op: OperatorActor) {
    return {
      actorKind: "host" as const,
      actorMembershipId: null,
      actorUserId: op.userId,
      sessionId: op.sessionId ?? null,
      requestId: op.requestId ?? null,
      ip: op.ip ?? null,
      userAgent: op.userAgent ?? null,
    };
  }

  async function requestRescreen(input: {
    readonly workspaceId: string;
    readonly operator: OperatorActor;
  }): Promise<boolean> {
    if (port === null) return false;
    return deps.db.withHost(async (tx) => {
      const ws = await readWorkspaceSubject(tx, input.workspaceId);
      if (ws === undefined || ws.deletedAt !== null) return false;
      await deps.queue.sendInTransaction(
        tx,
        JOB_SCREEN,
        { workspaceId: ws.id, reason: "operator" },
        { idempotencyKey: screenKey(ws.id) },
      );
      await auditPlatform(tx, {
        action: "sanctions.screen",
        resourceKind: "workspace",
        resourceId: ws.id,
        ...operatorAudit(input.operator),
        meta: { workspaceId: ws.id, requested: true, operator: true },
      });
      return true;
    });
  }

  async function decide(input: {
    readonly id: string;
    readonly decision: SanctionsDecision;
    readonly note: string;
    readonly operator: OperatorActor;
  }): Promise<ScreeningListRow> {
    const changes: WorkspaceHoldChange[] = [];
    const row = await deps.db.withHost(async (tx) => {
      const current = await getScreening(tx, input.id, { lock: true });
      if (current === undefined) throw new SanctionsDecisionError("not_found", "no such screening");
      if (!(await isOpenScreening(tx, input.id))) {
        throw new SanctionsDecisionError(
          "not_open",
          "this screening is decided, clear, or superseded by a later one",
        );
      }
      const at = deps.now();
      await writeDecision(tx, input.id, {
        decision: input.decision,
        decidedBy: input.operator.userId,
        note: input.note,
        at,
      });
      const actor = operatorStatusActor(input.operator);
      const common = { workspaceId: current.workspaceId, actor, note: input.note };
      try {
        // `confirmed` suspends (`sanctions`; any review hold stays until a later screening is
        // clear or cleared). `cleared` releases the review hold only — never a `sanctions`
        // suspension another screening's confirmation set, nor an operator or billing one.
        changes.push(
          await setWorkspaceHold(
            tx,
            input.decision === "confirmed"
              ? { ...common, hold: "sanctions", on: true }
              : { ...common, hold: "sanctions_review", on: false },
            statusDeps,
          ),
        );
      } catch (error) {
        // The workspace is gone (screenings outlive it): the decision is still the record.
        if (!(error instanceof WorkspaceStatusError && error.reason === "not_found")) throw error;
      }
      await auditPlatform(tx, {
        action: "sanctions.decision",
        resourceKind: "sanctions_screening",
        resourceId: input.id,
        ...operatorAudit(input.operator),
        occurredAt: at,
        meta: {
          workspaceId: current.workspaceId,
          decision: input.decision,
          outcome: current.outcome,
          operator: true,
        },
      });
      // A confirmed match ends the provider subscription too (R3-L1): the outbox job, last in
      // the transaction (lock order), so it exists iff the decision commits.
      if (input.decision === "confirmed") await deps.onConfirmed?.(tx, current.workspaceId);
      return getScreening(tx, input.id);
    });
    for (const c of changes) c.afterCommit();
    if (row === undefined) throw new SanctionsDecisionError("not_found", "no such screening");
    return row;
  }

  return {
    enabled: port !== null,
    hooks,
    screenWorkspace,
    refresh,
    rescreenAll,
    requestRescreen,
    list: ({ status }) =>
      deps.db.withHost((tx) =>
        listScreenings(tx, {
          open: status === "open",
          limit: status === "open" ? OPEN_LIST_LIMIT : SANCTIONS_LIST_LIMIT,
        }),
      ),
    get: async (id) => (await deps.db.withHost((tx) => getScreening(tx, id))) ?? null,
    decide,
  };
}
