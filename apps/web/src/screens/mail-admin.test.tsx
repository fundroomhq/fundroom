import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  type Handler,
  installMockApi,
  mailStatus,
  mailSuppression,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/mail` (E2.6). A kernel screen behind `access.settings`: which provider the server sends
 * with, the webhook URL to paste into it (with a per-provider hint), and the workspace's
 * suppression list, where removing an entry needs a fresh session.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const SECOND_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function handlers(over: Record<string, Handler> = {}, permissions = ["access.settings"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/mail/status": () => [200, mailStatus()],
    "GET /api/v1/mail/suppressions": ({ url }) =>
      url.searchParams.get("cursor") === "next-1"
        ? [
            200,
            {
              items: [
                mailSuppression({ id: SECOND_ID, address: "a•••@acme.test", reason: "complaint" }),
              ],
              nextCursor: null,
            },
          ]
        : [200, { items: [mailSuppression()], nextCursor: "next-1" }],
    ...over,
  });
}

async function openMail() {
  const r = await renderApp("/admin/mail");
  expect(
    await screen.findByRole("heading", { name: "Mail delivery", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("mail delivery admin", () => {
  it("shows the driver, its capabilities, the webhook URL and the provider's setup hint", async () => {
    handlers();
    const r = await openMail();
    expect(await screen.findByText("Resend")).toBeInTheDocument();
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(screen.getByText("Account setting at the provider")).toBeInTheDocument();
    expect(
      screen.getByText("https://investors.acme.test/webhooks/email/resend"),
    ).toBeInTheDocument();
    expect(screen.getByText("Setting up Resend")).toBeInTheDocument();
    expect(screen.getByText(/RESEND_WEBHOOK_SECRET/u)).toBeInTheDocument();
    // The nav entry is there for access.settings.
    expect(screen.getByRole("link", { name: "Mail delivery" })).toBeInTheDocument();
    expect(await screen.findByText("j•••@northwind.test")).toBeInTheDocument();
    expect(screen.getByText("Hard bounce")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy webhook URL" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://investors.acme.test/webhooks/email/resend"),
    );
  }, 20_000);

  it("explains SMTP has no webhooks and shows no URL", async () => {
    handlers({
      "GET /api/v1/mail/status": () => [
        200,
        mailStatus({
          driver: "smtp",
          capabilities: { perMessageTracking: false, webhooks: false },
          webhookUrl: null,
        }),
      ],
      "GET /api/v1/mail/suppressions": () => [200, { items: [], nextCursor: null }],
    });
    const r = await openMail();
    expect(await screen.findByText(/SMTP has no delivery webhooks/u)).toBeInTheDocument();
    expect(screen.queryByText("Webhook URL")).toBeNull();
    expect(screen.getByText("No addresses are suppressed.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("pages the suppression list and removes an entry after confirming", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/mail/suppressions/{id}": () => [200, { ok: true }],
    });
    await openMail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("a•••@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Marked as spam")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());

    await user.click(
      screen.getByRole("button", { name: "Remove a•••@acme.test from the suppression list" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Remove a•••@acme.test from the suppression list?",
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "DELETE" && c.path === `/api/v1/mail/suppressions/${SECOND_ID}`,
        ),
      ).toBeDefined(),
    );
  }, 20_000);

  it("sends a stale admin to step-up when removing a suppression", async () => {
    handlers({
      "DELETE /api/v1/mail/suppressions/{id}": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openMail();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Remove j•••@northwind.test from the suppression list",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fmail");
  }, 20_000);

  it("hides the nav entry and refuses the screen without access.settings", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/mail");
    expect(
      await screen.findByText(
        "Only workspace owners and admins can see mail delivery settings.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mail delivery" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/mail/"))).toBe(false);
  }, 20_000);
});
