import { describe, expect, it } from "vitest";
import {
  type ImportPlan,
  kindFromClassName,
  normalizeHeader,
  type PlanResult,
  parseDate,
  planImport,
} from "./import-plan.js";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "./model.js";

const MEMBERS = new Map([
  ["ada@investor.test", "11111111-1111-7111-8111-111111111111"],
  ["grace@investor.test", "22222222-2222-7222-8222-222222222222"],
]);

function ok(r: PlanResult): ImportPlan {
  if (!r.ok) throw new Error(`refused: ${r.reason} ${JSON.stringify(r.problems)}`);
  return r.plan;
}

const TEMPLATE = [
  "holder_name,holder_email,class,kind,shares,amount,currency,issued_on",
  "Founder,founder@acme.test,Common,common,8000000,,,2024-01-15",
  "Ada Lovelace,ADA@Investor.test,Series Seed,preferred,1500000,1500000,USD,2025-03-01",
  "Option pool,,2024 Plan,option_pool,1000000,,,",
  "Employee,emp@acme.test,Options,option,250000,,,2024-06-01",
  'Grace Hopper,grace@investor.test,Post-money SAFE,safe,,"250,000",USD,2025-06-30',
].join("\n");

describe("planImport — template", () => {
  it("parses our template, matches members by email case-insensitively and summarises", () => {
    const plan = ok(planImport({ format: "template", csv: TEMPLATE, members: MEMBERS }));
    expect(plan.source).toBe("csv");
    expect(plan.rows).toBe(5);
    expect(plan.classes.map((c) => [c.name, c.kind])).toEqual([
      ["Common", "common"],
      ["Series Seed", "preferred"],
      ["2024 Plan", "option_pool"],
      ["Options", "option"],
      ["Post-money SAFE", "safe"],
    ]);
    expect(plan.lines.map((l) => l.membershipId)).toEqual([
      null,
      MEMBERS.get("ada@investor.test"),
      null,
      null,
      MEMBERS.get("grace@investor.test"),
    ]);
    expect(plan.matched).toBe(2);
    expect(plan.unmatched).toBe(3);
    expect(plan.summary.fullyDilutedShares).toBe("10500000");
    expect(plan.summary.optionPool).toEqual({
      poolShares: "1000000",
      granted: "250000",
      available: "750000",
    });
    expect(plan.summary.convertiblesOutstanding).toEqual([
      { currency: "USD", safes: "250000", notes: "0", total: "250000" },
    ]);
    // Unmatched addresses are warned about once each; the pool line has no address.
    expect(plan.warnings.filter((w) => w.code === "email_unmatched").map((w) => w.line)).toEqual([
      2, 5,
    ]);
    expect(plan.lines[1]?.issuedOn).toBe("2025-03-01");
  });

  it("is deterministic: the same inputs give the same plan", () => {
    const a = planImport({ format: "template", csv: TEMPLATE, members: MEMBERS });
    const b = planImport({ format: "template", csv: TEMPLATE, members: MEMBERS });
    expect(a).toEqual(b);
  });

  it("refuses a template without its kind column, listing what is missing", () => {
    const r = planImport({
      format: "template",
      csv: "holder_name,class,shares\nA,Common,1\n",
      members: MEMBERS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing_columns");
    expect(r.problems.map((p) => p.column)).toEqual(["kind"]);
  });

  it("refuses bad rows with every problem, line and column", () => {
    const r = planImport({
      format: "template",
      csv: [
        "holder_name,class,kind,shares,amount,currency",
        "Z,Common,common,1,,",
        "A,Common,common,abc,,",
        ",Common,common,1,,",
        "B,Common,stock,1,,",
        "C,SAFE,safe,10,,",
        "D,Common,common,-5,,",
        "E,Common,preferred,5,,",
        "F,Notes,note,,100,US",
      ].join("\n"),
      members: MEMBERS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_rows");
    expect(r.problems.map((p) => [p.line, p.code])).toEqual([
      [3, "shares_invalid"],
      [4, "holder_name_missing"],
      [5, "kind_invalid"],
      [6, "amount_missing"],
      [7, "shares_negative"],
      [8, "class_kind_conflict"],
      [9, "currency_invalid"],
    ]);
    expect(r.problems[0]?.column).toBe("shares");
  });

  it("refuses an empty file and a header-only file", () => {
    for (const csv of ["", "holder_name,class,kind,shares\n", "\n\n"]) {
      const r = planImport({ format: "template", csv, members: MEMBERS });
      expect(r.ok ? "ok" : r.reason).toBe("empty");
    }
  });

  it("refuses a duplicated column", () => {
    const r = planImport({
      format: "template",
      csv: "holder_name,class,kind,shares,Shares\nA,C,common,1,2\n",
      members: MEMBERS,
    });
    expect(r.ok ? "ok" : r.reason).toBe("duplicate_column");
  });

  it("enforces the byte and row caps", () => {
    const big = `holder_name,class,kind,shares\n${"x".repeat(IMPORT_MAX_BYTES)}`;
    expect(planImport({ format: "template", csv: big, members: MEMBERS })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `H${i},Common,common,1`);
    const many = `holder_name,class,kind,shares\n${rows.join("\n")}`;
    expect(planImport({ format: "template", csv: many, members: MEMBERS })).toMatchObject({
      ok: false,
      reason: "too_many_rows",
    });
    const atCap = `holder_name,class,kind,shares\n${rows.slice(0, IMPORT_MAX_ROWS).join("\n")}`;
    expect(ok(planImport({ format: "template", csv: atCap, members: MEMBERS })).lines).toHaveLength(
      IMPORT_MAX_ROWS,
    );
  });

  it("warns (without refusing) on a bad address, a bad date, a zero line and an assumed currency", () => {
    const plan = ok(
      planImport({
        format: "template",
        csv: [
          "holder_name,holder_email,class,kind,shares,amount,currency,issued_on",
          "A,not-an-email,Common,common,1,,,31/31/2024",
          "B,,Common,common,0,,,",
          "C,,SAFE,safe,,100,,",
          "Total,,,,1,100,,",
        ].join("\n"),
        members: MEMBERS,
      }),
    );
    expect(plan.warnings.map((w) => w.code)).toEqual([
      "email_invalid",
      "date_invalid",
      "zero_line_skipped",
      "currency_assumed",
      "total_row_skipped",
    ]);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[1]?.currency).toBe("USD");
  });

  it("does not link an address that is not in the live-member map", () => {
    const plan = ok(planImport({ format: "template", csv: TEMPLATE, members: new Map() }));
    expect(plan.matched).toBe(0);
    expect(plan.summary.matchedHolders).toBe(0);
  });
});

describe("planImport — Carta and Pulley (inferred columns)", () => {
  it("reads a Carta-style ledger: aliases, US dates, formatted numbers, inferred kinds", () => {
    const csv = [
      "Stakeholder Name,Stakeholder Email,Share Class,Quantity Issued,Quantity Outstanding,Cash Paid,Issue Date",
      'Founder,founder@acme.test,Common Stock,"4,000,000","4,000,000",$400.00,1/15/2024',
      'Ada Lovelace,ada@investor.test,Series Seed Preferred,"1,500,000","1,500,000","$1,500,000.00",3/1/2025',
      "Emp,emp@acme.test,2024 Equity Incentive Plan,100000,80000,,6/1/2024",
      "Total,,,,,,",
    ].join("\n");
    const plan = ok(planImport({ format: "carta", csv, members: MEMBERS }));
    expect(plan.source).toBe("carta");
    expect(plan.classes.map((c) => c.kind)).toEqual(["common", "preferred", "option"]);
    // "Quantity Outstanding" outranks "Quantity Issued", which is reported as ignored.
    expect(plan.lines.map((l) => l.shares)).toEqual([
      4_000_000_000_000n,
      1_500_000_000_000n,
      80_000_000_000n,
    ]);
    expect(
      plan.warnings.some((w) => w.code === "column_ignored" && w.column === "Quantity Issued"),
    ).toBe(true);
    expect(plan.lines[0]?.issuedOn).toBe("2024-01-15");
    expect(plan.lines[1]?.membershipId).toBe(MEMBERS.get("ada@investor.test"));
    expect(plan.lines[1]?.currency).toBe("USD");
  });

  it("reads a Pulley-style export with a security type column", () => {
    const csv = [
      "Stakeholder,Email,Share Class,Security Type,Shares,Investment Amount,Currency,Issue Date",
      "Grace Hopper,grace@investor.test,Seed SAFE,SAFE,,50000,USD,2025-01-02",
      "Bob,bob@x.test,Common,Common Stock,1000,,,2024-01-02",
      "Warrant Co,,Warrants 2025,Warrant,500,,,",
    ].join("\n");
    const plan = ok(planImport({ format: "pulley", csv, members: MEMBERS }));
    expect(plan.source).toBe("pulley");
    expect(plan.classes.map((c) => [c.name, c.kind])).toEqual([
      ["Seed SAFE", "safe"],
      ["Common", "common"],
      ["Warrants 2025", "warrant"],
    ]);
    expect(plan.summary.fullyDilutedShares).toBe("1500");
    expect(plan.matched).toBe(1);
  });

  it("assumes common (with a warning) for a class it cannot classify", () => {
    const csv = "Stakeholder,Share Class,Shares\nA,Class Z,10\n";
    const plan = ok(planImport({ format: "pulley", csv, members: MEMBERS }));
    expect(plan.classes[0]?.kind).toBe("common");
    expect(plan.warnings[0]?.code).toBe("kind_assumed");
  });

  it("refuses a Carta file without a name column", () => {
    const r = planImport({
      format: "carta",
      csv: "Share Class,Quantity\nCommon,1\n",
      members: MEMBERS,
    });
    expect(r.ok ? "ok" : r.reason).toBe("missing_columns");
  });
});

describe("numbers", () => {
  const one = (shares: string) =>
    planImport({
      format: "template",
      csv: `holder_name,class,kind,shares\nA,Common,common,"${shares}"\n`,
      members: MEMBERS,
    });

  it("accepts commas only as thousands separators", () => {
    expect(ok(one("1,234,567.5")).lines[0]?.shares).toBe(1_234_567_500_000n);
    expect(ok(one("1234.5")).lines[0]?.shares).toBe(1_234_500_000n);
    expect(ok(one("$ 12,000")).lines[0]?.shares).toBe(12_000_000_000n);
  });

  it("refuses a comma that is not a thousands separator as ambiguous (European 1.234,5; 1,5)", () => {
    for (const v of ["1.234,5", "1,5", "12,34,567", "1,2345", ",5"]) {
      const r = one(v);
      expect(r.ok, v).toBe(false);
      if (r.ok) continue;
      expect(r.problems[0]?.code, v).toBe("shares_ambiguous");
    }
  });

  it("holds share counts up to the column's 18 integral digits", () => {
    expect(ok(one("123456789012345678")).lines[0]?.shares).toBe(123456789012345678000000n);
    expect(one("1234567890123456789")).toMatchObject({ ok: false, reason: "invalid_rows" });
  });
});

describe("helpers", () => {
  it("normalises headers", () => {
    expect(normalizeHeader(" Quantity (Outstanding) ")).toBe("quantity_outstanding");
    expect(normalizeHeader("Principal ($)")).toBe("principal");
  });

  it("parses ISO and US dates and refuses impossible ones", () => {
    expect(parseDate("2024-02-29")).toBe("2024-02-29");
    expect(parseDate("2/29/2024")).toBe("2024-02-29");
    expect(parseDate("2023-02-29")).toBeUndefined();
    expect(parseDate("yesterday")).toBeUndefined();
  });

  it("infers kinds from class names", () => {
    expect(kindFromClassName("Series A-1 Preferred")).toBe("preferred");
    expect(kindFromClassName("Convertible Note 2025")).toBe("note");
    expect(kindFromClassName("Options available for issuance")).toBe("option_pool");
    expect(kindFromClassName("ISO grants")).toBe("option");
    expect(kindFromClassName("Founders' Common")).toBe("common");
  });
});
