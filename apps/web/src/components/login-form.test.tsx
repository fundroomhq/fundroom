import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { testConfig } from "../test/fixtures.js";
import { apiError, installMockApi, json } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The conditional-UI (passkey autofill) request the sign-in form starts on mount must never eat
 * the visitor's first click on "Email me a code" (E2.2 recorded ~1 in 3 doing nothing; fixed in
 * E2.10). The WebAuthn wrapper is replaced with a controllable fake: `authenticate(…, true)`
 * hangs like a real conditional request until `cancelPending` aborts it, and `cancelPending`
 * takes a moment, the way the real one does (it lazily imports the library first).
 */
const log: string[] = [];
let cancelFails = false;
let rejectCeremony: ((e: Error) => void) | undefined;

vi.mock("../lib/webauthn.js", () => ({
  webAuthnSupported: async () => true,
  webAuthnAutofillSupported: async () => true,
  authenticate: (_options: unknown, autofill: boolean) => {
    log.push(`ceremony:${autofill ? "autofill" : "modal"}`);
    return new Promise((_resolve, reject) => {
      rejectCeremony = reject;
    });
  },
  cancelPending: async () => {
    await new Promise((r) => setTimeout(r, 20));
    if (cancelFails) throw new TypeError("Failed to fetch dynamically imported module");
    log.push("cancel");
    rejectCeremony?.(Object.assign(new Error("aborted"), { name: "AbortError" }));
  },
  isWebAuthnCancelled: (error: unknown) =>
    error instanceof Error && (error.name === "AbortError" || error.name === "NotAllowedError"),
}));

const config = testConfig({ auth: { methods: ["email_otp", "passkey"], passkeyRpId: "x" } });

function api(options: { begin?: Promise<void> } = {}) {
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "POST /api/v1/auth/passkeys/login/begin": async () => {
      await options.begin;
      log.push("begin");
      return json(200, { challengeId: "c1", options: { challenge: "x" } });
    },
    "POST /api/v1/auth/otp/start": () => {
      log.push("otp/start");
      return [200, { status: "sent", emailHint: "a***@b.co", ttlMinutes: 10 }];
    },
  });
}

beforeEach(() => {
  log.length = 0;
  cancelFails = false;
  rejectCeremony = undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("sign-in form vs. the conditional passkey request", () => {
  it("aborts the pending autofill ceremony before the code request goes out", async () => {
    api();
    const r = await renderApp("/login", config);
    const user = userEvent.setup();
    await waitFor(() => expect(log).toContain("ceremony:autofill"));
    await user.type(screen.getByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    expect(log).toEqual(["begin", "ceremony:autofill", "cancel", "otp/start"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not open the ceremony when /begin answers after the visitor chose a code", async () => {
    let release = () => {};
    const begin = new Promise<void>((r) => {
      release = r;
    });
    api({ begin });
    const r = await renderApp("/login", config);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(log).toContain("otp/start"));
    release();
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).not.toContain("ceremony:autofill");
  });

  it("still sends the code when aborting fails (library chunk did not load)", async () => {
    api();
    cancelFails = true;
    const r = await renderApp("/login", config);
    const user = userEvent.setup();
    await waitFor(() => expect(log).toContain("ceremony:autofill"));
    await user.type(screen.getByLabelText(/Email address/u), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /Email me a code/u }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login/verify"));
    expect(log).toContain("otp/start");
    await expectNoA11yViolations(r.container);
  });
});
