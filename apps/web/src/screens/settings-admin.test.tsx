import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  accessSettings,
  apiError,
  type Handler,
  installMockApi,
  moduleEnablement,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/settings` (E2.7): the hub lists every enabled module's `admin.settings` entries plus,
 * for owners, the danger zone; `/admin/settings/access` edits the access settings (PATCH with
 * only what changed, step-up); the modules page links each module to its settings entry.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f08";
const SEED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f09";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const NOW = "2026-09-20T10:00:00.000Z";

const MODULES = [
  {
    id: "access",
    version: "0.1.0",
    enabled: true,
    hidden: false,
    readOnly: false,
    flags: {},
    slots: {
      "admin.settings": [
        {
          id: "access-settings",
          label: "Access & sign-in",
          to: "/admin/settings/access",
          order: 10,
        },
        { id: "mail", label: "Mail delivery", to: "/admin/mail", order: 15, icon: "mail" },
      ],
    },
  },
  {
    id: "updates",
    version: "1.0.0",
    enabled: true,
    hidden: false,
    readOnly: false,
    flags: {},
    slots: {
      "admin.settings": [
        { id: "updates-settings", label: "Updates", to: "/admin/updates/settings", order: 60 },
      ],
    },
  },
  {
    id: "data-room",
    version: "1.0.0",
    enabled: false,
    hidden: false,
    readOnly: false,
    flags: {},
    slots: {
      "admin.settings": [
        { id: "dr-settings", label: "Data room", to: "/admin/data-room/settings", order: 50 },
      ],
    },
  },
];

function handlers(
  over: Record<string, Handler> = {},
  permissions = ["access.read", "access.settings", "access.transfer", "access.delete_workspace"],
  role: "owner" | "admin" | "legal" = "owner",
  offeringStatus: "none" | "506b" = "none",
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: MODULES,
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role },
        workspace: {
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f00",
          slug: "acme",
          name: "Acme",
          offeringStatus,
          defaultLocale: "en",
        },
      }),
    ],
    "GET /api/v1/access/settings": () => [200, accessSettings()],
    "GET /api/v1/access/groups": () => [
      200,
      {
        groups: [
          { id: BOARD_ID, name: "Board", kind: "board", memberCount: 1, createdAt: NOW },
          { id: SEED_ID, name: "Seed investors", kind: "round", memberCount: 0, createdAt: NOW },
        ],
      },
    ],
    ...over,
  });
}

async function open(path: string, heading: string) {
  const r = await renderApp(path);
  expect(
    await screen.findByRole("heading", { name: heading, level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("settings hub", () => {
  it("lists enabled modules' settings entries and the danger zone for owners", async () => {
    handlers();
    const r = await open("/admin/settings", "Settings");
    const main = screen.getByRole("main");
    expect(await screen.findByRole("link", { name: "Access & sign-in" })).toHaveAttribute(
      "href",
      "/admin/settings/access",
    );
    expect(screen.getAllByRole("link", { name: "Mail delivery" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Updates" }).length).toBeGreaterThan(0);
    // A disabled module's settings entry is not listed.
    expect(main.querySelector('a[href="/admin/data-room/settings"]')).toBeNull();
    const danger = screen.getByRole("link", { name: "Danger zone" });
    expect(danger).toHaveAttribute("href", "/admin/settings/danger");
    expect(danger.className).toContain("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides the danger zone from non-owners", async () => {
    handlers({}, ["access.read", "access.settings"], "admin");
    await open("/admin/settings", "Settings");
    expect(await screen.findByRole("link", { name: "Access & sign-in" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Danger zone" })).toBeNull();
  }, 20_000);
});

describe("access settings", () => {
  it("saves only the fields that changed", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/access/settings": ({ body }) => [
        200,
        accessSettings(body as Record<string, unknown>),
      ],
    });
    const r = await open("/admin/settings/access", "Access & sign-in");
    const staff = await screen.findByRole("switch", { name: "Require two-step sign-in for staff" });
    expect(staff).toBeChecked();
    await expectNoA11yViolations(r.container);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("switch", { name: "Require two-step sign-in for investors" }),
    );
    const expiry = screen.getByRole("spinbutton", { name: "Invitation expiry (days)" });
    await user.clear(expiry);
    await user.type(expiry, "120");
    expect(await screen.findByText(/between 1 and 90/u)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(expiry);
    await user.type(expiry, "30");
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ requireMfaForExternal: true, inviteExpiryDays: 30 });
    expect(await screen.findByText("Access settings saved.")).toBeInTheDocument();
  }, 20_000);

  it("saves the access-request settings as one whole object", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/access/settings": ({ body }) => [
        200,
        accessSettings(body as Record<string, unknown>),
      ],
    });
    const r = await open("/admin/settings/access", "Access & sign-in");
    const user = userEvent.setup();
    const enabled = await screen.findByRole("switch", { name: "Accept access requests" });
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Open the request queue" }).className).toMatch(
      /(^|\s)underline(\s|$)/u,
    );
    // Not under 506(b): auto-approve is not flagged as unavailable.
    expect(screen.queryByText(/Auto-approve does not apply/u)).toBeNull();
    await user.click(enabled);

    const domains = screen.getByRole("textbox", { name: "Auto-approve email domains" });
    await user.type(domains, "Example.com\nnot a domain{enter}@acme.test");
    expect(await screen.findByText("Not a valid domain: not, a, domain")).toBeInTheDocument();
    expect(domains).toHaveAttribute("aria-invalid", "true");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.clear(domains);
    await user.type(domains, "Example.com{enter}@acme.test");

    await user.click(await screen.findByRole("checkbox", { name: "Seed investors" }));
    const days = screen.getByRole("spinbutton", { name: "Pending requests expire after (days)" });
    await user.clear(days);
    await user.type(days, "400");
    expect(await screen.findByText(/between 1 and 365/u)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(days);
    await user.type(days, "14");
    await expectNoA11yViolations(r.container);

    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      requests: {
        enabled: true,
        autoApproveDomains: ["example.com", "acme.test"],
        defaultGroupIds: [SEED_ID],
        pendingExpiryDays: 14,
      },
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect((await screen.findAllByText("Access settings saved.")).length).toBeGreaterThan(0);
  }, 20_000);

  it("drops an archived default group instead of sending it back", async () => {
    const ARCHIVED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f0a";
    const { calls } = handlers({
      "GET /api/v1/access/settings": () => [
        200,
        accessSettings({
          requests: {
            enabled: true,
            autoApproveDomains: [],
            defaultGroupIds: [BOARD_ID, ARCHIVED_ID],
            pendingExpiryDays: 30,
          },
        }),
      ],
      "PATCH /api/v1/access/settings": ({ body }) => [
        200,
        accessSettings(body as Record<string, unknown>),
      ],
    });
    await open("/admin/settings/access", "Access & sign-in");
    const user = userEvent.setup();
    expect(await screen.findByRole("checkbox", { name: "Board" })).toBeChecked();
    // The stale id alone does not make the form dirty.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    // The expiry applies to requests made from now on, and says so.
    expect(screen.getByText(/^Applies to new requests\./u)).toBeInTheDocument();
    const days = screen.getByRole("spinbutton", { name: "Pending requests expire after (days)" });
    await user.clear(days);
    await user.type(days, "14");
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      requests: {
        enabled: true,
        autoApproveDomains: [],
        defaultGroupIds: [BOARD_ID],
        pendingExpiryDays: 14,
      },
    });
  }, 20_000);

  it("says auto-approve does not apply under Rule 506(b)", async () => {
    handlers({}, undefined, "owner", "506b");
    const r = await open("/admin/settings/access", "Access & sign-in");
    expect(
      await screen.findByText(
        /Auto-approve does not apply while the offering is under Rule 506\(b\)/u,
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends a stale admin to step-up on save", async () => {
    handlers({
      "PATCH /api/v1/access/settings": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await open("/admin/settings/access", "Access & sign-in");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Allow delegates" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fsettings%2Faccess");
  }, 20_000);

  it("is read-only without access.settings and refused without access.read", async () => {
    handlers({}, ["access.read"], "legal");
    const r = await open("/admin/settings/access", "Access & sign-in");
    expect(
      await screen.findByRole("switch", { name: "Require two-step sign-in for staff" }),
    ).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Accept access requests" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Auto-approve email domains" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await expectNoA11yViolations(r.container);
    r.unmount();

    const { calls } = handlers({}, []);
    await renderApp("/admin/settings/access");
    expect(
      await screen.findByText(
        "Only workspace owners, admins and legal staff can see access settings.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/access/settings")).toBe(false);
  }, 20_000);
});

describe("modules page settings links", () => {
  it("links a module to its first admin.settings entry", async () => {
    handlers({
      "GET /api/v1/modules/enablement": () => [
        200,
        {
          modules: [
            moduleEnablement({ id: "access", locked: true, lockedReason: "required" }),
            moduleEnablement({ id: "updates" }),
            moduleEnablement({ id: "crm" }),
          ],
        },
      ],
    });
    const r = await open("/admin/modules", "Modules");
    expect(await screen.findByRole("link", { name: "access settings" })).toHaveAttribute(
      "href",
      "/admin/settings/access",
    );
    expect(screen.getByRole("link", { name: "updates settings" })).toHaveAttribute(
      "href",
      "/admin/updates/settings",
    );
    expect(screen.queryByRole("link", { name: "crm settings" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
