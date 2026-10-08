import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y.js";
import { bootstrap, me } from "../../test/fixtures.js";
import { analyticsNotice, installMockApi } from "../../test/mock-api.js";
import { renderApp } from "../../test/render.js";

/*
 * The email-tracking control (E2.6) renders the server's decision and nothing else: `allowed`
 * from `GET /compliance/consent`, never `granted` re-folded with the consent mode in the browser.
 * Under Global Privacy Control it stays visible — off, disabled, and saying why.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

type ConsentState = FundRoomSchemas["ConsentState"];

function consentState(over: {
  gpc?: boolean;
  consentMode?: ConsentState["consentMode"];
  email: { granted: boolean | null; allowed: boolean };
}): ConsentState {
  return {
    consentMode: over.consentMode ?? "notice_only",
    gpc: over.gpc ?? false,
    purposes: [
      {
        purpose: "analytics_engagement",
        granted: null,
        source: null,
        recordedAt: null,
        allowed: !(over.gpc ?? false),
      },
      {
        purpose: "email_tracking",
        granted: over.email.granted,
        source: over.email.granted === null ? null : over.gpc ? "gpc" : "settings",
        recordedAt: over.email.granted === null ? null : "2026-09-12T10:00:00.000Z",
        allowed: over.email.allowed,
      },
    ],
  };
}

function mount(state: ConsentState, notice = analyticsNotice()) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, bootstrap()],
    "GET /api/v1/analytics/notice": () => [200, notice],
    "GET /api/v1/compliance/consent": () => [200, state],
  });
}

describe("email tracking consent control", () => {
  it("stays visible under GPC, off and disabled, and says why", async () => {
    mount(
      consentState({ gpc: true, email: { granted: false, allowed: false } }),
      analyticsNotice({
        consent: { mode: "notice_only", granted: false, gpc: true, shouldAsk: false },
        dwell: false,
      }),
    );
    const r = await renderApp("/settings");
    const email = await screen.findByRole(
      "checkbox",
      { name: /open update emails/u },
      { timeout: 5000 },
    );
    expect(email).not.toBeChecked();
    expect(email).toBeDisabled();
    expect(screen.getByText(/Global Privacy Control signal — and that choice is stored/u));
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows the server's `allowed`, not `granted` folded with the mode", async () => {
    // notice_only and never asked would re-derive to "on" in the browser; the server says no
    // (for example, the member is erased), and the server wins.
    mount(consentState({ consentMode: "notice_only", email: { granted: null, allowed: false } }));
    await renderApp("/settings");
    const email = await screen.findByRole(
      "checkbox",
      { name: /open update emails/u },
      { timeout: 5000 },
    );
    expect(email).not.toBeChecked();
    expect(email).toBeEnabled();
  }, 20_000);

  it("shows allowed in opt-in when the server says so", async () => {
    mount(consentState({ consentMode: "opt_in", email: { granted: true, allowed: true } }));
    await renderApp("/settings");
    const email = await screen.findByRole(
      "checkbox",
      { name: /open update emails/u },
      { timeout: 5000 },
    );
    expect(email).toBeChecked();
  }, 20_000);
});
