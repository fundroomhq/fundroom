import { describe, expect, it } from "vitest";
import { createAccreditationProvider, createDomainProvider } from "./container.js";

/*
 * Composition-root decisions that are only wrong in one configuration, and so are never noticed
 * by hand. `createDomainProvider` is exported for exactly that reason.
 */

const CANONICAL = "portal.fundroom.app";
const input = { hostname: "investors.acme.com", token: "tok3ntok3ntok3ntok3ntok3ntok3n12" };

describe("createDomainProvider", () => {
  it("gives `manual` no CNAME row when the operator configured no target (E2.1 M12)", () => {
    /*
     * `CUSTOM_DOMAIN_CNAME_TARGET` defaults to the canonical host, and passing that default
     * through made `createManualProvider`'s `target === ""` branch unreachable: every `manual`
     * install showed a CNAME row pointing at FundRoom's own hostname — on a driver where
     * FundRoom issues no certificate and the customer's DNS usually already points at the
     * operator's own proxy. That is the "tell the founder to break a working setup" outcome the
     * adapter omits the row to avoid.
     */
    const provider = createDomainProvider(
      { CUSTOM_DOMAIN_DRIVER: "manual", CUSTOM_DOMAIN_CNAME_TARGET: undefined },
      CANONICAL,
    );
    expect(provider.driver).toBe("manual");
    expect(provider.instructions(input).map((r) => r.type)).toEqual(["TXT"]);
    expect(provider.requires).toEqual({ cname: false, txt: true });
  });

  it("gives `manual` an advisory CNAME row when the operator did name their edge", () => {
    const provider = createDomainProvider(
      { CUSTOM_DOMAIN_DRIVER: "manual", CUSTOM_DOMAIN_CNAME_TARGET: "edge.acme.com" },
      CANONICAL,
    );
    const records = provider.instructions(input);
    expect(records.map((r) => r.type)).toEqual(["TXT", "CNAME"]);
    // Advisory, and truthfully so: `requires.cname` is false, so the verdict never reads it.
    expect(records.find((r) => r.type === "CNAME")).toMatchObject({
      value: "edge.acme.com",
      required: false,
    });
  });

  it("gives `caddy-ask` the resolved target, default included: it *is* the edge", () => {
    const provider = createDomainProvider(
      { CUSTOM_DOMAIN_DRIVER: "caddy-ask", CUSTOM_DOMAIN_CNAME_TARGET: undefined },
      CANONICAL,
    );
    expect(provider.driver).toBe("caddy-ask");
    expect(provider.instructions(input)[0]).toMatchObject({
      type: "CNAME",
      value: CANONICAL,
      required: true,
    });
    expect(provider.requires).toEqual({ cname: true, txt: true });
  });
});

describe("createAccreditationProvider", () => {
  const log = () => {
    /* silent */
  };

  it("builds the manual verifier, which needs an upload and a human (E2.5 D6)", async () => {
    const provider = createAccreditationProvider({ ACCREDITATION_DRIVER: "manual" }, log);
    expect(provider.driver).toBe("manual");
    expect(provider.requires).toEqual({ evidenceUpload: true, adminDecision: true });
    await expect(
      provider.start({
        workspaceId: "01920000-0000-7000-8000-0000000000w0",
        membershipId: "01920000-0000-7000-8000-0000000000m1",
        verificationId: "01920000-0000-7000-8000-0000000000v1",
        subject: "individual",
      }),
    ).resolves.toEqual({ status: "pending" });
  });

  it("refuses a driver no adapter answers to, rather than falling back to manual", () => {
    /*
     * The interesting case is the *next* driver, not this one. An install that configured a
     * verification bureau and quietly got a staff queue would believe it was taking reasonable
     * steps under Rule 506(c) while taking none — and would find out at an audit. Config refuses
     * the unknown id first; this refuses it again rather than guessing.
     */
    expect(() =>
      createAccreditationProvider({ ACCREDITATION_DRIVER: "bureau" as unknown as "manual" }, log),
    ).toThrow(/bureau/u);
  });
});
