import { parseFixed } from "@fundroom/decimal";
import { describe, expect, it } from "vitest";
import {
  computeSummary,
  DEFAULT_SETTINGS,
  decimalText,
  fullyDilutedByLine,
  investorSummary,
  parseQuantity,
  parseSettings,
  percentText,
  type SummaryClass,
  type SummaryLine,
} from "./model.js";

const n = (v: string) => {
  const f = parseFixed(v);
  if (f === undefined) throw new Error(v);
  return f;
};

const line = (
  classIndex: number,
  holderName: string,
  shares: string | null,
  extra: Partial<SummaryLine> = {},
): SummaryLine => ({
  classIndex,
  holderName,
  holderEmail: null,
  membershipId: null,
  shares: shares === null ? null : n(shares),
  amount: null,
  currency: null,
  ...extra,
});

describe("decimal text and percentages", () => {
  it("renders canonical decimals without trailing zeros", () => {
    expect(decimalText(n("1000000"))).toBe("1000000");
    expect(decimalText(n("0.500000"))).toBe("0.5");
    expect(decimalText(n("12.345678"))).toBe("12.345678");
    expect(decimalText(0n)).toBe("0");
  });

  it("computes % to four places, half away from zero, exactly (bigint)", () => {
    expect(percentText(n("1"), n("3"))).toBe("33.3333");
    expect(percentText(n("2"), n("3"))).toBe("66.6667");
    expect(percentText(n("1"), n("8"))).toBe("12.5000");
    expect(percentText(n("1"), n("1"))).toBe("100.0000");
    expect(percentText(0n, n("5"))).toBe("0.0000");
    expect(percentText(n("5"), 0n)).toBe("0.0000");
    // Large share counts: no double anywhere in the path.
    expect(percentText(n("123456789012"), n("987654321098"))).toBe("12.5000");
  });
});

describe("computeSummary", () => {
  const classes: SummaryClass[] = [
    { name: "Common", kind: "common", position: 0 },
    { name: "Series Seed Preferred", kind: "preferred", position: 1 },
    { name: "2024 Stock Plan (pool)", kind: "option_pool", position: 2 },
    { name: "Options", kind: "option", position: 3 },
    { name: "Post-money SAFE", kind: "safe", position: 4 },
    { name: "Bridge note", kind: "note", position: 5 },
  ];
  const lines: SummaryLine[] = [
    line(0, "Founder A", "4000000", { holderEmail: "a@x.test", membershipId: "m-a" }),
    line(0, "Founder B", "4000000"),
    line(1, "Fund I", "1500000", { amount: n("1500000"), currency: "USD" }),
    line(2, "Pool", "1000000"),
    line(3, "Employee 1", "250000"),
    line(3, "Employee 2", "150000"),
    line(4, "Angel", null, { amount: n("250000"), currency: "USD" }),
    line(4, "EU Angel", null, { amount: n("100000"), currency: "EUR" }),
    line(5, "Angel", null, { amount: n("50000.5"), currency: "USD" }),
  ];

  it("fully dilutes by class: pool counts only what is still available, convertibles nothing", () => {
    const s = computeSummary(classes, lines);
    // 8M common + 1.5M preferred + 400k granted + 600k available = 10.5M
    expect(s.fullyDilutedShares).toBe("10500000");
    const by = Object.fromEntries(s.classes.map((c) => [c.name, c]));
    expect(by["Common"]?.fullyDilutedShares).toBe("8000000");
    expect(by["Common"]?.percentFullyDiluted).toBe("76.1905");
    expect(by["2024 Stock Plan (pool)"]?.shares).toBe("1000000");
    expect(by["2024 Stock Plan (pool)"]?.fullyDilutedShares).toBe("600000");
    expect(by["Options"]?.fullyDilutedShares).toBe("400000");
    expect(by["Post-money SAFE"]?.shares).toBeNull();
    expect(by["Post-money SAFE"]?.fullyDilutedShares).toBe("0");
    expect(by["Post-money SAFE"]?.percentFullyDiluted).toBe("0.0000");
    expect(by["Post-money SAFE"]?.amounts).toEqual([
      { currency: "EUR", amount: "100000" },
      { currency: "USD", amount: "250000" },
    ]);
    const pct = s.classes.reduce((a, c) => a + Number(c.percentFullyDiluted), 0);
    expect(Math.abs(pct - 100)).toBeLessThan(0.001);
  });

  it("reports the option pool granted vs available and convertibles per currency", () => {
    const s = computeSummary(classes, lines);
    expect(s.optionPool).toEqual({ poolShares: "1000000", granted: "400000", available: "600000" });
    expect(s.convertiblesOutstanding).toEqual([
      { currency: "EUR", safes: "100000", notes: "0", total: "100000" },
      { currency: "USD", safes: "250000", notes: "50000.5", total: "300000.5" },
    ]);
  });

  it("counts holders (by member, else address, else name) and matched ones", () => {
    const s = computeSummary(classes, lines);
    // Angel holds two lines.
    expect(s.holderCount).toBe(8);
    expect(s.lineCount).toBe(9);
    expect(s.matchedHolders).toBe(1);
    expect(s.unmatchedHolders).toBe(7);
  });

  it("floors the available pool at zero when grants exceed it, and has no pool block without one", () => {
    const over = computeSummary(
      [
        { name: "Pool", kind: "option_pool", position: 0 },
        { name: "Options", kind: "option", position: 1 },
      ],
      [line(0, "Pool", "100"), line(1, "E", "150")],
    );
    expect(over.optionPool).toEqual({ poolShares: "100", granted: "150", available: "0" });
    expect(over.fullyDilutedShares).toBe("150");
    const none = computeSummary(
      [{ name: "Common", kind: "common", position: 0 }],
      [line(0, "A", "1")],
    );
    expect(none.optionPool).toBeNull();
    expect(none.convertiblesOutstanding).toEqual([]);
  });

  it("splits an option pool's available count across its lines exactly", () => {
    const cls: SummaryClass[] = [
      { name: "Pool", kind: "option_pool", position: 0 },
      { name: "Options", kind: "option", position: 1 },
    ];
    const ls = [line(0, "Plan A", "300"), line(0, "Plan B", "700"), line(1, "E", "100")];
    const fd = fullyDilutedByLine(cls, ls);
    expect(fd.reduce((a, b) => a + b, 0n)).toBe(n("1000"));
    expect(fd[2]).toBe(n("100"));
  });
});

