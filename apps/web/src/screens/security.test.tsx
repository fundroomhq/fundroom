import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

const now = "2026-09-11T09:00:00.000Z";
const S1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01";
const S2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";
const D1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b03";
const P1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b04";

function baseHandlers() {
  return {
    "GET /api/v1/me": () => [200, me()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
    "GET /api/v1/me/sessions": () =>
      [
        200,
        {
          sessions: [
            {
              id: S1,
              deviceId: D1,
              deviceName: "This Mac",
              device: "Chrome on macOS",
              ip: "203.0.113.9",
              createdAt: now,
              lastSeenAt: now,
              authLevel: 1,
              context: "first_party",
              current: true,
            },
            {
              id: S2,
              deviceId: null,
              deviceName: "Old phone",
              device: "Safari on iOS",
              ip: null,
              createdAt: now,
              lastSeenAt: now,
              authLevel: 1,
              context: "first_party",
              current: false,
            },
          ],
        },
      ] as [number, unknown],
    "GET /api/v1/me/devices": () =>
      [
        200,
        {
          devices: [
            {
              id: D1,
              name: "This Mac",
              device: "Chrome on macOS",
              firstSeenAt: now,
              lastSeenAt: now,
              trusted: true,
            },
          ],
        },
      ] as [number, unknown],
    "GET /api/v1/auth/passkeys": () =>
      [
        200,
        {
          passkeys: [
            {
              id: P1,
              label: "MacBook Touch ID",
              createdAt: now,
              lastUsedAt: null,
              backedUp: true,
              transports: ["internal"],
            },
          ],
        },
      ] as [number, unknown],
    "GET /api/v1/auth/totp": () =>
      [200, { enrolled: false, pending: false, recoveryCodesLeft: 0 }] as [number, unknown],
    "GET /api/v1/auth/password": () => [200, { enabled: true, set: false }] as [number, unknown],
  };
}

describe("security settings", () => {
  it("lists sessions, devices and passkeys and revokes a session", async () => {
    const { calls } = installMockApi({
      ...baseHandlers(),
      "DELETE /api/v1/me/sessions/{id}": ({ params }) => {
        expect(params["id"]).toBe(S2);
        return [200, { ok: true }];
      },
    });
    const r = await renderApp("/settings/security");
    const user = userEvent.setup();
    expect(await screen.findByText("Old phone")).toBeInTheDocument();
    expect(screen.getByText("This session")).toBeInTheDocument();
    expect(await screen.findByText("MacBook Touch ID")).toBeInTheDocument();
    expect(screen.getByText("Trusted")).toBeInTheDocument();
    expect(screen.queryByText("Password")).toBeNull(); // password not in auth.methods
    await expectNoA11yViolations(r.container);
    const row = screen.getByText("Old phone").closest("tr");
    if (!row) throw new Error("row");
    await user.click(within(row).getByRole("button", { name: /Sign out/u }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/me/sessions/${S2}`)),
      ).toBe(true),
    );
  });

  it("enrols TOTP and shows the recovery codes once", async () => {
    let enrolled = false;
    installMockApi({
      ...baseHandlers(),
      "GET /api/v1/auth/totp": () => [
        200,
        { enrolled, pending: !enrolled, recoveryCodesLeft: enrolled ? 8 : 0 },
      ],
      "POST /api/v1/auth/totp/enrol": () => [
        200,
        {
          credentialId: P1,
          secretBase32: "JBSWY3DPEHPK3PXP",
          otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        },
      ],
      "POST /api/v1/auth/totp/enrol/confirm": ({ body }) => {
        expect(body).toEqual({ code: "135790" });
        enrolled = true;
        return [200, { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] }];
      },
    });
    await renderApp("/settings/security");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Set up an authenticator/u }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /QR code/u })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("aaaa-bbbb")).toBeInTheDocument();
    expect(within(dialog).getByText("cccc-dddd")).toBeInTheDocument();
  });

  it("renders the password card when the method is on and routes fresh-auth to step-up", async () => {
    installMockApi({
      ...baseHandlers(),
      "PUT /api/v1/auth/password": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await renderApp(
      "/settings/security",
      testConfig({ auth: { methods: ["email_otp", "password"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/New password/u), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /Set password/u }));
    await waitFor(() =>
      expect(pathOf(r.router)).toBe("/auth/step-up?returnTo=%2Fsettings%2Fsecurity&reason=fresh"),
    );
  });

  it("asks for the current password before replacing one (F-20)", async () => {
    const { calls } = installMockApi({
      ...baseHandlers(),
      "GET /api/v1/auth/password": () => [200, { enabled: true, set: true }],
      "PUT /api/v1/auth/password": () => [200, { ok: true }],
    });
    const r = await renderApp(
      "/settings/security",
      testConfig({ auth: { methods: ["email_otp", "password"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    const current = await screen.findByLabelText(/Current password/u);
    await user.type(screen.getByLabelText(/New password/u), "correct horse battery staple");
    const replace = screen.getByRole("button", { name: /Replace password/u });
    expect(replace).toBeDisabled();
    await user.type(current, "the old one, twelve+");
    await user.click(replace);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path.endsWith("/auth/password"))?.body,
      ).toEqual({
        password: "correct horse battery staple",
        currentPassword: "the old one, twelve+",
      }),
    );
    await expectNoA11yViolations(r.container);
  });

  it("does not ask for a current password when none is set yet", async () => {
    const { calls } = installMockApi({
      ...baseHandlers(),
      "PUT /api/v1/auth/password": () => [200, { ok: true }],
    });
    await renderApp(
      "/settings/security",
      testConfig({ auth: { methods: ["email_otp", "password"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/New password/u), "correct horse battery staple");
    expect(screen.queryByLabelText(/Current password/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Set password/u }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path.endsWith("/auth/password"))?.body,
      ).toEqual({ password: "correct horse battery staple" }),
    );
  });

  it("sends a level step-up (removing a factor once one is enrolled) to the step-up screen", async () => {
    installMockApi({
      ...baseHandlers(),
      "DELETE /api/v1/auth/passkeys/{id}": () =>
        apiError(403, "step_up_required", { reason: "level", requiredLevel: 2, currentLevel: 1 }),
    });
    const r = await renderApp("/settings/security");
    const user = userEvent.setup();
    const item = (await screen.findByText("MacBook Touch ID")).closest("li") as HTMLElement;
    await user.click(within(item).getByRole("button", { name: /Remove/u }));
    await user.click(await screen.findByRole("button", { name: /^Remove$/u }));
    await waitFor(() =>
      expect(pathOf(r.router)).toBe("/auth/step-up?returnTo=%2Fsettings%2Fsecurity&reason=level"),
    );
  });
});
