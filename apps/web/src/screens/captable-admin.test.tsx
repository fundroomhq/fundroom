import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  captableDetail,
  captablePreview,
  captableSettings,
  captableSnapshot,
  PUBLISHED_ID,
  SNAPSHOT_ID,
  SUPERSEDED_ID,
} from "../test/fixtures-captable.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/captable` (E3.6 §8). What this screen has to get right:
 *
 *  - an import is **paste → dry run → draft**, and a dry run that no longer describes the input
 *    (any field edited since) cannot be confirmed;
 *  - the server's refusal of a file says **what** was wrong, line by line;
 *  - figures are printed from the server's decimal strings — nothing re-adds them;
 *  - publishing is confirmed, names the snapshot it supersedes and goes through step-up;
 *    deleting a draft is typed-confirmed; a published snapshot offers neither.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { captable: () => import("../modules/captable/admin.js") },
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

const staffBootstrap = (permissions = ["captable.read", "captable.manage"]) =>
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
          "admin.nav": [
            {
              id: "captable-admin",
              label: "Cap table",
              to: "/admin/captable",
              order: 38,
              icon: "pie-chart",
            },
          ],
        },
      },
    ],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

const snapshots = () => [
  captableSnapshot(),
  captableSnapshot({
    id: PUBLISHED_ID,
    asOf: "2026-06-30",
    source: "csv",
    status: "published",
    publishedAt: "2026-07-02T09:00:00.000Z",
  }),
  captableSnapshot({
    id: SUPERSEDED_ID,
    asOf: "2025-12-31",
    source: "pulley",
    status: "superseded",
    publishedAt: "2026-01-05T09:00:00.000Z",
  }),
];

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/captable/snapshots": () => [200, { snapshots: snapshots() }],
    "GET /api/v1/captable/snapshots/{id}": () => [200, captableDetail()],
    "GET /api/v1/captable/settings": () => [200, captableSettings()],
    ...over,
  });
}

