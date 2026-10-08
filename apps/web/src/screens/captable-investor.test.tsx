import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { captableMe } from "../test/fixtures-captable.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/captable` (E3.6 §8), the reader's side: "your holdings".
 *
 * The properties worth a test:
 *
 *  - a member sees **their own lines** and the as-of date, with the disclaimer right there;
 *  - the class summary appears **only** when the workspace chose `summary`, and never names
 *    another holder;
 *  - every 404 reason (module off, nothing published, view `none`) reads the same — a reader is
 *    not told *why* there is nothing;
 *  - a share count too large for a double is printed exactly (the string goes to `Intl`).
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: { captable: () => import("../modules/captable/investor.js") },
  adminModules: {},
}));

const investorBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "captable",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [
            { id: "captable", label: "Holdings", to: "/captable", order: 60, icon: "pie-chart" },
          ],
        },
      },
    ],
    permissions: [],
  });

function handlers(over: Record<string, Handler> = {}): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, investorBootstrap()],
    "GET /api/v1/captable/me": () => [200, captableMe()],
    ...over,
  });
}

async function openHoldings() {
  const r = await renderApp("/captable");
  expect(
    await screen.findByRole("heading", { name: "Holdings", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("cap table investor surface", () => {
  it("shows the member's own holdings, the as-of date and the disclaimer beside them", async () => {
    handlers();
    const r = await openHoldings();
    expect(await screen.findByText("As of Sep 1, 2026", {}, { timeout: 5000 })).toBeVisible();
    const table = screen.getByRole("table", { name: "Your holdings" });
    expect(within(table).getByText("Series Seed Preferred")).toBeInTheDocument();
    expect(within(table).getByText("2,000,000")).toBeInTheDocument();
    expect(within(table).getByText("Aug 15, 2026")).toBeInTheDocument();
    expect(screen.getByText("Fully diluted, you hold 2,000,000 shares (18.18%).")).toBeVisible();
    // The disclaimer is a landmark of its own, rendered as markdown.
    const aside = screen.getByRole("complementary", { name: "Important information" });
    expect(within(aside).getByText("for information only").tagName).toBe("STRONG");
    // `own_line`: no company-wide table.
    expect(screen.queryByText("Company breakdown")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds the coarse breakdown when the workspace chose it: kind buckets, % only", async () => {
    handlers({
      "GET /api/v1/captable/me": () => [
        200,
        captableMe({
          summary: {
            buckets: [
              { kind: "common", percentFullyDiluted: "72.7" },
              { kind: "options", percentFullyDiluted: "9.1" },
              { kind: "convertibles", present: true },
            ],
          },
        }),
      ],
    });
    const r = await openHoldings();
    const table = await screen.findByRole(
      "table",
      { name: "Company breakdown" },
      { timeout: 5000 },
    );
    const common = within(table).getByRole("row", { name: /Common stock/u });
    // One decimal place, exactly as the server rounded it — not padded to imply precision.
    expect(within(common).getByText("72.7%")).toBeInTheDocument();
    expect(within(table).getByText("Options and option pool")).toBeInTheDocument();
    // Nothing but the percentage: no share counts, no class names, no holder counts.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Category", "% fully diluted"]);
    expect(within(table).queryByText("Preferred stock")).toBeNull();
    // Convertibles: presence only, never an amount.
    expect(screen.getByText("SAFEs or convertible notes are outstanding.")).toBeVisible();
    expect(screen.queryByText(/\$/u)).toBeNull();
    // What was left out is not named or counted, only that small categories are not shown.
    expect(
      screen.getByText(/Categories held by only a few investors are not shown/u),
    ).toBeVisible();
    expect(screen.queryByText(/Other/u)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says there are not enough holders when summary mode has nothing to show", async () => {
    handlers({
      "GET /api/v1/captable/me": () => [200, captableMe({ summary: { buckets: [] } })],
    });
    const r = await openHoldings();
    expect(
      await screen.findByText("Not enough holders to show a breakdown.", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("table", { name: "Company breakdown" })).toBeNull();
    // The member's own lines stay exact regardless.
    expect(screen.getByText("Fully diluted, you hold 2,000,000 shares (18.18%).")).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says the same 'nothing to show' for every reason the server answers 404", async () => {
    handlers({ "GET /api/v1/captable/me": () => apiError(404, "not_found") });
    const r = await openHoldings();
    expect(await screen.findByText("Nothing to show yet", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("tells a member with no line in the published snapshot so, rather than showing zero", async () => {
    handlers({
      "GET /api/v1/captable/me": () => [
        200,
        captableMe({
          holdings: [],
          ownership: { fullyDilutedShares: "0", percentFullyDiluted: "0.0000" },
        }),
      ],
    });
    const r = await openHoldings();
    expect(
      await screen.findByText(
        "The published cap table has no line in your name.",
        {},
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Important information" })).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("prints a share count beyond a double's precision and a KWD amount exactly", async () => {
    handlers({
      "GET /api/v1/captable/me": () => [
        200,
        captableMe({
          holdings: [
            {
              className: "Common",
              kind: "common",
              shares: "123456789012345.000001",
              amount: null,
              currency: null,
              issuedOn: null,
            },
            {
              className: "Post-money SAFE",
              kind: "safe",
              shares: null,
              amount: "1500.125000",
              currency: "KWD",
              issuedOn: null,
            },
          ],
        }),
      ],
    });
    await openHoldings();
    // A three-decimal currency keeps its third place (fils), not rounded to two.
    expect(
      await screen.findByText(/^KWD\s1,500\.125$/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // `Number("123456789012345.000001")` is 123456789012345 — the millionth would vanish.
    expect(
      await screen.findByText("123,456,789,012,345.000001", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});
