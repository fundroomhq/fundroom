import { describe, expect, it } from "vitest";
import {
  defineEvent,
  EVENT_CATALOGUE,
  EVENT_TOPIC_RE,
  EVENT_TOPICS,
  EventCatalogueError,
  isEventTopic,
  parseEventPayload,
} from "./catalogue.js";

const WS = "01920000-0000-7000-8000-000000000001";
const M1 = "01920000-0000-7000-8000-000000000002";

describe("event catalogue", () => {
  it("every topic is dotted and versioned", () => {
    for (const topic of EVENT_TOPICS) {
      expect(topic).toMatch(EVENT_TOPIC_RE);
      expect(EVENT_CATALOGUE[topic].schemaVersion).toBeGreaterThanOrEqual(1);
      expect(EVENT_CATALOGUE[topic].description.length).toBeGreaterThan(10);
    }
  });

  it("defineEvent validates and stamps the schema version", () => {
    const e = defineEvent("workspace.created", { workspaceId: WS, slug: "acme" });
    expect(e).toEqual({
      topic: "workspace.created",
      payload: { workspaceId: WS, slug: "acme" },
      schemaVersion: 1,
    });
  });

  it("rejects unknown fields (payloads are strict contracts)", () => {
    expect(() =>
      defineEvent("workspace.created", {
        workspaceId: WS,
        slug: "acme",
        email: "x@y",
      } as never),
    ).toThrow(EventCatalogueError);
  });

  it("rejects invalid ids", () => {
    expect(() =>
      defineEvent("membership.revoked", {
        membershipIds: ["nope"],
        byMembershipId: null,
        reason: null,
      }),
    ).toThrow(/invalid payload/u);
  });

  it("the round topics carry ids only, and refuse amounts (E2.5)", () => {
    const roundId = "01920000-0000-7000-8000-00000000000a";
    const submissionId = "01920000-0000-7000-8000-00000000000b";
    for (const topic of [
      "round.opened",
      "round.closed",
      "round.terms_changed",
      "round.interest_submitted",
      "round.interest_decided",
      "round.commitment_created",
      "round.commitment_changed",
      "round.verification_requested",
      "round.verification_decided",
    ] as const) {
      expect(isEventTopic(topic)).toBe(true);
    }
    expect(
      defineEvent("round.interest_submitted", { submissionId, roundId, membershipId: M1 }).payload,
    ).toEqual({ submissionId, roundId, membershipId: M1 });
    // The figure an investor named is private to `round.commitment`, which is fenced and audited.
    // On the outbox it would outlive the row and be read by every subscriber written later.
    expect(() =>
      defineEvent("round.interest_submitted", {
        submissionId,
        roundId,
        membershipId: M1,
        amount: "250000",
      } as never),
    ).toThrow(EventCatalogueError);
    expect(() =>
      defineEvent("round.commitment_changed", {
        commitmentId: submissionId,
        roundId,
        status: "paid",
      } as never),
    ).toThrow(/invalid payload/u);
    // The optional subject ids are genuinely optional: a commitment may name nobody but a
    // display name, which carries no id at all.
    expect(
      defineEvent("round.commitment_created", { commitmentId: submissionId, roundId }).payload,
    ).toEqual({ commitmentId: submissionId, roundId });
  });

  it("the accreditation vendor topics carry ids and refs only (E3.7)", () => {
    const connectionId = "01920000-0000-7000-8000-00000000000c";
    const verificationId = "01920000-0000-7000-8000-00000000000d";
    expect(
      defineEvent("accreditation.provider_updated", {
        connectionId,
        driver: "verifyinvestor",
        refs: ["vr:123"],
      }).payload,
    ).toEqual({ connectionId, driver: "verifyinvestor", refs: ["vr:123"] });
    expect(() =>
      defineEvent("accreditation.provider_updated", {
        connectionId,
        driver: "manual",
        refs: [],
      } as never),
    ).toThrow(EventCatalogueError);
    expect(() =>
      defineEvent("accreditation.provider_updated", {
        connectionId,
        driver: "parallel-markets",
        refs: Array.from({ length: 21 }, (_, i) => `r${i}`),
      }),
    ).toThrow(EventCatalogueError);
    expect(() =>
      defineEvent("accreditation.provider_updated", {
        connectionId,
        driver: "parallel-markets",
        refs: ["x".repeat(201)],
      }),
    ).toThrow(EventCatalogueError);
    expect(
      defineEvent("round.verification_expiring", { verificationId, membershipId: M1 }).payload,
    ).toEqual({ verificationId, membershipId: M1 });
    expect(() =>
      defineEvent("round.verification_expiring", {
        verificationId,
        membershipId: M1,
        email: "x@y",
      } as never),
    ).toThrow(EventCatalogueError);
  });

  it("parseEventPayload refuses unreadable versions and unknown topics", () => {
    const payload = { membershipIds: [M1], byMembershipId: null, reason: "left" };
    expect(parseEventPayload("membership.revoked", payload, 1)).toEqual(payload);
    expect(() => parseEventPayload("membership.revoked", payload, 2)).toThrow(/version 2/u);
    expect(() => parseEventPayload("nope.nope" as never, {}, 1)).toThrow(/unknown topic/u);
    expect(isEventTopic("document.viewed")).toBe(true);
    expect(isEventTopic("constructor")).toBe(false);
  });
});
