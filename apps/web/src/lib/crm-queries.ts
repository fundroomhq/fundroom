import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Queries for the CRM-lite module (E2.5 §C) plus the two **round** lookups the pipeline board
 * needs (§D2): the round list that feeds the board's round selector and the allocation, which
 * is where the committed money actually lives.
 *
 * Two things about this file are deliberate and temporary:
 *
 *  - **The types are written here by hand.** `packages/sdk` is generated from the server's
 *    OpenAPI document and the `/crm/...` and `/round/...` routes are being written in the same
 *    epic, so the generated `paths` union does not know them yet. The interfaces below mirror
 *    contract §S column for column; when the SDK is regenerated they become
 *    `FundRoomSchemas["PipelineItem"]` and friends, exactly as `metrics-queries.ts` does.
 *  - **`crmApi()` is `api()` widened.** One cast in one place, rather than a cast at every
 *    call site; the calls themselves are written the way the typed client wants them
 *    (`GET("/crm/pipeline", { params: { query: { roundId } } })`) so that regenerating the SDK
 *    and deleting `crmApi`/`callAs` is a find-and-replace rather than a rewrite.
 *
 * Every money figure on these types is a decimal **string**. `numeric(20, 6)` does not survive
 * a round trip through a double, and the reconciliation panel adds forecasts up with
 * `@fundroom/decimal` rather than with `+` for exactly that reason.
 */

type ApiResult = Promise<{ data?: unknown; error?: unknown; response: Response }>;

interface LooseClient {
  GET: (path: string, init?: Record<string, unknown>) => ApiResult;
  POST: (path: string, init?: Record<string, unknown>) => ApiResult;
  PATCH: (path: string, init?: Record<string, unknown>) => ApiResult;
  PUT: (path: string, init?: Record<string, unknown>) => ApiResult;
  DELETE: (path: string, init?: Record<string, unknown>) => ApiResult;
}

/** `api()` widened to the paths the generated client does not carry yet — see the header. */
export function crmApi(): LooseClient {
  return api() as unknown as LooseClient;
}

/** `call()` with the response type supplied by hand instead of by the generated `paths`. */
export function callAs<T>(promise: ApiResult): Promise<T> {
  return call(promise as unknown as Promise<{ data?: T; error?: unknown; response: Response }>);
}

// --- payloads (mirror contract §S) --------------------------------------------------------

