import { readdirSync, readFileSync } from "node:fs";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import {
  bucketFor,
  CHANNEL_EVENT_TYPES,
  DEFAULT_CADENCE,
  dedupeKey,
  digestSubject,
  effectiveCadence,
  GROUP_TITLE,
  groupForDigest,
  instantSubject,
  isChannelEventType,
  isNotifyEventType,
  isoWeekKey,
  isSentenceEventType,
  isWorkspaceEventType,
  NOTIFY_EVENT_TYPES,
  VERB,
} from "./rules.js";
import type { Notification } from "./schema/notify.js";
import {
  channelInputOf,
  fromSlackApp,
  renderChannelMessage,
  slackAppText,
} from "./service/channels.js";
import { renderInstant } from "./service/notify.js";

describe("cadence defaults", () => {
  it("views and downloads default to daily, replies to instant; stored rows win", () => {
    expect(effectiveCadence("document.viewed", undefined)).toBe("daily");
    expect(effectiveCadence("document.downloaded", new Map())).toBe("daily");
    expect(effectiveCadence("update.replied", undefined)).toBe("instant");
    expect(effectiveCadence("document.viewed", new Map([["document.viewed", "off"]]))).toBe("off");
    expect(effectiveCadence("update.replied", new Map([["document.viewed", "off"]]))).toBe(
      DEFAULT_CADENCE["update.replied"],
    );
    expect(isNotifyEventType("document.viewed")).toBe(true);
    expect(isNotifyEventType("update.published")).toBe(false);
  });

  it("the round events are instant, and every type has copy (E2.5)", () => {
    // Instant, unlike a view: an indication of interest is a person saying they want to put
    // money in, and a founder who hears about it in tomorrow's digest has already been slow.
    expect(effectiveCadence("round.interest_submitted", undefined)).toBe("instant");
    expect(effectiveCadence("round.verification_requested", undefined)).toBe("instant");
    expect(isNotifyEventType("round.interest_submitted")).toBe(true);
    expect(isNotifyEventType("round.interest_decided")).toBe(false);
    // The three tables are what the email, the digest and the preferences form read; a type in
    // one and not the others renders a blank line to a founder rather than failing loudly.
    for (const type of NOTIFY_EVENT_TYPES) {
      expect(DEFAULT_CADENCE[type]).toBeDefined();
      expect(VERB[type]?.length ?? 0).toBeGreaterThan(3);
      expect(GROUP_TITLE[type]?.length ?? 0).toBeGreaterThan(3);
    }
    expect(instantSubject("Ada", "round.interest_submitted")).toBe(
      "Ada indicated interest in the round",
    );
  });
});

describe("dedupe key", () => {
  it("buckets views per hour and replies per reply id", () => {
    const t1 = new Date("2026-09-12T10:05:00Z");
    const t2 = new Date("2026-09-12T10:59:59Z");
    const t3 = new Date("2026-09-12T11:00:00Z");
    expect(bucketFor("document.viewed", t1)).toBe(bucketFor("document.viewed", t2));
    expect(bucketFor("document.viewed", t1)).not.toBe(bucketFor("document.viewed", t3));
    expect(bucketFor("document.downloaded", t1)).toBe(bucketFor("document.viewed", t1));
    expect(bucketFor("update.replied", t1, "r1")).toBe("r1");
    expect(bucketFor("update.replied", t3, "r1")).toBe("r1");
    // One bucket per submission and per verification, never per hour: two investors indicating
    // interest in the same hour are two facts, and the hourly collapse would drop the second.
    expect(bucketFor("round.interest_submitted", t1, "s1")).toBe("s1");
    expect(bucketFor("round.interest_submitted", t1, "s2")).toBe("s2");
    expect(bucketFor("round.verification_requested", t3, "v1")).toBe("v1");
    // A caller that forgets the id dedupes loudly rather than leaking a flood.
    expect(bucketFor("round.interest_submitted", t1)).toBe("interest");
    expect(bucketFor("round.verification_requested", t1)).toBe("verification");
  });

  it("is a stable composite of type, recipient, actor, resource and bucket", () => {
    const key = dedupeKey({
      eventType: "document.viewed",
      recipientMembershipId: "owner",
      actorMembershipId: "ada",
      resourceId: "doc",
      bucket: "496",
    });
    expect(key).toBe("document.viewed:owner:ada:doc:496");
    expect(
      dedupeKey({
        eventType: "document.viewed",
        recipientMembershipId: "admin",
        actorMembershipId: "ada",
        resourceId: "doc",
        bucket: "496",
      }),
    ).not.toBe(key);
  });
});

