import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import {
  auditEntry,
  entitlementCatalog,
  plan,
  platformApi,
  platformConfig,
  SCREENING_ID,
  screening,
  WS_ID,
} from "../test/fixtures-platform.js";
import { apiError, type Handler, json } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The operator console's other screens (E3.10): plans (create with unlimited limits, the
 * optimistic-version conflict, archive), the sanctions queue and a decision, the platform audit
 * chain, health and the read-only operator list.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

async function open(path: string, heading: string) {
  const r = await renderApp(path, platformConfig());
  expect(
    await screen.findByRole("heading", { name: heading, level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("plans", () => {
  it("lists plans with unlimited limits spelled out", async () => {
    platformApi();
    const r = await open("/platform/plans", "Plans");
    const table = await screen.findByRole("table", { name: "Plans" }, { timeout: 5000 });
    expect(within(table).getByText("Starter")).toBeInTheDocument();
    expect(within(table).getByText("14-day trial")).toBeInTheDocument();
    // investorSeats, customDomains and emailsPerMonth are absent: unlimited, never zero.
    expect(within(table).getAllByText("Unlimited")).toHaveLength(3);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a plan, sending only the limits that are set", async () => {
    const { calls } = platformApi({
      "POST /api/v1/platform/plans": ({ body }) => [201, plan(body as Record<string, unknown>)],
    });
    const r = await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New plan" }));
    await expectNoA11yViolations(r.container);

    // Nothing is sent while the id is invalid.
    await user.type(screen.getByLabelText(/Plan id/u), "Growth");
    await user.type(screen.getByLabelText(/^Name/u), "Growth");
    await user.click(screen.getByRole("button", { name: "Create plan" }));
    expect(await screen.findByText(/starting with a letter or digit/u)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.clear(screen.getByLabelText(/Plan id/u));
    await user.type(screen.getByLabelText(/Plan id/u), "growth");
    // Staff seats: un-tick Unlimited, then give a number. Storage: 2.5 GiB.
    await user.click(screen.getByRole("checkbox", { name: "Unlimited Staff seats" }));
    await user.type(screen.getByLabelText("Staff seats"), "10");
    await user.click(screen.getByRole("checkbox", { name: "Unlimited Storage (GiB)" }));
    await user.type(screen.getByLabelText("Storage (GiB)"), "2.5");
    await user.click(screen.getByRole("checkbox", { name: "Offer this plan at signup" }));
    await user.click(screen.getByRole("button", { name: "Create plan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        id: "growth",
        name: "Growth",
        limits: { staffSeats: 10, storageBytes: 2.5 * 1024 ** 3 },
        billingPriceRef: null,
        billingMeteredPriceRefs: [],
        trialDays: 0,
        public: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Create plan" })).toBeNull());
  }, 20_000);

  it("sends metered price ids one per line, and refuses a duplicate before sending", async () => {
    const { calls } = platformApi({
      "PATCH /api/v1/platform/plans/{id}": ({ body }) => [
        200,
        plan({ ...(body as Record<string, unknown>), version: 3 }),
      ],
    });
    const r = await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Starter" }, { timeout: 5000 }),
    );
    const field = screen.getByLabelText(/Metered price ids/u);
    await user.type(field, "price_seats{Enter}{Enter}price_seats");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/listed twice/u)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await expectNoA11yViolations(r.container);

    await user.clear(field);
    await user.type(field, "  price_seats  {Enter}{Enter}price_storage");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        billingMeteredPriceRefs: ["price_seats", "price_storage"],
        version: 2,
      }),
    );
  }, 20_000);

  it("refuses a limit below its minimum instead of sending it", async () => {
    const { calls } = platformApi();
    await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New plan" }));
    await user.type(screen.getByLabelText(/Plan id/u), "tiny");
    await user.type(screen.getByLabelText(/^Name/u), "Tiny");
    await user.click(screen.getByRole("checkbox", { name: "Unlimited Staff seats" }));
    await user.type(screen.getByLabelText("Staff seats"), "0");
    await user.click(screen.getByRole("button", { name: "Create plan" }));
    expect(await screen.findByText(/at least 1, or tick Unlimited/u)).toBeInTheDocument();
    expect(screen.getByLabelText("Staff seats")).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  }, 20_000);

  it("keeps the edit on a version conflict and retries against the newer version", async () => {
    let version = 2;
    const { calls } = platformApi({
      "GET /api/v1/platform/plans": () => [200, { plans: [plan({ version })] }],
      "PATCH /api/v1/platform/plans/{id}": ({ body }) => {
        const b = body as { version: number };
        if (b.version !== version) return apiError(409, "version_conflict");
        return [200, plan({ ...(body as Record<string, unknown>), version: version + 1 })];
      },
    });
    const r = await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Starter" }, { timeout: 5000 }),
    );
    // Someone else saves first.
    version = 3;
    const name = screen.getByLabelText(/^Name/u);
    await user.clear(name);
    await user.type(name, "Starter plus");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This plan changed")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/u)).toHaveValue("Starter plus");
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Load the latest version" }));
    await waitFor(() => expect(screen.queryByText("This plan changed")).toBeNull());
    await user.clear(screen.getByLabelText(/^Name/u));
    await user.type(screen.getByLabelText(/^Name/u), "Starter plus");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
      expect(patches).toHaveLength(2);
      expect(patches[0]).toMatchObject({ version: 2, name: "Starter plus" });
      expect(patches[1]).toMatchObject({
        version: 3,
        name: "Starter plus",
        limits: { staffSeats: 5, storageBytes: 10 * 1024 ** 3 },
      });
    });
  }, 20_000);

  it("archives a plan after confirming", async () => {
    const { calls } = platformApi({
      "POST /api/v1/platform/plans/{id}/archive": () => [
        200,
        plan({ archivedAt: "2026-09-27T10:00:00.000Z" }),
      ],
    });
    await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Archive Starter" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Archive Starter?" });
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Archive plan" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.path === "/api/v1/platform/plans/starter/archive",
        ),
      ).toBe(true),
    );
  }, 20_000);
});

