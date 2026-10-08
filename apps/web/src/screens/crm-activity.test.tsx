import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { CRM_CONTACT_ID, crmActivity, crmContactDetail, crmStages } from "../test/fixtures-crm.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The contact's Activity card (E3.6 §7): meetings booked, cancelled or moved through a
 * connected Calendly/Cal.com, newest first. Read-only, and on its own query — a failing
 * activity endpoint costs the card, not the contact.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { crm: () => import("../modules/crm/admin.js") },
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

const staffBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "crm",
        version: "1.0.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            { id: "crm-admin", label: "CRM", to: "/admin/crm", order: 37, icon: "crm" },
          ],
        },
      },
    ],
    permissions: ["crm.read"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(activity: Handler) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap()],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/access/people": () => [200, { items: [], nextCursor: null }],
    "GET /api/v1/crm/stages": () => [200, { stages: crmStages() }],
    "GET /api/v1/crm/contacts/{id}": () => [200, crmContactDetail()],
    "GET /api/v1/crm/contacts/{id}/activity": activity,
  });
}

async function openContact() {
  const r = await renderApp(`/admin/crm/contacts/${CRM_CONTACT_ID}`);
  expect(
    await screen.findByRole("heading", { name: "Ada Lovelace", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("CRM contact activity", () => {
  it("lists the contact's meetings newest first", async () => {
    const { calls } = handlers(() => [
      200,
      {
        // Deliberately out of order: the card must not depend on the server's sort alone.
        activities: [
          crmActivity(),
          crmActivity({
            id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f12",
            kind: "meeting_cancelled",
            occurredAt: "2026-09-20T08:00:00.000Z",
            title: null,
          }),
          crmActivity({
            id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f11",
            kind: "meeting_rescheduled",
            occurredAt: "2026-09-19T12:00:00.000Z",
            startsAt: "2026-09-26T15:00:00.000Z",
            title: "Intro call",
          }),
        ],
      },
    ]);
    const r = await openContact();
    const list = await screen.findByRole("list", { name: "Activity" }, { timeout: 5000 });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
      "Meeting cancelled",
      "Meeting rescheduled · Intro call",
      "Meeting booked · Intro call",
    ]);
    expect(within(rows[2] as HTMLElement).getByText(/^Meeting at /u)).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText(/^Recorded /u)).toBeInTheDocument();
    // Read-only: no controls on the card.
    expect(within(list).queryByRole("button")).toBeNull();
    expect(calls.some((c) => c.path === `/api/v1/crm/contacts/${CRM_CONTACT_ID}/activity`)).toBe(
      true,
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says when there is nothing yet", async () => {
    handlers(() => [200, { activities: [] }]);
    const r = await openContact();
    expect(
      await screen.findByText("No meetings recorded yet.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps the contact when the activity endpoint fails", async () => {
    handlers(() => apiError(500, "internal"));
    await openContact();
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Met at the seed dinner; wants the deck.")).toBeVisible();
  }, 20_000);
});
