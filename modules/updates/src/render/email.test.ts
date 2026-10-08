import type { RenderedBlock } from "@fundroom/module-content";
import { describe, expect, it } from "vitest";
import { validatePostDoc } from "../model.js";
import { renderUpdateEmail } from "./email.js";

const block = (over: Partial<RenderedBlock> = {}): RenderedBlock => ({
  id: "d",
  type: "disclaimer",
  schemaVersion: 1,
  data: { slug: null },
  ...over,
});

function email(blocks: readonly RenderedBlock[], title: string | null = null) {
  return renderUpdateEmail({
    title: "Q3",
    sections: [{ key: "legal", title, blocks }],
    workspaceName: "Acme",
    archiveUrl: "https://acme.test/updates/q3",
    unsubscribeUrl: undefined,
    postalAddress: null,
    footerNote: null,
    test: false,
  });
}

const grid = (hydrated: unknown): RenderedBlock =>
  block({
    id: "g",
    type: "metric_grid",
    data:
      hydrated === undefined
        ? { definitionIds: ["d1"] }
        : { definitionIds: ["d1"], hydrated: hydrated as RenderedBlock["data"] },
  });

const tile = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  key: "arr",
  name: "ARR",
  unit: "currency",
  currency: "USD",
  decimals: 0,
  direction: "up_good",
  latest: { periodKey: "2026-03", periodLabel: "Mar 2026", value: "1240000" },
  previous: null,
  sparkline: ["1240000"],
  ...over,
});

const chart = {
  url: "https://acme.test/api/v1/metrics/chart/tok.png",
  alt: "ARR by month, rising from $980k in April 2025 to $1.24M in March 2026.",
  width: 600,
  height: 300,
};

describe("the KPI grid in an emailed update", () => {
  it("puts the numbers in the text part, where no client can block them", () => {
    const { text } = email([grid({ columns: 3, metrics: [tile()], chart })]);
    // The text part is the wording of record (this file's header) and most clients block
    // remote images by default: a KPI email whose figures live only in a PNG has no figures.
    expect(text).toContain("Metric");
    expect(text).toMatch(/ARR\s+Mar 2026\s+USD 1240000/u);
    expect(text).toContain("View the KPIs on the web: https://acme.test/updates/q3");
  });

  it("writes a percent and a bare count in their own units, never reformatting the value", () => {
    const { text } = email([
      grid({
        columns: 3,
        metrics: [
          tile({
            id: "d2",
            key: "margin",
            name: "Gross margin",
            unit: "percent",
            currency: null,
            value: "73.5",
            latest: { periodKey: "2026-03", periodLabel: "Mar 2026", value: "73.5" },
          }),
          tile({
            id: "d3",
            key: "heads",
            name: "Headcount",
            unit: "count",
            currency: null,
            latest: { periodKey: "2026-03", periodLabel: "Mar 2026", value: "42" },
          }),
        ],
      }),
    ]);
    // Values are decimal strings and are printed byte for byte (§5): no float ever touches one.
    expect(text).toContain("73.5%");
    expect(text).toMatch(/Headcount\s+Mar 2026\s+42/u);
  });

  it("renders the chart with the payload's summary as its alt text", () => {
    const { html } = email([grid({ columns: 3, metrics: [tile()], chart })]);
    expect(html).toContain(`src="${chart.url}"`);
    expect(html).toContain(`alt="${chart.alt}"`);
    // Declared box, so blocked images do not reflow the mail when the reader shows them.
    expect(html).toContain('width="536" height="268"');
    // The frame is the dark-mode answer: a deliberate light card, not a bare white slab.
    expect(html).toContain("background-color:#ffffff;border:1px solid #e5e7eb");
    expect(html).toContain("View the KPIs on the web");
  });

  it("sends the numbers without a picture when no chart could be minted", () => {
    const { html, text } = email([grid({ columns: 3, metrics: [tile()] })]);
    expect(html).not.toContain("<img");
    expect(html).toContain("ARR");
    expect(text).toContain("USD 1240000");
  });

  it("refuses a chart URL that is not https, and one with no description", () => {
    const bad = (over: Record<string, unknown>) =>
      email([grid({ columns: 3, metrics: [tile()], chart: { ...chart, ...over } })]).html;
    // A hydrated payload is another module's output and this is the only fetch in the message.
    expect(bad({ url: "http://acme.test/c.png" })).not.toContain("<img");
    expect(bad({ url: "javascript:alert(1)" })).not.toContain("<img");
    // A picture nobody can read is pure weight: the table beside it carries every figure.
    expect(bad({ alt: "  " })).not.toContain("<img");
  });

  it("says a metric has no data rather than inventing a zero", () => {
    const { text } = email([grid({ columns: 3, metrics: [tile({ latest: null })] })]);
    expect(text).toContain("no data yet");
    expect(text).not.toMatch(/ARR\s+\s+0/u);
  });

  it("says nothing at all when this reader may see none of the block's metrics", () => {
    // §10 drops ids the viewer may not see rather than reporting them. A "View the KPIs" link
    // onto a page with no KPIs would advertise exactly what was just dropped.
    const { html, text } = email([grid({ columns: 3, metrics: [] })]);
    expect(html).not.toContain("View the KPIs");
    expect(text).not.toContain("View the KPIs");
  });

  it("takes the section heading with it, in both parts", () => {
    // The block returning "" was only half the suppression: the heading above it is written by
    // `renderUpdateEmail`, and an external investor admitted to none of these metrics used to
    // receive a bare `KPIs` heading with nothing beneath it — advertising the existence of the
    // numbers the block had just dropped, which is the one thing the block refused to do.
    // (The fixture this case had before used `title: null`, so it could not see any of that.)
    const { html, text } = email([grid({ columns: 3, metrics: [] })], "KPIs");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("KPIs");
    expect(text).not.toContain("KPIS");
    // The mail itself still renders: only the section went.
    expect(html).toContain("View this update on the web");
  });

  it("keeps the heading when anything under it survived", () => {
    const { html, text } = email(
      [
        grid({ columns: 3, metrics: [] }),
        block({ id: "r", type: "rich_text", data: { text: "We hired." } }),
      ],
      "KPIs",
    );
    expect(html).toContain("<h2");
    expect(html).toContain("KPIs");
    expect(text).toContain("KPIS");
    expect(text).toContain("We hired.");
  });

  it("keeps a heading an author wrote over no blocks at all", () => {
    // Not the same case, and the difference is the point. The editor makes a section with
    // `blocks: []` (`apps/web/src/modules/content/admin.tsx`) and `SectionSchema` has no
    // `.min(1)`, so a heading-only section is a document an author can write and save. Nothing
    // was gated away from this reader there, so suppressing it would delete the author's words
    // rather than close a leak.
    const { html, text } = email([], "Coming soon");
    expect(html).toContain("Coming soon");
    expect(text).toContain("COMING SOON");
  });

  it("keeps today's archive link when the block was never hydrated", () => {
    const { html, text } = email([grid(undefined)]);
    expect(html).toContain("View the KPIs on the web");
    expect(text).toContain("View the KPIs on the web: https://acme.test/updates/q3");
  });
});

