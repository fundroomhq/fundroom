import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import {
  analyticsNotice,
  apiError,
  type Handler,
  installMockApi,
  pendingAcceptance,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

/*
 * The investor side of E1.6: the acceptance interstitial that stands in front of the portal,
 * and the consent control on the member's own settings page.
 */
describe("acceptance interstitial", () => {
  it("stands in front of the portal, starts unticked, and opens it once accepted", async () => {
    let pending = [pendingAcceptance()];
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ pendingAcceptances: pending })],
      "POST /api/v1/compliance/acceptances": () => {
        pending = [];
        return [200, { recorded: true, acceptedAt: "2026-09-12T10:00:00.000Z", pending }];
      },
    });
    const r = await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Before you go in" })).toBeInTheDocument();
    // In place of the portal: no nav, no home screen behind it.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Welcome/u })).toBeNull();
    // The body travels on the bootstrap, so the text is on screen with no second fetch.
    expect(screen.getByText(/We record which documents you open/u)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes("/compliance/documents"))).toEqual([]);
    await expectNoA11yViolations(r.container);

    // A pre-ticked box is not a click-wrap: the control starts unchecked and the action is
    // unavailable until the person ticks it themselves.
    const box = screen.getByRole("checkbox", {
      name: "I have read and agree to Privacy notice.",
    });
    expect(box).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "Agree and continue" });
    expect(submit).toBeDisabled();

    const user = userEvent.setup();
    await user.click(box);
    expect(box).toBeChecked();
    await user.click(submit);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/compliance/acceptances")?.body,
      ).toEqual({ documentId: pendingAcceptance().documentId, versionNo: 1 }),
    );
    // Accepting invalidates the bootstrap, and the portal opens.
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Before you go in" })).toBeNull();
  }, 20_000);

  it("lands the member here when any other call answers 403 legal_acceptance_required", async () => {
    // The server enforces the gate independently (ADR-0037 decision 5). The UI is the humane
    // path to it, so a refusal anywhere else has to end up on the same screen.
    let pending: ReturnType<typeof pendingAcceptance>[] = [];
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ pendingAcceptances: pending })],
      "GET /api/v1/analytics/notice": () => {
        pending = [pendingAcceptance()];
        return apiError(403, "legal_acceptance_required");
      },
    });
    await renderApp("/settings");
    expect(
      await screen.findByRole("heading", { name: "Before you go in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("member consent", () => {
  const base = (over: Record<string, Handler> = {}) =>
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      ...over,
    });

  it("lets a member withdraw consent from the transparency notice", async () => {
    const { calls } = base({
      "GET /api/v1/analytics/notice": () => [200, analyticsNotice()],
      "PUT /api/v1/compliance/consent": () => [
        200,
        { consentMode: "notice_only", gpc: false, purposes: [] },
      ],
    });
    const r = await renderApp("/settings");
    const box = await screen.findByRole("checkbox", { name: /measure how I read/u });
    // notice_only records until told not to, so the stored state is "on".
    expect(box).toBeChecked();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(box);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/compliance/consent")?.body,
      ).toEqual({ purpose: "analytics_engagement", granted: false, source: "settings" }),
    );
  }, 20_000);

  it("says GPC is being honoured and offers no control that would imply otherwise", async () => {
    base({
      "GET /api/v1/analytics/notice": () => [
        200,
        analyticsNotice({
          consent: { mode: "opt_out", granted: true, gpc: true, shouldAsk: false },
          dwell: false,
        }),
      ],
    });
    await renderApp("/settings");
    expect(await screen.findByText(/Global Privacy Control/u)).toBeInTheDocument();
    // A stored "yes" is overridden by the signal, so there must be nothing here to switch.
    expect(screen.queryByRole("checkbox", { name: /measure how I read/u })).toBeNull();
  }, 20_000);

  it("asks once in an opt-in workspace that has never asked", async () => {
    const { calls } = base({
      "GET /api/v1/analytics/notice": () => [
        200,
        analyticsNotice({
          consent: { mode: "opt_in", granted: null, gpc: false, shouldAsk: true },
          dwell: false,
        }),
      ],
      "PUT /api/v1/compliance/consent": () => [
        200,
        { consentMode: "opt_in", gpc: false, purposes: [] },
      ],
    });
    const r = await renderApp("/settings");
    expect(await screen.findByText("May we measure how you read?")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Yes, that is fine" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/compliance/consent")?.body,
      ).toEqual({ purpose: "analytics_engagement", granted: true, source: "settings" }),
    );
  }, 20_000);
});
