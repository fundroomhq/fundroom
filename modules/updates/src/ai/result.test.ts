import { validateDoc } from "@fundroom/module-content";
import { describe, expect, it } from "vitest";
import {
  buildDraftResult,
  checkNumbers,
  DEFAULT_TITLE,
  MAX_SECTION_MARKDOWN,
  MAX_SECTIONS,
  MAX_UNVERIFIED_NUMBERS,
  METRICS_SECTION_TITLE,
  sectionKey,
  stripHtml,
  unlinkUnknown,
} from "./result.js";

/*
 * `finish` for `update_draft` (E3.12 §10): the model's JSON is untrusted. Every limit is
 * enforced here, raw HTML is removed, and the doc is valid for `PUT /posts/{id}/draft`.
 */

const KPI_A = "01920000-0000-7000-8000-00000000a001";
const KPI_B = "01920000-0000-7000-8000-00000000a002";
const none = { kpiDefinitionIds: [], lastUpdate: null };

type Result = {
  kind: "update_draft";
  title: string;
  doc: {
    sections: {
      key: string;
      title: string | null;
      blocks: { id: string; type: string; data: Record<string, unknown> }[];
    }[];
  };
  kpiDefinitionIds: string[];
  sources: { kpis: boolean; lastUpdate: unknown };
};

function ok(json: unknown, sources: Parameters<typeof buildDraftResult>[1] = none): Result {
  const out = buildDraftResult(json, sources);
  if (out.kind !== "result") throw new Error(`refused: ${out.code}`);
  return out.result as unknown as Result;
}

describe("stripHtml()", () => {
  it("removes tags and comments, keeps text, autolinks and lone angle brackets", () => {
    expect(stripHtml('Hi <b>there</b> <img src=x onerror="alert(1)"> <!-- c -->end')).toBe(
      "Hi there  end",
    );
    expect(stripHtml("<script>alert(1)</script>")).toBe("alert(1)");
    expect(stripHtml("see <https://example.com/a> and a < b, <5% churn")).toBe(
      "see https://example.com/a and a < b, <5% churn",
    );
    expect(stripHtml("dangling <iframe src=x")).toBe("dangling ");
    expect(stripHtml("<!-- never closed")).toBe("");
  });

  it("runs to a fixed point: removing a tag cannot assemble another (R2-L4)", () => {
    expect(stripHtml("<scr<script>ipt>alert(1)</script>")).toBe("alert(1)");
    expect(stripHtml("<<b>b>bold<</b>/b>")).toBe("bold");
    expect(stripHtml("<i<i<i>>>x")).not.toMatch(/<[a-z/]/iu);
  });
});

