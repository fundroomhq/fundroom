import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_SOURCE_LABELS,
  RELATIONSHIP_SOURCES,
  type RelationshipWarningInput,
  relationshipWarning,
} from "./relationship.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-12T12:00:00Z");

function input(patch: Partial<RelationshipWarningInput> = {}): RelationshipWarningInput {
  return {
    offeringStatus: "506b",
    membershipCreatedAt: NOW,
    relationshipEstablishedAt: new Date(NOW.getTime() - 200 * DAY),
    relationshipSource: "founder_invite",
    firstExposureAt: null,
    warningDays: 30,
    ...patch,
  };
}

describe("relationshipWarning", () => {
  it("says nothing when the relationship is old, sourced and documented", () => {
    expect(relationshipWarning(input())).toBeUndefined();
  });

  it("only fires under 506(b)", () => {
    for (const status of ["none", "informational", "506c", "non_us"] as const) {
      expect(
        relationshipWarning(
          input({
            offeringStatus: status,
            relationshipSource: null,
            relationshipEstablishedAt: null,
          }),
        ),
        status,
      ).toBeUndefined();
    }
  });

  it("warns with `no_source` for a missing source", () => {
    expect(relationshipWarning(input({ relationshipSource: null }))?.code).toBe("no_source");
    expect(relationshipWarning(input({ relationshipSource: "" }))?.code).toBe("no_source");
    expect(relationshipWarning(input({ relationshipSource: "   " }))?.code).toBe("no_source");
  });

  it("warns with `no_date` when the source is there but the date is not", () => {
    expect(relationshipWarning(input({ relationshipEstablishedAt: null }))?.code).toBe("no_date");
    expect(relationshipWarning(input({ relationshipEstablishedAt: undefined }))?.code).toBe(
      "no_date",
    );
  });

  it("warns with `access_too_soon` when access came inside the window", () => {
    const warning = relationshipWarning(
      input({ relationshipEstablishedAt: new Date(NOW.getTime() - 5 * DAY) }),
    );
    expect(warning?.code).toBe("access_too_soon");
    expect(warning?.message).toContain("30 days");
  });

  it("stays quiet exactly at the window boundary", () => {
    expect(
      relationshipWarning(input({ relationshipEstablishedAt: new Date(NOW.getTime() - 30 * DAY) })),
    ).toBeUndefined();
    expect(
      relationshipWarning(
        input({ relationshipEstablishedAt: new Date(NOW.getTime() - 30 * DAY + 1) }),
      )?.code,
    ).toBe("access_too_soon");
  });

  it("can be switched off with warningDays = 0", () => {
    expect(
      relationshipWarning(
        input({ relationshipEstablishedAt: new Date(NOW.getTime() - 1000), warningDays: 0 }),
      ),
    ).toBeUndefined();
  });

  it("warns with `exposure_before_relationship` when material went out first", () => {
    const established = new Date(NOW.getTime() - 200 * DAY);
    expect(
      relationshipWarning(
        input({
          relationshipEstablishedAt: established,
          firstExposureAt: new Date(established.getTime() - 1),
        }),
      )?.code,
    ).toBe("exposure_before_relationship");
  });

  it("does not warn when exposure is exactly on the relationship date", () => {
    const established = new Date(NOW.getTime() - 200 * DAY);
    expect(
      relationshipWarning(
        input({ relationshipEstablishedAt: established, firstExposureAt: established }),
      ),
    ).toBeUndefined();
  });

  it("reports the worst problem first, so an admin has one thing to fix", () => {
    // Everything is wrong at once; the missing source is the one with no story behind it.
    expect(
      relationshipWarning(
        input({
          relationshipSource: null,
          relationshipEstablishedAt: null,
          firstExposureAt: new Date(NOW.getTime() - 500 * DAY),
        }),
      )?.code,
    ).toBe("no_source");
  });

  it("prefers the ordering problem over the thin-window one", () => {
    const established = new Date(NOW.getTime() - 5 * DAY);
    expect(
      relationshipWarning(
        input({
          relationshipEstablishedAt: established,
          firstExposureAt: new Date(established.getTime() - DAY),
        }),
      )?.code,
    ).toBe("exposure_before_relationship");
  });

  it("never returns a warning with no message", () => {
    const warning = relationshipWarning(input({ relationshipSource: null }));
    expect(warning?.message.length).toBeGreaterThan(20);
  });
});

describe("relationship sources", () => {
  it("enumerates the sources design/04 §1.6 lists", () => {
    expect([...RELATIONSHIP_SOURCES]).toEqual([
      "founder_invite",
      "intro",
      "prior_investor",
      "event",
      "other",
    ]);
  });

  it("labels every source for the admin UI", () => {
    for (const source of RELATIONSHIP_SOURCES) {
      expect(RELATIONSHIP_SOURCE_LABELS[source].length).toBeGreaterThan(0);
    }
  });
});
