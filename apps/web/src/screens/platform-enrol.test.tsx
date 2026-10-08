import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { platformConfig } from "../test/fixtures-platform.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * Operator enrolment (E3.10 FR2): `/platform/enrol?token=…` on the canonical host. The address,
 * the emailed code, one factor through the enrolment-only `/platform/enrol/*` endpoints (never
 * `/auth/*`, which do not accept that session), then the `operator grant` command to hand on.
 * jsdom has no WebAuthn: support is stubbed on and the ceremony itself stubbed out.
 */
vi.mock("../lib/webauthn.js", async (importActual) => ({
  ...(await importActual<typeof import("../lib/webauthn.js")>()),
  webAuthnSupported: () => Promise.resolve(true),
  webAuthnAutofillSupported: () => Promise.resolve(false),
  register: () => Promise.resolve({ id: "cred", type: "public-key" }),
}));

afterEach(() => vi.unstubAllGlobals());

const TOKEN = "tok_0123456789abcdefghijKLMN";
const PAGE = `/platform/enrol?token=${TOKEN}`;
const CONFIG = platformConfig({
  auth: { methods: ["email_otp", "passkey"], passkeyRpId: "fundroom.test" },
});
const SESSION = { email: "new.op@fundroom.test", expiresAt: "2026-09-28T10:15:00.000Z" };

function handlers(over: Record<string, Handler> = {}) {
  let session = false;
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "GET /api/v1/platform/enrol/session": () =>
      session ? [200, SESSION] : apiError(404, "not_found"),
    "POST /api/v1/platform/enrol/start": () => [200, { ok: true }],
    "POST /api/v1/platform/enrol/verify": () => {
      session = true;
      return [200, SESSION];
    },
    "POST /api/v1/platform/enrol/totp": () => [
      200,
      {
        credentialId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f01",
        secretBase32: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
      },
    ],
    "POST /api/v1/platform/enrol/totp/confirm": () => {
      session = false;
      return [200, { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] }];
    },
    "POST /api/v1/platform/enrol/passkey/begin": () => [
      200,
      { challengeId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f02", options: { challenge: "x" } },
    ],
    "POST /api/v1/platform/enrol/passkey/finish": () => {
      session = false;
      return [
        200,
        {
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f03",
          label: "Passkey",
          backedUp: false,
          createdAt: SESSION.expiresAt,
          lastUsedAt: null,
        },
      ];
    },
    ...over,
  });
}

async function throughCode(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText(/Your email address/u, {}, { timeout: 5000 }),
    "new.op@fundroom.test",
  );
  await user.click(screen.getByRole("button", { name: "Email me a code" }));
  await user.type(await screen.findByLabelText(/One-time code/u), "246810");
}

describe("operator enrolment", () => {
  it("enrols an authenticator app through the enrolment endpoints and hands on the grant", async () => {
    const { calls } = handlers();
    const r = await renderApp(PAGE, CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Set up operator sign-in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await throughCode(user);
    expect(
      await screen.findByRole("heading", { name: "Add a sign-in factor" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/platform/enrol/start")?.body).toEqual({
      token: TOKEN,
      email: "new.op@fundroom.test",
    });
    expect(calls.find((c) => c.path === "/api/v1/platform/enrol/verify")?.body).toEqual({
      token: TOKEN,
      email: "new.op@fundroom.test",
      code: "246810",
    });
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: /Use an authenticator app/u }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    expect(
      await screen.findByRole("heading", { name: "You're set up" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("fundroom operator grant new.op@fundroom.test")).toBeInTheDocument();
    expect(screen.getByText("aaaa-bbbb")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/platform/enrol/totp/confirm")?.body).toEqual({
      code: "135790",
    });
    // The ordinary account endpoints would refuse this session: never used.
    expect(calls.some((c) => c.path.startsWith("/api/v1/auth/"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 30_000);

  it("registers a passkey instead", async () => {
    const { calls } = handlers();
    await renderApp(PAGE, CONFIG);
    const user = userEvent.setup();
    await throughCode(user);
    await user.click(
      await screen.findByRole("button", { name: /Add a passkey/u }, { timeout: 5000 }),
    );
    expect(
      await screen.findByRole("heading", { name: "You're set up" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/platform/enrol/passkey/finish")?.body).toEqual({
      challengeId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6f02",
      response: { id: "cred", type: "public-key" },
    });
    expect(calls.some((c) => c.path.startsWith("/api/v1/auth/"))).toBe(false);
  }, 30_000);

  it("says one thing for any wrong part, and hands on the grant when a factor exists", async () => {
    let answer = () => apiError(400, "invalid_code");
    handlers({ "POST /api/v1/platform/enrol/verify": () => answer() });
    const r = await renderApp(PAGE, CONFIG);
    const user = userEvent.setup();
    await throughCode(user);
    expect(await screen.findByText(/That code did not work/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    answer = () => apiError(409, "conflict", { details: { reason: "already_enrolled" } });
    await user.type(screen.getByLabelText(/One-time code/u), "111111");
    expect(
      await screen.findByRole("heading", { name: "Nothing to set up" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("fundroom operator grant new.op@fundroom.test")).toBeInTheDocument();
  }, 30_000);

  it("resumes an open enrolment session, and starts over when it has ended", async () => {
    // Open when the page loads, gone (15 min) by the time the button is pressed.
    let open = true;
    handlers({
      "GET /api/v1/platform/enrol/session": () =>
        open ? [200, SESSION] : apiError(404, "not_found"),
      "POST /api/v1/platform/enrol/totp": () => {
        open = false;
        return apiError(404, "not_found");
      },
    });
    await renderApp(PAGE, CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Add a sign-in factor" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Use an authenticator app/u }));
    expect(
      await screen.findByRole("heading", { name: "Set up operator sign-in" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 30_000);

  it("says the link is incomplete without a token", async () => {
    handlers();
    const r = await renderApp("/platform/enrol", CONFIG);
    expect(await screen.findByText("This link is incomplete", {}, { timeout: 5000 })).toBeVisible();
    await expectNoA11yViolations(r.container);
    await waitFor(() => expect(screen.queryByLabelText(/Your email address/u)).toBeNull());
  }, 30_000);
});
