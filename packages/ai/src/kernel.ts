import type { AuditRecorder } from "@fundroom/audit";
import {
  type Database,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  lockWorkspaceFacts,
  systemContext,
  type TenantContext,
  type Tx,
  updateWorkspaceSettings,
  workspaceIsActive,
} from "@fundroom/db";
import {
  type AiSettings,
  parseWorkspaceSettings,
  WORKSPACE_SETTINGS_SCHEMA_VERSION,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import {
  AI_FEATURES,
  type AiFeature,
  type AiPrompt,
  type AiServices,
  AiStartError,
  type AiStartErrorCode,
  type AiTaskInput,
  type RegisteredAiTask,
} from "@fundroom/module-kit";
import {
  type Entitlements,
  type EntitlementsPort,
  type JobDefinition,
  type JobQueuePort,
  type JsonObject,
  type ModelPort,
  ModelProviderError,
  type ModelProviderInfo,
  type ModelRequest,
  type ModelResult,
  type RateLimiterPort,
} from "@fundroom/ports";
import {
  type AiFeatureFlags,
  acknowledged,
  aiProviderKey,
  effectiveAiFeatures,
  effectiveBudget,
  flagOf,
  msUntilNextMonth,
  parseModelJson,
  Semaphore,
  sanitizeJson,
  usageMonth,
} from "./policy.js";
import {
  AiRequestRepo,
  type AiRequestRow,
  addUsage,
  DISCARDED,
  type MemberFacts,
  memberFacts,
  readUsage,
  readWorkspaceSettings,
} from "./repos/ai-repo.js";

/*
 * The AI kernel (E3.12 contract §7, ADR-0060): settings, effective state, start, the single
 * `ai.run` job, the retention/stale sweep, and the deletion hooks. AI never writes tenant content:
 * a request's `result` is a suggestion staff apply through the product's own write paths.
 *
 * Transactions are short and never span a model call or a task's `prepare`/`finish`.
 *
 * Lock order: start = `ai.start:<workspace>` advisory lock → (the new request row) → workspace row
 * and audit chain (the audit) → outbox; settings = workspace row → request rows (cancel) → chain;
 * job = one request row → the month's usage row (never the workspace row, never audits);
 * erasure = (chain) → request rows. No path takes a request row and then waits for the workspace
 * row or the chain, so none of these can wait on each other in a cycle.
 */

export const AI_JOBS = { run: "ai.run", retention: "ai.retention" } as const;
export const AI_RETENTION_CRON = "17 * * * *";
/** Queued + running requests per workspace at once (contract §7). */
export const AI_MAX_IN_FLIGHT = 4;
/** A task's stored result, serialised, at most this long. */
export const AI_MAX_RESULT_BYTES = 256 * 1024;
export const AI_CORRECTIVE_PROMPT = "Reply with JSON only that matches the schema.";

const HOUR_MS = 60 * 60_000;
/** A queued request nobody claimed for this long is failed `stale` by the sweep. */
export const AI_QUEUED_STALE_MS = HOUR_MS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_RE = /^[a-z_]{1,64}$/u;

const START_MESSAGES: Record<AiStartErrorCode, string> = {
  ai_unavailable: "AI assist is not configured on this install",
  ai_disabled: "AI assist is turned off for this feature in this workspace",
  ai_acknowledgement_required:
    "AI assist needs an administrator to acknowledge the current AI provider",
  ai_rate_limited: "too many AI requests; try again later",
  ai_busy: "this workspace has too many AI requests in progress; try again shortly",
  ai_budget_exhausted: "this workspace's monthly AI budget is used up",
};

/**
 * An `AiStartError` the API error handler adopts as it is: `code` is an API error code, the
 * message is the contract's, and `details.retryAfterMs` becomes `Retry-After`.
 */
export class AiKernelStartError extends AiStartError {
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    code: AiStartErrorCode,
    retryAfterMs?: number,
    extra: { readonly message?: string; readonly reason?: string } = {},
  ) {
    super(code, retryAfterMs);
    this.message = extra.message ?? START_MESSAGES[code];
    this.details = {
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    };
  }
}

