import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { kpiBinding, kpiProvider, kpiSources } from "../test/fixtures-kpi-slack.js";
import {
  apiError,
  type Handler,
  installMockApi,
  METRIC_DEFINITION_ID,
  METRIC_DEFINITION_ID_2,
  metricDefinition,
  metricGrid,
  metricSheetConnection,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/metrics/sources` (E3.6 §5). What it has to get right:
 *
 *  - the connection lives in the Integrations hub: a provider that is missing or unhealthy is
 *    said so in words and linked there, never connected from here;
 *  - only month-period, non-formula metrics can be bound, and the others say why;
 *  - a `historical: false` source (Stripe MRR) is flagged *before* saving: it writes the current
 *    month only;
 *  - a binding's last error is on its row.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { metrics: () => import("../modules/metrics/admin.js") },
}));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const FORMULA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a03";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions: string[]) =>
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

const definitions = () => [
  metricDefinition(),
  metricDefinition({ id: METRIC_DEFINITION_ID_2, key: "mrr", name: "MRR" }),
  metricDefinition({
    id: FORMULA_ID,
    key: "burn_multiple",
    name: "Burn multiple",
    formula: { op: "div", left: { ref: "net_burn" }, right: { ref: "net_new_arr" } } as never,
  }),
  metricDefinition({
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a04",
    key: "board_nps",
    name: "Board NPS",
    periodKind: "quarter",
  }),
];

function handlers(
  over: Record<string, Handler> = {},
  permissions = ["metrics.read", "metrics.manage", "metrics.settings"],
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/metrics/definitions": () => [200, { definitions: definitions() }],
    "GET /api/v1/metrics/grid": () => [200, metricGrid()],
    "GET /api/v1/metrics/sources": () => [200, kpiSources()],
    ...over,
  });
}

async function openSources() {
  const r = await renderApp("/admin/metrics/sources");
  expect(
    await screen.findByRole("heading", { name: "KPI sources", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  await screen.findByRole("heading", { name: "ARR", level: 3 }, { timeout: 5000 });
  return r;
}

describe("KPI sources", () => {
  it("shows each provider's connection and links to Integrations to fix it", async () => {
    handlers();
    const r = await openSources();
    expect(screen.getByText("QuickBooks Online")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.getByText("Acme Inc.")).toBeInTheDocument();
    expect(screen.getByText("Last problem: Stripe refused the key")).toBeInTheDocument();
    // Connecting happens in the hub, never here.
    expect(screen.getByRole("link", { name: "Connect Xero in Integrations" })).toHaveAttribute(
      "href",
      "/admin/integrations",
    );
    expect(screen.getByRole("link", { name: "Fix Stripe in Integrations" })).toHaveAttribute(
      "href",
      "/admin/integrations",
    );
    expect(
      screen.getByRole("link", { name: "Manage QuickBooks Online in Integrations" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a binding's source, status and last error, and says why a metric cannot be bound", async () => {
    handlers({
      "GET /api/v1/metrics/sources": () => [
        200,
        kpiSources({
          bindings: [
            kpiBinding({
              status: "failed",
              lastError: "QuickBooks refused the token",
              consecutiveFailures: 2,
            }),
          ],
        }),
      ],
    });
    const r = await openSources();
    expect(screen.getByText("QuickBooks Online · Revenue")).toBeInTheDocument();
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText(/QuickBooks refused the token · 2 failures in a row/u)).toBeVisible();
    // The formula and the quarterly metric are listed, with the reason, and cannot be bound.
    const reason = "Can't read from a source: only monthly metrics that are not formulas can.";
    expect(screen.getAllByText(reason)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Bind Burn multiple to a source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bind Board NPS to a source" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bind MRR to a source" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("binds a metric to a current-only source and warns before saving", async () => {
    const { calls } = handlers({
      "PUT /api/v1/metrics/definitions/{id}/binding": ({ body }) => [
        200,
        kpiBinding({ definitionId: METRIC_DEFINITION_ID_2, ...(body as object) }),
      ],
    });
    const r = await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Bind MRR to a source" }));
    const form = screen.getByRole("form", { name: "Source for MRR" });
    // Defaults to the first connected provider.
    expect(within(form).getByLabelText(/^Provider/u)).toHaveValue("quickbooks");
    expect(within(form).getByRole("option", { name: "Xero (not connected)" })).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText(/^Provider/u), "stripe");
    expect(within(form).queryByText(/writes the current month/u)).toBeNull();
    await user.selectOptions(within(form).getByLabelText(/^Reads/u), "mrr");
    expect(within(form).getByLabelText(/^Reads/u)).toHaveAccessibleDescription(
      /each sync writes the current month and never fills in earlier months/u,
    );
    await expectNoA11yViolations(r.container);
    await user.click(within(form).getByRole("button", { name: "Save source" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === "PUT" &&
            c.path === `/api/v1/metrics/definitions/${METRIC_DEFINITION_ID_2}/binding`,
        )?.body,
      ).toEqual({ provider: "stripe", sourceMetric: "mrr", enabled: true }),
    );
  }, 20_000);

  it("offers only the series of the metric's unit", async () => {
    handlers({
      "GET /api/v1/metrics/definitions": () => [
        200,
        {
          definitions: [
            metricDefinition({
              key: "customers",
              name: "Customers",
              unit: "count",
              currency: null,
            }),
            metricDefinition({
              id: METRIC_DEFINITION_ID_2,
              key: "churn",
              name: "Churn",
              unit: "percent",
              currency: null,
            }),
          ],
        },
      ],
      "GET /api/v1/metrics/sources": () => [200, kpiSources({ bindings: [] })],
    });
    await renderApp("/admin/metrics/sources");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Bind Customers to a source" }, { timeout: 5000 }),
    );
    const form = screen.getByRole("form", { name: "Source for Customers" });
    await user.selectOptions(within(form).getByLabelText(/^Provider/u), "stripe");
    const options = within(within(form).getByLabelText(/^Reads/u))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["New customers", "Active subscriptions (current month only)"]);
    await user.click(screen.getByRole("button", { name: "Bind Churn to a source" }));
    const churn = screen.getByRole("form", { name: "Source for Churn" });
    expect(within(churn).getByText(/No QuickBooks Online series fits/u)).toBeInTheDocument();
    expect(within(churn).getByRole("button", { name: "Save source" })).toBeDisabled();
  }, 20_000);

  it("queues a sync, then re-reads the bindings until the job has run", async () => {
    let reads = 0;
    const { calls } = handlers({
      "GET /api/v1/metrics/sources": () => {
        reads += 1;
        // The first two reads are before the job has run; the third sees it.
        return [
          200,
          reads < 3
            ? kpiSources()
            : kpiSources({
                bindings: [kpiBinding({ lastSyncAt: "2026-09-26T09:00:00.000Z" })],
              }),
        ];
      },
      "POST /api/v1/metrics/sources/sync": () => [202, { queued: true }],
    });
    const r = await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Sync queued")).toBeInTheDocument();
    // Nothing is read inline: one POST, no result body to show.
    expect(calls.filter((c) => c.path === "/api/v1/metrics/sources/sync")).toHaveLength(1);
    await expectNoA11yViolations(r.container);
    expect(await screen.findByText("Sync finished", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    // Polling stops once the job is seen.
    const settled = reads;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(reads).toBe(settled);
  }, 20_000);

  it("keeps polling while a binding is still syncing", async () => {
    let reads = 0;
    handlers({
      "GET /api/v1/metrics/sources": () => {
        reads += 1;
        return [
          200,
          kpiSources({
            bindings: [kpiBinding(reads === 1 ? {} : { status: "syncing" })],
          }),
        ];
      },
      "POST /api/v1/metrics/sources/sync": () => [202, { queued: true }],
    });
    await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Sync queued")).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3), { timeout: 8000 });
    // `syncing` differs from the baseline but is not a finished job.
    expect(screen.queryByText("Sync finished")).toBeNull();
    expect(screen.getByText("Sync queued")).toBeInTheDocument();
  }, 20_000);

  it("shows where history starts and a persistent history note as a warning", async () => {
    handlers({
      "GET /api/v1/metrics/sources": () => [
        200,
        kpiSources({
          bindings: [
            kpiBinding({
              historyFrom: "2026-07",
              historyNote: "history too large to backfill: synced the trailing 3 months only",
            }),
          ],
        }),
      ],
    });
    const r = await openSources();
    expect(screen.getByText("History from Jul 2026")).toBeInTheDocument();
    const note = screen.getByText(/history too large to backfill/u);
    expect(note.closest("dd")).not.toHaveClass("text-destructive");
    expect(screen.getByText("Warning")).toBeInTheDocument();
    // A healthy binding with a truncated history is still healthy.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an ok binding's note as a warning, not an error", async () => {
    handlers({
      "GET /api/v1/metrics/sources": () => [
        200,
        kpiSources({
          bindings: [
            kpiBinding({
              status: "ok",
              lastError: "history too large to backfill: synced the trailing 3 months only",
            }),
          ],
        }),
      ],
    });
    const r = await openSources();
    const note = screen.getByText(/history too large to backfill/u);
    expect(note.closest("dd")).not.toHaveClass("text-destructive");
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("Last error")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("names the Google Sheets mapping when a bind overlaps it", async () => {
    handlers({
      "PUT /api/v1/metrics/definitions/{id}/binding": () =>
        apiError(409, "conflict", { reason: "source_overlap" }),
    });
    const r = await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Bind MRR to a source" }));
    const form = screen.getByRole("form", { name: "Source for MRR" });
    await user.click(within(form).getByRole("button", { name: "Save source" }));
    expect(
      await within(form).findByText("Google Sheets already feeds this metric"),
    ).toBeInTheDocument();
    expect(within(form).getByText(/MRR is written by the Google Sheets mapping/u)).toBeVisible();
    expect(
      within(form).getByRole("link", { name: "Open the Google Sheets mapping" }),
    ).toHaveAttribute("href", "/admin/metrics/sheets");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lists the bound keys when a Sheets mapping overlaps a KPI source", async () => {
    handlers({
      "GET /api/v1/metrics/settings": () => [
        200,
        { defaultCurrency: "USD", defaultPeriodKind: "month" },
      ],
      "GET /api/v1/metrics/sheets": () => [200, { connection: metricSheetConnection() }],
      "PUT /api/v1/metrics/sheets": () =>
        apiError(409, "conflict", { reason: "source_overlap", keys: ["arr", "mrr"] }),
    });
    const r = await renderApp("/admin/metrics/sheets");
    const user = userEvent.setup();
    const json = await screen.findByLabelText(/^Service account JSON/u, {}, { timeout: 5000 });
    await user.click(json);
    await user.paste('{"type":"service_account"}');
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(
      await screen.findByText("Some mapped metrics already read from a KPI source"),
    ).toBeInTheDocument();
    expect(screen.getByText("arr")).toBeInTheDocument();
    expect(screen.getByText("mrr")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open KPI sources" })).toHaveAttribute(
      "href",
      "/admin/metrics/sources",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("unbinds after confirming", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/metrics/definitions/{id}/binding": () => [200, { ok: true }],
    });
    await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unbind ARR" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unbind" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.path === `/api/v1/metrics/definitions/${METRIC_DEFINITION_ID}/binding`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("shows the rate limit as a normal answer", async () => {
    handlers({
      "POST /api/v1/metrics/sources/sync": () => apiError(429, "rate_limited"),
    });
    await openSources();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Sync queued")).toBeNull();
  }, 20_000);

  it("says nothing is connected and links to Integrations", async () => {
    handlers({
      "GET /api/v1/metrics/sources": () => [
        200,
        kpiSources({
          providers: [
            kpiProvider({ provider: "quickbooks", connected: false }),
            kpiProvider({ provider: "xero", connected: false }),
            kpiProvider({ provider: "stripe", connected: false }),
          ],
          bindings: [],
        }),
      ],
    });
    const r = await openSources();
    expect(screen.getByText("No source is connected yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute(
      "href",
      "/admin/integrations",
    );
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links the grid to KPI sources for metrics.settings", async () => {
    handlers();
    await renderApp("/admin/metrics");
    expect(
      await screen.findByRole("link", { name: "KPI sources" }, { timeout: 5000 }),
    ).toHaveAttribute("href", "/admin/metrics/sources");
  }, 20_000);

  it("hides the KPI sources link without metrics.settings", async () => {
    handlers({}, ["metrics.read", "metrics.manage"]);
    await renderApp("/admin/metrics");
    await screen.findByRole("heading", { name: "KPIs", level: 1 }, { timeout: 5000 });
    expect(screen.queryByRole("link", { name: "KPI sources" })).toBeNull();
  }, 20_000);
});
