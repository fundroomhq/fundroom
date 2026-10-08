import { readFileSync } from "node:fs";
import type { PortableImportContext } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { dataRoomModule } from "./index.js";
import {
  dataRoomPortability,
  exportBlobRow,
  importBlobRow,
  NOT_EXPORTED_DETAIL,
} from "./portability.js";

const migration = ["0001_dataroom.sql", "0003_qa.sql", "0007_forensic.sql"]
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"))
  .join("\n");
const created = [...migration.matchAll(/CREATE TABLE dataroom\.(\w+)/gu)].map((m) => m[1]);

const OLD = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NEW = "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ctx: PortableImportContext = {
  workspaceId: "0190eeee-0000-7000-8000-000000000000",
  sourceWorkspaceId: "0190dddd-0000-7000-8000-000000000000",
  now: new Date(),
  mapId: (id) => (id === OLD ? NEW : id),
  remapLtree: (p) => p.replaceAll(OLD.replaceAll("-", ""), NEW.replaceAll("-", "")),
  remapKey: (k) => k,
};

describe("data-room portability spec", () => {
  it("covers every dataroom table exactly once", () => {
    expect(created.length).toBeGreaterThan(0);
    expect(dataRoomPortability.tables.map((t) => t.table).sort()).toEqual([...created].sort());
    expect(dataRoomModule.portability).toBe(dataRoomPortability);
  });

  it("lists tables in FK order (a referenced table comes first; the deferred current_version_id aside)", () => {
    const order = dataRoomPortability.tables.map((t) => t.table);
    for (const block of migration.split(/CREATE TABLE /u).slice(1)) {
      const name = /^dataroom\.(\w+)/u.exec(block)?.[1] ?? "";
      const body = block.split(/\n\);/u)[0] ?? "";
      for (const ref of body.matchAll(/REFERENCES dataroom\.(\w+)/gu)) {
        if (ref[1] === name) continue;
        expect(order.indexOf(ref[1] ?? ""), `${name} → ${ref[1]}`).toBeLessThan(
          order.indexOf(name),
        );
      }
    }
  });

  it("carries the tree, blobs, documents and versions; skips derived and transient tables", () => {
    const modes = Object.fromEntries(
      dataRoomPortability.tables.map((t) => [t.table, t.mode === "skip" ? t.reason : "rows"]),
    );
    expect(modes).toEqual({
      folder: "rows",
      blob: "rows",
      document: "rows",
      document_version: "rows",
      qa_question: "rows",
      qa_answer: "rows",
      rendition: "derived",
      page_text: "derived",
      upload: "transient",
      forensic_mark: "instance-local",
    });
    const blob = dataRoomPortability.tables.find((t) => t.table === "blob");
    expect(blob?.blobs).toEqual([
      {
        keyColumn: "storage_key",
        encryptionColumn: "encryption",
        purpose: "workspace-dek",
        sha256Column: "sha256",
      },
    ]);
    expect(dataRoomPortability.afterImport).toBeTypeOf("function");
  });

  it("remaps the ltree folder paths the generic id remap cannot see", () => {
    const hex = OLD.replaceAll("-", "");
    const folder = dataRoomPortability.tables.find((t) => t.table === "folder");
    const document = dataRoomPortability.tables.find((t) => t.table === "document");
    expect(folder?.importRow?.({ id: NEW, path: `r.${hex}` }, ctx)).toEqual({
      id: NEW,
      path: `r.${NEW.replaceAll("-", "")}`,
    });
    expect(folder?.importRow?.({ id: NEW, path: "r" }, ctx)).toEqual({ id: NEW, path: "r" });
    expect(document?.importRow?.({ folder_path: `r.${hex}.${hex}` }, ctx)).toEqual({
      folder_path: `r.${NEW.replaceAll("-", "")}.${NEW.replaceAll("-", "")}`,
    });
  });

  it("exports the bytes of promoted blobs only (never a quarantined or infected object)", () => {
    const clean = { id: OLD, scan_status: "clean", storage_key: "ws/x/blobs/ab" };
    expect(exportBlobRow(clean)).toBe(clean);
    expect(exportBlobRow({ ...clean, scan_status: "skipped" })).toEqual({
      ...clean,
      scan_status: "skipped",
    });
    for (const s of ["pending", "scanning", "error", "infected"]) {
      expect(exportBlobRow({ ...clean, scan_status: s })["storage_key"]).toBeNull();
    }
  });

  it("gives an unexported blob a placeholder key and marks it failed on import", () => {
    const kept = { id: NEW, storage_key: `ws/${ctx.workspaceId}/blobs/ab`, scan_status: "clean" };
    expect(importBlobRow(kept, ctx)).toBe(kept);
    expect(importBlobRow({ id: NEW, storage_key: null, scan_status: "infected" }, ctx)).toEqual({
      id: NEW,
      storage_key: `ws/${ctx.workspaceId}/quarantine/not-exported-${NEW}`,
      encryption: {},
      scan_status: "error",
      scan_detail: NOT_EXPORTED_DETAIL,
    });
  });

  it("drops the kernel envelope link from exported documents (E3.5: envelopes are not exported)", () => {
    const spec = dataRoomPortability.tables.find((t) => t.table === "document");
    const row = { id: OLD, title: "SAFE — signed", esign_envelope_id: NEW, legal_hold: true };
    expect(spec?.exportRow?.(row)).toEqual({ ...row, esign_envelope_id: null });
    const plain = { id: OLD, title: "Deck" };
    expect(spec?.exportRow?.(plain)).toEqual(plain);
  });
});