describe("digest grouping", () => {
  const names = new Map([
    ["ada", "Ada L."],
    ["bob", "Bob"],
  ]);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Someone") : "Someone");

  it("groups by event type, then by actor+resource with counts, most frequent first", () => {
    const groups = groupForDigest(
      [
        { eventType: "document.viewed", actorMembershipId: "ada", resourceId: "d1" },
        { eventType: "document.viewed", actorMembershipId: "ada", resourceId: "d1" },
        { eventType: "document.viewed", actorMembershipId: "ada", resourceId: "d1" },
        { eventType: "document.viewed", actorMembershipId: "bob", resourceId: "d1" },
        { eventType: "document.downloaded", actorMembershipId: "bob", resourceId: "d2" },
        { eventType: "update.replied", actorMembershipId: null, resourceId: "p1" },
      ],
      nameOf,
    );
    expect(groups.map((g) => [g.eventType, g.count])).toEqual([
      ["document.viewed", 4],
      ["document.downloaded", 1],
      ["update.replied", 1],
    ]);
    expect(groups[0]?.lines).toEqual(["Ada L. viewed a document · 3×", "Bob viewed a document"]);
    expect(groups[1]?.lines).toEqual(["Bob downloaded a document"]);
    expect(groups[2]?.lines).toEqual(["Someone replied to an update"]);
  });

  it("caps the lines across groups but keeps exact counts; empty input → no groups", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      eventType: "document.viewed" as const,
      actorMembershipId: `m${i}`,
      resourceId: "d",
    }));
    const groups = groupForDigest(
      [...rows, { eventType: "update.replied", actorMembershipId: "ada", resourceId: "p" }],
      nameOf,
      20,
    );
    expect(groups[0]?.lines).toHaveLength(20);
    expect(groups[0]?.count).toBe(30);
    expect(groups[1]?.lines).toEqual([]);
    expect(groups[1]?.count).toBe(1);
    expect(groupForDigest([], nameOf)).toEqual([]);
  });

  it("builds subjects without personal data beyond the display name", () => {
    expect(instantSubject("Ada L.", "document.viewed")).toBe("Ada L. viewed a document");
    expect(instantSubject("Ada L.", "update.replied")).toBe("Ada L. replied to an update");
    expect(digestSubject("Acme", 1)).toBe("Acme: 1 new activity in your data room");
    expect(digestSubject("Acme", 5)).toBe("Acme: 5 new activities in your data room");
  });
});

describe("E2.6 event types and channels", () => {
  it("commitments and hot leads are instant, dedupe per commitment and per day", () => {
    expect(effectiveCadence("round.commitment_created", undefined)).toBe("instant");
    expect(effectiveCadence("analytics.hot_lead", undefined)).toBe("instant");
    expect(bucketFor("round.commitment_created", new Date(), "c1")).toBe("c1");
    const morning = new Date("2026-09-12T01:00:00Z");
    const evening = new Date("2026-09-12T23:00:00Z");
    const next = new Date("2026-09-13T00:00:00Z");
    expect(bucketFor("analytics.hot_lead", morning)).toBe(bucketFor("analytics.hot_lead", evening));
    expect(bucketFor("analytics.hot_lead", morning)).not.toBe(
      bucketFor("analytics.hot_lead", next),
    );
  });

  it("a commitment without a member id still has a stable dedupe key", () => {
    const key = dedupeKey({
      eventType: "round.commitment_created",
      recipientMembershipId: "r",
      actorMembershipId: null,
      resourceId: "c1",
      bucket: "c1",
    });
    expect(key).toBe("round.commitment_created:r:-:c1:c1");
  });

  it("channels announce workspace-level facts only", () => {
    expect([...CHANNEL_EVENT_TYPES].sort()).toEqual([
      "access_request.submitted",
      "access_review.overdue",
      "analytics.hot_lead",
      "integration.connection_unhealthy",
      "qa.question_asked",
      "round.commitment_created",
      "round.interest_submitted",
      "round.verification_requested",
    ]);
    for (const t of CHANNEL_EVENT_TYPES) expect(isNotifyEventType(t)).toBe(true);
    expect(isChannelEventType("document.viewed")).toBe(false);
    expect(isChannelEventType("update.replied")).toBe(false);
  });

  it("weekly digests have their own subject", () => {
    expect(digestSubject("Acme", 3, "weekly")).toBe("Acme: your week — 3 new activities");
    expect(digestSubject("Acme", 1)).toBe("Acme: 1 new activity in your data room");
  });
});

