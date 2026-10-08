import { brandTokens } from "@fundroom/branding";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session, testConfig } from "../test/fixtures.js";
import {
  apiError,
  branding,
  brandLogo,
  contrastFinding,
  type Handler,
  installMockApi,
  json,
  moduleEnablement,
  planLockedModule,
  readOnlyModule,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (
  permissions = ["branding.read", "branding.manage"],
  role = "owner",
): ReturnType<typeof bootstrap> =>
  bootstrap({
    modules: [],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role },
  });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
  role?: string,
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions, role)],
    "GET /api/v1/branding": () => [200, branding()],
    "GET /api/v1/modules/enablement": () => [
      200,
      {
        modules: [
          moduleEnablement(),
          moduleEnablement({ id: "data-room", enabled: false }),
          moduleEnablement({
            id: "access",
            enabled: true,
            locked: true,
            lockedReason: "required",
          }),
        ],
      },
    ],
    ...over,
  });
}

async function openBranding(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/branding");
  expect(
    await screen.findByRole("heading", { name: "Branding", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("branding admin", () => {
  it("renders the brand the workspace has saved", async () => {
    handlers();
    const r = await openBranding();
    expect(await screen.findByLabelText("Display name")).toHaveValue("Acme Ventures");
    expect(screen.getByLabelText("Tagline")).toHaveValue("Building the boring parts");
    expect(screen.getByLabelText("Accent colour")).toHaveValue("#1d4ed8");
    expect(screen.getByLabelText("Support email")).toHaveValue("investors@acme.test");
    expect(screen.getByLabelText("Typeface")).toHaveValue("system");
    expect(screen.getByLabelText("Corners")).toHaveValue("soft");
    // A passing report says nothing: the warning is for colours that cannot reach AA.
    expect(screen.queryByText("This colour is hard to read")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("re-derives the preview tokens from the unsaved colour", async () => {
    handlers();
    const r = await openBranding();
    const preview = await screen.findByTestId("brand-preview");
    const saved = brandTokens(
      { accentColor: "#1d4ed8", fontFamily: "system", radius: "soft" },
      "light",
    );
    expect(preview.style.getPropertyValue("--sh-color-primary")).toBe(saved["--sh-color-primary"]);

    const user = userEvent.setup();
    const hex = screen.getByLabelText("Accent colour");
    await user.clear(hex);
    await user.type(hex, "#b91c1c");
    const next = brandTokens(
      { accentColor: "#b91c1c", fontFamily: "system", radius: "soft" },
      "light",
    );
    await waitFor(() =>
      expect(preview.style.getPropertyValue("--sh-color-primary")).toBe(next["--sh-color-primary"]),
    );
    // The document itself is untouched: the preview themes its own container (design/08 §4).
    expect(document.documentElement.style.getPropertyValue("--sh-color-primary")).toBe("");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("saves the whole brand in one PATCH", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/branding": ({ body }) => [200, { ...branding(), ...(body as object) }],
    });
    await openBranding();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Typeface"), "serif");
    await user.selectOptions(screen.getByLabelText("Corners"), "round");
    const tagline = screen.getByLabelText("Tagline");
    await user.clear(tagline);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/branding")?.body,
      ).toEqual({
        displayName: "Acme Ventures",
        // Cleared means cleared: an empty field is sent as null, not as "".
        tagline: null,
        accentColor: "#1d4ed8",
        fontFamily: "serif",
        radius: "round",
        supportEmail: "investors@acme.test",
        showPoweredBy: true,
      }),
    );
  }, 20_000);

  it("offers a member without branding.manage nothing to change", async () => {
    handlers({}, ["branding.read"], "member");
    const r = await openBranding();
    expect(await screen.findByLabelText("Display name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload a file" })).toBeNull();
    expect(screen.queryByLabelText("Or take it from your website")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("warns, without blocking, when a colour cannot reach AA", async () => {
    handlers({
      "GET /api/v1/branding": () => [
        200,
        branding({
          accentColor: "#ffe600",
          contrast: [
            contrastFinding({ passes: false, ratio: 1.9 }),
            contrastFinding({ mode: "dark", ratio: 8.2 }),
          ],
        }),
      ],
      "PATCH /api/v1/branding": () => [200, branding()],
    });
    const r = await openBranding();
    expect(
      await screen.findByText("This colour is hard to read", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/primary on background in light: 1.90:1, needs 4.5:1/u),
    ).toBeInTheDocument();
    // Advice, not a gate.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("uploads a logo as base64 and removes it again", async () => {
    let current = branding();
    const { calls } = handlers({
      "GET /api/v1/branding": () => [200, current],
      "POST /api/v1/branding/logo": () => {
        current = branding({ logo: brandLogo() });
        return [200, current];
      },
      "DELETE /api/v1/branding/logo": () => {
        current = branding();
        return [200, current];
      },
    });
    const r = await openBranding();
    expect(await screen.findByText("No logo yet.")).toBeInTheDocument();
    const user = userEvent.setup();
    // A one-pixel PNG: the server decides the content type from the bytes, so the shape of
    // the body is what matters here, not the pixels.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await user.upload(
      screen.getByLabelText("Choose a logo file"),
      new File([bytes], "logo.png", { type: "image/png" }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === "/api/v1/branding/logo" && c.method === "POST")?.body,
      ).toEqual({ data: "iVBORw0KGgo=", contentType: "image/png" }),
    );
    expect(await screen.findByAltText("Acme Ventures logo")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/branding/logo")).toBe(
        true,
      ),
    );
  }, 20_000);

  it("pulls a logo from a website URL", async () => {
    const { calls } = handlers({
      "POST /api/v1/branding/logo/fetch": () => [200, branding({ logo: brandLogo() })],
    });
    await openBranding();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Or take it from your website"),
      "https://acme.test",
    );
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/branding/logo/fetch")?.body).toEqual({
        url: "https://acme.test",
      }),
    );
  }, 20_000);
});

