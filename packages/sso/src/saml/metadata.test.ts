import { describe, expect, it } from "vitest";
import { createTestSamlIdp, selfSignedCertificate } from "../testing/index.js";
import {
  checkCertificates,
  checkIdpUrl,
  inspectCertificate,
  parseIdpMetadata,
  SamlConfigError,
  toPem,
} from "./metadata.js";

const now = new Date();

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SamlConfigError ? error.reason : `other: ${String(error)}`;
  }
  return undefined;
}

describe("IdP metadata parser", () => {
  const idp = createTestSamlIdp({
    entityId: "https://idp.example.org/saml",
    ssoUrl: "https://idp.example.org/sso",
  });

  it("reads entityID, the HTTP-Redirect SSO URL and the signing certificates", () => {
    const md = parseIdpMetadata(idp.metadataXml(), now);
    expect(md.entityId).toBe("https://idp.example.org/saml");
    expect(md.ssoUrl).toBe("https://idp.example.org/sso");
    expect(md.certificates).toEqual([toPem(idp.cert.certPem)]);
  });

  it("keeps a rollover's second certificate and drops an expired one", () => {
    const next = selfSignedCertificate();
    const expired = selfSignedCertificate({
      notBefore: new Date(Date.now() - 3 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    const md = parseIdpMetadata(
      idp.metadataXml({ extraCerts: [next.certPem, expired.certPem] }),
      now,
    );
    expect(md.certificates).toHaveLength(2);
  });

  it("refuses DOCTYPEs, entity declarations and malformed XML", () => {
    const doctype = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]>${idp.metadataXml().replace('<?xml version="1.0"?>', "")}`;
    expect(reason(() => parseIdpMetadata(doctype, now))).toBe("invalid_metadata");
    expect(reason(() => parseIdpMetadata("<md:EntityDescriptor", now))).toBe("invalid_metadata");
  });

  it("refuses zero or several EntityDescriptors", () => {
    const one = idp.metadataXml().replace('<?xml version="1.0"?>', "");
    const two = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${one}${one}</md:EntitiesDescriptor>`;
    expect(reason(() => parseIdpMetadata(two, now))).toBe("invalid_metadata");
    expect(reason(() => parseIdpMetadata("<root/>", now))).toBe("invalid_metadata");
  });

  it("refuses metadata without an HTTP-Redirect binding or with an http URL", () => {
    const noRedirect = idp
      .metadataXml()
      .replace(/<md:SingleSignOnService Binding="[^"]*HTTP-Redirect"[^>]*\/>/u, "");
    expect(reason(() => parseIdpMetadata(noRedirect, now))).toBe("invalid_metadata");
    const http = createTestSamlIdp({ ssoUrl: "http://idp.lan/sso" });
    expect(reason(() => parseIdpMetadata(http.metadataXml(), now))).toBe("invalid_metadata");
    expect(parseIdpMetadata(http.metadataXml(), now, ["idp.lan"]).ssoUrl).toBe(
      "http://idp.lan/sso",
    );
  });

  it("refuses metadata whose only certificate is unusable", () => {
    const weak = createTestSamlIdp({ cert: selfSignedCertificate({ bits: 1024 }) });
    expect(reason(() => parseIdpMetadata(weak.metadataXml(), now))).toBe("invalid_certificate");
  });
});

describe("certificates", () => {
  it("describes a valid certificate", () => {
    const c = selfSignedCertificate({ commonName: "Acme IdP" });
    const info = inspectCertificate(c.certPem, now);
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
    expect(info.subject).toContain("Acme IdP");
    expect(new Date(info.notAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts a bare base64 body and normalises it to PEM", () => {
    const c = selfSignedCertificate();
    const body = c.certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/gu, "");
    expect(toPem(body)).toBe(toPem(c.certPem));
  });

  it("refuses RSA below 2048 bits, expired certificates and junk", () => {
    expect(
      reason(() => inspectCertificate(selfSignedCertificate({ bits: 1024 }).certPem, now)),
    ).toBe("invalid_certificate");
    const expired = selfSignedCertificate({
      notBefore: new Date(Date.now() - 2 * 86_400_000),
      notAfter: new Date(Date.now() - 1000),
    });
    expect(reason(() => inspectCertificate(expired.certPem, now))).toBe("invalid_certificate");
    expect(reason(() => inspectCertificate("not a cert!", now))).toBe("invalid_certificate");
    expect(reason(() => inspectCertificate("QUJD", now))).toBe("invalid_certificate");
  });

  it("refuses a hand-pasted list with one bad certificate, and an empty list", () => {
    const good = selfSignedCertificate().certPem;
    expect(reason(() => checkCertificates([good, "junk"], now))).toBe("invalid_certificate");
    expect(reason(() => checkCertificates([], now))).toBe("invalid_certificate");
    expect(checkCertificates([good, good], now)).toHaveLength(1);
  });

  it("requires https IdP URLs without credentials", () => {
    expect(checkIdpUrl("https://idp.example.org/sso", [])).toBe("https://idp.example.org/sso");
    expect(reason(() => checkIdpUrl("http://idp.example.org/sso", []))).toBe("invalid_metadata");
    expect(reason(() => checkIdpUrl("https://u:p@idp.example.org/sso", []))).toBe(
      "invalid_metadata",
    );
    expect(reason(() => checkIdpUrl("javascript:alert(1)", []))).toBe("invalid_metadata");
  });
});
