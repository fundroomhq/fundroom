import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { createVerificationService } from "./verification.js";

/*
 * Accreditation verification, with the kernel standing in.
 *
 * Three rules from design/04 are pinned here and each is a compliance requirement rather than a
 * product choice: `verified` without evidence is refused (§1.6); the evidence is scanned and
 * encrypted before it is written, and never named in an audit row (§102); and the file is purged
 * `evidenceRetentionDays` after the *decision*, while the decision itself survives.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const MEMBER = "01920000-0000-7000-8000-0000000000d1";
const STAFF = "01920000-0000-7000-8000-0000000000d9";
const VERIFICATION = "01920000-0000-7000-8000-0000000000c1";
const tenant: TenantContext = { workspaceId: WORKSPACE, actorKind: "staff", membershipId: STAFF };
const external: TenantContext = {
  workspaceId: WORKSPACE,
  actorKind: "external",
  membershipId: MEMBER,
};
const NOW = new Date("2026-03-15T12:00:00.000Z");
const actor = { membershipId: STAFF, requestId: "req-1", sessionId: "sess-1" };

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

const row = (over: Record<string, unknown> = {}) => ({
  id: VERIFICATION,
  membershipId: MEMBER,
  interestSubmissionId: null,
  provider: "manual",
  providerRef: null,
  method: null,
  status: "pending",
  evidenceKey: null,
  evidenceSha256: null,
  evidenceContentType: null,
  evidenceBytes: null,
  evidenceNote: null,
  evidenceUploadedAt: null,
  evidencePurgedAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  expiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

interface HarnessOptions {
  readonly row?: Record<string, unknown> | null | undefined;
  readonly verdict?: "clean" | "infected" | "error" | "skipped" | undefined;
  readonly retentionDays?: number | undefined;
  readonly due?: Record<string, unknown>[] | undefined;
  readonly deleteThrows?: boolean | undefined;
  readonly uploadMaxBytes?: number | undefined;
  readonly stored?: Uint8Array | undefined;
  readonly erased?: boolean | undefined;
}

function harness(options: HarnessOptions = {}) {
  const audits: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const deleted: string[] = [];
  const recorded: unknown[] = [];
  const purged: string[] = [];
  const statements: string[] = [];

  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query).replace(/\s+/gu, " ").trim();
      statements.push(text);
      if (text.includes("SELECT settings FROM core.workspace")) {
        return {
          rows: [{ settings: { round: { evidenceRetentionDays: options.retentionDays ?? 90 } } }],
        };
      }
      if (text.includes("evidence_purged_at IS NULL AND decided_at IS NOT NULL")) {
        return { rows: (options.due ?? []).map((d) => row(d)) };
      }
      if (text.includes("UPDATE round.verification SET evidence_key = NULL")) {
        purged.push(VERIFICATION);
        return { rows: [] };
      }
      if (text.includes("UPDATE round.verification SET evidence_key =")) {
        return { rows: [row({ ...options.row, evidenceKey: "k", status: "pending" })] };
      }
      if (text.includes("UPDATE round.verification SET status =")) {
        return { rows: [row({ ...options.row, status: "verified" })] };
      }
      if (text.includes("FROM round.verification")) {
        return { rows: options.row === null ? [] : [row(options.row)] };
      }
      return { rows: [] };
    },
    // `publish` writes to the outbox through drizzle's builder rather than `execute`.
    insert: () => tx,
    values: () => tx,
    returning: async () => [{ id: 1 }],
  };

  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    limits: { uploadMaxBytes: options.uploadMaxBytes ?? 50 * 1024 * 1024 },
    scanner: {
      async scan() {
        return { verdict: options.verdict ?? "clean", engine: "noop" };
      },
    },
    crypto: {
      async currentKey() {
        return {
          keyId: "key-a",
          keyRef: "local",
          purpose: "round.evidence",
          key: new Uint8Array(32).fill(7),
        };
      },
      // A retired key the object was sealed under before a rotation (E2.8 descriptor).
      async keyById(_tx: unknown, _ctx: unknown, keyId: string) {
        return keyId === "key-old"
          ? { keyId, keyRef: "local", purpose: "round.evidence", key: new Uint8Array(32).fill(9) }
          : undefined;
      },
    },
    storage: {
      async put(key: string, bytes: Uint8Array) {
        puts.push({ key, bytes });
        return { key, size: bytes.byteLength };
      },
      async get() {
        return options.stored === undefined
          ? undefined
          : { body: new Response(options.stored).body, stat: {} };
      },
      async delete(key: string) {
        if (options.deleteThrows === true) throw new Error("bucket down");
        deleted.push(key);
      },
    },
    legal: {
      async isErased() {
        return options.erased ?? false;
      },
      async recordVerifiedAccreditation(_tx: unknown, _ctx: unknown, input: unknown) {
        recorded.push(input);
        return { attestationId: "att-1" };
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: Record<string, unknown>) {
        audits.push(input);
        return {};
      },
    },
    accreditation: { driver: "manual", requires: { evidenceUpload: true, adminDecision: true } },
    now: () => NOW,
    log: (event: string) => logs.push(event),
  } as unknown as ModuleServices;

  return { services, audits, logs, puts, deleted, recorded, purged, statements };
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("evidence upload", () => {
  const upload = (
    h: ReturnType<typeof harness>,
    over: Partial<{ bytes: Uint8Array; contentType: string }> = {},
  ) =>
    createVerificationService(h.services).uploadEvidence(
      external,
      VERIFICATION,
      MEMBER,
      { bytes: pdf, contentType: "application/pdf", ...over },
      { membershipId: MEMBER },
    );

  it("records which key sealed the object (E2.8: rotation and workspace export follow it)", async () => {
    const h = harness();
    await upload(h);
    expect(h.statements.some((s) => s.includes("evidence_encryption ="))).toBe(true);
  });

  it("scans, encrypts and stores under the module's own key", async () => {
    const h = harness();
    await upload(h);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]?.key).toBe(`round/verification/${WORKSPACE}/${VERIFICATION}`);
    // The ciphertext, not the plaintext: nothing downstream may be tempted to serve these
    // bytes to a browser as a PDF.
    expect(h.puts[0]?.bytes).not.toEqual(pdf);
    expect(h.puts[0]?.bytes.byteLength).toBeGreaterThan(pdf.byteLength);
  });

  it("audits the sha256 and the size, and never the file name or the key", async () => {
    const h = harness();
    await upload(h);
    const audit = h.audits.find((a) => a["action"] === "round.evidence_uploaded");
    expect(audit?.["meta"]).toMatchObject({
      bytes: 4,
      contentType: "application/pdf",
      scan: "clean",
    });
    expect(JSON.stringify(audit?.["meta"])).not.toContain("round/verification");
  });

  it("refuses anything but a PDF, a PNG or a JPEG", async () => {
    await expect(upload(harness(), { contentType: "image/svg+xml" })).rejects.toMatchObject({
      code: "unsupported_media_type",
    });
  });

  it("refuses an empty upload", async () => {
    await expect(upload(harness(), { bytes: new Uint8Array(0) })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("applies the deployment's upload limit when it is the smaller one", async () => {
    // 10 MiB is the module's own ceiling; an operator who set a tighter one meant it.
    const h = harness({ uploadMaxBytes: 2 });
    await expect(upload(h)).rejects.toMatchObject({
      code: "payload_too_large",
      details: { limitBytes: 2 },
    });
  });

  it("refuses a file the scanner would not pass, and stores nothing", async () => {
    const h = harness({ verdict: "infected" });
    await expect(upload(h)).rejects.toMatchObject({ code: "scan_failed" });
    expect(h.puts).toEqual([]);
    expect(h.logs).toContain("round.evidence_rejected");
  });

  it("refuses a scanner that could not answer, rather than trusting the file", async () => {
    await expect(upload(harness({ verdict: "error" }))).rejects.toMatchObject({
      code: "scan_failed",
    });
  });

  it("answers not_found for somebody else's verification", async () => {
    // Ownership is checked explicitly because the RLS UPDATE policy is deliberately narrow: one
    // wide enough to let an investor write `evidence_key` would be wide enough to let them
    // write `status`.
    const h = harness({ row: { membershipId: STAFF } });
    await expect(upload(h)).rejects.toMatchObject({ code: "not_found" });
    expect(h.puts).toEqual([]);
  });

  it("refuses an upload against a vendor verification (E3.7: the vendor settles it), storing nothing", async () => {
    const h = harness({ row: { provider: "verifyinvestor", providerRef: "inv:1" } });
    await expect(upload(h)).rejects.toMatchObject({ code: "conflict" });
    expect(h.puts).toEqual([]);
  });

  it("refuses an upload against a verification that is already decided", async () => {
    await expect(upload(harness({ row: { status: "verified" } }))).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("the decision", () => {
  const decide = (h: ReturnType<typeof harness>, input: Record<string, unknown>) =>
    createVerificationService(h.services).decide(tenant, VERIFICATION, input as never, actor);

  it("needs a method to record `verified`", async () => {
    await expect(decide(harness(), { status: "verified" })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "method" },
    });
  });

  it("needs a file for a document review", async () => {
    // "I saw a bank statement" is a claim about evidence, not evidence (design/04 §1.6).
    await expect(
      decide(harness(), { status: "verified", method: "document_review", note: "saw it" }),
    ).rejects.toMatchObject({ code: "evidence_required" });
  });

  it("needs a file for a professional letter", async () => {
    await expect(
      decide(harness(), { status: "verified", method: "professional_letter" }),
    ).rejects.toMatchObject({ code: "evidence_required" });
  });

  it("takes a note for a third-party check", async () => {
    const h = harness();
    await decide(h, { status: "verified", method: "third_party", note: "Bureau ref 41-9" });
    expect(h.recorded).toHaveLength(1);
  });

  it("refuses a third-party check with neither a note nor a file", async () => {
    await expect(
      decide(harness(), { status: "verified", method: "third_party" }),
    ).rejects.toMatchObject({ code: "evidence_required", details: { field: "note" } });
  });

  it("names the file when there is one and the note's hash when there is not", async () => {
    const withFile = harness({ row: { evidenceKey: "round/verification/w/v" } });
    await decide(withFile, { status: "verified", method: "document_review" });
    expect(withFile.recorded[0]).toMatchObject({
      evidenceRef: "storage:round/verification/w/v",
    });

    const withNote = harness();
    await decide(withNote, { status: "verified", method: "minimum_investment", note: "reps" });
    // `note:<sha256>` names the exact text without copying a private note into a kernel table.
    expect(withNote.recorded[0]).toMatchObject({
      evidenceRef: expect.stringMatching(/^note:[0-9a-f]{64}$/u),
    });
  });

  it("expires a professional letter after 90 days and everything else after twelve months", async () => {
    const letter = harness({ row: { evidenceKey: "k" } });
    await decide(letter, { status: "verified", method: "professional_letter" });
    expect((letter.recorded[0] as { expiresAt: Date }).expiresAt.toISOString()).toBe(
      "2026-06-13T12:00:00.000Z",
    );

    const review = harness({ row: { evidenceKey: "k" } });
    await decide(review, { status: "verified", method: "document_review" });
    expect((review.recorded[0] as { expiresAt: Date }).expiresAt.toISOString()).toBe(
      "2027-03-15T12:00:00.000Z",
    );
  });

  it("honours an explicit expiry", async () => {
    const h = harness({ row: { evidenceKey: "k" } });
    await decide(h, {
      status: "verified",
      method: "document_review",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect((h.recorded[0] as { expiresAt: Date }).expiresAt.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("writes the attestation through the legal seam, never by touching core.attestation", async () => {
    const h = harness({ row: { evidenceKey: "k" } });
    await decide(h, { status: "verified", method: "document_review" });
    expect(h.recorded[0]).toMatchObject({ membershipId: MEMBER, method: "document_review" });
    expect(h.statements.some((x) => x.includes("attestation"))).toBe(false);
  });

  it("writes no attestation for a rejection, and needs no method for one", async () => {
    const h = harness();
    await decide(h, { status: "rejected", note: "could not confirm" });
    expect(h.recorded).toEqual([]);
    expect(h.audits.map((a) => a["action"])).toEqual(["round.verification_decided"]);
  });

  it("records no accreditation for an erased member, but still lets staff reject (E3.7)", async () => {
    const h = harness({ erased: true });
    await expect(
      createVerificationService(h.services).decide(
        tenant,
        VERIFICATION,
        { status: "verified", method: "third_party", note: "bureau ref 1" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "member_erased" });
    expect(h.recorded).toEqual([]);
    await expect(
      createVerificationService(h.services).decide(
        tenant,
        VERIFICATION,
        { status: "rejected" },
        actor,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses to decide a verification twice", async () => {
    await expect(
      decide(harness({ row: { status: "verified" } }), { status: "rejected" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers not_found for a verification that is not there", async () => {
    await expect(decide(harness({ row: null }), { status: "rejected" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("reading the evidence", () => {
  it("answers not_found once the file has been purged", async () => {
    // The decision, its method and the sha256 of what was read survive the purge; the file does
    // not, and a 404 is the honest answer.
    const h = harness({ row: { evidenceKey: null, evidencePurgedAt: NOW } });
    await expect(
      createVerificationService(h.services).readEvidence(tenant, VERIFICATION, actor),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("decrypts with the key the descriptor names, and falls back to the current key without one", async () => {
    const { encryptBytes } = await import("@fundroom/crypto");
    const sealedOld = await encryptBytes(new Uint8Array(32).fill(9), pdf);
    const described = harness({
      row: {
        evidenceKey: "k",
        evidenceEncryption: { format: "she1", keyId: "key-old", keyRef: "local" },
      },
      stored: sealedOld,
    });
    const read = await createVerificationService(described.services).readEvidence(
      tenant,
      VERIFICATION,
      actor,
    );
    expect([...read.bytes]).toEqual([...pdf]);

    const sealedCurrent = await encryptBytes(new Uint8Array(32).fill(7), pdf);
    const legacy = harness({
      row: { evidenceKey: "k", evidenceEncryption: null },
      stored: sealedCurrent,
    });
    expect(
      (await createVerificationService(legacy.services).readEvidence(tenant, VERIFICATION, actor))
        .bytes,
    ).toEqual(Buffer.from(pdf));

    const lost = harness({
      row: { evidenceKey: "k", evidenceEncryption: { format: "she1", keyId: "gone", keyRef: "x" } },
      stored: sealedOld,
    });
    await expect(
      createVerificationService(lost.services).readEvidence(tenant, VERIFICATION, actor),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers not_found, not 500, when the row and the bucket disagree", async () => {
    const h = harness({ row: { evidenceKey: "k" } });
    await expect(
      createVerificationService(h.services).readEvidence(tenant, VERIFICATION, actor),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(h.logs).toContain("round.evidence_missing");
  });
});

describe("the purge", () => {
  const purge = (h: ReturnType<typeof harness>) =>
    createVerificationService(h.services).purge(WORKSPACE);

  it("does nothing when nothing is due", async () => {
    const h = harness({ due: [] });
    expect(await purge(h)).toBe(0);
    expect(h.deleted).toEqual([]);
  });

  it("deletes the object, clears the key and stamps the row", async () => {
    const h = harness({ due: [{ evidenceKey: "round/verification/w/v", decidedAt: NOW }] });
    expect(await purge(h)).toBe(1);
    expect(h.deleted).toEqual(["round/verification/w/v"]);
    expect(h.purged).toEqual([VERIFICATION]);
  });

  it("audits the purge with the sha256 and the retention window it applied", async () => {
    const h = harness({
      retentionDays: 30,
      due: [{ evidenceKey: "k", decidedAt: NOW, evidenceSha256: "deadbeef" }],
    });
    await purge(h);
    expect(h.audits[0]).toMatchObject({
      action: "round.evidence_purged",
      actorKind: "system",
      subjectMembershipId: MEMBER,
      meta: expect.objectContaining({ sha256: "deadbeef", retentionDays: 30 }),
    });
  });

  it("selects on the decision's age, not the upload's", async () => {
    /*
     * design/04 §102: the evidence expires *after the decision*. A file uploaded in January
     * against a decision taken in June has to be readable while the decision is being made, so
     * the cut-off is `now - retentionDays` compared against `decided_at`.
     */
    const h = harness({ retentionDays: 30, due: [] });
    await purge(h);
    const select = h.statements.find((x) => x.includes("evidence_purged_at IS NULL"));
    const where = select?.slice(select.indexOf("WHERE"));
    expect(where).toContain("decided_at <");
    expect(where).not.toContain("evidence_uploaded_at");
  });

  it("keeps going when one object cannot be removed, and leaves its key for the next run", async () => {
    const h = harness({ deleteThrows: true, due: [{ evidenceKey: "k", decidedAt: NOW }] });
    expect(await purge(h)).toBe(0);
    expect(h.purged).toEqual([]);
    expect(h.logs).toContain("round.evidence_purge_failed");
  });
});
