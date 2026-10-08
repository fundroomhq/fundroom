import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, login, me, membership, session, testConfig } from "../test/fixtures.js";
import {
  apiError,
  branding,
  type Handler,
  installMockApi,
  moduleEnablement,
  offeringState,
  planLockedModule,
  readOnlyModule,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The first-run wizard: token → owner → secure → mail → storage (E0.8) → company → offering →
 * domain (E2.1) → modules → data room → invitations → first update → done (E1.7). The
 * walk-through is one long
 * test on purpose — the steps are a sequence, and a per-step test would have to fake the
 * sequence to reach the step it cares about. Resumption and the step-up refusal get their own.
 */
afterEach(() => vi.unstubAllGlobals());

const TOKEN = "e2e-setup-token-0123456789";

type Progress = {
  owner: boolean;
  mail: boolean;
  storage: boolean;
  branding: boolean;
  offering: boolean;
};

function status(required = true, progress: Partial<Progress> = {}) {
  return {
    required,
    tenancy: "single",
    instanceName: "FundRoom",
    baseUrl: "https://investors.acme.test/",
    passwordEnabled: false,
    drivers: { storage: "fs", mail: "smtp" },
    ...(required ? { tokenSource: "generated" } : {}),
    probes: { mail: "pending", storage: "pending" },
    progress: {
      owner: !required,
      mail: false,
      storage: false,
      branding: false,
      offering: false,
      ...progress,
    },
  };
}

/** A signed-in staff owner: what tells the wizard a reload is a resume, not a stranger. */
const ownerMe = () =>
  me({
    session: session({ population: "staff", authLevel: 2 }),
    membership: membership({ kind: "staff", role: "owner" }),
  });

/** A-5: the owner signup just made, on the level-1 session an email code gives. */
const levelOneOwnerMe = () =>
  me({
    session: session({ population: "staff", authLevel: 1 }),
    membership: membership({ kind: "staff", role: "owner" }),
  });

/** Everything the six new steps read, so a test only overrides what it is about. */
function moduleHandlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/v1/branding": () => [
      200,
      branding({ displayName: null, tagline: null, accentColor: null }),
    ],
    "PATCH /api/v1/branding": () => [200, branding()],
    "POST /api/v1/branding/logo/fetch": () => [200, branding({ logo: null })],
    "GET /api/v1/compliance/offering": () => [200, offeringState({ status: "none" })],
    "PATCH /api/v1/compliance/offering": () => [
      200,
      {
        from: "none",
        to: "506b",
        current: offeringState().current,
        permits: {},
        irrevocable: false,
      },
    ],
    "POST /api/v1/domains": ({ body }) => [
      201,
      {
        id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5901",
        hostname: (body as { hostname: string }).hostname,
        status: "pending",
        records: [
          {
            type: "CNAME",
            name: (body as { hostname: string }).hostname,
            value: "edge.fundroom.test",
            required: true,
          },
          {
            type: "TXT",
            name: `_fundroom-challenge.${(body as { hostname: string }).hostname}`,
            value: "k7q2v9x4m3n8b5c1z6t0r7y2w4e9u3i8",
            required: true,
          },
        ],
        answer: null,
        detail: null,
        consecutiveFailures: 0,
        firstAttemptAt: "2026-09-12T10:00:00.000Z",
        deadlineAt: "2026-09-15T10:00:00.000Z",
        lastCheckedAt: null,
        dnsOkAt: null,
        activatedAt: null,
        createdAt: "2026-09-12T10:00:00.000Z",
        updatedAt: "2026-09-12T10:00:00.000Z",
      },
    ],
    "GET /api/v1/modules/enablement": () => [
      200,
      {
        modules: [
          moduleEnablement({ id: "updates" }),
          moduleEnablement({ id: "data-room" }),
          moduleEnablement({ id: "analytics", enabled: false }),
          moduleEnablement({ id: "access", locked: true, lockedReason: "required" }),
        ],
      },
    ],
    "PATCH /api/v1/modules/{id}": () => [200, moduleEnablement({ id: "analytics", enabled: true })],
    "GET /api/v1/data-room/templates": () => [
      200,
      {
        templates: [
          {
            id: "seed",
            name: "Seed",
            description: "The folders a seed round usually needs",
            folders: ["Company", "Company / Legal", "Financials"],
          },
        ],
      },
    ],
    "POST /api/v1/data-room/templates/{id}/apply": () => [
      200,
      { created: 3, tree: { folders: [] } },
    ],
    "POST /api/v1/access/invites": () => [
      200,
      {
        created: [{ email: "ada@investor.test" }],
        failed: [{ email: "sam@acme.test", code: "conflict" }],
      },
    ],
    "GET /api/v1/updates/posts": () => [200, { posts: [] }],
    "GET /api/v1/updates/templates": () => [
      200,
      { templates: [{ key: "yc", name: "YC monthly update", description: "Recap", doc: {} }] },
    ],
    "POST /api/v1/updates/posts": () => [201, { post: { title: "October update" } }],
    ...over,
  };
}

