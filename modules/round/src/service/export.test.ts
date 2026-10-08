import { describe, expect, it } from "vitest";
import type { CommitmentRecord, RoundRecord } from "../repos/round-repo.js";
import { CSV_COLUMNS, commitmentsCsv, csvField, csvFilename } from "./export.js";

/*
 * The commitments export. Its column order is frozen — somebody has a spreadsheet keyed on it —
 * and its quoting has to survive a tenant-supplied display name, which is free text.
 */

const NOW = new Date("2026-03-15T12:00:00.000Z");
const WIRED = new Date("2026-03-20T09:30:00.000Z");
const MEMBER = "01920000-0000-7000-8000-0000000000d1";

const round = (over: Partial<RoundRecord> = {}): RoundRecord =>
  ({
    id: "01920000-0000-7000-8000-0000000000a1",
    name: "Seed 2026",
    stage: "seed",
    instrumentKind: "safe",
    status: "open",
    targetAmount: "2000000.00",
    currency: "USD",
    minimumInvestment: null,
    opensAt: null,
    closesAt: null,
    openedAt: NOW,
    closedAt: null,
    showProgress: true,
    summary: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as RoundRecord;

const commitment = (over: Partial<CommitmentRecord> = {}): CommitmentRecord =>
  ({
    id: "01920000-0000-7000-8000-0000000000e1",
    roundId: "01920000-0000-7000-8000-0000000000a1",
    membershipId: null,
    organizationId: null,
    contactId: null,
    displayName: "Ada Lovelace",
    amount: "250000.00",
    status: "soft",
    note: null,
    interestSubmissionId: null,
    signedDocumentId: null,
    wiredAt: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as CommitmentRecord;

describe("csvField", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvField("250000.00")).toBe("250000.00");
  });

  it("writes an absent value as an empty field, never as `null`", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes a comma, a quote and a newline, doubling the quote", () => {
    expect(csvField("Lovelace, Ada")).toBe('"Lovelace, Ada"');
    expect(csvField('Ada "Countess" Lovelace')).toBe('"Ada ""Countess"" Lovelace"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("defuses a value a spreadsheet would run as a formula", () => {
    /*
     * CSV injection: a display name beginning `=`, `+`, `-` or `@` opens as a live formula in
     * Excel and Sheets. The name is tenant-supplied free text, so it is prefixed with a single
     * quote — a leading apostrophe in a cell nobody computes on, and the class is gone.
     */
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvField("-Acme")).toBe("'-Acme");
    // And still quoted when it also needs quoting.
    expect(csvField("=HYPERLINK(x),y")).toBe(`"'=HYPERLINK(x),y"`);
  });
});

describe("commitmentsCsv", () => {
  it("writes the frozen header", () => {
    expect([...CSV_COLUMNS]).toEqual([
      "id",
      "name",
      "status",
      "amount",
      "currency",
      "created_at",
      "wired_at",
    ]);
    const csv = commitmentsCsv(round(), [], new Map());
    expect(csv).toBe("id,name,status,amount,currency,created_at,wired_at\r\n");
  });

  it("puts the round's currency on every row", () => {
    // `Commitment.amount` is a bare decimal; the unit it is in lives on the round.
    const csv = commitmentsCsv(round({ currency: "EUR" }), [commitment()], new Map());
    expect(csv.split("\r\n")[1]).toContain(",EUR,");
  });

  it("prefers the display name, then the member's name, then nothing", () => {
    const names = new Map([[MEMBER, "Grace Hopper"]]);
    const rows = commitmentsCsv(
      round(),
      [
        commitment({ id: "a", displayName: "Ada Lovelace" }),
        commitment({ id: "b", displayName: null, membershipId: MEMBER }),
        commitment({ id: "c", displayName: null, membershipId: null, organizationId: "org" }),
      ],
      names,
    ).split("\r\n");
    expect(rows[1]).toContain("Ada Lovelace");
    expect(rows[2]).toContain("Grace Hopper");
    // An organisation-only commitment has no personal name and the field is simply empty.
    expect(rows[3]?.startsWith("c,,soft,")).toBe(true);
  });

  it("keeps withdrawn rows: the export is the record, not the tracker", () => {
    /*
     * `allocation()` deliberately excludes a withdrawal from every bucket. The CSV does not: a
     * finance team reconciling a bank statement needs to see that somebody committed and pulled
     * out, and `status` is the column that tells the two apart.
     */
    const csv = commitmentsCsv(
      round(),
      [commitment({ id: "a" }), commitment({ id: "b", status: "withdrawn" })],
      new Map(),
    );
    expect(csv).toContain(",withdrawn,");
    expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
  });

  it("writes timestamps as ISO, and an unwired commitment with an empty wired_at", () => {
    const csv = commitmentsCsv(
      round(),
      [commitment({ status: "wired", wiredAt: WIRED }), commitment({ id: "b" })],
      new Map(),
    ).split("\r\n");
    expect(csv[1]).toContain("2026-03-15T12:00:00.000Z,2026-03-20T09:30:00.000Z");
    expect(csv[2]?.endsWith("2026-03-15T12:00:00.000Z,")).toBe(true);
  });

  it("ends with a newline, because some tools drop an unterminated last line", () => {
    expect(commitmentsCsv(round(), [commitment()], new Map()).endsWith("\r\n")).toBe(true);
  });
});

describe("csvFilename", () => {
  it("slugs the round's name", () => {
    expect(csvFilename(round({ name: "Seed 2026" }))).toBe("seed-2026-commitments.csv");
    expect(csvFilename(round({ name: "Series A — Extension!" }))).toBe(
      "series-a-extension-commitments.csv",
    );
  });

  it("falls back rather than producing a filename that is only an extension", () => {
    expect(csvFilename(round({ name: "———" }))).toBe("round-commitments.csv");
  });

  it("cannot break out of the Content-Disposition quoting", () => {
    // Everything but `[a-z0-9]` becomes a hyphen, so a name carrying a quote or a path
    // separator cannot reach the header.
    expect(csvFilename(round({ name: '../../etc/"passwd' }))).toBe("etc-passwd-commitments.csv");
  });
});
