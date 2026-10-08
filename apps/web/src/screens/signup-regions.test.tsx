import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { testConfig } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The signup region picker (E3.11): offered only when the host runs more than one region. This
 * page signs up into its own region; one served elsewhere has its own sign-up page, reached by
 * an explicit link (never by merely moving through the radio group), and this form stays shut.
 */
afterEach(() => vi.unstubAllGlobals());

const SIGNUP = testConfig({
  workspace: null,
  tenancy: "multi",
  canonicalOrigin: "https://eu.fundroom.test",
  signup: true,
  signupTerms: { version: 1, url: null },
});

const REGIONS = [
  {
    region: "eu-central",
    label: "European Union (Frankfurt)",
    jurisdiction: "eu",
    signupUrl: null,
  },
  {
    region: "us-east",
    label: "United States (Virginia)",
    jurisdiction: "us",
    signupUrl: "https://us.fundroom.test/signup",
  },
  // A remote region without a usable sign-up page is not offered.
  { region: "ap", label: "Asia Pacific", jurisdiction: "other", signupUrl: "javascript:alert(1)" },
  // …nor one whose page is not https.
  {
    region: "ca",
    label: "Canada",
    jurisdiction: "ca",
    signupUrl: "http://ca.fundroom.test/signup",
  },
];

function handlers(over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "GET /api/v1/signup/slug": ({ url }) => [
      200,
      { slug: url.searchParams.get("slug") ?? "", available: true },
    ],
    "GET /api/v1/signup/regions": () => [200, { items: REGIONS }],
    "POST /api/v1/signup/start": () => [200, { ok: true }],
    ...over,
  });
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText(/Your work email/u, {}, { timeout: 5000 }),
    "ada@example.com",
  );
  await user.type(screen.getByLabelText(/Company name/u), "Acme");
  await user.type(screen.getByLabelText(/Registered legal name/u), "Acme GmbH");
  await user.selectOptions(screen.getByLabelText(/Country of registration/u), "DE");
  await user.click(screen.getByLabelText(/I accept the terms of service/u));
}

describe("signup region picker", () => {
  it("defaults to this origin's region and hands a region elsewhere to its own sign-up page", async () => {
    const { calls } = handlers();
    const r = await renderApp("/signup", SIGNUP);
    const group = await screen.findByRole(
      "group",
      { name: "Where your data will live" },
      { timeout: 5000 },
    );
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      "European Union (Frankfurt)",
      "United States (Virginia)",
    ]);
    expect(within(group).getByRole("radio", { name: "European Union (Frankfurt)" })).toBeChecked();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await fill(user);
    const submit = screen.getByRole("button", { name: "Email me a code" });
    expect(submit).toBeEnabled();

    await user.click(within(group).getByRole("radio", { name: "United States (Virginia)" }));
    // Selecting does not navigate; the link does, and this form stays shut meanwhile.
    const link = within(group).getByRole("link", {
      name: "Continue to sign up in United States (Virginia)",
    });
    expect(link).toHaveAttribute("href", "https://us.fundroom.test/signup");
    expect(link).toHaveClass("underline");
    expect(submit).toBeDisabled();
    await expectNoA11yViolations(r.container);

    await user.click(within(group).getByRole("radio", { name: "European Union (Frankfurt)" }));
    expect(within(group).queryByRole("link")).toBeNull();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(
      await screen.findByRole("heading", { name: "Check your email" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/signup/start")).toBe(true);
  }, 20_000);

  it("offers no picker with a single region, or when the server does not list any", async () => {
    const { calls } = handlers({
      "GET /api/v1/signup/regions": () => [200, { items: [REGIONS[0]] }],
    });
    await renderApp("/signup", SIGNUP);
    await screen.findByRole("heading", { name: "Create your workspace" }, { timeout: 5000 });
    // The answer has arrived (and rendered) before asserting the picker is absent.
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/signup/regions")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("group", { name: "Where your data will live" })).toBeNull();
    vi.unstubAllGlobals();

    handlers({ "GET /api/v1/signup/regions": () => apiError(404, "not_found") });
    await renderApp("/signup", SIGNUP);
    await screen.findAllByRole("heading", { name: "Create your workspace" }, { timeout: 5000 });
    expect(screen.queryByRole("group", { name: "Where your data will live" })).toBeNull();
  }, 20_000);
});