describe("E3.1 access requests", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme", primaryHost: null };

  it("is instant, one bucket per request, with copy for every surface", () => {
    expect(isNotifyEventType("access_request.submitted")).toBe(true);
    expect(isChannelEventType("access_request.submitted")).toBe(true);
    expect(effectiveCadence("access_request.submitted", undefined)).toBe("instant");
    const at = new Date("2026-09-25T10:00:00Z");
    expect(bucketFor("access_request.submitted", at, "r1")).toBe("r1");
    expect(bucketFor("access_request.submitted", at, "r2")).toBe("r2");
    expect(bucketFor("access_request.submitted", at)).toBe("access_request");
    expect(instantSubject("Ada Lovelace", "access_request.submitted")).toBe(
      "Ada Lovelace requested access",
    );
    expect(GROUP_TITLE["access_request.submitted"]).toBe("Access requests");
  });

  it("the digest names a member-less requester through the resource id", () => {
    const groups = groupForDigest(
      [{ eventType: "access_request.submitted", actorMembershipId: null, resourceId: "r1" }],
      (id, resourceId) => (id === null && resourceId === "r1" ? "Ada Lovelace" : "Someone"),
    );
    expect(groups[0]?.lines).toEqual(["Ada Lovelace requested access"]);
  });

  it("the email names the requester and links to the queue", () => {
    const r = renderInstant(
      services,
      ws,
      {
        eventType: "access_request.submitted",
        actorMembershipId: null,
        resourceId: "r1",
        payload: { accessRequestId: "r1" },
      } as unknown as Notification,
      "Ada Lovelace",
    );
    expect(r.subject).toBe("Ada Lovelace requested access");
    expect(r.paragraphs[0]).toBe(
      "Ada Lovelace requested access to Acme. The request is waiting for a decision.",
    );
    expect(r.cta).toEqual({
      label: "Review access requests",
      url: "https://acme.example.test/admin/access-requests",
    });
  });

  it("a channel post never carries the requester's details, whatever name it is handed", () => {
    const msg = renderChannelMessage(
      services,
      ws,
      {
        eventType: "access_request.submitted",
        payload: { accessRequestId: "r1" },
        actorMembershipId: null,
      },
      "Ada Lovelace",
    );
    expect(msg.text).toBe("A new access request is waiting for review in Acme.");
    expect(JSON.stringify(msg)).not.toContain("Ada");
    expect(msg.link?.url).toBe("https://acme.example.test/admin/access-requests");
  });

  it("the newest migration's CHECKs list exactly the TypeScript vocabularies", () => {
    // Each vocabulary migration drops and recreates all three CHECKs, so the newest definition of
    // each constraint (the last migration that ADDs it) is the one in force.
    const dir = new URL("../migrations/", import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.at(-1)).toBe("0012_verification_member_events.sql");
    const listOf = (constraint: string) => {
      let line = "";
      for (const f of files) {
        const found = readFileSync(new URL(f, dir), "utf8")
          .split("\n")
          .find((l) => l.includes(`ADD CONSTRAINT ${constraint}`));
        if (found !== undefined) line = found;
      }
      return [...line.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
    };
    expect(listOf("preference_event_type")).toEqual([...NOTIFY_EVENT_TYPES].sort());
    expect(listOf("notification_event_type")).toEqual([...NOTIFY_EVENT_TYPES].sort());
    expect(listOf("channel_event_types")).toEqual([...CHANNEL_EVENT_TYPES].sort());
  });
});

