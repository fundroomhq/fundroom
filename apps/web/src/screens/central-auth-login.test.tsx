import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  centralAuthNavigation,
  centralStartHref,
  isServerReturnPath,
  signInDestination,
  signInReturnPath,
} from "../lib/central-auth.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, login, me, session, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Central auth origin, the SPA's half (E3.10, ADR-0058 §5.6). On a workspace host the sign-in
 * screen leads with "Continue" (a page load to `/auth/central/start`); on the canonical host a
 * `next=/auth/central/authorize?…` is honoured after sign-in with a page load too, because it is
 * a server route the router would render as not found. `centralAuthNavigation.assign` stands in
 * for those page loads.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NO_SSO = { available: false, name: null, protocol: null, enforced: false };
const CENTRAL = testConfig({
  auth: { methods: ["email_otp"], passkeyRpId: "x" },
  centralAuth: { startPath: "/auth/central/start" },
});

function signedOut(over: Parameters<typeof installMockApi>[0] = {}) {
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "GET /api/v1/auth/sso": () => [200, NO_SSO],
    ...over,
  });
}

describe("central auth — workspace host", () => {
  it("leads with Continue, which starts the central flow with the return path", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    signedOut();
    const r = await renderApp("/login?returnTo=%2Fupdates%3Fx%3D1", CENTRAL);
    const button = await screen.findByRole("button", { name: "Continue" }, { timeout: 5000 });
    // The email code still works here, below it.
    expect(screen.getByRole("button", { name: /Email me a code/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    expect(assign).toHaveBeenCalledWith("/auth/central/start?return=%2Fupdates%3Fx%3D1");
  }, 20_000);

  it("is not offered without central auth, nor when sent here for the workspace's SSO", async () => {
    signedOut();
    const r = await renderApp("/login", testConfig({ auth: CENTRAL.auth }));
    expect(
      await screen.findByRole("button", { name: /Email me a code/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    r.unmount();

    await renderApp("/login?sso=1", CENTRAL);
    expect(
      await screen.findByRole("button", { name: /Email me a code/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  }, 20_000);

  it("says so when the account that signed in is not a member here", async () => {
    signedOut();
    const r = await renderApp("/login?error=no_access", CENTRAL);
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert).toHaveTextContent("No access to this workspace");
    expect(alert).toHaveTextContent(/not a member of this workspace/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("central auth — errors back on the workspace host", () => {
  // The only values `/auth/central/finish` puts in `/login?error=` (CENTRAL_AUTH_ERROR_CODES).
  const cases: [string, RegExp][] = [
    ["expired", /took too long or was already used/u],
    ["binding_mismatch", /started in a different browser or tab/u],
    ["reauth_mismatch", /with a different account than the one signed in here/u],
    ["session_ended", /session ended before sign-in could finish/u],
  ];
  it.each(cases)(
    "says what %s means in words, never the code",
    async (code, sentence) => {
      signedOut();
      const r = await renderApp(`/login?error=${code}`, CENTRAL);
      const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
      expect(alert).toHaveTextContent("Sign-in didn't finish");
      expect(alert).toHaveTextContent(sentence);
      expect(alert).not.toHaveTextContent(code);
      // Starting again is right there.
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );
});

describe("central auth — the server's own round trip", () => {
  it("honours authorize's returnTo=/auth/central/authorize with a page load after the code", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    // Byte for byte what `routes/central-auth.ts` redirects to (encodeURIComponent of `self`).
    const self = encodeURIComponent("/auth/central/authorize?req=Abc_-123");
    const r = await renderApp(
      `/login?returnTo=${self}`,
      testConfig({ workspace: null, auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Email address/u, {}, { timeout: 5000 }),
      "ada@example.com",
    );
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    await user.type(await screen.findByLabelText(/One-time code/u), "654321");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/auth/central/authorize?req=Abc_-123"),
    );
  }, 20_000);

  it("returns from authorize's fresh step-up with a page load too", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }),
        }),
      ],
      "POST /api/v1/auth/totp/verify": () => [200, { ok: true }],
    });
    const self = encodeURIComponent("/auth/central/authorize?req=Abc_-123");
    await renderApp(
      `/auth/step-up?reason=fresh&returnTo=${self}`,
      testConfig({ workspace: null, auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await userEvent
      .setup()
      .type(await screen.findByLabelText(/Authenticator code/iu, {}, { timeout: 5000 }), "123456");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/auth/central/authorize?req=Abc_-123"),
    );
  }, 20_000);
});

// A-5 round 5 L5: a return path is an SPA route, or a central-auth step — never another server path.
describe("central auth — return paths to other server routes", () => {
  it("goes home after the code instead of to an API or webhook path", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(
      `/login?returnTo=${encodeURIComponent("/webhooks/billing/stripe?x=1")}`,
      testConfig({ workspace: null, auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Email address/u, {}, { timeout: 5000 }),
      "ada@example.com",
    );
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    // Not carried on to the code screen either.
    expect(pathOf(r.router)).not.toContain("webhooks");
    await user.type(await screen.findByLabelText(/One-time code/u), "654321");
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/"));
    expect(assign).not.toHaveBeenCalled();
  }, 20_000);

  // Round 6 HIGH, then E-UP-18 D3: the investor KPIs page is `/kpis` (the metrics module);
  // `/metrics` is the server's ops endpoint, and a sign-in never returns to it.
  it("returns to the investor KPIs page at /kpis after the code", async () => {
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(
      "/login?returnTo=%2Fkpis",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Email address/u, {}, { timeout: 5000 }),
      "ada@example.com",
    );
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("returnTo=%2Fkpis"));
    await user.type(await screen.findByLabelText(/One-time code/u), "654321");
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/kpis"));
  }, 20_000);

  // E-UP-18 review L2: signed out on an old in-app link, the sign-in returns to the new page.
  it("sends a signed-out /metrics to sign-in with /kpis to return to", async () => {
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(
      "/metrics?period=2026-q3",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/login"));
    expect(r.router.state.location.search).toMatchObject({ returnTo: "/kpis?period=2026-q3" });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Email address/u, {}, { timeout: 5000 }),
      "ada@example.com",
    );
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "654321",
    );
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/kpis"));
  }, 20_000);

  it("keeps the query and the fragment of a signed-out /metrics on its way to /kpis", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    const r = await renderApp(
      "/metrics?x=1#h",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/login"));
    expect(pathOf(r.router)).toBe(`/login?returnTo=${encodeURIComponent("/kpis?x=1#h")}`);
  }, 20_000);

  it("goes home after the code instead of to the ops /metrics", async () => {
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(
      "/login/verify?email=ada%40example.com&returnTo=%2Fmetrics",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await userEvent
      .setup()
      .type(await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }), "654321");
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/"));
  }, 20_000);
});

describe("central auth — a session handed to this workspace host", () => {
  const WS = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
  const WITH_PASSWORD = testConfig({
    auth: { methods: ["email_otp", "password"], passkeyRpId: "x" },
    centralAuth: { startPath: "/auth/central/start" },
  });
  function boundMe(mfaEnrolled = false) {
    return () =>
      [
        200,
        {
          ...me(),
          session: {
            ...session({ user: { displayName: "Ada Lovelace", mfaEnrolled, locale: null } }),
            boundWorkspaceId: WS,
          },
        },
      ] as [number, unknown];
  }
  const securityReads = {
    "GET /api/v1/me/sessions": () => [200, { sessions: [] }] as [number, unknown],
    "GET /api/v1/me/devices": () => [200, { devices: [] }] as [number, unknown],
    "GET /api/v1/auth/passkeys": () => [200, { passkeys: [] }] as [number, unknown],
    "GET /api/v1/auth/totp": () =>
      [200, { enrolled: false, pending: false, recoveryCodesLeft: 0 }] as [number, unknown],
    "GET /api/v1/auth/password": () => [200, { enabled: true, set: false }] as [number, unknown],
  };

  it("replaces the security controls with one sentence, like an SSO-bound session", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": boundMe(),
      "GET /api/v1/modules": () => [200, bootstrap()],
      ...securityReads,
    });
    const r = await renderApp("/settings/security", WITH_PASSWORD);
    expect(
      await screen.findByText(
        /this session can't change your account's security settings/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Sign out everywhere/u })).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/me/sessions")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("stands down after a 403 bound_session_restricted when /me does not say", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      ...securityReads,
      "GET /api/v1/me/sessions": () => apiError(403, "bound_session_restricted"),
    });
    await renderApp("/settings/security", WITH_PASSWORD);
    expect(
      await screen.findByText(
        /this session can't change your account's security settings/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Sign out everywhere/u })).toBeNull(),
    );
  }, 20_000);

  it("step-up offers the canonical host, never a password or the security screen", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": boundMe(false),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    const r = await renderApp("/auth/step-up?returnTo=%2Fadmin&reason=fresh", WITH_PASSWORD);
    expect(
      await screen.findByRole("button", { name: "Continue" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: /Password/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /security settings/iu })).toBeNull();
    expect(screen.queryByText(/haven't set up a passkey/u)).toBeNull();
    // Not the workspace's IdP either: this session did not come from it.
    expect(calls.some((c) => c.path === "/api/v1/auth/sso")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("central auth — canonical host", () => {
  it("honours next=/auth/central/authorize with a page load after the code", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const next = encodeURIComponent("/auth/central/authorize?req=abc123");
    const r = await renderApp(
      `/login?next=${next}`,
      testConfig({ workspace: null, auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Email address/u, {}, { timeout: 5000 }),
      "ada@example.com",
    );
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    await user.type(await screen.findByLabelText(/One-time code/u), "654321");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/central/authorize?req=abc123"));
  }, 20_000);

  it("keeps BASE_PATH on the page load, whichever way next was spelt", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "POST /api/v1/auth/otp/verify": () => {
        signedIn = true;
        return [200, login()];
      },
    });
    const returnTo = encodeURIComponent("/auth/central/authorize?req=abc123");
    await renderApp(
      `/login/verify?email=ada%40example.com&returnTo=${returnTo}`,
      testConfig({ workspace: null, basePath: "/investors" }),
    );
    await userEvent
      .setup()
      .type(await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }), "654321");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/investors/auth/central/authorize?req=abc123"),
    );
  }, 20_000);
});

