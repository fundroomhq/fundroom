import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countryOptions, isValidSlug, previewHost, slugFromName } from "../lib/signup-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { me, session, testConfig } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * Self-service signup (E3.10, ADR-0058 §5.7) on the canonical host: company details and a
 * workspace address (checked as it is typed, with a preview of the host it becomes), the emailed
 * code, then a link to the new workspace. Only with `config.signup`.
 */
afterEach(() => vi.unstubAllGlobals());

const SIGNUP = testConfig({
  workspace: null,
  tenancy: "multi",
  canonicalOrigin: "https://fundroom.test",
  signup: true,
  signupTerms: { version: 1, url: null },
});

/** The host's public plans (A-5): free, paid with no trial, paid with a trial. */
const PLANS = {
  plans: [
    { id: "starter", name: "Starter", limits: null, trialDays: 0, paid: false },
    { id: "growth", name: "Growth", limits: null, trialDays: 0, paid: true },
    { id: "scale", name: "Scale", limits: null, trialDays: 14, paid: true },
  ],
};

function handlers(over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "GET /api/v1/signup/slug": ({ url }) => {
      const slug = url.searchParams.get("slug") ?? "";
      return [200, { slug, available: slug !== "taken" }];
    },
    "POST /api/v1/signup/start": () => [200, { ok: true }],
    "POST /api/v1/signup/verify": () => [201, { workspaceUrl: "https://acme-bohm.fundroom.test/" }],
    ...over,
  });
}

async function fillDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText(/Your work email/u, {}, { timeout: 5000 }),
    "ada@example.com",
  );
  await user.type(screen.getByLabelText(/Company name/u), "Acme Böhm");
  await user.type(screen.getByLabelText(/Registered legal name/u), "Acme Böhm GmbH");
  await user.selectOptions(screen.getByLabelText(/Country of registration/u), "DE");
  await user.click(screen.getByLabelText(/I accept the terms of service/u));
}

