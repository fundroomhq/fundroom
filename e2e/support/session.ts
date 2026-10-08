import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { codeFrom, freshTotpCode, waitForMail } from "../fixtures/stack.js";
import { loadStackState, type StackState, saveStackState } from "./state.js";

/*
 * Signing in through the real UI, the way `00-setup` does it: email → Mailpit → code. Shared by
 * the specs that come after setup.
 */
export const BASE_URL = process.env["E2E_BASE_URL"] ?? "http://localhost:3000";

/**
 * Fill the address and get a code sent, retrying the click if nothing goes out: the sign-in form
 * starts a conditional-UI WebAuthn request on mount that occasionally swallows the first click
 * (see `20-embed-hosts.test.ts` `requestCode` for the long version).
 */
export async function requestCode(page: Page, email: string): Promise<void> {
  await page.getByLabel(/Email address/u).fill(email);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = page
      .waitForResponse((r) => r.url().includes("/auth/otp/start"), { timeout: 5_000 })
      .catch(() => undefined);
    await page.getByRole("button", { name: /Email me a code/u }).click();
    const response = await started;
    if (response !== undefined) {
      expect(response.status(), await response.text()).toBe(200);
      return;
    }
  }
  throw new Error("the sign-in form never sent POST /auth/otp/start");
}

/** Email-code sign-in; lands wherever the app sends a fresh session (portal or admin). */
export async function signInWithCode(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  const before = new Date(Date.now() - 1000);
  await requestCode(page, email);
  const mail = await waitForMail(email, { subject: /code/iu, after: before });
  await page.getByRole("textbox").first().fill(codeFrom(mail.text));
  await expect(page).not.toHaveURL(/\/login/u, { timeout: 20_000 });
}

/**
 * A member's first visit to a workspace with an offering shows the acceptance gate (privacy
 * notice, ADR-0037). Agree once so the pages under test are the pages, not the gate.
 */
export async function passAcceptanceGate(page: Page): Promise<void> {
  const gate = page.getByRole("heading", { name: "Before you go in" });
  const home = page.getByRole("heading", { name: /^Welcome/u });
  await expect(gate.or(home)).toBeVisible({ timeout: 20_000 });
  if (await gate.isVisible()) {
    await page.getByRole("checkbox", { name: /I have read and agree/u }).click();
    await page.getByRole("button", { name: "Agree and continue" }).click();
    await expect(home).toBeVisible({ timeout: 20_000 });
  }
}

function stackState(): StackState {
  const state = loadStackState();
  if (!state) {
    throw new Error(
      "no owner TOTP secret: run 00-setup first on a fresh stack (stack:down && stack:up), it writes e2e/.state/stack.json",
    );
  }
  return state;
}

/** The owner's second factor through the step-up screen (an email code is only level 1). */
export async function stepUpOwner(page: Page, returnTo = "/admin"): Promise<void> {
  const state = stackState();
  await page.goto(`/auth/step-up?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("tab", { name: "Authenticator" }).click();
  const code = await freshTotpCode(state.totpSecret, state.lastCode);
  saveStackState({ ...state, lastCode: code });
  await page.getByRole("textbox").first().fill(code);
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[/?]/gu, "\\$&")}$`, "u"));
}

/** A fresh step-up over the API, for step-up routes called from `request` (10-minute window). */
export async function stepUpApi(request: APIRequestContext): Promise<void> {
  const state = stackState();
  const code = await freshTotpCode(state.totpSecret, state.lastCode);
  saveStackState({ ...state, lastCode: code });
  await apiOk(request, "POST", "/api/v1/auth/totp/verify", { code });
}

/**
 * JSON API call on a browser context's cookie jar (`context.request` shares the context's
 * cookies). Unsafe methods carry the `Origin` CSRF wants.
 */
export async function apiOk<T = unknown>(
  request: APIRequestContext,
  method: string,
  path: string,
  body?: unknown,
  expected: readonly number[] = [200, 201, 202, 204],
): Promise<T> {
  const res = await request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { origin: BASE_URL }),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await res.text();
  if (!expected.includes(res.status())) {
    throw new Error(`${method} ${path} -> ${res.status()}: ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
