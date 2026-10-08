import { DOMParser } from "@xmldom/xmldom";

/*
 * The only XML parsing `@fundroom/sso` does itself: IdP metadata an admin pastes and the
 * already-signature-verified assertion node-saml hands back (`profile.getAssertionXml()`).
 * `@xmldom/xmldom` 0.8.15+ (pinned by override) resolves no external entities; a DOCTYPE is still
 * refused outright, input is size-capped, and any parser error or warning is fatal.
 */

export const NS = {
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
} as const;

export class XmlInputError extends Error {
  override readonly name = "XmlInputError";
}

export function parseXml(text: string, maxBytes: number): Document {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new XmlInputError("the XML is too large");
  if (/<!DOCTYPE/iu.test(text) || /<!ENTITY/iu.test(text)) {
    throw new XmlInputError("the XML declares a DOCTYPE, which is not accepted");
  }
  const problems: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: (m: unknown) => problems.push(String(m)),
      error: (m: unknown) => problems.push(String(m)),
      fatalError: (m: unknown) => problems.push(String(m)),
    },
  }).parseFromString(text, "text/xml");
  if (problems.length > 0 || doc.documentElement === null) {
    throw new XmlInputError("the XML is not well-formed");
  }
  return doc;
}

/** Direct children of `parent` with the given namespace + local name. */
export function children(parent: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const e = n as Element;
      if (e.namespaceURI === ns && e.localName === local) out.push(e);
    }
  }
  return out;
}

/** All descendants of `parent` with the given namespace + local name. */
export function descendants(parent: Element | Document, ns: string, local: string): Element[] {
  const list = parent.getElementsByTagNameNS(ns, local);
  const out: Element[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list.item(i);
    if (e !== null) out.push(e);
  }
  return out;
}

/** Text content of an element, trimmed; comments and processing instructions do not count. */
export function textOf(e: Element): string {
  let s = "";
  for (let n = e.firstChild; n !== null; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue ?? "";
    else if (n.nodeType === 1) s += textOf(n as Element);
  }
  return s.trim();
}

export function attr(e: Element, name: string): string | undefined {
  return e.hasAttribute(name) ? (e.getAttribute(name) ?? undefined) : undefined;
}
