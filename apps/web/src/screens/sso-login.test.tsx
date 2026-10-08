import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ssoLoginNavigation } from "../lib/sso-login.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, session, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Workspace single sign-on on the sign-in screen (E3.8): the button, home-realm discovery,
 * enforced layout, `/login?sso_error=`, the "requires single sign-on" screen a staff member
 * gets from a 403 `sso_required` or the bootstrap's `ssoRequired`, and the embed hand-off.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const IDP_URL = "https://login.acme-idp.test/authorize?state=s";
const signedOut = { "GET /api/v1/me": () => apiError(401, "unauthenticated") };
const otpOnly = testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } });

function sso(over: Record<string, unknown> = {}) {
  return () =>
    [200, { available: true, name: "Acme Okta", protocol: "saml", enforced: false, ...over }] as [
      number,
      unknown,
    ];
}

/*
 * A held staff member's bootstrap (B's middleware): no membership is admitted, `ssoRequired`
 * says why, and `ssoBreakGlass` marks an owner who may step up instead.
 */
function staffBootstrap(over: Record<string, unknown> = {}) {
  return {
    ...bootstrap({
      membership: { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d", kind: "staff", role: "admin" },
      permissions: [],
    }),
    ...over,
  };
}

function staffMe() {
  return me({
    session: session({ population: "staff" }),
    membership: {
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d",
      kind: "staff",
      role: "admin",
      status: "active",
    },
  });
}

describe("sign-in: workspace single sign-on", () => {
  it("offers no SSO button when the workspace has none (or the lookup fails)", async () => {
    installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
    });
    await renderApp("/login", otpOnly);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Email address/u)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Continue with/u })).toBeNull();

    // A 404 (older server, no workspace) reads the same way.
    vi.unstubAllGlobals();
    installMockApi({ ...signedOut });
    await renderApp("/login", otpOnly);
    expect((await screen.findAllByRole("heading", { name: "Sign in" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Continue with/u })).toBeNull();
  }, 20_000);

  it("shows 'Continue with <name>' and redirects to the IdP from begin", async () => {
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": sso(),
      "POST /api/v1/auth/sso/begin": () => [200, { url: IDP_URL }],
    });
    const r = await renderApp("/login?returnTo=%2Fupdates", otpOnly);
    const button = await screen.findByRole(
      "button",
      { name: "Continue with Acme Okta" },
      { timeout: 5000 },
    );
    // Not enforced: an extra way in, under the email form, not the headline.
    expect(
      screen.queryByText(/must sign in|sign in with the company's single sign-on/u),
    ).toBeNull();
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(IDP_URL));
    const begin = calls.find((c) => c.path === "/api/v1/auth/sso/begin");
    expect(begin?.body).toEqual({ returnTo: "/updates" });
  }, 20_000);

  it("leads with SSO when the workspace enforces it, and keeps the email form for investors", async () => {
    installMockApi({ ...signedOut, "GET /api/v1/auth/sso": sso({ enforced: true }) });
    const r = await renderApp("/login", otpOnly);
    const button = await screen.findByRole(
      "button",
      { name: "Continue with Acme Okta" },
      { timeout: 5000 },
    );
    expect(
      screen.getByText(/Staff at Acme sign in with the company's single sign-on/u),
    ).toBeInTheDocument();
    const email = screen.getByLabelText(/Email address/u);
    // The SSO button comes first in reading order; the email form follows it.
    expect(button.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: /Email me a code/u })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Continue with/u })).toHaveLength(1);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends an address in a verified SSO domain to the IdP instead of emailing a code", async () => {
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": sso(),
      "POST /api/v1/auth/sso/discover": () => [200, { sso: true }],
      "POST /api/v1/auth/sso/begin": () => [200, { url: IDP_URL }],
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
    });
    await renderApp("/login?returnTo=%2Fadmin", otpOnly);
    await screen.findByRole("button", { name: "Continue with Acme Okta" }, { timeout: 5000 });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/u), "grace@acme.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(IDP_URL));
    expect(calls.find((c) => c.path === "/api/v1/auth/sso/discover")?.body).toEqual({
      email: "grace@acme.com",
    });
    expect(calls.find((c) => c.path === "/api/v1/auth/sso/begin")?.body).toEqual({
      returnTo: "/admin",
      loginHint: "grace@acme.com",
    });
    expect(calls.some((c) => c.path === "/api/v1/auth/otp/start")).toBe(false);
  }, 20_000);

  it("emails a code as before when discovery says no, and says nothing about it", async () => {
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": sso(),
      "POST /api/v1/auth/sso/discover": () => [200, { sso: false }],
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
    });
    const r = await renderApp("/login", otpOnly);
    await screen.findByRole("button", { name: "Continue with Acme Okta" }, { timeout: 5000 });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    expect(calls.find((c) => c.path === "/api/v1/auth/otp/start")?.body).toEqual({
      email: "ada@example.com",
    });
    expect(calls.some((c) => c.path === "/api/v1/auth/sso/begin")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  }, 20_000);

  it("does not ask discovery when the workspace has no SSO", async () => {
    const { calls } = installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": sso({ available: false, name: null, protocol: null }),
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
    });
    const r = await renderApp("/login", otpOnly);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    expect(calls.some((c) => c.path === "/api/v1/auth/sso/discover")).toBe(false);
  }, 20_000);
});

