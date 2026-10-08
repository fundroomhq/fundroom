import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  type Handler,
  installMockApi,
  notifyChannel,
  notifyInboxItem,
  notifyPreferences,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05";
const READ_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";
const OLDER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b03";
const NOW = "2026-09-12T10:00:00.000Z";
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/secretsecretwxyz";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions: string[]) =>
  bootstrap({
    modules: [
      {
        id: "notify",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [{ id: "notify", label: "Notifications", to: "/admin/notify", order: 50 }],
        },
      },
    ],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(over: Record<string, Handler> = {}, permissions: string[] = ["notify.manage"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/notify/preferences": () => [200, notifyPreferences()],
    "GET /api/v1/notify/inbox": () => [
      200,
      {
        unread: 1,
        nextCursor: null,
        items: [
          notifyInboxItem(),
          notifyInboxItem({
            id: READ_ID,
            eventType: "update.replied",
            createdAt: "2026-09-11T10:00:00.000Z",
            readAt: NOW,
            actor: null,
          }),
        ],
      },
    ],
    "GET /api/v1/notify/channels": () => [200, { channels: [notifyChannel()] }],
    ...over,
  });
}

const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.path === path);

describe("notifications inbox", () => {
  it("shows the unread count, marks one read, then all up to the newest shown", async () => {
    const { calls } = handlers({
      "POST /api/v1/notify/inbox/read": () => [200, { updated: 1 }],
      "POST /api/v1/notify/inbox/read-all": () => [200, { updated: 1 }],
    });
    const r = await renderApp("/admin/notify");
    expect(
      await screen.findByRole("heading", { name: "Notifications" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("1 unread")).toBeInTheDocument();
    expect(screen.getByText("An investor viewed a document")).toBeInTheDocument();
    expect(screen.getByText("An investor replied to an update")).toBeInTheDocument();
    expect(screen.getByText("Removed contact")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    await waitFor(() =>
      expect(posts(calls, "/api/v1/notify/inbox/read")[0]?.body).toEqual({
        ids: [notifyInboxItem().id],
      }),
    );

    // "All" means all the founder has seen: a notification newer than the list stays unread.
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() =>
      expect(posts(calls, "/api/v1/notify/inbox/read-all")[0]?.body).toEqual({ upTo: NOW }),
    );
  }, 20_000);

  it("pages with the cursor, archives an item and can include archived ones", async () => {
    const { calls } = handlers({
      "GET /api/v1/notify/inbox": ({ url }) => {
        const archived = url.searchParams.get("archived") === "true";
        if (url.searchParams.get("cursor") === "page-2") {
          return [
            200,
            {
              unread: 1,
              nextCursor: null,
              items: [
                notifyInboxItem({
                  id: OLDER_ID,
                  eventType: "analytics.hot_lead",
                  createdAt: "2026-09-01T10:00:00.000Z",
                  readAt: NOW,
                  archivedAt: archived ? NOW : null,
                }),
              ],
            },
          ];
        }
        return [
          200,
          {
            unread: 1,
            nextCursor: "page-2",
            items: [notifyInboxItem({ eventType: "round.commitment_created" })],
          },
        ];
      },
      "POST /api/v1/notify/inbox/archive": () => [200, { updated: 1 }],
    });
    await renderApp("/admin/notify");
    expect(
      await screen.findByText("An investor made a commitment in the round", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("An investor became a hot lead")).toBeInTheDocument();
    // The last page has no cursor, so nothing more to load.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());

    await user.click(screen.getAllByRole("button", { name: "Archive" })[0] as HTMLElement);
    await waitFor(() =>
      expect(posts(calls, "/api/v1/notify/inbox/archive")[0]?.body).toEqual({
        ids: [notifyInboxItem().id],
        archived: true,
      }),
    );

    await user.click(screen.getByRole("checkbox", { name: "Show archived" }));
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Archived")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() =>
      expect(posts(calls, "/api/v1/notify/inbox/archive")[1]?.body).toEqual({
        ids: [OLDER_ID],
        archived: false,
      }),
    );
  }, 20_000);

  it("names the requester of an access-request alert and links to the queue", async () => {
    handlers({
      "GET /api/v1/notify/inbox": () => [
        200,
        {
          unread: 1,
          nextCursor: null,
          items: [
            notifyInboxItem({
              eventType: "access_request.submitted",
              actor: null,
              subjectName: "Grace Prospect",
              resourceKind: "access_request",
              payload: { accessRequestId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d09" },
            }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify");
    expect(await screen.findByText("Grace Prospect", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("Removed contact")).toBeNull();
    const link = screen.getByRole("link", { name: "A prospective investor requested access" });
    expect(link).toHaveAttribute("href", "/admin/access-requests");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("labels an overdue access review, links to the review and names no person (E3.2)", async () => {
    handlers({
      "GET /api/v1/notify/inbox": () => [
        200,
        {
          unread: 1,
          nextCursor: null,
          items: [
            notifyInboxItem({
              eventType: "access_review.overdue",
              actor: null,
              subjectName: null,
              resourceKind: "workspace",
              payload: { dueAt: "2026-09-20T08:00:00.000Z", lastReviewId: null },
            }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify");
    const link = await screen.findByRole(
      "link",
      { name: "The access review is overdue" },
      { timeout: 5000 },
    );
    expect(link).toHaveAttribute("href", "/admin/access-review");
    expect(screen.getByText("Scheduled check")).toBeInTheDocument();
    expect(screen.queryByText("Removed contact")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links a Q&A alert to the question in the admin data room (E3.3)", async () => {
    const QUESTION = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
    handlers({
      "GET /api/v1/notify/inbox": () => [
        200,
        {
          unread: 2,
          nextCursor: null,
          items: [
            notifyInboxItem({
              eventType: "qa.question_due",
              actor: null,
              subjectName: null,
              resourceKind: "qa_question",
              resourceId: QUESTION,
              payload: {
                questionId: QUESTION,
                phase: "overdue",
                dueAt: "2026-09-20T08:00:00.000Z",
              },
            }),
            notifyInboxItem({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02",
              eventType: "qa.answer_submitted",
              actor: null,
              subjectName: null,
              resourceKind: "qa_question",
              resourceId: QUESTION,
              payload: { questionId: QUESTION },
            }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify");
    const due = await screen.findByRole(
      "link",
      { name: "A data-room question is due soon or overdue" },
      { timeout: 5000 },
    );
    expect(due).toHaveAttribute("href", `/admin/data-room/questions/${QUESTION}`);
    expect(
      screen.getByRole("link", { name: "A data-room answer is waiting for approval" }),
    ).toHaveAttribute("href", `/admin/data-room/questions/${QUESTION}`);
    expect(screen.getByText("Scheduled check")).toBeInTheDocument();
    expect(screen.getByText("Data-room Q&A")).toBeInTheDocument();
    expect(screen.queryByText("Removed contact")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links e-signature and closing alerts to where they are handled (E3.5)", async () => {
    const ROUND = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5701";
    handlers({
      "GET /api/v1/notify/inbox": () => [
        200,
        {
          unread: 2,
          nextCursor: null,
          items: [
            notifyInboxItem({
              eventType: "esign.envelope_attention",
              actor: null,
              subjectName: null,
              resourceKind: "esign_envelope",
              resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b01",
              payload: { status: "declined", purpose: "round_closing" },
            }),
            notifyInboxItem({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e09",
              eventType: "round.signature_completed",
              resourceKind: "commitment",
              resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5705",
              payload: { roundId: ROUND, commitmentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5705" },
            }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify");
    expect(
      await screen.findByRole(
        "link",
        { name: "An e-signature request needs attention" },
        { timeout: 5000 },
      ),
    ).toHaveAttribute("href", "/admin/esign");
    expect(screen.getByRole("link", { name: "Signed subscription agreements" })).toHaveAttribute(
      "href",
      `/admin/round/rounds/${ROUND}/closing`,
    );
    expect(screen.getByText("Scheduled check")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an empty inbox with no unread", async () => {
    handlers({
      "GET /api/v1/notify/inbox": () => [200, { unread: 0, items: [], nextCursor: null }],
    });
    await renderApp("/admin/notify");
    expect(await screen.findByText("Nothing here yet.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  }, 20_000);

  it("offers chat channels only to notify.manage", async () => {
    handlers({}, []);
    await renderApp("/admin/notify");
    expect(await screen.findByText("1 unread", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Chat channels" })).toBeNull();
  }, 20_000);
});

describe("notification preferences", () => {
  function echoPut(): Handler {
    return ({ body }) => {
      const b = body as { preferences: { eventType: string; cadence: string }[]; settings: object };
      return [
        200,
        {
          preferences: b.preferences.map((p) => ({ ...p, isDefault: false })),
          settings: b.settings,
        },
      ];
    };
  }

  it("saves cadences (incl. weekly), timezone, digest hour, weekly day and quiet hours", async () => {
    const { calls } = handlers({ "PUT /api/v1/notify/preferences": echoPut() });
    const r = await renderApp("/admin/notify/preferences");
    expect(
      await screen.findByRole("heading", { name: "Notification preferences" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Six of the seven event types are still on their defaults.
    expect(await screen.findAllByText("Default")).toHaveLength(6);
    const viewed = screen.getByRole("group", { name: /An investor viewed a document/u });
    expect(within(viewed).getByRole("radio", { name: "Instantly" })).toBeChecked();
    expect(within(viewed).getByRole("radio", { name: "Weekly digest" })).toBeInTheDocument();
    const downloaded = screen.getByRole("group", { name: /An investor downloaded a document/u });
    expect(within(downloaded).getByRole("radio", { name: "Daily digest" })).toBeChecked();
    // The E2.6 events, labelled in the founder's terms rather than the topic's.
    const hot = screen.getByRole("group", { name: /An investor became a hot lead/u });
    expect(within(hot).getByRole("radio", { name: "Instantly" })).toBeChecked();
    expect(
      screen.getByRole("group", { name: /An investor made a commitment in the round/u }),
    ).toBeInTheDocument();
    // E3.1: the access-request alert, which the fixture has never stored, starts instant.
    // E3.3: the Q&A alerts a staff member can receive; a released answer and a decline notice
    // reach the asker only, so they have no toggle here.
    expect(
      screen.getByRole("group", { name: /An investor asked a data-room question/u }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /An answer is released/u })).toBeNull();
    expect(screen.queryByRole("group", { name: /question was declined/u })).toBeNull();
    // E3.5: the two staff alerts are tunable; the investor's confirmation email is not.
    expect(
      screen.getByRole("group", { name: /An e-signature request needs attention/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /Signed subscription agreements/u }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Commitment confirmations/u })).toBeNull();
    const access = screen.getByRole("group", { name: /A prospective investor requested access/u });
    expect(within(access).getByRole("radio", { name: "Instantly" })).toBeChecked();
    // Saved before (one preference is not a default), so the stored zone stands.
    expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
    expect(screen.queryByText(/Filled in from this browser/u)).toBeNull();
    // Quiet hours say what they do and do not hold back.
    expect(
      screen.getByText(/In-app notifications still appear straight away/u),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Quiet from")).toBeNull();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(within(viewed).getByRole("radio", { name: "Weekly digest" }));
    await user.click(within(hot).getByRole("radio", { name: "Never" }));
    await user.selectOptions(screen.getByLabelText("Timezone"), "Europe/Berlin");
    await user.selectOptions(screen.getByLabelText("Digest hour"), "17");
    await user.selectOptions(screen.getByLabelText("Weekly digest day"), "5");
    await user.click(screen.getByRole("radio", { name: "On" }));
    await user.selectOptions(screen.getByLabelText("Quiet from"), "22");
    await user.selectOptions(screen.getByLabelText("Quiet until"), "22");
    // A window that starts and ends at the same hour is refused before it is sent.
    expect(
      await screen.findByText("Quiet hours must start and end at different hours."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Quiet until"), "7");
    await user.click(screen.getByRole("switch", { name: "Send me notification emails" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/notify/preferences")?.body,
      ).toEqual({
        preferences: [
          { eventType: "document.viewed", cadence: "weekly" },
          { eventType: "document.downloaded", cadence: "daily" },
          { eventType: "update.replied", cadence: "instant" },
          { eventType: "round.interest_submitted", cadence: "instant" },
          { eventType: "round.verification_requested", cadence: "instant" },
          { eventType: "round.commitment_created", cadence: "instant" },
          { eventType: "analytics.hot_lead", cadence: "off" },
          { eventType: "access_request.submitted", cadence: "instant" },
          { eventType: "access_review.overdue", cadence: "instant" },
          { eventType: "membership.delegate_added", cadence: "instant" },
          { eventType: "qa.question_asked", cadence: "instant" },
          { eventType: "qa.question_assigned", cadence: "instant" },
          { eventType: "qa.answer_submitted", cadence: "instant" },
          { eventType: "qa.question_due", cadence: "instant" },
          { eventType: "esign.envelope_attention", cadence: "instant" },
          { eventType: "round.signature_completed", cadence: "instant" },
          { eventType: "integration.connection_unhealthy", cadence: "instant" },
        ],
        settings: {
          emailEnabled: false,
          timezone: "Europe/Berlin",
          digestHour: 17,
          weeklyDay: 5,
          quietHours: { start: 22, end: 7 },
        },
      }),
    );
  }, 60_000);

  it("fills in the browser's timezone the first time, and says so", async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: "America/New_York" };
    });
    const fresh = notifyPreferences();
    const { calls } = handlers({
      "GET /api/v1/notify/preferences": () => [
        200,
        { ...fresh, preferences: fresh.preferences.map((p) => ({ ...p, isDefault: true })) },
      ],
      "PUT /api/v1/notify/preferences": echoPut(),
    });
    const r = await renderApp("/admin/notify/preferences");
    const zone = await screen.findByLabelText("Timezone", {}, { timeout: 5000 });
    expect(zone).toHaveValue("America/New_York");
    expect(zone).toHaveAccessibleDescription("Filled in from this browser. Save to use it.");
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        (
          calls.find((c) => c.method === "PUT")?.body as
            | { settings: { timezone: string; quietHours: unknown } }
            | undefined
        )?.settings,
      ).toMatchObject({ timezone: "America/New_York", quietHours: null }),
    );
  }, 60_000);
});

describe("chat channels", () => {
  async function openChannels() {
    const r = await renderApp("/admin/notify/channels");
    expect(
      await screen.findByRole("heading", { name: "Chat channels", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    return r;
  }

  it("lists channels by URL hint only and creates one without ever showing the URL again", async () => {
    let channels = [
      notifyChannel(),
      notifyChannel({
        id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c02",
        name: "#founders",
        urlHint: "9f3e",
        enabled: false,
        disabledReason: "not_found",
        failureCount: 3,
        lastSuccessAt: null,
        lastError: "not_found",
        eventTypes: ["round.interest_submitted"],
      }),
    ];
    const { calls } = handlers({
      "GET /api/v1/notify/channels": () => [200, { channels }],
      "POST /api/v1/notify/channels": ({ body }) => {
        const b = body as { name: string; eventTypes: string[] };
        const created = notifyChannel({
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03",
          name: b.name,
          urlHint: "wxyz",
          eventTypes: b.eventTypes as ReturnType<typeof notifyChannel>["eventTypes"],
          lastSuccessAt: null,
        });
        channels = [...channels, created];
        return [201, created];
      },
    });
    const r = await openChannels();
    expect(await screen.findByText("#deals")).toBeInTheDocument();
    expect(screen.getByText("Webhook ending …abcd")).toBeInTheDocument();
    expect(
      screen.getByText("An investor became a hot lead, An investor made a commitment in the round"),
    ).toBeInTheDocument();
    // The auto-disabled channel says so, and what to do about it.
    expect(screen.getByText("This channel switched itself off")).toBeInTheDocument();
    expect(screen.getByText(/Slack says this webhook no longer exists/u)).toBeInTheDocument();
    expect(screen.getByText(/3 failed in a row/u)).toBeInTheDocument();
    // The privacy note sits on the create form, before anything is saved.
    expect(
      screen.getByText(/Alert text, including investor names and what they did, is sent to Slack/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    const url = screen.getByLabelText(/Slack webhook URL/u);
    expect(url).toHaveAttribute("type", "url");
    await user.type(screen.getByLabelText(/^Name/u), "#team");
    await user.type(url, SLACK_URL);
    await user.click(
      screen.getByRole("checkbox", { name: "An investor requested accreditation verification" }),
    );
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        name: "#team",
        url: SLACK_URL,
        eventTypes: [
          "analytics.hot_lead",
          "round.interest_submitted",
          "round.commitment_created",
          "access_request.submitted",
          "access_review.overdue",
          "qa.question_asked",
          "integration.connection_unhealthy",
        ],
        enabled: true,
      }),
    );
    expect(await screen.findByText("#team")).toBeInTheDocument();
    expect(screen.getByText("Webhook ending …wxyz")).toBeInTheDocument();
    // Neither the field nor anything else on the page still holds the credential.
    expect(screen.getByLabelText(/Slack webhook URL/u)).toHaveValue("");
    expect(r.container.innerHTML).not.toContain("secretsecret");
  }, 30_000);

  it("sends a test post and shows what Slack answered", async () => {
    let answer = { ok: true, reason: null, detail: null } as {
      ok: boolean;
      reason: string | null;
      detail: string | null;
    };
    const { calls } = handlers({
      "POST /api/v1/notify/channels/{id}/test": () => [200, answer],
    });
    await openChannels();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Send test to #deals" }));
    expect(await screen.findByText("Test message posted")).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.method === "POST" && c.path === `/api/v1/notify/channels/${notifyChannel().id}/test`,
      ),
    ).toBe(true);

    answer = { ok: false, reason: "not_found", detail: null };
    await user.click(screen.getByRole("button", { name: "Send test to #deals" }));
    expect(await screen.findByText("The test message was not posted")).toBeInTheDocument();
    expect(
      screen.getByText("Slack says this webhook no longer exists. Paste a new webhook URL."),
    ).toBeInTheDocument();
  }, 20_000);

  it("edits only what changed and never pre-fills the URL", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/notify/channels/{id}": () => [200, notifyChannel({ name: "#deal-flow" })],
    });
    await openChannels();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit #deals" }));
    const form = screen.getByRole("form", { name: "Edit #deals" });
    expect(within(form).getByLabelText(/Replace webhook URL/u)).toHaveValue("");
    const name = within(form).getByLabelText(/^Name/u);
    await user.clear(name);
    await user.type(name, "#deal-flow");
    await user.click(within(form).getByRole("switch", { name: "Post to this channel" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "#deal-flow",
        enabled: false,
      }),
    );
  }, 20_000);

  it("deletes a channel after confirming", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/notify/channels/{id}": () => [200, { ok: true }],
    });
    await openChannels();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete #deals" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete #deals?" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === "DELETE" && c.path === `/api/v1/notify/channels/${notifyChannel().id}`,
        ),
      ).toBeDefined(),
    );
  }, 20_000);

  it("sends a stale admin to step-up when creating a channel", async () => {
    handlers({
      "POST /api/v1/notify/channels": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openChannels();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Name/u), "#team");
    await user.type(screen.getByLabelText(/Slack webhook URL/u), SLACK_URL);
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("refuses the screen without notify.manage", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/notify/channels");
    expect(
      await screen.findByText(
        "Only workspace owners and admins can manage chat channels.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/notify/channels")).toBe(false);
  }, 20_000);
});
