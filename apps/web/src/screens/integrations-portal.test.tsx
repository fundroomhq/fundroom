import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The investor home's "Book time" card (E3.6): rendered only when the bootstrap says a link is
 * visible to this member, filled from `GET /integrations/me/booking-links` (audience-filtered
 * by the server), each link opening the vendor in a new tab with no opener and no referrer.
 */
vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

afterEach(() => vi.unstubAllGlobals());

const LINKS = {
  links: [
    {
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8b01",
      provider: "calcom",
      url: "https://cal.com/acme/investor-call",
      label: "Book a call with the CEO",
      description: "30 minutes, video",
    },
    {
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8b02",
      provider: "calendly",
      url: "https://calendly.com/acme-cfo/diligence",
      label: "Diligence Q&A with the CFO",
      description: null,
    },
  ],
};

describe("portal: book time", () => {
  it("lists the member's booking links, opening each in a new tab without a referrer", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ bookingLinksAvailable: true })],
      "GET /api/v1/integrations/me/booking-links": () => [200, LINKS],
    });
    const r = await renderApp("/");
    const heading = await screen.findByRole("heading", { name: "Book time" }, { timeout: 5000 });
    const section = heading.closest("section") as HTMLElement;
    const ceo = within(section).getByRole("link", { name: /Book a call with the CEO/u });
    expect(ceo).toHaveAttribute("href", "https://cal.com/acme/investor-call");
    expect(ceo).toHaveAttribute("target", "_blank");
    expect(ceo).toHaveAttribute("rel", "noopener noreferrer");
    expect(ceo).toHaveAccessibleName(/opens in a new tab/u);
    expect(within(section).getByText("30 minutes, video")).toBeVisible();
    expect(
      within(section).getByRole("link", { name: /Diligence Q&A with the CFO/u }),
    ).toHaveAttribute("href", "https://calendly.com/acme-cfo/diligence");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("asks for nothing and shows nothing when no link is visible", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    await renderApp("/");
    expect(
      await screen.findByRole("heading", { name: /Welcome/u }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Book time" })).toBeNull();
    expect(calls.some((c) => c.path.includes("booking-links"))).toBe(false);
  }, 20_000);

  it("renders no empty card when every link was disabled since the bootstrap", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ bookingLinksAvailable: true })],
      "GET /api/v1/integrations/me/booking-links": () => [200, { links: [] }],
    });
    await renderApp("/");
    expect(
      await screen.findByRole("heading", { name: /Welcome/u }, { timeout: 5000 }),
    ).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading", { name: "Book time" })).toBeNull();
  }, 20_000);
});
