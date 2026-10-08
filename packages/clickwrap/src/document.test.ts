import { describe, expect, it } from "vitest";
import {
  assertValidCertificateDocument,
  CERTIFICATE_TIMESTAMP_RE,
  type CertificateDocument,
  CertificateError,
  canonicalize,
  digestOf,
  formatCertificateTimestamp,
  MAX_TEXT_LENGTH,
  parseCertificateDocument,
} from "./document.js";

const CERT = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b";
const WS = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a01";
const MEMBERSHIP = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a02";
const DOCUMENT = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a03";
const LINK = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a04";

const DOC: CertificateDocument = {
  version: 1,
  certificateId: CERT,
  workspace: { id: WS, name: "Northwind Ventures", host: "invest.northwind.example" },
  signer: {
    membershipId: MEMBERSHIP,
    emailSha256: "b".repeat(64),
    displayName: "Ada Lovelace",
    typedName: "Ada Lovelace",
  },
  document: {
    documentId: DOCUMENT,
    slug: "nda",
    title: "Mutual non-disclosure agreement",
    versionNo: 3,
    stamp: "nda:v3",
    bodySha256: "c".repeat(64),
  },
  acceptance: {
    acceptedAt: "2026-09-14T10:11:12.000000Z",
    method: "clickwrap",
    uaFamily: "firefox",
    ipHash: "d".repeat(64),
    viaLinkId: LINK,
  },
  anchor: { auditSeq: 42, auditHash: "e".repeat(64) },
};

/**
 * The format, frozen. If this string changes, every certificate ever issued now has a digest
 * nothing can reproduce — which is the entire failure mode this package exists to prevent.
 */
const GOLDEN_CANONICAL =
  '{"version":1,"certificateId":"0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b",' +
  '"workspace":{"id":"0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a01","name":"Northwind Ventures",' +
  '"host":"invest.northwind.example"},' +
  '"signer":{"membershipId":"0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a02","emailSha256":"' +
  "b".repeat(64) +
  '","displayName":"Ada Lovelace","typedName":"Ada Lovelace"},' +
  '"document":{"documentId":"0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a03","slug":"nda",' +
  '"title":"Mutual non-disclosure agreement","versionNo":3,"stamp":"nda:v3","bodySha256":"' +
  "c".repeat(64) +
  '"},' +
  '"acceptance":{"acceptedAt":"2026-09-14T10:11:12.000000Z","method":"clickwrap",' +
  '"uaFamily":"firefox","ipHash":"' +
  "d".repeat(64) +
  '","viaLinkId":"0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a04"},' +
  '"anchor":{"auditSeq":42,"auditHash":"' +
  "e".repeat(64) +
  '"}}';

const GOLDEN_SHA256 = "35c6d296cdb619b92812e294d6d083fc401d2053e2f117c4958712ba1a3b9e81";

/** Rebuilds an object graph with every object's keys in reverse insertion order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).reverse()) {
    out[k] = reverseKeys(v);
  }
  return out;
}

/** Rebuilds with every object's keys sorted, a different order again. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** Every leaf path in the document, as dotted paths. */
function leafPaths(value: unknown, prefix = ""): readonly string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

function setAt(doc: CertificateDocument, path: string, value: unknown): unknown {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
  const parts = path.split(".");
  let node: Record<string, unknown> = copy;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] ?? "";
  node[last] = value;
  return copy;
}

function deleteAt(doc: CertificateDocument, path: string): unknown {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
  const parts = path.split(".");
  let node: Record<string, unknown> = copy;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1] ?? ""];
  return copy;
}

/** A value of the right shape but a different fact, for each leaf. */
const OTHER_VALUE: Readonly<Record<string, unknown>> = {
  certificateId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4aff",
  "workspace.id": "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4afe",
  "workspace.name": "Northwind Ventures ",
  "workspace.host": "invest.northwind.example.com",
  "signer.membershipId": "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4afd",
  "signer.emailSha256": `${"b".repeat(63)}c`,
  "signer.displayName": "Ada Lovelace Jr",
  "signer.typedName": null,
  "document.documentId": "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4afc",
  "document.slug": "nda-2",
  "document.title": "Mutual non-disclosure agreement.",
  "document.versionNo": 4,
  "document.stamp": "nda:v4",
  "document.bodySha256": `${"c".repeat(63)}d`,
  "acceptance.acceptedAt": "2026-09-14T10:11:12.000001Z",
  "acceptance.uaFamily": null,
  "acceptance.ipHash": `${"d".repeat(63)}e`,
  "acceptance.viaLinkId": null,
  "anchor.auditSeq": 43,
  "anchor.auditHash": `${"e".repeat(63)}f`,
};

