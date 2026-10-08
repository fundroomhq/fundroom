import { describe, expect, it } from "vitest";
import {
  createTestSamlIdp,
  encodeResponse,
  parseAuthnRequest,
  type SamlResponseOptions,
  selfSignedCertificate,
} from "../testing/index.js";
import { checkAssertion, checkResponse, samlIdentityClaims } from "./checks.js";
import { createSp, oneShotCache, spMetadataXml } from "./sp.js";

/*
 * node-saml 5.1.0 + our post-checks, end to end without a database: every attack from research
 * §1 against the exact pipeline `samlAcs` runs (one-shot request cache seeded with this browser's
 * request id → validatePostResponseAsync → checkAssertion on the signed assertion bytes).
 */

const ENTITY = "https://app.example.com/sso/saml/0f0e0d0c-0b0a-4908-8706-050403020100/metadata";
const ACS = "https://app.example.com/sso/saml/0f0e0d0c-0b0a-4908-8706-050403020100/acs";
const idp = createTestSamlIdp({
  entityId: "https://idp.example.org/saml",
  ssoUrl: "https://idp.example.org/sso",
});
const settings = {
  entityId: ENTITY,
  acsUrl: ACS,
  idpSsoUrl: idp.ssoUrl,
  idpCerts: [idp.cert.certPem],
};

async function beginRequest(): Promise<string> {
  const cache = oneShotCache();
  const url = await createSp(settings, cache).getAuthorizeUrlAsync("relay-handle", undefined, {});
  const parsed = parseAuthnRequest(url);
  expect(cache.saved).toEqual([parsed.requestId]);
  expect(parsed.acsUrl).toBe(ACS);
  expect(parsed.issuer).toBe(ENTITY);
  expect(parsed.relayState).toBe("relay-handle");
  return parsed.requestId;
}

/** What `samlAcs` does after the challenge: node-saml, then our checks. */
async function acs(requestId: string, xml: string) {
  const sp = createSp(settings, oneShotCache(requestId));
  const { profile } = await sp.validatePostResponseAsync({ SAMLResponse: encodeResponse(xml) });
  const assertion = profile?.getAssertionXml?.();
  if (profile === null || assertion === undefined) throw new Error("no assertion");
  const checked = checkAssertion(assertion, {
    requestId,
    acsUrl: ACS,
    idpEntityId: idp.entityId,
    audience: ENTITY,
    now: new Date(),
  });
  checkResponse(xml, ACS);
  return checked;
}

function base(requestId: string, extra: Partial<SamlResponseOptions> = {}): SamlResponseOptions {
  return { requestId, acsUrl: ACS, audience: ENTITY, nameId: "alice@acme-corp.com", ...extra };
}

describe("SAML ACS pipeline (node-saml 5.1.0 + post-checks)", () => {
  it("accepts a valid SP-initiated response and reads identity claims", async () => {
    const id = await beginRequest();
    const checked = await acs(
      id,
      idp.response(
        base(id, {
          attributes: { displayName: "Alice Example" },
          authnContextClassRef: "urn:mfa",
        }),
      ),
    );
    expect(checked.nameId).toBe("alice@acme-corp.com");
    expect(checked.authnContextClassRefs).toEqual(["urn:mfa"]);
    expect(samlIdentityClaims(checked)).toEqual({
      email: "alice@acme-corp.com",
      displayName: "Alice Example",
    });
    expect(checked.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("takes the email from attributes when the NameID is opaque", async () => {
    const id = await beginRequest();
    const checked = await acs(
      id,
      idp.response(
        base(id, {
          nameId: "00u1abcd",
          nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
          attributes: {
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress":
              "bob@acme-corp.com",
            givenName: "Bob",
            surname: "Builder",
          },
        }),
      ),
    );
    expect(samlIdentityClaims(checked)).toEqual({
      email: "bob@acme-corp.com",
      displayName: "Bob Builder",
    });
  });

  const refusals: [string, (id: string) => SamlResponseOptions | string][] = [
    ["an unsigned assertion", (id) => base(id, { unsigned: true })],
    ["a tampered NameID", (id) => base(id, { tamperNameId: "mallory@acme-corp.com" })],
    ["an assertion signed by another key", (id) => base(id, { signWith: selfSignedCertificate() })],
    ["two assertions (sibling wrap)", (id) => base(id, { wrap: "sibling" })],
    ["a nested signature-wrapping assertion", (id) => base(id, { wrap: "nested" })],
    [
      "a signed assertion without InResponseTo rewrapped around our request (#434)",
      (id) => base(id, { omitSignedInResponseTo: true }),
    ],
    [
      "a signed InResponseTo answering another request",
      (id) => base(id, { signedInResponseTo: "_someone-elses-request" }),
    ],
    [
      "an unsolicited response (Response InResponseTo absent)",
      (id) => base(id, { responseInResponseTo: null }),
    ],
    [
      "a response naming a request this browser did not start",
      (id) => base(id, { responseInResponseTo: "_foreign", signedInResponseTo: "_foreign" }),
    ],
    [
      "a signed Recipient of another SP",
      (id) => base(id, { recipient: "https://evil.example/acs" }),
    ],
    ["a Destination of another SP", (id) => base(id, { destination: "https://evil.example/acs" })],
    ["another issuer", (id) => base(id, { issuer: "https://other-idp.example/saml" })],
    [
      "another audience",
      (id) => base(id, { audienceOverride: "https://other-sp.example/metadata" }),
    ],
    ["an expired assertion", (id) => base(id, { clockOffsetMs: -20 * 60_000 })],
    ["an assertion from the future", (id) => base(id, { clockOffsetMs: 20 * 60_000 })],
    ["a SHA-1 signature", (id) => base(id, { sha1: true })],
    [
      "a non-success status",
      (id) => base(id, { statusCode: "urn:oasis:names:tc:SAML:2.0:status:Responder" }),
    ],
  ];

  for (const [label, make] of refusals) {
    it(`refuses ${label}`, async () => {
      const id = await beginRequest();
      const o = make(id);
      const xml = typeof o === "string" ? o : idp.response(o);
      await expect(acs(id, xml)).rejects.toThrow();
    });
  }

  it("never reads a comment-injected NameID as the prefix (Duo class)", async () => {
    const id = await beginRequest();
    const xml = idp.response(
      base(id, { nameId: "alice@acme-corp.com.evil.example", commentAt: 19 }),
    );
    expect(xml).toContain("alice@acme-corp.com<!---->.evil.example");
    let nameId: string | undefined;
    try {
      nameId = (await acs(id, xml)).nameId;
    } catch {
      nameId = undefined; // refused outright is fine too
    }
    expect(nameId).not.toBe("alice@acme-corp.com");
    if (nameId !== undefined) expect(nameId).toBe("alice@acme-corp.com.evil.example");
  });

  it("refuses a response whose request id is not the one this browser's begin sealed", async () => {
    const mine = await beginRequest();
    const other = await beginRequest();
    // The IdP answered `other`, but this ACS call carries `mine`'s RelayState.
    await expect(acs(mine, idp.response(base(other)))).rejects.toThrow();
  });

  it("publishes SP metadata with the ACS and entity id", () => {
    const xml = spMetadataXml(ENTITY, ACS);
    expect(xml).toContain(`entityID="${ENTITY}"`);
    expect(xml).toContain(`Location="${ACS}"`);
    expect(xml).toContain('WantAssertionsSigned="true"');
  });
});
