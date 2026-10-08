import { createHash, randomBytes } from "node:crypto";
import type { AuditInput, AuditRecorder } from "@fundroom/audit";
import { decryptBytes, type EnvelopeService, MAGIC } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type {
  AuditEventRecord,
  ObjectBody,
  ObjectRead,
  ObjectStat,
  ObjectStoragePort,
  PutOptions,
} from "@fundroom/ports";
import { certificateKey } from "@fundroom/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { CertificateError, canonicalize, parseCertificateDocument } from "./document.js";
import {
  type CertificateFacts,
  createCertificateIssuer,
  formatCertificateReference,
  type IssueCertificateInput,
  parseCertificateReference,
} from "./issuer.js";

const WS = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a01";
const OTHER_WS = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a0f";
const MEMBERSHIP = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a02";
const DOCUMENT = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a03";
const LINK = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a04";
const ATTESTATION = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a05";
const CERT_ID = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b";
const KEY_ID = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a06";

const CTX: TenantContext = { workspaceId: WS, actorKind: "external", membershipId: MEMBERSHIP };
const TX = {} as Tx;

const EMAIL_SHA256 = createHash("sha256").update("ada@example.com").digest("hex");

const INPUT: IssueCertificateInput = {
  attestationId: ATTESTATION,
  membershipId: MEMBERSHIP,
  documentId: DOCUMENT,
  slug: "nda",
  title: "Mutual non-disclosure agreement",
  versionNo: 3,
  stamp: "nda:v3",
  bodySha256: "c".repeat(64),
  acceptedAt: new Date("2026-09-14T10:11:12.345Z"),
  acceptanceSeq: 42,
  acceptanceHash: "e".repeat(64),
  uaFamily: "firefox",
  ipHash: "d1".repeat(32),
  typedName: "Ada B. Lovelace",
  viaLinkId: LINK,
};

const FACTS: CertificateFacts = {
  workspace: { id: WS, name: "Northwind Ventures", host: "invest.northwind.example" },
  signer: { emailSha256: EMAIL_SHA256, displayName: "Ada Lovelace" },
};

let facts: CertificateFacts;
let factsCalls: number;

/** What happened, in order: the ordering is the contract (ADR-0041 D2 steps 3 then 4). */
let trace: string[] = [];
let events: AuditInput[] = [];
let objects: Map<string, { bytes: Uint8Array; options: PutOptions | undefined }>;
let seq: number;

const DEK = randomBytes(32);

const audit: AuditRecorder = {
  async record(_tx, ctx, input) {
    trace.push(`audit:${input.action}`);
    events.push(input);
    seq += 1;
    const record: AuditEventRecord = {
      id: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4aaa",
      workspaceId: ctx.workspaceId,
      seq,
      occurredAt: new Date("2026-09-14T10:11:12.400Z"),
      actorKind: "external",
      actorMembershipId: MEMBERSHIP,
      actorUserId: null,
      onBehalfOfMembershipId: null,
      action: input.action,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId ?? null,
      subjectMembershipId: input.subjectMembershipId ?? null,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
      sessionId: null,
      diff: null,
      meta: input.meta ?? {},
      prevHash: null,
      hash: `${seq}`.padStart(64, "a"),
    };
    return record;
  },
  async recordDetached() {
    throw new Error("not used");
  },
};

const crypto: EnvelopeService = {
  async currentKey() {
    trace.push("crypto:currentKey");
    return { keyId: KEY_ID, keyRef: "local:v1", purpose: "workspace-dek", key: DEK };
  },
  async keyById(_tx, _ctx, keyId) {
    return keyId === KEY_ID
      ? { keyId, keyRef: "local:v1", purpose: "workspace-dek", key: DEK }
      : undefined;
  },
  async keysFor() {
    throw new Error("not used");
  },
  async rotate() {
    throw new Error("not used");
  },
  async rewrap() {
    return 0;
  },
  invalidate() {},
  stats() {
    return { cached: 0, hits: 0, misses: 0 };
  },
};

function unsupported(): never {
  throw new Error("not used");
}