/** A settings write the contract refuses with 400 (adopted by the API error handler). */
export class AiSettingsError extends Error {
  override readonly name = "AiSettingsError";
  readonly code = "validation_failed" as const;
  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** The operator's AI_* limits (packages/config). */
export interface AiLimits {
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxInputChars: number;
  readonly concurrency: number;
  readonly monthlyTokenBudget: number;
  readonly requestsPerUserHour: number;
  readonly resultRetentionHours: number;
  /**
   * Worst-case tokens one request can spend (both calls incl. the corrective turn, dense
   * scripts): `aiRequestReservation(env)` from `@fundroom/config` (RR1-L1/M3). Reserved while a
   * request is in flight; also the smallest usable monthly budget.
   */
  readonly reservationTokens: number;
}

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface AiKernelDeps {
  readonly db: Database;
  /** null = AI unavailable on this install (AI_PROVIDER=none). */
  readonly model: ModelPort | null;
  readonly limits: AiLimits;
  readonly rateLimiter: RateLimiterPort;
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "sendInTransaction">;
  /** The registered tasks (lazy: modules resolve against the live `ModuleServices`). */
  readonly tasks: () => ReadonlyMap<AiFeature, RegisteredAiTask>;
  /** Is `module` enabled for the workspace (outside any tx). */
  readonly moduleEnabled: (ctx: TenantContext, module: string) => Promise<boolean>;
  readonly hasPermission: (
    membership: {
      readonly kind: "staff" | "external";
      readonly role: string;
      readonly status: string;
      readonly expiresAt?: Date | null | undefined;
    },
    permission: string,
  ) => boolean;
  /**
   * Is the membership erased (or being erased)? Read INSIDE the start transaction
   * (`LegalServices.isErased`); an erased requester cannot start a request (R1-L4).
   */
  readonly isErased?:
    | ((tx: Tx, ctx: TenantContext, membershipId: string) => Promise<boolean>)
    | undefined;
  /** Called after a settings write commits (the resolver caches `settings`). */
  readonly invalidate?: (() => void) | undefined;
  /**
   * The plan's entitlements (A-3, ADR-0063), resolved per use: the server builds this port after
   * the kernel. AI is a feature whose every use is the feature itself, so a plan without `ai`
   * refuses turning it on (settings), every new start (402) and every queued request's run.
   * Absent = everything allowed (tests, and an install without the control plane anyway).
   */
  readonly entitlements?: (() => EntitlementsPort) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

/** `GET /ai/status` (contracts `AiStatus`). */
export interface AiStatusView {
  readonly available: boolean;
  readonly provider: {
    readonly id: ModelProviderInfo["id"];
    readonly label: string;
    readonly model: string;
    readonly hosting: ModelProviderInfo["hosting"];
    readonly location: string | null;
    readonly jurisdiction: ModelProviderInfo["jurisdiction"];
    readonly trainsOnInputs: false | null;
    readonly retention: string;
  } | null;
  readonly settings: AiSettings;
  readonly needsAcknowledgement: boolean;
  readonly effective: AiFeatureFlags;
  /**
   * The workspace's plan includes AI (A-3). Independent of `effective`, which stays the settings
   * and install rule: a workspace downgraded with AI on still sees its settings as they are, and
   * every start answers 402 `plan_limit` until the plan changes.
   */
  readonly planAllows: boolean;
  readonly usage: {
    readonly month: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly requests: number;
    readonly budget: number;
    /** One request's reservation: a budget below it can never start a request. */
    readonly minimumBudget: number;
    /** The effective budget is below `minimumBudget`: every feature reads off (RR3-L8). */
    readonly budgetBelowMinimum: boolean;
  };
}

/** `GET /ai/requests/{id}` (contracts `AiRequest`). */
export interface AiRequestView {
  readonly id: string;
  readonly feature: AiFeature;
  readonly subjectId: string | null;
  readonly status: AiRequestRow["status"];
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly result: JsonObject | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface AiSettingsInput {
  readonly enabled: boolean;
  readonly features: AiFeatureFlags;
  readonly monthlyTokenBudget: number | null;
  readonly acknowledge: boolean;
}

export interface AiActor {
  readonly membershipId: string;
  readonly userId?: string | undefined;
  readonly requestId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
}

/** Who reads or discards a request: the membership row (for the task permission re-check). */
export interface AiCaller {
  readonly membershipId: string;
  readonly membership: {
    readonly kind: "staff" | "external";
    readonly role: string;
    readonly status: string;
    readonly expiresAt?: Date | null | undefined;
  };
}

export interface AiKernel {
  readonly info: ModelProviderInfo | null;
  readonly limits: AiLimits;
  readonly services: AiServices;
  status(ctx: TenantContext): Promise<AiStatusView>;
  updateSettings(ctx: TenantContext, input: AiSettingsInput, actor: AiActor): Promise<AiStatusView>;
  /** undefined = 404 (not the caller's, or the caller lost the task's permission). */
  getRequest(ctx: TenantContext, id: string, caller: AiCaller): Promise<AiRequestView | undefined>;
  /** false = 404 (same rule as `getRequest`). */
  deleteRequest(ctx: TenantContext, id: string, caller: AiCaller): Promise<boolean>;
  /** Runs one request as the `ai.run` job would (tests; the job handler calls this). */
  run(requestId: string, workspaceId: string, signal?: AbortSignal): Promise<void>;
  /** One pass of the hourly sweep for one workspace: expired rows deleted, stale ones failed. */
  sweep(workspaceId: string): Promise<{ readonly deleted: number; readonly stale: number }>;
  readonly jobs: readonly JobDefinition<JsonObject>[];
}

interface Outcome {
  readonly status: "done" | "failed" | "refused";
  readonly result: JsonObject | null;
  readonly errorCode: string | null;
}

const failed = (code: string): Outcome => ({ status: "failed", result: null, errorCode: code });
const refused = (code: string): Outcome => ({
  status: "refused",
  result: null,
  errorCode: CODE_RE.test(code) ? code : "refused",
});

function settingsOf(raw: unknown): AiSettings {
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return parseWorkspaceSettings(obj).ai;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function iso(d: Date | string | null): string | null {
  if (d === null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export function createAiKernel(deps: AiKernelDeps): AiKernel {
  const now = deps.now ?? (() => new Date());
  const log: Log = deps.log ?? (() => {});
  const info = deps.model?.info ?? null;
  const providerKey = info === null ? null : aiProviderKey(info);
  const limits = deps.limits;
  const semaphore = new Semaphore(limits.concurrency);
  const perUserRule = { max: limits.requestsPerUserHour, windowMs: HOUR_MS };
  /** Worst-case tokens one request can spend (one call): reserved while it is in flight. */
  const jobExpireSeconds = Math.ceil(limits.timeoutMs / 1000) * 2 + 60;
  const reservation = limits.reservationTokens;
  /** The effective budget cannot fund one request (e.g. after the operator raised AI_MAX_*). */
  const belowMinimum = (settings: AiSettings): boolean =>
    effectiveBudget(settings, limits.monthlyTokenBudget) < reservation;
  /**
   * Effective features for THIS install: the settings rule (`effectiveAiFeatures`) and a budget
   * that can fund at least one request — otherwise AI reads off, never "on but every start is
   * refused until next month" (RR3-L8).
   */
  const effectiveOf = (settings: AiSettings): AiFeatureFlags => {
    const f = effectiveAiFeatures(settings, info);
    return belowMinimum(settings) ? { updateDraft: false, qaAnswer: false } : f;
  };

  /** The workspace's entitlements, read on `tx` (never a second pool connection). */
  const entitlementsOn = async (tx: Tx, workspaceId: string): Promise<Entitlements | undefined> =>
    deps.entitlements === undefined ? undefined : deps.entitlements().forWorkspace(tx, workspaceId);
  const allowsAi = (e: Entitlements | undefined): boolean => e?.allowsFeature("ai") ?? true;
  /** Throws the 402 `plan_limit` `{ limit: "feature", feature: "ai" }` when the plan lacks AI. */
  const assertAi = (e: Entitlements | undefined): void => {
    if (e !== undefined) deps.entitlements?.().assertFeature(e, "ai");
  };

  const providerView = (): AiStatusView["provider"] =>
    info === null
      ? null
      : {
          id: info.id,
          label: info.label,
          model: info.model,
          hosting: info.hosting,
          location: info.location,
          jurisdiction: info.jurisdiction,
          trainsOnInputs: info.trainsOnInputs,
          retention: info.retention,
        };

  function statusOf(
    settings: AiSettings,
    usage: { inputTokens: number; outputTokens: number; requests: number },
    at: Date,
    planAllows: boolean,
  ): AiStatusView {
    return {
      available: info !== null,
      provider: providerView(),
      settings,
      needsAcknowledgement: info !== null && !acknowledged(settings, info),
      effective: effectiveOf(settings),
      planAllows,
      usage: {
        month: usageMonth(at).slice(0, 7),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        requests: usage.requests,
        budget: effectiveBudget(settings, limits.monthlyTokenBudget),
        minimumBudget: reservation,
        budgetBelowMinimum: belowMinimum(settings),
      },
    };
  }

  async function status(ctx: TenantContext): Promise<AiStatusView> {
    const at = now();
    const { settings, usage, planAllows } = await deps.db.withTenant(ctx, async (tx) => ({
      settings: settingsOf(await readWorkspaceSettings(tx, ctx.workspaceId)),
      usage: await readUsage(tx, ctx, usageMonth(at)),
      planAllows: allowsAi(await entitlementsOn(tx, ctx.workspaceId)),
    }));
    return statusOf(settings, usage, at, planAllows);
  }

  async function updateSettings(
    ctx: TenantContext,
    input: AiSettingsInput,
    actor: AiActor,
  ): Promise<AiStatusView> {
    if (info === null && (input.enabled || input.acknowledge)) {
      throw new AiKernelStartError("ai_unavailable");
    }
    const at = now();
    const next = await deps.db.withTenant(ctx, async (tx) => {
      // Read-modify-write on the locked row, never on the resolver's cached copy: the whole
      // jsonb is replaced, so a concurrent writer of any other block must not be undone.
      const facts = await lockWorkspaceFacts(tx, ctx.workspaceId);
      if (facts === undefined) throw new Error("workspace not visible to this transaction");
      const raw = isPlainObject(facts.settings) ? (facts.settings as Record<string, unknown>) : {};
      const current = parseWorkspaceSettings(raw);
      const before = current.ai;
      const entitlements = await entitlementsOn(tx, ctx.workspaceId);
      // A plan without AI refuses only what turns something on: AI going on, or a feature flag
      // going on while AI is (or goes) on. Turning things off, the budget, an acknowledgement and
      // a save that keeps what is on stay allowed after a downgrade (A-3 §4: toggles are gated on
      // the transition). Before the 409s below, so the plan is the answer, not a step to clear first.
      const turnsOn =
        input.enabled &&
        (!before.enabled ||
          (input.features.updateDraft && !before.features.updateDraft) ||
          (input.features.qaAnswer && !before.features.qaAnswer));
      if (turnsOn) assertAi(entitlements);
      // Above the operator's cap is refused — unless it is the value already stored: an operator
      // who lowered the cap must not block every later save (R3-L10; the cap applies on read).
      if (
        input.monthlyTokenBudget !== null &&
        input.monthlyTokenBudget > limits.monthlyTokenBudget &&
        input.monthlyTokenBudget !== before.monthlyTokenBudget
      ) {
        throw new AiSettingsError("monthlyTokenBudget is above the operator's monthly budget", {
          max: limits.monthlyTokenBudget,
        });
      }
      // Below one request's reservation nothing could ever start (RR1-M3).
      if (
        input.monthlyTokenBudget !== null &&
        input.monthlyTokenBudget < reservation &&
        input.monthlyTokenBudget !== before.monthlyTokenBudget
      ) {
        throw new AiSettingsError(
          `monthlyTokenBudget must be at least ${reservation} (one request's reservation)`,
          { min: reservation },
        );
      }
      let acknowledgement = before.acknowledgement;
      if (input.acknowledge && info !== null && providerKey !== null) {
        acknowledgement = {
          providerKey,
          hosting: info.hosting,
          at: at.toISOString(),
          byMembershipId: actor.membershipId,
        };
      }
      if (input.enabled && acknowledgement?.providerKey !== providerKey) {
        throw new AiKernelStartError("ai_acknowledgement_required");
      }
      const after: AiSettings = {
        enabled: input.enabled,
        features: { updateDraft: input.features.updateDraft, qaAnswer: input.features.qaAnswer },
        monthlyTokenBudget: input.monthlyTokenBudget,
        acknowledgement,
      };
      const merged = WorkspaceSettingsSchema.parse({ ...current, ai: after });
      await updateWorkspaceSettings(tx, ctx.workspaceId, {
        ...raw,
        ...merged,
        settingsSchemaVersion: WORKSPACE_SETTINGS_SCHEMA_VERSION,
      });
      // Whatever is now off loses its queued and running requests, in this transaction (a job
      // that finishes later finds its row no longer running and drops the result).
      const off = AI_FEATURES.filter((f) => !(after.enabled && after.features[flagOf(f)]));
      const cancelled = await new AiRequestRepo(ctx, tx).cancelInFlight(off, at);
      const usage = await readUsage(tx, ctx, usageMonth(at));
      // Audit last (workspace row → chain; the row is already held).
      await deps.audit.record(tx, ctx, {
        action: "ai.settings_updated",
        resourceKind: "workspace",
        resourceId: ctx.workspaceId,
        actorMembershipId: actor.membershipId,
        ...(actor.userId === undefined ? {} : { actorUserId: actor.userId }),
        requestId: actor.requestId ?? null,
        sessionId: actor.sessionId ?? null,
        meta: {
          before: before as unknown as JsonObject,
          after: merged.ai as unknown as JsonObject,
          cancelled,
        },
      });
      return { settings: merged.ai, usage, planAllows: allowsAi(entitlements) };
    });
    deps.invalidate?.();
    return statusOf(next.settings, next.usage, at, next.planAllows);
  }

  function startRefusal(settings: AiSettings, feature: AiFeature): AiKernelStartError {
    if (info === null) return new AiKernelStartError("ai_unavailable");
    if (effectiveAiFeatures(settings, info)[flagOf(feature)] && belowMinimum(settings)) {
      return new AiKernelStartError("ai_disabled", undefined, {
        message: "this workspace's monthly AI budget is below the minimum one request needs",
        reason: "budget_below_minimum",
      });
    }
    if (settings.enabled && settings.features[flagOf(feature)] && !acknowledged(settings, info)) {
      return new AiKernelStartError("ai_acknowledgement_required");
    }
    return new AiKernelStartError("ai_disabled");
  }

  const services: AiServices = {
    async start(ctx, input) {
      const model = deps.model;
      if (model === null || info === null || providerKey === null) {
        throw new AiKernelStartError("ai_unavailable");
      }
      if (deps.tasks().get(input.feature) === undefined) {
        throw new AiKernelStartError("ai_unavailable");
      }
      // The raw row, never the resolver's cached copy: a switch-off is effective at once. The plan
      // is read in the same short transaction: every start IS the feature, so a plan without AI
      // refuses it (402 `plan_limit`) whatever the settings say (A-3).
      const { settings, entitlements } = await deps.db.withTenant(ctx, async (tx) => ({
        settings: settingsOf(await readWorkspaceSettings(tx, ctx.workspaceId)),
        entitlements: await entitlementsOn(tx, ctx.workspaceId),
      }));
      assertAi(entitlements);
      if (!effectiveOf(settings)[flagOf(input.feature)]) {
        throw startRefusal(settings, input.feature);
      }
      // Never pass a lone surrogate or NUL to a query: the driver error would quote the params
      // (staff notes, question text) into the server log (RR1-L2).
      const params = sanitizeJson(input.params) as JsonObject;
      const budget = effectiveBudget(settings, limits.monthlyTokenBudget);
      /** Busy / budget against the counts; the in-tx call (under the lock) is authoritative. */
      const capacity = (inFlightCount: number, used: number, at: Date): void => {
        if (inFlightCount >= AI_MAX_IN_FLIGHT) throw new AiKernelStartError("ai_busy");
        if (used + reservation > budget) {
          throw new AiKernelStartError("ai_budget_exhausted", msUntilNextMonth(at));
        }
        // Only the reservations of OTHER in-flight requests tip it over: a slot frees within
        // minutes, so this is "busy", not "used up until next month" (RR1-M3).
        if (used + (inFlightCount + 1) * reservation > budget) {
          throw new AiKernelStartError("ai_busy");
        }
      };
      // Asking again for the same request (equal params) while it is in flight is not a new
      // start; and a start that would be refused anyway must not spend the user's hourly limit
      // (RR1-L3) — both read without the lock, before the charge.
      const limiterKey = `ai.start:${input.actor.membershipId}`;
      // The user's own limit answers first (nothing charged yet): an exhausted user is told so,
      // never "the workspace budget is used up" (E3.2 lesson 4).
      const peek = await deps.rateLimiter.peek(limiterKey, perUserRule);
      const pre = now();
      const precheck = await deps.db.withTenant(ctx, async (tx) => {
        const repo = new AiRequestRepo(ctx, tx);
        const reuse = await repo.reusable(
          input.feature,
          input.subjectId,
          input.actor.membershipId,
          params,
        );
        if (reuse !== undefined) return reuse;
        if (!peek.allowed) throw new AiKernelStartError("ai_rate_limited", peek.retryAfterMs);
        const used = await readUsage(tx, ctx, usageMonth(pre));
        capacity(await repo.countInFlight(), used.inputTokens + used.outputTokens, pre);
        return undefined;
      });
      if (precheck !== undefined) return { requestId: precheck.id, reused: true };
      // Per user BEFORE anything the workspace shares (E3.2 lesson 4): one user must not be able
      // to spend the workspace's in-flight slots or budget past their own limit. Charged
      // atomically (hit, then check) so concurrent starts cannot overshoot (R1-L2); outside any
      // transaction (the limiter has its own connection).
      const hit = await deps.rateLimiter.hit(limiterKey, perUserRule);
      if (!hit.allowed) throw new AiKernelStartError("ai_rate_limited", hit.retryAfterMs);

      const at = now();
      return deps.db.withTenant(ctx, async (tx) => {
        const repo = new AiRequestRepo(ctx, tx);
        await repo.lockStart();
        const existing = await repo.reusable(
          input.feature,
          input.subjectId,
          input.actor.membershipId,
          params,
        );
        if (existing !== undefined) return { requestId: existing.id, reused: true };
        if (
          deps.isErased !== undefined &&
          (await deps.isErased(tx, ctx, input.actor.membershipId))
        ) {
          throw new AiKernelStartError("ai_disabled");
        }
        // Budget with reservations (R1-H1/M3): every in-flight request (this one included) is
        // counted at its worst case until its job settles and records what it actually used.
        const usage = await readUsage(tx, ctx, usageMonth(at));
        capacity(await repo.countInFlight(), usage.inputTokens + usage.outputTokens, at);
        const row = await repo.insert({
          feature: input.feature,
          subjectId: input.subjectId,
          requestedBy: input.actor.membershipId,
          params,
          provider: providerKey,
          model: info.model,
          createdAt: at,
          expiresAt: new Date(at.getTime() + limits.resultRetentionHours * HOUR_MS),
        });
        await deps.audit.record(tx, ctx, {
          action: "ai.request_started",
          resourceKind: "ai_request",
          resourceId: row.id,
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          meta: { feature: input.feature, subjectId: input.subjectId },
        });
        await deps.queue.sendInTransaction(
          tx,
          AI_JOBS.run,
          { requestId: row.id, workspaceId: ctx.workspaceId },
          { idempotencyKey: `${AI_JOBS.run}:${row.id}` },
        );
        return { requestId: row.id, reused: false };
      });
    },

    async discardForSubject(tx: Tx, ctx: TenantContext, feature: AiFeature, subjectId: string) {
      return new AiRequestRepo(ctx, tx).deleteForSubject(feature, subjectId, now());
    },

    async discardCiting(tx: Tx, ctx: TenantContext, documentId: string) {
      if (!UUID_RE.test(documentId)) return 0;
      return new AiRequestRepo(ctx, tx).deleteCiting(documentId, now());
    },
  };

  async function visibleRow(
    ctx: TenantContext,
    id: string,
    caller: AiCaller,
  ): Promise<AiRequestRow | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const row = await deps.db.withTenant(ctx, (tx) =>
      new AiRequestRepo(ctx, tx).ownedBy(id, caller.membershipId),
    );
    // Discarded by its requester: gone for them (the row only waits for its job to settle).
    if (row === undefined || row.errorCode === DISCARDED) return undefined;
    const task = deps.tasks().get(row.feature);
    if (task === undefined || !deps.hasPermission(caller.membership, task.task.permission)) {
      return undefined;
    }
    return row;
  }

  async function getRequest(
    ctx: TenantContext,
    id: string,
    caller: AiCaller,
  ): Promise<AiRequestView | undefined> {
    const row = await visibleRow(ctx, id, caller);
    if (row === undefined) return undefined;
    return {
      id: row.id,
      feature: row.feature,
      subjectId: row.subjectId,
      status: row.status,
      errorCode: row.errorCode,
      createdAt: iso(row.createdAt) ?? "",
      finishedAt: iso(row.finishedAt),
      result: isPlainObject(row.result) ? (row.result as JsonObject) : null,
      usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
    };
  }

  async function deleteRequest(ctx: TenantContext, id: string, caller: AiCaller): Promise<boolean> {
    const row = await visibleRow(ctx, id, caller);
    if (row === undefined) return false;
    // A running request is cancelled, not deleted: its model call is under way, so it keeps its
    // slot and reservation until the job settles (which then deletes it) — R1-H1.
    await deps.db.withTenant(ctx, (tx) => new AiRequestRepo(ctx, tx).discard(row.id, now()));
    return true;
  }

  // --- the job --------------------------------------------------------------------------------

  async function callModel(
    model: ModelPort,
    req: ModelRequest,
    usage: { input: number; output: number; calls: number },
  ): Promise<ModelResult> {
    usage.calls += 1;
    let result: ModelResult;
    try {
      result = await model.generate(req);
    } catch (error) {
      // The provider may have processed (and billed) the prompt: charge it at the worst case of
      // one token per character (R1-M3, RR3-L6; errors report no output tokens).
      const chars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
      usage.input += chars;
      throw error;
    }
    usage.input += Math.max(0, Math.trunc(result.usage.inputTokens));
    usage.output += Math.max(0, Math.trunc(result.usage.outputTokens));
    return result;
  }

  /** undefined = go on; else the outcome to stop with (a dropped one when no longer running). */
  async function stillGo(row: AiRequestRow): Promise<Outcome | undefined> {
    const sctx = systemContext(row.workspaceId);
    const { running, active } = await deps.db.withTenant(sctx, async (tx) => ({
      running: await new AiRequestRepo(sctx, tx).isRunning(row.id),
      active: await workspaceIsActive(tx, row.workspaceId),
    }));
    if (!running) return failed("cancelled");
    if (!active) return refused("workspace_unavailable");
    return undefined;
  }

  /** Everything between claim and finish; never inside a transaction. */
  async function execute(
    row: AiRequestRow,
    signal: AbortSignal | undefined,
    usage: { input: number; output: number; calls: number },
  ): Promise<Outcome> {
    const model = deps.model;
    if (model === null || info === null) return refused("disabled");
    const sctx = systemContext(row.workspaceId);
    // Fresh settings and the requester's standing: either may have changed since the start.
    const { settings, member, active, planAllows } = await deps.db.withTenant(sctx, async (tx) => ({
      settings: settingsOf(await readWorkspaceSettings(tx, row.workspaceId)),
      member: await memberFacts(tx, sctx, row.requestedBy),
      active: await workspaceIsActive(tx, row.workspaceId),
      planAllows: allowsAi(await entitlementsOn(tx, row.workspaceId)),
    }));
    // A suspended, held (sanctions, relocation) or deleted workspace sends nothing out (R1-M1).
    if (!active) return refused("workspace_unavailable");
    if (!effectiveOf(settings)[flagOf(row.feature)]) return refused("disabled");
    // Queued before a downgrade: the plan no longer includes AI, so nothing goes to the model —
    // refused like a switch-off, with the reason the requester can act on (A-3).
    if (!planAllows) return refused("plan_limit");
    const registered = deps.tasks().get(row.feature);
    if (registered === undefined) return refused("disabled");
    if (!(await deps.moduleEnabled(sctx, registered.module))) return refused("disabled");
    const { task } = registered;
    if (member === undefined || !deps.hasPermission(member, task.permission)) {
      return refused("forbidden");
    }
    const params = task.paramsSchema.safeParse(row.params);
    if (!params.success) return failed("invalid_params");

    const tctx = requesterContext(row.workspaceId, member);
    const input: AiTaskInput = {
      requestId: row.id,
      workspaceId: row.workspaceId,
      subjectId: row.subjectId,
      params: params.data,
      requestedBy: { membershipId: row.requestedBy },
      maxInputChars: limits.maxInputChars,
    };
    const prepared = await task.prepare(tctx, input);
    if (prepared.kind === "refused") return refused(prepared.code);
    const prompt: AiPrompt = prepared;
    if (prompt.system.length + prompt.user.length > limits.maxInputChars) {
      return refused("input_too_large");
    }

    const maxOutputTokens = Math.min(
      prompt.maxOutputTokens ?? Number.POSITIVE_INFINITY,
      limits.maxOutputTokens,
    );
    const release = await semaphore.acquire(signal);
    let parsed: { json: unknown; text: string } | undefined;
    try {
      // The wait for a slot can be long: still wanted, and may the workspace still send?
      const gate = await stillGo(row);
      if (gate !== undefined) return gate;
      const base = {
        system: prompt.system,
        maxOutputTokens,
        json: prompt.json,
        ...(signal === undefined ? {} : { signal }),
      };
      const messages: ModelRequest["messages"] = [{ role: "user", content: prompt.user }];
      let result = await callModel(model, { ...base, messages }, usage);
      const early = finishOutcome(result);
      if (early !== undefined) return early;
      let json = parseModelJson(result.text);
      if (!json.ok) {
        const again = await stillGo(row);
        if (again !== undefined) return again;
        // ONE corrective turn: the model's own answer, then the instruction.
        result = await callModel(
          model,
          {
            ...base,
            messages: [
              ...messages,
              { role: "assistant", content: result.text },
              { role: "user", content: AI_CORRECTIVE_PROMPT },
            ],
          },
          usage,
        );
        const late = finishOutcome(result);
        if (late !== undefined) return late;
        json = parseModelJson(result.text);
        if (!json.ok) return failed("invalid_output");
      }
      parsed = { json: json.json, text: result.text };
    } finally {
      release();
    }

    if (parsed === undefined) return failed("internal");
    const outcome = await task.finish(tctx, input, prompt, parsed);
    if (outcome.kind === "refused") return refused(outcome.code);
    // Lone surrogates / NUL would make the write throw (R1-H2): cleaned here, whatever the task did.
    const clean = sanitizeJson(outcome.result);
    if (!isPlainObject(clean)) return failed("invalid_result");
    if (Buffer.byteLength(JSON.stringify(clean), "utf8") > AI_MAX_RESULT_BYTES) {
      return failed("result_too_large");
    }
    return { status: "done", result: clean, errorCode: null };
  }

  /**
   * The job. Never throws or logs anything carrying prompt or result text (R1-H2: pg-boss stores a
   * handler's error message in `pgboss.job`, which has no RLS): every failure becomes a code.
   */
  async function run(requestId: string, workspaceId: string, signal?: AbortSignal): Promise<void> {
    if (!UUID_RE.test(requestId) || !UUID_RE.test(workspaceId)) return;
    const sctx = systemContext(workspaceId);
    const claimed = await deps.db.withTenant(sctx, (tx) =>
      new AiRequestRepo(sctx, tx).claim(requestId, now()),
    );
    if (claimed === undefined) return;
    const usage = { input: 0, output: 0, calls: 0 };
    let outcome: Outcome;
    try {
      outcome = await execute(claimed, signal, usage);
    } catch (error) {
      if (error instanceof ModelProviderError) {
        outcome = failed(`provider_${error.code}`);
      } else if (signal?.aborted === true) {
        outcome = failed("timeout");
      } else {
        outcome = failed("internal");
      }
      // Codes only: never prompt or model text, never the error message (it may quote either).
      log("ai.run_failed", {
        level: "warn",
        workspaceId,
        requestId,
        feature: claimed.feature,
        code: outcome.errorCode,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    const at = now();
    const tokens = {
      inputTokens: Math.min(usage.input, 2_147_483_647),
      outputTokens: Math.min(usage.output, 2_147_483_647),
    };
    // Usage and settle in ONE short transaction, on the locked request row (request row → usage
    // row, the job's lock order): charged only while this job still owns the row, so a row the
    // sweep already failed `stale` (and charged) is not charged twice, and a settle that fails
    // rolls its charge back with it (RR3-L7). The sweep charges a row whose settle never lands.
    const settle = (o: Outcome) =>
      deps.db.withTenant(sctx, async (tx): Promise<"written" | "dropped" | "stale"> => {
        const repo = new AiRequestRepo(sctx, tx);
        if (!(await repo.lockForSettle(claimed.id))) return "stale";
        if (usage.calls > 0) {
          await addUsage(tx, sctx, usageMonth(at), {
            inputTokens: usage.input,
            outputTokens: usage.output,
            requests: 1,
          });
        }
        return repo.settle(claimed.id, { ...o, ...tokens }, at);
      });
    let kept: "written" | "dropped" | "stale" | "lost";
    try {
      kept = await settle(outcome);
    } catch (error) {
      // The error names the query and its parameters (the result): log its name only, and settle
      // the request as failed without a result.
      log("ai.settle_failed", {
        level: "error",
        workspaceId,
        requestId,
        error: error instanceof Error ? error.name : "unknown",
      });
      outcome = failed("internal");
      try {
        kept = await settle(outcome);
      } catch {
        kept = "lost";
      }
    }
    log("ai.run", {
      workspaceId,
      requestId,
      feature: claimed.feature,
      status: kept === "written" ? outcome.status : kept,
      code: outcome.errorCode,
      inputTokens: usage.input,
      outputTokens: usage.output,
    });
  }

  async function sweep(workspaceId: string): Promise<{ deleted: number; stale: number }> {
    const sctx = systemContext(workspaceId);
    const at = now();
    // Running: past the job's own expiry (pg-boss has given up on it). Queued: nobody claimed it.
    const runningBefore = new Date(at.getTime() - (jobExpireSeconds + 60) * 1000);
    const queuedBefore = new Date(
      at.getTime() - Math.max(AI_QUEUED_STALE_MS, jobExpireSeconds * 1000),
    );
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new AiRequestRepo(sctx, tx);
      const { stale, crashed } = await repo.failStale({ runningBefore, queuedBefore }, at);
      // A call that started and never settled (process died) is charged half a reservation each
      // (RR1-L4) — same order as the job: request rows, then the usage row.
      if (crashed > 0) {
        await addUsage(tx, sctx, usageMonth(at), {
          inputTokens: crashed * Math.ceil(reservation / 2),
          outputTokens: 0,
          requests: crashed,
        });
      }
      const deleted = await repo.deleteExpired(at);
      return { deleted, stale };
    });
  }

  const jobs: JobDefinition<JsonObject>[] = [
    {
      name: AI_JOBS.run,
      queue: {
        policy: "standard",
        retryLimit: 0,
        expireInSeconds: jobExpireSeconds,
      },
      work: { concurrency: limits.concurrency },
      handler: async (job) => {
        const { requestId, workspaceId } = job.data;
        if (typeof requestId !== "string" || typeof workspaceId !== "string") return;
        try {
          await run(requestId, workspaceId, job.signal);
        } catch (error) {
          // Code-only: nothing from the error reaches pg-boss's job output.
          log("ai.run_error", {
            level: "error",
            workspaceId,
            requestId,
            error: error instanceof Error ? error.name : "unknown",
          });
          throw new Error("ai.run failed");
        }
      },
    },
    {
      name: AI_JOBS.retention,
      cron: AI_RETENTION_CRON,
      queue: { policy: "singleton", retryLimit: 0 },
      handler: async () => {
        let deleted = 0;
        let stale = 0;
        for (const workspaceId of await listLiveWorkspaceIds(deps.db)) {
          if (isPlatformWorkspace(workspaceId)) continue;
          try {
            const r = await sweep(workspaceId);
            deleted += r.deleted;
            stale += r.stale;
          } catch (error) {
            log("ai.retention_failed", {
              level: "error",
              workspaceId,
              error: error instanceof Error ? error.name : "unknown",
            });
          }
        }
        if (deleted + stale > 0) log("ai.retention", { deleted, stale });
      },
    },
  ];

  return {
    info,
    limits,
    services,
    status,
    updateSettings,
    getRequest,
    deleteRequest,
    run,
    sweep,
    jobs,
  };
}

/** The finish reasons that end a request before its text is parsed. */
function finishOutcome(result: ModelResult): Outcome | undefined {
  if (result.finish === "length") return failed("output_truncated");
  if (result.finish === "refusal" || result.finish === "filtered")
    return failed("refused_by_model");
  return undefined;
}

/** A task runs as the requester (staff RLS), not as the system actor. */
function requesterContext(workspaceId: string, member: MemberFacts): TenantContext {
  return {
    workspaceId,
    actorKind: member.kind === "staff" ? "staff" : "external",
    membershipId: member.id,
    userId: member.userId,
  };
}