describe("central auth — step-up on a workspace host", () => {
  it("offers to re-prove the session on the canonical host", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    const r = await renderApp("/auth/step-up?returnTo=%2Fadmin%2Fbilling&reason=fresh", CENTRAL);
    const button = await screen.findByRole("button", { name: "Continue" }, { timeout: 5000 });
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    expect(assign).toHaveBeenCalledWith("/auth/central/start?return=%2Fadmin%2Fbilling&reauth=1");
  }, 20_000);

  // E-UP-18 D1: a fresh sign-in alone may come back at level 1 — and straight back here.
  it("asks the canonical host for level 2 when the step-up is for the level", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    await renderApp("/auth/step-up?returnTo=%2Fadmin%2Fbilling&reason=level", CENTRAL);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Continue" }, { timeout: 5000 }));
    expect(assign).toHaveBeenCalledWith(
      "/auth/central/start?return=%2Fadmin%2Fbilling&reauth=1&level=2",
    );
  }, 20_000);
});

describe("central auth — a level step-up on the canonical host", () => {
  const AUTHORIZE = "/auth/central/authorize?req=abc123";
  const CANONICAL = testConfig({
    workspace: null,
    auth: { methods: ["email_otp"], passkeyRpId: "x" },
  });

  // E-UP-18: with nothing to confirm with, "open security settings" would lose the authorize
  // step; the first factor is added here, and the central sign-in goes on.
  it("adds a first factor in place and goes on to the authorize step", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    let level: 1 | 2 = 1;
    let enrolled = false;
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            authLevel: level,
            user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null },
          }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/totp/enrol": () => [
        200,
        {
          credentialId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5999",
          secretBase32: "JBSWY3DPEHPK3PXP",
          otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        },
      ],
      "POST /api/v1/auth/totp/enrol/confirm": () => {
        enrolled = true;
        level = 2;
        return [200, { recoveryCodes: ["aaaa-bbbb"] }];
      },
    });
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(AUTHORIZE)}`,
      CANONICAL,
    );
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/haven't set up a passkey/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /security settings/iu })).toBeNull();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /^Set up$/u }));
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    // The recovery codes are read before anything moves; the enrolment stays on screen although
    // the account now has a factor.
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
  }, 20_000);

  // Review L1: a `/me` cached from before a factor was added elsewhere does not decide it.
  it("reads the account afresh before offering to add a first factor", async () => {
    let enrolled = false;
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({ user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null } }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    // A page that reads `/me` first: the cache says "no factor".
    const r = await renderApp("/accessibility", CANONICAL);
    await waitFor(() => expect(r.queryClient.getQueryData(["me"])).toBeTruthy());
    // An authenticator app is added in another tab; this one then needs a level step-up.
    enrolled = true;
    await r.router.navigate({
      to: "/auth/step-up",
      search: { reason: "level", next: AUTHORIZE },
    });
    expect(
      await screen.findByLabelText(/Authenticator code/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Secure your account/u })).toBeNull();
  }, 20_000);

  // Fix round 2: an account that cannot be read is said, not shown as a lone passkey tab.
  it("says so when the account cannot be read", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(500, "internal"),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    await renderApp(`/auth/step-up?reason=level&next=${encodeURIComponent(AUTHORIZE)}`, CANONICAL);
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    // Fix round 3: only the error and a retry — nothing decided from an account not read.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText(/haven't set up/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /security settings/iu })).toBeNull();
  }, 20_000);

  // Fix round 4: in a frame, the top-level window stays offered beside the error.
  it("keeps the new-window way in a frame when the account cannot be read", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(500, "internal"),
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    await renderApp(
      "/auth/step-up?reason=level&returnTo=%2Fupdates",
      testConfig({
        tree: "embed",
        auth: { methods: ["email_otp"], passkeyRpId: "x" },
        embedOrigins: ["https://acme.com"],
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue in a new window/u })).toBeInTheDocument();
  }, 20_000);

  // Review L4: in a frame the top-level window is the way, not enrolling in place.
  it("does not enrol in place inside an embed", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    await renderApp(
      "/auth/step-up?reason=level&returnTo=%2Fupdates",
      testConfig({
        tree: "embed",
        auth: { methods: ["email_otp"], passkeyRpId: "x" },
        embedOrigins: ["https://acme.com"],
      }),
    );
    expect(
      await screen.findByRole("button", { name: /Continue in a new window/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Settled on the fresh `/me`: the frame's own (empty) choice, not an enrolment.
    expect(
      await screen.findByText(/haven't set up a passkey/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Secure your account/u })).toBeNull();
  }, 20_000);

  it("still confirms with the factor an account already has", async () => {
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({ session: session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }) }),
      ],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
    });
    await renderApp(`/auth/step-up?reason=level&next=${encodeURIComponent(AUTHORIZE)}`, CANONICAL);
    expect(
      await screen.findByLabelText(/Authenticator code/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Secure your account/u })).toBeNull();
  }, 20_000);
});

describe("central auth helpers", () => {
  it("reads next before returnTo, strips BASE_PATH and refuses off-site values", () => {
    expect(signInReturnPath({ next: "/auth/central/authorize?req=a", returnTo: "/x" }, "")).toBe(
      "/auth/central/authorize?req=a",
    );
    expect(signInReturnPath({ next: "/base/auth/central/authorize?req=a" }, "/base")).toBe(
      "/auth/central/authorize?req=a",
    );
    expect(signInReturnPath({ returnTo: "/updates" }, "/base")).toBe("/updates");
    expect(signInReturnPath({ next: "//evil.example/auth/central/x" }, "")).toBe("/");
    expect(signInReturnPath({ next: "https://evil.example/" }, "")).toBe("/");
    expect(signInReturnPath({}, "")).toBe("/");
    // A central-auth step only as the server routes it: no encoded slash, no empty step.
    expect(signInDestination("/auth/central%2Fstart")).toBe("/");
    expect(signInDestination("/auth/central/")).toBe("/");
  });

  it("knows the server's own paths from the SPA's routes", () => {
    const esign = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    for (const path of [
      "/api/v1/me",
      "/api",
      "/auth/central/finish?code=x",
      "/.well-known/fundroom.json",
      `/webhooks/esign/${esign}`,
      `/webhooks/accreditation/${esign}`,
      `/webhooks/integrations/${esign}`,
      "/webhooks/email/postmark",
      "/webhooks/billing/stripe",
      "/scim/v2/Users",
      "/scim/v2",
      `/sso/oidc/${esign}/callback`,
      `/sso/saml/${esign}/acs`,
      `/sso/saml/${esign}/metadata`,
      "/oauth/integrations/callback?code=x",
      "/internal/tls/ask",
      "/embed/v1/embed.js",
      "/embed/acme/theme.json",
      "/csp-report",
      "/healthz",
      "/readyz",
      "/metrics",
      "/metrics/",
      "/metrics?period=2026-q3",
      "/healthz/",
      "/webhooks/billing/stripe/",
      "/security.txt",
      "/%61pi/v1/me",
    ]) {
      expect(isServerReturnPath(path), path).toBe(true);
    }
    // SPA routes, module pages among them (the investor nav of every module, and the admin's).
    for (const path of [
      "/",
      "/kpis",
      "/kpis?period=2026-q3",
      "/updates",
      "/data-room",
      "/round",
      "/captable",
      "/admin/metrics",
      "/admin/metrics/sheets",
      "/admin/webhooks",
      "/admin/sso",
      "/admin/embed",
      "/auth/step-up?reason=level",
      "/auth/magic-link",
      "/auth/popup",
      "/admin/billing?plan=growth",
      "/setup?step=secure&returnTo=%2Fapi%2Fv1%2Fme",
      "/apis",
      "/settings/security",
      "/healthz/x",
      "/internal",
      "/sso",
      "/embed",
      "/webhooks",
      "/oauth",
    ]) {
      expect(isServerReturnPath(path), path).toBe(false);
      expect(signInDestination(path), path).toBe(path);
    }
    // A sign-in returns to a central-auth step (a page load) but to no other server path.
    expect(signInReturnPath({ returnTo: "/api/v1/me" }, "")).toBe("/");
    expect(signInReturnPath({ next: "/base/scim/v2/Users" }, "/base")).toBe("/");
    expect(signInReturnPath({ returnTo: "/kpis" }, "")).toBe("/kpis");
    expect(signInReturnPath({ returnTo: "/metrics" }, "")).toBe("/");
    expect(signInReturnPath({ returnTo: "/auth/central/authorize?req=a" }, "")).toBe(
      "/auth/central/authorize?req=a",
    );
    expect(centralStartHref("/auth/central/start", "/webhooks/billing/stripe")).toBe(
      "/auth/central/start",
    );
    expect(centralStartHref("/auth/central/start", "/kpis")).toBe(
      "/auth/central/start?return=%2Fkpis",
    );
    expect(centralStartHref("/auth/central/start", "/metrics")).toBe("/auth/central/start");
  });

  it("builds the start URL without looping back into the central flow", () => {
    expect(centralStartHref("/w/auth/central/start", "/updates")).toBe(
      "/w/auth/central/start?return=%2Fupdates",
    );
    expect(centralStartHref("/auth/central/start", "/")).toBe("/auth/central/start");
    expect(centralStartHref("/auth/central/start", "/", { reauth: true })).toBe(
      "/auth/central/start?reauth=1",
    );
    expect(centralStartHref("/auth/central/start", "/auth/central/finish?code=x")).toBe(
      "/auth/central/start",
    );
    expect(centralStartHref("/auth/central/start", "//evil.example")).toBe("/auth/central/start");
  });
});
