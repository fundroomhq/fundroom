import { describe, expect, it } from "vitest";
import { type Audience, audienceIncludes, type Reader } from "../model.js";
import { hydrationKey, ineligibleReason } from "./delivery.js";

/*
 * An update addressed to every member is "updates" content. A `data_room`
 * delegate is not in that audience — not on the web (the TypeScript twin of
 * `updates.audience_includes_current`) and not on the send path — while an `updates` or `all`
 * delegate is. A delegate's own groups still count whatever its scope.
 */
const ALL: Audience = { kind: "all" };
const BOARD: Audience = { kind: "groups", groupIds: ["board"] };
const reader = (delegateScope: Reader["delegateScope"], ...groupIds: string[]): Reader => ({
  kind: "external",
  groupIds,
  delegateScope,
});
const at = new Date("2026-09-25T10:00:00Z");
const member = (role: string, delegateScope: string | null) => ({
  kind: "external",
  status: "active",
  expiresAt: null,
  role,
  delegateScope,
});

describe("delegate audiences (F3)", () => {
  it("web: `all` updates reach investors and `all`/`updates` delegates, not `data_room` ones", () => {
    expect(audienceIncludes(ALL, reader(null))).toBe(true);
    expect(audienceIncludes(ALL, reader("all"))).toBe(true);
    expect(audienceIncludes(ALL, reader("updates"))).toBe(true);
    expect(audienceIncludes(ALL, reader("data_room"))).toBe(false);
    // Not even through its own group (round 2: a delegate reads nothing its scope does not admit).
    expect(audienceIncludes(BOARD, reader("data_room", "board"))).toBe(false);
    expect(audienceIncludes(BOARD, reader("updates", "board"))).toBe(true);
  });

  it("send path: a `data_room` delegate is skipped as out of the audience", () => {
    expect(ineligibleReason(member("investor", null), ALL, [], at)).toBeUndefined();
    expect(ineligibleReason(member("delegate", "updates"), ALL, [], at)).toBeUndefined();
    expect(ineligibleReason(member("delegate", "data_room"), ALL, [], at)).toBe(
      "no longer in the audience",
    );
    expect(ineligibleReason(member("delegate", "data_room"), BOARD, ["board"], at)).toBe(
      "no longer in the audience",
    );
  });

  it("keys a delegate's hydration apart from an investor's in the same groups", () => {
    expect(hydrationKey(reader("updates"))).not.toBe(hydrationKey(reader(null)));
    expect(hydrationKey(reader(null, "b", "a"))).toBe(hydrationKey(reader(undefined, "a", "b")));
  });
});
