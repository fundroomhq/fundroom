import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, login, me } from "../test/fixtures.js";
import { apiError, installMockApi, pendingAcceptance } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/s/<token>` — the share-link landing (E2.3, contract C4/S6.2/S7).
 *
 * What is actually being asserted, in order of how badly it would hurt to lose it:
 *
 *  - the screen **never links to `/login`**, because a generic OTP start that accepted a link
 *    would make the passcode bypassable;
 *  - the token leaves the address bar as soon as it resolves, so it is not in `document.referrer`
 *    for every later navigation;
 *  - the resolve response's absence of a resource name is respected — nothing gated is shown;
 *  - a wrong passcode is answered beside the passcode field, and an unresolvable token gets the
 *    one indistinguishable "this link does not work" screen.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const TOKEN = "8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA";

/** jsdom starts at `/`; the real browser starts at the link, which is the point of S7. */
function standOnTheLink(): void {
  window.history.replaceState(null, "", `/s/${TOKEN}`);
}

const resolution = (over: Record<string, unknown> = {}) => ({
  valid: true,
  requiresPasscode: false,
  workspaceName: "Acme",
  ...over,
});

describe("share-link landing", () => {
  it("resolves, strips the token from the URL, and never offers /login", async () => {
    standOnTheLink();
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/links/{token}": () => [200, resolution()],
    });
    const r = await renderApp(`/s/${TOKEN}`);
    expect(
      await screen.findByRole("heading", { name: "You have been sent a link" }),
    ).toBeInTheDocument();

    // S7: the secret is out of the address bar the moment it has been spent.
    await waitFor(() => expect(window.location.pathname).toBe("/s"));
    expect(window.location.href).not.toContain(TOKEN);

    // C4: the whole ceremony is here. A link to /login would hand the flow to an endpoint that
    // has never seen the passcode.
    expect(screen.queryByRole("link", { name: /sign in/iu })).toBeNull();
    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href")).not.toContain("/login");
    }
    // D7: the resolve response carries no resource name, and neither does the screen.
    expect(screen.queryByText(/data room|folder|document/iu)).toBeNull();
    expect(screen.queryByLabelText(/^Passcode/u)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("runs email → passcode → OTP → portal without leaving the route", async () => {
    standOnTheLink();
    let signedIn = false;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/links/{token}": () => [200, resolution({ requiresPasscode: true })],
      "POST /api/v1/links/{token}/start": ({ body }) => {
        const sent = body as { email: string; passcode?: string };
        if (sent.passcode !== "hunter2") {
          return apiError(403, "forbidden", { reason: "passcode_wrong" });
        }
        return [200, { status: "sent", emailHint: "a***@acme.com", ttlMinutes: 10 }];
      },
      "POST /api/v1/links/{token}/verify": () => {
        signedIn = true;
        return [200, login()];
      },
      "GET /api/v1/compliance/gates": () => [200, { pending: [] }],
    });
    const r = await renderApp(`/s/${TOKEN}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "You have been sent a link" });
    await user.type(screen.getByLabelText(/Email address/u), "ada@acme.com");
    await user.type(screen.getByLabelText(/^Passcode/u), "wrong1");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));

    // The refusal belongs beside the field that caused it, not in a toast.
    expect(await screen.findByText("That passcode is not right.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Passcode/u)).toHaveAttribute("aria-invalid", "true");
    await expectNoA11yViolations(r.container);

    await user.clear(screen.getByLabelText(/^Passcode/u));
    await user.type(screen.getByLabelText(/^Passcode/u), "hunter2");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByRole("heading", { name: /Enter your code/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/One-time code/u), "123456");
    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
    // The token is the only key the ceremony ever used; the link id never appears in a URL.
    for (const call of calls) expect(call.path).not.toMatch(/\/auth\/otp\//u);
    expect(calls.find((c) => c.path === `/api/v1/links/${TOKEN}/verify`)?.body).toEqual({
      email: "ada@acme.com",
      code: "123456",
      rememberDevice: false,
    });
  }, 20_000);

  it("runs the click-wrap before the portal and offers the certificate", async () => {
    standOnTheLink();
    let signedIn = false;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/links/{token}": () => [200, resolution()],
      "POST /api/v1/links/{token}/start": () => [
        200,
        { status: "sent", emailHint: "a***@acme.com", ttlMinutes: 10 },
      ],
      "POST /api/v1/links/{token}/verify": () => {
        signedIn = true;
        return [200, login()];
      },
      "GET /api/v1/compliance/gates": () => [
        200,
        { pending: [pendingAcceptance({ slug: "nda", title: "Mutual NDA", kind: "nda" })] },
      ],
      "POST /api/v1/compliance/acceptances": () => [
        200,
        { stamp: "nda:v1", acceptedAt: "2026-09-12T10:00:00.000Z", recorded: true, pending: [] },
      ],
    });
    const r = await renderApp(`/s/${TOKEN}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "You have been sent a link" });
    await user.type(screen.getByLabelText(/Email address/u), "ada@acme.com");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await user.type(await screen.findByLabelText(/One-time code/u), "123456");

    expect(
      await screen.findByRole(
        "heading",
        { name: "One thing to agree to first" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    // A pre-ticked box is not a click-wrap, and the submit stays shut until the person ticks it.
    const box = screen.getByRole("checkbox", { name: /I have read and agree to Mutual NDA/u });
    expect(box).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "Agree and continue" });
    expect(submit).toBeDisabled();
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/Type your full name/u), "Ada Lovelace");
    await user.click(box);
    await user.click(submit);
    expect(await screen.findByRole("heading", { name: "You are in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Certificate/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    // C2: the client posts what it was shown, never a hash of it.
    const accept = calls.find((c) => c.path === "/api/v1/compliance/acceptances");
    expect(accept?.body).not.toHaveProperty("bodySha256");
    expect(accept?.body).toMatchObject({ versionNo: 1, typedName: "Ada Lovelace" });
  }, 20_000);

  it("leaves a resource-scoped NDA to the unlock sheet and goes straight to the portal", async () => {
    standOnTheLink();
    let signedIn = false;
    installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/links/{token}": () => [200, resolution()],
      "POST /api/v1/links/{token}/start": () => [
        200,
        { status: "sent", emailHint: "a***@acme.com", ttlMinutes: 10 },
      ],
      "POST /api/v1/links/{token}/verify": () => {
        signedIn = true;
        return [200, login()];
      },
      // E3.5 B3: the link's own NDA gate is listed as `scope: "resource"`.
      "GET /api/v1/compliance/gates": () => [
        200,
        {
          pending: [
            pendingAcceptance({ slug: "nda", title: "Mutual NDA", kind: "nda", scope: "resource" }),
          ],
        },
      ],
    });
    const r = await renderApp(`/s/${TOKEN}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "You have been sent a link" });
    await user.type(screen.getByLabelText(/Email address/u), "ada@acme.com");
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await user.type(await screen.findByLabelText(/One-time code/u), "123456");
    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
    expect(screen.queryByRole("heading", { name: "One thing to agree to first" })).toBeNull();
  }, 20_000);

  it("gives an unresolvable token one answer and nothing else", async () => {
    standOnTheLink();
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      // Unknown, revoked, paused, expired and exhausted are all this (D7).
      "GET /api/v1/links/{token}": () => apiError(404, "not_found"),
    });
    const r = await renderApp(`/s/${TOKEN}`);
    expect(
      await screen.findByRole("heading", { name: "This link does not work" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email address/u)).toBeNull();
    expect(screen.queryByRole("link", { name: /sign in/iu })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