describe("module enablement", () => {
  it("toggles a module and leaves a locked one disabled with its reason", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/modules/{id}": ({ params }) => [
        200,
        moduleEnablement({ id: params["id"] ?? "", enabled: true }),
      ],
    });
    const r = await renderApp("/admin/modules");
    expect(
      await screen.findByRole("heading", { name: "Modules", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const dataRoom = await screen.findByRole("switch", { name: "data-room" }, { timeout: 5000 });
    expect(dataRoom).not.toBeChecked();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(dataRoom);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/modules/data-room")?.body).toEqual({
        enabled: true,
      }),
    );

    // Locked: shown, disabled, and carrying the reason rather than hidden.
    const locked = screen.getByRole("switch", { name: "access" });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    const row = locked.closest("li") as HTMLElement;
    expect(within(row).getByText("Always on")).toBeInTheDocument();
  }, 20_000);

  it("shows the switches as read-only to staff who are neither owner nor admin", async () => {
    handlers({}, ["branding.read"], "member");
    await renderApp("/admin/modules");
    expect(
      await screen.findByRole("heading", { name: "Modules", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "updates" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }, 20_000);

  // A-3 (ADR-0063): modules the plan leaves out.
  describe("on a plan", () => {
    const planModules = (): Record<string, Handler> => ({
      "GET /api/v1/modules/enablement": () => [
        200,
        {
          modules: [moduleEnablement(), planLockedModule("metrics"), readOnlyModule("crm")],
        },
      ],
    });

    it("greys out a module the plan leaves out, with the way to billing", async () => {
      handlers(planModules(), ["branding.read", "billing.read"]);
      const r = await renderApp("/admin/modules", testConfig({ billing: true }));
      const metrics = await screen.findByRole("switch", { name: "metrics" }, { timeout: 5000 });
      // Unavailable but focusable, described by its badge (RR3 RL3).
      expect(metrics).toHaveAttribute("aria-disabled", "true");
      expect(metrics).toHaveAccessibleDescription(/Not on your plan/u);
      expect(metrics).not.toBeChecked();
      const row = metrics.closest("li") as HTMLElement;
      expect(within(row).getByText("Not on your plan")).toBeInTheDocument();
      expect(within(row).getByRole("link", { name: "Go to billing" })).toHaveAttribute(
        "href",
        "/admin/billing",
      );
      // Never a tier name: the product does not know plan order.
      expect(screen.queryByText(/and up/u)).toBeNull();
      // On but outside the plan: still a working switch, labelled read-only.
      const crm = screen.getByRole("switch", { name: "crm" });
      expect(crm).toBeEnabled();
      expect(crm).toBeChecked();
      const crmRow = crm.closest("li") as HTMLElement;
      expect(within(crmRow).getByText("Read-only on your plan")).toBeInTheDocument();
      expect(within(crmRow).queryByRole("link", { name: "Go to billing" })).toBeNull();
      await expectNoA11yViolations(r.container);
    }, 20_000);

    it("keeps an unavailable switch focusable but inert", async () => {
      const { calls } = handlers(planModules());
      await renderApp("/admin/modules");
      const metrics = await screen.findByRole("switch", { name: "metrics" }, { timeout: 5000 });
      metrics.focus();
      expect(metrics).toHaveFocus();
      await userEvent.setup().click(metrics);
      expect(metrics).not.toBeChecked();
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    }, 20_000);

    it("offers no billing link to staff who cannot see billing", async () => {
      handlers(planModules());
      await renderApp("/admin/modules", testConfig({ billing: true }));
      const metrics = await screen.findByRole("switch", { name: "metrics" }, { timeout: 5000 });
      const row = metrics.closest("li") as HTMLElement;
      expect(within(row).getByText("Not on your plan")).toBeInTheDocument();
      expect(within(row).queryByRole("link", { name: "Go to billing" })).toBeNull();
    }, 20_000);

    it("asks before switching off a read-only module, and does nothing on cancel", async () => {
      // The PATCH waits until released, so the switch can be checked while the change saves.
      let release: () => void = () => {};
      const { calls } = handlers({
        ...planModules(),
        "PATCH /api/v1/modules/{id}": ({ params }) =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(json(200, moduleEnablement({ id: params["id"] ?? "", enabled: false })));
          }),
      });
      await renderApp("/admin/modules");
      const crm = await screen.findByRole("switch", { name: "crm" }, { timeout: 5000 });
      const user = userEvent.setup();
      await user.click(crm);
      const dialog = await screen.findByRole("dialog", { name: "Turn off crm?" });
      expect(
        within(dialog).getByText("You won't be able to turn it back on without changing plan."),
      ).toBeInTheDocument();
      await expectNoA11yViolations(dialog);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      // Focus goes back to the switch that asked.
      await waitFor(() => expect(crm).toHaveFocus());
      expect(crm).toBeChecked();

      await user.click(crm);
      const again = await screen.findByRole("dialog", { name: "Turn off crm?" });
      await user.click(within(again).getByRole("button", { name: "Turn off" }));
      await waitFor(() =>
        expect(calls.find((c) => c.path === "/api/v1/modules/crm")?.body).toEqual({
          enabled: false,
        }),
      );
      // Focus comes back to the switch, which stays focusable while it saves and once it is
      // locked (`aria-disabled`, not `disabled`) — R3 L2 / RR3 RL3.
      await waitFor(() => expect(crm).toHaveFocus());
      expect(crm).toHaveAttribute("aria-disabled", "true");
      expect(crm).not.toBeDisabled();
      release();
      await waitFor(() => expect(crm).not.toHaveAttribute("aria-disabled"));
    }, 20_000);

    it("shows read-only beside a dependency lock (R3 L3)", async () => {
      handlers({
        "GET /api/v1/modules/enablement": () => [
          200,
          {
            modules: [
              moduleEnablement({
                id: "data-room",
                locked: true,
                lockedReason: "dependency",
                planAllows: false,
                readOnly: true,
              }),
            ],
          },
        ],
      });
      await renderApp("/admin/modules");
      const row = (
        await screen.findByRole("switch", { name: "data-room" }, { timeout: 5000 })
      ).closest("li") as HTMLElement;
      expect(within(row).getByText("Needed by another module")).toBeInTheDocument();
      expect(within(row).getByText("Read-only on your plan")).toBeInTheDocument();
    }, 20_000);

    it("names the module when a refusal races the list (R3 L7)", async () => {
      handlers({
        ...planModules(),
        "PATCH /api/v1/modules/{id}": () =>
          apiError(402, "plan_limit", { limit: "module", module: "updates" }),
      });
      await renderApp("/admin/modules");
      await userEvent
        .setup()
        .click(await screen.findByRole("switch", { name: "updates" }, { timeout: 5000 }));
      expect(await screen.findByText("Not on your plan: updates")).toBeInTheDocument();
    }, 20_000);

    it("switches an ordinary module off without asking", async () => {
      const { calls } = handlers({
        ...planModules(),
        "PATCH /api/v1/modules/{id}": ({ params }) => [
          200,
          moduleEnablement({ id: params["id"] ?? "", enabled: false }),
        ],
      });
      await renderApp("/admin/modules");
      const updates = await screen.findByRole("switch", { name: "updates" }, { timeout: 5000 });
      await userEvent.setup().click(updates);
      await waitFor(() =>
        expect(calls.find((c) => c.path === "/api/v1/modules/updates")?.body).toEqual({
          enabled: false,
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    }, 20_000);
  });
});