async function open(path: string, heading: string | RegExp) {
  const r = await renderApp(path);
  expect(
    await screen.findByRole("heading", { name: heading, level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("cap table admin: snapshots", () => {
  it("lists drafts, the published snapshot and superseded ones, each linking to its summary", async () => {
    handlers();
    const r = await open("/admin/captable", "Cap table");
    const table = await screen.findByRole("table", {}, { timeout: 5000 });
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("Published")).toBeInTheDocument();
    expect(within(table).getByText("Superseded")).toBeInTheDocument();
    expect(within(table).getByText("Carta")).toBeInTheDocument();
    expect(within(table).getByText("Pulley")).toBeInTheDocument();
    // Fully diluted, printed from the server's decimal string without its six zeros.
    expect(within(table).getAllByText("11,000,000").length).toBe(3);
    const link = within(table).getByRole("link", { name: "Sep 1, 2026" });
    expect(link).toHaveAttribute("href", `/admin/captable/snapshots/${SNAPSHOT_ID}`);
    expect(link.className).toContain("underline");
    expect(screen.getByRole("link", { name: "Import" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an empty state that leads to the import", async () => {
    handlers({ "GET /api/v1/captable/snapshots": () => [200, { snapshots: [] }] });
    const r = await open("/admin/captable", "Cap table");
    expect(await screen.findByText("No cap table yet", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Import" }).length).toBeGreaterThan(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("offers a reader without captable.manage no import, settings, publish or delete", async () => {
    handlers({}, ["captable.read"]);
    await open("/admin/captable", "Cap table");
    await screen.findByRole("table", {}, { timeout: 5000 });
    expect(screen.queryByRole("link", { name: "Import" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  }, 20_000);
});

describe("cap table admin: one snapshot", () => {
  it("summarises a draft fully diluted by class, with the pool, SAFEs and holders", async () => {
    handlers();
    const r = await open(`/admin/captable/snapshots/${SNAPSHOT_ID}`, "Cap table as of Sep 1, 2026");
    expect(await screen.findByText(/This is a draft/u, {}, { timeout: 5000 })).toBeVisible();
    // Totals: the server's figures, formatted, not recomputed.
    expect(screen.getByText("Fully diluted shares")).toBeInTheDocument();
    expect(
      screen.getByText("1,000,000 in the pool: 400,000 granted, 600,000 available"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("$500,000").length).toBeGreaterThan(0);
    const classes = screen.getByRole("table", { name: "Fully diluted by class" });
    const seed = within(classes).getByRole("row", { name: /Series Seed Preferred/u });
    expect(within(seed).getByText("18.1818%")).toBeInTheDocument();
    expect(within(classes).getByText("Option pool")).toBeInTheDocument();
    // Under both %-FD tables: per-row rounding means a column need not sum to 100.
    expect(screen.getAllByText(/may not add up to exactly 100%/u).length).toBe(2);
    const holders = screen.getByRole("table", { name: "Holders" });
    expect(within(holders).getByText("Angel Fund LP")).toBeInTheDocument();
    expect(within(holders).getByText("Not matched")).toBeInTheDocument();
    expect(within(holders).getAllByText("Linked").length).toBe(2);
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete draft" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("publishes after a confirmation that names the snapshot it supersedes", async () => {
    const { calls } = handlers({
      "POST /api/v1/captable/snapshots/{id}/publish": () => [
        200,
        captableSnapshot({ status: "published", publishedAt: "2026-09-26T10:00:00.000Z" }),
      ],
    });
    await open(`/admin/captable/snapshots/${SNAPSHOT_ID}`, "Cap table as of Sep 1, 2026");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Publish" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", {
      name: "Publish the snapshot as of Sep 1, 2026?",
    });
    expect(within(dialog).getByText(/replaces the snapshot as of Jun 30, 2026/u)).toBeVisible();
    await expectNoA11yViolations(dialog);
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" && c.path === `/api/v1/captable/snapshots/${SNAPSHOT_ID}/publish`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("sends a stale admin to step-up when publishing", async () => {
    handlers({
      "POST /api/v1/captable/snapshots/{id}/publish": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await open(`/admin/captable/snapshots/${SNAPSHOT_ID}`, /Cap table as of/u);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Publish" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain(`returnTo=%2Fadmin%2Fcaptable%2Fsnapshots%2F${SNAPSHOT_ID}`);
  }, 20_000);

  it("deletes a draft only after its date is typed back, then returns to the list", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/captable/snapshots/{id}": () => [200, { ok: true }],
    });
    const r = await open(`/admin/captable/snapshots/${SNAPSHOT_ID}`, /Cap table as of/u);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Delete draft" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete the draft as of Sep 1, 2026?",
    });
    const confirm = within(dialog).getByRole("button", { name: "Delete draft" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type 2026-09-01 to confirm"), "2026-09-01");
    await expectNoA11yViolations(dialog);
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/captable/snapshots/${SNAPSHOT_ID}`,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/captable"));
  }, 20_000);

  it("offers no publish or delete on a published snapshot: it is a record", async () => {
    handlers({
      "GET /api/v1/captable/snapshots/{id}": () => [
        200,
        captableDetail({
          snapshot: captableSnapshot({
            id: PUBLISHED_ID,
            asOf: "2026-06-30",
            status: "published",
            publishedAt: "2026-07-02T09:00:00.000Z",
          }),
        }),
      ],
    });
    const r = await open(`/admin/captable/snapshots/${PUBLISHED_ID}`, /Cap table as of Jun 30/u);
    expect(await screen.findByText(/^Published Jul 2, 2026/u, {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete draft" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("cap table admin: import", () => {
  it("runs a dry run first, and editing any field afterwards un-arms the import", async () => {
    const { calls } = handlers({
      "POST /api/v1/captable/import/dry-run": () => [200, captablePreview()],
      "POST /api/v1/captable/import": () => [
        201,
        { snapshot: captableSnapshot(), preview: captablePreview() },
      ],
    });
    const r = await open("/admin/captable/import", "Import a cap table");
    const user = userEvent.setup();
    const confirm = screen.getByRole("button", { name: "Import as draft" });
    // Nothing may be imported before a dry run has said what would happen.
    expect(confirm).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Format"), "carta");
    await user.type(screen.getByLabelText(/^As of/u), "2026-09-01");
    const csv = screen.getByLabelText(/^CSV/u);
    await user.clear(csv);
    await user.type(csv, "Stakeholder,Security{enter}Ada Lovelace,Series Seed");
    await user.click(screen.getByRole("button", { name: "Dry run" }));

    expect(
      await screen.findByText(/6 rows in 5 classes\. 3 holders matched a member, 1 did not\./u),
    ).toBeVisible();
    expect(calls.find((c) => c.path === "/api/v1/captable/import/dry-run")?.body).toEqual({
      format: "carta",
      asOf: "2026-09-01",
      csv: "Stakeholder,Security\nAda Lovelace,Series Seed",
    });
    // Warnings say where, then what the server said.
    expect(
      screen.getByText("Line 7, column issued_on: issue date not understood; left empty"),
    ).toBeVisible();
    // The holder with no member is named, so the admin can invite them or fix the email.
    const unmatched = screen.getByRole("heading", { name: "Holders not matched to a member" });
    expect(unmatched.parentElement).toHaveTextContent("Angel Fund LP");
    expect(screen.getByRole("button", { name: "Import as draft" })).toBeEnabled();
    await expectNoA11yViolations(r.container);

    // Editing the date invalidates the preview: it no longer describes what would be sent.
    await user.clear(screen.getByLabelText(/^As of/u));
    await user.type(screen.getByLabelText(/^As of/u), "2026-09-02");
    expect(screen.queryByText(/6 rows in 5 classes/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Import as draft" })).toBeDisabled();
    // …and so does editing the CSV.
    await user.click(screen.getByRole("button", { name: "Dry run" }));
    await screen.findByText(/6 rows in 5 classes/u);
    await user.type(csv, "x");
    expect(screen.getByRole("button", { name: "Import as draft" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Dry run" }));
    await screen.findByText(/6 rows in 5 classes/u);
    await user.click(screen.getByRole("button", { name: "Import as draft" }));
    await waitFor(() => expect(pathOf(r.router)).toBe(`/admin/captable/snapshots/${SNAPSHOT_ID}`));
    expect(
      calls.find((c) => c.method === "POST" && c.path === "/api/v1/captable/import")?.body,
    ).toMatchObject({ format: "carta", asOf: "2026-09-02" });
  }, 20_000);

  it("says what was wrong with a refused file, line by line", async () => {
    handlers({
      "POST /api/v1/captable/import/dry-run": () =>
        apiError(422, "captable_import_invalid", {
          reason: "missing_columns",
          problems: [
            { line: null, column: "shares", code: "missing_column", message: "required" },
            { line: 4, column: null, code: "bad_row", message: "holder name is empty" },
          ],
        }),
    });
    const r = await open("/admin/captable/import", "Import a cap table");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^As of/u), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Dry run" }));
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(within(alert).getByText("The CSV could not be imported")).toBeVisible();
    expect(within(alert).getByText("Required columns are missing for this format.")).toBeVisible();
    expect(within(alert).getByText("Column shares: required")).toBeVisible();
    expect(within(alert).getByText("Line 4: holder name is empty")).toBeVisible();
    expect(screen.getByRole("button", { name: "Import as draft" })).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("cap table admin: settings", () => {
  it("saves the investor view, and an empty disclaimer means the built-in text", async () => {
    const { calls } = handlers({
      "GET /api/v1/captable/settings": () => [
        200,
        captableSettings({ disclaimer: "Our own words." }),
      ],
      "PUT /api/v1/captable/settings": ({ body }) => [
        200,
        captableSettings(body as Partial<ReturnType<typeof captableSettings>>),
      ],
    });
    const r = await open("/admin/captable/settings", "Cap table settings");
    const user = userEvent.setup();
    const view = await screen.findByLabelText("What investors see", {}, { timeout: 5000 });
    expect(view).toHaveValue("own_line");
    const disclaimer = screen.getByLabelText("Disclaimer");
    expect(disclaimer).toHaveValue("Our own words.");
    await expectNoA11yViolations(r.container);
    await user.selectOptions(view, "summary");
    await user.clear(disclaimer);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        investorView: "summary",
        disclaimer: null,
      }),
    );
  }, 20_000);

  it("sends a stale admin to step-up when saving the settings", async () => {
    handlers({
      "PUT /api/v1/captable/settings": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await open("/admin/captable/settings", "Cap table settings");
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("What investors see", {}, { timeout: 5000 }),
      "none",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fcaptable%2Fsettings");
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);
});
