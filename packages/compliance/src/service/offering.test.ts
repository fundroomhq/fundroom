import { OFFERING_STATUSES } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { bodyDigest, parseStamp, stamp } from "./documents.js";
import { isIrrevocableFrom, permits } from "./offering.js";

describe("permits", () => {
  it("answers for every status the enum has, so a new one cannot be forgotten", () => {
    const all = permits();
    expect(all.map((p) => p.status)).toEqual([...OFFERING_STATUSES]);
  });

  it("keeps round and terms off until securities are actually being offered", () => {
    expect(permits("none").roundAndTerms).toBe(false);
    expect(permits("informational").roundAndTerms).toBe(false);
    expect(permits("506b").roundAndTerms).toBe(true);
    expect(permits("506c").roundAndTerms).toBe(true);
  });

  it("requires accreditation only under 506(c)", () => {
    for (const p of permits()) {
      expect(p.accreditationRequired, p.status).toBe(p.status === "506c");
    }
  });

  it("never auto-approves an access request under 506(b), and allows it everywhere else (E3.1)", () => {
    for (const p of permits()) {
      expect(p.requestAutoApprove, p.status).toBe(p.status !== "506b");
    }
  });

  it("allows no public surface at all under `none`", () => {
    const p = permits("none");
    expect(p.publicSections).toBe(false);
    expect(p.shareLinks).toBe(false);
  });

  it("keeps share links off while the workspace is informational only", () => {
    expect(permits("informational").shareLinks).toBe(false);
  });

  it("explains every status in plain English", () => {
    for (const p of permits()) {
      expect(p.explanation.length, p.status).toBeGreaterThan(40);
      expect(p.explanation.endsWith("."), p.status).toBe(true);
    }
  });
});

describe("isIrrevocableFrom", () => {
  it("treats 506(c), and only 506(c), as a one-way door", () => {
    for (const status of OFFERING_STATUSES) {
      expect(isIrrevocableFrom(status), status).toBe(status === "506c");
    }
  });
});

describe("the `<slug>:v<n>` stamp", () => {
  it("formats a slug and a version the way an auditor reads it", () => {
    expect(stamp("privacy-notice", 1)).toBe("privacy-notice:v1");
    expect(stamp("nda", 12)).toBe("nda:v12");
  });

  it("round-trips through parseStamp", () => {
    expect(parseStamp(stamp("offering-legends", 3))).toEqual({
      slug: "offering-legends",
      versionNo: 3,
    });
  });

  it("rejects anything that is not a stamp, so a bare attestation kind is not misread", () => {
    expect(parseStamp("nda")).toBeUndefined();
    expect(parseStamp("accredited")).toBeUndefined();
    expect(parseStamp("privacy-notice:v")).toBeUndefined();
    expect(parseStamp("Privacy-Notice:v1")).toBeUndefined();
    expect(parseStamp("privacy-notice:v1:v2")).toBeUndefined();
  });
});

describe("bodyDigest", () => {
  it("is the sha256 of the body, in both the shapes the row needs", () => {
    const { hex, bytes } = bodyDigest("hello");
    expect(bytes).toHaveLength(32);
    expect(hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("changes when a single character of the body changes", () => {
    expect(bodyDigest("a").hex).not.toBe(bodyDigest("b").hex);
  });
});