describe("the disclaimer in an emailed update", () => {
  it("renders the legend and its version in both parts", () => {
    const { html, text } = email([
      block({
        data: {
          slug: "offering-disclaimer",
          hydrated: {
            slug: "offering-disclaimer",
            title: "Offering disclaimer",
            versionNo: 3,
            body: "This is **not** an offer.",
            effectiveAt: "2026-01-02T03:04:05.000Z",
          },
        },
      }),
    ]);
    expect(html).toContain("Offering disclaimer · v3");
    expect(html).toContain("<strong>not</strong>");
    expect(text).toContain("Offering disclaimer (v3)");
    expect(text).toContain("This is not an offer.");
  });

  it("says nothing when the workspace has no disclaimer to say", () => {
    const { html, text } = email([block()]);
    expect(html).not.toContain("border-left");
    expect(text).not.toContain("(v");
  });

  it("is allowed in an update body, unlike a hero", () => {
    const doc = (type: string) => ({
      sections: [
        {
          key: "legal",
          title: null,
          blocks: [
            {
              id: "b",
              type,
              schemaVersion: 1,
              data: type === "hero" ? { heading: "Acme" } : { slug: null },
            },
          ],
        },
      ],
    });
    expect(validatePostDoc(doc("disclaimer")).sections[0]?.blocks[0]?.type).toBe("disclaimer");
    expect(() => validatePostDoc(doc("hero"))).toThrow(/hero/u);
  });
});

describe("the footer unsubscribe link", () => {
  const withLink = () =>
    renderUpdateEmail({
      title: "Q3",
      sections: [{ key: "s", title: null, blocks: [] }],
      workspaceName: "Acme",
      archiveUrl: "https://acme.test/updates/q3",
      unsubscribeUrl: "https://acme.test/unsubscribe?token=tok&x=1",
      postalAddress: null,
      footerNote: null,
      test: false,
    });

  it("opts out of ESP click tracking (Postmark and SES per-link attributes)", () => {
    const { html } = withLink();
    const link = /<a [^>]*href="https:\/\/acme\.test\/unsubscribe\?token=tok&amp;x=1"[^>]*>/u.exec(
      html,
    )?.[0];
    expect(link).toBeDefined();
    expect(link).toContain(" data-pm-no-track");
    expect(link).toContain(" ses:no-track");
  });

  it("leaves the other links trackable", () => {
    const { html } = withLink();
    const archive = /<a [^>]*href="https:\/\/acme\.test\/updates\/q3"[^>]*>/u.exec(html)?.[0];
    expect(archive).toBeDefined();
    expect(archive).not.toContain("no-track");
  });
});

describe("the chrome in the recipient's language (E2.8)", () => {
  const render = (locale?: string) =>
    renderUpdateEmail({
      title: "Q3 update",
      sections: [{ key: "s", title: null, blocks: [{ type: "document_list", data: {} } as never] }],
      workspaceName: "Acme",
      archiveUrl: "https://acme.test/updates/q3",
      unsubscribeUrl: "https://acme.test/unsubscribe?token=tok",
      postalAddress: null,
      footerNote: null,
      test: true,
      ...(locale === undefined ? {} : { locale }),
    });

  it("localises subject prefix, banner, links and footer; keeps the author's words", () => {
    const { subject, html, text } = render("en-XA");
    expect(subject.startsWith("⟦")).toBe(true);
    expect(subject).toContain("Acme");
    expect(subject).toContain("Q3 update");
    expect(html).toContain('<html lang="en-XA">');
    expect(html).not.toContain("Unsubscribe from investor updates");
    expect(html).not.toContain("View this update on the web");
    expect(text).not.toContain("TEST SEND");
    expect(text).toContain("https://acme.test/unsubscribe?token=tok");
    expect(html).toContain("<h1");
    expect(html).toContain("Q3 update</h1>");
  });

  it("is English, byte for byte, without a locale", () => {
    const { subject, html, text } = render();
    expect(subject).toBe("[Test] Acme: Q3 update");
    expect(html).toContain('<html lang="en">');
    expect(text).toContain(
      "Unsubscribe from investor updates: https://acme.test/unsubscribe?token=tok",
    );
    expect(text).toContain("View the documents on the web: https://acme.test/updates/q3");
  });
});