describe("buildDraftResult()", () => {
  it("builds a valid post doc: one rich_text per section, unique keys, fresh block ids", () => {
    const r = ok({
      title: "September update",
      sections: [
        { heading: "TL;DR", markdown: "A good month." },
        { heading: "TL;DR", markdown: "Second one with the same heading." },
        { heading: "", markdown: "No heading." },
      ],
    });
    expect(r.kind).toBe("update_draft");
    expect(r.title).toBe("September update");
    expect(r.doc.sections.map((s) => s.key)).toEqual(["tl-dr", "tl-dr-2", "section-3"]);
    expect(r.doc.sections.map((s) => s.title)).toEqual(["TL;DR", "TL;DR", null]);
    for (const s of r.doc.sections) {
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0]?.type).toBe("rich_text");
    }
    const ids = r.doc.sections.flatMap((s) => s.blocks.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
    const again = ok({ title: "x", sections: [{ heading: "TL;DR", markdown: "A" }] });
    expect(again.doc.sections[0]?.blocks[0]?.id).not.toBe(ids[0]);
    expect(() => validateDoc(r.doc)).not.toThrow();
    expect(r.kpiDefinitionIds).toEqual([]);
    expect(r.sources).toEqual({ kpis: false, lastUpdate: null });
  });

  it("strips HTML from title, headings and markdown", () => {
    const r = ok({
      title: "<h1>Update</h1>",
      sections: [{ heading: "<i>Wins</i>", markdown: "We <b>won</b><script>x()</script>" }],
    });
    expect(r.title).toBe("Update");
    expect(r.doc.sections[0]?.title).toBe("Wins");
    expect(r.doc.sections[0]?.blocks[0]?.data["text"]).toBe("We wonx()");
    expect(JSON.stringify(r)).not.toMatch(/<\/?(?:b|h1|i|script)>/u);
  });

  it("enforces the limits: 10 sections, title 200, heading 120, markdown 6000; drops empties", () => {
    const r = ok({
      title: "T".repeat(500),
      sections: [
        { heading: "Empty", markdown: "   " },
        { heading: "Only tags", markdown: "<br><hr/>" },
        "not an object",
        ...Array.from({ length: 15 }, (_, i) => ({
          heading: `H${i} ${"h".repeat(300)}`,
          markdown: "m".repeat(9_000),
        })),
      ],
    });
    expect(r.title.length).toBeLessThanOrEqual(200);
    expect(r.doc.sections).toHaveLength(MAX_SECTIONS);
    expect(r.doc.sections[0]?.title?.startsWith("H0")).toBe(true);
    for (const s of r.doc.sections) {
      expect(s.title?.length ?? 0).toBeLessThanOrEqual(120);
      expect(String(s.blocks[0]?.data["text"]).length).toBeLessThanOrEqual(MAX_SECTION_MARKDOWN);
      expect(s.key.length).toBeLessThanOrEqual(40);
    }
  });

  it("a missing title becomes the default; a multi-line heading one line", () => {
    const r = ok({ title: 7, sections: [{ heading: "A\n\nB", markdown: "x" }] });
    expect(r.title).toBe(DEFAULT_TITLE);
    expect(r.doc.sections[0]?.title).toBe("A B");
  });

  it("refuses output that is not the schema, or has nothing to show", () => {
    expect(buildDraftResult(null, none)).toEqual({ kind: "refused", code: "invalid_output" });
    expect(buildDraftResult([], none)).toEqual({ kind: "refused", code: "invalid_output" });
    expect(buildDraftResult({ title: "x" }, none)).toEqual({
      kind: "refused",
      code: "invalid_output",
    });
    expect(
      buildDraftResult({ title: "x", sections: [{ heading: "a", markdown: "" }] }, none),
    ).toEqual({ kind: "refused", code: "empty_output" });
  });

  it("puts the metric grid into the first KPI-ish section", () => {
    const r = ok(
      {
        title: "x",
        sections: [
          { heading: "TL;DR", markdown: "a" },
          { heading: "Our key numbers", markdown: "b" },
          { heading: "KPIs", markdown: "c" },
        ],
      },
      { kpiDefinitionIds: [KPI_A, KPI_B, KPI_A], lastUpdate: null },
    );
    const target = r.doc.sections[1];
    expect(target?.blocks.map((b) => b.type)).toEqual(["rich_text", "metric_grid"]);
    expect(target?.blocks[1]?.data).toEqual({ definitionIds: [KPI_A, KPI_B], columns: 3 });
    expect(r.doc.sections[2]?.blocks.map((b) => b.type)).toEqual(["rich_text"]);
    expect(r.kpiDefinitionIds).toEqual([KPI_A, KPI_B]);
    expect(r.sources.kpis).toBe(true);
  });

  it("without a KPI-ish section, adds 'Key metrics' at index 1 (or 0 is kept first)", () => {
    const r = ok(
      {
        title: "x",
        sections: [
          { heading: "Hello", markdown: "a" },
          { heading: "Asks", markdown: "b" },
        ],
      },
      { kpiDefinitionIds: [KPI_A], lastUpdate: null },
    );
    expect(r.doc.sections.map((s) => s.title)).toEqual(["Hello", METRICS_SECTION_TITLE, "Asks"]);
    expect(r.doc.sections[1]?.key).toBe("key-metrics");
    expect(r.doc.sections[1]?.blocks.map((b) => b.type)).toEqual(["metric_grid"]);
    expect(() => validateDoc(r.doc)).not.toThrow();
  });

  it("carries the last-update source through", () => {
    const lastUpdate = {
      postId: "01920000-0000-7000-8000-00000000b001",
      title: "August",
      sentAt: "2026-09-01T10:00:00.000Z",
    };
    const r = ok(
      { title: "x", sections: [{ heading: "a", markdown: "b" }] },
      {
        kpiDefinitionIds: [],
        lastUpdate,
      },
    );
    expect(r.sources.lastUpdate).toEqual(lastUpdate);
  });
});

