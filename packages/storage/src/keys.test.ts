import { isStorageError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  blobKey,
  brandingLogoKey,
  certificateKey,
  certificatePrefix,
  isQuarantineKey,
  parseObjectKey,
  quarantineKey,
  renditionKey,
  renditionPrefix,
  workspacePrefix,
} from "./keys.js";
import { MULTIPART_PART_BYTES, partCountFor } from "./policy.js";

const WS = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b";
const VER = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5c";
const SHA = "a".repeat(64);
const CERT = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5d";

describe("object keys", () => {
  it("builds the documented layout", () => {
    expect(workspacePrefix(WS)).toBe(`ws/${WS}`);
    expect(blobKey(WS, SHA)).toBe(`ws/${WS}/blobs/${SHA}`);
    expect(quarantineKey(WS, VER)).toBe(`ws/${WS}/quarantine/${VER}`);
    expect(renditionKey(WS, VER, "page", 3)).toBe(`ws/${WS}/renditions/${VER}/page/3`);
    expect(renditionKey(WS, VER, "pdf")).toBe(`ws/${WS}/renditions/${VER}/pdf`);
    expect(renditionPrefix(WS, VER)).toBe(`ws/${WS}/renditions/${VER}/`);
    expect(brandingLogoKey(WS, SHA)).toBe(`ws/${WS}/branding/${SHA}`);
    expect(certificateKey(WS, CERT, "json")).toBe(`ws/${WS}/certificates/${CERT}/certificate.json`);
    expect(certificateKey(WS, CERT, "pdf")).toBe(`ws/${WS}/certificates/${CERT}/certificate.pdf`);
    expect(certificatePrefix(WS, CERT)).toBe(`ws/${WS}/certificates/${CERT}/`);
  });

  it("normalises case of ids and digests", () => {
    expect(blobKey(WS.toUpperCase(), SHA.toUpperCase())).toBe(`ws/${WS}/blobs/${SHA}`);
  });

  it("rejects malformed inputs before touching storage", () => {
    for (const fn of [
      () => blobKey("not-a-uuid", SHA),
      () => blobKey(WS, "deadbeef"),
      () => quarantineKey(WS, "../x"),
      () => renditionKey(WS, VER, "Page With Space"),
      () => renditionKey(WS, VER, "page", -1),
      () => renditionKey(WS, VER, "page", 1.5),
      () => renditionKey(WS, "x", "page"),
      () => brandingLogoKey(WS, "deadbeef"),
      () => certificateKey(WS, "not-a-uuid", "json"),
      () => certificateKey("not-a-uuid", CERT, "json"),
      // A form the key layout does not define must not become a new area by accident.
      () => certificateKey(WS, CERT, "xml" as "json"),
    ]) {
      expect(fn).toThrow();
      try {
        fn();
      } catch (e) {
        expect(isStorageError(e, "invalid_key")).toBe(true);
      }
    }
  });

  it("parses what it builds", () => {
    expect(parseObjectKey(blobKey(WS, SHA))).toEqual({
      kind: "blob",
      workspaceId: WS,
      sha256: SHA,
    });
    expect(parseObjectKey(quarantineKey(WS, VER))).toEqual({
      kind: "quarantine",
      workspaceId: WS,
      uploadId: VER,
    });
    expect(parseObjectKey(renditionKey(WS, VER, "page", 7))).toEqual({
      kind: "rendition",
      workspaceId: WS,
      versionId: VER,
      renditionKind: "page",
      index: 7,
    });
    expect(parseObjectKey(renditionKey(WS, VER, "pdf"))).toMatchObject({
      kind: "rendition",
      index: undefined,
    });
    expect(parseObjectKey(brandingLogoKey(WS, SHA))).toEqual({
      kind: "branding",
      workspaceId: WS,
      sha256: SHA,
    });
    expect(parseObjectKey(certificateKey(WS, CERT, "json"))).toEqual({
      kind: "certificate",
      workspaceId: WS,
      certificateId: CERT,
      form: "json",
    });
    expect(parseObjectKey(certificateKey(WS, CERT, "pdf"))).toMatchObject({
      kind: "certificate",
      form: "pdf",
    });
    expect(isQuarantineKey(quarantineKey(WS, VER))).toBe(true);
    expect(isQuarantineKey(blobKey(WS, SHA))).toBe(false);
  });

  it("classifies foreign keys as other", () => {
    expect(parseObjectKey("backups/2026/x.tar")).toEqual({ kind: "other", workspaceId: undefined });
    expect(parseObjectKey(`ws/${WS}/unknown/thing`)).toEqual({ kind: "other", workspaceId: WS });
    expect(parseObjectKey(`ws/${WS}/blobs/nothex`)).toEqual({ kind: "other", workspaceId: WS });
    expect(parseObjectKey(`ws/${WS}/renditions/${VER}/page/07`)).toEqual({
      kind: "other",
      workspaceId: WS,
    });
    expect(() => parseObjectKey("../etc/passwd")).toThrow();
    // A certificate area key that is not one of the two defined forms is not a certificate.
    expect(parseObjectKey(`ws/${WS}/certificates/${CERT}/certificate.xml`)).toEqual({
      kind: "other",
      workspaceId: WS,
    });
    expect(parseObjectKey(`ws/${WS}/certificates/${CERT}/certificate.json/extra`)).toEqual({
      kind: "other",
      workspaceId: WS,
    });
    expect(parseObjectKey(`ws/${WS}/certificates/not-a-uuid/certificate.json`)).toEqual({
      kind: "other",
      workspaceId: WS,
    });
  });
});

describe("partCountFor", () => {
  it("rounds up and never returns zero", () => {
    expect(partCountFor(0)).toBe(1);
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(MULTIPART_PART_BYTES)).toBe(1);
    expect(partCountFor(MULTIPART_PART_BYTES + 1)).toBe(2);
    expect(partCountFor(100, 10)).toBe(10);
  });

  it("refuses sizes beyond the S3 part limit", () => {
    expect(() => partCountFor(10_001, 1)).toThrow(RangeError);
    expect(() => partCountFor(-1)).toThrow(RangeError);
  });
});