export const ORG_KINDS = ["fund", "angel_group", "corporate", "family_office", "other"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const SUBJECT_KINDS = ["contact", "organization", "pipeline_item"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface PipelineStage {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly isTerminal: boolean;
}

export interface ContactRef {
  readonly id: string;
  readonly displayName: string;
  readonly email?: string | null;
}

export interface OrganizationRef {
  readonly id: string;
  readonly name: string;
}

export interface PipelineItem {
  readonly id: string;
  readonly roundId: string | null;
  readonly stageId: string;
  readonly contact: ContactRef | null;
  readonly organization: OrganizationRef | null;
  /** A *forecast* — what staff expect. The committed figure lives in `round` (§D2). */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly ownerMembershipId: string | null;
  /** Present when the server resolves it; otherwise the screens look it up in the people list. */
  readonly ownerName?: string | null;
  readonly commitmentId: string | null;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PipelineView {
  readonly stages: readonly PipelineStage[];
  readonly items: readonly PipelineItem[];
}

export interface Contact {
  readonly id: string;
  readonly organizationId: string | null;
  readonly organization?: OrganizationRef | null;
  readonly membershipId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly ownerMembershipId: string | null;
  readonly ownerName?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly website: string | null;
  readonly kind: OrgKind | string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Note {
  readonly id: string;
  readonly subjectKind: SubjectKind | string;
  readonly subjectId: string;
  readonly body: string;
  readonly authorMembershipId: string | null;
  readonly authorName?: string | null;
  readonly createdAt: string;
}

export interface Task {
  readonly id: string;
  readonly subjectKind: SubjectKind | string;
  readonly subjectId: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly assigneeMembershipId: string | null;
  readonly assigneeName?: string | null;
  readonly doneAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContactDetail {
  readonly contact: Contact;
  readonly organization: Organization | null;
  readonly notes: readonly Note[];
  readonly tasks: readonly Task[];
  readonly pipelineItems: readonly PipelineItem[];
}

export interface ContactsPage {
  readonly contacts: readonly Contact[];
  readonly nextCursor?: string | null;
}

export interface OrganizationsPage {
  readonly organizations: readonly Organization[];
  readonly nextCursor?: string | null;
}

export interface StagesView {
  readonly stages: readonly PipelineStage[];
}

// --- the two round lookups (§D2) ----------------------------------------------------------

export const COMMITMENT_STATUSES = ["soft", "verbal", "signed", "wired", "withdrawn"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/** Only the fields the CRM board needs; `round` owns the rest. */
export interface RoundSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly currency: string;
  readonly targetAmount: string;
}

export interface Allocation {
  readonly target: string;
  readonly soft: string;
  readonly verbal: string;
  readonly signed: string;
  readonly wired: string;
  readonly committed: string;
  readonly total: string;
  readonly remaining: string;
  readonly percent: { readonly soft: string; readonly committed: string; readonly wired: string };
}

export interface CommitmentSummary {
  readonly id: string;
  readonly amount: string;
  readonly status: CommitmentStatus | string;
  readonly displayName?: string | null;
}

export interface AllocationView {
  readonly allocation: Allocation;
  readonly commitments: readonly CommitmentSummary[];
}

/**
 * Reads the allocation response whether the round module wraps it (`{ allocation, commitments }`)
 * or returns the allocation's own fields at the top level with the commitments beside them.
 * The CRM board is a *consumer* of a route another work package owns; a shape it did not expect
 * should cost it the reconciliation panel, not the whole board.
 */
export function readAllocation(data: unknown): AllocationView | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  const inner =
    typeof raw["allocation"] === "object" && raw["allocation"] !== null ? raw["allocation"] : raw;
  const allocation = inner as Allocation;
  if (typeof allocation.target !== "string") return undefined;
  const commitments = Array.isArray(raw["commitments"])
    ? (raw["commitments"] as readonly CommitmentSummary[])
    : [];
  return { allocation, commitments };
}

// --- queries ------------------------------------------------------------------------------

export const crmStagesQuery = queryOptions({
  queryKey: ["crm", "stages"],
  queryFn: () => callAs<StagesView>(crmApi().GET("/crm/stages")),
});

/**
 * The board. `roundId` narrows the items server-side; the "no round" view of the board reuses
 * the unfiltered query and filters `roundId === null` in the browser, so that choosing it
 * costs no request and needs no magic value in the query string.
 */
export function crmPipelineQuery(roundId?: string) {
  return queryOptions({
    queryKey: ["crm", "pipeline", roundId ?? null],
    queryFn: () =>
      callAs<PipelineView>(
        crmApi().GET("/crm/pipeline", {
          ...(roundId === undefined ? {} : { params: { query: { roundId } } }),
        }),
      ),
  });
}

export function crmContactsQuery(q = "") {
  const trimmed = q.trim();
  return queryOptions({
    queryKey: ["crm", "contacts", trimmed],
    queryFn: () =>
      callAs<ContactsPage>(
        crmApi().GET("/crm/contacts", {
          params: { query: { ...(trimmed === "" ? {} : { q: trimmed }), limit: 100 } },
        }),
      ),
  });
}

export function crmContactQuery(id: string) {
  return queryOptions({
    queryKey: ["crm", "contact", id],
    queryFn: () =>
      callAs<ContactDetail>(crmApi().GET("/crm/contacts/{id}", { params: { path: { id } } })),
  });
}

export function crmOrganizationsQuery(q = "") {
  const trimmed = q.trim();
  return queryOptions({
    queryKey: ["crm", "organizations", trimmed],
    queryFn: () =>
      callAs<OrganizationsPage>(
        crmApi().GET("/crm/organizations", {
          params: { query: { ...(trimmed === "" ? {} : { q: trimmed }), limit: 100 } },
        }),
      ),
  });
}

/*
 * The round module is a different module and may simply be off: `crm` does not depend on it
 * (§D1). Both round queries therefore retry nothing — a 404 here is an answer ("there are no
 * rounds to pick from"), not a fault, and the board degrades to "All" and "No round".
 */
export const roundsQuery = queryOptions({
  queryKey: ["round", "rounds"],
  retry: false,
  queryFn: () => callAs<{ rounds: readonly RoundSummary[] }>(crmApi().GET("/round/rounds")),
});

export function roundAllocationQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "allocation", id],
    retry: false,
    queryFn: async (): Promise<AllocationView | undefined> =>
      readAllocation(
        await callAs<unknown>(
          crmApi().GET("/round/rounds/{id}/allocation", { params: { path: { id } } }),
        ),
      ),
  });
}

// --- contact activity (E3.6 §7) -----------------------------------------------------------------

/*
 * Meetings a contact booked, cancelled or moved through a connected booking provider (Calendly,
 * Cal.com). Written by the server from the verified booking webhook — never typed by staff — so
 * the card that shows them is read-only.
 */
export type ContactActivity = FundRoomSchemas["CrmActivity"];
export type ActivityKind = FundRoomSchemas["CrmActivityKind"];

export function crmContactActivityQuery(id: string) {
  return queryOptions({
    queryKey: ["crm", "contact", id, "activity"],
    queryFn: () => call(api().GET("/crm/contacts/{id}/activity", { params: { path: { id } } })),
  });
}
