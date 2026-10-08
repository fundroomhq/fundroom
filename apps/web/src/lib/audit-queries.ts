import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";
import { saveBlob } from "./certificates.js";

/*
 * The audit log (E2.7): the workspace's hash-chained event trail, its on-demand verification,
 * the Ed25519 keys signed exports are checked against, and the signed export itself. Kernel
 * routes behind the required `audit` manifest: `audit.read` for everything but the export,
 * which is `audit.export` (owner, legal) plus a fresh session.
 */
export type AuditEvent = FundRoomSchemas["AuditEvent"];
export type AuditEventPage = FundRoomSchemas["AuditEventPage"];
export type AuditVerification = FundRoomSchemas["AuditVerification"];
export type AuditOutcome = FundRoomSchemas["AuditOutcome"];

export const AUDIT_KEY = ["audit"] as const;

export interface AuditFilter {
  action?: string | undefined;
  actorMembershipId?: string | undefined;
  subjectMembershipId?: string | undefined;
  resourceKind?: string | undefined;
  outcome?: AuditOutcome | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The same shape the server accepts: an exact action, or a prefix ending in `.`. */
export const AUDIT_ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.?$/u;
export const AUDIT_RESOURCE_KIND_RE = /^[a-z][a-z0-9_]*$/u;

/** Drops empty fields, so the query key and the query string only carry what is set. */
type AuditQuery = { [K in keyof AuditFilter]?: NonNullable<AuditFilter[K]> };

function defined(filter: AuditFilter): AuditQuery {
  const out: AuditQuery = {};
  for (const [key, value] of Object.entries(filter) as [keyof AuditFilter, string | undefined][])
    if (value) (out as Record<string, string>)[key] = value;
  return out;
}

/** Newest first (seq DESC). The cursor is opaque and handed back exactly as received. */
export function auditEventsQuery(filter: AuditFilter, limit = 50) {
  return infiniteQueryOptions({
    queryKey: [...AUDIT_KEY, "events", defined(filter), limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/audit/events", {
          params: {
            query: {
              ...defined(filter),
              limit,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: AuditEventPage) => last.nextCursor ?? undefined,
  });
}

export const auditExportKeysQuery = queryOptions({
  queryKey: [...AUDIT_KEY, "export-key"],
  queryFn: () => call(api().GET("/audit/export-key")),
});

/** Walks the whole chain server-side; run on demand, never on page load. */
export function verifyAuditChain(): Promise<AuditVerification> {
  return call(api().GET("/audit/verify"));
}

export interface AuditExportResult {
  filename: string;
  sha256: string | null;
}

/**
 * Downloads a signed export (zip) of the window. Fetched as bytes, not a link — see
 * `lib/certificates.ts` for why — and run through `useGuardedMutation` by the screen, so a
 * stale session goes to step-up exactly as any other fresh-only mutation does.
 */
export async function downloadAuditExport(
  range: { from?: string | undefined; to?: string | undefined },
  slug: string,
): Promise<AuditExportResult> {
  let sha256: string | null = null;
  const blob = await call(
    api()
      .POST("/audit/exports", {
        body: {
          ...(range.from ? { from: range.from } : {}),
          ...(range.to ? { to: range.to } : {}),
        },
        parseAs: "blob",
      })
      .then((result) => {
        sha256 = result.response.headers.get("x-content-sha256");
        return result;
      }),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-export-${slug || "workspace"}-${stamp}.zip`;
  saveBlob(blob as Blob, filename);
  return { filename, sha256 };
}

/*
 * External anchoring (E3.13, ADR-0061): each daily checkpoint's Merkle inclusion in a batch
 * whose root an RFC 3161 time-stamp authority and/or a Rekor transparency log witnessed.
 * `configured` is empty when the operator has not turned anchoring on.
 */
export type AuditAnchorPage = FundRoomSchemas["AuditAnchorPage"];
export type AuditAnchorItem = FundRoomSchemas["AuditAnchorItem"];
export type AuditAnchorProof = FundRoomSchemas["AuditAnchorProof"];
export type AuditAnchorSummary = FundRoomSchemas["AuditAnchorSummary"];

export function auditAnchorsQuery(limit = 20) {
  return infiniteQueryOptions({
    queryKey: [...AUDIT_KEY, "anchors", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/audit/anchors", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: AuditAnchorPage) => last.nextCursor ?? undefined,
  });
}

/** `audit-anchor-proof-<seq>.json`, the file `fundroom audit verify-anchor` takes. */
export function anchorProofFilename(seq: number): string {
  return `audit-anchor-proof-${seq}.json`;
}

/**
 * Fetches one checkpoint's self-contained proof (`audit.export`) and saves it as JSON, pretty
 * printed so a reader can see what a third party is asked to check.
 */
export async function downloadAnchorProof(item: Pick<AuditAnchorItem, "checkpointId" | "seq">) {
  const proof = await call(
    api().GET("/audit/anchors/{checkpointId}/proof", {
      params: { path: { checkpointId: item.checkpointId } },
    }),
  );
  const filename = anchorProofFilename(item.seq);
  saveBlob(
    new Blob([`${JSON.stringify(proof, null, 2)}\n`], { type: "application/json" }),
    filename,
  );
  return { filename };
}
