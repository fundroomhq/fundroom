import { describe, expect, it } from "vitest";
import { createManualAccreditationProvider } from "./manual-provider.js";

const start = {
  workspaceId: "01920000-0000-7000-8000-000000000001",
  membershipId: "01920000-0000-7000-8000-000000000002",
  verificationId: "01920000-0000-7000-8000-000000000003",
  subject: "individual" as const,
};

describe("createManualAccreditationProvider", () => {
  it("self-identifies as manual", () => {
    expect(createManualAccreditationProvider().driver).toBe("manual");
  });

  it("declares that it needs an upload and a human", () => {
    // The two facts the round module arranges the flow around: offer the investor an upload,
    // and park the row in a staff queue. A driver that could decide on its own sets both false.
    expect(createManualAccreditationProvider().requires).toEqual({
      evidenceUpload: true,
      adminDecision: true,
    });
  });

  it("never claims a verification: start and check both answer pending", async () => {
    const provider = createManualAccreditationProvider();
    // Rule 506(c) asks the *issuer* for reasonable steps. An adapter answering `verified` here
    // would be making that assertion on their behalf, which is the one thing it must not do.
    expect(await provider.start(start)).toEqual({ status: "pending" });
    expect(await provider.start({ ...start, subject: "entity", jurisdiction: "US" })).toEqual({
      status: "pending",
    });
    expect(await provider.check({ providerRef: "anything" })).toEqual({ status: "pending" });
  });

  it("answers rather than throws, for every input a caller can reach it with", async () => {
    const provider = createManualAccreditationProvider();
    await expect(provider.check({ providerRef: "" })).resolves.toMatchObject({
      status: "pending",
    });
    await expect(provider.start({ ...start, jurisdiction: "" })).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("warns once per process that verifications wait for a person", async () => {
    const events: string[] = [];
    const provider = createManualAccreditationProvider({ log: (e) => events.push(e) });
    await provider.start(start);
    await provider.start(start);
    await provider.check({ providerRef: "x" });
    // A staff queue is a configuration, not an incident: one line, not one per investor.
    expect(events).toEqual(["accreditation.manual"]);
  });

  it("hands every caller its own answer, not a shared mutable one", async () => {
    const provider = createManualAccreditationProvider();
    const first = await provider.start(start);
    expect(() => {
      (first as { status: string }).status = "verified";
    }).toThrow();
    expect(await provider.check({ providerRef: "x" })).toEqual({ status: "pending" });
  });
});
