import { describe, expect, it } from "vitest";
import {
  createSubscriptionRegistry,
  eventJobIdempotencyKey,
  eventQueueName,
} from "./subscriptions.js";

describe("subscription registry", () => {
  it("registers subscribers per topic and lists topics", () => {
    const reg = createSubscriptionRegistry();
    const h = async () => {};
    reg.subscribe("membership.revoked", "data-room.purge-renditions", h);
    reg.subscribe("membership.revoked", "analytics.close-sessions", h);
    reg.subscribe("document.viewed", "analytics.record-view", h);
    expect(reg.topics()).toEqual(["membership.revoked", "document.viewed"]);
    expect(reg.subscribersFor("membership.revoked").map((s) => s.id)).toEqual([
      "data-room.purge-renditions",
      "analytics.close-sessions",
    ]);
    expect(reg.subscribersFor("acl.changed")).toEqual([]);
    expect(reg.get("document.viewed", "analytics.record-view")?.handler).toBe(h);
    expect(reg.get("document.viewed", "nope.nope")).toBeUndefined();
  });

  it("rejects unknown topics, malformed ids and duplicates", () => {
    const reg = createSubscriptionRegistry();
    const h = async () => {};
    expect(() => reg.subscribe("nope.nope" as never, "a.b", h)).toThrow(/unknown event topic/u);
    expect(() => reg.subscribe("acl.changed", "NoDots", h)).toThrow(/must match/u);
    reg.subscribe("acl.changed", "access.rebuild", h);
    expect(() => reg.subscribe("acl.changed", "access.rebuild", h)).toThrow(/already registered/u);
  });

  it("derives queue names and idempotency keys", () => {
    expect(eventQueueName("document.viewed")).toBe("event.document.viewed");
    expect(eventJobIdempotencyKey(42, "analytics.record-view")).toBe(
      "outbox:42:analytics.record-view",
    );
  });
});