describe("canonicalize", () => {
  it("emits the frozen byte sequence for the golden document", () => {
    expect(canonicalize(DOC)).toBe(GOLDEN_CANONICAL);
    expect(digestOf(DOC)).toBe(GOLDEN_SHA256);
  });

  it("emits keys in declaration order, not insertion order", () => {
    const order = [...canonicalize(DOC).matchAll(/"([A-Za-z0-9]+)":/gu)].map((m) => m[1]);
    expect(order).toEqual([
      "version",
      "certificateId",
      "workspace",
      "id",
      "name",
      "host",
      "signer",
      "membershipId",
      "emailSha256",
      "displayName",
      "typedName",
      "document",
      "documentId",
      "slug",
      "title",
      "versionNo",
      "stamp",
      "bodySha256",
      "acceptance",
      "acceptedAt",
      "method",
      "uaFamily",
      "ipHash",
      "viaLinkId",
      "anchor",
      "auditSeq",
      "auditHash",
    ]);
  });

  it("is unchanged by reordering the input object's keys, at every level", () => {
    const reversed = reverseKeys(DOC) as CertificateDocument;
    const sorted = sortKeys(DOC) as CertificateDocument;
    // Sanity: the shuffles really did change the objects' own key order.
    expect(Object.keys(reversed)[0]).toBe("anchor");
    expect(Object.keys(sorted)[0]).toBe("acceptance");
    expect(canonicalize(reversed)).toBe(GOLDEN_CANONICAL);
    expect(canonicalize(sorted)).toBe(GOLDEN_CANONICAL);
  });

  it("is unchanged by a JSON round trip, and is its own fixed point", () => {
    const roundTripped = JSON.parse(JSON.stringify(DOC)) as CertificateDocument;
    expect(canonicalize(roundTripped)).toBe(GOLDEN_CANONICAL);
    expect(canonicalize(parseCertificateDocument(canonicalize(DOC)))).toBe(GOLDEN_CANONICAL);
    expect(canonicalize(DOC)).toBe(canonicalize(DOC));
  });

  it("ignores keys outside the fixed set, so what is hashed is exactly what is kept", () => {
    const withExtras = {
      ...JSON.parse(JSON.stringify(DOC)),
      email: "ada@example.com",
      signer: { ...DOC.signer, ip: "203.0.113.7" },
    };
    expect(canonicalize(withExtras as CertificateDocument)).toBe(GOLDEN_CANONICAL);
  });

  it("carries no insignificant whitespace", () => {
    // Every space in the output is inside a string literal; strip the strings and none remain.
    const withoutStrings = canonicalize(DOC).replace(/"(?:[^"\\]|\\.)*"/gu, '""');
    expect(withoutStrings).not.toMatch(/\s/u);
  });

  it("changes the digest when any single field changes", () => {
    const paths = leafPaths(DOC).filter((p) => p !== "version" && p !== "acceptance.method");
    expect(paths).toHaveLength(Object.keys(OTHER_VALUE).length);
    const seen = new Map<string, string>([[GOLDEN_SHA256, "(unchanged)"]]);
    for (const path of paths) {
      const mutated = setAt(DOC, path, OTHER_VALUE[path]);
      const digest = digestOf(assertValidCertificateDocument(mutated));
      const clash = seen.get(digest);
      expect(clash, `${path} collides with ${clash ?? ""}`).toBeUndefined();
      seen.set(digest, path);
    }
  });

  it("refuses a missing key rather than treating it as null", () => {
    for (const path of ["signer.typedName", "acceptance.ipHash", "acceptance.viaLinkId"]) {
      expect(() => canonicalize(deleteAt(DOC, path) as CertificateDocument)).toThrow(
        CertificateError,
      );
    }
  });

  it("distinguishes an explicit null from the empty string", () => {
    const asNull = digestOf(setAt(DOC, "signer.typedName", null) as CertificateDocument);
    expect(() => canonicalize(setAt(DOC, "signer.typedName", "") as CertificateDocument)).toThrow(
      CertificateError,
    );
    expect(asNull).not.toBe(GOLDEN_SHA256);
  });

  it("keeps non-Latin text exactly, and hashes it stably", () => {
    const names = ["李雷", "Ольга", "Zoë 😀", 'quote " backslash \\ slash /', "  "];
    for (const typedName of names) {
      const doc = setAt(DOC, "signer.typedName", typedName) as CertificateDocument;
      const canonical = canonicalize(doc);
      expect(parseCertificateDocument(canonical).signer.typedName).toBe(typedName);
      expect(canonicalize(parseCertificateDocument(canonical))).toBe(canonical);
      expect(digestOf(doc)).toBe(digestOf(JSON.parse(JSON.stringify(doc)) as CertificateDocument));
    }
  });

  it("escapes a lone surrogate deterministically instead of emitting invalid UTF-8", () => {
    const doc = setAt(DOC, "signer.typedName", "A\ud800B") as CertificateDocument;
    expect(canonicalize(doc)).toContain('"typedName":"A\\ud800B"');
    expect(digestOf(doc)).toBe(digestOf(doc));
  });
});

