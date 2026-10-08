import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  type Handler,
  installMockApi,
  METRIC_DEFINITION_ID,
  metricDefinition,
  metricDryRun,
  metricGrid,
  metricGridCell,
  metricImport,
  metricPoint,
  metricSheetConnection,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/metrics` (E2.4). The four things this screen exists to get right:
 *
 *  - an **empty cell is not a zero**. A month nobody has a figure for is missing, not 0, and
 *    the save body must simply not mention it;
 *  - a cell that has **not changed writes nothing**, so re-saving the grid is not a
 *    restatement storm across the whole history;
 *  - a changed cell **is** a restatement and the admin is told before they save, not after;
 *  - a restatement is **provable** afterwards: every revision is still there, with its source.
 *
 * Plus the two-step CSV flow, whose defining property is that a dry run that no longer
 * describes the input cannot be confirmed.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { metrics: () => import("../modules/metrics/admin.js") },
}));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions = ["metrics.read", "metrics.manage", "metrics.settings"]) =>
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
          "admin.nav": [
            {
              id: "metrics-admin",
              label: "KPIs",
              to: "/admin/metrics",
              order: 35,
              icon: "metrics",
            },
          ],
        },
      },
    ],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/metrics/definitions": () => [200, { definitions: [metricDefinition()] }],
    "GET /api/v1/metrics/grid": () => [200, metricGrid()],
    ...over,
  });
}

async function openGrid(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/metrics");
  expect(
    await screen.findByRole("heading", { name: "KPIs", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

async function openCatalogue(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/metrics/catalogue");
  expect(
    await screen.findByRole("heading", { name: "Metric catalogue", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("metrics admin", () => {
  it("lists the catalogue with each metric's audience", async () => {
    handlers({
      "GET /api/v1/metrics/definitions": () => [
        200,
        {
          definitions: [
            metricDefinition(),
            metricDefinition({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02",
              key: "net_burn",
              name: "Net burn",
              direction: "down_good",
              audience: { kind: "staff_only" },
            }),
          ],
        },
      ],
    });
    const r = await openCatalogue();
    expect(await screen.findByText("ARR", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Net burn")).toBeInTheDocument();
    // The audience is the whole of the gating, so it is on the row rather than behind an edit.
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    expect(screen.getByText("Staff only")).toBeInTheDocument();
    // Direction is a fact about the number, not a colour: "down is good" for a burn rate.
    expect(screen.getByText("Down is good")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a definition, closed to everyone until somebody says otherwise", async () => {
    const { calls } = handlers({
      "POST /api/v1/metrics/definitions": () => [201, metricDefinition({ key: "headcount" })],
    });
    await openCatalogue();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New metric" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/u), "Headcount");
    await user.type(within(dialog).getByLabelText(/^Key/u), "headcount");
    await user.selectOptions(within(dialog).getByLabelText(/^Unit/u), "count");
    // The default audience is the closed one: a number nobody has chosen to publish is not
    // published, and the form must not quietly widen that.
    expect(within(dialog).getByLabelText(/Who may see it/u)).toHaveValue("staff_only");
    // Radix marks the rest of the page `aria-hidden` while a dialog is open and jsdom has no
    // `inert` to go with it, so axe is scoped to the dialog.
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create metric" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/metrics/definitions")?.body,
      ).toMatchObject({
        key: "headcount",
        name: "Headcount",
        unit: "count",
        audience: { kind: "staff_only" },
      }),
    );
  }, 20_000);

  it("shows the grid's existing figures and leaves an unfilled period empty", async () => {
    handlers();
    const r = await openGrid();
    expect(await screen.findByText("ARR", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Jul 2026" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Sep 2026" })).toBeInTheDocument();
    expect(screen.getByLabelText("ARR, Jul 2026")).toHaveValue("1200000");
    // The fixture has no cell for September. An absent figure is absent, not 0.
    expect(screen.getByLabelText("ARR, Sep 2026")).toHaveValue("");
    // Nothing to save until something is typed.
    expect(screen.getByRole("button", { name: /Save 0 cells/u })).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("saves only the changed cell, and never sends a zero for an empty one", async () => {
    const { calls } = handlers({
      "PUT /api/v1/metrics/grid": () => [
        200,
        {
          written: 0,
          unchanged: 0,
          restated: 1,
          skipped: 0,
          definitionIds: [METRIC_DEFINITION_ID],
        },
      ],
    });
    const r = await openGrid();
    const user = userEvent.setup();

    const july = await screen.findByLabelText("ARR, Jul 2026", {}, { timeout: 5000 });
    const august = screen.getByLabelText("ARR, Aug 2026");
    const september = screen.getByLabelText("ARR, Sep 2026");
    // The stored decimals are not shown back as `1200000.000000`.
    expect(july).toHaveValue("1200000");
    expect(august).toHaveValue("1250000");
    // September has no cell in the fixture, so it is empty — not "0".
    expect(september).toHaveValue("");

    // Retype July with the same number in a different spelling. It must count as unchanged:
    // the comparison is on the decimal value, not on the characters.
    await user.clear(july);
    await user.type(july, "1200000.00");
    // Change August. This one is a restatement and the screen says so before saving.
    await user.clear(august);
    await user.type(august, "1300000");
    expect(await screen.findByText("Restates")).toBeVisible();
    expect(screen.getByText(/1 of these cells already have a published figure/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Save 1 cell$/u }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/metrics/grid"),
      ).toBeDefined(),
    );
    const body = calls.find((c) => c.method === "PUT" && c.path === "/api/v1/metrics/grid")
      ?.body as {
      periodKind: string;
      cells: { definitionId: string; periodKey: string; value: string }[];
    };
    // Exactly one cell: the changed one. Not the re-typed identical one, and above all not a
    // zero for September — an empty cell means "no point", never 0.
    expect(body.cells).toEqual([
      { definitionId: METRIC_DEFINITION_ID, periodKey: "2026-08", value: "1300000" },
    ]);
    expect(body.cells.some((c) => c.periodKey === "2026-09")).toBe(false);
    expect(JSON.stringify(body)).not.toContain('"value":"0"');
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("marks the cells a sync changed under a person's figure", async () => {
    handlers({
      "GET /api/v1/metrics/grid": () => [
        200,
        metricGrid({
          cells: [
            metricGridCell({ periodKey: "2026-07" }),
            metricGridCell({
              periodKey: "2026-08",
              value: "1250000.000000",
              revision: 2,
              sourceKind: "sheets",
              needsReview: true,
            }),
          ],
        }),
      ],
    });
    const r = await openGrid();
    expect(await screen.findByText("Needs review", {}, { timeout: 5000 })).toBeVisible();
    // Said in words, in a live region, not only shown as a differently coloured box.
    expect(screen.getByText(/1 cell was changed by a sync and is waiting/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("proves a restatement: every revision, with its source and when it was written", async () => {
    const { calls } = handlers({
      "GET /api/v1/metrics/definitions/{id}/points": () => [
        200,
        {
          points: [
            metricPoint({ revision: 2, value: "1250000.000000", current: true }),
            metricPoint({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b00",
              revision: 1,
              value: "1200000.000000",
              sourceKind: "csv",
              current: false,
            }),
          ],
        },
      ],
    });
    await openGrid();
    const user = userEvent.setup();
    const open = await screen.findByRole(
      "button",
      { name: "History of ARR for Aug 2026" },
      { timeout: 5000 },
    );
    // Not fetched until asked: the grid is about the live figures, not their history.
    expect(calls.some((c) => c.path.endsWith("/points"))).toBe(false);
    await user.click(open);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Restated 1 time\./u)).toBeVisible();
    // From what, to what, and from which source — the whole point of an append-only table.
    expect(within(dialog).getByText("$1,200,000")).toBeInTheDocument();
    expect(within(dialog).getByText("$1,250,000")).toBeInTheDocument();
    expect(within(dialog).getByText("CSV import")).toBeInTheDocument();
    expect(within(dialog).getByText("Superseded")).toBeInTheDocument();
    expect(within(dialog).getByText("Current")).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("runs a CSV dry run, and editing the CSV afterwards un-arms the import", async () => {
    const { calls } = handlers({
      "POST /api/v1/metrics/import/dry-run": () => [200, metricDryRun()],
      "POST /api/v1/metrics/import": () => [200, metricImport({ status: "done" })],
      "GET /api/v1/metrics/import/{id}": () => [200, metricImport({ status: "done" })],
    });
    await openGrid();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Import CSV" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    const csv = within(dialog).getByLabelText("CSV");
    await user.clear(csv);
    await user.type(csv, "period,arr{enter}2026-08,1250000");

    // Nothing may be imported before a dry run has said what would happen.
    const confirm = within(dialog).getByRole("button", { name: /Import 0 figures/u });
    expect(confirm).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Dry run" }));
    expect(await within(dialog).findByText(/1 rows ready/u, {}, { timeout: 5000 })).toBeVisible();
    // The admin's column mapping is what was sent, not a guess made server-side.
    expect(calls.find((c) => c.path === "/api/v1/metrics/import/dry-run")?.body).toMatchObject({
      mapping: {
        periodColumn: "period",
        periodKind: "month",
        columns: [{ key: "arr", column: "arr" }],
      },
    });
    await expectNoA11yViolations(dialog);

    // Editing the CSV invalidates the preview: a dry run that no longer describes the input
    // must not be confirmable.
    await user.type(csv, "{enter}2026-09,9999");
    expect(within(dialog).queryByText(/1 rows ready/u)).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Import 0 figures/u })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Dry run" }));
    expect(await within(dialog).findByText(/1 rows ready/u, {}, { timeout: 5000 })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: /Import 1 figure$/u }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/metrics/import")).toBe(
        true,
      ),
    );
    expect(await within(dialog).findByText(/Import done/u, {}, { timeout: 5000 })).toBeVisible();
  }, 20_000);

  it("leads the Sheets panel with the address the sheet has to be shared with", async () => {
    handlers({
      "GET /api/v1/metrics/settings": () => [
        200,
        { defaultCurrency: "USD", defaultPeriodKind: "month" },
      ],
      "GET /api/v1/metrics/sheets": () => [200, { connection: metricSheetConnection() }],
    });
    const r = await renderApp("/admin/metrics/sheets");
    expect(
      await screen.findByRole("heading", { name: "KPI settings", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // The step everybody misses, and the one the server's `unauthorized` detail names.
    expect(
      await screen.findByText("Share the sheet with this address", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("kpis@acme-metrics.iam.gserviceaccount.com")).toBeVisible();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("tells the admin when to try a sync again rather than saying it went wrong", async () => {
    handlers({
      "GET /api/v1/metrics/sheets": () => [
        200,
        {
          connection: metricSheetConnection({
            status: "failed",
            lastError: "unauthorized: share the sheet with the service account",
            consecutiveFailures: 3,
          }),
        },
      ],
      "GET /api/v1/metrics/settings": () => [
        200,
        { defaultCurrency: "USD", defaultPeriodKind: "month" },
      ],
      "POST /api/v1/metrics/sheets/sync": () =>
        new Response(
          JSON.stringify({
            error: { code: "rate_limited", message: "rate_limited", requestId: "req-test-1" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "540" } },
        ),
    });
    const r = await renderApp("/admin/metrics/sheets");
    const user = userEvent.setup();
    // The failure the server recorded is shown as the server wrote it: it is actionable.
    expect(
      await screen.findByText(/share the sheet with the service account/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    // 429 is an expected answer here — Google's quota is per project — so the screen says
    // when, not "something went wrong".
    expect(await screen.findByText(/540 seconds/u, {}, { timeout: 5000 })).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides every mutation from a reader", async () => {
    handlers({}, ["metrics.read"]);
    const r = await openGrid();
    expect(await screen.findByText("ARR", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText("ARR, Jul 2026")).toBeNull();
    expect(screen.queryByRole("button", { name: "Import CSV" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/u })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
