import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import {
  platformApi,
  platformConfig,
  platformMe,
  platformWorkspace,
  platformWorkspaceDetail,
  WS_ID,
  WS2_ID,
} from "../test/fixtures-platform.js";
import { apiError } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The operator console (E3.10): the sign-in gate, the workspaces list and one workspace. The
 * gate's job is to send the operator through the normal login / step-up screens and back — never
 * to mint an operator session on its own — and to say "not available" for the server's one
 * undifferentiated 404.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

async function open(path: string) {
  return renderApp(path, platformConfig());
}

describe("operator gate", () => {
  it("shows the sign-in gate without an operator session and sends a stale session to step-up", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/me": () => apiError(404, "not_found"),
      "POST /api/v1/platform/session": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await open("/platform");
    expect(
      await screen.findByRole("heading", { name: "Operator sign-in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Nothing is minted until the operator asks for it.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start operator session" }));
    await waitFor(() =>
      expect(pathOf(r.router)).toBe("/auth/step-up?returnTo=%2Fplatform&reason=fresh"),
    );
  }, 20_000);

  it("sends a signed-out visitor to login and back", async () => {
    platformApi({
      "GET /api/v1/platform/me": () => apiError(404, "not_found"),
      "POST /api/v1/platform/session": () => apiError(401, "unauthenticated"),
    });
    const r = await open("/platform");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Start operator session" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe("/login?returnTo=%2Fplatform"));
  }, 20_000);

  it("says the console is not available when the server answers 404", async () => {
    platformApi({
      "GET /api/v1/platform/me": () => apiError(404, "not_found"),
      "POST /api/v1/platform/session": () => apiError(404, "not_found"),
    });
    const r = await open("/platform");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Start operator session" }, { timeout: 5000 }),
    );
    expect(await screen.findByText("Operator console not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start operator session" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("opens the console once the session is minted, and signing out returns to the gate", async () => {
    let session = false;
    const { calls } = platformApi({
      "GET /api/v1/platform/me": () => (session ? [200, platformMe()] : apiError(404, "not_found")),
      "POST /api/v1/platform/session": () => {
        session = true;
        return [200, { ok: true, expiresAt: "2026-09-27T22:00:00.000Z" }];
      },
      "DELETE /api/v1/platform/session": () => {
        session = false;
        return new Response(null, { status: 204 });
      },
    });
    await open("/platform");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Start operator session" }, { timeout: 5000 }),
    );
    expect(
      await screen.findByRole("heading", { name: "Workspaces", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Operator: ops@fundroom.test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "End operator session" }));
    expect(
      await screen.findByRole("heading", { name: "Operator sign-in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/platform/session")).toBe(
      true,
    );
  }, 20_000);

  it("falls back to the gate when the operator session expires mid-use", async () => {
    let live = true;
    platformApi({
      "GET /api/v1/platform/me": () => (live ? [200, platformMe()] : apiError(404, "not_found")),
      "GET /api/v1/platform/health": () => apiError(404, "not_found"),
    });
    const r = await open("/platform");
    expect(
      await screen.findByRole("heading", { name: "Workspaces", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    live = false;
    await r.router.navigate({ to: "/platform/health" });
    expect(
      await screen.findByRole("heading", { name: "Operator sign-in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("workspaces list", () => {
  it("lists workspaces, filters through the URL and loads the next page", async () => {
    const queries: string[] = [];
    platformApi({
      "GET /api/v1/platform/workspaces": ({ url }) => {
        queries.push(url.search);
        return url.searchParams.get("cursor") === "c2"
          ? [
              200,
              {
                items: [platformWorkspace({ id: WS2_ID, slug: "beta", name: "Beta Capital" })],
                nextCursor: null,
              },
            ]
          : [
              200,
              {
                items: [
                  platformWorkspace(),
                  platformWorkspace({
                    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6003",
                    slug: "gamma",
                    name: "Gamma Fund",
                    status: "suspended",
                    suspendedReason: "billing",
                    holds: ["billing"],
                    planId: null,
                    subscription: null,
                  }),
                ],
                nextCursor: "c2",
              },
            ];
      },
    });
    const r = await open("/platform");
    const table = await screen.findByRole("table", { name: "Workspaces" }, { timeout: 5000 });
    expect(within(table).getByRole("link", { name: "Acme Ventures" })).toHaveAttribute(
      "href",
      `/platform/workspaces/${WS_ID}`,
    );
    const gamma = within(table).getByText("Gamma Fund").closest("tr") as HTMLElement;
    expect(within(gamma).getByText("Suspended")).toBeInTheDocument();
    expect(within(gamma).getByText("Reason: billing")).toBeInTheDocument();
    expect(within(gamma).getByText("No plan (unlimited)")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await within(table).findByText("Beta Capital")).toBeInTheDocument();
    expect(queries).toContainEqual("?limit=50&cursor=c2");

    await user.type(screen.getByLabelText("Search slug, name or legal name"), " acme ");
    await user.selectOptions(screen.getByLabelText("Status"), "suspended");
    await user.selectOptions(screen.getByLabelText("Plan"), "starter");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(pathOf(r.router)).toBe("/platform?q=acme&status=suspended&plan=starter"),
    );
    await waitFor(() =>
      expect(queries).toContainEqual("?q=acme&status=suspended&plan=starter&limit=50"),
    );
  }, 20_000);
});

describe("workspace detail", () => {
  it("shows status, owners (audited), subscription, sanctions and 30 days of usage", async () => {
    platformApi();
    const r = await open(`/platform/workspaces/${WS_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Acme Ventures", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("founder@acme.test")).toBeInTheDocument();
    expect(screen.getByText(/recorded in the platform audit log/u)).toBeInTheDocument();
    expect(screen.getByText("Acme Ventures GmbH")).toBeInTheDocument();
    const usage = await screen.findByRole("table", { name: "Usage per day" }, { timeout: 5000 });
    const rows = within(usage).getAllByRole("row");
    // Header + two days, newest first.
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("2026-09-26")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("2026-09-25")).toBeInTheDocument();
    expect(screen.getByText("Plan Starter")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Screening history" })).toHaveAttribute(
      "href",
      `/platform/sanctions?status=all&workspace=${WS_ID}`,
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("suspends only with a written reason", async () => {
    let current = platformWorkspaceDetail();
    const { calls } = platformApi({
      "GET /api/v1/platform/workspaces/{id}": () => [200, current],
      "POST /api/v1/platform/workspaces/{id}/suspend": () => {
        current = platformWorkspaceDetail({
          status: "suspended",
          suspendedReason: "operator",
          holds: ["operator"],
        });
        return [200, current];
      },
    });
    await open(`/platform/workspaces/${WS_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Suspend" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Suspend Acme Ventures?" });
    const confirm = within(dialog).getByRole("button", { name: "Suspend" });
    expect(confirm).toBeDisabled();
    // The dialog itself: Radix hides the page behind it, focus guards and all.
    await expectNoA11yViolations(dialog);

    await user.type(within(dialog).getByLabelText(/Reason/u), "  Chargeback fraud  ");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === `/api/v1/platform/workspaces/${WS_ID}/suspend`)?.body,
      ).toEqual({ reason: "operator", note: "Chargeback fraud" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Reason: operator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unsuspend" })).toBeInTheDocument();
  }, 20_000);

  it("keeps the dialog open with its own sentence when a sanctions suspension is unresolved", async () => {
    platformApi({
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({
          status: "suspended",
          suspendedReason: "sanctions",
          holds: ["sanctions"],
        }),
      ],
      "POST /api/v1/platform/workspaces/{id}/unsuspend": () =>
        apiError(409, "sanctions_unresolved"),
    });
    await open(`/platform/workspaces/${WS_ID}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Lift sanctions suspension" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/only once its latest screening has been cleared/u),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/u), "Customer called");
    await user.click(within(dialog).getByRole("button", { name: "Lift sanctions suspension" }));
    expect(
      await within(dialog).findByText(/Clear the screening in the sanctions queue first/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // What the operator wrote survives the refusal.
    expect(within(dialog).getByLabelText(/Reason/u)).toHaveValue("Customer called");
  }, 20_000);

  it("changes the plan and the cell, and queues a re-screen", async () => {
    const { calls } = platformApi({
      "PATCH /api/v1/platform/workspaces/{id}": ({ body }) => [
        200,
        platformWorkspace(body as Record<string, unknown>),
      ],
      "POST /api/v1/platform/workspaces/{id}/rescreen": () => new Response(null, { status: 202 }),
    });
    await open(`/platform/workspaces/${WS_ID}`);
    const user = userEvent.setup();
    const planSelect = await screen.findByLabelText("Plan", {}, { timeout: 5000 });
    const changePlan = screen.getByRole("button", { name: "Change plan" });
    expect(changePlan).toBeDisabled();
    // The selects wait for the plan and cell lists.
    await waitFor(() => expect(planSelect).toBeEnabled());
    await waitFor(() => expect(screen.getByLabelText("Cell")).toBeEnabled());
    await user.selectOptions(planSelect, "");
    await user.click(changePlan);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === `/api/v1/platform/workspaces/${WS_ID}`)
          ?.body,
      ).toEqual({ planId: null }),
    );

    await user.selectOptions(screen.getByLabelText("Cell"), "eu-2");
    await user.click(screen.getByRole("button", { name: "Change cell" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toContainEqual({
        cellId: "eu-2",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Screen again" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.path === `/api/v1/platform/workspaces/${WS_ID}/rescreen`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(/Screening queued/u)).toBeInTheDocument();
  }, 20_000);
});
