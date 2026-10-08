import { describe, expect, it } from "vitest";
import { CHALLENGE_LABEL, expectedRecords, LEGACY_CHALLENGE_LABEL } from "./records.js";

describe("expectedRecords", () => {
  const records = expectedRecords({
    hostname: "investors.acme.com",
    token: "abcdefghijklmnopqrstuvwxyz234567",
    cnameTarget: "edge.fundroom.app",
  });

  it("derives a CNAME at the hostname pointing at the edge", () => {
    expect(records[0]).toEqual({
      type: "CNAME",
      name: "investors.acme.com",
      value: "edge.fundroom.app",
      required: true,
    });
  });

  it("derives the challenge TXT under the _fundroom-challenge label", () => {
    expect(records[1]).toEqual({
      type: "TXT",
      name: "_fundroom-challenge.investors.acme.com",
      value: "abcdefghijklmnopqrstuvwxyz234567",
      required: true,
    });
  });

  it("uses the renamed label, and keeps the pre-rename one only as a lookup fallback", () => {
    expect(CHALLENGE_LABEL).toBe("_fundroom-challenge");
    expect(LEGACY_CHALLENGE_LABEL).toBe("_seedhost-challenge");
  });

  it("never shows the pre-rename label in the instructions (A-2)", () => {
    expect(JSON.stringify(records)).not.toContain(LEGACY_CHALLENGE_LABEL);
  });

  it("marks both records required — the CNAME alone is not proof of control", () => {
    expect(records.every((r) => r.required)).toBe(true);
    expect(records).toHaveLength(2);
  });
});
