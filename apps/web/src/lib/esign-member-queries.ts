import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call, isApiError } from "./api.js";
import { saveBlob } from "./certificates.js";
import type { PendingAcceptance } from "./compliance-queries.js";

/*
 * The member's side of e-signature (E3.5, ADR-0053): the NDA ceremony that replaces the
 * click-wrap for a document whose `ceremony` is `esign`, and the member's own envelopes.
 *
 * Every route here is member-scoped and gate-exempt on the server — the NDA gate is exactly what
 * these calls exist to close, so they must work while it is still shut.
 */

export type ESignEnvelope = FundRoomSchemas["ESignEnvelope"];
export type ESignNdaStatus = FundRoomSchemas["ESignNdaStatus"];
export type ESignNdaStartResult = FundRoomSchemas["ESignNdaStartResult"];

/** The version of the ESIGN consumer disclosure the portal shows (`packages/esign/src/consent.ts`). */
export const ESIGN_DISCLOSURE_VERSION = 1 as const;

export type Ceremony = "clickwrap" | "esign";

/** Who will run the signature, as far as a member may know it: a name for the button. */
export interface ESignVendorRef {
  readonly driver: string;
  readonly displayName: string;
}

/**
 * Which ceremony a pending document asks for. Anything but an explicit `esign` is a click-wrap:
 * that is the server's default (`core.legal_document.ceremony DEFAULT 'clickwrap'`) and the
 * ceremony every earlier document was accepted under.
 */
export function ceremonyOf(doc: PendingAcceptance): Ceremony {
  return doc.ceremony === "esign" ? "esign" : "clickwrap";
}

/**
 * The vendor the NDA will be signed with. `undefined` when the server sent none — for an `esign`
 * document that means the workspace's connection is gone and the member cannot sign yet.
 */
export function esignVendorOf(doc: PendingAcceptance): ESignVendorRef | undefined {
  const vendor = doc.esign;
  if (vendor === null || vendor === undefined || vendor.displayName === "") return undefined;
  return { driver: vendor.driver, displayName: vendor.displayName };
}

/** Splits a pending list into the two ceremonies, keeping each side's order. */
export function splitByCeremony(docs: readonly PendingAcceptance[]): {
  clickwrap: PendingAcceptance[];
  esign: PendingAcceptance[];
} {
  const clickwrap: PendingAcceptance[] = [];
  const esign: PendingAcceptance[] = [];
  for (const doc of docs) (ceremonyOf(doc) === "esign" ? esign : clickwrap).push(doc);
  return { clickwrap, esign };
}

export function ndaStatusKey(documentId: string) {
  return ["esign", "nda-status", documentId] as const;
}

export function ndaStatusQuery(documentId: string) {
  return queryOptions({
    queryKey: ndaStatusKey(documentId),
    queryFn: () => call(api().GET("/esign/nda/status", { params: { query: { documentId } } })),
  });
}

export function startNda(documentId: string): Promise<ESignNdaStartResult> {
  return call(
    api().POST("/esign/nda/start", {
      body: {
        documentId,
        consentToElectronicRecords: true,
        disclosureVersion: ESIGN_DISCLOSURE_VERSION,
      },
    }),
  );
}

export const myEnvelopesQuery = queryOptions({
  queryKey: ["esign", "me", "envelopes"],
  queryFn: () => call(api().GET("/esign/me/envelopes")),
});

/** Saves the member's own signed copy. The server answers 404 for anyone else's envelope. */
export async function downloadMySignedCopy(envelope: {
  readonly id: string;
  readonly title?: string;
}): Promise<void> {
  const blob = await call(
    api().GET("/esign/me/envelopes/{id}/signed.pdf", {
      params: { path: { id: envelope.id } },
      parseAs: "blob",
    }),
  );
  saveBlob(blob, signedFilename(envelope.title));
}

