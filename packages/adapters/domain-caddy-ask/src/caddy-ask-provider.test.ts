import { describe, expect, it } from "vitest";
import { createCaddyAskProvider } from "./caddy-ask-provider.js";

const provider = createCaddyAskProvider({ cnameTarget: "edge.fundroom.app" });
const input = { hostname: "investors.acme.com", token: "tok3n" };

describe("createCaddyAskProvider", () => {
  it("self-identifies as caddy-ask", () => {
    expect(provider.driver).toBe("caddy-ask");
  });

  it("activate and deactivate resolve without doing anything", async () => {
    await expect(provider.activate("investors.acme.com")).resolves.toBeUndefined();
    await expect(provider.deactivate("investors.acme.com")).resolves.toBeUndefined();
  });

  it("derives the CNAME and the challenge TXT from the configured target", () => {
    expect(provider.instructions(input)).toEqual([
      {
        type: "CNAME",
        name: "investors.acme.com",
        value: "edge.fundroom.app",
        required: true,
      },
      {
        type: "TXT",
        name: "_fundroom-challenge.investors.acme.com",
        value: "tok3n",
        required: true,
      },
    ]);
  });

  it("requires both records, because it is the one issuing the certificate", () => {
    // The CNAME proves the handshake reaches us; the TXT proves whoever published it controls
    // the name. Dropping either would issue a certificate for a hostname somebody else owns.
    expect(provider.requires).toEqual({ cname: true, txt: true });
  });

  it("marks every record it checks `required`", () => {
    for (const record of provider.instructions(input)) expect(record.required).toBe(true);
  });

  it("refuses an empty CNAME target instead of becoming unverifiable", () => {
    // `cnameOk` is false for every answer when the target is empty, so this configuration means
    // "no domain on this install can ever verify" — a startup error is the only honest outcome.
    expect(() => createCaddyAskProvider({ cnameTarget: "" })).toThrow(
      /CUSTOM_DOMAIN_CNAME_TARGET/u,
    );
    expect(() => createCaddyAskProvider({ cnameTarget: "   " })).toThrow(/needs a CNAME target/u);
  });

  it("follows the configured target rather than storing one", () => {
    const moved = createCaddyAskProvider({ cnameTarget: "edge2.fundroom.app" });
    expect(moved.instructions(input)[0]?.value).toBe("edge2.fundroom.app");
  });
});
