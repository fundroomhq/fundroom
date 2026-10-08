import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sumAmounts } from "../modules/crm/reconciliation.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  CRM_CONTACT_ID,
  CRM_CONTACT_ID_2,
  CRM_ITEM_ID,
  CRM_ITEM_ID_2,
  CRM_ORG_ID,
  CRM_TASK_ID,
  crmContact,
  crmContactDetail,
  crmOrganization,
  crmPipelineItem,
  crmStages,
  ROUND_ID,
  roundAllocationView,
  roundSummary,
  stageId,
} from "../test/fixtures-crm.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/crm` (E2.5). What these tests are actually defending:
 *
 *  - **a card's amount is a forecast and the round's commitment is the money** (§D2). They are
 *    labelled differently, they are joined by commitment id in the browser, and a card whose
 *    commitment has gone is named on the reconciliation panel rather than quietly dropped;
 *  - **the totals are added up in fixed point**, not with `+` on floats;
 *  - **the board survives the round module being off** (§D1). `/round/rounds` failing costs the
 *    selector its rounds, not the page;
 *  - **the board is operable without a mouse**: a stage change is a `<select>`, not a drag.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { crm: () => import("../modules/crm/admin.js") },
}));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const STAFF_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions = ["crm.read", "crm.manage"]) =>
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
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

const person = (id: string, displayName: string) => ({
  membershipId: id,
  userId: id,
  kind: "staff" as const,
  role: "admin" as const,
  status: "active" as const,
  displayName,
  email: `${displayName.split(" ")[0]?.toLowerCase() ?? "x"}@acme.test`,
  groups: [],
  profile: {},
  source: "invite",
  principalMembershipId: null,
  delegateScope: null,
  principal: null,
  expiresAt: null,
  lastSeenAt: null,
});

const defaultItems = () => [
  crmPipelineItem(),
  crmPipelineItem({
    id: CRM_ITEM_ID_2,
    stageId: stageId("prospect"),
    contact: null,
    organization: { id: CRM_ORG_ID, name: "Northwind Ventures" },
    amount: "100000.000000",
    commitmentId: null,
  }),
];

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/access/people": () => [
      200,
      {
        items: [person(OWNER_ID, "Grace Hopper"), person(STAFF_ID, "Alan Turing")],
        nextCursor: null,
      },
    ],
    "GET /api/v1/crm/stages": () => [200, { stages: crmStages() }],
    "GET /api/v1/crm/pipeline": () => [200, { stages: crmStages(), items: defaultItems() }],
    "GET /api/v1/crm/contacts": () => [200, { contacts: [crmContact()], nextCursor: null }],
    "GET /api/v1/crm/contacts/{id}": () => [200, crmContactDetail()],
    "GET /api/v1/crm/organizations": () => [
      200,
      { organizations: [crmOrganization()], nextCursor: null },
    ],
    "GET /api/v1/round/rounds": () => [200, { rounds: [roundSummary()] }],
    "GET /api/v1/round/rounds/{id}/allocation": () => [200, roundAllocationView()],
    ...over,
  });
}