describe("setup wizard", () => {
  it("walks from the token to the done card, calling each endpoint", async () => {
    let created = false;
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(!created)],
        "GET /api/v1/me": () => (created ? [200, ownerMe()] : apiError(401, "unauthenticated")),
        "POST /api/v1/setup/token/verify": (req) =>
          (req.body as { token?: string } | undefined)?.token === TOKEN
            ? [200, { ok: true }]
            : apiError(401, "invalid_credential"),
        "POST /api/v1/setup/owner": () => {
          created = true;
          return [
            200,
            {
              ...login({ membership: { id: "m", kind: "staff", role: "owner", status: "active" } }),
              workspace: { id: "w", slug: "acme-inc", name: "Acme Inc." },
            },
          ];
        },
        "POST /api/v1/setup/probes/mail": () => [
          200,
          { ok: true, driver: "smtp", latencyMs: 42, detail: "<id>" },
        ],
        "POST /api/v1/setup/probes/storage": () => [
          200,
          { ok: true, driver: "fs", latencyMs: 7, detail: "setup/probe-x.txt" },
        ],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: true, workspace: null }));
    const user = userEvent.setup();

    expect(
      await screen.findByRole("heading", { name: /Enter the setup token/u }),
    ).toBeInTheDocument();
    expect(screen.getByText(/printed a one-time setup token/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    // Wrong token: inline error, still on the token step.
    await user.type(screen.getByLabelText(/Setup token/u), "not-the-token-0123456789");
    await user.click(screen.getByRole("button", { name: /Continue/u }));
    expect(await screen.findByText(/does not match/u)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Setup token/u));
    await user.type(screen.getByLabelText(/Setup token/u), TOKEN);
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Owner step.
    expect(
      await screen.findByRole("heading", { name: /Create the owner account/u }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Your name/u), "Sam Founder");
    await user.type(screen.getByLabelText(/Your email address/u), "sam@acme.test");
    await user.type(screen.getByLabelText(/Company or workspace name/u), "Acme Inc.");
    expect(screen.getByText(/acme-inc on investors\.acme\.test/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Create account and workspace/u }));
    const owner = calls.find((c) => c.path === "/api/v1/setup/owner");
    expect(owner?.body).toEqual({
      token: TOKEN,
      email: "sam@acme.test",
      displayName: "Sam Founder",
      workspaceName: "Acme Inc.",
    });

    // Secure step (jsdom has no WebAuthn → no passkey option), skipped.
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add passkey/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Skip for now/u }));

    // Mail probe.
    expect(
      await screen.findByRole("heading", { name: /Check outbound email/u }),
    ).toBeInTheDocument();
    expect(screen.getByText(/configured mailer \(smtp\)/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Send me a test email/u }));
    expect(await screen.findByText(/42 ms/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Storage probe.
    expect(
      await screen.findByRole("heading", { name: /Check document storage/u }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Run storage check/u }));
    expect(await screen.findByText(/7 ms/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Company basics: name, tagline, accent, and the logo pulled from the company website.
    expect(await screen.findByRole("heading", { name: /Company basics/u })).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Display name/u), "Acme Ventures");
    await user.type(screen.getByLabelText(/Tagline/u), "Building the boring parts");
    await user.clear(screen.getByLabelText("Accent colour"));
    await user.type(screen.getByLabelText("Accent colour"), "#1d4ed8");
    await user.type(screen.getByLabelText(/take it from your website/u), "https://acme.test");
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/branding/logo/fetch")?.body).toEqual({
        url: "https://acme.test",
      }),
    );
    await user.click(screen.getByRole("button", { name: /Save and continue/u }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/branding")?.body,
      ).toEqual({
        displayName: "Acme Ventures",
        tagline: "Building the boring parts",
        accentColor: "#1d4ed8",
      }),
    );

    // Offering mode: four plain-English choices and the "not legal advice" framing.
    expect(
      await screen.findByRole("heading", { name: /How are you raising/u }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This is not legal advice/u)).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("radio", { name: /Rule 506\(b\)/u }));
    await user.click(screen.getByRole("button", { name: /Set offering mode/u }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/compliance/offering")?.body,
      ).toEqual({ status: "506b" }),
    );

    // Portal address: three answers, and two of them are "nothing to do here".
    expect(
      await screen.findByRole("heading", { name: /Where should investors find/u }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("radio", { name: /Use a domain you own/u }));
    await user.type(screen.getByLabelText("Hostname"), "investors.acme.test");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/domains")?.body).toEqual({
        hostname: "investors.acme.test",
      }),
    );
    // The records, not a verification: verifying belongs on the admin screen, and DNS will not
    // have propagated while the founder is still in the wizard anyway.
    expect(
      await screen.findByRole("table", { name: "DNS records for investors.acme.test" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/_fundroom-challenge\.investors\.acme\.test/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Modules: defaults on, a locked module disabled with its reason.
    expect(
      await screen.findByRole("heading", { name: /Choose what the portal does/u }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "access" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Always on")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "analytics" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/modules/analytics")?.body).toEqual({
        enabled: true,
      }),
    );
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Data room: a folder template, applied.
    expect(
      await screen.findByRole("heading", { name: /Start the data room/u }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Company · Company \/ Legal · Financials/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Create these folders/u }));
    expect(await screen.findByText(/Created 3 folders/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Invitations: the partial-failure shape is reported address by address.
    expect(
      await screen.findByRole("heading", { name: /Invite your first investors/u }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText(/Email addresses/u),
      "ada@investor.test, sam@acme.test\nnot-an-email",
    );
    expect(screen.getByText(/2 ready to invite/u)).toBeInTheDocument();
    expect(screen.getByText(/left out: not-an-email/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Send invitations/u }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/access/invites")?.body).toEqual({
        invites: [{ email: "ada@investor.test" }, { email: "sam@acme.test" }],
        kind: "external",
        role: "investor",
      }),
    );
    expect(await screen.findByText(/Invited 1 people/u)).toBeInTheDocument();
    expect(screen.getByText(/already a member of this workspace/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // First update: one draft, and the form goes away the moment it exists.
    expect(
      await screen.findByRole("heading", { name: /Draft your first update/u }),
    ).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Update title/u), "October update");
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Save draft/u }));
    expect(await screen.findByText(/October update/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save draft/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/u }));

    // Done card: the portal URL (there is no domain step), three next things, a link to admin.
    expect(await screen.findByRole("heading", { name: /You're all set/u })).toBeInTheDocument();
    expect(screen.getByText(/Acme Inc\. is ready/u)).toBeInTheDocument();
    expect(screen.getByText("https://investors.acme.test/")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("listitem")
        .filter((li) => /Admin →|investor update/u.test(li.textContent ?? "")),
    ).toHaveLength(3);
    expect(screen.getByRole("link", { name: /Open admin/u })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("navigation", { name: /Setup steps/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        "POST /api/v1/setup/token/verify",
        "POST /api/v1/setup/owner",
        "POST /api/v1/setup/probes/mail",
        "POST /api/v1/setup/probes/storage",
        "PATCH /api/v1/branding",
        "PATCH /api/v1/compliance/offering",
        "POST /api/v1/domains",
        "POST /api/v1/data-room/templates/seed/apply",
        "POST /api/v1/access/invites",
        "POST /api/v1/updates/posts",
      ]),
    );
  }, 20_000);

  it("resumes at the first step the kernel says is unfinished", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: false }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false }));
    expect(await screen.findByRole("heading", { name: /Company basics/u })).toBeInTheDocument();
    // The step is in the URL, so the next reload lands here too.
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=company"));
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("resumes at the modules step once every kernel fact is true", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    await renderApp("/setup", testConfig({ setupRequired: false }));
    expect(
      await screen.findByRole("heading", { name: /Choose what the portal does/u }),
    ).toBeInTheDocument();
  }, 20_000);

  // A-3 (ADR-0063): the modules step shows what the plan leaves out, as the modules page does.
  it("greys out modules the plan leaves out and asks before switching off a read-only one", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/modules": () => [
          200,
          bootstrap({
            permissions: ["billing.read"],
            membership: {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01",
              kind: "staff",
              role: "owner",
            },
          }),
        ],
        "GET /api/v1/modules/enablement": () => [
          200,
          {
            modules: [
              moduleEnablement({ id: "updates" }),
              planLockedModule("metrics"),
              readOnlyModule("crm"),
            ],
          },
        ],
        "PATCH /api/v1/modules/{id}": () => [200, moduleEnablement({ id: "crm", enabled: false })],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false, billing: true }));
    const metrics = await screen.findByRole("switch", { name: "metrics" }, { timeout: 5000 });
    // Unavailable but focusable, described by its badge (RR3 RL3).
    expect(metrics).toHaveAttribute("aria-disabled", "true");
    expect(metrics).toHaveAccessibleDescription(/Not on your plan/u);
    const row = metrics.closest("li") as HTMLElement;
    expect(within(row).getByText("Not on your plan")).toBeInTheDocument();
    expect(
      await within(row).findByRole("link", { name: "Go to billing" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const crm = screen.getByRole("switch", { name: "crm" });
    expect(
      within(crm.closest("li") as HTMLElement).getByText("Read-only on your plan"),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(crm);
    const dialog = await screen.findByRole("dialog", { name: "Turn off crm?" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/modules/crm")?.body).toEqual({ enabled: false }),
    );
    // Focus comes back to the switch, which stays focusable (R3 L2 / RR3 RL3).
    await waitFor(() => expect(crm).toHaveFocus());
    expect(crm).not.toBeDisabled();
  }, 20_000);

  // R3 L11: a refused switch says why instead of failing silently.
  it("says why the modules step could not switch a module", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
        "PATCH /api/v1/modules/{id}": () =>
          apiError(402, "plan_limit", { limit: "module", module: "analytics" }),
      }),
    );
    await renderApp("/setup", testConfig({ setupRequired: false }));
    await userEvent
      .setup()
      .click(await screen.findByRole("switch", { name: "analytics" }, { timeout: 5000 }));
    expect(await screen.findByText("Not on your plan: analytics")).toBeInTheDocument();
  }, 20_000);

  /*
   * The domain step is optional by design (E2.1 §3): a founder on the subdomain, and one who
   * will embed the portal, are both finished with the question. So it has no kernel fact, it is
   * not in `resumeStep`, and skipping it must cost nothing — which is exactly the mistake E1.7
   * made with `hasBrand` and had to take back out.
   */
  it("lets a founder past the domain step without adding one", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp("/setup?step=domain", testConfig({ setupRequired: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: /Where should investors find/u },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    // Keeping the address the portal came with is the default, so the step is one click.
    expect(screen.getByRole("radio", { name: /Keep the address it came with/u })).toBeChecked();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Continue/u }));
    expect(
      await screen.findByRole("heading", { name: /Choose what the portal does/u }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/domains")).toBe(false);
  }, 20_000);

  it("still resumes at modules when the founder never chose an address", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: /Choose what the portal does/u },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=modules"));
    // Offered in the sidebar, and still not a gate: there is no fact to be unfinished.
    expect(screen.getByRole("navigation", { name: /Setup steps/u }).textContent).toMatch(
      /Address/u,
    );
  }, 20_000);

  it("honours an explicit step in the URL and drops the steps whose module is off", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false, { mail: true, storage: true })],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/modules/enablement": () => [200, { modules: [] }],
      }),
    );
    await renderApp("/setup?step=dataroom", testConfig({ setupRequired: false }));
    // No data-room module: the step is not offered, and the wizard shows the next one that is.
    expect(
      await screen.findByRole("heading", { name: /Invite your first investors/u }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: /Setup steps/u });
    expect(nav.textContent).not.toMatch(/Data room/u);
    expect(nav.textContent).not.toMatch(/First update/u);
  }, 20_000);

  it("sends a founder who skipped the security step back to it instead of working around it", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/compliance/offering": () =>
          apiError(403, "step_up_required", { reason: "level" }),
      }),
    );
    const r = await renderApp("/setup?step=offering", testConfig({ setupRequired: false }));
    expect(
      await screen.findByText(/Finish the security step first/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Back to the security step/u }));
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }),
    ).toBeInTheDocument();
  }, 20_000);

  it("asks for confirmation before switching to Rule 506(c), then echoes it back", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
        "PATCH /api/v1/compliance/offering": ({ body }) =>
          (body as { confirm?: string }).confirm === "506c"
            ? [
                200,
                {
                  from: "none",
                  to: "506c",
                  current: offeringState({ status: "506c" }).current,
                  permits: {},
                  irrevocable: true,
                },
              ]
            : apiError(409, "conflict", { requiresConfirmation: true }),
      }),
    );
    await renderApp("/setup?step=offering", testConfig({ setupRequired: false }));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("radio", { name: /Rule 506\(c\)/u }, { timeout: 5000 }),
    );
    expect(screen.getByText(/Rule 506\(c\) cannot be undone/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Set offering mode/u }));
    expect(await screen.findByText(/Confirm the switch to Rule 506\(c\)/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Yes, switch permanently/u }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PATCH" && c.path === "/api/v1/compliance/offering").at(-1)
          ?.body,
      ).toEqual({ status: "506c", confirm: "506c" }),
    );
  }, 20_000);

  it("will not create a second draft when the workspace already has one", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [
          200,
          status(false, { mail: true, storage: true, branding: true, offering: true }),
        ],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/updates/posts": () => [200, { posts: [{ id: "p1", title: "September" }] }],
      }),
    );
    await renderApp("/setup?step=update", testConfig({ setupRequired: false }));
    expect(
      await screen.findByText(/already has 1 draft or sent update/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save draft/u })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/updates/posts")).toBe(
      false,
    );
  }, 20_000);

  // A-5 D8: under the control plane the host runs mail and storage, and signup made the owner.
  it("leaves out the token, mail and storage steps under the control plane", async () => {
    installMockApi(
      moduleHandlers({
        // Mail and storage never probed: a hosted wizard does not stop there anyway.
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByRole("heading", { name: /Company basics/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=company"));
    const nav = screen.getByRole("navigation", { name: /Setup steps/u });
    expect(within(nav).queryByText("Setup token")).toBeNull();
    expect(within(nav).queryByText("Email")).toBeNull();
    expect(within(nav).queryByText("Storage")).toBeNull();
    expect(within(nav).getByText("Your account")).toBeInTheDocument();
    // An old link to a hosted step lands on the next step that exists.
    await r.router.navigate({ to: "/setup", search: { step: "mail" } });
    expect(
      await screen.findByRole("heading", { name: /Company basics/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("shows the workspace's own address when done under the control plane, with the footer", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp(
      "/setup?step=done",
      testConfig({
        setupRequired: false,
        controlPlane: true,
        canonicalOrigin: "https://acme.fundroom.test",
        links: { terms: "https://fundroom.test/terms", privacy: null, support: null, status: null },
      }),
    );
    expect(await screen.findByText("Your portal is live at", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("https://acme.fundroom.test/")).toBeInTheDocument();
    // `baseUrl` is the install's canonical host under the control plane, not this workspace.
    expect(screen.queryByText("https://investors.acme.test/")).toBeNull();
    expect(screen.getByText(/add it under Admin → Domains/u)).toBeInTheDocument();
    const footer = screen.getByRole("navigation", { name: "Footer" });
    expect(
      within(footer)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Terms", "Accessibility"]);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("does not double a path mount in the done address", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    await renderApp(
      "/fr/w/acme/setup?step=done",
      testConfig({
        setupRequired: false,
        controlPlane: true,
        basePath: "/fr",
        routerBase: "/fr/w/acme",
        canonicalOrigin: "https://fundroom.test/fr/w/acme",
      }),
    );
    expect(
      await screen.findByText("https://fundroom.test/fr/w/acme/", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("keeps showing the install's address when done without the control plane", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    await renderApp("/setup?step=done", testConfig({ setupRequired: false }));
    expect(
      await screen.findByText("https://investors.acme.test/", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  // A-5 D7: a new hosted workspace is held for a short check; every setup route answers 423.
  it("says the new workspace is being checked, and checks again on request", async () => {
    let held = true;
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () =>
          held
            ? apiError(423, "workspace_unavailable", {
                details: { workspaceStatus: "pending_review", reason: null },
              })
            : [200, status(false, { branding: false })],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp(
      "/setup",
      testConfig({
        setupRequired: false,
        controlPlane: true,
        workspaceStatus: { status: "pending_review", reason: null },
      }),
    );
    expect(
      await screen.findByText("Checking your new workspace", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/standard check on new workspaces/u)).toBeInTheDocument();
    // Never the generic "unavailable" error, and never what the check is.
    expect(screen.queryByText(/sanction/iu)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(r.container);

    held = false;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("heading", { name: /Company basics/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/v1/setup/status").length).toBeGreaterThan(1);
  }, 20_000);

  it("says the same when a step is refused while the workspace is held", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/branding": () =>
          apiError(423, "workspace_unavailable", {
            details: { workspaceStatus: "pending_review", reason: null },
          }),
      }),
    );
    await renderApp(
      "/setup?step=company",
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    expect(
      await screen.findByText("Checking your new workspace", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  }, 20_000);

  it("resumes a founder on the level-1 signup session at the security step", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=secure"));
  }, 20_000);

  it("offers the security step while the workspace is held, and not a 423 for it", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () =>
          apiError(423, "workspace_unavailable", {
            details: { workspaceStatus: "pending_review", reason: null },
          }),
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
      }),
    );
    const r = await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByText("Checking your new workspace", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  /** The TOTP enrolment endpoints; `me` answers whatever level the test says, read per call. */
  function totpHandlers(level: () => 1 | 2): Record<string, Handler> {
    return {
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({ population: "staff", authLevel: level() }),
          membership: membership({ kind: "staff", role: "owner" }),
        }),
      ],
      "POST /api/v1/auth/totp/enrol": () => [
        200,
        {
          credentialId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5999",
          secretBase32: "JBSWY3DPEHPK3PXP",
          otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        },
      ],
      "POST /api/v1/auth/totp/enrol/confirm": () => [200, { recoveryCodes: ["aaaa-bbbb"] }],
    };
  }

  async function enrolTotp(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }));
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
  }

  const BILLING_BACK = `/setup?step=secure&returnTo=${encodeURIComponent("/admin/billing?plan=growth")}`;
  /** Where a step-up from the security step returns: the step itself, then on to billing. */
  const STEPPED_BILLING = `/setup?step=secure&stepped=1&returnTo=${encodeURIComponent(
    "/admin/billing?plan=growth",
  )}`;

  it("goes back to the page that asked for a second factor once the session is level 2", async () => {
    let level: 1 | 2 = 1;
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        ...totpHandlers(() => level),
        "POST /api/v1/auth/totp/enrol/confirm": () => {
          level = 2;
          return [200, { recoveryCodes: ["aaaa-bbbb"] }];
        },
      }),
    );
    const r = await renderApp(
      BILLING_BACK,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    // Skipping would only lead back to the page that refused (M2).
    expect(
      await screen.findByRole("heading", { name: /Secure your account/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    await enrolTotp(userEvent.setup());
    await waitFor(() => expect(r.router.state.location.href).toBe("/admin/billing?plan=growth"));
  }, 20_000);

  // H2: a new factor that left the session at level 1 (a passkey that did not verify the user;
  // one that did raises it as it registers, E-UP-18 D2) — the fresh `/me` says so, and step-up
  // does.
  it("goes through step-up when the new factor left the session at level 1", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        ...totpHandlers(() => 1),
      }),
    );
    const r = await renderApp(
      BILLING_BACK,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    await enrolTotp(userEvent.setup());
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(
        `/auth/step-up?returnTo=${encodeURIComponent(STEPPED_BILLING)}&reason=level`,
      ),
    );
  }, 20_000);

  /** An owner who has a factor already, back on a level-1 session (an email code). */
  const enrolledLevelOneMe = () =>
    me({
      session: session({
        population: "staff",
        authLevel: 1,
        user: { displayName: "Sam", mfaEnrolled: true, locale: null },
      }),
      membership: membership({ kind: "staff", role: "owner" }),
    });

  // M-A: enrolling from a level-1 session is refused; confirming with the factor is the way.
  it("asks an owner who already has a factor to confirm it, not to enrol another", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, enrolledLevelOneMe()],
      }),
    );
    await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    const link = await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 });
    expect(link).toHaveAttribute(
      "href",
      `/auth/step-up?returnTo=${encodeURIComponent(
        `/setup?step=secure&stepped=1&returnTo=${encodeURIComponent("/setup?step=company")}`,
      )}&reason=level`,
    );
    // No enrol list (a level-1 session with a factor may not add one); the app is offered
    // only as the server's call, beside the confirmation.
    expect(screen.queryByRole("button", { name: /^Set up$/u })).toBeNull();
  }, 20_000);

  it("asks the same while the workspace is held, returning to the page that asked", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () =>
          apiError(423, "workspace_unavailable", {
            details: { workspaceStatus: "pending_review", reason: null },
          }),
        "GET /api/v1/me": () => [200, enrolledLevelOneMe()],
      }),
    );
    await renderApp(BILLING_BACK, testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByText("Checking your new workspace", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 });
    expect(link).toHaveAttribute(
      "href",
      `/auth/step-up?returnTo=${encodeURIComponent(STEPPED_BILLING)}&reason=level`,
    );
  }, 20_000);

  it("offers step-up when enrolling is refused for want of it", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
        "POST /api/v1/auth/totp/enrol": () =>
          apiError(403, "step_up_required", { reason: "level" }),
      }),
    );
    await renderApp("/setup?step=secure", testConfig({ setupRequired: false, controlPlane: true }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }));
    expect(
      await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  // L2: skipping goes where the wizard would resume, not back through mail and storage.
  it("skips the security step to where the wizard would otherwise resume", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false, { mail: true, storage: true })],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp("/setup?step=secure", testConfig({ setupRequired: false }));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Skip for now" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=company"));
  }, 20_000);

  // L4: held, the status is unreadable — the hosted wizard still has no token step.
  it("never lists the token step for a hosted workspace, even while held", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () =>
          apiError(423, "workspace_unavailable", {
            details: { workspaceStatus: "pending_review", reason: null },
          }),
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    const nav = await screen.findByRole("navigation", { name: /Setup steps/u }, { timeout: 5000 });
    await screen.findByText("Checking your new workspace", {}, { timeout: 5000 });
    expect(within(nav).queryByText("Setup token")).toBeNull();
  }, 20_000);

  // Round 3 LOW: a level-1 skip to a step that needs level 2 only comes back here.
  it("offers no skip to a level-1 session whose next step needs level 2", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
      }),
    );
    await renderApp("/setup?step=secure", testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  }, 20_000);

  it("still offers the skip to a level-1 session whose next step is the mail check", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
      }),
    );
    await renderApp("/setup?step=secure", testConfig({ setupRequired: false }));
    expect(
      await screen.findByRole("button", { name: "Skip for now" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  /** A session handed over by central auth: bound to this workspace, no factor yet. */
  const boundMe = () => {
    const who = levelOneOwnerMe();
    (who.session as { boundWorkspaceId?: string }).boundWorkspaceId = "w";
    return who;
  };

  // Round 3 HIGH: a central-bound session may not change the account (`bound_session_restricted`).
  it("sends a central-auth session with no factor to sign in by email code, and back", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, boundMe()],
        "POST /api/v1/auth/logout": () => [200, { ok: true }],
      }),
    );
    const r = await renderApp(
      BILLING_BACK,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    const button = await screen.findByRole(
      "button",
      { name: "Sign in with an email code" },
      { timeout: 5000 },
    );
    expect(screen.queryByRole("button", { name: /Set up/u })).toBeNull();
    // Round 4 L2: a workspace host can take an authenticator app, not a passkey.
    expect(screen.getByText(/then add an authenticator app\./u)).toBeInTheDocument();
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(`/login?returnTo=${encodeURIComponent(BILLING_BACK)}`),
    );
    expect(calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(true);
  }, 20_000);

  it("reads a bound-session refusal of enrolment the same way", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
        "POST /api/v1/auth/totp/enrol": () => apiError(403, "bound_session_restricted"),
      }),
    );
    await renderApp("/setup?step=secure", testConfig({ setupRequired: false, controlPlane: true }));
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }));
    expect(
      await screen.findByRole("button", { name: "Sign in with an email code" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  // Round 3 MEDIUM: back from step-up still at level 1 (a passkey without user verification).
  it("explains a confirmation that did not verify and offers an authenticator app", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, enrolledLevelOneMe()],
        "POST /api/v1/auth/totp/enrol": () => [
          200,
          {
            credentialId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5999",
            secretBase32: "JBSWY3DPEHPK3PXP",
            otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
          },
        ],
      }),
    );
    await renderApp(STEPPED_BILLING, testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByText(/did not verify you/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Set up an authenticator app" }));
    expect(await screen.findByLabelText(/Code from the app/u)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/auth/totp/enrol")).toBe(true);
  }, 20_000);

  // Round 4 H2: the authenticator app added here makes the session level 2 — the codes first.
  it("shows the recovery codes of an app added after a step-up before going on", async () => {
    let level: 1 | 2 = 1;
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        ...totpHandlers(() => level),
        "GET /api/v1/me": () => {
          const who = enrolledLevelOneMe();
          who.session.authLevel = level;
          return [200, who];
        },
        "POST /api/v1/auth/totp/enrol/confirm": () => {
          level = 2;
          return [200, { recoveryCodes: ["aaaa-bbbb"] }];
        },
      }),
    );
    const r = await renderApp(
      STEPPED_BILLING,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Set up an authenticator app" }, { timeout: 5000 }),
    );
    await user.type(await screen.findByLabelText(/Code from the app/u), "135790");
    await user.click(screen.getByRole("button", { name: /Confirm code/u }));
    expect(await screen.findByText("aaaa-bbbb")).toBeInTheDocument();
    // Still here, a moment later, with the codes on screen.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.router.state.location.pathname).toBe("/setup");
    expect(screen.getByText("aaaa-bbbb")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(r.router.state.location.href).toBe("/admin/billing?plan=growth"));
  }, 20_000);

  // Round 4 M2: the email-code way out is for an account with nothing to confirm with.
  it("asks a central-auth session that has a factor to confirm it, not to sign in again", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => {
          const who = enrolledLevelOneMe();
          (who.session as { boundWorkspaceId?: string }).boundWorkspaceId = "w";
          return [200, who];
        },
      }),
    );
    await renderApp(BILLING_BACK, testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with an email code" })).toBeNull();
    // A bound session may not add an app either: not offered.
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 20_000);

  // Round 4 L1: `stepped` means nothing without a factor, and never rides into a fresh sign-in.
  it("drops the step-up marker for a session with no factor", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, boundMe()],
        "POST /api/v1/auth/logout": () => [200, { ok: true }],
      }),
    );
    const r = await renderApp(
      STEPPED_BILLING,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    const button = await screen.findByRole(
      "button",
      { name: "Sign in with an email code" },
      { timeout: 5000 },
    );
    expect(screen.queryByText(/did not verify you/u)).toBeNull();
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(`/login?returnTo=${encodeURIComponent(BILLING_BACK)}`),
    );
  }, 20_000);

  // Round 5 M2(a): a central-bound session back from a step-up still at level 1 (a passkey that
  // does not verify) would only go round again; an ordinary sign-in here can confirm the key
  // and then add an app. Billing's "Confirm it's you" leads here too.
  it("offers a central-auth session that did not verify a sign-in by email code", async () => {
    const { calls } = installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => {
          const who = enrolledLevelOneMe();
          (who.session as { boundWorkspaceId?: string }).boundWorkspaceId = "w";
          return [200, who];
        },
        "POST /api/v1/auth/logout": () => [200, { ok: true }],
      }),
    );
    const r = await renderApp(
      STEPPED_BILLING,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    const button = await screen.findByRole(
      "button",
      { name: "Sign in with an email code" },
      { timeout: 5000 },
    );
    expect(screen.getByText(/did not verify you/u)).toBeInTheDocument();
    expect(
      screen.getByText(/can confirm your passkey and then add an authenticator app/u),
    ).toBeInTheDocument();
    // Confirming again is still there, second; an app is not (the server refuses a bound one).
    expect(screen.getByRole("link", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(`/login?returnTo=${encodeURIComponent(BILLING_BACK)}`),
    );
    expect(calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(true);
  }, 20_000);

  // Round 6 MEDIUM: before any confirmation the server refuses an app (no presence proof).
  it("offers an owner with a factor no authenticator app before a confirmation", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, enrolledLevelOneMe()],
      }),
    );
    await renderApp(BILLING_BACK, testConfig({ setupRequired: false, controlPlane: true }));
    expect(
      await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
  }, 20_000);

  // Round 5 L4: `stepped` is honoured only for an account that has a factor to have confirmed.
  it("ignores the step-up marker for an ordinary session with no factor", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, levelOneOwnerMe()],
        "POST /api/v1/auth/totp/enrol": () =>
          apiError(403, "step_up_required", { reason: "level" }),
      }),
    );
    await renderApp(STEPPED_BILLING, testConfig({ setupRequired: false, controlPlane: true }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Set up/u }, { timeout: 5000 }));
    expect(
      await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Confirm it's you with it to go on/u)).toBeInTheDocument();
    expect(screen.queryByText(/did not verify you/u)).toBeNull();
  }, 20_000);

  // Round 5 L4: signed out on the step-up screen — the sign-in afresh carries no marker.
  it("drops the step-up marker when the step-up screen sends a signed-out visitor to sign in", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/auth/sso": () => [
        200,
        { available: false, name: null, protocol: null, enforced: false },
      ],
    });
    const r = await renderApp(
      `/auth/step-up?returnTo=${encodeURIComponent(STEPPED_BILLING)}&reason=level`,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(`/login?returnTo=${encodeURIComponent(BILLING_BACK)}`),
    );
  }, 20_000);

  // Round 4 L3: the wizard only ever sends anyone to its own routes.
  it("ignores a return path to a server route", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false, { mail: true, storage: true })],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp(
      `/setup?step=secure&returnTo=${encodeURIComponent("/auth/central/finish?code=x")}`,
      testConfig({ setupRequired: false }),
    );
    // No page to go back to, so the wizard's own skip is there and goes on through the wizard.
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Skip for now" }, { timeout: 5000 }));
    await waitFor(() => expect(r.router.state.location.searchStr).toBe("?step=company"));
  }, 20_000);

  it("goes on to the page that asked once a step-up has raised the session", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
      }),
    );
    const r = await renderApp(
      STEPPED_BILLING,
      testConfig({ setupRequired: false, controlPlane: true }),
    );
    await waitFor(() => expect(r.router.state.location.href).toBe("/admin/billing?plan=growth"));
  }, 20_000);

  // H1: signup signs the founder in on the canonical host only.
  it("sends a signed-out visitor of a hosted workspace's wizard to sign in, and back", async () => {
    installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/setup/status": () => apiError(404, "not_found"),
    });
    const r = await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    await waitFor(() => expect(pathOf(r.router)).toBe("/login?returnTo=%2Fsetup"));
  }, 20_000);

  // E-UP-11 (replaces A-5's M1): no first run under the control plane, not even on the canonical
  // host before its first workspace — the token step is never offered there.
  it("never offers the token step on the canonical host under the control plane", async () => {
    // Even a status saying "required" (a server from before E-UP-11) offers no token step.
    installMockApi({
      "GET /api/v1/setup/status": () => [200, status(true)],
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    });
    await renderApp(
      "/setup",
      testConfig({ setupRequired: true, workspace: null, controlPlane: true }),
    );
    const nav = await screen.findByRole("navigation", { name: /Setup steps/u }, { timeout: 5000 });
    expect(within(nav).queryByText("Setup token")).toBeNull();
    expect(screen.queryByLabelText(/Setup token/u)).toBeNull();
  }, 20_000);

  // E-UP-11 fix round 1 L3: there, "set up" means "sign up".
  it("points the canonical host's /setup at signup under the control plane", async () => {
    installMockApi({
      "GET /api/v1/setup/status": () => [200, status(false)],
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    });
    await renderApp(
      "/setup",
      testConfig({ setupRequired: false, workspace: null, controlPlane: true, signup: true }),
    );
    const signup = await screen.findByRole(
      "link",
      { name: "Create a workspace" },
      { timeout: 5000 },
    );
    expect(signup).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByText("Setup is complete")).toBeNull();
  }, 20_000);

  it("never reads a step-up refusal as the hold", async () => {
    installMockApi(
      moduleHandlers({
        "GET /api/v1/setup/status": () => [200, status(false)],
        "GET /api/v1/me": () => [200, ownerMe()],
        "GET /api/v1/branding": () => apiError(403, "step_up_required", { reason: "level" }),
      }),
    );
    await renderApp(
      "/setup?step=company",
      testConfig({
        setupRequired: false,
        controlPlane: true,
        workspaceStatus: { status: "pending_review", reason: null },
      }),
    );
    expect(
      await screen.findByText(/Finish the security step first/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking your new workspace")).toBeNull();
  }, 20_000);

  it("shows the generic error for a suspension, which is not a check", async () => {
    installMockApi({
      "GET /api/v1/setup/status": () =>
        apiError(423, "workspace_unavailable", {
          details: { workspaceStatus: "suspended", reason: "billing" },
        }),
      "GET /api/v1/me": () => [200, ownerMe()],
    });
    await renderApp("/setup", testConfig({ setupRequired: false, controlPlane: true }));
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("Checking your new workspace")).toBeNull();
  }, 20_000);

  it("shows the completed state when setup is no longer required", async () => {
    installMockApi({
      // What an anonymous caller gets once setup is done (E2.10 ZAP-04).
      "GET /api/v1/setup/status": () => [200, { required: false }],
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    });
    const r = await renderApp("/setup", testConfig());
    expect(await screen.findByText(/Setup is complete/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to sign in/u })).toHaveAttribute("href", "/login");
    await expectNoA11yViolations(r.container);
  });

  it("starts at the token step from the anonymous pre-setup status (no drivers, probes or progress)", async () => {
    installMockApi({
      "GET /api/v1/setup/status": () => [
        200,
        {
          required: true,
          tenancy: "single",
          instanceName: "FundRoom",
          baseUrl: "https://investors.acme.test/",
          passwordEnabled: false,
          tokenSource: "env",
        },
      ],
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    });
    await renderApp("/setup", testConfig({ setupRequired: true, workspace: null }));
    expect(await screen.findByLabelText(/Setup token/u)).toBeInTheDocument();
  });

  it("keeps every other URL on the setup-required screen before setup", async () => {
    installMockApi({ "GET /api/v1/setup/status": () => [200, status(true)] });
    await renderApp("/admin", testConfig({ setupRequired: true, workspace: null }));
    expect(await screen.findByText(/Setup required/u)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Open setup/u })).toHaveAttribute("href", "/setup"),
    );
  });
});
