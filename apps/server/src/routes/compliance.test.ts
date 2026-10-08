import { sha256Hex } from "@fundroom/audit";
import { isApiError } from "@fundroom/contracts";
import { describe, expect, it } from "vitest";
import { signerFacts } from "./compliance.js";

/*
 * The signer half of the certificate's facts (E2.3, contract §5.4, §10 G2).
 *
 * One operator's worth of behaviour, and it was a 500 on the first NDA for every share-link
 * visitor — the population the epic exists for. `MembershipRepo.namesFor` answers `""` for a
 * signer nobody has named, not `null`, so `?? null` let the empty string through to
 * `assertValidCertificateDocument`, which refuses it and rolls the acceptance back with it.
 * These tests are against the projection rather than the route because the bug is entirely in
 * the projection, and because a route test would need a database to make a nameless membership.
 */
describe("signerFacts", () => {
  const MEMBER = "01930000-0000-7000-8000-0000000000b1";

  it("gives a nameless signer an explicit null, not an empty string", () => {
    // Exactly what `namesFor` returns for a share-link visitor: an address, and no name at all.
    const facts = signerFacts(MEMBER, { displayName: "", email: "ada@investor.test" });
    expect(facts.displayName).toBeNull();
    expect(facts.emailSha256).toBe(sha256Hex("ada@investor.test"));
  });

  it("treats a whitespace-only name the same way, because it is the same fact", () => {
    expect(
      signerFacts(MEMBER, { displayName: "   ", email: "ada@investor.test" }).displayName,
    ).toBe(null);
  });

  it("keeps and trims a real name", () => {
    expect(
      signerFacts(MEMBER, { displayName: " Ada L ", email: "ada@investor.test" }).displayName,
    ).toBe("Ada L");
  });

  it("normalises the address before hashing it, and never carries the address itself", () => {
    const facts = signerFacts(MEMBER, { displayName: null, email: "  Ada@Investor.TEST " });
    expect(facts.emailSha256).toBe(sha256Hex("ada@investor.test"));
    expect(JSON.stringify(facts)).not.toContain("@");
  });

  it("refuses a membership with no address at all: an unbound signature is evidence of nothing", () => {
    for (const who of [undefined, { displayName: "Ada", email: null }, { email: "" }]) {
      let code = "";
      try {
        signerFacts(MEMBER, who);
      } catch (error) {
        code = isApiError(error) ? error.code : "not-an-api-error";
      }
      expect(code).toBe("conflict");
    }
  });
});
