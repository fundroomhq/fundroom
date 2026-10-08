import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { selfSignedCertificate, type TestCertificate } from "./cert.js";

/*
 * A SAML 2.0 IdP for tests: builds and signs Responses/Assertions with a generated key + cert
 * (xml-crypto, RSA-SHA256, exclusive c14n, enveloped signature after the Issuer), with a knob for
 * every attack in research §1: unsigned, signature wrapping (sibling and nested), missing or
 * foreign InResponseTo, wrong Recipient / Issuer / Audience, expired, replay (just post twice),
 * comment-injected NameID, post-signing tampering, a foreign signing key, SHA-1. Test-only.
 */

const SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
export const EMAIL_NAMEID_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
export const PERSISTENT_NAMEID_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

export interface TestSamlIdp {
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly cert: TestCertificate;
  /** A metadata document an admin would paste. */
  metadataXml(options?: { readonly extraCerts?: readonly string[] }): string;
  /** Builds a Response (XML string; base64 it with `encodeResponse`). */
  response(options: SamlResponseOptions): string;
}

export interface SamlResponseOptions {
  /** The AuthnRequest id (from `parseAuthnRequest`). */
  readonly requestId: string;
  readonly acsUrl: string;
  /** SP entity id (the audience). */
  readonly audience: string;
  readonly nameId: string;
  readonly nameIdFormat?: string | undefined;
  readonly attributes?: Readonly<Record<string, string | readonly string[]>> | undefined;
  readonly authnContextClassRef?: string | undefined;
  readonly assertionId?: string | undefined;
  /** `AuthnStatement/@AuthnInstant` (default: the assertion's issue time). */
  readonly authnInstant?: Date | undefined;
  // --- attack knobs -------------------------------------------------------------------------
  /** No signature at all. */
  readonly unsigned?: boolean | undefined;
  /** Omit `SubjectConfirmationData/@InResponseTo` from the signed assertion (#434). */
  readonly omitSignedInResponseTo?: boolean | undefined;
  /** The signed `SubjectConfirmationData/@InResponseTo` (default: `requestId`). */
  readonly signedInResponseTo?: string | undefined;
  /** The unsigned `Response/@InResponseTo` (default: `requestId`); `null` omits it. */
  readonly responseInResponseTo?: string | null | undefined;
  readonly recipient?: string | undefined;
  readonly destination?: string | null | undefined;
  /** Assertion `Issuer` (default: the IdP entity id). */
  readonly issuer?: string | undefined;
  readonly audienceOverride?: string | undefined;
  /** Shift every timestamp (negative → expired). */
  readonly clockOffsetMs?: number | undefined;
  /** Validity window length (default 5 minutes). */
  readonly lifetimeMs?: number | undefined;
  /** Add an unsigned assertion next to the signed one (`sibling`) or wrap it (`nested`). */
  readonly wrap?: "sibling" | "nested" | undefined;
  /** NameID of the injected evil assertion. */
  readonly wrapNameId?: string | undefined;
  /**
   * Sign `nameId`, then insert an XML comment at this offset of the NameID text (the Duo class:
   * `alice@acme.com<!---->.evil`).
   */
  readonly commentAt?: number | undefined;
  /** Replace the NameID text after signing. */
  readonly tamperNameId?: string | undefined;
  /** Sign with another key (an attacker's). */
  readonly signWith?: TestCertificate | undefined;
  /** RSA-SHA1 + SHA-1 digest instead of SHA-256. */
  readonly sha1?: boolean | undefined;
  /** A non-success top-level status (e.g. `urn:oasis:names:tc:SAML:2.0:status:Responder`). */
  readonly statusCode?: string | undefined;
}

function esc(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function newId(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

export function encodeResponse(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

/** Reads the HTTP-Redirect AuthnRequest node-saml produced (for its id and RelayState). */
export function parseAuthnRequest(url: string): {
  readonly requestId: string;
  readonly relayState: string;
  readonly acsUrl: string | undefined;
  readonly issuer: string | undefined;
  readonly xml: string;
} {
  const u = new URL(url);
  const req = u.searchParams.get("SAMLRequest");
  const relayState = u.searchParams.get("RelayState");
  if (req === null || relayState === null) throw new Error("not a SAML redirect URL");
  const xml = inflateRawSync(Buffer.from(req, "base64")).toString("utf8");
  const id = /\bID="([^"]+)"/u.exec(xml)?.[1];
  if (id === undefined) throw new Error("no AuthnRequest ID");
  return {
    requestId: id,
    relayState,
    acsUrl: /AssertionConsumerServiceURL="([^"]+)"/u.exec(xml)?.[1],
    issuer: /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/u.exec(xml)?.[1],
    xml,
  };
}

