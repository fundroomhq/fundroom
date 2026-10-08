import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QaQuestionViewSchema } from "./contracts.js";
import {
  approvalCurrent,
  canTransition,
  defaultPublicText,
  dueAtFor,
  isReleased,
  isUnanswered,
  nextStatus,
  QA_ACTIONS,
  QA_CLOSED_REASONS,
  QA_IMPORT_MAX_ROWS,
  QA_MAX_ASKS_PER_DAY,
  QA_STATUSES,
  type QaAction,
  type QaQuestionStatus,
  qaSearchTitle,
  sha256Hex,
  slaState,
} from "./rules.js";
import { projectQuestionView, type QaQuestionViewSource } from "./view.js";

const ALLOWED: Record<QaAction, readonly QaQuestionStatus[]> = {
  ask: [],
  assign: ["open", "assigned", "awaiting_approval", "answered", "published"],
  unassign: ["open", "assigned", "awaiting_approval", "answered", "published"],
  save_answer: ["open", "assigned", "awaiting_approval", "answered", "published"],
  submit: ["open", "assigned"],
  approve: ["awaiting_approval", "answered", "published"],
  reject: ["awaiting_approval"],
  release_asker: ["open", "assigned", "awaiting_approval"],
  release_target: ["open", "assigned", "awaiting_approval", "answered"],
  unpublish: ["published"],
  close: ["open", "assigned", "awaiting_approval", "answered", "published"],
  withdraw: ["open", "assigned", "awaiting_approval"],
  reopen: ["closed"],
  erase: ["open", "assigned", "awaiting_approval", "answered", "published", "closed"],
  withdraw_for_review: ["answered", "published"],
};

describe("Q&A status machine", () => {
  it("allows exactly the documented (status, action) pairs", () => {
    for (const action of QA_ACTIONS) {
      for (const from of QA_STATUSES) {
        expect(canTransition(from, action), `${from} --${action}-->`).toBe(
          ALLOWED[action].includes(from),
        );
      }
    }
  });

  it("creates with ask, and nothing else starts from nothing", () => {
    expect(nextStatus(null, "ask")).toBe("open");
    expect(canTransition(null, "ask")).toBe(true);
    for (const action of QA_ACTIONS.filter((a) => a !== "ask")) {
      expect(nextStatus(null, action)).toBeNull();
    }
  });

  it("moves to the documented statuses", () => {
    expect(nextStatus("open", "assign")).toBe("assigned");
    expect(nextStatus("awaiting_approval", "assign")).toBe("awaiting_approval");
    expect(nextStatus("assigned", "unassign")).toBe("open");
    expect(nextStatus("published", "save_answer")).toBe("published");
    expect(nextStatus("assigned", "submit")).toBe("awaiting_approval");
    expect(nextStatus("awaiting_approval", "approve")).toBe("awaiting_approval");
    expect(nextStatus("assigned", "release_asker")).toBe("answered");
    expect(nextStatus("answered", "release_target")).toBe("published");
    expect(nextStatus("published", "close")).toBe("closed");
    expect(nextStatus("assigned", "withdraw")).toBe("closed");
    expect(nextStatus("answered", "withdraw")).toBeNull();
    expect(nextStatus("closed", "erase")).toBe("closed");
  });

  it("branches on assignee and asker where the contract says so", () => {
    expect(nextStatus("awaiting_approval", "reject", { hasAssignee: true })).toBe("assigned");
    expect(nextStatus("awaiting_approval", "reject")).toBe("open");
    expect(nextStatus("closed", "reopen", { hasAssignee: true })).toBe("assigned");
    expect(nextStatus("closed", "reopen", { hasAssignee: false })).toBe("open");
    expect(nextStatus("published", "unpublish", { hasAsker: true })).toBe("answered");
    expect(nextStatus("published", "unpublish", { hasAsker: false, hasAssignee: true })).toBe(
      "assigned",
    );
    expect(nextStatus("published", "unpublish")).toBe("open");
    // four-eyes: a changed released answer goes back to the answerer's queue
    expect(nextStatus("published", "withdraw_for_review", { hasAssignee: true })).toBe("assigned");
    expect(nextStatus("answered", "withdraw_for_review")).toBe("open");
    expect(nextStatus("assigned", "withdraw_for_review")).toBeNull();
  });

  it("has no closed reason nothing sets", () => {
    expect(QA_CLOSED_REASONS).toEqual(["declined", "withdrawn", "erased"]);
  });

  it("classifies unanswered and released statuses", () => {
    expect(QA_STATUSES.filter(isUnanswered)).toEqual(["open", "assigned", "awaiting_approval"]);
    expect(QA_STATUSES.filter(isReleased)).toEqual(["answered", "published"]);
  });
});

