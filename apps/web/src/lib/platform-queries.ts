import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { callNoContent } from "./access-admin-queries.js";
import { api, call, describeError, isApiError } from "./api.js";
import { formatBytes } from "./format.js";
import { PLAN_FEATURES, type PlanFeature } from "./plan-features.js";

/*
 * The operator console (E3.10, ADR-0058): `/api/v1/platform/*` on the canonical host. Every
 * route answers a plain 404 to anyone who is not holding a live operator session — including
 * when the control plane is off — so "404 on `/platform/me`" means "no operator session here",
 * and the console shows its sign-in gate rather than an error.
 *
 * Nothing here is tenant content: names, slugs, plans, statuses, usage counters and the owners'
 * addresses (whose read the server audits). Everything is keyed under `["platform"]` so signing
 * out can drop the whole console's cache in one call.
 */
export type PlatformMe = FundRoomSchemas["PlatformMe"];
export type PlatformWorkspace = FundRoomSchemas["PlatformWorkspace"];
export type PlatformWorkspacePage = FundRoomSchemas["PlatformWorkspacePage"];
export type PlatformWorkspaceDetail = FundRoomSchemas["PlatformWorkspaceDetail"];
export type WorkspaceStatus = FundRoomSchemas["WorkspaceStatus"];
export type SuspendReason = FundRoomSchemas["SuspendReason"];
export type WorkspaceHold = FundRoomSchemas["WorkspaceHold"];
/** The holds an operator may lift (E3.11: not `relocation`, which only a move sets and lifts). */
export type LiftableHold = FundRoomSchemas["LiftableHold"];
export type SubscriptionStatus = FundRoomSchemas["SubscriptionStatus"];
export type WorkspaceUsage = FundRoomSchemas["WorkspaceUsage"];
export type UsageDay = FundRoomSchemas["UsageDay"];
export type Plan = FundRoomSchemas["Plan"];
export type PlanLimits = FundRoomSchemas["PlanLimits"];
/** A-3 (ADR-0063): what a plan's lists may name on this build. */
export type PlanEntitlementCatalog = FundRoomSchemas["PlanEntitlementCatalog"];
export type Cell = FundRoomSchemas["Cell"];
/** E3.11: a move of one workspace to a cell in another database (never the bundle URL). */
export type Move = FundRoomSchemas["Move"];
export type PlatformOperator = FundRoomSchemas["PlatformOperator"];
export type PlatformAuditEntry = FundRoomSchemas["PlatformAuditEntry"];
export type PlatformAuditPage = FundRoomSchemas["PlatformAuditPage"];
export type PlatformHealth = FundRoomSchemas["PlatformHealth"];
export type SanctionsScreening = FundRoomSchemas["SanctionsScreening"];
export type SanctionsScreeningDetail = FundRoomSchemas["SanctionsScreeningDetail"];
export type SanctionsOutcome = SanctionsScreening["outcome"];
export type SanctionsDecision = "cleared" | "confirmed";

export const PLATFORM_KEY = ["platform"] as const;
export const PLATFORM_ME_KEY = [...PLATFORM_KEY, "me"] as const;

export const WORKSPACE_STATUSES = ["active", "pending_review", "suspended"] as const;

export const platformMeQuery = queryOptions({
  queryKey: PLATFORM_ME_KEY,
  queryFn: () => call(api().GET("/platform/me")),
  // An operator session is 1 h idle: re-read it rather than trusting a cached "signed in".
  staleTime: 0,
});

/** Mints the operator session from a fresh level-2 canonical session (the gate's one button). */
export function startOperatorSession(): Promise<FundRoomSchemas["PlatformSession"]> {
  return call(api().POST("/platform/session"));
}

export function endOperatorSession(): Promise<void> {
  return callNoContent(api().DELETE("/platform/session"));
}

// --- workspaces -------------------------------------------------------------------------------

export interface WorkspaceFilter {
  q?: string | undefined;
  status?: WorkspaceStatus | undefined;
  plan?: string | undefined;
}

/** The filter as sent: only what is set (so the query key only carries that too). */
type WorkspaceQuery = { q?: string; status?: WorkspaceStatus; plan?: string };

