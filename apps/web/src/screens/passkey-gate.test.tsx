import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session, testConfig } from "../test/fixtures.js";
import { installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * E3.9 FR2 C1: where passkeys cannot work (a path mount, any origin other than the passkey RP's)
 * the server leaves `passkey` out of the page config's `auth.methods` and refuses the ceremony
 * routes. Every passkey affordance follows the config, not only browser support. jsdom has no
 * WebAuthn, so support is stubbed on: each "off" case would show the affordance without the gate.
 */
vi.mock("../lib/webauthn.js", async (importActual) => ({
  ...(await importActual<typeof import("../lib/webauthn.js")>()),
  webAuthnSupported: () => Promise.resolve(true),
  webAuthnAutofillSupported: () => Promise.resolve(false),
}));

afterEach(() => vi.unstubAllGlobals());

const ON = testConfig({ auth: { methods: ["email_otp", "passkey"], passkeyRpId: "localhost" } });
const OFF = testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "localhost" } });
const now = "2026-09-27T09:00:00.000Z";

function mfaMe() {
  return me({
    session: session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }),
  });
}

describe("step-up passkey tab", () => {
  const handlers = () => ({
    "GET /api/v1/me": () => [200, mfaMe()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
  });
  const url = "/auth/step-up?returnTo=%2Fsettings%2Fsecurity&reason=level";

  it("is offered where the config lists passkeys", async () => {
    installMockApi(handlers());
    await renderApp(url, ON);
    expect(await screen.findByRole("tab", { name: /passkey/iu })).toBeInTheDocument();
  });

  it("is not offered off the passkey origin, and the authenticator code is the default", async () => {
    installMockApi(handlers());
    const r = await renderApp(url, OFF);
    const totp = await screen.findByRole("tab", { name: /authenticator/iu });
    expect(totp).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /passkey/iu })).toBeNull();
    expect(screen.queryByRole("button", { name: /passkey/iu })).toBeNull();
    expect(screen.getByLabelText(/Authenticator code/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("security settings passkeys card", () => {
  const handlers = () => ({
    "GET /api/v1/me": () => [200, me()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
    "GET /api/v1/me/sessions": () => [200, { sessions: [] }] as [number, unknown],
    "GET /api/v1/me/devices": () => [200, { devices: [] }] as [number, unknown],
    "GET /api/v1/auth/passkeys": () =>
      [
        200,
        {
          passkeys: [
            {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b04",
              label: "MacBook Touch ID",
              createdAt: now,
              lastUsedAt: null,
              backedUp: false,
              transports: ["internal"],
            },
          ],
        },
      ] as [number, unknown],
    "GET /api/v1/auth/totp": () =>
      [200, { enrolled: false, pending: false, recoveryCodesLeft: 0 }] as [number, unknown],
  });

  it("offers Add where the config lists passkeys", async () => {
    installMockApi(handlers());
    await renderApp("/settings/security", ON);
    expect(await screen.findByRole("button", { name: /Add a passkey/u })).toBeInTheDocument();
    expect(screen.queryByText(/can't be used at this address/u)).toBeNull();
  });

  it("hides Add off the passkey origin, says why, and still lists existing passkeys", async () => {
    installMockApi(handlers());
    const r = await renderApp("/settings/security", OFF);
    expect(await screen.findByText("MacBook Touch ID")).toBeInTheDocument();
    expect(screen.getByText(/can't be used at this address/u)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Add a passkey/u })).toBeNull(),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("setup wizard security step", () => {
  const handlers = () => ({
    "GET /api/v1/setup/status": () =>
      [
        200,
        {
          required: false,
          tenancy: "single",
          instanceName: "FundRoom",
          baseUrl: "https://investors.acme.test/",
          passwordEnabled: false,
          drivers: { storage: "fs", mail: "smtp" },
          probes: { mail: "pending", storage: "pending" },
          progress: { owner: true, mail: false, storage: false, branding: false, offering: false },
        },
      ] as [number, unknown],
    "GET /api/v1/me": () =>
      [
        200,
        me({
          session: session({ population: "staff", authLevel: 1 }),
          membership: membership({ kind: "staff", role: "owner" }),
        }),
      ] as [number, unknown],
    "GET /api/v1/modules/enablement": () => [200, { modules: [] }] as [number, unknown],
  });

  it("offers a passkey where the config lists passkeys", async () => {
    installMockApi(handlers());
    await renderApp("/setup?step=secure", testConfig({ ...ON, setupRequired: false }));
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Add passkey/u })).toBeInTheDocument();
  }, 20_000);

  it("offers only the authenticator app off the passkey origin", async () => {
    installMockApi(handlers());
    await renderApp("/setup?step=secure", testConfig({ ...OFF, setupRequired: false }));
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up/u })).toBeInTheDocument();
    // Give the (stubbed) support probe its turn before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: /Add passkey/u })).toBeNull();
  }, 20_000);
});