describe("slaState", () => {
  const due = new Date("2026-09-25T12:00:00Z");
  const at = (iso: string) => new Date(iso);

  it("is none without a due time or once the question is no longer waiting", () => {
    expect(slaState(null, at("2026-09-30T00:00:00Z"), 24, "open")).toBe("none");
    for (const status of ["answered", "published", "closed"] as const) {
      expect(slaState(due, at("2026-09-30T00:00:00Z"), 24, status)).toBe("none");
    }
  });

  it("is on_track, due_soon inside the lead window, overdue at and after due", () => {
    expect(slaState(due, at("2026-09-24T11:59:59Z"), 24, "open")).toBe("on_track");
    expect(slaState(due, at("2026-09-24T12:00:00Z"), 24, "assigned")).toBe("due_soon");
    expect(slaState(due, at("2026-09-25T11:59:59Z"), 24, "awaiting_approval")).toBe("due_soon");
    expect(slaState(due, at("2026-09-25T12:00:00Z"), 24, "open")).toBe("overdue");
    expect(slaState(due, at("2026-10-01T00:00:00Z"), 24, "open")).toBe("overdue");
  });

  it("never reports due_soon with a zero lead", () => {
    expect(slaState(due, at("2026-09-25T11:59:59Z"), 0, "open")).toBe("on_track");
    expect(slaState(due, at("2026-09-25T12:00:00Z"), 0, "open")).toBe("overdue");
  });

  it("computes due_at from ask time plus the SLA", () => {
    expect(dueAtFor(at("2026-09-25T00:00:00Z"), 72).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });
});

describe("text helpers", () => {
  it("defaults the public text to subject and body", () => {
    expect(defaultPublicText("  Revenue? ", "What was ARR?\n")).toBe("Revenue?\n\nWhat was ARR?");
  });

  it("hashes bodies as lower-case hex SHA-256", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("réponse")).toBe(
      createHash("sha256").update(Buffer.from("réponse", "utf8")).digest("hex"),
    );
    expect(sha256Hex("a")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("treats an approval as current only for the exact body approved", () => {
    const body = "Yes, audited.";
    expect(approvalCurrent({ body, approvedBodySha256: sha256Hex(body) })).toBe(true);
    expect(approvalCurrent({ body: `${body} `, approvedBodySha256: sha256Hex(body) })).toBe(false);
    expect(approvalCurrent({ body, approvedBodySha256: null })).toBe(false);
  });

  it("titles search entries from the first non-empty line", () => {
    expect(qaSearchTitle("\n  Revenue?  \n\nbody")).toBe("Revenue?");
    expect(qaSearchTitle("x".repeat(250))).toHaveLength(200);
    expect(qaSearchTitle("")).toBe("");
  });

  it("pins the budgets", () => {
    expect(QA_MAX_ASKS_PER_DAY).toBe(20);
    expect(QA_IMPORT_MAX_ROWS).toBe(500);
  });
});

describe("projectQuestionView", () => {
  const asker = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01";
  const other = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";
  const base: QaQuestionViewSource = {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b10",
    targetKind: "document",
    documentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b20",
    folderId: null,
    askerMembershipId: asker,
    status: "published",
    subject: "ARR",
    body: "What was ARR at Acme Corp's renewal?",
    publicText: "ARR\n\nWhat was ARR?",
    visibility: "target",
    createdAt: new Date("2026-09-20T00:00:00Z"),
    releasedAt: new Date("2026-09-21T00:00:00Z"),
    publishedAt: new Date("2026-09-22T00:00:00Z"),
    answerBody: "$1.2m",
  };

  it("shows the asker everything of their own question", () => {
    const v = projectQuestionView(base, { membershipId: asker, isDelegate: false }, "Deck");
    expect(v).toEqual({
      id: base.id,
      targetKind: "document",
      targetId: base.documentId,
      targetTitle: "Deck",
      mine: true,
      status: "published",
      subject: "ARR",
      body: base.body,
      publicText: base.publicText,
      answer: { body: "$1.2m", releasedAt: "2026-09-21T00:00:00.000Z" },
      createdAt: "2026-09-20T00:00:00.000Z",
      publishedAt: "2026-09-22T00:00:00.000Z",
      releasedAt: "2026-09-21T00:00:00.000Z",
      visibility: "target",
    });
    expect(QaQuestionViewSchema.safeParse(v).success).toBe(true);
  });

  it("never shows another investor the asker's own words", () => {
    const v = projectQuestionView(base, { membershipId: other, isDelegate: false }, "Deck");
    expect(v).toMatchObject({ mine: false, subject: null, body: null, status: "published" });
    expect(JSON.stringify(v)).not.toContain("Acme");
    // when a rival asked is not theirs to know; when it was published is
    expect(v).toMatchObject({ createdAt: null, publishedAt: "2026-09-22T00:00:00.000Z" });
    expect(QaQuestionViewSchema.safeParse(v).success).toBe(true);
  });

  it("hides unpublished questions from everyone but the asker", () => {
    const answered = { ...base, status: "answered" as const, visibility: "asker" as const };
    expect(projectQuestionView(answered, { membershipId: other, isDelegate: false }, "")).toBe(
      null,
    );
    const mine = projectQuestionView(answered, { membershipId: asker, isDelegate: false }, "");
    expect(mine).toMatchObject({
      status: "answered",
      publicText: null,
      visibility: "asker",
      publishedAt: null,
    });
    expect(mine?.answer?.body).toBe("$1.2m");
  });

  it("does not treat a delegate as the asker", () => {
    const open = { ...base, status: "open" as const, visibility: null, releasedAt: null };
    expect(projectQuestionView(open, { membershipId: asker, isDelegate: true }, "")).toBeNull();
    expect(projectQuestionView(base, { membershipId: asker, isDelegate: true }, "")?.mine).toBe(
      false,
    );
  });

  it("withholds a draft answer until release", () => {
    const assigned = {
      ...base,
      status: "assigned" as const,
      visibility: null,
      releasedAt: null,
      publicText: null,
    };
    const v = projectQuestionView(assigned, { membershipId: asker, isDelegate: false }, "");
    expect(v).toMatchObject({ answer: null, releasedAt: null, visibility: null });
  });
});