/** Drops empty fields, so the query key and the query string only carry what is set. */
function definedFilter(filter: WorkspaceFilter): WorkspaceQuery {
  const out: WorkspaceQuery = {};
  if (filter.q !== undefined && filter.q.trim() !== "") out.q = filter.q.trim();
  if (filter.status !== undefined) out.status = filter.status;
  if (filter.plan !== undefined && filter.plan !== "") out.plan = filter.plan;
  return out;
}

/** Oldest first by `(created_at, id)`; the cursor is opaque and handed back as received. */
export function platformWorkspacesQuery(filter: WorkspaceFilter, limit = 50) {
  const query = definedFilter(filter);
  return infiniteQueryOptions({
    queryKey: [...PLATFORM_KEY, "workspaces", "list", query, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/platform/workspaces", {
          params: {
            query: { ...query, limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last: PlatformWorkspacePage) => last.nextCursor ?? undefined,
  });
}

export const workspaceKey = (id: string) => [...PLATFORM_KEY, "workspaces", "one", id] as const;

export function platformWorkspaceQuery(id: string) {
  return queryOptions({
    queryKey: workspaceKey(id),
    queryFn: () => call(api().GET("/platform/workspaces/{id}", { params: { path: { id } } })),
  });
}

export function platformWorkspaceUsageQuery(id: string) {
  return queryOptions({
    queryKey: [...workspaceKey(id), "usage"],
    queryFn: () => call(api().GET("/platform/workspaces/{id}/usage", { params: { path: { id } } })),
  });
}

/** `POST /platform/workspaces`'s body; no `cellId` = the server's default cell. */
export interface PlatformWorkspaceCreate {
  slug: string;
  name: string;
  legalName: string;
  country: string;
  ownerEmail: string;
  planId: string | null;
  cellId?: string;
}

/**
 * `POST /platform/workspaces`: creates and seeds the workspace, invites the owner by email and
 * runs the provisioning hooks (a sanctions screen may hold it `pending_review`). 409
 * `slug_taken`; a refused plan or cell is a 400 naming the field.
 */
export function createWorkspace(body: PlatformWorkspaceCreate): Promise<PlatformWorkspaceDetail> {
  return call(api().POST("/platform/workspaces", { body }));
}

export type PlatformSubscriptionSummary = FundRoomSchemas["PlatformSubscriptionSummary"];

/** What an operator records for a manually billed workspace (BILLING_DRIVER=manual only). */
export interface ManualSubscriptionInput {
  status: SubscriptionStatus;
  planId?: string;
  currentPeriodEnd?: string | null;
}

export function recordManualSubscription(
  id: string,
  body: ManualSubscriptionInput,
): Promise<PlatformSubscriptionSummary> {
  return call(
    api().POST("/platform/workspaces/{id}/subscription", { params: { path: { id } }, body }),
  );
}

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "paused",
] as const satisfies readonly SubscriptionStatus[];

/** The field a 400/422 names (`details.field`, or spread into the envelope), if any. */
export function errorField(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  const field = source["field"];
  return typeof field === "string" ? field : undefined;
}

/** One string field of a refusal's details (`details.<key>`, or spread into the envelope). */
export function errorDetail(error: unknown, key: string): string | undefined {
  if (!isApiError(error)) return undefined;
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  const value = source[key] ?? envelope[key];
  return typeof value === "string" ? value : undefined;
}

export function suspendWorkspace(id: string, note: string): Promise<PlatformWorkspaceDetail> {
  return call(
    api().POST("/platform/workspaces/{id}/suspend", {
      params: { path: { id } },
      body: { reason: "operator", note },
    }),
  );
}

/**
 * Lifts ONE hold (`hold`, default `operator` on the server); every other hold stays, so a
 * workspace suspended for two reasons stays suspended until both are lifted.
 */
export function unsuspendWorkspace(
  id: string,
  note: string,
  hold: LiftableHold = "operator",
): Promise<PlatformWorkspaceDetail> {
  return call(
    api().POST("/platform/workspaces/{id}/unsuspend", {
      params: { path: { id } },
      body: { note, hold },
    }),
  );
}

export function patchWorkspace(
  id: string,
  body: { planId?: string | null; cellId?: string; legalName?: string; country?: string },
): Promise<PlatformWorkspace> {
  return call(api().PATCH("/platform/workspaces/{id}", { params: { path: { id } }, body }));
}

export function rescreenWorkspace(id: string): Promise<void> {
  return callNoContent(
    api().POST("/platform/workspaces/{id}/rescreen", { params: { path: { id } } }),
  );
}

// --- plans, cells, operators, audit, health ---------------------------------------------------

export const PLANS_KEY = [...PLATFORM_KEY, "plans"] as const;

export const platformPlansQuery = queryOptions({
  queryKey: PLANS_KEY,
  queryFn: () => call(api().GET("/platform/plans")),
});

/** What the plan form sends: every field, so an edit never leaves one silently unchanged. */
export interface PlanCreate {
  id: string;
  name: string;
  limits: PlanLimits;
  billingPriceRef: string | null;
  /** Quantity-less metered prices added to a checkout (the whole list; `[]` = none). */
  billingMeteredPriceRefs: string[];
  trialDays: number;
  public: boolean;
}

export const MAX_METERED_PRICE_REFS = 10;

/**
 * The metered-price field (one provider price id per line) as the API takes it, or why not:
 * blank lines are dropped; more than ten, a duplicate or an over-long id is refused here.
 */
export function parseMeteredPriceRefs(
  text: string,
): { ok: true; refs: string[] } | { ok: false; reason: "too_many" | "duplicate" | "too_long" } {
  const refs = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (refs.length > MAX_METERED_PRICE_REFS) return { ok: false, reason: "too_many" };
  if (refs.some((r) => r.length > 255)) return { ok: false, reason: "too_long" };
  if (new Set(refs).size !== refs.length) return { ok: false, reason: "duplicate" };
  return { ok: true, refs };
}

export function createPlan(body: PlanCreate): Promise<Plan> {
  return call(api().POST("/platform/plans", { body }));
}

export function updatePlan(
  id: string,
  body: Omit<PlanCreate, "id"> & { version: number },
): Promise<Plan> {
  return call(api().PATCH("/platform/plans/{id}", { params: { path: { id } }, body }));
}

export function archivePlan(id: string): Promise<Plan> {
  return call(api().POST("/platform/plans/{id}/archive", { params: { path: { id } } }));
}

export const platformCellsQuery = queryOptions({
  queryKey: [...PLATFORM_KEY, "cells"],
  queryFn: () => call(api().GET("/platform/cells")),
});

// --- moves between cells (E3.11) ---------------------------------------------------------------

export const MOVES_KEY = [...PLATFORM_KEY, "moves"] as const;
/** How often a workspace's moves are re-read while one is still running. */
export const MOVE_POLL_MS = 5000;

const LIVE_MOVE_STATES: ReadonlySet<Move["state"]> = new Set([
  "requested",
  "exporting",
  "exported",
  "importing",
  "imported",
]);

/** A workspace's moves, newest first; polled while one is still on its way. */
export function platformMovesQuery(workspaceId: string) {
  return queryOptions({
    queryKey: [...MOVES_KEY, "workspace", workspaceId],
    queryFn: async () => {
      const out = await call(api().GET("/platform/moves", { params: { query: { workspaceId } } }));
      return {
        items: [...out.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      };
    },
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((mv) => LIVE_MOVE_STATES.has(mv.state))
        ? MOVE_POLL_MS
        : false,
  });
}

/**
 * `POST /platform/workspaces/{id}/move` (202): puts the workspace on a `relocation` hold and
 * starts the export. The slug is typed by the operator as the confirmation.
 */
export function requestMove(
  id: string,
  body: { targetCellId: string; confirmSlug: string },
): Promise<Move> {
  return call(api().POST("/platform/workspaces/{id}/move", { params: { path: { id } }, body }));
}

export function cancelMove(id: string): Promise<Move> {
  return call(api().POST("/platform/moves/{id}/cancel", { params: { path: { id } } }));
}

/** The failed move's `{stage, code}` as one sentence (an unknown code still names both). */
export function moveErrorSentence(error: { stage: string; code: string }): string {
  switch (error.code) {
    case "export_failed":
      return m.platform_move_error_export_failed();
    case "bundle_expired":
      return m.platform_move_error_bundle_expired();
    case "bundle_too_large":
      return m.platform_move_error_bundle_too_large();
    case "download_failed":
      return m.platform_move_error_download_failed();
    case "sha256_mismatch":
      return m.platform_move_error_sha256_mismatch();
    case "signature_invalid":
    case "unknown_signer":
      return m.platform_move_error_signature_invalid();
    case "bundle_mismatch":
      return m.platform_move_error_bundle_mismatch();
    case "incompatible":
      return m.platform_move_error_incompatible();
    case "import_failed":
      return m.platform_move_error_import_failed();
    case "slug_taken":
      return m.platform_move_error_slug_taken();
    case "plan_unknown":
      return m.platform_move_error_plan_unknown();
    case "erasure_during_move":
      return m.platform_move_error_erasure();
    case "target_unavailable":
      return m.platform_move_error_target_unavailable();
    // Stage `switch`: the source changed under the move, which then released it.
    case "deleted":
      return m.platform_move_error_source_deleted();
    case "not_held":
      return m.platform_move_error_source_not_held();
    case "legal_hold":
      return m.platform_move_error_source_legal_hold();
    default:
      return m.platform_move_error_other({ stage: error.stage, code: error.code });
  }
}

/** Why `POST …/move` (or a PATCH to a remote cell) was refused: `move_unavailable`'s reason. */
function moveUnavailableSentence(reason: string | undefined): string {
  switch (reason) {
    case "use_move":
      return m.platform_error_use_move();
    case "no_directory":
      return m.platform_error_move_no_directory();
    case "target_unknown":
    case "target_local":
      return m.platform_error_move_target_unknown();
    case "target_inactive":
      return m.platform_error_move_target_inactive();
    case "target_stale":
      return m.platform_error_move_target_stale();
    case "deleted":
      return m.platform_error_move_deleted();
    case "legal_hold":
      return m.platform_error_move_legal_hold();
    case "erasure_open":
      return m.platform_error_move_erasure_open();
    case "storage":
      return m.platform_error_move_storage();
    case "source_remote":
      return m.platform_error_move_source_remote();
    case "not_in_directory":
      return m.platform_error_move_not_in_directory();
    case "sanctions_review":
      return m.platform_error_move_sanctions_review();
    default:
      return m.platform_error_move_unavailable();
  }
}

export const platformOperatorsQuery = queryOptions({
  queryKey: [...PLATFORM_KEY, "operators"],
  queryFn: () => call(api().GET("/platform/operators")),
});

/** The platform chain, newest first; the cursor is opaque. */
export function platformAuditQuery(limit = 50) {
  return infiniteQueryOptions({
    queryKey: [...PLATFORM_KEY, "audit", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/platform/audit", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: PlatformAuditPage) => last.nextCursor ?? undefined,
  });
}

export const platformHealthQuery = queryOptions({
  queryKey: [...PLATFORM_KEY, "health"],
  queryFn: () => call(api().GET("/platform/health")),
  staleTime: 0,
});

// --- sanctions --------------------------------------------------------------------------------

export const SANCTIONS_KEY = [...PLATFORM_KEY, "sanctions"] as const;

export function sanctionsQueueQuery(status: "open" | "all") {
  return queryOptions({
    queryKey: [...SANCTIONS_KEY, "list", status],
    queryFn: () => call(api().GET("/platform/sanctions", { params: { query: { status } } })),
  });
}

export function sanctionsScreeningQuery(id: string) {
  return queryOptions({
    queryKey: [...SANCTIONS_KEY, "one", id],
    queryFn: () => call(api().GET("/platform/sanctions/{id}", { params: { path: { id } } })),
  });
}

export function decideSanctions(
  id: string,
  decision: SanctionsDecision,
  note: string,
): Promise<SanctionsScreeningDetail> {
  return call(
    api().POST("/platform/sanctions/{id}/decision", {
      params: { path: { id } },
      body: { decision, note },
    }),
  );
}

// --- words ------------------------------------------------------------------------------------

export function workspaceStatusLabel(status: WorkspaceStatus): string {
  switch (status) {
    case "active":
      return m.platform_status_active();
    case "pending_review":
      return m.platform_status_pending_review();
    default:
      return m.platform_status_suspended();
  }
}

export function workspaceStatusVariant(
  status: WorkspaceStatus,
): "success" | "warning" | "destructive" {
  return status === "active" ? "success" : status === "pending_review" ? "warning" : "destructive";
}

/** Holds in the order the page lists them: the strongest first. */
export const WORKSPACE_HOLDS = [
  "sanctions",
  "operator",
  "billing",
  "sanctions_review",
] as const satisfies readonly LiftableHold[];

export function holdLabel(hold: WorkspaceHold): string {
  switch (hold) {
    case "sanctions":
      return m.platform_reason_sanctions();
    case "operator":
      return m.platform_reason_operator();
    case "billing":
      return m.platform_reason_billing();
    case "relocation":
      return m.platform_reason_relocation();
    default:
      return m.platform_hold_sanctions_review();
  }
}

/** The holds a workspace carries, strongest first (the server sends them sorted by name). */
export function orderedHolds(holds: readonly WorkspaceHold[]): LiftableHold[] {
  return WORKSPACE_HOLDS.filter((h) => holds.includes(h));
}

export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case "trialing":
      return m.platform_sub_trialing();
    case "active":
      return m.platform_sub_active();
    case "past_due":
      return m.platform_sub_past_due();
    case "unpaid":
      return m.platform_sub_unpaid();
    case "canceled":
      return m.platform_sub_canceled();
    case "incomplete":
      return m.platform_sub_incomplete();
    default:
      return m.platform_sub_paused();
  }
}

export function sanctionsOutcomeLabel(outcome: SanctionsOutcome): string {
  switch (outcome) {
    case "clear":
      return m.platform_outcome_clear();
    case "potential_match":
      return m.platform_outcome_potential_match();
    default:
      return m.platform_outcome_error();
  }
}

export function sanctionsDecisionLabel(decision: SanctionsDecision | null): string {
  if (decision === null) return m.platform_decision_none();
  return decision === "cleared" ? m.platform_decision_cleared() : m.platform_decision_confirmed();
}

/** Limits keys in the order the forms and tables show them. */
export const LIMIT_KEYS = [
  "staffSeats",
  "investorSeats",
  "storageBytes",
  "customDomains",
  "emailsPerMonth",
] as const satisfies readonly (keyof PlanLimits)[];
export type LimitKey = (typeof LIMIT_KEYS)[number];

export function limitLabel(key: LimitKey): string {
  switch (key) {
    case "staffSeats":
      return m.platform_limit_staff_seats();
    case "investorSeats":
      return m.platform_limit_investor_seats();
    case "storageBytes":
      return m.platform_limit_storage();
    case "customDomains":
      return m.platform_limit_custom_domains();
    default:
      return m.platform_limit_emails_per_month();
  }
}

/** Features in display order (the server stores them sorted alphabetically). */
export function orderedFeatures(features: readonly PlanFeature[]): PlanFeature[] {
  const order: readonly PlanFeature[] = PLAN_FEATURES;
  return [...features].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** An absent limit is unlimited, never zero. */
export function formatLimit(key: LimitKey, value: number | undefined): string {
  if (value === undefined) return m.platform_unlimited();
  return key === "storageBytes" ? formatBytes(value) : formatCount(value);
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(getLocale()).format(n);
}

/**
 * The console's refusals, each with its own sentence. Anything the operator API does not
 * specifically answer falls back to the shared table (`describeError`).
 */
export function describePlatformError(error: unknown): string {
  if (isApiError(error)) {
    switch (error.code) {
      case "version_conflict":
        return m.platform_error_version_conflict();
      case "sanctions_unresolved":
        return m.platform_error_sanctions_unresolved();
      case "conflict":
        switch (errorDetail(error, "reason")) {
          case "not_cancellable":
            return m.platform_error_move_not_cancellable();
          // E3.11: a cell change while a move holds the workspace.
          case "relocating":
            return m.platform_error_cell_relocating();
          default:
            return m.platform_error_conflict();
        }
      case "validation_failed":
      case "invalid_request":
        // A-3: a plan's module list named a module this build does not have as optional.
        if (errorDetail(error, "reason") === "unknown_module") {
          return m.platform_error_unknown_module({
            module: errorDetail(error, "module") ?? "?",
          });
        }
        return errorDetail(error, "reason") === "confirmation_mismatch" ||
          errorField(error) === "confirmSlug"
          ? m.platform_move_confirm_mismatch()
          : m.platform_error_invalid();
      // E3.11: moves between cells.
      case "move_unavailable":
        return moveUnavailableSentence(errorDetail(error, "reason"));
      case "move_busy":
        return m.platform_error_move_busy();
      case "directory_unavailable":
        return m.platform_error_directory_unavailable();
      default:
        break;
    }
  }
  return describeError(error).body;
}
