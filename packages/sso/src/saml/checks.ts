import { attr, children, descendants, NS, parseXml, textOf } from "./xml.js";

/*
 * Our checks on top of node-saml 5.1.0 (research §1.4, ADR-0056 decision 10). They run on
 * `profile.getAssertionXml()` — the bytes xml-crypto verified the signature over — never on the
 * surrounding (unsigned) Response:
 *
 *  1. exactly one bearer `SubjectConfirmation`, whose `SubjectConfirmationData` has
 *     `@InResponseTo` equal to the AuthnRequest id this browser's begin sealed (node-saml only
 *     reads the unsigned Response attribute: #434 accepts a captured IdP-initiated assertion
 *     rewrapped around an attacker's pending request), `@Recipient` equal to our ACS URL (node-saml
 *     never checks it), `@NotOnOrAfter` in the future, and no `@NotBefore`;
 *  2. `Issuer` equal to the connection's IdP entity ID (node-saml trusts the cert alone);
 *  3. `Conditions`: the audience is our per-connection SP entity ID, and the validity window holds
 *     (both within the clock skew);
 *  4. no SHA-1 signature or digest anywhere in the Response (`checkResponse`).
 * Anything missing is a refusal. The assertion id and its expiry feed the replay table.
 */

export const SAML_CLOCK_SKEW_MS = 180_000;
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const WEAK_ALGORITHMS = [
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  "http://www.w3.org/2000/09/xmldsig#sha1",
  "http://www.w3.org/2000/09/xmldsig#dsa-sha1",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha1",
];
const ASSERTION_MAX_BYTES = 256 * 1024;

export class SamlAssertionError extends Error {
  override readonly name = "SamlAssertionError";
}

export interface AssertionExpectations {
  readonly requestId: string;
  readonly acsUrl: string;
  readonly idpEntityId: string;
  readonly audience: string;
  readonly now: Date;
  readonly skewMs?: number | undefined;
}

export interface CheckedAssertion {
  readonly assertionId: string;
  readonly nameId: string;
  readonly nameIdFormat: string | undefined;
  /** When the replay-table row may be swept (the latest validity bound plus the skew). */
  readonly expiresAt: Date;
  readonly authnContextClassRefs: readonly string[];
  /** The latest `AuthnStatement/@AuthnInstant` (when the IdP authenticated the user), if any. */
  readonly authnInstant: Date | undefined;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

function fail(message: string): never {
  throw new SamlAssertionError(message);
}

function time(value: string | undefined, what: string): Date {
  if (value === undefined) fail(`${what} is missing`);
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) fail(`${what} is not a timestamp`);
  return d;
}