export function createTestSamlIdp(
  options: {
    readonly entityId?: string;
    readonly ssoUrl?: string;
    readonly cert?: TestCertificate;
  } = {},
): TestSamlIdp {
  const entityId =
    options.entityId ?? `https://idp.test-saml.example/${randomBytes(4).toString("hex")}`;
  const ssoUrl = options.ssoUrl ?? "https://idp.test-saml.example/sso";
  const cert = options.cert ?? selfSignedCertificate();
  const certBody = (pem: string) =>
    pem.replace(/-----(BEGIN|END) CERTIFICATE-----/gu, "").replace(/\s+/gu, "");

  function assertionXml(o: SamlResponseOptions, id: string, nameId: string, now: Date): string {
    const lifetime = o.lifetimeMs ?? 5 * 60_000;
    const later = new Date(now.getTime() + lifetime);
    const iso = (d: Date) => d.toISOString();
    const irt = o.omitSignedInResponseTo
      ? ""
      : ` InResponseTo="${esc(o.signedInResponseTo ?? o.requestId)}"`;
    const attrs = Object.entries(o.attributes ?? {})
      .map(([k, v]) => {
        const values = (typeof v === "string" ? [v] : v)
          .map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`)
          .join("");
        return `<saml:Attribute Name="${esc(k)}">${values}</saml:Attribute>`;
      })
      .join("");
    return (
      `<saml:Assertion xmlns:saml="${SAML}" ID="${id}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${esc(o.issuer ?? entityId)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${esc(o.nameIdFormat ?? EMAIL_NAMEID_FORMAT)}">${esc(nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(later)}" Recipient="${esc(o.recipient ?? o.acsUrl)}"/>` +
      `</saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(now)}" NotOnOrAfter="${iso(later)}">` +
      `<saml:AudienceRestriction><saml:Audience>${esc(o.audienceOverride ?? o.audience)}</saml:Audience></saml:AudienceRestriction>` +
      `</saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(o.authnInstant ?? now)}" SessionIndex="${newId()}"><saml:AuthnContext>` +
      `<saml:AuthnContextClassRef>${esc(o.authnContextClassRef ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport")}</saml:AuthnContextClassRef>` +
      `</saml:AuthnContext></saml:AuthnStatement>` +
      (attrs === "" ? "" : `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>`) +
      `</saml:Assertion>`
    );
  }

  function signAssertion(xml: string, signer: TestCertificate, sha1: boolean): string {
    const sig = new SignedXml({
      privateKey: signer.keyPem,
      publicCert: signer.certPem,
      signatureAlgorithm: sha1
        ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
        : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: sha1
        ? "http://www.w3.org/2000/09/xmldsig#sha1"
        : "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
    });
    sig.computeSignature(xml, {
      location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
    });
    return sig.getSignedXml();
  }

  return {
    entityId,
    ssoUrl,
    cert,
    metadataXml(o = {}) {
      const certs = [cert.certPem, ...(o.extraCerts ?? [])]
        .map(
          (c) =>
            `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody(c)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
        )
        .join("");
      return (
        `<?xml version="1.0"?>` +
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(entityId)}">` +
        `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        certs +
        `<md:NameIDFormat>${EMAIL_NAMEID_FORMAT}</md:NameIDFormat>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(ssoUrl)}/post"/>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(ssoUrl)}"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`
      );
    },
    response(o) {
      const now = new Date(Date.now() + (o.clockOffsetMs ?? 0));
      const id = o.assertionId ?? newId();
      const commentAt = o.commentAt;
      let assertion = assertionXml(o, id, o.nameId, now);
      if (o.unsigned !== true)
        assertion = signAssertion(assertion, o.signWith ?? cert, o.sha1 === true);
      if (commentAt !== undefined) {
        const escaped = esc(o.nameId);
        const at = esc(o.nameId.slice(0, commentAt)).length;
        assertion = assertion.replace(
          `>${escaped}</saml:NameID>`,
          `>${escaped.slice(0, at)}<!---->${escaped.slice(at)}</saml:NameID>`,
        );
      }
      if (o.tamperNameId !== undefined) {
        assertion = assertion.replace(
          `>${esc(o.nameId)}</saml:NameID>`,
          `>${esc(o.tamperNameId)}</saml:NameID>`,
        );
      }
      if (o.wrap !== undefined) {
        const evil = assertionXml(o, newId(), o.wrapNameId ?? "mallory@evil.example", now);
        assertion =
          o.wrap === "sibling"
            ? `${evil}${assertion}`
            : // XSW: the evil assertion is what a naive reader sees first; the signed original
              // hides inside it where the signature's reference still finds it by ID.
              evil.replace("</saml:Subject>", `</saml:Subject>${assertion}`);
      }
      const irt =
        o.responseInResponseTo === null
          ? ""
          : ` InResponseTo="${esc(o.responseInResponseTo ?? o.requestId)}"`;
      const destination =
        o.destination === null ? "" : ` Destination="${esc(o.destination ?? o.acsUrl)}"`;
      const status = o.statusCode ?? "urn:oasis:names:tc:SAML:2.0:status:Success";
      return (
        `<samlp:Response xmlns:samlp="${SAMLP}" ID="${newId()}" Version="2.0" IssueInstant="${now.toISOString()}"${destination}${irt}>` +
        `<saml:Issuer xmlns:saml="${SAML}">${esc(entityId)}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="${esc(status)}"/></samlp:Status>` +
        (status.endsWith(":Success") ? assertion : "") +
        `</samlp:Response>`
      );
    },
  };
}