describe("E3.2 overdue access review", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme", primaryHost: null };

  it("is an instant, actor-less workspace event with channel support", () => {
    expect(isNotifyEventType("access_review.overdue")).toBe(true);
    expect(isChannelEventType("access_review.overdue")).toBe(true);
    expect(isWorkspaceEventType("access_review.overdue")).toBe(true);
    expect(isWorkspaceEventType("access_request.submitted")).toBe(false);
    expect(effectiveCadence("access_review.overdue", undefined)).toBe("instant");
    expect(GROUP_TITLE["access_review.overdue"]).toBe("Access reviews");
    expect(instantSubject("Someone", "access_review.overdue")).toBe("The access review is overdue");
  });

  it("buckets by ISO week (UTC): same week collapses, the next week alerts again", () => {
    const mon = new Date("2026-09-21T00:00:00Z");
    const sun = new Date("2026-09-27T23:59:59Z");
    const nextMon = new Date("2026-09-28T00:00:00Z");
    expect(bucketFor("access_review.overdue", mon)).toBe("2026-W39");
    expect(bucketFor("access_review.overdue", sun)).toBe("2026-W39");
    expect(bucketFor("access_review.overdue", nextMon)).toBe("2026-W40");
    // The ISO year is the Thursday's: 2027-01-01 (a Friday) is still in 2026's last week, and
    // 2024-12-30 (a Monday) is already 2025-W01.
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01");
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });

  it("a digest line is the sentence alone, never '<name> …'", () => {
    const groups = groupForDigest(
      [{ eventType: "access_review.overdue", actorMembershipId: null, resourceId: "w" }],
      () => "Someone",
    );
    expect(groups[0]?.lines).toEqual(["The access review is overdue"]);
  });

  it("the email gives the due day, says when there was never a review, and links to it", () => {
    const row = (payload: Record<string, unknown>) =>
      ({
        eventType: "access_review.overdue",
        actorMembershipId: null,
        resourceKind: "workspace",
        resourceId: "w",
        payload,
      }) as unknown as Notification;
    const first = renderInstant(
      services,
      ws,
      row({ dueAt: "2026-09-20T08:00:00.000Z", lastReviewId: null }),
      "Someone",
    );
    expect(first.subject).toBe("The access review is overdue");
    expect(first.paragraphs[0]).toBe(
      "The periodic access review of Acme was due on 2026-09-20. No access review has been " +
        "recorded yet. Check who can see what and record the review.",
    );
    expect(first.cta).toEqual({
      label: "Open the access review",
      url: "https://acme.example.test/admin/access-review",
    });
    const again = renderInstant(
      services,
      ws,
      row({ dueAt: "2026-09-20T08:00:00.000Z", lastReviewId: "r1" }),
      "Someone",
    );
    expect(again.paragraphs[0]).not.toContain("No access review");
    expect(JSON.stringify(again)).not.toContain("Someone");
  });

  it("the channel post names nobody", () => {
    const msg = renderChannelMessage(
      services,
      ws,
      {
        eventType: "access_review.overdue",
        payload: { dueAt: "2026-09-20T08:00:00.000Z" },
        actorMembershipId: null,
      },
      null,
    );
    expect(msg.text).toBe("The periodic access review of Acme is overdue.");
    expect(msg.link?.url).toBe("https://acme.example.test/admin/access-review");
  });
});

