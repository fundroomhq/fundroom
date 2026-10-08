import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isManualKind } from "./data-requests.js";
import {
  buildSubjectExport,
  collectModuleFiles,
  DSAR_EXPORT_KIND,
  dsarOrder,
  REDACTED_TEXT,
  subjectAuditLine,
  verifySubjectExport,
} from "./subject-export.js";

const ws = { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a", slug: "acme", name: "Acme" };
const input = {
  workspace: ws,
  membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6b",
  generatedAt: new Date("2026-09-22T10:00:00.000Z"),
  files: {
    "profile.json": '{"a":1}\n',
    "audit.jsonl": '{"seq":1}\n',
    "modules/crm.json": '{"version":1}\n',
  },
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("buildSubjectExport", () => {
  it("writes every file plus README and a manifest whose hashes match the entries", () => {
    const out = buildSubjectExport(input);
    const entries = unzipSync(out.bytes);
    expect(Object.keys(entries).sort()).toEqual([
      "README.txt",
      "audit.jsonl",
      "manifest.json",
      "modules/crm.json",
      "profile.json",
    ]);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"] as Uint8Array));
    expect(manifest).toMatchObject({
      version: 1,
      kind: DSAR_EXPORT_KIND,
      workspace: ws,
      subject: { membershipId: input.membershipId },
      generatedAt: "2026-09-22T10:00:00.000Z",
      auditTruncated: false,
    });
    expect(Object.keys(manifest.files).sort()).toEqual(
      Object.keys(entries)
        .filter((n) => n !== "manifest.json")
        .sort(),
    );
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(sha(entries[name] as Uint8Array)).toBe(digest);
    }
    expect(out.sha256).toBe(sha(out.bytes));
    expect(strFromU8(entries["README.txt"] as Uint8Array)).toContain("modules/crm.json");
  });

  it("is byte-stable for the same inputs, and any content change moves the digest", () => {
    expect(buildSubjectExport(input).sha256).toBe(buildSubjectExport(input).sha256);
    const changed = buildSubjectExport({
      ...input,
      files: { ...input.files, "profile.json": '{"a":2}\n' },
    });
    expect(changed.sha256).not.toBe(buildSubjectExport(input).sha256);
  });

  it("says when the audit log was cut", () => {
    const out = buildSubjectExport({ ...input, auditTruncated: true });
    const entries = unzipSync(out.bytes);
    expect(JSON.parse(strFromU8(entries["manifest.json"] as Uint8Array)).auditTruncated).toBe(true);
    expect(strFromU8(entries["README.txt"] as Uint8Array)).toContain("was cut");
  });
});

describe("isManualKind", () => {
  it("access and rectification are completed by hand; erasure completes itself", () => {
    expect(isManualKind("access")).toBe(true);
    expect(isManualKind("rectification")).toBe(true);
    expect(isManualKind("erasure")).toBe(false);
  });
});

describe("verifySubjectExport", () => {
  it("accepts an untouched export", () => {
    const check = verifySubjectExport(buildSubjectExport(input).bytes);
    expect(check.problems).toEqual([]);
    expect(check.files["profile.json"]).toBe('{"a":1}\n');
  });
  it("names a file whose bytes no longer match the manifest, and an unlisted one", () => {
    const entries = unzipSync(buildSubjectExport(input).bytes);
    entries["profile.json"] = strToU8('{"a":666}\n');
    entries["extra.txt"] = strToU8("x");
    const check = verifySubjectExport(zipSync(entries));
    expect(check.problems).toEqual([
      "profile.json does not match its sha256",
      "extra.txt is not in the manifest",
    ]);
  });
  it("rejects garbage", () => {
    expect(verifySubjectExport(new Uint8Array([1, 2, 3])).problems).toEqual(["not a zip archive"]);
  });
});

describe("subjectAuditLine", () => {
  const subject = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6b";
  const staff = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6c";
  const row = (actor: string | null, meta: unknown = {}, diff: unknown = null) => {
    const canonical = JSON.stringify({
      seq: 7,
      actor_membership_id: actor,
      actor_user_id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d",
      subject_membership_id: subject,
      ip: "203.0.113.0",
      user_agent: "Mozilla/5.0 staff laptop",
      session_id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6e",
      diff,
      meta,
    });
    return { seq: 7, canonical, hash: sha(strToU8(canonical)) };
  };

  it("keeps the subject's own lines verbatim, so they re-hash", () => {
    const r = row(subject, { reason: "mine" });
    expect(subjectAuditLine(r, subject)).toEqual(r);
  });

  it("strips another actor's user, session, ip, user agent and typed text, and says so", () => {
    const r = row(
      staff,
      { reason: "checking the portal", until: "x", count: 2 },
      {
        relationshipNote: { from: null, to: "met at a bar" },
        status: { from: "active", to: "suspended" },
      },
    );
    const line = subjectAuditLine(r, subject);
    const f = JSON.parse(line.canonical);
    expect(f).toMatchObject({
      actor_membership_id: staff,
      actor_user_id: null,
      session_id: null,
      ip: null,
      user_agent: null,
      meta: { reason: REDACTED_TEXT, until: "x", count: 2 },
      diff: {
        relationshipNote: REDACTED_TEXT,
        status: { from: "active", to: "suspended" },
      },
    });
    expect(line.seq).toBe(7);
    expect(line.hash).toBe(r.hash);
    expect(line.redacted).toEqual([
      "actor_user_id",
      "session_id",
      "ip",
      "user_agent",
      "meta.reason",
      "diff.relationshipNote",
    ]);
    expect(line.canonical).not.toContain("checking the portal");
    expect(line.canonical).not.toContain("met at a bar");
    expect(line.canonical).not.toContain("staff laptop");
  });

  it("treats a system line (no actor) as somebody else's", () => {
    expect(subjectAuditLine(row(null), subject).redacted).toContain("session_id");
  });
});

describe("module exporter order", () => {
  const exporter = (id: string, after?: string[]) => ({
    id,
    dsar: {
      ...(after === undefined ? {} : { after }),
      export: async ({ related }: { related: Readonly<Record<string, unknown>> }) => ({
        id,
        saw: Object.keys(related),
      }),
    },
  });

  it("runs by id, but after the exporters a module names in `after`", () => {
    const order = dsarOrder([
      exporter("round", ["crm", "missing"]),
      exporter("analytics"),
      exporter("zeta"),
      exporter("crm"),
      { id: "no-dsar" },
    ]).map((m) => m.id);
    expect(order).toEqual(["analytics", "crm", "round", "zeta"]);
    expect(dsarOrder([exporter("a", ["crm"]), exporter("crm")]).map((m) => m.id)).toEqual([
      "crm",
      "a",
    ]);
    // A cycle does not hang: id order for the modules in it.
    expect(dsarOrder([exporter("b", ["a"]), exporter("a", ["b"])]).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("hands each exporter what the modules it named exported, one transaction each", async () => {
    let transactions = 0;
    const db = {
      withTenant: async <T>(_ctx: unknown, fn: (tx: never) => Promise<T>) => {
        transactions++;
        return fn(undefined as never);
      },
    };
    const files = await collectModuleFiles(db as never, ws.id, input.membershipId, [
      exporter("a", ["crm"]),
      exporter("crm"),
    ] as never);
    expect(transactions).toBe(2);
    expect(JSON.parse(files["modules/a.json"] ?? "{}")).toEqual({ id: "a", saw: ["crm"] });
    expect(JSON.parse(files["modules/crm.json"] ?? "{}")).toEqual({ id: "crm", saw: [] });
  });
});

describe("buildSubjectExport binary entries (E3.5 signed PDFs)", () => {
  it("stores binary files byte-for-byte, lists them in the manifest and the README", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80]);
    const out = buildSubjectExport({
      ...input,
      files: { ...input.files, "esign.json": '{"version":1,"envelopes":[]}\n' },
      binaryFiles: { "esign/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6c-signed.pdf": pdf },
    });
    const entries = unzipSync(out.bytes);
    const name = "esign/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6c-signed.pdf";
    expect(entries[name]).toEqual(pdf);
    expect(out.manifest.files[name]).toBe(sha(pdf));
    expect(strFromU8(entries["README.txt"] ?? new Uint8Array())).toContain("esign/*.pdf");
    expect(verifySubjectExport(out.bytes).problems).toEqual([]);
  });

  it("a text file wins over a binary one of the same name", () => {
    const out = buildSubjectExport({
      ...input,
      binaryFiles: { "profile.json": new Uint8Array([1, 2, 3]) },
    });
    expect(strFromU8(unzipSync(out.bytes)["profile.json"] ?? new Uint8Array())).toBe('{"a":1}\n');
  });
});
