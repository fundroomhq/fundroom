import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { centralAuthNavigation } from "../lib/central-auth.js";
import { me, session, testConfig } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * A-5 fix round 4 (H1): a passkey added on the signup Done screen leaves the canonical session at
 * level 2 before the founder continues — a central-auth handoff copies the level. E-UP-18 D2: a
 * key that verified the user raises the session as it registers (`authLevel: 2` on the
 * response); one that did not is confirmed at once, as before. jsdom has no WebAuthn: the
 * ceremonies are stubbed.
 */
const webauthn = vi.hoisted(() => ({
  /** How many `get()` ceremonies are rejected (cancelled) before one goes through. */
  cancels: 0,
  /** When set, `get()` waits for it (the browser's prompt still open). */
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../lib/webauthn.js", async (importActual) => ({
  ...(await importActual<typeof import("../lib/webauthn.js")>()),
  webAuthnSupported: () => Promise.resolve(true),
  register: () => Promise.resolve({ id: "cred" }),
  authenticate: async () => {
    if (webauthn.gate !== undefined) await webauthn.gate;
    if (webauthn.cancels > 0) {
      webauthn.cancels -= 1;
      // What a browser rejects `get()` with (a DOMException, an Error there; not so in jsdom).
      throw Object.assign(new Error("The operation is not allowed."), { name: "NotAllowedError" });
    }
    return { id: "cred" };
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  webauthn.cancels = 0;
  webauthn.gate = undefined;
});

const SIGNUP = testConfig({
  workspace: null,
  tenancy: "multi",
  canonicalOrigin: "https://fundroom.test",
  signup: true,
  signupTerms: { version: 1, url: null },
});

const TOTP = {
  credentialId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5999",
  secretBase32: "JBSWY3DPEHPK3PXP",
  otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
};

function handlers(
  stepUpLevel: 1 | 2,
  opts: { confirmRefused?: boolean; enrolNeedsProof?: boolean; registerLevel?: 1 | 2 } = {},
) {
  let signedIn = false;
  let proof = false;
  let level: 1 | 2 = 1;
  let enrolled = false;
  const api: Record<string, Handler> = {
    "GET /api/v1/me": () =>
      signedIn
        ? [
            200,
            me({
              session: session({
                population: "staff",
                authLevel: level,
                user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null },
              }),
            }),
          ]
        : apiError(401, "unauthenticated"),
    "GET /api/v1/signup/slug": ({ url }) => [
      200,
      { slug: url.searchParams.get("slug") ?? "", available: true },
    ],
    "POST /api/v1/signup/start": () => [200, { ok: true }],
    "POST /api/v1/signup/verify": () => {
      signedIn = true;
      return [201, { workspaceUrl: "https://acme-bohm.fundroom.test/setup" }];
    },
    "POST /api/v1/auth/passkeys/register/begin": () => [200, { options: {} }],
    "POST /api/v1/auth/passkeys/register/finish": () => {
      enrolled = true;
      // E-UP-18 D2: the session's level after the call — 2 when the key verified the user.
      if (opts.registerLevel === 2) level = 2;
      return [200, { id: "cred", authLevel: level }];
    },
    "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
    "POST /api/v1/auth/passkeys/step-up/finish": () => {
      level = stepUpLevel;
      proof = true;
      return [200, { ok: true }];
    },
    // The server's rule: an enrolled level-1 session may add an app only after a presence proof.
    "POST /api/v1/auth/totp/enrol": () =>
      opts.enrolNeedsProof === true && enrolled && !proof
        ? apiError(403, "step_up_required", { reason: "level" })
        : [200, TOTP],
    "POST /api/v1/auth/totp/enrol/confirm": () => {
      if (opts.confirmRefused === true)
        return apiError(403, "step_up_required", { reason: "level" });
      level = 2;
      return [200, { recoveryCodes: ["aaaa-bbbb"] }];
    },
  };
  return installMockApi(api);
}

async function toDone() {
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText(/Your work email/u, {}, { timeout: 5000 }),
    "ada@example.com",
  );
  await user.type(screen.getByLabelText(/Company name/u), "Acme Böhm");
  await user.type(screen.getByLabelText(/Registered legal name/u), "Acme Böhm GmbH");
  await user.selectOptions(screen.getByLabelText(/Country of registration/u), "DE");
  await user.click(screen.getByLabelText(/I accept the terms of service/u));
  await screen.findByText("That address is available.", {}, { timeout: 5000 });
  await user.click(screen.getByRole("button", { name: "Email me a code" }));
  await user.type(await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }), "123456");
  await user.click(await screen.findByRole("button", { name: "Add passkey" }, { timeout: 5000 }));
  return user;
}

