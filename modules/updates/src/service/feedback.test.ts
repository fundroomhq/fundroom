import { describe, expect, it } from "vitest";
import type { RecipientStatus } from "../schema/updates.js";
import { bounceError, isDeliveryFact, nextRecipientStatus, notesSoftBounce } from "./feedback.js";

describe("the recipient feedback ladder", () => {
  it("moves a sent row up to delivered, bounced or complained", () => {
    expect(nextRecipientStatus("sent", "delivered")).toBe("delivered");
    expect(nextRecipientStatus("sent", "bounce", "hard")).toBe("bounced");
    expect(nextRecipientStatus("sent", "complaint")).toBe("complained");
    expect(nextRecipientStatus("delivered", "bounce", "hard")).toBe("bounced");
    expect(nextRecipientStatus("delivered", "complaint")).toBe("complained");
    expect(nextRecipientStatus("bounced", "complaint")).toBe("complained");
  });

  it("never downgrades: a late `delivered` does not resurrect a bounce or a complaint", () => {
    expect(nextRecipientStatus("bounced", "delivered")).toBeUndefined();
    expect(nextRecipientStatus("complained", "delivered")).toBeUndefined();
    expect(nextRecipientStatus("complained", "bounce")).toBeUndefined();
  });

  it("is idempotent: the same event twice moves the row once", () => {
    expect(nextRecipientStatus("delivered", "delivered")).toBeUndefined();
    expect(nextRecipientStatus("bounced", "bounce", "hard")).toBeUndefined();
    expect(nextRecipientStatus("complained", "complaint")).toBeUndefined();
  });

  it("ignores opens, clicks and delays entirely", () => {
    for (const status of ["sent", "delivered", "bounced"] as const) {
      expect(nextRecipientStatus(status, "open")).toBeUndefined();
      expect(nextRecipientStatus(status, "click")).toBeUndefined();
      expect(nextRecipientStatus(status, "delay")).toBeUndefined();
    }
    expect(isDeliveryFact("open")).toBe(false);
    expect(isDeliveryFact("click")).toBe(false);
    expect(isDeliveryFact("delay")).toBe(true);
  });

  it("only a hard bounce is terminal: a soft (or untyped) one is noted, not climbed", () => {
    for (const status of ["sent", "delivered"] as const) {
      expect(nextRecipientStatus(status, "bounce", "soft")).toBeUndefined();
      expect(nextRecipientStatus(status, "bounce", null)).toBeUndefined();
      expect(notesSoftBounce(status, "bounce", "soft")).toBe(true);
      expect(notesSoftBounce(status, "bounce", "hard")).toBe(false);
    }
    // A stronger fact keeps its error.
    expect(notesSoftBounce("bounced", "bounce", "soft")).toBe(false);
    expect(notesSoftBounce("complained", "bounce", "soft")).toBe(false);
    expect(notesSoftBounce("sent", "delay", null)).toBe(false);
  });

  it("never moves a row the provider was never handed", () => {
    for (const status of ["queued", "failed", "skipped"] as RecipientStatus[]) {
      for (const kind of ["delivered", "bounce", "complaint"] as const) {
        expect(nextRecipientStatus(status, kind, "hard"), `${status}/${kind}`).toBeUndefined();
      }
    }
  });

  it("stores the bounce kind, never the provider's text", () => {
    expect(bounceError("hard")).toBe("bounce:hard");
    expect(bounceError("soft")).toBe("bounce:soft");
    expect(bounceError(null)).toBe("bounce");
  });
});