async function openBoard(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/crm");
  expect(
    await screen.findByRole("heading", { name: "Pipeline", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

const bodyOf = (
  calls: { method: string; path: string; body: unknown }[],
  method: string,
  path: string,
) => calls.find((c) => c.method === method && c.path === path)?.body;

describe("crm admin", () => {
  it("draws a column per stage and a card per item", async () => {
    handlers();
    const r = await openBoard();
    // Stages in position order, each a landmark of its own with the count in words.
    expect(
      await screen.findByRole("heading", { name: /Prospect/u, level: 2 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Soft committed/u, level: 2 })).toBeInTheDocument();
    // Terminal stages say so rather than merely looking different.
    expect(
      screen.getByRole("heading", { name: /Wired · Terminal|Wired/u, level: 2 }),
    ).toBeVisible();
    expect(screen.getAllByText("Terminal").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("Northwind Ventures")).toBeVisible();
    // The card's amount is a forecast and is labelled as one.
    expect(screen.getByText("Forecast: $250,000")).toBeVisible();
    // Owner initials are decoration; the name is what a screen reader gets.
    expect(screen.getAllByText("Owner: Grace Hopper").length).toBeGreaterThan(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("moves a card with a select, not a drag", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/crm/pipeline/{id}": () => [
        200,
        crmPipelineItem({ stageId: stageId("committed") }),
      ],
    });
    await openBoard();
    const user = userEvent.setup();
    const move = await screen.findByRole(
      "combobox",
      { name: "Move Ada Lovelace to another stage" },
      { timeout: 5000 },
    );
    expect(move).toHaveValue(stageId("soft_committed"));
    await user.selectOptions(move, stageId("committed"));
    await waitFor(() =>
      expect(bodyOf(calls, "PATCH", `/api/v1/crm/pipeline/${CRM_ITEM_ID}`)).toEqual({
        stageId: stageId("committed"),
      }),
    );
  }, 20_000);

  it("adds a card from the dialog with the stage key, not the stage id", async () => {
    const { calls } = handlers({
      "POST /api/v1/crm/pipeline": () => [201, crmPipelineItem()],
    });
    await openBoard();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Add to pipeline" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/^Contact/u), CRM_CONTACT_ID);
    await user.selectOptions(within(dialog).getByLabelText("Stage"), "meeting");
    await user.type(within(dialog).getByLabelText(/^Forecast amount/u), "50000");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Add to pipeline" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/crm/pipeline")).toMatchObject({
        contactId: CRM_CONTACT_ID,
        stageKey: "meeting",
        amount: "50000",
        currency: "USD",
      }),
    );
  }, 20_000);

  it("adds forecasts up in fixed point and names the cards whose commitment has gone", async () => {
    // The whole reason the panel does not use `+`: the float answer here is
    // 0.30000000000000004, and a total on a funding screen must not be approximately right.
    expect(sumAmounts([{ amount: "0.1" }, { amount: "0.2" }])).toBe("0.30");
    expect(sumAmounts([{ amount: "250000.10" }, { amount: "100000.20" }])).toBe("350000.30");
    // A figure that cannot be read is left out rather than counted as a zero.
    expect(sumAmounts([{ amount: "1.5" }, { amount: "not a number" }, { amount: null }])).toBe(
      "1.50",
    );

    handlers({
      "GET /api/v1/crm/pipeline": () => [
        200,
        {
          stages: crmStages(),
          items: [
            crmPipelineItem({ amount: "250000.10" }),
            crmPipelineItem({
              id: CRM_ITEM_ID_2,
              stageId: stageId("meeting"),
              amount: "100000.20",
              // A commitment the round no longer has.
              commitmentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6e99",
              contact: { id: CRM_CONTACT_ID_2, displayName: "Alan Turing", email: null },
            }),
          ],
        },
      ],
    });
    const r = await openBoard();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("Round", {}, { timeout: 5000 }),
      ROUND_ID,
    );

    expect(await screen.findByText("$350,000.3", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("$2,000,000")).toBeVisible();
    expect(screen.getByText("$1,550,000")).toBeVisible();
    // Committed is the round's figure, kept apart from the forecast.
    expect(screen.getByText("$350,000")).toBeVisible();
    expect(screen.getByText("Cards pointing at a missing commitment: 1")).toBeVisible();
    expect(screen.getByText(/Alan Turing — linked commitment not found/u)).toBeVisible();
    // The card that does have a commitment shows the round's amount and status.
    expect(screen.getByText("Committed: $300,000 (Signed)")).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps the board when the round module is not there at all", async () => {
    handlers({
      "GET /api/v1/round/rounds": () => apiError(404, "not_found"),
    });
    const r = await openBoard();
    const select = await screen.findByLabelText("Round", {}, { timeout: 5000 });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["All rounds", "No round"]),
    );
    // Said in words, not by an empty control.
    expect(screen.getByText(/The round module is not available here/u)).toBeVisible();
    // And the cards are still there.
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("searches contacts server-side and says so when nothing matches", async () => {
    const seen: string[] = [];
    handlers({
      "GET /api/v1/crm/contacts": ({ url }) => {
        const q = url.searchParams.get("q") ?? "";
        seen.push(q);
        const all = [
          crmContact(),
          crmContact({
            id: CRM_CONTACT_ID_2,
            displayName: "Alan Turing",
            email: "alan@bletchley.test",
            tags: [],
            membershipId: STAFF_ID,
            organizationId: null,
            organization: null,
          }),
        ];
        const hit = all.filter((c) => c.displayName.toLowerCase().includes(q.toLowerCase()));
        return [200, { contacts: hit, nextCursor: null }];
      },
    });
    const r = await renderApp("/admin/crm/contacts");
    expect(
      await screen.findByRole("heading", { name: "Contacts", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace", {}, { timeout: 5000 })).toBeVisible();
    // The link to a member is words, not a coloured dot.
    expect(screen.getByText("Linked to a member")).toBeVisible();
    expect(screen.getByText("Not linked")).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search contacts"), "turing");
    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).toBeNull());
    expect(screen.getByText("Alan Turing")).toBeVisible();
    expect(seen).toContain("turing");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a contact with tags split on commas and an optional member link", async () => {
    const { calls } = handlers({ "POST /api/v1/crm/contacts": () => [201, crmContact()] });
    await renderApp("/admin/crm/contacts");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New contact" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/u), "Alan Turing");
    await user.type(within(dialog).getByLabelText("Email"), "alan@bletchley.test");
    await user.selectOptions(within(dialog).getByLabelText("Organisation"), CRM_ORG_ID);
    await user.type(within(dialog).getByLabelText(/^Tags/u), "seed, warm intro ,");
    await user.selectOptions(within(dialog).getByLabelText(/^Link to a member/u), STAFF_ID);
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create contact" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/crm/contacts")).toMatchObject({
        displayName: "Alan Turing",
        email: "alan@bletchley.test",
        organizationId: CRM_ORG_ID,
        // An empty trailing segment is not a tag.
        tags: ["seed", "warm intro"],
        membershipId: STAFF_ID,
      }),
    );
  }, 20_000);

  it("shows a contact's notes and posts a new one against the contact", async () => {
    const { calls } = handlers({
      "POST /api/v1/crm/notes": () => [201, { id: "n2" }],
    });
    const r = await renderApp(`/admin/crm/contacts/${CRM_CONTACT_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Ada Lovelace", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Met at the seed dinner; wants the deck.")).toBeVisible();
    expect(screen.getByText(/Soft committed · forecast \$250,000/u)).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New note"), "Sent the deck.");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/crm/notes")).toEqual({
        subjectKind: "contact",
        subjectId: CRM_CONTACT_ID,
        body: "Sent the deck.",
      }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds a task and ticks one off", async () => {
    const { calls } = handlers({
      "POST /api/v1/crm/tasks": () => [201, { id: "t2" }],
      "PATCH /api/v1/crm/tasks/{id}": () => [200, { id: CRM_TASK_ID }],
    });
    await renderApp(`/admin/crm/contacts/${CRM_CONTACT_ID}`);
    const user = userEvent.setup();
    const done = await screen.findByRole("checkbox", { name: "Send the deck" }, { timeout: 5000 });
    expect(done).not.toBeChecked();
    await user.click(done);
    await waitFor(() =>
      expect(bodyOf(calls, "PATCH", `/api/v1/crm/tasks/${CRM_TASK_ID}`)).toEqual({ done: true }),
    );

    await user.type(screen.getByLabelText(/^Task/u), "Book the follow-up");
    await user.selectOptions(screen.getByLabelText("Assignee"), STAFF_ID);
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/crm/tasks")).toMatchObject({
        subjectKind: "contact",
        subjectId: CRM_CONTACT_ID,
        title: "Book the follow-up",
        assigneeMembershipId: STAFF_ID,
      }),
    );
  }, 20_000);

  it("creates an organisation", async () => {
    const { calls } = handlers({
      "POST /api/v1/crm/organizations": () => [201, crmOrganization()],
    });
    const r = await renderApp("/admin/crm/organizations");
    expect(
      await screen.findByRole("heading", { name: "Organisations", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Fund", {}, { timeout: 5000 })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New organisation" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/u), "Bletchley Capital");
    await user.type(within(dialog).getByLabelText(/^Domain/u), "bletchley.test");
    await user.selectOptions(within(dialog).getByLabelText("Kind"), "family_office");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create organisation" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/crm/organizations")).toMatchObject({
        name: "Bletchley Capital",
        domain: "bletchley.test",
        kind: "family_office",
      }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("reorders stages and saves the whole list with its positions", async () => {
    const { calls } = handlers({
      "PUT /api/v1/crm/stages": () => [200, { stages: crmStages() }],
    });
    const r = await renderApp("/admin/crm/stages");
    expect(
      await screen.findByRole("heading", { name: "Pipeline stages", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("button", { name: "Save stages" }, { timeout: 5000 }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Contacted up" }));
    expect(screen.getByText("Unsaved changes. Nothing moves until you save.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save stages" }));
    await waitFor(() => expect(bodyOf(calls, "PUT", "/api/v1/crm/stages")).toBeDefined());
    const body = bodyOf(calls, "PUT", "/api/v1/crm/stages") as {
      stages: { key: string; name: string; position: number; isTerminal: boolean }[];
    };
    expect(body.stages).toHaveLength(10);
    expect(body.stages.slice(0, 2).map((s) => s.key)).toEqual(["contacted", "prospect"]);
    expect(body.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(body.stages.find((s) => s.key === "wired")?.isTerminal).toBe(true);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refuses to remove a stage in use before the click, and shows the server's 409 after it", async () => {
    handlers({
      "PUT /api/v1/crm/stages": () => apiError(409, "conflict"),
    });
    await renderApp("/admin/crm/stages");
    const user = userEvent.setup();
    // One card sits in "Soft committed" in the fixture, so it cannot go — with the count said
    // out loud rather than a disabled button and no explanation.
    expect(
      await screen.findByRole("button", { name: "Remove Soft committed" }, { timeout: 5000 }),
    ).toBeDisabled();
    // Two stages hold a card in the fixture, and each says so on its own row.
    expect(
      screen.getAllByText("Cards in this stage: 1. Move them before removing it."),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove Prospect" })).toBeDisabled();
    // The two stages the round module moves cards into are never removable.
    expect(screen.getByRole("button", { name: "Remove Wired" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Passed" })).toBeDisabled();
    // An empty stage can be taken out here — the server still gets the last word.
    await user.click(screen.getByRole("button", { name: "Remove Diligence" }));
    await user.click(screen.getByRole("button", { name: "Save stages" }));
    expect(await screen.findByText("Already exists", {}, { timeout: 5000 })).toBeVisible();
  }, 20_000);

  it("gives a reader the board and none of the controls", async () => {
    handlers({}, ["crm.read"]);
    const r = await openBoard();
    expect(await screen.findByText("Ada Lovelace", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add to pipeline" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /^Move Ada Lovelace/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Take Ada Lovelace/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links the four sections and marks the one you are on", async () => {
    handlers();
    await openBoard();
    const nav = screen.getByRole("navigation", { name: "CRM sections" });
    expect(within(nav).getByRole("link", { name: "Pipeline" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const user = userEvent.setup();
    await user.click(within(nav).getByRole("link", { name: "Contacts" }));
    expect(
      await screen.findByRole("heading", { name: "Contacts", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "CRM sections" })).getByRole("link", {
        name: "Contacts",
      }),
    ).toHaveAttribute("aria-current", "page");
  }, 20_000);
});