describe("signup done: passkey", () => {
  // E-UP-18 D2.
  it("asks for no second ceremony when registering raised the session to level 2", async () => {
    const { calls } = handlers(2, { registerLevel: 2 });
    await renderApp("/signup", SIGNUP);
    await toDone();
    expect(
      await screen.findByText(/Passkey added\. You can sign in/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/If you continue anyway/u)).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/auth/passkeys/login/begin")).toBe(false);
    expect(calls.some((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toBe(false);
  }, 40_000);

  it("still confirms at once, and offers the way on, when registering left level 1", async () => {
    const { calls } = handlers(1, { registerLevel: 1 });
    await renderApp("/signup", SIGNUP);
    await toDone();
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Confirm with the passkey" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Set up an authenticator app" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Continue anyway" })).toBeInTheDocument();
  }, 40_000);

  it("confirms a new passkey at once, so the session leaves at level 2", async () => {
    const { calls } = handlers(2);
    await renderApp("/signup", SIGNUP);
    await toDone();
    expect(
      await screen.findByText(/Passkey added\. You can sign in/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toBe(true);
  }, 40_000);

  it("says so when the passkey did not verify, and offers an authenticator app", async () => {
    handlers(1);
    await renderApp("/signup", SIGNUP);
    await toDone();
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Set up an authenticator app" }),
      ).toBeInTheDocument(),
    );
  }, 40_000);

  // Round 5 L3: Safari wants a click of its own for the second ceremony, so the automatic
  // confirmation is often rejected. Nothing was proved, so no app (the server would refuse one).
  it("asks for a click to confirm after a cancelled confirmation, and offers no app", async () => {
    webauthn.cancels = 1;
    const { calls } = handlers(2, { enrolNeedsProof: true });
    await renderApp("/signup", SIGNUP);
    const user = await toDone();
    const button = await screen.findByRole(
      "button",
      { name: "Confirm with the passkey" },
      { timeout: 5000 },
    );
    expect(screen.getByText(/Confirm it's you with it once to finish/u)).toBeInTheDocument();
    expect(screen.queryByText(/did not verify you/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
    await user.click(button);
    expect(
      await screen.findByText(/Passkey added\. You can sign in/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/auth/totp/enrol")).toBe(false);
  }, 40_000);

  // Round 5 M1: nothing on the Done screen leads to `/signup` (an empty form, the address lost).
  it("stays on the Done screen through Back and a refused app confirmation", async () => {
    const { calls } = handlers(1, { confirmRefused: true });
    const r = await renderApp("/signup", SIGNUP);
    const user = await toDone();
    await user.click(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    );
    await screen.findByLabelText(/Code from the app/u, {}, { timeout: 5000 });
    // Back returns to the view it came from, not to an "already has a factor" view.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText(/did not verify you/u)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Confirm it's you" })).toBeNull();
    // A refused confirmation of the app is confirmed here, with the passkey, not on another page.
    await user.click(screen.getByRole("button", { name: "Set up an authenticator app" }));
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    const confirm = await screen.findByRole("button", { name: "Confirm it's you" });
    expect(screen.queryByRole("link", { name: "Confirm it's you" })).toBeNull();
    await user.click(confirm);
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toHaveLength(
        2,
      ),
    );
    // Round 6 L-b: the form says how the confirmation went.
    expect(
      await screen.findByText(/Enter the current code from the app again/u),
    ).toBeInTheDocument();
    expect(r.router.state.location.pathname).toBe("/signup");
    expect(screen.getByText("acme-bohm.fundroom.test")).toBeInTheDocument();
    expect(document.querySelector('a[href*="/auth/step-up"]')).toBeNull();
  }, 40_000);

  // Round 5 M2(b): the workspace would only ask again, so going on is not an equal choice.
  it("makes continuing a secondary choice while the passkey left the session at level 1", async () => {
    handlers(1);
    await renderApp("/signup", SIGNUP);
    const user = await toDone();
    await screen.findByText(/did not verify you/u, {}, { timeout: 5000 });
    expect(screen.getByText(/If you continue anyway/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue anyway" })).toHaveAttribute(
      "href",
      "https://acme-bohm.fundroom.test/setup",
    );
    expect(screen.queryByRole("link", { name: "Continue" })).toBeNull();
    // An app makes the session level 2: continuing is the way on again.
    await user.click(screen.getByRole("button", { name: "Set up an authenticator app" }));
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/If you continue anyway/u)).toBeNull();
  }, 40_000);

  // Round 6 L-a: the "continue anyway" choice is for the settled level-1 view only.
  it("keeps Continue as it is while the confirmation runs and under the app form", async () => {
    let release: () => void = () => {};
    webauthn.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlers(1);
    await renderApp("/signup", SIGNUP);
    const user = await toDone();
    expect(
      await screen.findByText(/Confirm with your new passkey/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/If you continue anyway/u)).toBeNull();
    webauthn.gate = undefined;
    release();
    await screen.findByText(/did not verify you/u, {}, { timeout: 5000 });
    expect(screen.getByRole("link", { name: "Continue anyway" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up an authenticator app" }));
    await screen.findByLabelText(/Code from the app/u);
    expect(screen.getByRole("link", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/If you continue anyway/u)).toBeNull();
  }, 40_000);

  // Round 6 L-b: the app form's "Confirm it's you" stays, busy, until the confirmation is done.
  it("shows the app form's confirmation in progress", async () => {
    handlers(1, { confirmRefused: true });
    await renderApp("/signup", SIGNUP);
    const user = await toDone();
    await user.click(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    );
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    let release: () => void = () => {};
    webauthn.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    const busy = await screen.findByRole("button", { name: /Confirm it's you/u });
    await waitFor(() => expect(busy).toBeDisabled());
    webauthn.gate = undefined;
    release();
    expect(
      await screen.findByText(/Enter the current code from the app again/u),
    ).toBeInTheDocument();
    // The stale code is cleared for the new one.
    expect(screen.getByLabelText(/Code from the app/u)).toHaveValue("");
  }, 40_000);

  // Round 6 L-c: a completed level-1 confirmation still counts after a cancelled retry.
  it("keeps offering the app after a cancelled retry of a confirmation that did not verify", async () => {
    handlers(1, { enrolNeedsProof: true });
    await renderApp("/signup", SIGNUP);
    const user = await toDone();
    await screen.findByText(/did not verify you/u, {}, { timeout: 5000 });
    webauthn.cancels = 1;
    await user.click(screen.getByRole("button", { name: "Confirm with the passkey" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm with the passkey" })).toBeEnabled(),
    );
    await user.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
    expect(await screen.findByLabelText(/Code from the app/u)).toBeInTheDocument();
  }, 40_000);
});

// E-UP-18: the canonical host's level step-up, for an account with no second factor yet (a
// central sign-in that asked for level 2). A passkey that verified the user is enough.
describe("level step-up with no factor yet: passkey", () => {
  it("adds a passkey that raises the session and goes on, with no second ceremony", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    const authorize = "/auth/central/authorize?req=abc123";
    let level: 1 | 2 = 1;
    let enrolled = false;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            authLevel: level,
            user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null },
          }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
      "POST /api/v1/auth/passkeys/register/begin": () => [200, { challengeId: "c0", options: {} }],
      "POST /api/v1/auth/passkeys/register/finish": () => {
        enrolled = true;
        level = 2;
        return [200, { id: "cred", authLevel: 2 }];
      },
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add passkey" }, { timeout: 5000 }));
    expect(
      await screen.findByText(/Passkey added\. You can sign in/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // The step-up screen's own tabs did not take over once the account had a factor.
    expect(screen.queryByRole("tab", { name: /passkey/iu })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorize));
    expect(calls.some((c) => c.path === "/api/v1/auth/passkeys/login/begin")).toBe(false);
  }, 40_000);
});

// Fix round 4: the in-place passkey that did not verify — the view loads, then says so; focus
// follows it there once its heading exists.
describe("level step-up with no factor yet: a passkey that does not verify", () => {
  it("moves focus to the view once it has settled", async () => {
    let enrolled = false;
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            authLevel: 1,
            user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null },
          }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
      "POST /api/v1/auth/passkeys/register/begin": () => [200, { challengeId: "c0", options: {} }],
      "POST /api/v1/auth/passkeys/register/finish": () => {
        enrolled = true;
        return [200, { id: "cred", authLevel: 1 }];
      },
      "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
      "POST /api/v1/auth/passkeys/step-up/finish": () => [200, { ok: true }],
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent("/auth/central/authorize?req=a")}`,
      testConfig({ workspace: null }),
    );
    // The confirmation that follows the registration waits: the view is loading meanwhile.
    let release: () => void = () => {};
    webauthn.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Add passkey" }, { timeout: 5000 }));
    expect(
      await screen.findByText(/Confirm with your new passkey/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Secure your account/u })).toBeNull();
    webauthn.gate = undefined;
    release();
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: /Secure your account/u }),
      ),
    );
  }, 40_000);
});

// E-UP-18 review M1: the account's only factor is a key that does not verify the user. Its
// confirmation completes at level 1; going back would only be sent here again, round and round.
describe("level step-up with a key that does not verify the user", () => {
  it("stays, says so, and offers an authenticator app instead of going round", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    const authorize = "/auth/central/authorize?req=abc123";
    let level: 1 | 2 = 1;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            authLevel: level,
            user: { displayName: "Ada", mfaEnrolled: true, locale: null },
          }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
      "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
      // Completed, user not verified: the session stays at level 1.
      "POST /api/v1/auth/passkeys/step-up/finish": () => [200, { ok: true }],
      // The key is the account's only factor: no authenticator app yet.
      "GET /api/v1/auth/totp": () => [
        200,
        { enrolled: false, pending: false, recoveryCodesLeft: 0 },
      ],
      "POST /api/v1/auth/totp/enrol": () => [200, TOTP],
      "POST /api/v1/auth/totp/enrol/confirm": () => {
        level = 2;
        return [200, { recoveryCodes: ["aaaa-bbbb"] }];
      },
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }),
    );
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toHaveLength(1);
    // Fix round 4: announced, and focus moves to the view that offers the app.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="step-up-notice"]')?.textContent).toBe(
        "That key did not confirm it's you.",
      ),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: /Secure your account/u }),
      ),
    );
    await user.click(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    );
    // Fix round 3: no app and no recovery codes — those tabs would lead nowhere.
    expect(screen.queryByRole("tab", { name: /authenticator|recovery/iu })).toBeNull();
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    // Focus moves to the view that says the app was added (and shows the codes).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: /Secure your account/u }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorize));
  }, 40_000);
});

// Fix round 2: the same key on an account that also has an authenticator app. The app is how it
// finishes — its tab stays — and adding a second one is not offered (the server would refuse).
describe("level step-up with a key that does not verify the user, and an app", () => {
  it("keeps the authenticator tab, which finishes the step-up", async () => {
    const assign = vi.spyOn(centralAuthNavigation, "assign").mockImplementation(() => {});
    const authorize = "/auth/central/authorize?req=abc123";
    let level: 1 | 2 = 1;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            authLevel: level,
            user: { displayName: "Ada", mfaEnrolled: true, locale: null },
          }),
        }),
      ],
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
      "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
      "POST /api/v1/auth/passkeys/step-up/finish": () => [200, { ok: true }],
      "GET /api/v1/auth/totp": () => [
        200,
        { enrolled: true, pending: false, recoveryCodesLeft: 8 },
      ],
      "POST /api/v1/auth/totp/verify": () => {
        level = 2;
        return [200, { ok: true }];
      },
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    const user = userEvent.setup();
    const passkeyButton = await screen.findByRole(
      "button",
      { name: "Use a passkey" },
      { timeout: 5000 },
    );
    // The live region is there, empty, before the warning: filling it is what gets announced.
    const notice = document.querySelector('[data-slot="step-up-notice"]');
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice?.textContent).toBe("");
    await user.click(passkeyButton);
    await waitFor(() =>
      expect(notice?.textContent).toMatch(/Use your authenticator app or a recovery code/u),
    );
    expect(document.querySelector('[data-slot="step-up-notice"]')).toBe(notice);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/auth/totp")).toBe(true));
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /authenticator/iu }));
    await user.type(await screen.findByLabelText(/Authenticator code/u), "246810");
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorize));
  }, 40_000);
});

// Fix round 3: what the warning says follows what this session can do next.
describe("level step-up: a key that did not verify, by session", () => {
  const authorize = "/auth/central/authorize?req=abc123";
  const NO_SSO = { available: false, name: null, protocol: null, enforced: false };
  function keyApi(over: Record<string, Handler> = {}, sessionExtra: Record<string, unknown> = {}) {
    return installMockApi({
      "GET /api/v1/me": () => [
        200,
        {
          ...me(),
          session: {
            ...session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }),
            ...sessionExtra,
          },
        },
      ],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
      "POST /api/v1/auth/passkeys/step-up/finish": () => [200, { ok: true }],
      ...over,
    });
  }
  async function useKey(config = testConfig({ workspace: null })) {
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      config,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }));
    return r;
  }

  it("tells a single-sign-on session what is left, not to add an app", async () => {
    keyApi({}, { sso: { connectionId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a" } });
    await useKey();
    expect(
      await screen.findByText(/ask your workspace administrator/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Add an authenticator app/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 40_000);

  it("points a central-bound session to Continue on the main sign-in", async () => {
    keyApi({}, { boundWorkspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a" });
    await useKey(
      testConfig({ workspace: null, centralAuth: { startPath: "/auth/central/start" } }),
    );
    expect(
      await screen.findByText(/Choose Continue to confirm it's you on/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/code sent by email/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 40_000);

  it("points a frame to the new window", async () => {
    keyApi();
    await useKey(
      testConfig({ tree: "embed", embedOrigins: ["https://acme.com"], workspace: null }),
    );
    expect(
      await screen.findByText(/Continue in a new window, where/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 40_000);

  it("says when the app status cannot be read, and does not guess", async () => {
    keyApi({ "GET /api/v1/auth/totp": () => apiError(500, "internal") });
    await useKey();
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/Confirm another way below/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 40_000);

  it("reads the app status afresh, whatever is cached", async () => {
    keyApi({
      "GET /api/v1/auth/totp": () => [
        200,
        { enrolled: false, pending: false, recoveryCodesLeft: 0 },
      ],
    });
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    // Cached from before the app was removed elsewhere.
    r.queryClient.setQueryData(["auth", "totp"], {
      enrolled: true,
      pending: false,
      recoveryCodesLeft: 8,
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }));
    expect(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 40_000);

  it("concludes nothing when the session cannot be read after the key", async () => {
    let failReads = false;
    let readGate: Promise<void> | undefined;
    const { calls } = keyApi({
      "GET /api/v1/me": async () => {
        if (readGate !== undefined) await readGate;
        return failReads
          ? new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : new Response(
              JSON.stringify(
                me({
                  session: session({
                    user: { displayName: "Ada", mfaEnrolled: true, locale: null },
                  }),
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    const button = await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 });
    failReads = true;
    const user = userEvent.setup();
    await user.click(button);
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/did not verify you/u)).toBeNull();
    // Fix round 4: another go with the key clears the old error as it starts.
    let release: () => void = () => {};
    webauthn.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(screen.getByRole("button", { name: "Use a passkey" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    // Fix round 5: nor is the stale error of the failed read shown while the key is held.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    webauthn.gate = undefined;
    release();
    const retry = await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    // Fix round 5: "Try again" stays (busy, keeping focus) while it reads, and a failed read
    // leaves one alert, not a second one for the same error.
    let releaseRead: () => void = () => {};
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await user.click(retry);
    expect(retry.isConnected).toBe(true);
    await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
    expect(document.activeElement).toBe(retry);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    readGate = undefined;
    releaseRead();
    await waitFor(() => expect(retry).not.toHaveAttribute("aria-busy"));
    expect(retry.isConnected).toBe(true);
    expect(screen.queryAllByRole("alert")).toHaveLength(1);
    // …and a way on: read the session again (only), no further ceremony.
    failReads = false;
    await user.click(retry);
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/v1/auth/passkeys/step-up/finish")).toHaveLength(2);
  }, 40_000);

  it("says when a refresh of the account fails, keeping the choices it has", async () => {
    let failReads = false;
    keyApi({
      "GET /api/v1/me": () =>
        failReads
          ? apiError(500, "internal")
          : [
              200,
              me({
                session: session({
                  user: { displayName: "Ada", mfaEnrolled: true, locale: null },
                }),
              }),
            ],
    });
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    expect(
      await screen.findByRole("tab", { name: /authenticator/iu }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    failReads = true;
    await r.queryClient.refetchQueries({ queryKey: ["me"] });
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /authenticator/iu })).toBeInTheDocument();
  }, 40_000);

  it("decides nothing from a cached app status while it is read again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = keyApi({
      "GET /api/v1/auth/totp": async () => {
        await gate;
        return new Response(
          JSON.stringify({ enrolled: true, pending: false, recoveryCodesLeft: 8 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    // Cached: no app and no codes, from before an app was added elsewhere.
    r.queryClient.setQueryData(["auth", "totp"], {
      enrolled: false,
      pending: false,
      recoveryCodesLeft: 0,
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/auth/totp")).toBe(true));
    // While the read is out, the stale answer neither offers an app nor hides the app's tab,
    // and no warning is guessed.
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
    expect(screen.getByRole("tab", { name: /authenticator/iu })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="step-up-notice"]')?.textContent).toBe("");
    release();
    expect(
      await screen.findByText(
        /Use your authenticator app or a recovery code/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 40_000);
});

// Fix round 5: focus, the app offer and the central sentence, around the key's outcome.
describe("level step-up: after the key, round 5", () => {
  const authorize = "/auth/central/authorize?req=abc123";
  const NO_SSO = { available: false, name: null, protocol: null, enforced: false };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  function api(over: Record<string, Handler> = {}, sessionExtra: Record<string, unknown> = {}) {
    return installMockApi({
      "GET /api/v1/me": () => [
        200,
        {
          ...me(),
          session: {
            ...session({ user: { displayName: "Ada", mfaEnrolled: true, locale: null } }),
            ...sessionExtra,
          },
        },
      ],
      "GET /api/v1/auth/sso": () => [200, NO_SSO],
      "POST /api/v1/auth/passkeys/login/begin": () => [200, { challengeId: "c1", options: {} }],
      "POST /api/v1/auth/passkeys/step-up/finish": () => [200, { ok: true }],
      ...over,
    });
  }
  const NO_APP = { enrolled: false, pending: false, recoveryCodesLeft: 3 };

  it("leaves focus in a field someone is typing in when the app is offered", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api({
      "GET /api/v1/auth/totp": async () => {
        await gate;
        return json(NO_APP);
      },
    });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }),
    );
    // Recovery codes are left: that tab stays while the status is read, and is being typed in.
    await user.click(await screen.findByRole("tab", { name: /recovery/iu }, { timeout: 5000 }));
    const field = await screen.findByRole("textbox", { name: "Recovery code" });
    await user.click(field);
    await user.type(field, "abcd");
    release();
    expect(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(field);
  }, 40_000);

  it("keeps the app offer up while the status is read again", async () => {
    let gate: Promise<void> | undefined;
    api({
      "GET /api/v1/auth/totp": async () => {
        if (gate !== undefined) await gate;
        return json(NO_APP);
      },
    });
    const r = await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }));
    const offer = await screen.findByRole(
      "button",
      { name: "Set up an authenticator app" },
      { timeout: 5000 },
    );
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A reconnect refetches it.
    void r.queryClient.refetchQueries({ queryKey: ["auth", "totp"] });
    await waitFor(() =>
      expect(r.queryClient.getQueryState(["auth", "totp"])?.fetchStatus).toBe("fetching"),
    );
    expect(screen.getByRole("button", { name: "Set up an authenticator app" })).toBe(offer);
    release();
  }, 40_000);

  it("says Continue only where Continue is offered", async () => {
    api({}, { boundWorkspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a" });
    await renderApp(
      `/auth/step-up?reason=level&next=${encodeURIComponent(authorize)}`,
      testConfig({ workspace: null }),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Use a passkey" }, { timeout: 5000 }));
    expect(
      await screen.findByText(/Confirm another way below/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Choose Continue/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  }, 40_000);
});
