import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  SLACK_APP_CHANNEL_ID,
  SLACK_CHANNELS,
  slackAppChannel,
} from "../test/fixtures-kpi-slack.js";
import {
  apiError,
  type Handler,
  installMockApi,
  notifyChannel,
  notifyInboxItem,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/notify/channels`, the `slack_app` kind (E3.6 §6). The channel is picked from the
 * connected Slack app's own list — a native `<select>` — and a workspace with no Slack connection
 * is sent to the Integrations hub rather than shown an empty picker.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05";

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
    permissions: ["notify.manage"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap()],
    "GET /api/v1/notify/channels": () => [200, { channels: [notifyChannel()] }],
    "GET /api/v1/notify/slack/channels": () => [200, { channels: SLACK_CHANNELS }],
    ...over,
  });
}

async function openChannels() {
  const r = await renderApp("/admin/notify/channels");
  expect(
    await screen.findByRole("heading", { name: "Chat channels", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  await screen.findByText("#deals", {}, { timeout: 5000 });
  return r;
}

describe("chat channels: Slack app", () => {
  it("creates a Slack app channel from the app's channel list", async () => {
    const { calls } = handlers({
      "POST /api/v1/notify/channels": () => [201, slackAppChannel({ name: "#founders" })],
    });
    const r = await openChannels();
    const user = userEvent.setup();
    // The webhook form is the default; no channel list is fetched until it is asked for.
    expect(screen.getByLabelText(/Slack webhook URL/u)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/notify/slack/channels")).toBe(false);

    await user.click(screen.getByRole("radio", { name: "Connected Slack app" }));
    const picker = await screen.findByLabelText(/^Slack channel/u, {}, { timeout: 5000 });
    expect(picker.tagName).toBe("SELECT");
    expect(screen.queryByLabelText(/Slack webhook URL/u)).toBeNull();
    expect(within(picker).getByRole("option", { name: "#founders (private)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    await expectNoA11yViolations(r.container);

    await user.selectOptions(picker, "C000FOUNDR");
    // The Slack channel's name becomes the label when none was typed.
    expect(screen.getByLabelText(/^Name/u)).toHaveValue("#founders");
    // The new alert is offered with the others.
    expect(
      screen.getByRole("checkbox", { name: "A connected integration stopped working" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        kind: "slack_app",
        name: "#founders",
        slackChannelId: "C000FOUNDR",
        eventTypes: [
          "analytics.hot_lead",
          "round.interest_submitted",
          "round.commitment_created",
          "round.verification_requested",
          "access_request.submitted",
          "access_review.overdue",
          "qa.question_asked",
          "integration.connection_unhealthy",
        ],
        enabled: true,
      }),
    );
  }, 30_000);

  it("sends the admin to Integrations when Slack is not connected", async () => {
    handlers({
      "GET /api/v1/notify/slack/channels": () => apiError(404, "integration_not_connected"),
    });
    const r = await openChannels();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Connected Slack app" }));
    expect(
      await screen.findByText("Slack is not connected", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Slack in Integrations" })).toHaveAttribute(
      "href",
      "/admin/integrations",
    );
    expect(screen.queryByLabelText(/^Slack channel/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an app channel by its Slack channel and re-points it", async () => {
    const { calls } = handlers({
      "GET /api/v1/notify/channels": () => [200, { channels: [slackAppChannel()] }],
      "PATCH /api/v1/notify/channels/{id}": () => [200, slackAppChannel()],
    });
    const r = await renderApp("/admin/notify/channels");
    expect(
      await screen.findByText("Slack app · #deals", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Webhook ending/u)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit Deal flow" }));
    const form = screen.getByRole("form", { name: "Edit Deal flow" });
    const picker = await within(form).findByLabelText(/^Slack channel/u, {}, { timeout: 5000 });
    expect(picker).toHaveValue("C0000DEALS");
    // An app channel has no URL to replace.
    expect(within(form).queryByLabelText(/Replace webhook URL/u)).toBeNull();
    await expectNoA11yViolations(r.container);
    await user.selectOptions(picker, "C000FOUNDR");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === "PATCH" && c.path === `/api/v1/notify/channels/${SLACK_APP_CHANNEL_ID}`,
        )?.body,
      ).toEqual({ slackChannelId: "C000FOUNDR" }),
    );
  }, 20_000);

  it("says a disconnected Slack app switched the channel off", async () => {
    handlers({
      "GET /api/v1/notify/channels": () => [
        200,
        {
          channels: [
            slackAppChannel({ enabled: false, disabledReason: "not_connected", failureCount: 3 }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify/channels");
    expect(
      await screen.findByText(/The Slack app was disconnected/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("inbox: integration health", () => {
  it("links an unhealthy-connection alert to Integrations, from the system", async () => {
    handlers({
      "GET /api/v1/notify/preferences": () => [200, { preferences: [], settings: {} }],
      "GET /api/v1/notify/inbox": () => [
        200,
        {
          unread: 1,
          nextCursor: null,
          items: [
            notifyInboxItem({
              eventType: "integration.connection_unhealthy",
              actor: null,
              resourceKind: "integration_connection",
              resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b01",
              payload: { provider: "quickbooks", status: "reauth_required" },
            }),
          ],
        },
      ],
    });
    const r = await renderApp("/admin/notify");
    expect(
      await screen.findByRole(
        "link",
        { name: "A connected integration stopped working" },
        { timeout: 5000 },
      ),
    ).toHaveAttribute("href", "/admin/integrations");
    expect(screen.getByText("Scheduled check")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