const storage: ObjectStoragePort = {
  driver: "fs",
  capabilities: { presignedGet: false, presignedMultipart: false, tus: false, ranges: false },
  async put(key: string, body: ObjectBody, options?: PutOptions): Promise<ObjectStat> {
    if (!(body instanceof Uint8Array)) throw new Error("expected bytes");
    trace.push(`put:${key}`);
    objects.set(key, { bytes: body, options });
    return {
      key,
      size: body.byteLength,
      etag: undefined,
      contentType: options?.contentType,
      lastModified: undefined,
      sha256: undefined,
      metadata: { ...(options?.metadata ?? {}) },
    };
  },
  async get(key: string): Promise<ObjectRead | undefined> {
    const hit = objects.get(key);
    if (hit === undefined) return undefined;
    trace.push(`get:${key}`);
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(hit.bytes);
          controller.close();
        },
      }),
      stat: {
        key,
        size: hit.bytes.byteLength,
        etag: undefined,
        contentType: undefined,
        lastModified: undefined,
        sha256: undefined,
        metadata: {},
      },
      range: undefined,
    };
  },
  head: unsupported,
  delete: unsupported,
  deleteMany: unsupported,
  copy: unsupported,
  list: unsupported,
  presignGet: unsupported,
  multipart: {
    create: unsupported,
    presignPart: unsupported,
    complete: unsupported,
    abort: unsupported,
  },
  healthCheck: unsupported,
};

const issuer = createCertificateIssuer({
  audit,
  crypto,
  storage,
  newId: () => CERT_ID,
  facts: async () => {
    factsCalls += 1;
    trace.push("facts");
    return facts;
  },
});

/*
 * A verbatim copy of the interface `@fundroom/compliance` declares in
 * `src/service/certificates.ts`. Neither package imports the other (contract D1/S2), so this
 * assignment is the only compile-time check that the two halves of the seam still line up. It is
 * checked by `pnpm --filter @fundroom/clickwrap typecheck`, not by vitest.
 */
