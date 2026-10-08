import { describe, expect, it } from "vitest";
import { createManualProvider, MANUAL_TLS_NOTICE } from "./manual-provider.js";

const input = { hostname: "investors.acme.com", token: "tok3n" };

describe("createManualProvider", () => {
  it("self-identifies as manual", () => {
    expect(createManualProvider().driver).toBe("manual");
  });

  it("requires the TXT challenge and nothing else", () => {
    // The whole point of the driver: we verify *control of the name*, the operator owns
    // routing. Requiring a CNAME here would fail a founder on a record nobody asked for, and
    // with no target configured (the default) would make the domain unverifiable forever.
    expect(createManualProvider().requires).toEqual({ cname: false, txt: true });
    expect(createManualProvider({ cnameTarget: "proxy.acme.internal" }).requires).toEqual({
      cname: false,
      txt: true,
    });
  });

  it("marks exactly the records verification checks as required", () => {
    const records = createManualProvider({ cnameTarget: "proxy.acme.internal" }).instructions(
      input,
    );
    const required = records.filter((r) => r.required).map((r) => r.type);
    // TXT is checked, so it is required; the CNAME is not checked, so it must not claim to be.
    expect(required).toEqual(["TXT"]);
  });

  it("activate and deactivate resolve without doing anything", async () => {
    const provider = createManualProvider();
    await expect(provider.activate("investors.acme.com")).resolves.toBeUndefined();
    await expect(provider.deactivate("investors.acme.com")).resolves.toBeUndefined();
  });

  it("asks only for the ownership TXT when no edge host is configured", () => {
    expect(createManualProvider().instructions(input)).toEqual([
      {
        type: "TXT",
        name: "_fundroom-challenge.investors.acme.com",
        value: "tok3n",
        required: true,
      },
    ]);
  });

  it("adds an advisory CNAME when the operator names their edge", () => {
    const records = createManualProvider({ cnameTarget: "proxy.acme.internal" }).instructions(
      input,
    );
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({
      type: "CNAME",
      name: "investors.acme.com",
      value: "proxy.acme.internal",
      required: false,
    });
  });

  it("treats an empty edge host as none", () => {
    expect(createManualProvider({ cnameTarget: "" }).instructions(input)).toHaveLength(1);
  });

  it("says out loud that the operator terminates TLS and owns the routing", () => {
    expect(MANUAL_TLS_NOTICE).toMatch(/verifies domain ownership only/u);
    expect(MANUAL_TLS_NOTICE).toMatch(/will not request one/u);
    // `DnsInstruction` has no field for a note, so the advisory CNAME is explained here.
    expect(MANUAL_TLS_NOTICE).toMatch(/guidance, not a requirement/u);
  });
});
