import type {
  RoundClosing,
  RoundClosingChecklist,
  RoundClosingCommitment,
  RoundSignatureRequest,
} from "../lib/round-closing-queries.js";
import { COMMITMENT_ID, INVESTOR_MEMBERSHIP_ID, ROUND_ID } from "./fixtures-round.js";

/*
 * Round closing fixtures, staff side (E3.5): three commitments at three points of the checklist —
 * Ada (a member, soft, nothing sent), Bolt Ventures (no member, agreement out for signature) and
 * Grace (a member, signed and wired, waiting for confirmation).
 */
export const BOLT_COMMITMENT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5711";
export const GRACE_COMMITMENT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5712";
export const BOLT_REQUEST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5721";
export const GRACE_REQUEST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5722";

export function checklist(over: Partial<RoundClosingChecklist> = {}): RoundClosingChecklist {
  return {
    documentsSent: false,
    documentsSentAt: null,
    signed: false,
    signedAt: null,
    wired: false,
    wiredAt: null,
    confirmed: false,
    confirmedAt: null,
    stage: "not_started",
    ...over,
  };
}

export function signatureRequest(over: Partial<RoundSignatureRequest> = {}): RoundSignatureRequest {
  return {
    id: BOLT_REQUEST_ID,
    roundId: ROUND_ID,
    commitmentId: BOLT_COMMITMENT_ID,
    envelopeId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b01",
    status: "sent",
    templateRef: "tmpl-101",
    sentAt: "2026-09-21T10:00:00.000Z",
    completedAt: null,
    terminalAt: null,
    signedDocumentId: null,
    ...over,
  };
}

export function closingCommitment(
  over: Partial<RoundClosingCommitment> = {},
): RoundClosingCommitment {
  return {
    commitmentId: COMMITMENT_ID,
    investor: {
      membershipId: INVESTOR_MEMBERSHIP_ID,
      contactId: null,
      organizationId: null,
      name: "Ada Lovelace",
    },
    amount: "50000.000000",
    currency: "USD",
    status: "soft",
    checklist: checklist(),
    signatureRequest: null,
    signedDocumentId: null,
    ...over,
  };
}

export function roundClosing(over: Partial<RoundClosing> = {}): RoundClosing {
  return {
    roundId: ROUND_ID,
    currency: "USD",
    summary: {
      currency: "USD",
      not_started: { count: 1, amount: "50000.000000" },
      documents_sent: { count: 1, amount: "25000.000000" },
      signed: { count: 0, amount: "0" },
      wired: { count: 1, amount: "100000.000000" },
      confirmed: { count: 0, amount: "0" },
      withdrawn: { count: 1, amount: "10000.000000" },
    },
    commitments: [
      closingCommitment(),
      closingCommitment({
        commitmentId: BOLT_COMMITMENT_ID,
        investor: {
          membershipId: null,
          contactId: null,
          organizationId: null,
          name: "Bolt Ventures",
        },
        amount: "25000.000000",
        status: "verbal",
        checklist: checklist({
          documentsSent: true,
          documentsSentAt: "2026-09-21T10:00:00.000Z",
          stage: "documents_sent",
        }),
        signatureRequest: signatureRequest(),
      }),
      closingCommitment({
        commitmentId: GRACE_COMMITMENT_ID,
        investor: {
          membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5799",
          contactId: null,
          organizationId: null,
          name: "Grace Hopper",
        },
        amount: "100000.000000",
        status: "wired",
        checklist: checklist({
          documentsSent: true,
          documentsSentAt: "2026-09-18T10:00:00.000Z",
          signed: true,
          signedAt: "2026-09-19T10:00:00.000Z",
          wired: true,
          wiredAt: "2026-09-20T10:00:00.000Z",
          stage: "wired",
        }),
        signatureRequest: signatureRequest({
          id: GRACE_REQUEST_ID,
          commitmentId: GRACE_COMMITMENT_ID,
          status: "completed",
          sentAt: "2026-09-18T10:00:00.000Z",
          completedAt: "2026-09-19T10:00:00.000Z",
          terminalAt: "2026-09-19T10:00:00.000Z",
        }),
      }),
    ],
    tasks: [],
    ...over,
  };
}