describe("unlinkUnknown() (R2-L6)", () => {
  const material = "<notes>See https://acme.example/deck and mailto:ir@acme.example</notes>";
  it("keeps links whose URL the model was given; others become their text", () => {
    expect(
      unlinkUnknown(
        "[Deck](https://acme.example/deck) [Wire here](https://evil.example/pay) [Mail](mailto:ir@acme.example)",
        material,
      ),
    ).toBe("[Deck](https://acme.example/deck) Wire here [Mail](mailto:ir@acme.example)");
  });

  it("applies in finish: an invented link is plain text in the stored doc", () => {
    const out = buildDraftResult(
      {
        title: "x",
        sections: [{ heading: "a", markdown: "[Wire here](https://evil.example/pay)" }],
      },
      none,
      material,
    );
    expect(JSON.stringify(out)).not.toContain("evil.example");
    expect(JSON.stringify(out)).toContain("Wire here");
  });
});

describe("checkNumbers() (R2-L5, RR2-L5)", () => {
  const prompt = [
    "<outline>\n- KPIs\n</outline>",
    "<kpis>\n- MRR (USD): Sep 2026 42000.00; previous (Aug 2026) 40000.00; change +5.0%\n- Runway (months): Sep 2026 14; previous (Aug 2026) 18; change -22.2%\n</kpis>",
    "<notes>\nHired 3 engineers. Raised $1.2M.\n</notes>",
    "<last_update>\n# August\nARR hit $3.1M with 42 customers.\n</last_update>",
  ].join("\n\n");
  const check = (text: string) => checkNumbers(text, prompt);

  it("flags figures that are nowhere in the material, whatever their form", () => {
    expect(check("ARR reached $9.7M (up 312%).")).toEqual({
      unverified: ["$9.7M", "312%"],
      fromLastUpdate: [],
    });
    expect(
      check(
        "MRR is $42k (42,000 USD), up 5% from 40000. Runway 14 months, down 22.2%. We hired 3 and raised 1,200,000 in 2026. Churn 7%, 12 new logos, Q3 plans.",
      ),
    ).toEqual({ unverified: ["7%", "12"], fromLastUpdate: [] });
  });

  it("the last update's figures are reported separately, never as verified", () => {
    expect(check("ARR is $3.1M with 42 customers.")).toEqual({
      unverified: [],
      fromLastUpdate: ["$3.1M", "42"],
    });
  });

  it("compares unit class: a percentage is not a count or an amount", () => {
    expect(check("Churn was 14%.").unverified).toEqual(["14%"]);
    expect(check("Revenue grew 42000.00%.").unverified).toEqual(["42000.00%"]);
    expect(check("Runway is 14 months.").unverified).toEqual([]);
  });

  it("compares an explicit sign", () => {
    expect(check("Runway grew +22.2%.").unverified).toEqual(["+22.2%"]);
    expect(check("Runway fell -22.2% (22.2% down).").unverified).toEqual([]);
    expect(check("MRR changed -5.0%.").unverified).toEqual(["-5.0%"]);
  });

  it("integers under 10 000 match exactly (years included)", () => {
    expect(check("We have 2,030 customers.").unverified).toEqual(["2,030"]);
    expect(check("In 2026 we hired 3.").unverified).toEqual([]);
    expect(check("MRR is 41,950.").unverified).toEqual([]);
  });

  it("treats dates and periods as one non-numeric token (FIX2b)", () => {
    for (const text of [
      "On 2026-09-30 we shipped.",
      "Since 2027-01 we grew.",
      "Signed 09/30/2027.",
      "Signed 30.09.2027.",
      "Plan for Q4 2027 and H2 2028, FY2029.",
      "Closed on Sept 30, 2027 and Oct 1st.",
      "Board meets 15 March 2028.",
      "Launch in Nov 2027.",
    ])
      expect(check(text).unverified, text).toEqual([]);
    // Figures next to a date still count.
    expect(check("On 2026-09-30 churn was 7%, 12 new logos by Sept 30.").unverified).toEqual([
      "7%",
      "12",
    ]);
    expect(check("MRR 9.5k in Sep 2026").unverified).toEqual(["9.5k"]);
  });

  it("removes only the date token: figures next to a period stay figures (RR3-L5)", () => {
    const cases: [string, string[]][] = [
      ["In Q3 35% of revenue came from Germany.", ["35%"]],
      ["In Q3 42 new customers signed.", ["42"]],
      ["H1 17% growth.", ["17%"]],
      ["In June 40% of new MRR came from upsell.", ["40%"]],
      ["In March 12 customers churned.", ["12"]],
      ["Headcount of 45 may grow.", ["45"]],
      ["Headcount of 12 may grow.", ["12"]],
      ["March 45, 2027 is not a date.", ["45", "2027"]],
      ["We closed a 1200-50 split.", ["1200", "50"]],
      ["FY25 and Q3'27 and Q4 2027 were fine.", []],
    ];
    // `42` is in the last update of this prompt, so it is reported there; both lists count.
    for (const [text, flagged] of cases) {
      const r = check(text);
      expect([...r.unverified, ...r.fromLastUpdate], text).toEqual(flagged);
    }
  });

  it("treats en/em dashes and the minus sign as a minus (RR3-L5)", () => {
    for (const dash of ["\u2013", "\u2014", "\u2212", "\u2011"]) {
      expect(check(`MRR grew ${dash}5%.`).unverified).toEqual([`${dash}5%`]);
      expect(check(`Runway fell ${dash}22.2%.`).unverified).toEqual([]);
    }
    expect(check("From 2020\u20132025 we grew.").unverified).toEqual(["2020", "2025"]);
  });

  it("ignores list markers and words with digits; dedupes; caps", () => {
    expect(check("1. First\n2) Second\nQ3 and H1 and v2 on 2026-09").unverified).toEqual([]);
    expect(check("99 and 99").unverified).toEqual(["99"]);
    const many = Array.from({ length: 80 }, (_, i) => `${5000 + i}`).join(" ");
    expect(check(many).unverified).toHaveLength(MAX_UNVERIFIED_NUMBERS);
  });

  it("is part of the result, computed against the prompt given to finish", () => {
    const json = {
      title: "September",
      sections: [{ heading: "KPIs", markdown: "MRR 42k; ARR $3.1M; churn up 312%." }],
    };
    const out = buildDraftResult(json, none, prompt) as unknown as {
      result: { unverifiedNumbers: string[]; numbersFromLastUpdate: string[] };
    };
    expect(out.result.unverifiedNumbers).toEqual(["312%"]);
    expect(out.result.numbersFromLastUpdate).toEqual(["$3.1M"]);
  });
});

describe("sectionKey()", () => {
  it("slugs, de-accents, dedupes and falls back", () => {
    const taken = new Set<string>();
    expect(sectionKey("Café & Crème", taken, 0)).toBe("cafe-creme");
    expect(sectionKey("Café & Crème", taken, 1)).toBe("cafe-creme-2");
    expect(sectionKey("¡¡¡", taken, 2)).toBe("section-3");
    expect(sectionKey("x".repeat(200), taken, 3).length).toBeLessThanOrEqual(40);
  });
});
