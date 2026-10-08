import { describe, expect, it } from "vitest";
import { audienceCovers, type PendingInput, pendingStamps } from "./acceptances.js";

describe("audienceCovers", () => {
  it("gates everybody on an `all` document", () => {
    expect(audienceCovers("all", "staff")).toBe(true);
    expect(audienceCovers("all", "external")).toBe(true);
  });

  it("gates only investors on an `external` document", () => {
    expect(audienceCovers("external", "external")).toBe(true);
    expect(audienceCovers("external", "staff")).toBe(false);
  });

  it("never puts a staff-only document in front of an investor", () => {
    expect(audienceCovers("staff", "external")).toBe(false);
    expect(audienceCovers("staff", "staff")).toBe(true);
  });
});

const NOW = new Date("2026-09-14T10:30:00.000Z");
const DOC_ID = "01920000-0000-7000-8000-0000000000d0";

function nda(versionNo: number): PendingInput["documents"][number] {
  return {
    id: DOC_ID,
    slug: "nda",
    title: "Mutual NDA",
    kind: "nda",
    audience: "all",
    current: {
      versionNo,
      body: `# NDA v${versionNo}`,
      bodySha256: "ab".repeat(32),
      effectiveAt: NOW,
    },
  };
}

describe("pendingStamps", () => {
  it("gates a member who has accepted nothing", () => {
    const out = pendingStamps({
      documents: [nda(1)],
      membershipKind: "external",
      held: [],
      now: NOW,
    });
    expect(out.map((p) => p.stamp)).toEqual(["nda:v1"]);
  });

  it("lets a member through once they hold the current stamp", () => {
    const out = pendingStamps({
      documents: [nda(1)],
      membershipKind: "external",
      held: [{ kind: "nda:v1", expiresAt: null, revokedAt: null }],
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("puts a prior acceptor back in front of the gate when a new version is published", () => {
    // This is "re-acceptance on version change", and it needs no machinery: the version lives in
    // the stamp, so holding `nda:v1` is simply not holding `nda:v2`.
    const out = pendingStamps({
      documents: [nda(2)],
      membershipKind: "external",
      held: [{ kind: "nda:v1", expiresAt: null, revokedAt: null }],
      now: NOW,
    });
    expect(out.map((p) => p.stamp)).toEqual(["nda:v2"]);
    expect(out[0]?.versionNo).toBe(2);
  });

  it("gates nothing for a document that has never been published: there is no text to agree to", () => {
    const out = pendingStamps({
      documents: [{ ...nda(1), current: undefined }],
      membershipKind: "external",
      held: [],
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("never puts a staff-only document in front of an investor", () => {
    const out = pendingStamps({
      documents: [{ ...nda(1), audience: "staff" }],
      membershipKind: "external",
      held: [],
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("ignores a revoked acceptance, so revoking one re-gates the member", () => {
    const out = pendingStamps({
      documents: [nda(1)],
      membershipKind: "external",
      held: [{ kind: "nda:v1", expiresAt: null, revokedAt: NOW }],
      now: NOW,
    });
    expect(out.map((p) => p.stamp)).toEqual(["nda:v1"]);
  });

  it("ignores an expired acceptance — the accreditation case, where the row lapses at 12 months", () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const out = pendingStamps({
      documents: [{ ...nda(1), slug: "accreditation", kind: "accreditation" }],
      membershipKind: "external",
      held: [{ kind: "accreditation:v1", expiresAt: yesterday, revokedAt: null }],
      now: NOW,
    });
    expect(out.map((p) => p.stamp)).toEqual(["accreditation:v1"]);
  });

  it("carries the body and its digest, so the bytes shown are the bytes the acceptance names", () => {
    const out = pendingStamps({
      documents: [nda(3)],
      membershipKind: "external",
      held: [],
      now: NOW,
    });
    expect(out[0]?.body).toBe("# NDA v3");
    expect(out[0]?.bodySha256).toBe("ab".repeat(32));
  });
});
