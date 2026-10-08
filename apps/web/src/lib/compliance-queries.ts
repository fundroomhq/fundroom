import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";
import { saveBlob } from "./certificates.js";

/*
 * Queries for the compliance kernel routes (E1.6): the offering mode and its period history,
 * the tenant's legal documents and their immutable versions, the acceptance register, the
 * workspace legal settings, and the member's own consent record.
 */
export type OfferingState = FundRoomSchemas["OfferingState"];
export type OfferingPeriod = FundRoomSchemas["OfferingPeriod"];
export type OfferingPermits = FundRoomSchemas["OfferingPermits"];
export type OfferingStatus = OfferingPermits["status"];
export type OfferingChangeResult = FundRoomSchemas["OfferingChangeResult"];
export type ComplianceSettings = FundRoomSchemas["ComplianceSettings"];
export type LegalDocument = FundRoomSchemas["LegalDocument"];
export type LegalDocumentDetail = FundRoomSchemas["LegalDocumentDetail"];
export type LegalDocumentVersion = FundRoomSchemas["LegalDocumentVersion"];
export type LegalTemplate = FundRoomSchemas["LegalTemplate"];
export type LegalTemplateDetail = FundRoomSchemas["LegalTemplateDetail"];
export type LegalDocumentKind = LegalDocument["kind"];
export type LegalAudience = LegalDocument["audience"];
/** E3.5: how a member accepts the document — click-wrap here, or e-signature at the vendor. */
export type LegalCeremony = LegalDocument["ceremony"];
export type AcceptanceEntry = FundRoomSchemas["AcceptanceEntry"];
export type AcceptanceRegister = FundRoomSchemas["AcceptanceRegister"];
export type PendingAcceptance = FundRoomSchemas["PendingAcceptance"];

/**
 * The documents that gate the whole portal. `GET /compliance/gates` also lists the NDAs a live
 * `nda` access gate names on one folder, document or share link (`scope: "resource"`, E3.5 B3):
 * those are signed from the lock badge's unlock sheet and must never stand the all-or-nothing
 * interstitial in front of everything else the member may see.
 */
export function workspaceScoped(docs: readonly PendingAcceptance[]): PendingAcceptance[] {
  return docs.filter((d) => d.scope !== "resource");
}
export type ConsentState = FundRoomSchemas["ConsentState"];
export type ConsentPurpose = FundRoomSchemas["ConsentPurposeState"]["purpose"];
export type Relationship = FundRoomSchemas["Relationship"];
export type ErasureRequest = FundRoomSchemas["ErasureRequest"];
export type ErasureRequestList = FundRoomSchemas["ErasureRequestList"];
export type PrivacyRegion = NonNullable<ComplianceSettings["privacyRegion"]>;
export type ConsentMode = ComplianceSettings["consentMode"];

export const PRIVACY_REGIONS = [
  "eu",
  "uk",
  "us",
  "other",
] as const satisfies readonly PrivacyRegion[];
export type RelationshipSource = NonNullable<Relationship["source"]>;

/** Every offering status, in the order the change form offers them. */
export const OFFERING_STATUSES = [
  "none",
  "informational",
  "506b",
  "506c",
  "non_us",
] as const satisfies readonly OfferingStatus[];

export const RELATIONSHIP_SOURCES = [
  "founder_invite",
  "intro",
  "prior_investor",
  "event",
  "other",
] as const satisfies readonly RelationshipSource[];

export const LEGAL_DOCUMENT_KINDS = [
  "privacy_notice",
  "nda",
  "terms",
  "disclaimer",
  "accreditation",
  "cookie_notice",
  "accessibility_statement",
] as const satisfies readonly LegalDocumentKind[];

export const LEGAL_AUDIENCES = [
  "external",
  "staff",
  "all",
] as const satisfies readonly LegalAudience[];

export const offeringQuery = queryOptions({
  queryKey: ["compliance", "offering"],
  queryFn: () => call(api().GET("/compliance/offering")),
});

export const complianceSettingsQuery = queryOptions({
  queryKey: ["compliance", "settings"],
  queryFn: () => call(api().GET("/compliance/settings")),
});

export const legalDocumentsQuery = queryOptions({
  queryKey: ["compliance", "documents"],
  queryFn: () => call(api().GET("/compliance/documents")),
});