describe("sign-in: /login?sso_error=", () => {
  const cases: [string, RegExp][] = [
    ["expired", /took too long/u],
    ["binding_mismatch", /Start again in the same browser/u],
    ["invalid_response", /couldn't verify the answer from your identity provider/u],
    ["idp_error", /identity provider didn't sign you in/u],
    ["unknown_user", /doesn't have access to this workspace/u],
    ["not_provisioned", /hasn't been set up in this workspace/u],
    ["suspended", /access to this workspace is suspended/u],
    ["staff_only", /for the company's staff/u],
    ["disabled", /turned off for this workspace/u],
    ["rate_limited", /Too many sign-in attempts/u],
    ["reauth_mismatch", /different person than the one using this session/u],
    ["reauth_required", /didn't ask you to sign in again/u],
  ];

  it("explains each failure code in a sentence of its own", async () => {
    installMockApi({ ...signedOut });
    for (const [code, sentence] of cases) {
      const r = await renderApp(`/login?sso_error=${code}`, otpOnly);
      const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
      expect(alert).toHaveTextContent(/Single sign-on didn't finish/u);
      expect(alert).toHaveTextContent(sentence);
      // The machine code itself never reaches the screen (a plain word like "expired" may).
      if (code.includes("_")) expect(alert).not.toHaveTextContent(code);
      if (code === "binding_mismatch") await expectNoA11yViolations(r.container);
      r.unmount();
    }
  }, 30_000);

  it("never echoes a crafted value", async () => {
    installMockApi({ ...signedOut });
    await renderApp(
      `/login?sso_error=${encodeURIComponent("Call +1 555 0100 to unlock your account")}`,
      otpOnly,
    );
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert).toHaveTextContent(/Something went wrong with single sign-on/u);
    expect(alert).not.toHaveTextContent(/555|unlock/u);
  }, 20_000);
});

describe("sso_required", () => {
  it("shows the 'requires single sign-on' screen when the bootstrap says the staff member is held", async () => {
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ ssoRequired: true, ssoBreakGlass: false, membership: null }),
      ],
      "GET /api/v1/auth/sso": sso({ enforced: true }),
      "POST /api/v1/auth/sso/begin": () => [200, { url: IDP_URL }],
    });
    const r = await renderApp("/admin");
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace requires single sign-on" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Owners can still use a passkey or authenticator/u)).toBeVisible();
    // Only an owner gets the step-up link.
    expect(screen.queryByRole("link", { name: /Verify with a passkey/u })).toBeNull();
    const button = await screen.findByRole("button", { name: "Continue with Acme Okta" });
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(IDP_URL));
    expect(calls.find((c) => c.path === "/api/v1/auth/sso/begin")?.body).toEqual({
      returnTo: "/admin",
    });
  }, 20_000);

  it("offers an owner the break-glass step-up", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ ssoRequired: true, ssoBreakGlass: true, membership: null }),
      ],
      "GET /api/v1/auth/sso": sso({ enforced: true }),
    });
    const r = await renderApp("/admin");
    const link = await screen.findByRole(
      "link",
      { name: "Verify with a passkey or authenticator" },
      { timeout: 5000 },
    );
    expect(link).toHaveClass("underline");
    expect(link.getAttribute("href")).toContain("/auth/step-up");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("a 403 sso_required from any query refreshes the bootstrap and lands on the same screen", async () => {
    let held = false;
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap(held ? { ssoRequired: true, membership: null } : {}),
      ],
      "GET /api/v1/content/render/{slug}": () => {
        held = true;
        return apiError(403, "sso_required", { details: { reason: "enforced" } });
      },
      "GET /api/v1/auth/sso": sso({ enforced: true }),
    });
    await renderApp("/");
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace requires single sign-on" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("shows the same screen when the bootstrap itself answers 403 sso_required", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => apiError(403, "sso_required"),
      "GET /api/v1/auth/sso": sso({ enforced: true }),
    });
    await renderApp("/");
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace requires single sign-on" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Continue with Acme Okta" })).toBeVisible();
  }, 20_000);
});

