import type { FundRoomSchemas } from "@fundroom/sdk";
import { FundRoomApiError } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "../lib/api.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import { staffBootstrap, staffMe } from "../test/fixtures-billing.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Data residency for the tenant (E3.11, ADR-0059): `/admin/settings/residency` shows the region
 * the host DECLARED (or that none is declared), every part of the deployment with an in-region
 * badge, the vendors split into the host's and the workspace's own with out-of-region flags, a
 * way to the DPA template, and a banner while a move runs. And the relocation hold's own words
 * wherever a hold is explained to staff.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

type Residency = FundRoomSchemas["Residency"];

function residency(over: Partial<Residency> = {}): Residency {
  return {
    region: {
      code: "eu-central",
      label: "European Union (Frankfurt, Germany)",
      jurisdiction: "eu",
    },
    declared: "operator",
    cellId: "eu-1",
    components: [
      { component: "database", location: "Frankfurt, Germany", jurisdiction: "eu", inRegion: true },
      { component: "email", location: "United States", jurisdiction: "us", inRegion: false },
      { component: "telemetry", location: null, jurisdiction: null, inRegion: null },
      {
        component: "virusScan",
        location: "Frankfurt, Germany",
        jurisdiction: "eu",
        inRegion: true,
      },
    ],
    subProcessors: [
      {
        name: "Postmark",
        purpose: "Transactional email",
        dataProcessed: "Recipient addresses, message content",
        location: "United States",
        jurisdiction: "us",
        transferMechanism: "EU SCCs (Module 3)",
        dpaUrl: "https://postmarkapp.com/dpa",
        certifications: ["SOC 2"],
        scope: "deployment",
        outsideRegion: true,
      },
      {
        name: "Amazon S3",
        purpose: "File storage",
        dataProcessed: "Uploaded documents",
        location: "Frankfurt, Germany",
        jurisdiction: "eu",
        transferMechanism: null,
        dpaUrl: "javascript:alert(1)",
        certifications: [],
        scope: "deployment",
        outsideRegion: false,
      },
      {
        name: "DocuSign",
        purpose: "E-signature",
        dataProcessed: "Signer names and addresses",
        location: "Global",
        jurisdiction: "varies",
        transferMechanism: null,
        dpaUrl: null,
        certifications: [],
        scope: "workspace",
        outsideRegion: null,
      },
    ],
    relocation: null,
    ...over,
  };
}

const RESIDENCY_SLOT = {
  id: "residency",
  version: "0.1.0",
  enabled: true,
  hidden: false,
  readOnly: false,
  flags: {},
  slots: {
    "admin.settings": [
      {
        id: "residency",
        label: "Data residency",
        to: "/admin/settings/residency",
        order: 39,
        icon: "residency",
      },
    ],
  },
};

function handlers(over: Record<string, Handler> = {}, permissions = ["compliance.read"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [RESIDENCY_SLOT],
        permissions,
        membership: { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07", kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/residency": () => [200, residency()],
    ...over,
  });
}

async function open() {
  const r = await renderApp("/admin/settings/residency");
  await screen.findByRole("heading", { name: "Data residency", level: 1 }, { timeout: 5000 });
  await screen.findByText("Where your data lives", {}, { timeout: 5000 });
  return r;
}

function cardOf(title: string): HTMLElement {
  return screen
    .getByText(title, { selector: "[data-slot=card-title]" })
    .closest("[data-slot=card]") as HTMLElement;
}