/** `Mutual NDA` → `mutual-nda-signed.pdf`. */
export function signedFilename(title: string | undefined): string {
  const safe = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `${safe === "" ? "document" : safe}-signed.pdf`;
}

/**
 * Polling backoff for the NDA status, by how many answers have come back since polling began:
 * quick at first (the member usually returns from the vendor within seconds of the callback),
 * then settling at half a minute for an emailed link that may be signed tomorrow.
 */
export function ndaPollDelay(answers: number): number {
  const steps = [2_000, 3_000, 5_000, 8_000, 13_000, 20_000];
  return steps[Math.min(answers, steps.length - 1)] ?? 30_000;
}

/** Codes the ceremony explains itself rather than handing to the generic error copy. */
export type ESignMemberErrorKind =
  | "consent_required"
  | "not_configured"
  | "provider"
  | "superseded"
  | "esign_required"
  /** 409 `conflict` `not_pending` / `not_nda_document`: nothing here is owed any more. */
  | "not_pending"
  /** 409 `conflict` `envelope_creating`: a start is already in flight; retry shortly. */
  | "creating"
  /** 429 `rate_limited` `nda_start_budget`: too many new signing requests today. */
  | "start_budget"
  /** 422 `esign_nda_text_unsupported`: the text cannot be printed faithfully for signing. */
  | "text_unsupported";

function reasonOf(error: unknown): unknown {
  if (!isApiError(error)) return undefined;
  // Flattened on the wire (`error.reason`); tolerate a nested `details` too.
  return (
    error.body.error["reason"] ??
    (error.body.error["details"] as Record<string, unknown> | undefined)?.["reason"]
  );
}

export function esignErrorKind(error: unknown): ESignMemberErrorKind | undefined {
  if (!isApiError(error)) return undefined;
  switch (error.code as string) {
    case "esign_consent_required":
      return "consent_required";
    case "esign_not_configured":
      return "not_configured";
    case "esign_provider_error":
      return "provider";
    case "nda_version_superseded":
      return "superseded";
    case "esign_required":
      return "esign_required";
    case "esign_nda_text_unsupported":
      return "text_unsupported";
    case "conflict":
      switch (reasonOf(error)) {
        case "not_pending":
        case "not_nda_document":
          return "not_pending";
        case "envelope_creating":
          return "creating";
        default:
          return undefined;
      }
    case "rate_limited":
      return reasonOf(error) === "nda_start_budget" ? "start_budget" : undefined;
    default:
      return undefined;
  }
}

/** Envelope statuses that ended without a signature: the member may start again. */
export type EndedUnsigned = "declined" | "voided" | "expired" | "error";

/**
 * How the member's newest envelope for this document ended, when it ended unsigned — so the
 * ceremony can say why it is asking again instead of silently showing the sign button. The
 * member's own envelopes come newest first.
 */
export function lastUnsignedOutcome(
  envelopes: readonly Pick<ESignEnvelope, "purpose" | "subject" | "status">[],
  documentId: string,
): EndedUnsigned | undefined {
  const latest = envelopes.find((e) => e.purpose === "nda" && e.subject.id === documentId);
  switch (latest?.status) {
    case "declined":
    case "voided":
    case "expired":
    case "error":
      return latest.status;
    default:
      return undefined;
  }
}

/** The member's own NDA envelopes, newest first (enough to find the latest for one document). */
export const myNdaEnvelopesQuery = queryOptions({
  queryKey: ["esign", "me", "envelopes", "nda"],
  queryFn: () =>
    call(api().GET("/esign/me/envelopes", { params: { query: { purpose: "nda", limit: 50 } } })),
});

/**
 * Only a web URL is ever navigated to. `signingUrl` comes from the vendor through our server;
 * a `javascript:` or `data:` value there would be script on the portal origin, so anything that
 * is not http(s) is treated as "no link" and the member is told to use the email instead.
 */
export function safeSigningUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined || url === "") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
