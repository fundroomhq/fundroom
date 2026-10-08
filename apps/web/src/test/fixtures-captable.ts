import type {
  CaptableClassSummary,
  CaptableHolder,
  CaptableImportPreview,
  CaptableMe,
  CaptableSettings,
  CaptableSnapshot,
  CaptableSnapshotDetail,
  CaptableSummary,
} from "../lib/captable-queries.js";

/*
 * Cap table fixtures (E3.6). Typed against the hand-written mirrors in
 * `lib/captable-queries.ts` until the SDK is regenerated, like `fixtures-round.ts`.
 *
 * Reproduced on purpose from the real responses: **every figure is a decimal string** with the
 * database's six places (`"8000000.000000"`), and the totals are consistent — fully diluted is
 * the sum of the classes' fully diluted shares, the pool counts only its unissued part — so a
 * test cannot assert against a summary whose parts do not add up.
 */

export const SNAPSHOT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a01";
export const PUBLISHED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a02";
export const SUPERSEDED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a03";
export const INVESTOR_MEMBERSHIP_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a04";

export function captableClass(over: Partial<CaptableClassSummary> = {}): CaptableClassSummary {
  return {
    name: "Common",
    kind: "common",
    position: 0,
    shares: "8000000.000000",
    fullyDilutedShares: "8000000.000000",
    percentFullyDiluted: "72.7273",
    amounts: [],
    holders: 2,
    lines: 2,
    ...over,
  };
}

/** 8,000,000 common + 2,000,000 seed preferred + 400,000 granted + 600,000 unissued = 11,000,000. */
export function captableSummary(over: Partial<CaptableSummary> = {}): CaptableSummary {
  return {
    fullyDilutedShares: "11000000.000000",
    classes: [
      captableClass(),
      captableClass({
        name: "Series Seed Preferred",
        kind: "preferred",
        position: 1,
        shares: "2000000.000000",
        fullyDilutedShares: "2000000.000000",
        percentFullyDiluted: "18.1818",
        holders: 1,
        lines: 1,
      }),
      captableClass({
        name: "2024 Stock Plan",
        kind: "option_pool",
        position: 2,
        shares: "1000000.000000",
        fullyDilutedShares: "600000.000000",
        percentFullyDiluted: "5.4545",
        holders: 0,
        lines: 1,
      }),
      captableClass({
        name: "Options",
        kind: "option",
        position: 3,
        shares: "400000.000000",
        fullyDilutedShares: "400000.000000",
        percentFullyDiluted: "3.6364",
        holders: 1,
        lines: 1,
      }),
      captableClass({
        name: "Post-money SAFE",
        kind: "safe",
        position: 4,
        shares: null,
        fullyDilutedShares: "0",
        percentFullyDiluted: "0.0000",
        amounts: [{ currency: "USD", amount: "500000.000000" }],
        holders: 1,
        lines: 1,
      }),
    ],
    optionPool: {
      poolShares: "1000000.000000",
      granted: "400000.000000",
      available: "600000.000000",
    },
    convertiblesOutstanding: [
      { currency: "USD", safes: "500000.000000", notes: "0", total: "500000.000000" },
    ],
    holderCount: 4,
    lineCount: 6,
    matchedHolders: 3,
    unmatchedHolders: 1,
    ...over,
  };
}

export function captableSnapshot(over: Partial<CaptableSnapshot> = {}): CaptableSnapshot {
  return {
    id: SNAPSHOT_ID,
    asOf: "2026-09-01",
    source: "carta",
    status: "draft",
    note: "Post seed close",
    importedBy: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    publishedAt: null,
    summary: captableSummary(),
    ...over,
  };
}

export function captableHolder(over: Partial<CaptableHolder> = {}): CaptableHolder {
  return {
    key: "ada@example.com",
    holderName: "Ada Lovelace",
    holderEmail: "ada@example.com",
    membershipId: INVESTOR_MEMBERSHIP_ID,
    fullyDilutedShares: "2000000.000000",
    percentFullyDiluted: "18.1818",
    amounts: [],
    lines: 1,
    ...over,
  };
}

export function captableDetail(over: Partial<CaptableSnapshotDetail> = {}): CaptableSnapshotDetail {
  return {
    snapshot: captableSnapshot(),
    holders: [
      captableHolder(),
      captableHolder({
        key: "founder@example.com",
        holderName: "Grace Founder",
        holderEmail: "founder@example.com",
        membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a05",
        fullyDilutedShares: "8000000.000000",
        percentFullyDiluted: "72.7273",
        lines: 2,
      }),
      captableHolder({
        key: "angel fund",
        holderName: "Angel Fund LP",
        holderEmail: null,
        membershipId: null,
        fullyDilutedShares: "0",
        percentFullyDiluted: "0.0000",
        amounts: [{ currency: "USD", amount: "500000.000000" }],
      }),
    ],
    holdings: [],
    ...over,
  };
}

export function captablePreview(over: Partial<CaptableImportPreview> = {}): CaptableImportPreview {
  return {
    format: "carta",
    source: "carta",
    asOf: "2026-09-01",
    rows: 6,
    matched: 3,
    unmatched: 1,
    summary: captableSummary(),
    warnings: [
      {
        line: 7,
        column: "issued_on",
        code: "date_ignored",
        message: "issue date not understood; left empty",
      },
    ],
    lines: [
      {
        line: 2,
        holderName: "Ada Lovelace",
        holderEmail: "ada@example.com",
        membershipId: INVESTOR_MEMBERSHIP_ID,
        className: "Series Seed Preferred",
        kind: "preferred",
        shares: "2000000.000000",
        amount: null,
        currency: null,
        issuedOn: "2026-08-15",
      },
      {
        line: 7,
        holderName: "Angel Fund LP",
        holderEmail: null,
        membershipId: null,
        className: "Post-money SAFE",
        kind: "safe",
        shares: null,
        amount: "500000.000000",
        currency: "USD",
        issuedOn: null,
      },
    ],
    ...over,
  };
}

export function captableSettings(over: Partial<CaptableSettings> = {}): CaptableSettings {
  return {
    investorView: "own_line",
    disclaimer: null,
    defaultDisclaimer: "This summary is for information only and is not an offer.",
    ...over,
  };
}

export function captableMe(over: Partial<CaptableMe> = {}): CaptableMe {
  return {
    snapshotId: PUBLISHED_ID,
    asOf: "2026-09-01",
    disclaimer:
      "This summary is **for information only**. The company's stock ledger is the record.",
    holdings: [
      {
        className: "Series Seed Preferred",
        kind: "preferred",
        shares: "2000000.000000",
        amount: null,
        currency: null,
        issuedOn: "2026-08-15",
      },
    ],
    ownership: { fullyDilutedShares: "2000000.000000", percentFullyDiluted: "18.18" },
    summary: null,
    ...over,
  };
}