describe("residency page", () => {
  it("is offered on the settings hub", async () => {
    handlers();
    const r = await renderApp("/admin/settings");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("link", { name: "Data residency" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/settings/residency"));
  }, 20_000);

  it("shows the declared region, every part with its badge and the vendors by scope", async () => {
    handlers();
    const r = await open();
    const region = cardOf("Where your data lives");
    expect(region).toHaveTextContent("European Union (Frankfurt, Germany)");
    expect(region).toHaveTextContent("Declared by your host");
    expect(region).toHaveTextContent("eu-central");
    expect(region).toHaveTextContent("eu-1");
    // Kept apart from the privacy regime, with a persistently underlined link to it.
    expect(region).toHaveTextContent(/The privacy regime in Legal settings is separate/u);
    const regime = within(region).getByRole("link", { name: "Privacy regime in Legal settings" });
    expect(regime).toHaveClass("underline");
    expect(regime).toHaveAttribute("href", "/admin/legal?tab=settings");

    const parts = within(cardOf("Parts of the deployment")).getAllByRole("row").slice(1);
    expect(parts.map((row) => row.textContent)).toEqual([
      "DatabaseFrankfurt, GermanyEuropean UnionIn region",
      "Email deliveryUnited StatesUnited StatesOutside region",
      "TelemetryNot declaredNot declaredUnknown",
      "Virus scanning (uploaded files)Frankfurt, GermanyEuropean UnionIn region",
    ]);

    const host = cardOf("Vendors chosen by your host");
    const hostRows = within(host).getAllByRole("row").slice(1);
    // Sorted by name; the flag is per vendor.
    expect(hostRows[0]).toHaveTextContent(/^Amazon S3/u);
    expect(hostRows[0]).toHaveTextContent("In region");
    expect(hostRows[1]).toHaveTextContent(/^Postmark/u);
    expect(hostRows[1]).toHaveTextContent("Outside region");
    expect(hostRows[1]).toHaveTextContent("EU SCCs (Module 3)");
    const dpa = within(hostRows[1] as HTMLElement).getByRole("link", {
      name: "Postmark DPA (opens in a new tab)",
    });
    expect(dpa).toHaveAttribute("href", "https://postmarkapp.com/dpa");
    expect(dpa).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // A vendor URL that is not https is never rendered as a link.
    expect(within(hostRows[0] as HTMLElement).queryByRole("link")).toBeNull();
    expect(host).not.toHaveTextContent("DocuSign");

    const own = cardOf("Vendors connected by this workspace");
    expect(own).toHaveTextContent("DocuSign");
    expect(own).toHaveTextContent("Varies / not identified");
    expect(own).toHaveTextContent("Unknown");
    expect(own).toHaveTextContent("Not stated");
    expect(screen.queryByRole("status")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says when the host declared no region, and marks nothing in or out of it", async () => {
    handlers({
      "GET /api/v1/residency": () => [
        200,
        residency({
          region: null,
          cellId: null,
          components: [
            { component: "database", location: null, jurisdiction: null, inRegion: null },
          ],
          subProcessors: [],
        }),
      ],
    });
    const r = await open();
    expect(screen.getByText("Your host has not declared a data region.")).toBeInTheDocument();
    expect(screen.queryByText("Declared by your host")).toBeNull();
    expect(cardOf("Parts of the deployment")).toHaveTextContent(
      /With no region declared, nothing can be marked in or outside it/u,
    );
    expect(
      screen.getByText("Your host uses no third-party vendor for this workspace's data."),
    ).toBeInTheDocument();
    expect(screen.getByText("This workspace has not connected any vendor.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a banner while the host moves the workspace to another region", async () => {
    handlers({
      "GET /api/v1/residency": () => [
        200,
        residency({
          relocation: {
            state: "importing",
            targetRegion: "us-east",
            requestedAt: "2026-09-27T09:30:00.000Z",
          },
        }),
      ],
    });
    const r = await open();
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Move to another region");
    expect(banner).toHaveTextContent(/Your host is moving this workspace's data to us-east/u);
    expect(banner).toHaveTextContent("Status: Importing");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links to the DPA template in Legal, picked and ready", async () => {
    handlers(
      {
        "GET /api/v1/compliance/documents": () => [200, { documents: [] }],
        "GET /api/v1/compliance/templates": () => [
          200,
          {
            templates: [
              {
                id: "dpa",
                title: "Data processing agreement",
                version: 1,
                audience: "staff",
                jurisdiction: ["eu"],
                mergeFields: ["company.name"],
                requiresAcceptance: false,
                bodySha256: "b".repeat(64),
              },
            ],
          },
        ],
      },
      ["compliance.read", "compliance.manage"],
    );
    const r = await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Start a DPA from the template" }));
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/legal?tab=documents&template=dpa"));
    const template = await screen.findByRole(
      "combobox",
      { name: /Start from/u },
      { timeout: 5000 },
    );
    await waitFor(() => expect(template).toHaveValue("dpa"));
    expect(screen.getByRole("textbox", { name: /Name in URLs/u })).toHaveValue("dpa");
  }, 20_000);

  it("refuses a member without the legal read permission and never asks the server", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/settings/residency");
    expect(
      await screen.findByText(
        /Only members who can see this workspace's legal settings/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/residency")).toBe(false);
  }, 20_000);
});

describe("residency during a move", () => {
  const relocating = (permissions = ["compliance.read"], reason = "relocation") =>
    staffBootstrap({
      permissions,
      workspaceStatus: { status: "suspended", reason: reason as "relocation" },
    });

  it("stays readable while the host moves the workspace, with the banner", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, relocating()],
      "GET /api/v1/residency": () => [
        200,
        residency({
          relocation: {
            state: "exporting",
            targetRegion: "us-east",
            requestedAt: "2026-09-27T09:30:00.000Z",
          },
        }),
      ],
    });
    const r = await renderApp("/admin/settings/residency", testConfig({ billing: false }));
    const title = await screen.findByText("Move to another region", {}, { timeout: 5000 });
    const banner = title.closest("[role=status]") as HTMLElement;
    expect(banner).toHaveTextContent(/moving this workspace's data to us-east/u);
    expect(banner).toHaveTextContent("Status: Exporting");
    // The shell still says why everything else is quiet, and offers the way back here.
    const strip = r.container.querySelector("[data-slot=app-shell-banner]") as HTMLElement;
    expect(strip).toHaveTextContent(/moving this workspace to another data region/u);
    const nav = screen.getByRole("navigation", { name: /admin/iu });
    expect(within(nav).getByRole("link", { name: "Data residency" })).toBeInTheDocument();
    // Every other admin screen is the unavailable panel now: the page links to none of them.
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("link", { name: "Back to settings" })).toBeNull();
    expect(within(main).queryByRole("link", { name: /Privacy regime/u })).toBeNull();
    expect(within(main).queryByRole("link", { name: /Start a DPA/u })).toBeNull();
    expect(within(main).getByText(/Legal opens again once the move is done/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a 423 from an older server as the move, not as an error to fix", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, relocating()],
      "GET /api/v1/residency": () =>
        apiError(423, "workspace_unavailable", {
          details: { workspaceStatus: "suspended", reason: "relocation" },
        }),
    });
    const r = await renderApp("/admin/settings/residency", testConfig({ billing: false }));
    expect(
      await screen.findByText(
        /Your host is moving it to another data region/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps the page closed for other holds and for members without the permission", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, relocating(["compliance.read"], "operator")],
      "GET /api/v1/residency": () => [200, residency()],
    });
    await renderApp("/admin/settings/residency", testConfig({ billing: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Data residency" })).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/residency")).toBe(false);
    vi.unstubAllGlobals();

    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, relocating([])],
    });
    await renderApp("/admin/settings/residency", testConfig({ billing: false }));
    expect(
      (
        await screen.findAllByRole(
          "heading",
          { name: "This workspace is unavailable" },
          { timeout: 5000 },
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Data residency" })).toBeNull();
  }, 20_000);

  it("lists two vendors of the same name with different purposes without a key clash", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = residency().subProcessors[0] as Residency["subProcessors"][number];
    handlers({
      "GET /api/v1/residency": () => [
        200,
        residency({
          subProcessors: [
            { ...base, name: "Amazon Web Services", purpose: "Email delivery" },
            { ...base, name: "Amazon Web Services", purpose: "File storage" },
          ],
        }),
      ],
    });
    await open();
    const rows = within(cardOf("Vendors chosen by your host")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[1]?.textContent)).toEqual([
      "Email delivery",
      "File storage",
    ]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  }, 20_000);
});

describe("relocation hold copy", () => {
  it("tells staff the workspace is being moved, not suspended", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "suspended", reason: "relocation" } }),
      ],
    });
    const r = await renderApp("/admin/settings", testConfig({ billing: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    const strip = r.container.querySelector("[data-slot=app-shell-banner]") as HTMLElement;
    expect(strip).toHaveTextContent(/Your host is moving this workspace to another data region/u);
    // Not the generic sentence, and not a sanctions review.
    expect(screen.queryByText(/compliance review|unavailable at the moment/u)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps investors on the one generic screen", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({ workspaceStatus: { status: "suspended", reason: null } }),
      ],
    });
    await renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "This portal is unavailable" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/moving|region/iu)).toBeNull();
  }, 20_000);

  it("explains a 423 with reason relocation as a move", () => {
    const failure = (details: Record<string, unknown>) =>
      new FundRoomApiError(
        423,
        { error: { code: "workspace_unavailable", message: "x", details } as never },
        undefined,
      );
    expect(describeError(failure({ reason: "relocation" })).body).toMatch(
      /moving it to another data region/u,
    );
    expect(describeError(failure({ reason: "operator" })).body).toMatch(
      /suspended or under review/u,
    );
  });
});