describe("embed", () => {
  const embedConfig = testConfig({
    tree: "embed",
    auth: { methods: ["email_otp"], passkeyRpId: "x" },
    embedOrigins: ["https://acme.com"],
    canonicalOrigin: "https://investors.acme.test",
  });

  it("opens the workspace sign-in at its own address in a new tab instead of redirecting the frame", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({ ...signedOut, "GET /api/v1/auth/sso": sso() });
    const r = await renderApp("/login?returnTo=%2Fupdates", embedConfig);
    const link = await screen.findByRole(
      "link",
      { name: "Continue with Acme Okta" },
      { timeout: 5000 },
    );
    expect(link).toHaveAttribute("href", "https://investors.acme.test/login?returnTo=%2Fupdates");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText(/opens the portal in a new tab/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(link);
    expect(open).toHaveBeenCalledWith(
      "https://investors.acme.test/login?returnTo=%2Fupdates",
      "_blank",
      "noopener",
    );
    expect(calls.some((c) => c.path === "/api/v1/auth/sso/begin")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  }, 20_000);

  it("after discovery, points the framed visitor at the new tab rather than sending a code", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { calls } = installMockApi({
      ...signedOut,
      "GET /api/v1/auth/sso": sso(),
      "POST /api/v1/auth/sso/discover": () => [200, { sso: true }],
    });
    await renderApp("/login", embedConfig);
    await screen.findByRole("link", { name: "Continue with Acme Okta" }, { timeout: 5000 });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/u), "grace@acme.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/can't run inside this page/u);
    expect(within(status).getByRole("link", { name: "Continue with Acme Okta" })).toBeVisible();
    expect(calls.some((c) => c.path === "/api/v1/auth/otp/start")).toBe(false);
    expect(calls.some((c) => c.path === "/api/v1/auth/sso/begin")).toBe(false);
  }, 20_000);
});

