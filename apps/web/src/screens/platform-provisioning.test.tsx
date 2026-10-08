import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import {
  platformApi,
  platformConfig,
  platformMe,
  platformWorkspaceDetail,
  WS_ID,
  WS2_ID,
} from "../test/fixtures-platform.js";
import { apiError } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Operator writes the console gained in the E3.10 fix round: creating a workspace
 * (`POST /platform/workspaces`), recording a manual subscription
 * (`POST /platform/workspaces/{id}/subscription`, BILLING_DRIVER=manual only), and write answers
 * that carry no owners (only the detail GET reads them) not blanking the owners on screen.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

/** The create form (the list's filter form has a "Plan" too). */
function createForm(): HTMLElement {
  return screen.getByRole("form", { name: "New workspace" });
}

async function fillCreateForm(user: ReturnType<typeof userEvent.setup>) {
  const form = within(createForm());
  await user.type(form.getByLabelText(/^Name/u), "Böhm & Co.");
  await user.type(form.getByLabelText(/Legal name/u), "Böhm & Co. GmbH");
  await user.selectOptions(form.getByLabelText(/Country/u), "DE");
  await user.type(form.getByLabelText(/Owner's email/u), "founder@bohm.test");
}

describe("create workspace", () => {
  it("creates a workspace from the list and opens it", async () => {
    const { calls } = platformApi({
      "POST /api/v1/platform/workspaces": () => [
        201,
        platformWorkspaceDetail({ id: WS2_ID, slug: "bohm-co", name: "Böhm & Co.", owners: [] }),
      ],
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({ id: WS2_ID, slug: "bohm-co", name: "Böhm & Co." }),
      ],
    });
    const r = await renderApp("/platform", platformConfig());
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "New workspace" }, { timeout: 5000 }),
    );
    expect(await screen.findByText(/emails its owner an invitation/u)).toBeInTheDocument();
    await waitFor(() => expect(within(createForm()).getByLabelText("Plan")).toBeEnabled());
    await expectNoA11yViolations(r.container);

    // Nothing is sent while a required field is missing.
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("Enter the workspace's name.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await fillCreateForm(user);
    // The address follows the name until it is edited.
    expect(within(createForm()).getByLabelText(/Address/u)).toHaveValue("bohm-co");
    await user.selectOptions(within(createForm()).getByLabelText("Plan"), "starter");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        slug: "bohm-co",
        name: "Böhm & Co.",
        legalName: "Böhm & Co. GmbH",
        country: "DE",
        ownerEmail: "founder@bohm.test",
        planId: "starter",
      }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe(`/platform/workspaces/${WS2_ID}`));
    // The detail page reads its own copy (the write answer had no owners).
    expect(await screen.findByText("founder@acme.test", {}, { timeout: 5000 })).toBeVisible();
  }, 20_000);

  it("puts a taken address and a refused plan on their fields", async () => {
    let answer = () => apiError(409, "slug_taken");
    const { calls } = platformApi({ "POST /api/v1/platform/workspaces": () => answer() });
    const r = await renderApp("/platform", platformConfig());
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "New workspace" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(within(createForm()).getByLabelText("Plan")).toBeEnabled());
    await fillCreateForm(user);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("That address is already taken. Choose another.")).toBeVisible();
    expect(within(createForm()).getByLabelText(/Address/u)).toHaveAttribute("aria-invalid", "true");
    await expectNoA11yViolations(r.container);

    answer = () => apiError(400, "invalid_request", { details: { field: "planId" } });
    await user.clear(within(createForm()).getByLabelText(/Address/u));
    await user.type(within(createForm()).getByLabelText(/Address/u), "bohm-2");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText(/That plan can't be assigned/u)).toBeVisible();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  }, 20_000);
});

describe("manual billing", () => {
  it("records a manual subscription when the install bills by hand", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/me": () => [200, platformMe({ billingDriver: "manual" })],
      "POST /api/v1/platform/workspaces/{id}/subscription": () => [
        200,
        { status: "past_due", provider: "manual", currentPeriodEnd: "2026-10-31T00:00:00.000Z" },
      ],
    });
    const r = await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    const form = await screen.findByRole(
      "form",
      { name: "Record manual billing" },
      { timeout: 5000 },
    );
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.selectOptions(within(form).getByLabelText("Status"), "past_due");
    const end = within(form).getByLabelText(/Current period ends/u);
    await user.clear(end);
    await user.type(end, "2026-10-31");
    await user.click(within(form).getByRole("button", { name: "Save billing" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === `/api/v1/platform/workspaces/${WS_ID}/subscription`)?.body,
      ).toEqual({ status: "past_due", currentPeriodEnd: "2026-10-31T00:00:00.000Z" }),
    );
    expect(await screen.findByText("Billing recorded")).toBeInTheDocument();
  }, 20_000);

  it("is not offered when the install bills through Stripe", async () => {
    platformApi({
      "GET /api/v1/platform/me": () => [200, platformMe({ billingDriver: "stripe" })],
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({
          subscription: { status: "active", provider: "manual", currentPeriodEnd: null },
        }),
      ],
    });
    await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    expect(
      await screen.findByRole("heading", { name: "Acme Ventures", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Record manual billing" })).toBeNull();
  }, 20_000);
});

