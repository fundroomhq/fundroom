import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * The investor's own closing checklist (E3.5 §6): `GET /round/current/closing`.
 *
 * Derived on the server from the commitment, its signature request and the confirmation — the
 * browser draws the stages and never decides one. `canSign` and `signedDocumentAvailable` are
 * server flags for the same reason the data room's `canAsk` is: a delegate reads the checklist
 * but signs nothing and cannot fetch the investor's signed copy, and that rule lives in one place.
 */

export type MemberClosingView = FundRoomSchemas["InvestorRoundClosing"];
export type MemberClosingCommitment = FundRoomSchemas["InvestorClosingCommitment"];
export type MemberClosingChecklist = FundRoomSchemas["RoundClosingChecklist"];
export type MemberSignatureRequest = FundRoomSchemas["InvestorSignatureRequest"];

export const roundMemberClosingQuery = queryOptions({
  queryKey: ["round", "current", "closing"],
  queryFn: () => call(api().GET("/round/current/closing")),
});

/** A request the investor still has to act on (the vendor has emailed, or is about to email, the link). */
export function isOpenSignatureRequest(req: MemberSignatureRequest | null): boolean {
  return (
    req !== null &&
    (req.status === "pending" || req.status === "sent" || req.status === "delivered")
  );
}

/**
 * A request that ended without a signature; the team has to send a new one. An `error` whose
 * envelope reached the vendor (`envelopeId` set) is not over — the kernel's `error` is
 * recoverable — so it is "stalled", not dead.
 */
export function isDeadSignatureRequest(
  req: MemberSignatureRequest | null,
  envelopeId: string | null,
): boolean {
  if (req === null) return false;
  if (req.status === "error") return envelopeId === null;
  return req.status === "declined" || req.status === "voided" || req.status === "expired";
}

/** In `error`, but the vendor has the envelope: it may still be signed there. */
export function isStalledSignatureRequest(
  req: MemberSignatureRequest | null,
  envelopeId: string | null,
): boolean {
  return req !== null && req.status === "error" && envelopeId !== null;
}
