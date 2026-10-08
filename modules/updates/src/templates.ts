import type { PageDoc } from "@fundroom/module-content";

/*
 * Update templates (design/03 C1: "YC: recap / highlights / lowlights / KPIs / asks;
 * Techstars minimal; board"). A template is a starting document; the founder edits it.
 * Section keys are stable so per-section audience rules and KPI embeds can target them.
 */
export const TEMPLATE_KEYS = ["yc", "minimal", "board", "blank"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface UpdateTemplate {
  readonly key: TemplateKey;
  readonly name: string;
  readonly description: string;
  readonly doc: PageDoc;
}

const text = (id: string, lines: readonly string[]) => ({
  id,
  type: "rich_text",
  schemaVersion: 1,
  data: { format: "markdown", text: lines.join("\n") },
});

const YC: UpdateTemplate = {
  key: "yc",
  name: "YC monthly update",
  description:
    "Recap, highlights, lowlights, KPIs and asks: the structure most seed investors expect.",
  doc: {
    sections: [
      {
        key: "recap",
        title: "TL;DR",
        blocks: [
          text("recap-text", ["Two or three sentences: where we are, what changed, what we need."]),
        ],
      },
      {
        key: "highlights",
        title: "Highlights",
        blocks: [
          text("highlights-text", ["- What went well this month", "- A customer win", "- A hire"]),
        ],
      },
      {
        key: "lowlights",
        title: "Lowlights",
        blocks: [
          text("lowlights-text", [
            "- What did not work, and what we learned",
            "- Risks we are watching",
          ]),
        ],
      },
      {
        key: "kpis",
        title: "KPIs",
        blocks: [
          text("kpis-text", [
            "- **Revenue (MRR):** …",
            "- **Customers:** …",
            "- **Burn / runway:** …",
            "",
            "Replace with a metric grid once the KPIs module is on.",
          ]),
        ],
      },
      {
        key: "asks",
        title: "Asks",
        blocks: [text("asks-text", ["- Introductions to …", "- Advice on …"])],
      },
      {
        key: "thanks",
        title: "Thanks",
        blocks: [text("thanks-text", ["Thank you to … for …"])],
      },
    ],
  },
};

const MINIMAL: UpdateTemplate = {
  key: "minimal",
  name: "Minimal",
  description: "One narrative section and one ask. Techstars-style short letter.",
  doc: {
    sections: [
      {
        key: "update",
        title: null,
        blocks: [
          text("update-text", [
            "Dear investors,",
            "",
            "Here is what happened since the last update.",
            "",
            "Best,",
          ]),
        ],
      },
      { key: "asks", title: "How you can help", blocks: [text("asks-text", ["- …"])] },
    ],
  },
};

const BOARD: UpdateTemplate = {
  key: "board",
  name: "Board update",
  description:
    "Executive summary, financials, hiring, risks and decisions needed. Restrict the confidential sections to the board group.",
  doc: {
    sections: [
      { key: "summary", title: "Executive summary", blocks: [text("summary-text", ["…"])] },
      {
        key: "financials",
        title: "Financials",
        blocks: [text("financials-text", ["- Cash: …", "- Burn: …", "- Runway: …"])],
      },
      { key: "hiring", title: "Team and hiring", blocks: [text("hiring-text", ["- …"])] },
      { key: "risks", title: "Risks", blocks: [text("risks-text", ["- …"])] },
      { key: "decisions", title: "Decisions needed", blocks: [text("decisions-text", ["- …"])] },
    ],
  },
};

const BLANK: UpdateTemplate = {
  key: "blank",
  name: "Blank",
  description: "One empty section.",
  doc: { sections: [{ key: "body", title: null, blocks: [text("body-text", [""])] }] },
};

export const TEMPLATES: readonly UpdateTemplate[] = [YC, MINIMAL, BOARD, BLANK];

export function templateByKey(key: string): UpdateTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