describe("holds", () => {
  it("shows every hold and lifts one at a time, keeping the others and the owners", async () => {
    let current = platformWorkspaceDetail({
      status: "suspended",
      suspendedReason: "operator",
      holds: ["billing", "operator"],
    });
    let lifted = false;
    const { calls } = platformApi({
      // After the write the refetch fails: what is on screen is the write answer as cached.
      "GET /api/v1/platform/workspaces/{id}": () =>
        lifted ? apiError(503, "service_unavailable") : [200, current],
      "POST /api/v1/platform/workspaces/{id}/unsuspend": () => {
        lifted = true;
        // The write answer carries no owners (only the detail GET reads them).
        current = platformWorkspaceDetail({
          status: "suspended",
          suspendedReason: "billing",
          holds: ["billing"],
        });
        return [200, { ...current, owners: [] }];
      },
    });
    const r = await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    expect(await screen.findByText("Reason: operator", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("Reason: billing")).toBeVisible();
    expect(screen.getByText(/More than one thing holds this workspace/u)).toBeVisible();
    // Already suspended by an operator: no second suspension to add.
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.getByRole("button", { name: "Override billing suspension" })).toBeVisible();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unsuspend" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsuspend Acme Ventures?" });
    await user.type(within(dialog).getByLabelText(/Reason/u), "Dispute settled");
    await user.click(within(dialog).getByRole("button", { name: "Unsuspend" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === `/api/v1/platform/workspaces/${WS_ID}/unsuspend`)?.body,
      ).toEqual({ note: "Dispute settled", hold: "operator" }),
    );
    await waitFor(() => expect(screen.queryByText("Reason: operator")).toBeNull());
    expect(screen.getByText("Reason: billing")).toBeVisible();
    expect(screen.getByText(/still held for another reason/u)).toBeInTheDocument();
    // The billing hold stays, and so do the owners the write answer did not carry.
    expect(screen.getByRole("button", { name: "Override billing suspension" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeVisible();
    expect(screen.getByText("founder@acme.test")).toBeVisible();
  }, 20_000);

  it("releases a new workspace's sanctions-review hold on its own", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({
          status: "pending_review",
          suspendedReason: null,
          holds: ["sanctions_review"],
        }),
      ],
      "POST /api/v1/platform/workspaces/{id}/unsuspend": () => [200, platformWorkspaceDetail()],
    });
    await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Release hold" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Reason/u), "Screened by hand");
    await user.click(within(dialog).getByRole("button", { name: "Release hold" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === `/api/v1/platform/workspaces/${WS_ID}/unsuspend`)?.body,
      ).toEqual({ note: "Screened by hand", hold: "sanctions_review" }),
    );
  }, 20_000);
});

describe("company", () => {
  it("edits the legal name and country, sending only what changed", async () => {
    const { calls } = platformApi({
      "PATCH /api/v1/platform/workspaces/{id}": () => [200, platformWorkspaceDetail()],
    });
    const r = await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    const form = await screen.findByRole("form", { name: "Company" }, { timeout: 5000 });
    const save = within(form).getByRole("button", { name: "Save company" });
    // Nothing changed yet: nothing to save.
    expect(save).toBeDisabled();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    const legal = within(form).getByLabelText(/Legal name/u);
    await user.clear(legal);
    await user.type(legal, "Acme Ventures AG");
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        legalName: "Acme Ventures AG",
      }),
    );
    expect(await screen.findByText(/Company saved/u)).toBeInTheDocument();

    await user.selectOptions(within(form).getByLabelText(/Country/u), "CH");
    await user.click(save);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        legalName: "Acme Ventures AG",
        country: "CH",
      }),
    );
  }, 20_000);

  it("refuses an empty legal name before sending", async () => {
    const { calls } = platformApi();
    await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
    const form = await screen.findByRole("form", { name: "Company" }, { timeout: 5000 });
    const user = userEvent.setup();
    await user.clear(within(form).getByLabelText(/Legal name/u));
    await user.click(within(form).getByRole("button", { name: "Save company" }));
    expect(await within(form).findByText("Enter the company's legal name.")).toBeVisible();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  }, 20_000);
});