describe("E3.3 data-room Q&A", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme", primaryHost: null };
  const QA = [
    "qa.question_asked",
    "qa.question_assigned",
    "qa.answer_submitted",
    "qa.answer_released",
    "qa.question_declined",
    "qa.question_due",
  ] as const;
  const row = (eventType: string, payload: Record<string, unknown>, actor: string | null = null) =>
    ({
      eventType,
      membershipId: "r",
      actorMembershipId: actor,
      resourceKind: "qa_question",
      resourceId: "q1",
      payload,
    }) as unknown as Notification;
  /** Words that would mean the copy quotes the question or the answer. */
  const SECRET = "Is the patent pending?";

  it("six instant types; only a new question is a channel event", () => {
    for (const t of QA) {
      expect(isNotifyEventType(t)).toBe(true);
      expect(effectiveCadence(t, undefined)).toBe("instant");
      expect(isChannelEventType(t)).toBe(t === "qa.question_asked");
      expect(isWorkspaceEventType(t)).toBe(false);
      expect(isSentenceEventType(t)).toBe(t !== "qa.question_asked");
    }
    expect(effectiveCadence("qa.question_due", new Map([["qa.question_due", "daily"]]))).toBe(
      "daily",
    );
  });

  it("buckets per question, and per phase / visibility / outbox event where the handler says so", () => {
    const at = new Date("2026-09-25T10:00:00Z");
    const later = new Date("2026-09-26T10:00:00Z");
    expect(bucketFor("qa.question_asked", at, "q1")).toBe(
      bucketFor("qa.question_asked", later, "q1"),
    );
    expect(bucketFor("qa.question_asked", at, "q1")).not.toBe(
      bucketFor("qa.question_asked", at, "q2"),
    );
    expect(bucketFor("qa.question_due", at, "q1:due_soon")).not.toBe(
      bucketFor("qa.question_due", at, "q1:overdue"),
    );
    // A moved deadline re-arms the reminder: the handler's id carries the due date.
    expect(bucketFor("qa.question_due", at, "q1:due_soon:2026-09-26T09:30:00.000Z")).not.toBe(
      bucketFor("qa.question_due", at, "q1:due_soon:2026-09-28T09:30:00.000Z"),
    );
    // Never the clock: a forgotten id dedupes loudly.
    expect(bucketFor("qa.answer_released", at)).toBe("qa");
    expect(bucketFor("qa.answer_released", later)).toBe("qa");
  });

  it("subjects and digest lines are sentences, except the asker's name on a new question", () => {
    expect(instantSubject("Ada", "qa.question_asked")).toBe("Ada asked a data-room question");
    expect(instantSubject("Bob", "qa.question_assigned")).toBe(
      "A data-room question was assigned to you",
    );
    const groups = groupForDigest(
      [
        { eventType: "qa.question_asked", actorMembershipId: "ada", resourceId: "q1" },
        { eventType: "qa.question_due", actorMembershipId: null, resourceId: "q1" },
      ],
      (id) => (id === "ada" ? "Ada" : "Someone"),
    );
    expect(groups.map((g) => g.lines)).toEqual([
      ["Ada asked a data-room question"],
      ["A data-room question is due soon or overdue"],
    ]);
    for (const t of QA) expect(GROUP_TITLE[t].length).toBeGreaterThan(3);
  });

  it("staff alerts link to the admin question page; the asker's to the portal", () => {
    const admin = "https://acme.example.test/admin/data-room/questions/q1";
    const asked = renderInstant(
      services,
      ws,
      row("qa.question_asked", { questionId: "q1" }, "ada"),
      "Ada",
    );
    expect(asked.subject).toBe("Ada asked a data-room question");
    expect(asked.cta?.url).toBe(admin);
    const assigned = renderInstant(
      services,
      ws,
      row("qa.question_assigned", { questionId: "q1" }, "bob"),
      "Bob",
    );
    expect(assigned.subject).toBe("A data-room question was assigned to you");
    expect(assigned.cta?.url).toBe(admin);
    const submitted = renderInstant(
      services,
      ws,
      row("qa.answer_submitted", { questionId: "q1" }),
      "Someone",
    );
    expect(submitted.cta).toEqual({ label: "Review the answer", url: admin });
    const toAsker = renderInstant(
      services,
      ws,
      row("qa.answer_released", { questionId: "q1", visibility: "asker" }),
      "Someone",
    );
    expect(toAsker.subject).toBe("Acme answered your question");
    expect(toAsker.paragraphs[0]).toContain("Only you can see the answer.");
    expect(toAsker.cta).toEqual({
      label: "Read the answer",
      url: "https://acme.example.test/data-room/questions/q1",
    });
    const published = renderInstant(
      services,
      ws,
      row("qa.answer_released", { questionId: "q1", visibility: "target" }),
      "Someone",
    );
    expect(published.paragraphs[0]).toContain("published the answer for everyone");
    const declined = renderInstant(
      services,
      ws,
      row("qa.question_declined", { questionId: "q1" }),
      "Someone",
    );
    expect(declined.subject).toBe("Acme declined your question");
    expect(declined.cta).toEqual({
      label: "View your question",
      url: "https://acme.example.test/data-room/questions/q1",
    });
    for (const r of [asked, assigned, submitted, toAsker, published, declined]) {
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain("Someone");
    }
  });

  it("due reminders say which phase, with the deadline", () => {
    const soon = renderInstant(
      services,
      ws,
      row("qa.question_due", {
        questionId: "q1",
        phase: "due_soon",
        dueAt: "2026-09-26T09:30:00.000Z",
      }),
      "Someone",
    );
    const late = renderInstant(
      services,
      ws,
      row("qa.question_due", {
        questionId: "q1",
        phase: "overdue",
        dueAt: "2026-09-26T09:30:00.000Z",
      }),
      "Someone",
    );
    expect(soon.subject).toBe("A data-room question is due soon");
    expect(late.subject).toBe("A data-room question is overdue");
    expect(soon.paragraphs[0]).toContain("2026-09-26 09:30 UTC");
    expect(late.paragraphs[0]).toContain("passed its answer deadline");
    expect(late.cta?.url).toBe("https://acme.example.test/admin/data-room/questions/q1");
  });

  it("the channel post names nobody and quotes nothing, whatever name it is handed", () => {
    const msg = renderChannelMessage(
      services,
      ws,
      { eventType: "qa.question_asked", payload: { questionId: "q1" }, actorMembershipId: "ada" },
      "Ada Lovelace",
    );
    expect(msg.text).toBe("A new data-room question is waiting in Acme.");
    expect(JSON.stringify(msg)).not.toContain("Ada");
    expect(msg.link?.url).toBe("https://acme.example.test/admin/data-room/questions/q1");
  });
});

