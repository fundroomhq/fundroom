import type { TenantContext, Tx } from "@fundroom/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `accept()` with `method: "esign"` (E3.5): the e-sign NDA's evidence reference is recorded as
 * given and the click-wrap certificate issuer is never called (it would overwrite it); a
 * click-wrap acceptance of a document whose ceremony is `esign` is refused. Repositories are
 * replaced by in-memory fakes; the DB-backed path is covered by the server integration tests.
 */

const mem = vi.hoisted(() => ({
  doc: undefined as undefined | Record<string, unknown>,
  attestations: [] as Record<string, unknown>[],
  published: [] as string[],
}));

vi.mock("../repos/compliance-repo.js", () => ({
  LegalDocumentRepo: class {
    async byId() {
      return mem.doc;
    }
  },
  LegalDocumentVersionRepo: class {
    async byNo(_doc: string, versionNo: number) {
      return versionNo === 2
        ? { id: "v2", versionNo: 2, bodySha256: Buffer.alloc(32, 1) }
        : undefined;
    }
  },
  AcceptanceRegisterRepo: class {},
  MAX_REGISTER_ROWS: 1000,
}));
vi.mock("@fundroom/identity", () => ({
  AttestationRepo: class {
    async current() {
      return undefined;
    }
    async record(values: Record<string, unknown>) {
      const row = { id: `att-${mem.attestations.length + 1}`, ...values };
      mem.attestations.push(row);
      return row;
    }
    async setEvidenceRef(id: string, ref: string) {
      const row = mem.attestations.find((a) => a["id"] === id);
      if (row) row["evidenceRef"] = ref;
      return row;
    }
  },
}));
vi.mock("@fundroom/events", () => ({
  publish: async (_tx: unknown, _ctx: unknown, topic: string) => {
    mem.published.push(topic);
    return 1;
  },
}));
vi.mock("@fundroom/db", async (orig) => ({
  ...(await orig<typeof import("@fundroom/db")>()),
  bumpAclVersionInTx: async () => 1,
}));

const { createAcceptanceService, ESIGN_EVIDENCE_REF_RE } = await import("./acceptances.js");

const ctx: TenantContext = {
  workspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  actorKind: "system",
};
const tx = {} as Tx;
const ENV = "0199a000-0000-7000-8000-000000000001";
const MEMBER = "0199a000-0000-7000-8000-0000000000b1";

function service() {
  const issued: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const svc = createAcceptanceService({
    db: {} as never,
    audit: {
      record: async (_t, _c, input) => {
        audits.push(input as never);
        return { seq: audits.length, hash: "h" } as never;
      },
      recordDetached: async () => ({}) as never,
    },
    certificates: {
      issue: async (_c, _t, input) => {
        issued.push(input);
        return { reference: "cert:v1:x:she1:y", sha256: "s" };
      },
      fetch: async () => undefined,
    },
  });
  return { svc, issued, audits };
}

beforeEach(() => {
  mem.attestations = [];
  mem.published = [];
  mem.doc = {
    id: "doc",
    slug: "nda",
    title: "NDA",
    kind: "nda",
    ceremony: "esign",
    currentVersionId: "v2",
  };
});

describe("accept() with method esign", () => {
  it("records esign:v1:<envelopeId> as evidence, marks the data, and issues no click-wrap certificate", async () => {
    const { svc, issued, audits } = service();
    const out = await svc.accept(ctx, tx, {
      membershipId: MEMBER,
      documentId: "doc",
      versionNo: 2,
      evidence: { evidenceRef: `esign:v1:${ENV}`, method: "esign" },
    });
    expect(out.recorded).toBe(true);
    expect(out.certificateSha256).toBeUndefined();
    expect(issued).toEqual([]);
    expect(out.attestation.evidenceRef).toBe(`esign:v1:${ENV}`);
    expect((out.attestation.data as Record<string, unknown>)["method"]).toBe("esign");
    expect(audits[0]?.["meta"]).toMatchObject({ method: "esign", evidenceRef: `esign:v1:${ENV}` });
    expect(mem.published).toEqual(["legal.accepted"]);
  });

  it("refuses an esign acceptance without a well-formed esign reference", async () => {
    const { svc } = service();
    await expect(
      svc.accept(ctx, tx, {
        membershipId: MEMBER,
        documentId: "doc",
        versionNo: 2,
        evidence: { evidenceRef: "cert:v1:whatever", method: "esign" },
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(ESIGN_EVIDENCE_REF_RE.test(`esign:v1:${ENV}`)).toBe(true);
    expect(ESIGN_EVIDENCE_REF_RE.test(`esign:v1:${ENV}x`)).toBe(false);
  });

  it("refuses click-wrap on a document whose ceremony is esign", async () => {
    const { svc } = service();
    await expect(
      svc.accept(ctx, tx, { membershipId: MEMBER, documentId: "doc", versionNo: 2 }),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "esign_required" } });
    expect(mem.attestations).toEqual([]);
  });

  it("click-wrap on a click-wrap document still gets its certificate (format unchanged)", async () => {
    mem.doc = { ...mem.doc, ceremony: "clickwrap" };
    const { svc, issued } = service();
    const out = await svc.accept(ctx, tx, {
      membershipId: MEMBER,
      documentId: "doc",
      versionNo: 2,
    });
    expect(issued).toHaveLength(1);
    expect(out.attestation.evidenceRef).toBe("cert:v1:x:she1:y");
    expect((out.attestation.data as Record<string, unknown>)["method"]).toBeUndefined();
  });
});