function plansWith(...plans: ReturnType<typeof plan>[]): Handler {
  return () => [200, { plans, entitlementCatalog: entitlementCatalog() }];
}

describe("plan entitlements (A-3)", () => {
  it("lists a plan's modules and features, and All where the plan has no list", async () => {
    platformApi({
      "GET /api/v1/platform/plans": plansWith(
        plan({
          limits: { staffSeats: 5, modules: ["crm", "data-room"], features: ["ai", "sso"] },
        }),
        plan({ id: "open", name: "Open", limits: { features: [] } }),
        plan({ id: "core", name: "Core", limits: { modules: [] } }),
      ),
    });
    const r = await open("/platform/plans", "Plans");
    const table = await screen.findByRole("table", { name: "Plans" }, { timeout: 5000 });
    const [, starter, openRow, coreRow] = within(table).getAllByRole("row");
    if (starter === undefined || openRow === undefined || coreRow === undefined) {
      throw new Error("rows");
    }
    expect(within(starter).getByText("crm, data-room")).toBeInTheDocument();
    // Display order (single sign-on before AI), not the stored alphabetical order.
    expect(within(starter).getByText("Single sign-on, AI drafting assist")).toBeInTheDocument();
    expect(within(openRow).getByText("All")).toBeInTheDocument();
    expect(within(openRow).getByText("None")).toBeInTheDocument();
    // `modules: []` keeps the required modules: Billing's words, never "None".
    expect(within(coreRow).getByText("Core modules only")).toBeInTheDocument();
    expect(within(coreRow).queryByText("None")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a plan with a module checklist, and All left ticked sends no key", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/plans": plansWith(plan()),
      "POST /api/v1/platform/plans": ({ body }) => [201, plan(body as Record<string, unknown>)],
    });
    const r = await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New plan" }));
    await user.type(screen.getByLabelText(/Plan id/u), "starter2");
    await user.type(screen.getByLabelText(/^Name/u), "Starter 2");
    const modules = screen.getByRole("group", { name: "Modules" });
    const allModules = within(modules).getByRole("checkbox", {
      name: "All (no restriction) Modules",
    });
    expect(allModules).toBeChecked();
    expect(within(modules).queryByRole("checkbox", { name: "crm" })).toBeNull();
    // Unticking All starts from the whole catalogue: the operator unticks what is left out.
    await user.click(allModules);
    expect(within(modules).getByRole("checkbox", { name: "crm" })).toBeChecked();
    expect(within(modules).getAllByRole("checkbox")).toHaveLength(
      1 + entitlementCatalog().modules.length,
    );
    for (const id of ["crm", "captable", "metrics", "round"]) {
      await user.click(within(modules).getByRole("checkbox", { name: id }));
    }
    // Features: untick All, look, tick it again — no `features` key is sent.
    const features = screen.getByRole("group", { name: "Features" });
    const allFeatures = within(features).getByRole("checkbox", {
      name: "All (no restriction) Features",
    });
    await user.click(allFeatures);
    const names = within(features)
      .getAllByRole("checkbox")
      .slice(1)
      .map((c) => c.closest("label")?.textContent);
    expect(names.slice(0, 3)).toEqual(["Data-room Q&A", "API keys", "Webhooks"]);
    expect(names).toHaveLength(12);
    await expectNoA11yViolations(r.container);
    await user.click(allFeatures);
    expect(within(features).getAllByRole("checkbox")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Create plan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
        id: "starter2",
        limits: { modules: ["analytics", "data-room", "notify", "updates"] },
      }),
    );
    const sent = calls.find((c) => c.method === "POST")?.body as { limits: object };
    expect(sent.limits).not.toHaveProperty("features");
  }, 20_000);

  it("editing a number keeps the plan's lists; ticking All removes one", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/plans": plansWith(
        plan({
          limits: { staffSeats: 5, modules: ["crm", "data-room"], features: ["sso"] },
        }),
      ),
      "PATCH /api/v1/platform/plans/{id}": ({ body }) => [
        200,
        plan({ ...(body as Record<string, unknown>), version: 3 }),
      ],
    });
    await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Starter" }, { timeout: 5000 }),
    );
    const modules = screen.getByRole("group", { name: "Modules" });
    expect(
      within(modules).getByRole("checkbox", { name: "All (no restriction) Modules" }),
    ).not.toBeChecked();
    expect(within(modules).getByRole("checkbox", { name: "crm" })).toBeChecked();
    expect(within(modules).getByRole("checkbox", { name: "metrics" })).not.toBeChecked();
    const seats = screen.getByLabelText("Staff seats");
    await user.clear(seats);
    await user.type(seats, "8");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        version: 2,
        limits: { staffSeats: 8, modules: ["crm", "data-room"], features: ["sso"] },
      }),
    );

    // Again: tick metrics in, and give features back to "All".
    await user.click(
      await screen.findByRole("button", { name: "Edit Starter" }, { timeout: 5000 }),
    );
    await user.click(
      within(screen.getByRole("group", { name: "Modules" })).getByRole("checkbox", {
        name: "metrics",
      }),
    );
    await user.click(
      within(screen.getByRole("group", { name: "Features" })).getByRole("checkbox", {
        name: "All (no restriction) Features",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toMatchObject({
        limits: { staffSeats: 5, modules: ["crm", "data-room", "metrics"] },
      }),
    );
    const second = calls.filter((c) => c.method === "PATCH")[1]?.body as { limits: object };
    expect(second.limits).not.toHaveProperty("features");
  }, 20_000);

  it("says under All that an explicit list leaves out later additions", async () => {
    platformApi();
    await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New plan" }));
    const all = within(screen.getByRole("group", { name: "Modules" })).getByRole("checkbox", {
      name: "All (no restriction) Modules",
    });
    expect(all).toHaveAccessibleDescription(/Modules added in later versions won't be included\./u);
    expect(
      within(screen.getByRole("group", { name: "Features" })).getByRole("checkbox", {
        name: "All (no restriction) Features",
      }),
    ).toHaveAccessibleDescription(/Features added in later versions won't be included\./u);
    // The default fixture carries the catalogue, as the server always does: unticking All shows it.
    await user.click(all);
    expect(
      within(screen.getByRole("group", { name: "Modules" })).getByRole("checkbox", { name: "crm" }),
    ).toBeChecked();
  }, 20_000);

  it("cannot untick All before the catalogue has loaded (it would save None)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    platformApi({
      "GET /api/v1/platform/plans": async () => {
        await gate;
        return json(200, { plans: [plan()], entitlementCatalog: entitlementCatalog() });
      },
    });
    await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New plan" }));
    const all = () =>
      within(screen.getByRole("group", { name: "Modules" })).getByRole("checkbox", {
        name: "All (no restriction) Modules",
      });
    expect(all()).toBeDisabled();
    // The disabled checkbox says why.
    expect(all()).toHaveAccessibleDescription(/The list hasn't loaded, so this stays on All/u);
    release();
    await waitFor(() => expect(all()).toBeEnabled());
    expect(all()).not.toHaveAccessibleDescription(/hasn't loaded/u);
    expect(screen.queryByText(/The list hasn't loaded/u)).toBeNull();
  }, 20_000);

  it("names the module the server refused", async () => {
    platformApi({
      "GET /api/v1/platform/plans": plansWith(plan({ limits: { modules: ["crm"] } })),
      "PATCH /api/v1/platform/plans/{id}": () =>
        apiError(400, "validation_failed", {
          details: { reason: "unknown_module", module: "crm" },
        }),
    });
    const r = await open("/platform/plans", "Plans");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Starter" }, { timeout: 5000 }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "crm is not an optional module of this build. Untick it and save again.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("sanctions", () => {
  it("lists the open queue and narrows to one workspace", async () => {
    platformApi();
    const r = await open("/platform/sanctions", "Sanctions screening");
    const table = await screen.findByRole(
      "table",
      { name: "Sanctions screening" },
      { timeout: 5000 },
    );
    expect(within(table).getByRole("link", { name: "Acme Ventures GmbH" })).toHaveAttribute(
      "href",
      `/platform/sanctions/${SCREENING_ID}`,
    );
    expect(within(table).getByText("Potential match")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await r.router.navigate({
      to: "/platform/sanctions",
      search: { status: "all", workspace: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6fff" },
    });
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  }, 20_000);

  it("clears a match only with a note, and the page shows the decision", async () => {
    let current = screening();
    const { calls } = platformApi({
      "GET /api/v1/platform/sanctions/{id}": () => [200, current],
      "POST /api/v1/platform/sanctions/{id}/decision": ({ body }) => {
        const b = body as { decision: "cleared" | "confirmed"; note: string };
        current = screening({
          decision: b.decision,
          decisionNote: b.note,
          decidedAt: "2026-09-27T10:30:00.000Z",
        });
        return [200, current];
      },
    });
    const r = await open(`/platform/sanctions/${SCREENING_ID}`, "Acme Ventures GmbH");
    const matches = screen.getByRole("table", { name: "Flagged list entries" });
    expect(within(matches).getByText("ACME VENTURES LTD")).toBeInTheDocument();
    expect(within(matches).getByText("93%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "acme" })).toHaveAttribute(
      "href",
      `/platform/workspaces/${WS_ID}`,
    );
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Confirm match" }));
    const confirmDialog = await screen.findByRole("dialog", {
      name: "Confirm the match for Acme Ventures GmbH?",
    });
    expect(within(confirmDialog).getByRole("button", { name: "Confirm match" })).toBeDisabled();
    await user.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Clear" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear Acme Ventures GmbH?" });
    await expectNoA11yViolations(dialog);
    await user.type(within(dialog).getByLabelText(/Reason/u), "Different registry number");
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === `/api/v1/platform/sanctions/${SCREENING_ID}/decision`)?.body,
      ).toEqual({
        decision: "cleared",
        note: "Different registry number",
      }),
    );
    expect(await screen.findByText("Different registry number")).toBeInTheDocument();
    // Decided: no second decision is offered.
    expect(screen.queryByRole("button", { name: "Confirm match" })).toBeNull();
  }, 20_000);
});

describe("audit, health, operators", () => {
  it("pages the platform audit chain and names operators", async () => {
    const queries: string[] = [];
    platformApi({
      "GET /api/v1/platform/audit": ({ url }) => {
        queries.push(url.search);
        return url.searchParams.get("cursor") === "a2"
          ? [
              200,
              {
                items: [
                  auditEntry({
                    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6302",
                    seq: 11,
                    action: "operator.grant",
                    actorKind: "system",
                    actorUserId: null,
                    meta: {},
                  }),
                ],
                nextCursor: null,
              },
            ]
          : [200, { items: [auditEntry()], nextCursor: "a2" }];
      },
    });
    const r = await open("/platform/audit", "Platform audit log");
    const table = await screen.findByRole(
      "table",
      { name: "Platform audit log" },
      { timeout: 5000 },
    );
    expect(within(table).getByText("workspace.suspend")).toBeInTheDocument();
    expect(within(table).getByText("Operator")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await within(table).findByText("operator.grant")).toBeInTheDocument();
    expect(queries).toContainEqual("?limit=50&cursor=a2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  }, 20_000);

  it("shows queue depth, dead letters and adapter checks", async () => {
    platformApi();
    const r = await open("/platform/health", "Health");
    expect(
      await screen.findByText(/2 jobs failed every retry/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const queues = screen.getByRole("table", { name: "Queues" });
    expect(within(queues).getByText("sanctions.screen")).toBeInTheDocument();
    const checks = screen.getByRole("table", { name: "Service checks" });
    expect(within(checks).getByText("list download failed")).toBeInTheDocument();
    expect(within(checks).getByText("Down")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lists operators read-only and points at the command line", async () => {
    const { calls } = platformApi();
    const r = await open("/platform/operators", "Operators");
    const table = await screen.findByRole("table", { name: "Operators" }, { timeout: 5000 });
    expect(within(table).getByText("ops@fundroom.test")).toBeInTheDocument();
    expect(within(table).getByText("cli:root")).toBeInTheDocument();
    expect(screen.getByText("fundroom operator grant <email>")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /grant|revoke/iu })).toBeNull();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