describe("assertValidCertificateDocument", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["a non-object", "nope"],
    ["an array", []],
    ["a future format version", setAt(DOC, "version", 2)],
    ["an upper-case id", setAt(DOC, "signer.membershipId", MEMBERSHIP.toUpperCase())],
    ["an upper-case digest", setAt(DOC, "document.bodySha256", "C".repeat(64))],
    ["a short digest", setAt(DOC, "signer.emailSha256", "b".repeat(63))],
    ["a non-UUID id", setAt(DOC, "certificateId", "cert-1")],
    ["a v9 UUID", setAt(DOC, "certificateId", "0192b3c4-5d6e-9f80-8a9b-0c1d2e3f4a5b")],
    ["a stamp with no version", setAt(DOC, "document.stamp", "nda")],
    ["a stamp at v0", setAt(DOC, "document.stamp", "nda:v0")],
    ["a fractional version number", setAt(DOC, "document.versionNo", 1.5)],
    ["version number zero", setAt(DOC, "document.versionNo", 0)],
    ["a negative audit seq", setAt(DOC, "anchor.auditSeq", -1)],
    ["audit seq zero", setAt(DOC, "anchor.auditSeq", 0)],
    ["a numeric string audit seq", setAt(DOC, "anchor.auditSeq", "42")],
    ["an unsafe integer audit seq", setAt(DOC, "anchor.auditSeq", 2 ** 53)],
    [
      "a timestamp with milliseconds only",
      setAt(DOC, "acceptance.acceptedAt", "2026-09-14T10:11:12.000Z"),
    ],
    [
      "a timestamp with an offset",
      setAt(DOC, "acceptance.acceptedAt", "2026-09-14T10:11:12.000000+00:00"),
    ],
    ["a timestamp with no zone", setAt(DOC, "acceptance.acceptedAt", "2026-09-14T10:11:12.000000")],
    ["month 13", setAt(DOC, "acceptance.acceptedAt", "2026-13-14T10:11:12.000000Z")],
    ["another signing method", setAt(DOC, "acceptance.method", "wet-ink")],
    ["a raw User-Agent in uaFamily", setAt(DOC, "acceptance.uaFamily", "Mozilla/5.0 (X11)")],
    ["a raw IP in ipHash", setAt(DOC, "acceptance.ipHash", "203.0.113.7")],
    ["a newline in a name", setAt(DOC, "signer.displayName", "Ada\nLovelace")],
    ["a NUL in a title", setAt(DOC, "document.title", "NDA \u0000")],
    ["over-long free text", setAt(DOC, "workspace.name", "x".repeat(MAX_TEXT_LENGTH + 1))],
    ["a numeric name", setAt(DOC, "workspace.name", 7)],
    ["a null workspace name", setAt(DOC, "workspace.name", null)],
  ];

  for (const [what, value] of cases) {
    it(`rejects ${what}`, () => {
      expect(() => assertValidCertificateDocument(value)).toThrow(CertificateError);
    });
  }

  it("accepts exactly MAX_TEXT_LENGTH characters", () => {
    const doc = setAt(DOC, "workspace.name", "x".repeat(MAX_TEXT_LENGTH));
    expect(assertValidCertificateDocument(doc).workspace.name).toHaveLength(MAX_TEXT_LENGTH);
  });

  it("reports which field was wrong", () => {
    try {
      assertValidCertificateDocument(setAt(DOC, "anchor.auditHash", "nope"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CertificateError);
      expect((error as CertificateError).code).toBe("invalid_document");
      expect((error as CertificateError).details?.["field"]).toBe("anchor.auditHash");
    }
  });
});

describe("formatCertificateTimestamp", () => {
  it("renders UTC with microsecond places", () => {
    expect(formatCertificateTimestamp(new Date("2026-09-14T10:11:12.345Z"))).toBe(
      "2026-09-14T10:11:12.345000Z",
    );
    expect(formatCertificateTimestamp(new Date(0))).toBe("1970-01-01T00:00:00.000000Z");
  });

  it("renders the same instant identically whatever the local zone", () => {
    const at = new Date(Date.UTC(2026, 0, 1, 23, 59, 59, 999));
    expect(formatCertificateTimestamp(at)).toBe("2026-01-01T23:59:59.999000Z");
    expect(formatCertificateTimestamp(at)).toMatch(CERTIFICATE_TIMESTAMP_RE);
  });

  it("refuses an invalid date and a year outside four digits", () => {
    expect(() => formatCertificateTimestamp(new Date("nope"))).toThrow(CertificateError);
    expect(() => formatCertificateTimestamp(new Date(8.64e15))).toThrow(CertificateError);
  });
});

describe("parseCertificateDocument", () => {
  it("round-trips what canonicalize wrote", () => {
    expect(parseCertificateDocument(GOLDEN_CANONICAL)).toEqual(DOC);
  });

  it("refuses bytes that are not JSON, and JSON that is not a certificate", () => {
    expect(() => parseCertificateDocument("{")).toThrow(CertificateError);
    expect(() => parseCertificateDocument("{}")).toThrow(CertificateError);
    try {
      parseCertificateDocument("not json");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as CertificateError).code).toBe("unreadable");
    }
  });
});
