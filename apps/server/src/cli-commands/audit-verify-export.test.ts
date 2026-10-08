import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportBundle, exportSigningKey } from "@fundroom/audit";
import type { KeyRing, KeyRingEntry } from "@fundroom/config";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAuditVerifyExport } from "./audit-verify-export.js";

/*
 * `fundroom audit verify-export` exit codes (E2.7 M2/L5): 0 verified against a trusted key,
 * 1 failed, 2 usage, 3 intact but unpinned ("UNVERIFIED ORIGIN").
 */
function entry(id: string, fill: number): KeyRingEntry {
  return { id, key: new Uint8Array(32).fill(fill), fingerprint: `sha256:${id}` };
}
const ringOf = (...entries: KeyRingEntry[]): KeyRing => ({
  current: entries[0] as KeyRingEntry,
  entries,
  get: (id) => entries.find((e) => e.id === id),
});
const OLD = entry("v1", 1);
const NEW = entry("v2", 2);
const pub = (e: KeyRingEntry) => Buffer.from(exportSigningKey(e).publicKey).toString("base64");

let file: string;
let output: string[];

beforeAll(() => {
  const bundle = buildExportBundle({
    workspace: { id: "0190f1a0-0000-7000-8000-000000000001", slug: "acme", name: "Acme" },
    generatedAt: new Date("2026-09-22T12:00:00.000Z"),
    generatedBy: { membershipId: null },
    range: { from: null, to: null },
    rows: [],
    prevHash: null,
    checkpoints: [],
    signingKey: exportSigningKey(OLD),
  });
  file = join(mkdtempSync(join(tmpdir(), "fundroom-verify-")), "bundle.zip");
  writeFileSync(file, bundle.bytes);
});

function capture() {
  output = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    output.push(a.map(String).join(" "));
  });
}
afterEach(() => vi.restoreAllMocks());

describe("fundroom audit verify-export", () => {
  it("with no key and no config: UNVERIFIED ORIGIN on its own line, exit 3", async () => {
    capture();
    expect(await runAuditVerifyExport([file])).toBe(3);
    const lines = output.join("\n").split("\n");
    expect(lines.some((l) => l.startsWith("UNVERIFIED ORIGIN — "))).toBe(true);
    expect(output.join("\n")).not.toContain(pub(OLD));
  });

  it("pinned to the right --public-key: exit 0", async () => {
    capture();
    expect(await runAuditVerifyExport([file, "--public-key", pub(OLD)])).toBe(0);
    expect(output.join("\n")).not.toContain("UNVERIFIED ORIGIN");
  });

  it("pinned to the wrong key: exit 1", async () => {
    capture();
    expect(await runAuditVerifyExport([file, "--public-key", pub(NEW)])).toBe(1);
  });

  it("the config ring trusts its current keys; a key since removed needs --public-key", async () => {
    capture();
    expect(await runAuditVerifyExport([file], { keyRing: ringOf(NEW, OLD) })).toBe(0);
    // v1 rotated out of the ring: the bundle no longer verifies against the config alone…
    expect(await runAuditVerifyExport([file], { keyRing: ringOf(NEW) })).toBe(1);
    // …but does against the key recorded at export time.
    expect(
      await runAuditVerifyExport([file, "--public-key", pub(OLD)], { keyRing: ringOf(NEW) }),
    ).toBe(0);
  });

  it("usage errors exit 2", async () => {
    capture();
    expect(await runAuditVerifyExport([])).toBe(2);
    expect(await runAuditVerifyExport([join(tmpdir(), "no-such-bundle.zip")])).toBe(2);
  });
});