interface ComplianceCertificateIssuer {
  issue(
    ctx: TenantContext,
    tx: Tx,
    input: IssueCertificateInput,
  ): Promise<{ readonly reference: string; readonly sha256: string }>;
  fetch(
    ctx: TenantContext,
    tx: Tx,
    reference: string,
    as: "json" | "pdf",
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
}
const _conformsToComplianceSeam: ComplianceCertificateIssuer = issuer;

beforeEach(() => {
  trace = [];
  events = [];
  objects = new Map();
  seq = 42;
  facts = FACTS;
  factsCalls = 0;
});

const JSON_KEY = certificateKey(WS, CERT_ID, "json");
const PDF_KEY = certificateKey(WS, CERT_ID, "pdf");

describe("issue", () => {
  it("stores both forms under the documented keys and returns the JSON's digest", async () => {
    const result = await issuer.issue(CTX, TX, INPUT);

    expect([...objects.keys()]).toEqual([JSON_KEY, PDF_KEY]);
    expect(JSON_KEY).toBe(`ws/${WS}/certificates/${CERT_ID}/certificate.json`);
    expect(result.reference).toBe(`cert:v1:${CERT_ID}:she1:${KEY_ID}`);

    const stored = objects.get(JSON_KEY)?.bytes ?? new Uint8Array();
    const canonical = Buffer.from(await decryptBytes(DEK, stored)).toString("utf8");
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(result.sha256);
    expect(canonicalize(parseCertificateDocument(canonical))).toBe(canonical);
  });

  it("writes the audit anchor before the bytes, so a storage failure rolls it back", async () => {
    await issuer.issue(CTX, TX, INPUT);
    expect(trace).toEqual([
      "facts",
      "audit:legal.certificate_issued",
      "crypto:currentKey",
      `put:${JSON_KEY}`,
      `put:${PDF_KEY}`,
    ]);
  });

  it("cites the acceptance event in the JSON and the certificate digest in the audit row", async () => {
    const result = await issuer.issue(CTX, TX, INPUT);
    const stored = objects.get(JSON_KEY)?.bytes ?? new Uint8Array();
    const doc = parseCertificateDocument(
      Buffer.from(await decryptBytes(DEK, stored)).toString("utf8"),
    );

    expect(doc.anchor).toEqual({ auditSeq: 42, auditHash: "e".repeat(64) });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("legal.certificate_issued");
    expect(events[0]?.resourceKind).toBe("certificate");
    expect(events[0]?.resourceId).toBe(CERT_ID);
    expect(events[0]?.subjectMembershipId).toBe(MEMBERSHIP);
    expect(events[0]?.meta).toEqual({
      certificateSha256: result.sha256,
      acceptanceSeq: 42,
      acceptanceHash: "e".repeat(64),
      attestationId: ATTESTATION,
      stamp: "nda:v3",
    });
  });

  it("renders the acceptance timestamp to microsecond places in UTC", async () => {
    await issuer.issue(CTX, TX, INPUT);
    const stored = objects.get(JSON_KEY)?.bytes ?? new Uint8Array();
    const canonical = Buffer.from(await decryptBytes(DEK, stored)).toString("utf8");
    expect(canonical).toContain('"acceptedAt":"2026-09-14T10:11:12.345000Z"');
  });

  it("takes the workspace and signer facts from the resolver, not from the acceptance", async () => {
    facts = {
      workspace: { id: WS, name: "Northwind Ventures", host: "deals.northwind.example" },
      signer: { emailSha256: Buffer.from(EMAIL_SHA256, "hex"), displayName: null },
    };
    await issuer.issue(CTX, TX, INPUT);
    const stored = objects.get(JSON_KEY)?.bytes ?? new Uint8Array();
    const doc = parseCertificateDocument(
      Buffer.from(await decryptBytes(DEK, stored)).toString("utf8"),
    );
    expect(factsCalls).toBe(1);
    expect(doc.workspace.host).toBe("deals.northwind.example");
    // A Buffer digest is hexed for us; a display name nobody set is an explicit null.
    expect(doc.signer.emailSha256).toBe(EMAIL_SHA256);
    expect(doc.signer.displayName).toBeNull();
  });

  it("turns an omitted optional fact into an explicit null, never a missing key", async () => {
    await issuer.issue(CTX, TX, {
      attestationId: ATTESTATION,
      membershipId: MEMBERSHIP,
      documentId: DOCUMENT,
      slug: "nda",
      title: "Mutual non-disclosure agreement",
      versionNo: 3,
      stamp: "nda:v3",
      bodySha256: "c".repeat(64),
      acceptedAt: new Date("2026-09-14T10:11:12.345Z"),
      acceptanceSeq: 42,
      acceptanceHash: "e".repeat(64),
    });
    const stored = objects.get(JSON_KEY)?.bytes ?? new Uint8Array();
    const canonical = Buffer.from(await decryptBytes(DEK, stored)).toString("utf8");
    expect(canonical).toContain('"typedName":null');
    expect(canonical).toContain('"uaFamily":null,"ipHash":null,"viaLinkId":null');
  });

  it("encrypts both objects under the workspace DEK", async () => {
    await issuer.issue(CTX, TX, INPUT);
    for (const [key, object] of objects) {
      expect(object.bytes.subarray(0, MAGIC.length), key).toEqual(MAGIC);
      // Nothing recognisable survives: no plaintext workspace name, no PDF header.
      const raw = Buffer.from(object.bytes).toString("latin1");
      expect(raw, key).not.toContain("Northwind");
      expect(raw, key).not.toContain("%PDF-");
      expect(object.options?.contentType, key).toBe("application/octet-stream");
      expect(object.options?.contentLength, key).toBe(object.bytes.byteLength);
      expect(object.options?.metadata?.["sh-format"], key).toBe("she1");
    }
    expect(objects.get(PDF_KEY)?.options?.metadata?.["sh-content-type"]).toBe("application/pdf");
  });

  it("prints the anchors of the event it actually wrote into the PDF", async () => {
    await issuer.issue(CTX, TX, INPUT);
    const stored = objects.get(PDF_KEY)?.bytes ?? new Uint8Array();
    const pdf = Buffer.from(await decryptBytes(DEK, stored));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const fetched = await issuer.fetch(CTX, TX, `cert:v1:${CERT_ID}:she1:${KEY_ID}`, "pdf");
    expect(Buffer.from(fetched?.bytes ?? []).equals(pdf)).toBe(true);
    // seq 43 is the `legal.certificate_issued` event the fake recorder assigned.
    expect(events).toHaveLength(1);
    expect(seq).toBe(43);
  });

  it("refuses an input it cannot canonicalise, before writing anything", async () => {
    await expect(
      issuer.issue(CTX, TX, { ...INPUT, uaFamily: "Mozilla/5.0 (X11; Linux x86_64)" }),
    ).rejects.toThrow(CertificateError);
    expect(trace).toEqual(["facts"]);
    expect(objects.size).toBe(0);
  });
});

describe("fetch", () => {
  it("round-trips both forms", async () => {
    const { reference } = await issuer.issue(CTX, TX, INPUT);
    const json = await issuer.fetch(CTX, TX, reference, "json");
    expect(json?.contentType).toBe("application/json");
    expect(json?.filename).toBe(`certificate-${CERT_ID}.json`);
    expect(
      parseCertificateDocument(Buffer.from(json?.bytes ?? []).toString("utf8")).certificateId,
    ).toBe(CERT_ID);

    const pdf = await issuer.fetch(CTX, TX, reference, "pdf");
    expect(pdf?.contentType).toBe("application/pdf");
    expect(pdf?.filename).toBe(`certificate-${CERT_ID}.pdf`);
  });

  it("resolves the key from the caller's workspace, never from the reference", async () => {
    const { reference } = await issuer.issue(CTX, TX, INPUT);
    const elsewhere: TenantContext = {
      workspaceId: OTHER_WS,
      actorKind: "external",
      membershipId: MEMBERSHIP,
    };
    expect(await issuer.fetch(elsewhere, TX, reference, "json")).toBeUndefined();
  });

  it("ignores a reference this package did not write", async () => {
    // The certificate really is there: what is refused is the reference, not the lookup.
    await issuer.issue(CTX, TX, INPUT);
    for (const reference of [
      "",
      "docusign:envelope:123",
      `cert:v2:${CERT_ID}:she1:${KEY_ID}`,
      `cert:v1:${CERT_ID}:aes:${KEY_ID}`,
      `cert:v1:not-a-uuid-at-all-not-a-uuid-at-all:she1:${KEY_ID}`,
    ]) {
      expect(await issuer.fetch(CTX, TX, reference, "json"), reference).toBeUndefined();
    }
  });

  it("returns undefined when the objects are gone but the reference is well formed", async () => {
    const { reference } = await issuer.issue(CTX, TX, INPUT);
    objects.clear();
    expect(await issuer.fetch(CTX, TX, reference, "json")).toBeUndefined();
  });

  it("says the key is gone rather than pretending the certificate never existed", async () => {
    await issuer.issue(CTX, TX, INPUT);
    const shredded = formatCertificateReference({
      certificateId: CERT_ID,
      keyId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a07",
    });
    await expect(issuer.fetch(CTX, TX, shredded, "json")).rejects.toThrow(CertificateError);
  });
});

describe("certificate references", () => {
  it("round-trips", () => {
    const reference = formatCertificateReference({ certificateId: CERT_ID, keyId: KEY_ID });
    expect(reference).toBe(`cert:v1:${CERT_ID}:she1:${KEY_ID}`);
    expect(parseCertificateReference(reference)).toEqual({
      certificateId: CERT_ID,
      keyId: KEY_ID,
    });
  });

  it("refuses to format one from anything but two UUIDs", () => {
    expect(() => formatCertificateReference({ certificateId: "x", keyId: KEY_ID })).toThrow(
      CertificateError,
    );
  });

  it("carries no workspace id, so it cannot point across tenants", () => {
    expect(formatCertificateReference({ certificateId: CERT_ID, keyId: KEY_ID })).not.toContain(WS);
  });
});