export function legalDocumentQuery(id: string) {
  return queryOptions({
    queryKey: ["compliance", "document", id],
    queryFn: () => call(api().GET("/compliance/documents/{id}", { params: { path: { id } } })),
  });
}

export const legalTemplatesQuery = queryOptions({
  queryKey: ["compliance", "templates"],
  queryFn: () => call(api().GET("/compliance/templates")),
});

/** `templateId` empty = nothing picked yet; the query stays disabled rather than 404ing. */
export function legalTemplateQuery(templateId: string) {
  return queryOptions({
    queryKey: ["compliance", "template", templateId],
    queryFn: () =>
      call(api().GET("/compliance/templates/{templateId}", { params: { path: { templateId } } })),
    enabled: templateId !== "",
  });
}

/** The acceptance register. The cursor is opaque: it is handed back exactly as received. */
export function acceptancesQuery(filter: { documentId?: string; limit?: number } = {}) {
  const limit = filter.limit ?? 25;
  return infiniteQueryOptions({
    queryKey: ["compliance", "acceptances", filter.documentId ?? "", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/compliance/acceptances", {
          params: {
            query: {
              limit,
              ...(filter.documentId === undefined ? {} : { documentId: filter.documentId }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: AcceptanceRegister) => last.nextCursor ?? undefined,
  });
}

/** The signed-in member's own consent record (`GET /compliance/consent`). */
export const consentQuery = queryOptions({
  queryKey: ["compliance", "consent"],
  queryFn: () => call(api().GET("/compliance/consent")),
  retry: false,
});

/** DSAR erasure requests (E2.6), newest first; the cursor is opaque. */
export function erasureRequestsQuery(limit = 25) {
  return infiniteQueryOptions({
    queryKey: ["compliance", "erasure-requests", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/compliance/erasure-requests", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: ErasureRequestList) => last.nextCursor ?? undefined,
  });
}

// --- every kind of data-subject request (E2.7) ---------------------------------------------------

export type DataRequest = FundRoomSchemas["DataRequest"];
export type DataRequestList = FundRoomSchemas["DataRequestList"];
export type DataRequestKind = DataRequest["kind"];
export type DataRequestStatus = DataRequest["status"];

export const DATA_REQUEST_KINDS = [
  "access",
  "rectification",
  "erasure",
] as const satisfies readonly DataRequestKind[];
export const DATA_REQUEST_STATUSES = [
  "requested",
  "completed",
  "cancelled",
] as const satisfies readonly DataRequestStatus[];

export interface DataRequestFilter {
  kind?: DataRequestKind | undefined;
  status?: DataRequestStatus | undefined;
}

/** All kinds of DSAR, newest first; the cursor is opaque. */
export function dataRequestsQuery(filter: DataRequestFilter = {}, limit = 25) {
  return infiniteQueryOptions({
    queryKey: ["compliance", "data-requests", filter.kind ?? "", filter.status ?? "", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/compliance/data-requests", {
          params: {
            query: {
              limit,
              ...(filter.kind === undefined ? {} : { kind: filter.kind }),
              ...(filter.status === undefined ? {} : { status: filter.status }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: DataRequestList) => last.nextCursor ?? undefined,
  });
}

/**
 * The subject-access export for one member, as a zip (`compliance.manage` + a fresh session).
 * Fetched as bytes for the same reasons as the certificates (see `lib/certificates.ts`); a
 * `step_up_required` surfaces as an `ApiFailure`, so callers run this inside
 * `useGuardedMutation`, which sends a stale session through step-up and back.
 *
 * The download changes nothing on the server but its audit row. It resolves with the zip's
 * sha256 (`X-Content-SHA256`), which the screen offers back when the access request is marked
 * complete — the server checks it names an export it actually produced.
 */
export async function downloadSubjectExport(
  membershipId: string,
): Promise<{ sha256: string | null }> {
  let sha256: string | null = null;
  const blob = await call(
    api()
      .GET("/compliance/subjects/{membershipId}/export", {
        params: { path: { membershipId } },
        parseAs: "blob",
      })
      .then((result) => {
        sha256 = result.response.headers.get("x-content-sha256");
        return result;
      }),
  );
  saveBlob(blob, `data-export-${membershipId.slice(0, 8)}.zip`);
  return { sha256 };
}
