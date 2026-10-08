import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { EVIDENCE_KEY_PURPOSE, evidenceKeyFor } from "./model.js";
import {
  exportVendorColumns,
  exportVerificationRow,
  importVerificationRow,
  roundPortability,
} from "./portability.js";
import {
  closingTask,
  commitment,
  interestSubmission,
  round,
  signatureRequest,
  terms,
  verification,
} from "./schema/round.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const DESCRIPTOR = { format: "she1", keyId: "k1", keyRef: "local" };

describe("round portability spec", () => {
  it("lists every table of the schema in FK order, all carried as rows", () => {
    const tables = [
      round,
      terms,
      interestSubmission,
      verification,
      commitment,
      closingTask,
      signatureRequest,
    ].map((t) => getTableConfig(t).name);
    expect(roundPortability.tables.map((t) => t.table)).toEqual(tables);
    // E3.5: signature requests mirror vendor-bound kernel envelopes and stay behind.
    expect(roundPortability.tables.filter((t) => t.mode !== "rows").map((t) => t.table)).toEqual([
      "signature_request",
    ]);
  });

  it("verification carries the evidence object, re-sealed under the module's purpose", () => {
    const spec = roundPortability.tables.find((t) => t.table === "verification");
    expect(spec?.blobs).toEqual([
      {
        keyColumn: "evidence_key",
        encryptionColumn: "evidence_encryption",
        purpose: EVIDENCE_KEY_PURPOSE,
        optional: true,
      },
    ]);
    // Lives outside `ws/`; `ctx.remapKey` rewrites every uuid in it, so both halves move.
    expect(evidenceKeyFor("w", "v")).toBe("round/verification/w/v");
  });

  it("exportRow keeps a sealed-and-described object and rows without a file as they are", () => {
    const described = { evidence_key: "round/verification/w/v", evidence_encryption: DESCRIPTOR };
    expect(exportVerificationRow(described, NOW)).toBe(described);
    const none = { evidence_key: null, evidence_encryption: null, evidence_sha256: "ab" };
    expect(exportVerificationRow(none, NOW)).toBe(none);
  });

  it("exportRow leaves behind a file whose sealing key was never recorded, marking it gone", () => {
    const legacy = {
      status: "verified",
      evidence_key: "round/verification/w/v",
      evidence_encryption: null,
      evidence_sha256: "ab",
      evidence_purged_at: null,
    };
    expect(exportVerificationRow(legacy, NOW)).toEqual({
      ...legacy,
      evidence_key: null,
      evidence_purged_at: NOW.toISOString(),
    });
    // The digest stays, so `verification_verified_has_evidence` still holds on import.
    expect(exportVerificationRow(legacy, NOW)["evidence_sha256"]).toBe("ab");
  });
});

describe("vendor verifications (E3.7)", () => {
  const vendorRow = {
    provider: "parallel-markets",
    provider_ref: "VXNlcjox",
    vendor_status: "pending",
    next_check_at: "2026-09-23T12:05:00.000Z",
    handoff: { kind: "widget", sdk: "parallel-markets", config: { clientId: "c" } },
    reverification_of: null,
  };

  it("leave their handoff behind: it configures this install's vendor connection", () => {
    expect(exportVendorColumns(vendorRow)).toEqual({ ...vendorRow, handoff: null });
    const spec = roundPortability.tables.find((t) => t.table === "verification");
    expect(spec?.exportRow?.(vendorRow)?.["handoff"]).toBeNull();
  });

  it("are never polled after an import (the target has no connection the ref means anything to)", () => {
    const imported = importVerificationRow(vendorRow);
    expect(imported).toMatchObject({
      next_check_at: null,
      handoff: null,
      vendor_error: "imported",
    });
    // A manual row is nobody's vendor row: left alone.
    expect(importVerificationRow({ provider: "manual", vendor_error: null })).toMatchObject({
      vendor_error: null,
    });
    // The vendor's facts travel: the provider, its ref and its last answer.
    expect(imported).toMatchObject({ provider_ref: "VXNlcjox", vendor_status: "pending" });
    const spec = roundPortability.tables.find((t) => t.table === "verification");
    expect(spec?.importRow).toBeDefined();
  });
});
