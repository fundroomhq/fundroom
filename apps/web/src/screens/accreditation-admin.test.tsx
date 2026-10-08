import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  accreditationConnection,
  accreditationProviders,
  parallelConnection,
  parallelProvider,
  verifyInvestorProvider,
} from "../test/fixtures-accreditation.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/accreditation` (E3.7). What the screen owes the admin:
 *
 *  - no connection is a real state: verifications stay manual, and the page says so;
 *  - only vendors the operator offers can be chosen; the others say why not;
 *  - the form is generated from the vendor's credential fields, a blank secret keeps the saved
 *    one on a same-vendor save, and a refusal names the fields the vendor rejected;
 *  - the callback URL (and, for Parallel Markets, the redirect URI) can be copied;
 *  - switching or disconnecting says pending vendor verifications are left for an admin;
 *  - saving, verifying and disconnecting go through step-up; readers change nothing.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

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

const ALL = ["accreditation.read", "accreditation.manage", "round.read"];

function handlers(over: Record<string, Handler> = {}, permissions: string[] = ALL) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [
          {
            id: "round",
            version: "1.0.0",
            enabled: true,
            hidden: false,
            readOnly: false,
            flags: {},
            slots: {},
          },
        ],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/accreditation/providers": () => [200, accreditationProviders()],
    "GET /api/v1/accreditation/connection": () => [200, { connection: accreditationConnection() }],
    ...over,
  });
}

const notConnected: Record<string, Handler> = {
  "GET /api/v1/accreditation/connection": () => [200, { connection: null }],
};