describe("SSO-bound session (FR1)", () => {
  const WS = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
  const CONN = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c99";
  const RESTRICTED =
    /This session came from single sign-on and can't change account security settings; sign in with your email to do this\./u;
  const securityReads = {
    "GET /api/v1/me/sessions": () => [200, { sessions: [] }] as [number, unknown],
    "GET /api/v1/me/devices": () => [200, { devices: [] }] as [number, unknown],
    "GET /api/v1/auth/passkeys": () => [200, { passkeys: [] }] as [number, unknown],
    "GET /api/v1/auth/totp": () =>
      [200, { enrolled: false, pending: false, recoveryCodesLeft: 0 }] as [number, unknown],
    "GET /api/v1/auth/password": () => [200, { enabled: true, set: false }] as [number, unknown],
  };

  it("replaces the security controls with one sentence when /me says the session is SSO-bound", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        { ...me(), session: { ...session(), sso: { workspaceId: WS, connectionId: CONN } } },
      ],
      "GET /api/v1/modules": () => [200, bootstrap()],
      ...securityReads,
    });
    const r = await renderApp("/settings/security");
    expect(await screen.findByText(RESTRICTED, {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Sign out everywhere/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /passkey/iu })).toBeNull();
    // Nothing the server would refuse is even asked for.
    expect(calls.some((c) => c.path === "/api/v1/me/sessions")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("stands down the same way after a 403 sso_session_restricted when /me does not say", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      ...securityReads,
      "GET /api/v1/me/sessions": () => apiError(403, "sso_session_restricted"),
    });
    await renderApp("/settings/security");
    expect(await screen.findByText(RESTRICTED, {}, { timeout: 5000 })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Sign out everywhere/u })).toBeNull(),
    );
  }, 20_000);

  it("lists the one bound workspace on the profile without breaking", async () => {
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        { ...me(), session: { ...session(), sso: { workspaceId: WS, connectionId: CONN } } },
      ],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    const r = await renderApp("/settings");
    const table = await screen.findByRole("table", {}, { timeout: 5000 });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Acme")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("step-up for an SSO-bound session (FR4)", () => {
  const WS = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
  const CONN = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c99";
  const withPassword = testConfig({
    auth: { methods: ["email_otp", "password"], passkeyRpId: "x" },
  });
  function boundMe(mfaEnrolled: boolean) {
    return () =>
      [
        200,
        {
          ...me(),
          session: {
            ...session({ user: { displayName: "Ada Lovelace", mfaEnrolled, locale: null } }),
            sso: { workspaceId: WS, connectionId: CONN },
          },
        },
      ] as [number, unknown];
  }

  it("drops the password tab and leads with signing in again at the IdP", async () => {
    const assign = vi.spyOn(ssoLoginNavigation, "assign").mockImplementation(() => {});
    const { calls } = installMockApi({
      "GET /api/v1/me": boundMe(false),
      "GET /api/v1/auth/sso": sso(),
      "POST /api/v1/auth/sso/begin": () => [200, { url: IDP_URL }],
    });
    const r = await renderApp(
      "/auth/step-up?returnTo=%2Fadmin%2Fapi-keys&reason=fresh",
      withPassword,
    );
    const button = await screen.findByRole(
      "button",
      { name: "Sign in again with Acme Okta" },
      { timeout: 5000 },
    );
    expect(screen.queryByRole("tab", { name: /Password/u })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(IDP_URL));
    expect(calls.find((c) => c.path === "/api/v1/auth/sso/begin")?.body).toEqual({
      returnTo: "/admin/api-keys",
      reauth: true,
    });
    // Reads a bound session is refused are never made.
    for (const path of ["/api/v1/auth/totp", "/api/v1/auth/passkeys", "/api/v1/auth/password"]) {
      expect(calls.some((c) => c.path === path)).toBe(false);
    }
  }, 20_000);

  it("keeps an enrolled authenticator next to the IdP option, still without a password tab", async () => {
    installMockApi({ "GET /api/v1/me": boundMe(true), "GET /api/v1/auth/sso": sso() });
    const r = await renderApp("/auth/step-up?returnTo=%2Fadmin&reason=fresh", withPassword);
    expect(
      await screen.findByRole(
        "button",
        { name: "Sign in again with Acme Okta" },
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /Authenticator/iu })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Password/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("does not offer the IdP for a level step-up (it would loop), only enrolled factors", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": boundMe(true),
      "GET /api/v1/auth/sso": sso(),
    });
    const r = await renderApp("/auth/step-up?returnTo=%2Fadmin&reason=level", withPassword);
    expect(
      await screen.findByRole("tab", { name: /Authenticator/iu }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in again/u })).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/auth/sso")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("a level step-up with no enrolled factor says there is nothing, even with SSO available", async () => {
    installMockApi({ "GET /api/v1/me": boundMe(false), "GET /api/v1/auth/sso": sso() });
    await renderApp("/auth/step-up?returnTo=%2Fadmin&reason=level", withPassword);
    expect(
      await screen.findByText(/no way to confirm it's you here right now/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Sign in again/u })).toBeNull();
  }, 20_000);

  it("says plainly when the session has no way to step up", async () => {
    installMockApi({
      "GET /api/v1/me": boundMe(false),
      "GET /api/v1/auth/sso": sso({ available: false, name: null, protocol: null }),
    });
    const r = await renderApp("/auth/step-up?returnTo=%2Fadmin&reason=level", withPassword);
    expect(
      await screen.findByText(/no way to confirm it's you here right now/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in again/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /security settings/iu })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