describe("E3.5 e-signature and round closing", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme", primaryHost: null };
  const row = (eventType: string, payload: Record<string, unknown>, actor: string | null = null) =>
    ({
      eventType,
      membershipId: "r",
      actorMembershipId: actor,
      resourceKind: eventType.startsWith("esign.") ? "esign_envelope" : "commitment",
      resourceId: "x1",
      payload,
    }) as unknown as Notification;

  it("all three are instant, never channel events, and bucket per envelope / commitment", () => {
    const at = new Date("2026-09-25T10:00:00Z");
    for (const t of [
      "esign.envelope_attention",
      "round.signature_completed",
      "round.commitment_confirmed",
    ] as const) {
      expect(effectiveCadence(t, undefined)).toBe("instant");
      expect(isChannelEventType(t)).toBe(false);
    }
    expect(bucketFor("esign.envelope_attention", at, "e1:declined")).toBe("e1:declined");
    expect(bucketFor("round.signature_completed", at, "e1")).toBe("e1");
    expect(bucketFor("round.commitment_confirmed", at, "c1")).toBe("c1");
  });

  it("an attention alert says what happened to which kind of envelope, and names nobody", () => {
    const declined = renderInstant(
      services,
      ws,
      row("esign.envelope_attention", {
        envelopeId: "e1",
        status: "declined",
        purpose: "round_closing",
      }),
      "Someone",
    );
    expect(declined.subject).toBe("An e-signature request was declined");
    expect(declined.paragraphs[0]).toContain("A subscription agreement in Acme was declined");
    expect(declined.cta?.url).toBe("https://acme.example.test/admin/esign");
    const nda = renderInstant(
      services,
      ws,
      row("esign.envelope_attention", { envelopeId: "e1", status: "expired", purpose: "nda" }),
      "Someone",
    );
    expect(nda.subject).toBe("An e-signature request expired");
    expect(nda.paragraphs[0]).toContain("An NDA sent for signature in Acme expired");
  });

  it("a signed agreement names the signer when there is one, and links the round", () => {
    const named = renderInstant(
      services,
      ws,
      row("round.signature_completed", { roundId: "r1", commitmentId: "c1" }, "ada"),
      "Ada Lovelace",
    );
    expect(named.subject).toBe("Ada Lovelace signed the subscription agreement");
    expect(named.cta?.url).toBe("https://acme.example.test/admin/round/rounds/r1");
    const anonymous = renderInstant(
      services,
      ws,
      row("round.signature_completed", { roundId: "r1", commitmentId: "c1" }),
      "Someone",
    );
    expect(anonymous.subject).toBe("A subscription agreement was signed");
  });

  it("the investor's confirmation is in the second person and links the portal round page", () => {
    const r = renderInstant(
      services,
      ws,
      row("round.commitment_confirmed", { roundId: "r1", commitmentId: "c1" }),
      "Someone",
    );
    expect(r.subject).toBe("Acme confirmed your commitment");
    expect(r.paragraphs[0]).toContain("confirmed your investment");
    expect(r.cta?.url).toBe("https://acme.example.test/round");
  });
});