describe("settings", () => {
  it("defaults to own_line and the default disclaimer", () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ flags: { x: true } })).toEqual(DEFAULT_SETTINGS);
  });

  it("reads config.settings, and falls back to the default on a broken block", () => {
    expect(parseSettings({ settings: { investorView: "summary", disclaimer: " Hi " } })).toEqual({
      investorView: "summary",
      disclaimer: "Hi",
    });
    expect(parseSettings({ settings: { investorView: "everything" } })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ settings: { investorView: "none", disclaimer: "" } })).toEqual({
      investorView: "none",
      disclaimer: null,
    });
  });
});

/** The viewer's lines: linked to them, or unlinked under one of their addresses (R5). */
const viewer =
  (id: string, emails: readonly string[] = []) =>
  (l: SummaryLine) =>
    l.membershipId === id ||
    (l.membershipId === null &&
      l.holderEmail !== null &&
      emails.includes(l.holderEmail.toLowerCase()));

describe("investorSummary (R2-G1: kind buckets, % only, ≥ 3 other holders)", () => {
  const m = (id: string) => ({ membershipId: id });
  const many = (classIndex: number, prefix: string, count: number, shares: string) =>
    Array.from({ length: count }, (_, i) =>
      line(classIndex, `${prefix}${i}`, shares, m(`${prefix}${i}`)),
    );
  const pct = (s: ReturnType<typeof investorSummary>) =>
    (s?.buckets ?? []).flatMap((b) =>
      "percentFullyDiluted" in b ? [Number(b.percentFullyDiluted)] : [],
    );
  /**
   * Everything a viewer could derive about one holder whose exact % FD is `target`: a shown
   * figure equal to it, or the complement (100 − shown) equal to it. Both must miss by more than
   * the 1-dp rounding.
   */
  const recoverable = (s: ReturnType<typeof investorSummary>, target: number) => {
    const shown = pct(s);
    const complement = 100 - shown.reduce((a, b) => a + b, 0);
    return [...shown, complement].some((v) => Math.abs(v - target) <= 0.15);
  };
  const noQuantities = (s: ReturnType<typeof investorSummary>) => {
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/shares|amount|fullyDilutedShares|total/u);
  };

  it("R3 #1: a single warrant holder next to SAFEs cannot be recovered", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Series A", kind: "preferred", position: 1 },
      { name: "Warrant", kind: "warrant", position: 2 },
      { name: "SAFE", kind: "safe", position: 3 },
    ];
    const ls = [
      line(0, "Viewer", "100", m("v")),
      ...many(0, "c", 4, "1000"),
      ...many(1, "p", 3, "500"),
      line(2, "W", "300", m("w")),
      ...many(3, "s", 3, "0").map((l) => ({
        ...l,
        shares: null,
        amount: n("1000"),
        currency: "USD",
      })),
    ];
    const s = investorSummary(cls, ls, viewer("v"));
    // Warrants (one holder) are omitted; the complement would then be exactly W's share, so the
    // smallest shown bucket (preferred) is suppressed with it.
    expect(s?.buckets.map((b) => b.kind)).toEqual(["common", "convertibles"]);
    expect(recoverable(s, (300 / 5900) * 100)).toBe(false);
    noQuantities(s);
  });

  it("R3 #2: one optionee beside a pool is not isolated (pool − granted is never shown)", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Preferred", kind: "preferred", position: 1 },
      { name: "Pool", kind: "option_pool", position: 2 },
      { name: "Options", kind: "option", position: 3 },
    ];
    const ls = [
      ...many(0, "c", 3, "1000"),
      ...many(1, "p", 3, "1000"),
      line(2, "Option pool", "1000"),
      line(3, "Optionee", "250", m("o")),
    ];
    const s = investorSummary(cls, ls, null);
    expect(s?.buckets.some((b) => b.kind === "options")).toBe(false);
    expect(recoverable(s, (250 / 7000) * 100)).toBe(false);
    noQuantities(s);
  });

  it("R3 #3: two plan pools show only one combined options figure, and only with ≥ 3 optionees", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "2019 Plan", kind: "option_pool", position: 1 },
      { name: "2024 Plan", kind: "option_pool", position: 2 },
      { name: "Options", kind: "option", position: 3 },
    ];
    const pools = [line(1, "2019 pool", "400"), line(2, "2024 pool", "600")];
    const two = investorSummary(
      cls,
      [...many(0, "c", 5, "1000"), ...pools, ...many(3, "o", 2, "300")],
      null,
    );
    // Two optionees: the options bucket is omitted; the common bucket goes with it, so neither
    // pool nor optionee can be read off the complement.
    expect(two).toEqual({ buckets: [] });
    const three = investorSummary(
      cls,
      [...many(0, "c", 5, "1000"), ...pools, ...many(3, "o", 3, "300")],
      null,
    );
    expect(three?.buckets).toEqual([
      { kind: "common", percentFullyDiluted: "83.3" },
      { kind: "options", percentFullyDiluted: "16.7" }, // 900 granted + 100 available, together
    ]);
    noQuantities(three);
  });

  it("R4 #1: a lender's 437,000 warrants beside advisors with 1 and 0 shares are not recoverable", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Warrants", kind: "warrant", position: 1 },
    ];
    const ls = [
      ...many(0, "c", 8, "1200000"),
      line(1, "Lender", "437000", m("lender")),
      line(1, "Advisor A", "1", m("adv-a")),
      line(1, "Advisor B", "0", m("adv-b")),
    ];
    const target = (437_000 / 10_037_001) * 100; // 4.354 %
    expect(target).toBeCloseTo(4.354, 3);
    const s = investorSummary(cls, ls, null);
    // Two holders with FD > 0 (the 0-share advisor is nobody), and the lender dominates anyway:
    // warrants are omitted, and common goes with them (the complement would be the lender's).
    expect(s.buckets.some((b) => b.kind === "warrants")).toBe(false);
    expect(recoverable(s, target)).toBe(false);
    expect(s).toEqual({ buckets: [] });
  });

  it("R4 #2: a Lead's 3.0M preferred with two 0-share alias lines is not shown", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Series A", kind: "preferred", position: 1 },
    ];
    const ls = [
      ...many(0, "c", 5, "1400000"),
      line(1, "Lead Fund", "3000000", m("lead")),
      line(1, "Lead Fund LP", "0"),
      line(1, "LEAD  FUND  II", "0"),
    ];
    const s = investorSummary(cls, ls, null);
    expect(s.buckets.some((b) => b.kind === "preferred")).toBe(false);
    expect(recoverable(s, 30)).toBe(false);
  });

  it("dominance is borderline-inclusive: 70 % / 90 % passes, 71 % does not", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Seed", kind: "preferred", position: 1 },
    ];
    const common = many(0, "c", 4, "1000");
    const pass = investorSummary(
      cls,
      [
        ...common,
        line(1, "P1", "70", m("p1")),
        line(1, "P2", "20", m("p2")),
        line(1, "P3", "10", m("p3")),
      ],
      null,
    );
    expect(pass.buckets.map((b) => b.kind)).toEqual(["common", "preferred"]);
    const fail = investorSummary(
      cls,
      [
        ...common,
        line(1, "P1", "71", m("p1")),
        line(1, "P2", "19", m("p2")),
        line(1, "P3", "10", m("p3")),
      ],
      null,
    );
    // Preferred is dominated; the complement (the same three, pooled) is too, so common goes.
    expect(fail).toEqual({ buckets: [] });
    const top2 = investorSummary(
      cls,
      [
        ...common,
        line(1, "P1", "46", m("p1")),
        line(1, "P2", "45", m("p2")),
        line(1, "P3", "5", m("p3")),
        line(1, "P4", "4", m("p4")),
      ],
      null,
    );
    expect(top2).toEqual({ buckets: [] }); // top two hold 91 %
  });

  it("R5: the viewer's unlinked trust and alt-email lines are theirs, so a 237-share holder stays hidden", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Series A", kind: "preferred", position: 1 },
    ];
    const email = (holderEmail: string) => ({ holderEmail });
    const ls = [
      line(0, "Viewer", "1000", m("v")),
      line(0, "Viewer Family Trust", "2000", email("v@home.test")),
      line(0, "Viewer (alt)", "2000", email("v.alt@work.test")),
      line(0, "Viewer Holdings LLC", "2000", email("V.LLC@Work.test")),
      line(0, "X", "237", m("x")),
      ...many(1, "p", 3, "10000"),
    ];
    const target = 237;
    // Without the address match the trust/alt lines count as three "other" common holders, the
    // common bucket shows 19.4 % and the viewer, knowing their own 7,000, recovers X to ±5.
    const naive = investorSummary(cls, ls, (l) => l.membershipId === "v");
    const common = naive.buckets.find((b) => b.kind === "common");
    const recovered =
      common !== undefined && "percentFullyDiluted" in common
        ? (Number(common.percentFullyDiluted) / (100 - Number(common.percentFullyDiluted))) *
            30000 -
          7000
        : Number.NaN;
    expect(Math.abs(recovered - target)).toBeLessThan(30);
    // With them treated as the viewer's, common has one other holder: omitted, and the complement
    // (X alone) takes the preferred bucket with it.
    const s = investorSummary(
      cls,
      ls,
      viewer("v", ["v@home.test", "v.alt@work.test", "v.llc@work.test"]),
    );
    expect(s).toEqual({ buckets: [] });
  });

  it("does not count the viewer: a bucket of the viewer plus two others is omitted", () => {
    const cls: SummaryClass[] = [
      { name: "Common", kind: "common", position: 0 },
      { name: "Seed", kind: "preferred", position: 1 },
    ];
    const withTwo = [
      ...many(0, "c", 4, "1000"),
      line(1, "Viewer", "500", m("v")),
      ...many(1, "p", 2, "500"),
    ];
    const s = investorSummary(cls, withTwo, viewer("v"));
    // Preferred: viewer + 2 others → omitted; the complement would be the viewer plus two others
    // (subtracting their own leaves two), so common is suppressed too.
    expect(s).toEqual({ buckets: [] });
    const withThree = [...withTwo, line(1, "P3", "500", m("p3"))];
    expect(investorSummary(cls, withThree, viewer("v"))?.buckets.map((b) => b.kind)).toEqual([
      "common",
      "preferred",
    ]);
  });
});

describe("parseQuantity", () => {
  it("accepts 18 integral digits for shares and 14 for amounts", () => {
    expect(parseQuantity("123456789012345678", 18)).toBe(123456789012345678000000n);
    expect(parseQuantity("1234567890123456789", 18)).toBeUndefined();
    expect(parseQuantity("123456789012345", 14)).toBeUndefined();
    expect(parseQuantity("0.0000005", 18)).toBe(1n);
    expect(parseQuantity("1e5", 18)).toBeUndefined();
  });
});