export function checkAssertion(xml: string, expect: AssertionExpectations): CheckedAssertion {
  const skew = expect.skewMs ?? SAML_CLOCK_SKEW_MS;
  const now = expect.now.getTime();
  let doc: Document;
  try {
    doc = parseXml(xml, ASSERTION_MAX_BYTES);
  } catch {
    fail("the assertion is not well-formed XML");
  }
  const root = doc.documentElement as Element;
  if (root.namespaceURI !== NS.saml || root.localName !== "Assertion") {
    fail("the signed element is not an Assertion");
  }
  if (descendants(root, NS.saml, "Assertion").length !== 0) fail("nested assertions");
  const assertionId = attr(root, "ID") ?? "";
  if (assertionId.length < 1 || assertionId.length > 512) fail("the assertion has no usable ID");

  // 2. issuer
  const issuers = children(root, NS.saml, "Issuer");
  if (issuers.length !== 1 || textOf(issuers[0] as Element) !== expect.idpEntityId) {
    fail("the assertion issuer is not the configured IdP");
  }

  // 1. subject confirmation
  const subjects = children(root, NS.saml, "Subject");
  if (subjects.length !== 1) fail("the assertion has no single Subject");
  const subject = subjects[0] as Element;
  const nameIds = children(subject, NS.saml, "NameID");
  if (nameIds.length !== 1) fail("the assertion has no NameID");
  const nameIdEl = nameIds[0] as Element;
  const nameId = textOf(nameIdEl);
  if (nameId === "" || nameId.length > 512) fail("the NameID is empty or too long");
  const confirmations = children(subject, NS.saml, "SubjectConfirmation");
  const bearers = confirmations.filter((c) => attr(c, "Method") === BEARER);
  if (bearers.length !== 1 || confirmations.length !== 1) {
    fail("the assertion must carry exactly one bearer SubjectConfirmation");
  }
  const scds = children(bearers[0] as Element, NS.saml, "SubjectConfirmationData");
  if (scds.length !== 1) fail("the SubjectConfirmationData is missing");
  const scd = scds[0] as Element;
  if (attr(scd, "InResponseTo") !== expect.requestId) {
    fail("the signed InResponseTo does not answer this sign-in's request");
  }
  if (attr(scd, "Recipient") !== expect.acsUrl) fail("the assertion's Recipient is not our ACS");
  if (attr(scd, "NotBefore") !== undefined) fail("a bearer confirmation must not have NotBefore");
  const scdEnd = time(attr(scd, "NotOnOrAfter"), "SubjectConfirmationData NotOnOrAfter");
  if (scdEnd.getTime() + skew <= now) fail("the assertion has expired");

  // 3. conditions
  const conditionsList = children(root, NS.saml, "Conditions");
  if (conditionsList.length !== 1) fail("the assertion has no single Conditions");
  const conditions = conditionsList[0] as Element;
  const notBefore = attr(conditions, "NotBefore");
  if (notBefore !== undefined && time(notBefore, "NotBefore").getTime() - skew > now) {
    fail("the assertion is not valid yet");
  }
  const condEnd = time(attr(conditions, "NotOnOrAfter"), "Conditions NotOnOrAfter");
  if (condEnd.getTime() + skew <= now) fail("the assertion has expired");
  const restrictions = children(conditions, NS.saml, "AudienceRestriction");
  if (restrictions.length === 0) fail("the assertion has no AudienceRestriction");
  // Every restriction must admit us (SAML core §2.5.1.4: they are ANDed).
  for (const r of restrictions) {
    const audiences = children(r, NS.saml, "Audience").map(textOf);
    if (!audiences.includes(expect.audience)) fail("the assertion is for another audience");
  }

  const authnContextClassRefs = descendants(root, NS.saml, "AuthnContextClassRef").map(textOf);
  let authnInstant: Date | undefined;
  for (const st of children(root, NS.saml, "AuthnStatement")) {
    const v = attr(st, "AuthnInstant");
    const d = v === undefined ? undefined : new Date(v);
    if (
      d !== undefined &&
      Number.isFinite(d.getTime()) &&
      (authnInstant === undefined || d > authnInstant)
    ) {
      authnInstant = d;
    }
  }
  const attributes: Record<string, string[]> = {};
  for (const statement of children(root, NS.saml, "AttributeStatement")) {
    for (const a of children(statement, NS.saml, "Attribute")) {
      const name = attr(a, "Name");
      if (name === undefined || name.length > 512) continue;
      const values = children(a, NS.saml, "AttributeValue")
        .map(textOf)
        .filter((v) => v !== "" && v.length <= 1024);
      attributes[name] = [...(attributes[name] ?? []), ...values].slice(0, 20);
    }
  }

  return {
    assertionId,
    nameId,
    nameIdFormat: attr(nameIdEl, "Format"),
    expiresAt: new Date(Math.max(scdEnd.getTime(), condEnd.getTime()) + skew),
    authnContextClassRefs,
    authnInstant,
    attributes,
  };
}

/**
 * On the whole posted Response: a present `Destination` must be our ACS (hygiene — the Response is
 * unsigned when only the assertion is), and no signature in it may use SHA-1 (the verified
 * assertion bytes node-saml returns have the enveloped signature removed, so this is read here).
 */
export function checkResponse(responseXml: string, acsUrl: string): void {
  let doc: Document;
  try {
    doc = parseXml(responseXml, ASSERTION_MAX_BYTES * 2);
  } catch {
    fail("the response is not well-formed XML");
  }
  const root = doc.documentElement as Element;
  const destination = attr(root, "Destination");
  if (destination !== undefined && destination !== acsUrl) {
    fail("the response's Destination is not our ACS");
  }
  for (const m of [
    ...descendants(root, NS.ds, "SignatureMethod"),
    ...descendants(root, NS.ds, "DigestMethod"),
  ]) {
    if (WEAK_ALGORITHMS.includes(attr(m, "Algorithm") ?? "")) fail("SHA-1 signatures are refused");
  }
}

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_ATTRIBUTES = [
  "displayName",
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];
const GIVEN_ATTRIBUTES = [
  "givenName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  "urn:oid:2.5.4.42",
];
const SURNAME_ATTRIBUTES = [
  "surname",
  "sn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  "urn:oid:2.5.4.4",
];
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function first(
  attributes: Readonly<Record<string, readonly string[]>>,
  names: readonly string[],
): string | undefined {
  for (const n of names) {
    const v = attributes[n]?.[0];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Email and display name from a checked assertion (contract Corrections): the NameID when its
 * format is emailAddress (or it is email-shaped), else the first of the usual email attributes;
 * the display name from `displayName` / `name`, else given name + surname.
 */
export function samlIdentityClaims(a: CheckedAssertion): {
  readonly email: string | undefined;
  readonly displayName: string | undefined;
} {
  const nameIdIsEmail = a.nameIdFormat === EMAIL_FORMAT || EMAIL_SHAPE.test(a.nameId);
  const email = nameIdIsEmail ? a.nameId : first(a.attributes, EMAIL_ATTRIBUTES);
  const name = first(a.attributes, NAME_ATTRIBUTES);
  const given = first(a.attributes, GIVEN_ATTRIBUTES);
  const surname = first(a.attributes, SURNAME_ATTRIBUTES);
  const composed = [given, surname].filter((v) => v !== undefined).join(" ");
  const displayName = name ?? (composed === "" ? undefined : composed);
  return { email, displayName: displayName?.slice(0, 200) };
}