describe("E3.6 integration health and Slack app channels", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme <& Co>", primaryHost: null };
  const payload = { connectionId: "c1", provider: "quickbooks", status: "reauth_required" };
  const row = (p: Record<string, unknown>) =>
    ({
      eventType: "integration.connection_unhealthy",
      membershipId: "r",
      actorMembershipId: null,
      resourceKind: "integration_connection",
      resourceId: "c1",
      payload: p,
    }) as unknown as Notification;

  it("is an instant, actor-less workspace event that channels may announce", () => {
    const t = "integration.connection_unhealthy";
    expect(isNotifyEventType(t)).toBe(true);
    expect(isChannelEventType(t)).toBe(true);
    expect(isWorkspaceEventType(t)).toBe(true);
    expect(effectiveCadence(t, undefined)).toBe("instant");
    expect(bucketFor(t, new Date(), "c1:degraded:7")).toBe("c1:degraded:7");
    const groups = groupForDigest(
      [{ eventType: t, actorMembershipId: null, resourceId: "c1" }],
      () => "Someone",
    );
    expect(groups[0]?.lines).toEqual(["A connected service needs attention"]);
  });

  it("the email names the vendor and the state, and links to the integrations page", () => {
    const r = renderInstant(services, ws, row(payload), "Someone");
    expect(r.subject).toBe("QuickBooks needs to be reconnected");
    expect(r.paragraphs[0]).toContain(
      "The QuickBooks connection of Acme <& Co> needs to be reconnected",
    );
    expect(r.cta?.url).toBe("https://acme.example.test/admin/integrations");
    const d = renderInstant(services, ws, row({ ...payload, status: "degraded" }), "Someone");
    expect(d.subject).toBe("The QuickBooks connection keeps failing");
  });

  it("the channel post is a vendor and a state, nothing else", () => {
    const msg = renderChannelMessage(
      services,
      ws,
      { eventType: "integration.connection_unhealthy", payload, actorMembershipId: null },
      "Ada Lovelace",
    );
    expect(msg.text).toBe(
      "The QuickBooks connection of Acme <& Co> needs to be reconnected: the service no longer accepts its authorisation.",
    );
    expect(JSON.stringify(msg)).not.toContain("Ada");
    expect(msg.link?.url).toBe("https://acme.example.test/admin/integrations");
  });

  it("renders a Slack app post as escaped mrkdwn with the link inline", () => {
    expect(
      slackAppText({
        text: "Hot lead in Acme <& Co>",
        link: { url: "https://acme.example.test/admin/x", label: "See <them>" },
      }),
    ).toBe(
      "Hot lead in Acme &lt;&amp; Co&gt; <https://acme.example.test/admin/x|See &lt;them&gt;>",
    );
    expect(slackAppText({ text: "plain" })).toBe("plain");
  });

  it("maps the integrations port's refusals onto permanent and transient channel failures", () => {
    expect(fromSlackApp({ ok: true, value: undefined })).toEqual({ ok: true });
    expect(fromSlackApp({ ok: false, reason: "not_connected" })).toMatchObject({
      reason: "not_connected",
      permanent: "not_connected",
    });
    for (const reason of ["unauthorized", "forbidden"] as const) {
      expect(fromSlackApp({ ok: false, reason })).toMatchObject({
        reason: "rejected",
        permanent: "rejected",
      });
    }
    expect(fromSlackApp({ ok: false, reason: "not_found", detail: "channel_not_found" })).toEqual({
      ok: false,
      reason: "not_found",
      permanent: "not_found",
      detail: "channel_not_found",
    });
    expect(fromSlackApp({ ok: false, reason: "rate_limited" })).toMatchObject({ permanent: null });
    for (const reason of ["transport", "malformed", "unavailable", "too_large"] as const) {
      expect(fromSlackApp({ ok: false, reason })).toMatchObject({
        reason: "unavailable",
        permanent: null,
      });
    }
  });

  it("splits the create body by kind and refuses a field of the other kind", () => {
    const eventTypes = ["analytics.hot_lead"] as const;
    expect(channelInputOf({ name: "Deals", url: "https://h/x", eventTypes })).toEqual({
      kind: "slack",
      name: "Deals",
      url: "https://h/x",
      eventTypes,
    });
    expect(channelInputOf({ kind: "slack_app", slackChannelId: "C1", eventTypes })).toEqual({
      kind: "slack_app",
      slackChannelId: "C1",
      eventTypes,
    });
    const field = (body: Parameters<typeof channelInputOf>[0]) => {
      try {
        channelInputOf(body);
        return "accepted";
      } catch (e) {
        return String((e as { details?: { field?: string } }).details?.field);
      }
    };
    expect(field({ kind: "slack_app", eventTypes })).toBe("slackChannelId");
    expect(field({ kind: "slack_app", slackChannelId: "C1", url: "u", eventTypes })).toBe("url");
    expect(field({ name: "x", url: "u", slackChannelId: "C1", eventTypes })).toBe("slackChannelId");
    expect(field({ name: "x", eventTypes })).toBe("url");
    expect(field({ url: "u", eventTypes })).toBe("name");
  });
});

