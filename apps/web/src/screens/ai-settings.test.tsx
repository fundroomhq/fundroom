import { FundRoomApiError } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "../lib/api.js";
import { componentLabel } from "../lib/residency-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, testConfig } from "../test/fixtures.js";
import {
  AI_SETTINGS_SLOT,
  AI_UNAVAILABLE,
  type AiStatus,
  aiOn,
  aiStatus,
  THIRD_PARTY,
} from "../test/fixtures-ai.js";
import { staffMe } from "../test/fixtures-billing.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Settings → AI assist (E3.12): the host's model (or that there is none), the opt-in with an
 * acknowledgement whose copy depends on where the model runs, per-feature switches, the budget,
 * usage, and who may see or change it. The hub lists the page only on an install with a model.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const MANAGE = ["ai.read", "ai.manage"];

function handlers(
  over: Record<string, Handler> = {},
  opts: { permissions?: string[]; status?: AiStatus } = {},
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [AI_SETTINGS_SLOT],
        permissions: opts.permissions ?? MANAGE,
        membership: { id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07", kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/ai/status": () => [200, opts.status ?? aiStatus()],
    ...over,
  });
}

const aiConfig = () => testConfig({ ai: true });

async function open() {
  const r = await renderApp("/admin/settings/ai", aiConfig());
  await screen.findByRole("heading", { name: "AI assist", level: 1 }, { timeout: 5000 });
  return r;
}

const masterSwitch = () =>
  screen.findByRole(
    "checkbox",
    { name: /Turn on AI assist for this workspace/u },
    { timeout: 5000 },
  );

