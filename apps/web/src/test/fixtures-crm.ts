import type {
  Allocation,
  AllocationView,
  CommitmentSummary,
  Contact,
  ContactActivity,
  ContactDetail,
  Note,
  Organization,
  PipelineItem,
  PipelineStage,
  RoundSummary,
  Task,
} from "../lib/crm-queries.js";

/*
 * Fixtures for the CRM screens (E2.5). They live here rather than in `mock-api.ts` because the
 * `/crm/...` payloads are typed by hand in `lib/crm-queries.ts` until the SDK is regenerated,
 * and `mock-api.ts` is written against `FundRoomSchemas`.
 *
 * The defaults are a small but *complete* workspace: the ten seeded stages, two contacts (one
 * of them linked to a member), one organisation, and two pipeline cards — one of which carries
 * a commitment id so the round join has something to find.
 */

export const CRM_ORG_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6b01";
export const CRM_CONTACT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a01";
export const CRM_CONTACT_ID_2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a02";
export const CRM_ITEM_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6c01";
export const CRM_ITEM_ID_2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6c02";
export const CRM_NOTE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f01";
export const CRM_TASK_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f02";
export const ROUND_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6d01";
export const COMMITMENT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6e01";
export const CRM_MEMBER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6e02";

const NOW = "2026-09-20T10:00:00.000Z";

const DEFAULT_STAGES: readonly (readonly [string, string, boolean])[] = [
  ["prospect", "Prospect", false],
  ["contacted", "Contacted", false],
  ["meeting", "Meeting", false],
  ["diligence", "Diligence", false],
  ["soft_committed", "Soft committed", false],
  ["committed", "Committed", false],
  ["docs_sent", "Docs sent", false],
  ["signed", "Signed", false],
  ["wired", "Wired", true],
  ["passed", "Passed", true],
];

export function stageId(key: string): string {
  const index = DEFAULT_STAGES.findIndex(([k]) => k === key);
  return `0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c70${String(index < 0 ? 99 : index).padStart(2, "0")}`;
}

export function crmStage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: stageId("prospect"),
    key: "prospect",
    name: "Prospect",
    position: 0,
    isTerminal: false,
    ...over,
  };
}

/** The ten keys §D10 seeds, in order. */
export function crmStages(): PipelineStage[] {
  return DEFAULT_STAGES.map(([key, name, isTerminal], position) =>
    crmStage({ id: stageId(key), key, name, position, isTerminal }),
  );
}

export function crmOrganization(over: Partial<Organization> = {}): Organization {
  return {
    id: CRM_ORG_ID,
    name: "Northwind Ventures",
    domain: "northwind.test",
    website: "https://northwind.test",
    kind: "fund",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function crmContact(over: Partial<Contact> = {}): Contact {
  return {
    id: CRM_CONTACT_ID,
    organizationId: CRM_ORG_ID,
    organization: { id: CRM_ORG_ID, name: "Northwind Ventures" },
    membershipId: null,
    displayName: "Ada Lovelace",
    email: "ada@northwind.test",
    title: "Partner",
    tags: ["seed", "warm intro"],
    notes: null,
    ownerMembershipId: null,
    ownerName: "Grace Hopper",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function crmPipelineItem(over: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: CRM_ITEM_ID,
    roundId: ROUND_ID,
    stageId: stageId("soft_committed"),
    contact: { id: CRM_CONTACT_ID, displayName: "Ada Lovelace", email: "ada@northwind.test" },
    organization: null,
    amount: "250000.000000",
    currency: "USD",
    ownerMembershipId: null,
    ownerName: "Grace Hopper",
    commitmentId: COMMITMENT_ID,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function crmNote(over: Partial<Note> = {}): Note {
  return {
    id: CRM_NOTE_ID,
    subjectKind: "contact",
    subjectId: CRM_CONTACT_ID,
    body: "Met at the seed dinner; wants the deck.",
    authorMembershipId: null,
    authorName: "Grace Hopper",
    createdAt: NOW,
    ...over,
  };
}

export function crmTask(over: Partial<Task> = {}): Task {
  return {
    id: CRM_TASK_ID,
    subjectKind: "contact",
    subjectId: CRM_CONTACT_ID,
    title: "Send the deck",
    dueAt: "2026-09-30T00:00:00.000Z",
    assigneeMembershipId: null,
    assigneeName: "Grace Hopper",
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function crmContactDetail(over: Partial<ContactDetail> = {}): ContactDetail {
  return {
    contact: crmContact(),
    organization: crmOrganization(),
    notes: [crmNote()],
    tasks: [crmTask()],
    pipelineItems: [crmPipelineItem()],
    ...over,
  };
}

export function roundSummary(over: Partial<RoundSummary> = {}): RoundSummary {
  return {
    id: ROUND_ID,
    name: "Seed 2026",
    status: "open",
    currency: "USD",
    targetAmount: "2000000.000000",
    ...over,
  };
}

export function crmCommitment(over: Partial<CommitmentSummary> = {}): CommitmentSummary {
  return { id: COMMITMENT_ID, amount: "300000.000000", status: "signed", ...over };
}

export function roundAllocation(over: Partial<Allocation> = {}): Allocation {
  return {
    target: "2000000.000000",
    soft: "100000.000000",
    verbal: "0.000000",
    signed: "300000.000000",
    wired: "50000.000000",
    committed: "350000.000000",
    total: "450000.000000",
    remaining: "1550000.000000",
    percent: { soft: "5.00", committed: "17.50", wired: "2.50" },
    ...over,
  };
}

export function roundAllocationView(over: Partial<AllocationView> = {}): AllocationView {
  return { allocation: roundAllocation(), commitments: [crmCommitment()], ...over };
}

/* E3.6: one booking-provider activity row for a contact (`GET /crm/contacts/{id}/activity`). */
export const CRM_ACTIVITY_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f10";

export function crmActivity(over: Partial<ContactActivity> = {}): ContactActivity {
  return {
    id: CRM_ACTIVITY_ID,
    contactId: CRM_CONTACT_ID,
    kind: "meeting_booked",
    occurredAt: "2026-09-18T09:00:00.000Z",
    startsAt: "2026-09-25T15:00:00.000Z",
    endsAt: "2026-09-25T15:30:00.000Z",
    title: "Intro call",
    provider: "calendly",
    bookingId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f20",
    ...over,
  };
}
