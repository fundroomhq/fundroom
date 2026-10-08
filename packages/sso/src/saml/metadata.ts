import { X509Certificate } from "node:crypto";
import { attr, children, descendants, NS, parseXml, textOf, XmlInputError } from "./xml.js";

/*
 * IdP metadata (research §1.3): node-saml has no parser, so this reads exactly three facts from
 * a pasted `EntityDescriptor` and nothing else —
 *   - `@entityID`: the assertion `Issuer` we will require;
 *   - the HTTP-Redirect `SingleSignOnService/@Location` of a SAML 2.0 `IDPSSODescriptor` (https);
 *   - every signing `X509Certificate` (`KeyDescriptor` with no `use` or `use="signing"`).
 * Exactly one EntityDescriptor, no DOCTYPE, 1 MiB at most. Certificates are validated with
 * `X509Certificate`: RSA ≥ 2048 bits or EC, not expired.
 */

export const METADATA_MAX_BYTES = 1024 * 1024;
export const MAX_CERTIFICATES = 5;
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const SAML2_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";

export type SamlConfigProblem = "invalid_metadata" | "invalid_certificate";

export class SamlConfigError extends Error {
  override readonly name = "SamlConfigError";
  constructor(
    readonly reason: SamlConfigProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface IdpMetadata {
  readonly entityId: string;
  readonly ssoUrl: string;
  /** PEM, normalised. */
  readonly certificates: readonly string[];
}

export interface CertificateInfo {
  readonly fingerprintSha256: string;
  readonly notAfter: string;
  readonly subject: string;
}

/** Wraps a base64 body (or re-wraps a PEM) as a canonical `CERTIFICATE` PEM. */
export function toPem(input: string): string {
  const body = input
    .replace(/-----BEGIN CERTIFICATE-----/gu, "")
    .replace(/-----END CERTIFICATE-----/gu, "")
    .replace(/\s+/gu, "");
  if (body === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) {
    throw new SamlConfigError("invalid_certificate", "a certificate is not PEM or base64 DER");
  }
  const lines = body.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Parses and checks one signing certificate. Refuses RSA below 2048 bits, anything that is not
 * RSA or EC, and a certificate already past `notAfter`.
 */
export function inspectCertificate(
  pemOrBase64: string,
  now: Date,
): CertificateInfo & { pem: string } {
  const pem = toPem(pemOrBase64);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new SamlConfigError("invalid_certificate", "a certificate could not be parsed");
  }
  const key = cert.publicKey;
  const type = key.asymmetricKeyType;
  if (type === "rsa" || type === "rsa-pss") {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048) {
      throw new SamlConfigError(
        "invalid_certificate",
        "an RSA signing key must be 2048 bits or more",
      );
    }
  } else if (type !== "ec") {
    throw new SamlConfigError("invalid_certificate", "a signing key must be RSA or EC");
  }
  const notAfter = new Date(cert.validTo);
  if (!Number.isFinite(notAfter.getTime()) || notAfter.getTime() <= now.getTime()) {
    throw new SamlConfigError("invalid_certificate", "a signing certificate has expired");
  }
  return {
    pem,
    fingerprintSha256: cert.fingerprint256,
    notAfter: notAfter.toISOString(),
    subject: cert.subject.replace(/\n/gu, ", ").slice(0, 300),
  };
}

/** Best effort for display: a stored certificate that no longer parses shows as unknown. */
export function describeCertificate(pem: string): CertificateInfo {
  try {
    const cert = new X509Certificate(pem);
    return {
      fingerprintSha256: cert.fingerprint256,
      notAfter: new Date(cert.validTo).toISOString(),
      subject: cert.subject.replace(/\n/gu, ", ").slice(0, 300),
    };
  } catch {
    return { fingerprintSha256: "", notAfter: "", subject: "" };
  }
}

/** The IdP URL an AuthnRequest is sent to: https, or http only for an allow-listed host. */
export function checkIdpUrl(raw: string, insecureHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SamlConfigError("invalid_metadata", "the IdP sign-on URL is not a URL");
  }
  const insecureOk = url.protocol === "http:" && insecureHosts.includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !insecureOk) {
    throw new SamlConfigError("invalid_metadata", "the IdP sign-on URL must be https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SamlConfigError("invalid_metadata", "the IdP sign-on URL must not carry credentials");
  }
  if (url.href.length > 2048) {
    throw new SamlConfigError("invalid_metadata", "the IdP sign-on URL is too long");
  }
  return url.href;
}