describe("AI assist settings", () => {
  it("is on the settings hub only when the install has a model", async () => {
    handlers();
    const r = await renderApp("/admin/settings", aiConfig());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "AI assist" }, { timeout: 5000 }));
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/settings/ai"));
    r.unmount();

    handlers();
    await renderApp("/admin/settings", testConfig({ ai: false }));
    await screen.findByRole("heading", { name: "Settings", level: 1 }, { timeout: 5000 });
    expect(screen.queryByRole("link", { name: "AI assist" })).toBeNull();
  }, 20_000);

  it("says when the host has not configured a model, and offers nothing to switch on", async () => {
    handlers({}, { status: AI_UNAVAILABLE });
    const r = await open();
    expect(
      await screen.findByText("Your host has not configured an AI model", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a self-hosted model and asks for the acknowledgement before turning it on", async () => {
    const saved: AiStatus = aiOn({ effective: { updateDraft: true, qaAnswer: false } });
    const mock = handlers({ "PUT /api/v1/ai/settings": () => [200, saved] });
    const r = await open();
    const user = userEvent.setup();
    expect(await screen.findByText("Ollama at ollama:11434")).toBeInTheDocument();
    expect(screen.getByText("qwen3.5:9b")).toBeInTheDocument();
    expect(
      screen.getByText("Runs on infrastructure your host says it operates"),
    ).toBeInTheDocument();
    expect(screen.getByText("Your host's infrastructure")).toBeInTheDocument(); // location
    // Off: no privacy-notice callout yet.
    expect(screen.queryByText("Tell investors about AI assist")).toBeNull();
    expect(screen.getByText("Not used to train models")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Prompts are processed on the operator's own server and not stored by the model.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("200,000 of 2,000,000 tokens used (10%)")).toBeInTheDocument();
    expect(screen.getByText("12 requests this month.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const feature = screen.getByRole("checkbox", { name: /Draft investor updates/u });
    expect(feature).toBeDisabled(); // until the master switch is on
    await user.click(await masterSwitch());
    await user.click(feature);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/which your host says runs on infrastructure it operates/u),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/leave your host's infrastructure/u)).toBeNull();
    expect(
      within(dialog).getByText(
        "Update your privacy notice and DPA so investors are told about AI assist.",
      ),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Turn on AI assist" });
    expect(confirm).toBeDisabled();
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({
        enabled: true,
        features: { updateDraft: true, qaAnswer: false },
        monthlyTokenBudget: null,
        acknowledge: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }, 20_000);

  it("says documents leave the host's infrastructure for a third-party model", async () => {
    handlers({}, { status: aiStatus({ provider: THIRD_PARTY }) });
    await open();
    const user = userEvent.setup();
    expect(
      await screen.findByText("Third-party service — documents leave your host's infrastructure"),
    ).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();
    await user.click(await masterSwitch());
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/a third-party service\. Location: United States\./u),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Documents leave your host's infrastructure."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Not used to train models")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", {
        name: /documents and questions leave our host's infrastructure/u,
      }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("never places a third-party model without a stated location on the host's infrastructure", async () => {
    handlers({}, { status: aiStatus({ provider: { ...THIRD_PARTY, location: null } }) });
    const r = await open();
    const user = userEvent.setup();
    expect(await screen.findByText("Location not stated by your host")).toBeInTheDocument();
    expect(screen.queryByText("Your host's infrastructure")).toBeNull();
    await expectNoA11yViolations(r.container);
    await user.click(await masterSwitch());
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /a third-party service\. Location: Location not stated by your host\./u,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Your host's infrastructure/u)).toBeNull();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("does not claim a provider does not train when the host has not stated it", async () => {
    // `trainsOnInputs: null` = a hosted OpenAI-compatible service whose terms govern training.
    const provider = { ...THIRD_PARTY, id: "openai-compatible" as const, trainsOnInputs: null };
    handlers({}, { status: aiStatus({ provider }) });
    await open();
    const user = userEvent.setup();
    expect(
      await screen.findByText(
        "Your host hasn't stated whether this provider trains models on your data — check the provider's terms.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not used to train models")).toBeNull();
    await user.click(await masterSwitch());
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Not used to train models")).toBeNull();
    expect(
      within(dialog).getByText(/hasn't stated whether this provider trains/u),
    ).toBeInTheDocument();
  }, 20_000);

  it("while AI assist is on, reminds admins to update the privacy notice and DPA", async () => {
    handlers({}, { status: aiOn() });
    const r = await open();
    const callout = (await screen.findByText("Tell investors about AI assist")).closest(
      "[data-slot=alert]",
    ) as HTMLElement;
    expect(
      within(callout).getByText(/Update your privacy notice and DPA so investors are told/u),
    ).toBeInTheDocument();
    const link = within(callout).getByRole("link", { name: "Go to legal documents" });
    expect(link.getAttribute("href")).toBe("/admin/legal?tab=documents");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("names a feature turned on in this visit in the privacy-notice callout", async () => {
    // Draft is already on (and the callout with it); turning Q&A on names Q&A.
    const before = aiOn({
      settings: { ...aiOn().settings, features: { updateDraft: true, qaAnswer: false } },
      effective: { updateDraft: true, qaAnswer: false },
    });
    let current = before;
    handlers(
      {
        "PUT /api/v1/ai/settings": () => {
          current = aiOn();
          return [200, current];
        },
        "GET /api/v1/ai/status": () => [200, current],
      },
      { status: before },
    );
    const r = await open();
    const user = userEvent.setup();
    expect(await screen.findByText("Tell investors about AI assist")).toBeInTheDocument();
    expect(screen.queryByText(/You just turned on/u)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /Suggest Q&A answers/u }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "You just turned on Suggest Q&A answers. Your published privacy notice may not mention it yet.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("saves without asking again while the acknowledgement is current, and checks the budget", async () => {
    const mock = handlers(
      {
        "PUT /api/v1/ai/settings": () => [
          200,
          aiOn({ settings: { ...aiOn().settings, monthlyTokenBudget: 200_000 } }),
        ],
      },
      { status: aiOn() },
    );
    await open();
    const user = userEvent.setup();
    const budget = await screen.findByLabelText("Monthly token budget", {}, { timeout: 5000 });
    // The hint names the minimum: one request's reservation (status.usage.minimumBudget).
    expect(budget).toHaveAccessibleDescription(/The minimum is 132,000 tokens/u);
    await user.type(budget, "50000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Enter a whole number of at least 132,000, or leave it empty."),
    ).toBeInTheDocument();
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
    await user.clear(budget);
    await user.type(budget, "200000");
    await user.click(screen.getByRole("checkbox", { name: /Suggest Q&A answers/u }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({
        enabled: true,
        features: { updateDraft: true, qaAnswer: false },
        monthlyTokenBudget: 200_000,
        acknowledge: false,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20_000);

  it("keeps an unchanged stored budget below today's minimum saveable, as the server does", async () => {
    const low = aiOn({ settings: { ...aiOn().settings, monthlyTokenBudget: 50_000 } });
    const mock = handlers({ "PUT /api/v1/ai/settings": () => [200, low] }, { status: low });
    await open();
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Monthly token budget", {}, { timeout: 5000 })).toHaveValue(
      "50000",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toMatchObject({
        monthlyTokenBudget: 50_000,
      }),
    );
  }, 20_000);

  it("warns that every feature is off while the budget is below one request's minimum", async () => {
    const below = aiOn({
      settings: { ...aiOn().settings, monthlyTokenBudget: 50_000 },
      effective: { updateDraft: false, qaAnswer: false },
      usage: { ...aiOn().usage, budget: 50_000, budgetBelowMinimum: true },
    });
    handlers({}, { status: below });
    const r = await open();
    expect(
      await screen.findByText(
        "Your monthly budget is below the minimum of 132,000 tokens one request needs, so AI assist is off. Raise it to turn AI assist back on.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    r.unmount();

    handlers({}, { status: aiOn() });
    await open();
    await screen.findByLabelText("Monthly token budget", {}, { timeout: 5000 });
    expect(screen.queryByText("Budget below the minimum")).toBeNull();
  }, 20_000);

  it("asks for the acknowledgement when the server says the provider changed underneath", async () => {
    const mock = handlers(
      { "PUT /api/v1/ai/settings": () => apiError(409, "ai_acknowledgement_required") },
      { status: aiOn() },
    );
    await open();
    const user = userEvent.setup();
    await screen.findByLabelText("Monthly token budget", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(mock.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  }, 20_000);

  it("warns that AI assist is off after the host changed the provider", async () => {
    handlers(
      {},
      {
        status: aiOn({
          needsAcknowledgement: true,
          effective: { updateDraft: false, qaAnswer: false },
        }),
      },
    );
    await open();
    expect(await screen.findByText("The AI provider changed")).toBeInTheDocument();
  }, 20_000);

  it("sends a stale session to step-up when saving", async () => {
    handlers(
      { "PUT /api/v1/ai/settings": () => apiError(401, "step_up_required", { reason: "fresh" }) },
      { status: aiOn() },
    );
    const r = await open();
    const user = userEvent.setup();
    await screen.findByLabelText("Monthly token budget", {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
  }, 20_000);

  it("is read-only without ai.manage", async () => {
    handlers({}, { permissions: ["ai.read"], status: aiOn() });
    const r = await open();
    expect(await masterSwitch()).toBeDisabled();
    expect(
      screen.getByText("Only owners and admins can change these settings."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("is forbidden without ai.read and asks for nothing", async () => {
    const mock = handlers({}, { permissions: [] });
    const r = await renderApp("/admin/settings/ai", aiConfig());
    expect(
      await screen.findByText(
        "You need permission to view AI assist settings.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(mock.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("AI assist copy", () => {
  it("names each start refusal in the reader's language", () => {
    const title = (code: string, status: number) =>
      describeError(
        new FundRoomApiError(status, { error: { code, message: code } } as never, undefined),
      ).title;
    expect(title("ai_unavailable", 409)).toBe("AI assist is not available");
    expect(title("ai_disabled", 409)).toBe("AI assist is off");
    expect(title("ai_acknowledgement_required", 409)).toBe("AI provider not acknowledged");
    expect(title("ai_rate_limited", 429)).toBe("Too many AI requests");
    expect(title("ai_busy", 429)).toBe("AI assist is busy");
    expect(title("ai_budget_exhausted", 429)).toBe("Monthly AI budget used up");
    const below = describeError(
      new FundRoomApiError(
        409,
        {
          error: { code: "ai_disabled", message: "ai_disabled", reason: "budget_below_minimum" },
        } as never,
        undefined,
      ),
    );
    expect(below.body).toBe(
      "The workspace's monthly AI budget is below what one request needs. An admin can raise it in Settings → AI assist.",
    );
  });

  it("labels the AI model in the residency components", () => {
    expect(componentLabel("ai" as never)).toBe("AI model");
  });
});

// A-3 (ADR-0063): a plan without `ai` lets a switch go off, never on.
describe("AI assist settings on a plan without AI", () => {
  it("says so and will not switch AI assist on", async () => {
    handlers();
    withPlanEntitlements({ features: [] });
    const r = await open();
    expect(
      await screen.findByText(
        "Your plan doesn't include AI drafting assist. Your settings are kept, but it can't be used until the plan includes it.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await masterSwitch()).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets what is on be switched off, and explains a refusal with the way to billing", async () => {
    const { calls } = handlers(
      {
        "PUT /api/v1/ai/settings": () =>
          apiError(402, "plan_limit", { limit: "feature", feature: "ai" }),
      },
      {
        permissions: [...MANAGE, "billing.read"],
        status: aiOn({
          settings: { ...aiOn().settings, features: { updateDraft: true, qaAnswer: false } },
          effective: { updateDraft: true, qaAnswer: false },
        }),
      },
    );
    withPlanEntitlements({ features: [] });
    const r = await renderApp("/admin/settings/ai", testConfig({ ai: true, billing: true }));
    expect(await masterSwitch()).toBeEnabled();
    const draft = screen.getByRole("checkbox", { name: /Draft investor updates/u });
    expect(draft).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Suggest Q&A answers/u })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(draft);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not on your plan: AI drafting assist")).toBeInTheDocument();
    expect(
      within(alert).getByText("Your plan doesn't include AI drafting assist."),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(/An owner can change the plan in Billing\./u),
    ).toBeInTheDocument();
    expect(within(alert).getByRole("link", { name: "Go to billing" })).toHaveAttribute(
      "href",
      "/admin/billing",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
