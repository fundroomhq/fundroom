import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, login, me, session, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

describe("login", () => {
  it("renders the methods from config and starts an OTP", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "POST /api/v1/auth/otp/start": () => [
        200,
        { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 },
      ],
      "GET /api/v1/auth/oidc/providers": () => [200, { providers: [{ id: "sso" }] }],
      // E3.8: the workspace's own SSO is a separate lookup; none here (sso-login.test covers it).
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
    });
    const config = testConfig({
      auth: { methods: ["email_otp", "magic_link", "password", "oidc"], passkeyRpId: "x" },
    });
    const r = await renderApp("/login?returnTo=%2Fupdates", config);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email me a link instead/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use a password/u })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Continue with SSO/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /passkey/iu })).toBeNull();
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fupdates");
    const start = calls.find((c) => c.path === "/api/v1/auth/otp/start");
    expect(start?.body).toEqual({ email: "ada@example.com" });
  });

  it("shows the rate-limit alert with the retry delay", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "POST /api/v1/auth/otp/start": () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "42" },
        }),
    });
    await renderApp("/login", testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("42 seconds");
  });
});

describe("verify", () => {
  it("keeps the field on invalid_code and navigates on success", async () => {
    let attempt = 0;
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "POST /api/v1/auth/otp/verify": ({ body }) => {
        attempt++;
        if (attempt === 1) return apiError(400, "invalid_code");
        expect(body).toEqual({ email: "ada@example.com", code: "654321", rememberDevice: true });
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(
      "/login/verify?email=ada%40example.com&returnTo=%2Fupdates&remember=true",
    );
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: /Enter your code/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const input = screen.getByLabelText(/One-time code/u);
    await user.type(input, "123456");
    expect(await screen.findByText(/didn't work|Check the code/u)).toBeInTheDocument();
    expect(pathOf(r.router)).toContain("/login/verify");
    await user.type(screen.getByLabelText(/One-time code/u), "654321");
    await waitFor(() => expect(pathOf(r.router)).toBe("/updates"));
  });

  /*
   * The regression the e2e host harness found, and the reason `refreshSession` exists.
   *
   * It is invisible to the test above because that one opens `/login/verify` directly, with an
   * empty cache. A real visitor arrives at a gated route first: `_portal`'s `ensureQueryData`
   * asks `/me`, gets a 401, and caches `null` before redirecting to the sign-in screen. A plain
   * `invalidateQueries` then marks that `null` stale without refetching it — nothing on the
   * sign-in screen observes `me` — and `ensureQueryData` resolves stale data from the cache, so
   * the guard sends a freshly signed-in visitor straight back to "Sign in" with a perfectly
   * good session cookie. This starts from `/` so the `null` is in the cache, which is the whole
   * point.
   */
  it("lands on the gated route it came from, not back at the sign-in screen", async () => {
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
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
      "/",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const user = userEvent.setup();
    // Signed out at a gated route: the guard has now cached `me === null`.
    await waitFor(() => expect(pathOf(r.router)).toContain("/login"));
    expect(pathOf(r.router)).toContain("returnTo=%2F");

    await user.type(await screen.findByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    await user.type(await screen.findByLabelText(/One-time code/u), "654321");

    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
    expect(pathOf(r.router)).not.toContain("/login");
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();
  }, 20_000);

  it("explains an expired membership instead of asking for another code (E3.2)", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "POST /api/v1/auth/otp/verify": () => apiError(403, "membership_expired"),
    });
    const r = await renderApp("/login/verify?email=ada%40example.com");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/One-time code/u), "123456");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Your access to this workspace has ended. Contact the company to restore it.",
    );
    // Another code would be refused the same way: the form is gone, a way back is offered.
    expect(screen.queryByLabelText(/One-time code/u)).toBeNull();
    expect(screen.getByRole("link", { name: /Back/u })).toBeInTheDocument();
    expect(pathOf(r.router)).toContain("/login/verify");
    await expectNoA11yViolations(r.container);
  });
});

describe("magic link", () => {
  it("peeks, never auto-confirms, and posts on the button", async () => {
    const token = "t".repeat(32);
    let signedIn = false;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/auth/magic-link/peek": () => [
        200,
        { valid: true, emailHint: "a***@b.co", requestedFrom: "Chrome on macOS" },
      ],
      "POST /api/v1/auth/magic-link/confirm": ({ body }) => {
        expect(body).toEqual({ token, rememberDevice: false });
        signedIn = true;
        return [200, login()];
      },
    });
    const r = await renderApp(`/auth/magic-link?token=${token}`);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: /Confirm sign-in/u })).toBeInTheDocument();
    expect(screen.getByText(/Chrome on macOS/u)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(true));
    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
  });
  it("shows an error state for an unusable link", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/auth/magic-link/peek": () => [200, { valid: false }],
    });
    await renderApp(`/auth/magic-link?token=${"u".repeat(32)}`);
    expect(await screen.findByText(/This link can't be used/u)).toBeInTheDocument();
  });
});

describe("invite", () => {
  it("renders a valid invitation and an invalid one", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/invites/{token}": ({ params }) =>
        params["token"] === "good".padEnd(20, "0")
          ? [
              200,
              {
                valid: true,
                emailHint: "a***@b.co",
                kind: "external",
                expiresAt: "2026-10-01T00:00:00Z",
              },
            ]
          : [200, { valid: false }],
    });
    const r = await renderApp(`/invite/${"good".padEnd(20, "0")}`);
    expect(
      await screen.findByRole("heading", { name: /You've been invited/u }),
    ).toBeInTheDocument();
    expect(screen.getByText("Investor")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Continue to sign in/u })).toHaveAttribute(
      "href",
      "/login?returnTo=%2F",
    );
    await expectNoA11yViolations(r.container);
    r.unmount();
    await renderApp(`/invite/${"bad".padEnd(20, "0")}`);
    expect(await screen.findByText(/This invitation can't be used/u)).toBeInTheDocument();
  });
});

describe("step-up", () => {
  it("verifies a TOTP code and returns to returnTo", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({ session: session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }) }),
      ],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "POST /api/v1/auth/totp/verify": ({ body }) => {
        expect(body).toEqual({ code: "246810" });
        return [200, { ok: true }];
      },
    });
    const r = await renderApp("/auth/step-up?returnTo=%2Fsettings%2Fsecurity&reason=fresh");
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: /Confirm it's you/u })).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Authenticator code/u), "246810");
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/totp/verify"))).toBe(true));
    await waitFor(() => expect(pathOf(r.router)).toBe("/settings/security"));
  });
});
