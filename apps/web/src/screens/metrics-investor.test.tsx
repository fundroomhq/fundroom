import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockView } from "../components/content/page-renderer.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import {
  type Handler,
  installMockApi,
  METRIC_DEFINITION_ID,
  metricGridHydrated,
  metricGridTile,
  metricSeries,
  metricSeriesEntry,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/kpis` and the `metric_grid` content block (E2.4 §§9–10), from the reader's side. The page
 * was `/metrics` until E-UP-18 D3 (that is the server's ops endpoint on every host).
 *
 * The property worth a test more than any other is a **negative** one: a metric this reader's
 * audience does not admit is simply not on the page. Not greyed out, not counted, not named —
 * the server drops it before the payload is built, and the screen must not reintroduce it as a
 * placeholder, because "there is a number here you may not see" is itself the disclosure a
 * per-metric audience exists to prevent.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: { metrics: () => import("../modules/metrics/investor.js") },
  adminModules: {},
}));

const investorBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "metrics",
        version: "1.0.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [{ id: "metrics", label: "KPIs", to: "/kpis", order: 30 }],
        },
      },
    ],
    permissions: [],
  });

function handlers(over: Record<string, Handler> = {}): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, investorBootstrap()],
    "GET /api/v1/metrics/series": () => [200, metricSeries()],
    ...over,
  });
}

describe("metrics investor surface", () => {
  it("shows a published metric with its latest figure and how it moved", async () => {
    handlers();
    const r = await renderApp("/kpis");
    expect(
      await screen.findByRole("heading", { name: "KPIs", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // "ARR" is deliberately reachable more than once — the card heading and the chart's own
    // data table — so this asks for "at least one", never "exactly one".
    expect((await screen.findAllByText("ARR", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    // The figure is deliberately reachable more than once — the headline and the chart's own
    // data table — so this asks for "at least one", not "exactly one".
    expect(screen.getAllByText("$1,250,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sep 2026").length).toBeGreaterThan(0);
    // The delta says "better" in words as well as in colour: 1.4.1 forbids colour alone, and
    // "up" and "better" are not the same claim (a falling burn rate is better).
    expect(screen.getByText(/better/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows only what the audience admitted, with no trace of what it did not", async () => {
    // The server has already dropped `net_burn`: there is no field on the response that could
    // tell this screen it exists, and this test pins that the screen invents none.
    handlers({
      "GET /api/v1/metrics/series": () => [
        200,
        metricSeries({ series: [metricSeriesEntry({ name: "ARR" })] }),
      ],
    });
    const r = await renderApp("/kpis");
    expect((await screen.findAllByText("ARR", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(r.container.textContent).not.toContain("Net burn");
    expect(r.container.textContent).not.toContain("hidden");
    expect(screen.queryByText(/not available/iu)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("is an ordinary empty page for a reader admitted to nothing", async () => {
    handlers({ "GET /api/v1/metrics/series": () => [200, metricSeries({ series: [] })] });
    const r = await renderApp("/kpis");
    // Indistinguishable from a workspace that publishes no KPIs at all — which is the point.
    expect(await screen.findByText("No KPIs published", {}, { timeout: 5000 })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  // E-UP-18 D3: links and history from before the move are followed inside the app.
  it("follows an old /metrics link to /kpis inside the app", async () => {
    handlers();
    const r = await renderApp("/metrics?period=2026-q3#arr");
    expect(
      await screen.findByRole("heading", { name: "KPIs", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(pathOf(r.router)).toBe("/kpis?period=2026-q3"));
    expect(r.router.state.location.hash).toBe("arr");
    // Replaced, not pushed: Back does not land on the old path to be redirected again.
    expect(r.router.history.length).toBe(1);
    // The nav says where the page is now.
    expect(screen.getByRole("link", { name: /KPIs/u })).toHaveAttribute("href", "/kpis");
  }, 20_000);

  it("puts every charted figure in text as well, gaps included", async () => {
    handlers();
    const r = await renderApp("/kpis");
    const chart = await screen.findByRole("img", {}, { timeout: 5000 });
    // The accessible name is the sentence the emailed PNG uses as its `alt`, so the figures
    // travel even when the picture does not.
    expect(chart.getAttribute("aria-labelledby")).toBeTruthy();
    const table = r.container.querySelector("table");
    expect(table?.textContent).toContain("$1,200,000");
    expect(table?.textContent).toContain("$1,250,000");
    // Aug has no figure in the fixture. It is a dash, not a zero.
    expect(table?.textContent).toContain("—");
    // And every column says *which* period it is: the table is what a screen-reader user
    // actually reads, so a header of "3" or "2 periods ago" would be the whole chart unread.
    expect([...(table?.querySelectorAll("thead th") ?? [])].map((th) => th.textContent)).toEqual([
      "Series",
      "Jul 2026",
      "Aug 2026",
      "Sep 2026",
    ]);
    expect(r.container.querySelectorAll("[style]")).toHaveLength(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("metric_grid content block", () => {
  it("renders the hydrated tiles instead of a wall of JSON", async () => {
    const r = render(
      <BlockView
        block={{
          id: "metric-grid-1",
          type: "metric_grid",
          schemaVersion: 1,
          data: { definitionIds: [METRIC_DEFINITION_ID], hydrated: metricGridHydrated() },
        }}
      />,
    );
    // "ARR" appears twice by design: as the tile's heading and as the chart table's row
    // header. The figure being reachable twice is the point, not a duplication bug.
    expect((await screen.findAllByText("ARR", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1,250,000").length).toBeGreaterThan(0);
    // "Sep 2026" is now reachable twice as well: beside the headline figure, and as the last
    // column header of the chart's accessible table.
    expect(screen.getAllByText("Sep 2026").length).toBeGreaterThan(0);
    // The delta against the previous period, coloured by `direction` and said in words.
    expect(screen.getByText(/4\.2% better/u)).toBeVisible();
    // The raw payload is gone: no `<pre>` full of ids.
    expect(r.container.querySelector("pre")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("names every sparkline column by its period rather than by its position", async () => {
    /*
     * The regression this test exists to prevent: §10's `periods` arriving on the payload and
     * reaching nothing, so the accessible table headed its columns "11 periods ago … Latest".
     * That is the one part of a chart a screen-reader user actually reads, and it silently
     * rots — the picture looks identical either way.
     */
    const r = render(
      <BlockView
        block={{
          id: "metric-grid-1",
          type: "metric_grid",
          schemaVersion: 1,
          data: { definitionIds: [METRIC_DEFINITION_ID], hydrated: metricGridHydrated() },
        }}
      />,
    );
    // The interpreter is a lazy chunk, so wait for the picture before reading the text beside it.
    expect(await screen.findByRole("img", {}, { timeout: 5000 })).toBeInTheDocument();
    const table = r.container.querySelector("table");
    expect([...(table?.querySelectorAll("thead th") ?? [])].map((th) => th.textContent)).toEqual([
      "Series",
      "Jul 2026",
      "Aug 2026",
      "Sep 2026",
    ]);
    // Aug is a gap in the fixture: labelled like every other column, and a dash, never a zero.
    expect([...(table?.querySelectorAll("tbody td") ?? [])].map((td) => td.textContent)).toEqual([
      "$1,200,000",
      "—",
      "$1,250,000",
    ]);
    // The sentence the chart announces — and the emailed PNG's `alt` — names them too.
    expect(r.container.querySelector("svg title")?.textContent).toContain(
      "covering Jul 2026 to Sep 2026",
    );
    expect(r.container.textContent).not.toMatch(/periods? ago/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("still says when, by position, for a payload that carries no periods", async () => {
    // A server older than C-F.1 sends no `periods`. The columns fall back to counting
    // backwards, which is worse than a month and far better than a bare column number.
    const r = render(
      <BlockView
        block={{
          id: "metric-grid-1",
          type: "metric_grid",
          schemaVersion: 1,
          data: {
            definitionIds: [METRIC_DEFINITION_ID],
            hydrated: metricGridHydrated({ metrics: [metricGridTile({ periods: undefined })] }),
          },
        }}
      />,
    );
    expect(await screen.findByRole("img", {}, { timeout: 5000 })).toBeInTheDocument();
    const headers = [...(r.container.querySelectorAll("thead th") ?? [])].map(
      (th) => th.textContent ?? "",
    );
    expect(headers[0]).toBe("Series");
    expect(headers.at(-1)).toBe("Latest");
    for (const header of headers.slice(1, -1)) expect(header).toMatch(/periods? ago$/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("renders nothing at all when the reader may see none of the block's metrics", async () => {
    const r = render(
      <BlockView
        block={{
          id: "metric-grid-1",
          type: "metric_grid",
          schemaVersion: 1,
          // The hydrator dropped every id. No placeholder, no count, no trace.
          data: { definitionIds: [METRIC_DEFINITION_ID], hydrated: { columns: 3, metrics: [] } },
        }}
      />,
    );
    expect(r.container.textContent).toBe("");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says the module is off rather than guessing, when the block cannot be hydrated", async () => {
    const r = render(
      <BlockView
        block={{
          id: "metric-grid-1",
          type: "metric_grid",
          schemaVersion: 1,
          data: { definitionIds: [METRIC_DEFINITION_ID] },
          unavailable: "module_unavailable",
        }}
      />,
    );
    expect(screen.getByText(/once the metrics module is enabled/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