describe("E3.7 accreditation verification (the investor's own alerts)", () => {
  const services = {
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.test"),
  } as unknown as ModuleServices;
  const ws = { id: "w", slug: "acme", name: "Acme", primaryHost: null };
  const row = (eventType: string, payload: Record<string, unknown>) =>
    ({
      eventType,
      membershipId: "m1",
      actorMembershipId: null,
      resourceKind: "verification",
      resourceId: "v1",
      payload,
    }) as unknown as Notification;
  const types = ["round.verification_expiring", "round.verification_decided"] as const;

  it("both are instant sentences, never channel or workspace events, bucketed per fact", () => {
    const at = new Date("2026-09-26T10:00:00Z");
    for (const t of types) {
      expect(isNotifyEventType(t)).toBe(true);
      expect(effectiveCadence(t, undefined)).toBe("instant");
      expect(isChannelEventType(t)).toBe(false);
      expect(isWorkspaceEventType(t)).toBe(false);
      expect(isSentenceEventType(t)).toBe(true);
      expect(instantSubject("Ada", t)).toBe(VERB[t]);
    }
    expect(bucketFor("round.verification_expiring", at, "v1")).toBe("v1");
    expect(bucketFor("round.verification_decided", at, "v1:expired")).toBe("v1:expired");
    // No name in a digest line either: the sentence stands alone.
    const groups = groupForDigest(
      types.map((eventType) => ({ eventType, actorMembershipId: null, resourceId: "v1" })),
      () => "Ada Lovelace",
    );
    expect(groups.flatMap((g) => g.lines).join(" ")).not.toContain("Ada");
  });

  it.each([
    ["verified", "Your accreditation verification is complete", "is complete", "View your round"],
    [
      "rejected",
      "Your accreditation verification could not be completed",
      "could not be completed",
      "View your round",
    ],
    [
      "expired",
      "Your accreditation verification has expired",
      "has expired",
      "Renew your verification",
    ],
  ])(
    "decided %s: neutral second-person copy linking the portal round page",
    (status, subject, what, label) => {
      const r = renderInstant(
        services,
        ws,
        row("round.verification_decided", { verificationId: "v1", status }),
        "Someone",
      );
      expect(r.subject).toBe(subject);
      expect(r.title).toBe(subject);
      expect(r.paragraphs[0]).toContain(`Your accreditation verification with Acme ${what}.`);
      expect(r.cta).toEqual({ label, url: "https://acme.example.test/round" });
      expect(JSON.stringify(r)).not.toMatch(/\/admin\/|\$|amount|Someone/u);
    },
  );

  it("an expiry reminder says soon and asks to renew in the portal", () => {
    const r = renderInstant(
      services,
      ws,
      row("round.verification_expiring", { verificationId: "v1" }),
      "Someone",
    );
    expect(r.subject).toBe("Your accreditation verification expires soon");
    expect(r.paragraphs[0]).toContain("Your accreditation verification with Acme expires soon.");
    expect(r.cta).toEqual({
      label: "Renew your verification",
      url: "https://acme.example.test/round",
    });
    expect(JSON.stringify(r)).not.toContain("/admin/");
  });

  it("an unknown status falls back to a generic sentence, still to the portal", () => {
    const r = renderInstant(
      services,
      ws,
      row("round.verification_decided", { verificationId: "v1", status: "pending" }),
      "Someone",
    );
    expect(r.subject).toBe(VERB["round.verification_decided"]);
    expect(r.cta?.url).toBe("https://acme.example.test/round");
  });
});
