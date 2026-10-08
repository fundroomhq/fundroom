import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, testConfig, WS_ID } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/request-access` — the public access-request form (E3.1).
 *
 * Asserted: details → code → a neutral "received" screen; a wrong code is one generic refusal
 * beside the field; the honeypot is never in the accessibility tree nor the tab order; the page
 * (and the sign-in page's link to it) only exists where the workspace takes requests.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const EXPIRES = "2026-09-25T10:10:00.000Z";
const EXPIRES_2 = "2026-09-25T10:12:00.000Z";

const signedOut = (over: Parameters<typeof bootstrap>[0] = {}) =>
  bootstrap({ permissions: [], membership: null, requestAccessEnabled: true, ...over });

describe("request access", () => {
  it("runs details → code → received, with one generic refusal for a wrong code", async () => {
    let starts = 0;
    let verifies = 0;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut()],
      "POST /api/v1/access-requests/start": () => {
        starts++;
        return [202, { expiresAt: starts === 1 ? EXPIRES : EXPIRES_2 }];
      },
      "POST /api/v1/access-requests/verify": () => {
        verifies++;
        if (verifies === 1) return apiError(400, "invalid_code");
        return [200, { status: "received" }];
      },
    });
    const r = await renderApp("/request-access");
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Request access" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // No offering note outside 506(b), and never an accreditation question.
    expect(screen.queryByText(/No information about any offering/u)).toBeNull();
    expect(screen.queryByText(/accredited/iu)).toBeNull();
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/Full name/u), "Grace Hopper");
    await user.type(screen.getByLabelText(/Email address/u), "grace@navy.test");
    await user.type(screen.getByLabelText(/Firm or organisation/u), "Navy Ventures");
    await user.type(screen.getByLabelText(/Anything the team should know/u), "Met at demo day");
    expect(screen.getByText("15 of 2000 characters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email me a code" }));

    expect(
      await screen.findByRole("heading", { name: "Confirm your email" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/access-requests/start")?.body).toEqual({
      email: "grace@navy.test",
      name: "Grace Hopper",
      firm: "Navy Ventures",
      reason: "Met at demo day",
    });
    await expectNoA11yViolations(r.container);

    // A wrong code: the one generic refusal, beside the field, which is cleared for a retry.
    const input = screen.getByLabelText(/One-time code/u);
    await user.type(input, "111111");
    expect(await screen.findByText(/Check the code and try again/u)).toBeInTheDocument();
    expect(screen.getByLabelText(/One-time code/u)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/One-time code/u)).toHaveValue("");
    await expectNoA11yViolations(r.container);

    // Resend restarts the challenge, but only after a cooldown (next test).
    expect(screen.getByRole("button", { name: /Resend in/u })).toBeDisabled();

    await user.type(screen.getByLabelText(/One-time code/u), "123456");
    const received = await screen.findByRole(
      "heading",
      { name: "Request received" },
      { timeout: 5000 },
    );
    // The step change is announced: focus moves to the new heading.
    await waitFor(() => expect(received).toHaveFocus());
    expect(
      screen.getByText("If your request can be considered, the team will be in touch by email."),
    ).toBeInTheDocument();
    // The code is paired with the address it was mailed to — there is no challenge id.
    const verifyCalls = calls.filter((c) => c.path === "/api/v1/access-requests/verify");
    expect(verifyCalls.map((c) => c.body)).toEqual([
      { email: "grace@navy.test", code: "111111" },
      { email: "grace@navy.test", code: "123456" },
    ]);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("resends by starting again and verifies with the address", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let starts = 0;
      const { calls } = installMockApi({
        "GET /api/v1/me": () => apiError(401, "unauthenticated"),
        "GET /api/v1/modules": () => [200, signedOut()],
        "POST /api/v1/access-requests/start": () => {
          starts++;
          return [202, { expiresAt: starts === 1 ? EXPIRES : EXPIRES_2 }];
        },
        "POST /api/v1/access-requests/verify": () => [200, { status: "received" }],
      });
      await renderApp("/request-access");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(
        await screen.findByLabelText(/Full name/u, undefined, { timeout: 5000 }),
        "Grace Hopper",
      );
      await user.type(screen.getByLabelText(/Email address/u), "grace@navy.test");
      await user.click(screen.getByRole("button", { name: "Email me a code" }));
      await screen.findByRole("heading", { name: "Confirm your email" }, { timeout: 5000 });

      // The cooldown ticks once a second, each tick scheduled by the previous render.
      for (let i = 0; i < 31; i++) {
        await act(() => vi.advanceTimersByTimeAsync(1000));
      }
      await user.click(await screen.findByRole("button", { name: "Resend code" }));
      await waitFor(() => expect(starts).toBe(2));
      await user.type(screen.getByLabelText(/One-time code/u), "123456");
      await screen.findByRole("heading", { name: "Request received" }, { timeout: 5000 });
      const startCalls = calls.filter((c) => c.path === "/api/v1/access-requests/start");
      expect(startCalls.map((c) => c.body)).toEqual([
        { email: "grace@navy.test", name: "Grace Hopper" },
        { email: "grace@navy.test", name: "Grace Hopper" },
      ]);
      expect(calls.find((c) => c.path === "/api/v1/access-requests/verify")?.body).toEqual({
        email: "grace@navy.test",
        code: "123456",
      });
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("says beside the field when the address is not valid", async () => {
    let refuse = false;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut()],
      "POST /api/v1/access-requests/start": () =>
        refuse ? apiError(400, "validation_failed") : [202, { expiresAt: EXPIRES }],
    });
    const r = await renderApp("/request-access");
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Full name/u, undefined, { timeout: 5000 }),
      "Grace Hopper",
    );
    const email = screen.getByLabelText(/Email address/u);
    await user.type(email, "grace@navy");
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(
      await screen.findByText("Enter a valid email address, such as name@example.com."),
    ).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveFocus();
    expect(calls.some((c) => c.path === "/api/v1/access-requests/start")).toBe(false);
    await expectNoA11yViolations(r.container);

    // Typing clears it; an address the server still refuses is shown in the same place.
    await user.type(email, ".test");
    expect(screen.queryByText(/Enter a valid email address/u)).toBeNull();
    expect(email).not.toHaveAttribute("aria-invalid", "true");
    refuse = true;
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(
      await screen.findByText("Enter a valid email address, such as name@example.com."),
    ).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Check the form")).toBeNull();
  }, 20_000);

  it("keeps the honeypot out of the accessibility tree and the tab order", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut()],
    });
    const r = await renderApp("/request-access");
    await screen.findByRole("heading", { name: "Request access" }, { timeout: 5000 });

    // Not reachable by role or label for assistive technology…
    expect(screen.queryByRole("textbox", { name: /website/iu })).toBeNull();
    expect(screen.getAllByRole("textbox").map((e) => e.getAttribute("name"))).toEqual([
      "name",
      "email",
      "organization",
      "reason",
    ]);
    // …but present for a bot, unfocusable and never autofilled.
    const trap = r.container.querySelector<HTMLInputElement>('input[name="website"]');
    expect(trap).not.toBeNull();
    expect(trap).toHaveAttribute("tabindex", "-1");
    expect(trap).toHaveAttribute("autocomplete", "off");
    const wrapper = trap?.closest("[aria-hidden]");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(wrapper).toHaveAttribute("inert");
    // Keyboard order goes from the last visible field straight to the submit button.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Full name/u), "Grace Hopper");
    await user.type(screen.getByLabelText(/Email address/u), "grace@navy.test");
    await user.click(screen.getByLabelText(/Anything the team should know/u));
    await user.tab();
    expect(screen.getByRole("button", { name: "Email me a code" })).toHaveFocus();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows the 506(b) note", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [
        200,
        signedOut({
          workspace: {
            id: WS_ID,
            slug: "acme",
            name: "Acme",
            offeringStatus: "506b",
            defaultLocale: "en",
          },
        }),
      ],
    });
    const r = await renderApp("/request-access");
    expect(
      await screen.findByText(
        /No information about any offering is provided through it/u,
        undefined,
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/accredited/iu)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says requests are not available when the workspace does not take them", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut({ requestAccessEnabled: false })],
    });
    const r = await renderApp("/request-access");
    expect(
      await screen.findByRole("heading", { name: "Requests are not available" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link).toHaveAttribute("href", "/login");
    // Body-text links keep a persistent underline (jsdom axe cannot check contrast).
    expect(link.className).toContain("underline");
    expect(screen.queryByLabelText(/Full name/u)).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/access-requests"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("falls back to 'not available' when the server 404s the start", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut()],
      "POST /api/v1/access-requests/start": () => apiError(404, "not_found"),
    });
    await renderApp("/request-access");
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/Full name/u, undefined, { timeout: 5000 }),
      "Grace Hopper",
    );
    await user.type(screen.getByLabelText(/Email address/u), "grace@navy.test");
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(
      await screen.findByRole("heading", { name: "Requests are not available" }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("sign-in page link", () => {
  it("offers 'Request access' when the workspace takes requests", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut()],
    });
    const r = await renderApp(
      "/login",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    const link = await screen.findByRole("link", { name: "Request access" }, { timeout: 5000 });
    expect(link).toHaveAttribute("href", "/request-access");
    expect(link.className).toContain("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides it otherwise", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, signedOut({ requestAccessEnabled: false })],
    });
    const r = await renderApp(
      "/login",
      testConfig({ auth: { methods: ["email_otp"], passkeyRpId: "x" } }),
    );
    await screen.findByRole("heading", { name: "Sign in" }, { timeout: 5000 });
    // The bootstrap has answered before absence means anything.
    await waitFor(() =>
      expect(r.queryClient.getQueryData(["bootstrap"])).toMatchObject({
        requestAccessEnabled: false,
      }),
    );
    expect(screen.queryByRole("link", { name: "Request access" })).toBeNull();
  }, 20_000);
});