async function openScreen() {
  const r = await renderApp("/admin/accreditation");
  expect(
    await screen.findByRole("heading", { name: "Accreditation", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("accreditation admin: connecting", () => {
  it("explains manual review, offers only enabled vendors and connects VerifyInvestor.com", async () => {
    let connection: ReturnType<typeof accreditationConnection> | null = null;
    const { calls } = handlers({
      "GET /api/v1/accreditation/connection": () => [200, { connection }],
      "GET /api/v1/accreditation/providers": () => [
        200,
        accreditationProviders([verifyInvestorProvider(), parallelProvider({ offered: false })]),
      ],
      "PUT /api/v1/accreditation/connection": () => {
        connection = accreditationConnection();
        return [200, { connection }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    expect(
      await screen.findByText(
        /No vendor is connected, so verifications are manual/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeVisible();
    const vi_ = screen.getByRole("radio", { name: "VerifyInvestor.com" });
    expect(vi_).toBeChecked();
    const parallel = screen.getByRole("radio", { name: "Parallel Markets" });
    expect(parallel).toBeDisabled();
    expect(parallel).toHaveAccessibleDescription("Not enabled by your operator.");
    // Sub-processor and billing facts sit next to the form, before anything is saved.
    expect(
      screen.getByText(/VerifyInvestor\.com becomes a sub-processor of this workspace/u),
    ).toBeVisible();
    expect(screen.getByText(/the vendor bills it for every verification/u)).toBeVisible();
    const submit = screen.getByRole("button", { name: "Verify and connect" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/^API token/u), "  tok_live_123 ");
    await user.selectOptions(screen.getByLabelText(/^Environment/u), "production");
    await expectNoA11yViolations(r.container);
    await user.click(submit);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/accreditation/connection")
          ?.body,
      ).toEqual({
        driver: "verifyinvestor",
        credentials: { apiToken: "tok_live_123", environment: "production" },
      }),
    );
    expect(await screen.findByRole("heading", { name: "VerifyInvestor.com" })).toBeVisible();
  }, 20_000);

  it("names the fields the vendor rejected", async () => {
    handlers({
      ...notConnected,
      "PUT /api/v1/accreditation/connection": () =>
        apiError(422, "accreditation_credentials_invalid", { fields: ["apiToken"] }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/^API token/u, {}, { timeout: 5000 }),
      "tok_wrong",
    );
    await user.click(screen.getByRole("button", { name: "Verify and connect" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The vendor did not accept the connection")).toBeVisible();
    expect(within(alert).getByText("Check: API token.")).toBeVisible();
  }, 20_000);

  it("says so when the operator offers no vendor at all", async () => {
    handlers({
      ...notConnected,
      "GET /api/v1/accreditation/providers": () => [
        200,
        accreditationProviders([
          verifyInvestorProvider({ offered: false }),
          parallelProvider({ offered: false }),
        ]),
      ],
    });
    const r = await openScreen();
    expect(await screen.findByText("No vendor available", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify and connect" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("accreditation admin: connected", () => {
  it("shows the connection, masked credentials and a copyable callback URL", async () => {
    handlers();
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "VerifyInvestor.com" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("••••ab12")).toBeInTheDocument();
    expect(screen.getByText("None received yet")).toBeInTheDocument();
    expect(screen.getByText(/X-Signature-SHA256 HMAC/u)).toBeInTheDocument();
    // Not a widget vendor: no redirect URI to register.
    expect(screen.queryByRole("heading", { name: "Redirect URI" })).toBeNull();
    // Pending vendor verifications end up with an admin; the queue is one click away.
    expect(screen.getByRole("link", { name: "Open the verification queue" })).toHaveAttribute(
      "href",
      "/admin/round/verifications",
    );
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy callback URL" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(accreditationConnection().callbackUrl),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows Parallel Markets' redirect URI to register", async () => {
    handlers({
      "GET /api/v1/accreditation/connection": () => [200, { connection: parallelConnection() }],
    });
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "Redirect URI" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText(parallelConnection().handoffUrl)).toBeInTheDocument();
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy redirect URI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(parallelConnection().handoffUrl));
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a failing connection's last error", async () => {
    handlers({
      "GET /api/v1/accreditation/connection": () => [
        200,
        { connection: accreditationConnection({ status: "error", lastError: "401 Unauthorized" }) },
      ],
    });
    const r = await openScreen();
    expect(await screen.findByText("Needs attention", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("401 Unauthorized")).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps blank secrets on a same-vendor save and can forget an optional one", async () => {
    const { calls } = handlers({
      "PUT /api/v1/accreditation/connection": () => [
        200,
        { connection: accreditationConnection() },
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    // Environment starts where the connection is; nothing needs retyping.
    expect(screen.getByLabelText(/^Environment/u)).toHaveValue("production");
    expect(screen.getByText(/Leave empty to keep the saved value \(••••ab12\)/u)).toBeVisible();
    await user.click(screen.getByLabelText("Remove the saved Webhook secret"));
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/accreditation/connection")
          ?.body,
      ).toEqual({
        driver: "verifyinvestor",
        credentials: { environment: "production" },
        clearCredentials: ["webhookSecret"],
      }),
    );
  }, 20_000);

  it("warns that switching vendors leaves pending verifications to an admin", async () => {
    handlers();
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    expect(screen.queryByText("Pending verifications stay with the old vendor")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Parallel Markets" }));
    expect(screen.getByText("Pending verifications stay with the old vendor")).toBeVisible();
    // A new vendor needs every required field, text ones included.
    expect(screen.getByLabelText(/^Client ID/u)).toBeRequired();
    expect(screen.getByRole("button", { name: "Verify and replace" })).toBeDisabled();
    expect(screen.getByText(/register the redirect URI shown here/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends a stale admin to step-up when verifying", async () => {
    handlers({
      "POST /api/v1/accreditation/connection/verify": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Verify again" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Faccreditation");
  }, 20_000);

  it("re-verifies and reports the vendor's answer", async () => {
    let connection = accreditationConnection();
    handlers({
      "GET /api/v1/accreditation/connection": () => [200, { connection }],
      "POST /api/v1/accreditation/connection/verify": () => {
        connection = accreditationConnection({ status: "error", lastError: "token revoked" });
        return [200, { connection }];
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Verify again" }, { timeout: 5000 }),
    );
    expect(await screen.findByText("The vendor check failed")).toBeVisible();
    expect(await screen.findByText("token revoked")).toBeVisible();
  }, 20_000);

  it("disconnects only after the driver is typed back, then falls back to manual", async () => {
    let connection: ReturnType<typeof accreditationConnection> | null = accreditationConnection();
    const { calls } = handlers({
      "GET /api/v1/accreditation/connection": () => [200, { connection }],
      "DELETE /api/v1/accreditation/connection": () => {
        connection = null;
        return [200, { ok: true }];
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/decide them yourself in the verification queue/u),
    ).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText("Type verifyinvestor to confirm"),
      "verifyinvestor",
    );
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/accreditation/connection"),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/No vendor is connected, so verifications are manual/u),
    ).toBeVisible();
  }, 20_000);
});

describe("accreditation admin: vendor no longer offered", () => {
  it("warns that new verifications are manual and still lets the admin re-key", async () => {
    const { calls } = handlers({
      "GET /api/v1/accreditation/providers": () => [
        200,
        accreditationProviders([verifyInvestorProvider({ offered: false }), parallelProvider()]),
      ],
      "PUT /api/v1/accreditation/connection": () => [
        200,
        { connection: accreditationConnection() },
      ],
    });
    const r = await openScreen();
    expect(
      await screen.findByText(
        "Your operator no longer offers VerifyInvestor.com",
        {},
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(screen.getByText(/New verifications use manual review/u)).toBeVisible();
    expect(screen.getByText(/keep syncing until they are decided/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Replace credentials" }));
    // Same driver: still selectable (a re-key), and chosen.
    expect(screen.getByRole("radio", { name: "VerifyInvestor.com" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "VerifyInvestor.com" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/accreditation/connection")
          ?.body,
      ).toMatchObject({ driver: "verifyinvestor" }),
    );
  }, 20_000);
});

describe("accreditation admin: permissions", () => {
  it("shows a reader the connection and no controls", async () => {
    handlers({}, ["accreditation.read"]);
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "VerifyInvestor.com" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(
      screen.getByText(/Changing it needs the accreditation manage permission/u),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Verify again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    // Without `round.read` the queue is not linked.
    expect(screen.queryByRole("link", { name: "Open the verification queue" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refuses a staff member without accreditation.read", async () => {
    const { calls } = handlers({}, ["round.read"]);
    await renderApp("/admin/accreditation");
    expect(
      await screen.findByText(
        "You need accreditation access to see this page.",
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeVisible();
    expect(calls.some((c) => c.path.startsWith("/api/v1/accreditation"))).toBe(false);
  }, 20_000);
});

// A-3 (ADR-0063): verifications keep running through the connection the plan no longer includes.
describe("accreditation admin on a plan without accreditation", () => {
  it("keeps verify, replace and disconnect, and locks the other vendors", async () => {
    handlers();
    withPlanEntitlements({ features: [] });
    const r = await openScreen();
    expect(
      await screen.findByText(
        "Your plan doesn't include Accreditation verification services. What you've already set up keeps working.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Verify again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(screen.getByRole("button", { name: "Replace credentials" }));
    expect(screen.getByRole("radio", { name: "VerifyInvestor.com" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Parallel Markets" })).toBeDisabled();
  }, 20_000);

  it("will not connect a vendor for the first time", async () => {
    handlers({ "GET /api/v1/accreditation/connection": () => [200, { connection: null }] });
    withPlanEntitlements({ features: [] });
    await openScreen();
    const submit = await screen.findByRole(
      "button",
      { name: "Verify and connect" },
      { timeout: 5000 },
    );
    // Even with every field filled in.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^API token/u), "tok_live_123");
    await user.selectOptions(screen.getByLabelText(/^Environment/u), "production");
    expect(submit).toBeDisabled();
  }, 20_000);
});