describe("signup", () => {
  it("creates a workspace: details, code, then a link to it", async () => {
    const { calls } = handlers();
    const r = await renderApp("/signup", SIGNUP);
    expect(
      await screen.findByRole("heading", { name: "Create your workspace" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await fillDetails(user);
    // The address follows the company name, and says where the portal will live.
    expect(screen.getByLabelText(/Workspace address/u)).toHaveValue("acme-bohm");
    expect(screen.getByText("Your portal will be at acme-bohm.fundroom.test.")).toBeInTheDocument();
    expect(
      await screen.findByText("That address is available.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/signup/slug")).toBe(true);
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(
      await screen.findByRole("heading", { name: "Check your email" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/signup/start")?.body).toEqual({
      email: "ada@example.com",
      companyName: "Acme Böhm",
      legalName: "Acme Böhm GmbH",
      country: "DE",
      slug: "acme-bohm",
      locale: "en",
      acceptTerms: true,
      termsVersion: 1,
    });
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/One-time code/u), "123456");
    expect(
      await screen.findByRole("heading", { name: "Your workspace is ready" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/signup/verify")?.body).toEqual({
      email: "ada@example.com",
      code: "123456",
    });
    expect(screen.getByRole("link", { name: /Continue/u })).toHaveAttribute(
      "href",
      "https://acme-bohm.fundroom.test/",
    );
    // No plans to choose from (the catalogue 404s here): no plan group, no planId sent.
    expect(screen.queryByRole("group", { name: "Plan" })).toBeNull();
    await expectNoA11yViolations(r.container);
    // Four full-page axe runs over a 249-option select: slow under a loaded full-suite run.
  }, 40_000);

  it("asks for the tick again when the terms changed while the page was open", async () => {
    let starts = 0;
    const { calls } = handlers({
      "POST /api/v1/signup/start": () => {
        starts += 1;
        return starts === 1
          ? apiError(409, "conflict", { details: { reason: "terms_version", current: 2 } })
          : [200, { ok: true }];
      },
    });
    const r = await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByText(/terms of service have changed/u)).toBeInTheDocument();
    const box = screen.getByLabelText(/I accept the terms of service/u);
    expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeDisabled();
    await expectNoA11yViolations(r.container);

    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(
      await screen.findByRole("heading", { name: "Check your email" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const sent = calls.filter((c) => c.path === "/api/v1/signup/start").map((c) => c.body);
    expect(sent.map((b) => (b as { termsVersion: number }).termsVersion)).toEqual([1, 2]);
  }, 40_000);

  it("accepts the terms version the page config names", async () => {
    const { calls } = handlers();
    await renderApp("/signup", testConfig({ ...SIGNUP, signupTerms: { version: 7, url: null } }));
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/signup/start")?.body).toMatchObject({
        acceptTerms: true,
        termsVersion: 7,
      }),
    );
  }, 40_000);

  it("refuses a taken or malformed address before sending anything", async () => {
    const { calls } = handlers();
    await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    const slug = screen.getByLabelText(/Workspace address/u);
    await user.clear(slug);
    await user.type(slug, "taken");
    expect(
      await screen.findByText(
        "That address is taken. Choose a different one.",
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(slug).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeDisabled();

    await user.clear(slug);
    await user.type(slug, "-bad-");
    expect(
      screen.getByText(/Use lower-case letters, digits and hyphens only/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeDisabled();
    expect(calls.some((c) => c.path === "/api/v1/signup/start")).toBe(false);
  }, 20_000);

  it("goes back to the address when it was taken between the check and the code", async () => {
    handlers({ "POST /api/v1/signup/verify": () => apiError(409, "slug_taken") });
    await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    expect(
      await screen.findByText(
        "That address is taken. Choose a different one.",
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    // Everything else the founder typed is still there.
    expect(screen.getByLabelText(/Company name/u)).toHaveValue("Acme Böhm");
  }, 20_000);

  it("keeps the code field on a wrong code", async () => {
    handlers({ "POST /api/v1/signup/verify": () => apiError(400, "invalid_code") });
    await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/One-time code/u)).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  }, 20_000);

  it("preselects the plan the link names and sends it with the code", async () => {
    const { calls } = handlers({
      "GET /api/v1/signup/plans": () => [200, PLANS],
      "POST /api/v1/signup/verify": () => [
        201,
        { workspaceUrl: "https://acme-bohm.fundroom.test/admin/billing?plan=growth" },
      ],
    });
    const r = await renderApp("/signup?plan=growth", SIGNUP);
    const group = await screen.findByRole("group", { name: "Plan" }, { timeout: 5000 });
    expect(within(group).getByRole("radio", { name: "Growth" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Starter" })).not.toBeChecked();
    // How each plan starts, tied to its radio; no prices (the host's site has those).
    expect(within(group).getByRole("radio", { name: "Scale" })).toHaveAccessibleDescription(
      "Starts with a 14-day free trial.",
    );
    expect(within(group).getByRole("radio", { name: "Growth" })).toHaveAccessibleDescription(
      /^A subscription/u,
    );
    // Not `paid` proves nothing about price (a manually billed install): never called free.
    expect(within(group).getByRole("radio", { name: "Starter" })).toHaveAccessibleDescription("");
    expect(within(group).queryByText(/free$/iu)).toBeNull();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    // The plan rides on the code, not on the request for one.
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    await screen.findByRole("heading", { name: "Your workspace is ready" }, { timeout: 5000 });
    expect(calls.find((c) => c.path === "/api/v1/signup/start")?.body).not.toHaveProperty("planId");
    expect(calls.find((c) => c.path === "/api/v1/signup/verify")?.body).toEqual({
      email: "ada@example.com",
      code: "123456",
      planId: "growth",
    });
    // The server chose the billing page; the button goes there, the text shows the workspace.
    expect(screen.getByRole("link", { name: /Continue/u })).toHaveAttribute(
      "href",
      "https://acme-bohm.fundroom.test/admin/billing?plan=growth",
    );
    expect(screen.getByText("acme-bohm.fundroom.test")).toBeInTheDocument();
  }, 40_000);

  it("falls back to the first plan that is free to start when the link's plan is not offered", async () => {
    const { calls } = handlers({ "GET /api/v1/signup/plans": () => [200, PLANS] });
    await renderApp("/signup?plan=enterprise", SIGNUP);
    const group = await screen.findByRole("group", { name: "Plan" }, { timeout: 5000 });
    expect(within(group).getByRole("radio", { name: "Starter" })).toBeChecked();
    const user = userEvent.setup();
    await user.click(within(group).getByRole("radio", { name: "Scale" }));
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/signup/verify")?.body).toMatchObject({
        planId: "scale",
      }),
    );
  }, 40_000);

  // Round 3: the second factor is added on the canonical host, while the session may add one.
  it("asks for a second factor on the done screen before the founder leaves", async () => {
    let signedIn = false;
    let enrolled = false;
    handlers({
      "GET /api/v1/me": () =>
        signedIn
          ? [
              200,
              me({
                session: session({
                  population: "staff",
                  authLevel: enrolled ? 2 : 1,
                  user: { displayName: "Ada", mfaEnrolled: enrolled, locale: null },
                }),
              }),
            ]
          : apiError(401, "unauthenticated"),
      "POST /api/v1/signup/verify": () => {
        signedIn = true;
        return [201, { workspaceUrl: "https://acme-bohm.fundroom.test/setup" }];
      },
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
        return [200, { recoveryCodes: ["aaaa-bbbb"] }];
      },
    });
    const r = await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    expect(
      await screen.findByRole("heading", { name: "Secure your account" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Leaving without it stays possible; the workspace asks again.
    expect(screen.getByRole("link", { name: /Continue/u })).toHaveAttribute(
      "href",
      "https://acme-bohm.fundroom.test/setup",
    );
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Set up/u }));
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Secure your account" })).toBeNull(),
    );
  }, 40_000);

  // Round 4 M1: no factor, too old a session to add one — keep the workspace URL, don't restart.
  it("offers the workspace when the done screen's session is too old to add a factor", async () => {
    let signedIn = false;
    handlers({
      "GET /api/v1/me": () =>
        signedIn
          ? [200, me({ session: session({ population: "staff", authLevel: 1 }) })]
          : apiError(401, "unauthenticated"),
      "POST /api/v1/signup/verify": () => {
        signedIn = true;
        return [201, { workspaceUrl: "https://acme-bohm.fundroom.test/setup" }];
      },
      "POST /api/v1/auth/totp/enrol": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    await renderApp("/signup", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(
      await screen.findByLabelText(/One-time code/u, {}, { timeout: 5000 }),
      "123456",
    );
    await user.click(await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }));
    expect(
      await screen.findByRole("link", { name: "Add one in your workspace instead" }),
    ).toHaveAttribute("href", "https://acme-bohm.fundroom.test/setup");
    // Not the "you already have one" view, whose step-up would restart signup.
    expect(screen.queryByRole("link", { name: "Confirm it's you" })).toBeNull();
  }, 40_000);

  it("waits for the plans before sending anything", async () => {
    handlers({ "GET /api/v1/signup/plans": () => new Promise<Response>(() => {}) });
    await renderApp("/signup?plan=growth", SIGNUP);
    const user = userEvent.setup();
    await fillDetails(user);
    await screen.findByText("That address is available.", {}, { timeout: 5000 });
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeDisabled();
  }, 20_000);

  it("ties the plan help text to the plan group", async () => {
    handlers({ "GET /api/v1/signup/plans": () => [200, PLANS] });
    await renderApp("/signup", SIGNUP);
    expect(
      await screen.findByRole("group", { name: "Plan" }, { timeout: 5000 }),
    ).toHaveAccessibleDescription(/You can change plans later/u);
  }, 20_000);

  it("links the terms when the host publishes them, in a new tab", async () => {
    handlers();
    await renderApp(
      "/signup",
      testConfig({ ...SIGNUP, signupTerms: { version: 1, url: "https://fundroom.test/terms" } }),
    );
    const link = await screen.findByRole(
      "link",
      { name: /Read the terms of service/u },
      { timeout: 5000 },
    );
    expect(link).toHaveAttribute("href", "https://fundroom.test/terms");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    expect(link).toHaveAccessibleName(/opens in a new tab/u);
  }, 20_000);

  it("says the terms in plain text when the host has not published them", async () => {
    handlers();
    await renderApp("/signup", SIGNUP);
    expect(
      await screen.findByLabelText(/I accept the terms of service/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Read the terms of service/u })).toBeNull();
  }, 20_000);

  it("carries the host's footer links, then the accessibility statement", async () => {
    handlers();
    await renderApp(
      "/signup",
      testConfig({
        ...SIGNUP,
        links: {
          terms: "https://fundroom.test/terms",
          // Never reaches an href, whatever a misconfigured server sends.
          privacy: "javascript:alert(1)",
          support: "mailto:help@fundroom.test",
          status: "https://status.fundroom.test/",
        },
      }),
    );
    const footer = await screen.findByRole("navigation", { name: "Footer" }, { timeout: 5000 });
    const links = within(footer).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Terms",
      "Support",
      "Status",
      "Accessibility",
    ]);
    expect(links[1]).toHaveAttribute("href", "mailto:help@fundroom.test");
  }, 20_000);

  it("is not there when the page config names no terms to accept", async () => {
    const { calls } = handlers();
    await renderApp("/signup", testConfig({ ...SIGNUP, signupTerms: null }));
    expect(
      await screen.findByRole("heading", { name: "Page not found" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/signup"))).toBe(false);
  }, 20_000);

  it("is not there when signup is closed", async () => {
    const { calls } = handlers();
    await renderApp("/signup", testConfig({ workspace: null, signup: false }));
    expect(
      await screen.findByRole("heading", { name: "Page not found" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/signup"))).toBe(false);
  }, 20_000);
});

describe("signup helpers", () => {
  it("turns a company name into an address and previews its host", () => {
    expect(slugFromName("  Acme Böhm & Co. ")).toBe("acme-bohm-co");
    expect(isValidSlug("acme-bohm-co")).toBe(true);
    expect(isValidSlug("-acme")).toBe(false);
    expect(isValidSlug("v2")).toBe(false);
    expect(isValidSlug("1.2.3")).toBe(false);
    expect(previewHost("acme", "https://fundroom.test:8443")).toBe("acme.fundroom.test:8443");
  });

  it("names every country in the reader's language, sorted by name", () => {
    const options = countryOptions("en");
    expect(options).toHaveLength(249);
    expect(options.find((o) => o.code === "DE")?.name).toBe("Germany");
    const names = options.map((o) => o.name);
    expect([...names].sort(new Intl.Collator("en").compare)).toEqual(names);
  });
});
