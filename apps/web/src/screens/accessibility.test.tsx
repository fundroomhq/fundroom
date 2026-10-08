import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The accessibility statement (E2.8): public at `/accessibility`, rendered from Markdown with a
 * proper outline, reachable from the footer of the sign-in layout and of the portal shell.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const DEFAULT_BODY = [
  "> **TEMPLATE — NOT LEGAL ADVICE.**",
  "",
  "# Accessibility statement",
  "",
  "**Effective date:** 2026-09-23  ·  **Version:** 1",
  "",
  "Acme wants everyone to be able to use the investor portal at https://investors.acme.test/.",
  "",
  "## Conformance",
  "",
  "We aim to meet **WCAG 2.2 level AA**. See [the guidelines](https://www.w3.org/TR/WCAG22/).",
  "",
  "## Feedback and contact",
  "",
  "- Email: help@acme.test",
].join("\n");

function statement(
  over: Partial<FundRoomSchemas["AccessibilityStatement"]> = {},
): FundRoomSchemas["AccessibilityStatement"] {
  return {
    source: "default",
    title: "Accessibility statement",
    bodyMarkdown: DEFAULT_BODY,
    effectiveDate: "2026-09-23",
    version: null,
    ...over,
  };
}

function signedOut(statementHandler: Handler = () => [200, statement()]) {
  return installMockApi({
    "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    "GET /api/v1/compliance/accessibility-statement": statementHandler,
  });
}

describe("accessibility statement", () => {
  it("is readable without signing in, with a proper heading outline", async () => {
    signedOut();
    const r = await renderApp("/accessibility");
    expect(
      await screen.findByRole("heading", { name: "Accessibility statement", level: 1 }),
    ).toBeInTheDocument();
    expect(pathOf(r.router)).toBe("/accessibility");
    // The body's own title heading is folded into the page's h1; sections are h2.
    expect(screen.getAllByRole("heading", { name: "Accessibility statement" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Conformance", level: 2 })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Feedback and contact", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/the company has not published its own yet/u)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "the guidelines" });
    expect(link).toHaveAttribute("href", "https://www.w3.org/TR/WCAG22/");
    expect(link.closest("[class]")?.className).toMatch(/\[&_a\]:underline/u);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("main")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a published statement's version", async () => {
    signedOut(() => [
      200,
      statement({
        source: "published",
        title: "Accessibility at Acme",
        bodyMarkdown: "# Accessibility at Acme\n\nOur own words.\n\n## Contact\n\nWrite to us.",
        version: 3,
      }),
    ]);
    const r = await renderApp("/accessibility");
    expect(
      await screen.findByRole("heading", { name: "Accessibility at Acme", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Version 3/u)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact", level: 2 })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("offers signed-in readers the way back to the portal", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/compliance/accessibility-statement": () => [200, statement()],
    });
    await renderApp("/accessibility");
    expect(await screen.findByRole("link", { name: "Back to the portal" })).toHaveAttribute(
      "href",
      "/",
    );
  }, 20_000);

  it("explains a failure", async () => {
    signedOut(() => apiError(500, "internal_error"));
    const r = await renderApp("/accessibility");
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(
      screen.getByRole("heading", { name: "Accessibility statement", level: 1 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("is linked from the sign-in layout's footer", async () => {
    signedOut();
    const r = await renderApp("/login");
    const footer = await screen.findByRole("navigation", { name: "Footer" });
    const link = within(footer).getByRole("link", { name: "Accessibility" });
    expect(link).toHaveAttribute("href", "/accessibility");
    expect(link).toHaveClass("underline");
    await userEvent.setup().click(link);
    await waitFor(() => expect(pathOf(r.router)).toBe("/accessibility"));
    expect(
      await screen.findByRole("heading", { name: "Accessibility statement", level: 1 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("is linked from the portal shell's footer", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    const r = await renderApp("/settings");
    const footer = await screen.findByRole("navigation", { name: "Footer" }, { timeout: 5000 });
    expect(within(footer).getByRole("link", { name: "Accessibility" })).toHaveAttribute(
      "href",
      "/accessibility",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