export function checkEntityId(raw: string): string {
  const id = raw.trim();
  if (id === "" || id.length > 1024 || /[\s<>"]/u.test(id)) {
    throw new SamlConfigError("invalid_metadata", "the IdP entity ID is missing or malformed");
  }
  return id;
}

export function parseIdpMetadata(
  xml: string,
  now: Date,
  insecureHosts: readonly string[] = [],
): IdpMetadata {
  let doc: Document;
  try {
    doc = parseXml(xml, METADATA_MAX_BYTES);
  } catch (error) {
    throw new SamlConfigError(
      "invalid_metadata",
      error instanceof XmlInputError ? error.message : "the metadata is not XML",
    );
  }
  const entities = descendants(doc, NS.md, "EntityDescriptor");
  if (entities.length !== 1) {
    throw new SamlConfigError(
      "invalid_metadata",
      "the metadata must hold exactly one EntityDescriptor",
    );
  }
  const entity = entities[0] as Element;
  const entityId = checkEntityId(attr(entity, "entityID") ?? "");
  const idps = children(entity, NS.md, "IDPSSODescriptor").filter((d) =>
    (attr(d, "protocolSupportEnumeration") ?? "").split(/\s+/u).includes(SAML2_PROTOCOL),
  );
  if (idps.length !== 1) {
    throw new SamlConfigError(
      "invalid_metadata",
      "the metadata must describe one SAML 2.0 identity provider",
    );
  }
  const idp = idps[0] as Element;
  const sso = children(idp, NS.md, "SingleSignOnService").find(
    (s) => attr(s, "Binding") === REDIRECT_BINDING,
  );
  if (sso === undefined) {
    throw new SamlConfigError(
      "invalid_metadata",
      "the IdP offers no HTTP-Redirect SingleSignOnService",
    );
  }
  const ssoUrl = checkIdpUrl(attr(sso, "Location") ?? "", insecureHosts);
  const pems: string[] = [];
  for (const kd of children(idp, NS.md, "KeyDescriptor")) {
    const use = attr(kd, "use");
    if (use !== undefined && use !== "signing") continue;
    for (const c of descendants(kd, NS.ds, "X509Certificate")) {
      const pem = toPem(textOf(c));
      if (!pems.includes(pem)) pems.push(pem);
    }
  }
  return {
    entityId,
    ssoUrl,
    certificates: checkCertificates(pems, now, { dropInvalid: true }).map((c) => c.pem),
  };
}

/**
 * 1..MAX_CERTIFICATES valid signing certificates, de-duplicated. With `dropInvalid` (metadata: a
 * file mid-rollover lists an expired one next to its successor) an unusable certificate is skipped
 * while at least one valid remains; otherwise (pasted by hand) any unusable one is refused.
 */
export function checkCertificates(
  pems: readonly string[],
  now: Date,
  options: { readonly dropInvalid?: boolean } = {},
): (CertificateInfo & { pem: string })[] {
  const out: (CertificateInfo & { pem: string })[] = [];
  let firstError: SamlConfigError | undefined;
  for (const p of pems) {
    try {
      const info = inspectCertificate(p, now);
      if (!out.some((o) => o.fingerprintSha256 === info.fingerprintSha256)) out.push(info);
    } catch (error) {
      if (!(error instanceof SamlConfigError) || options.dropInvalid !== true) throw error;
      firstError ??= error;
    }
  }
  if (out.length === 0) {
    throw (
      firstError ?? new SamlConfigError("invalid_certificate", "no signing certificate was given")
    );
  }
  if (out.length > MAX_CERTIFICATES) {
    throw new SamlConfigError(
      "invalid_certificate",
      `at most ${MAX_CERTIFICATES} signing certificates are accepted`,
    );
  }
  return out;
}
