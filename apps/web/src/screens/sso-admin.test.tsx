import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ssoTestNavigation } from "../lib/sso-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  connectionResponse,
  oidcConnection,
  samlConnection,
  scimAdmin,
  scimGroup,
  scimToken,
  scimUser,
  spInfo,
  ssoDomain,
} from "../test/fixtures-sso.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/sso` (E3.8). What the screen owes the admin:
 *
 *  - no connection is a real state, and only the protocols the operator offers can be chosen;
 *  - OIDC and SAML (metadata or by hand) are saved in one checked step; a blank client secret
 *    keeps the saved one unless the issuer changes;
 *  - the addresses to register with the IdP can be copied; a test sign-in goes out and its
 *    result comes back as a banner;
 *  - requiring SSO names the break-glass and says why the server refused;
 *  - domains show their TXT record and why a check failed; SCIM tokens are shown once; groups
 *    map to roles;
 *  - every write goes through step-up; readers change nothing.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const ALL = ["sso.read", "sso.manage"];

function handlers(
  over: Record<string, Handler> = {},
  permissions: string[] = ALL,
  role: "owner" | "admin" = "owner",
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({ permissions, membership: { id: OWNER_ID, kind: "staff", role } }),
    ],
    "GET /api/v1/sso/connection": () => [200, connectionResponse(oidcConnection())],
    "GET /api/v1/sso/domains": () => [200, { domains: [] }],
    "GET /api/v1/sso/scim": () => [200, scimAdmin()],
    "GET /api/v1/sso/scim/users": () => [200, { items: [], nextCursor: null }],
    "GET /api/v1/sso/scim/groups": () => [200, { groups: [] }],
    ...over,
  });
}

const noConnection: Record<string, Handler> = {
  "GET /api/v1/sso/connection": () => [200, connectionResponse(null)],
};

async function openScreen(path = "/admin/sso") {
  const r = await renderApp(path);
  expect(
    await screen.findByRole("heading", { name: "Single sign-on", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function bodyOf(
  calls: { method: string; path: string; body: unknown }[],
  method: string,
  path: string,
) {
  return calls.find((c) => c.method === method && c.path === path)?.body;
}

describe("sso admin: connecting", () => {
  it("starts empty, connects OpenID Connect and shows the redirect URI to copy", async () => {
    let connection: ReturnType<typeof oidcConnection> | null = null;
    const { calls } = handlers({
      "GET /api/v1/sso/connection": () => [200, connectionResponse(connection)],
      "PUT /api/v1/sso/connection": () => {
        connection = oidcConnection({ jit: { enabled: true, role: "editor" } });
        return [200, { connection }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    expect(
      await screen.findByText(/No identity provider is connected/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    // Nothing to register yet: the addresses need the connection's id.
    await user.click(screen.getByRole("radio", { name: "OpenID Connect" }));
    expect(screen.getByText(/appear here once it is saved/u)).toBeVisible();
    const submit = screen.getByRole("button", { name: "Check and save" });
    expect(submit).toBeDisabled();
    // A new connection needs its secret.
    expect(screen.getByLabelText(/^Client secret/u)).toBeRequired();
    await user.type(screen.getByLabelText(/^Name/u), "Acme Okta");
    await user.type(screen.getByLabelText(/^Issuer URL/u), " https://acme.okta.com ");
    await user.type(screen.getByLabelText(/^Client ID/u), "0oa1client");
    await user.type(screen.getByLabelText(/^Client secret/u), "s3cret");
    await user.click(screen.getByLabelText("Create a staff account on first sign-in"));
    await user.selectOptions(screen.getByLabelText("Role for new accounts"), "editor");
    await user.type(screen.getByLabelText("Values that mean MFA was used"), "mfa\n\nphr\nmfa");
    await expectNoA11yViolations(r.container);
    await user.click(submit);
    await waitFor(() =>
      expect(bodyOf(calls, "PUT", "/api/v1/sso/connection")).toEqual({
        name: "Acme Okta",
        jit: { enabled: true, role: "editor" },
        mfa: { trust: false, values: ["mfa", "phr"] },
        protocol: "oidc",
        issuer: "https://acme.okta.com",
        clientId: "0oa1client",
        clientSecret: "s3cret",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Acme Okta" })).toBeVisible();
    expect(screen.getByText("On, as Editor")).toBeVisible();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy redirect URI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(spInfo().oidcRedirectUri));
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("offers only the operator's protocols and saves SAML from pasted metadata", async () => {
    let connection: ReturnType<typeof samlConnection> | null = null;
    const { calls } = handlers({
      "GET /api/v1/sso/connection": () => [
        200,
        connectionResponse(connection, { protocolsOffered: ["saml"] }),
      ],
      "PUT /api/v1/sso/connection": () => {
        connection = samlConnection();
        return [200, { connection }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const saml = await screen.findByRole("radio", { name: "SAML 2.0" }, { timeout: 5000 });
    expect(saml).toBeChecked();
    expect(screen.queryByRole("radio", { name: "OpenID Connect" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Paste the provider's metadata XML" })).toBeChecked();
    await user.type(screen.getByLabelText(/^Name/u), "Acme Entra");
    await user.click(screen.getByLabelText(/^IdP metadata XML/u));
    await user.paste("<EntityDescriptor entityID='https://sts.windows.net/t/'/>");
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() =>
      expect(bodyOf(calls, "PUT", "/api/v1/sso/connection")).toEqual({
        name: "Acme Entra",
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
        protocol: "saml",
        metadataXml: "<EntityDescriptor entityID='https://sts.windows.net/t/'/>",
      }),
    );
    // Connected: the SAML addresses and the certificate's fingerprint.
    expect(await screen.findByRole("heading", { name: "Acme Entra" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy ACS URL" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy metadata URL" })).toBeVisible();
    expect(screen.getByText("AB:CD:EF:01")).toBeInTheDocument();
  }, 20_000);

  it("names why the provider settings were refused", async () => {
    handlers({
      ...noConnection,
      "PUT /api/v1/sso/connection": () =>
        apiError(400, "sso_invalid_config", { reason: "discovery_failed" }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "OpenID Connect" }, {}));
    await user.type(screen.getByLabelText(/^Name/u), "Okta");
    await user.type(screen.getByLabelText(/^Issuer URL/u), "https://nope.example");
    await user.type(screen.getByLabelText(/^Client ID/u), "id");
    await user.type(screen.getByLabelText(/^Client secret/u), "secret");
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The identity provider settings were not saved")).toBeVisible();
    expect(
      within(alert).getByText(/could not load the provider's discovery document/u),
    ).toBeVisible();
  }, 20_000);

  it("says so when the operator offers no protocol", async () => {
    handlers({
      "GET /api/v1/sso/connection": () => [200, connectionResponse(null, { protocolsOffered: [] })],
    });
    const r = await openScreen();
    expect(
      await screen.findByText("Single sign-on is not available", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check and save" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("sso admin: editing", () => {
  it("keeps a blank client secret, but asks for it again when the issuer changes", async () => {
    const { calls } = handlers({
      "PUT /api/v1/sso/connection": () => [200, { connection: oidcConnection() }],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }),
    );
    const secret = screen.getByLabelText(/^Client secret/u);
    expect(secret).not.toBeRequired();
    expect(secret).toHaveAccessibleDescription("Leave blank to keep the saved secret.");
    await expectNoA11yViolations(r.container);
    // A different issuer is a different provider: the old secret must not follow it.
    const issuer = screen.getByLabelText(/^Issuer URL/u);
    await user.clear(issuer);
    await user.type(issuer, "https://other.okta.com");
    expect(screen.getByLabelText(/^Client secret/u)).toBeRequired();
    expect(screen.getByRole("button", { name: "Check and save" })).toBeDisabled();
    await user.clear(issuer);
    await user.type(issuer, "https://acme.okta.com");
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() =>
      expect(bodyOf(calls, "PUT", "/api/v1/sso/connection")).toEqual({
        name: "Acme Okta",
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
        protocol: "oidc",
        issuer: "https://acme.okta.com",
        clientId: "0oa1client",
      }),
    );
  }, 20_000);

  it("keeps saved SAML certificates when the box is left blank", async () => {
    const { calls } = handlers({
      "GET /api/v1/sso/connection": () => [200, connectionResponse(samlConnection())],
      "PUT /api/v1/sso/connection": () => [200, { connection: samlConnection() }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }),
    );
    expect(screen.getByRole("radio", { name: "Enter them by hand" })).toBeChecked();
    expect(screen.getByLabelText(/^Signing certificates/u)).not.toBeRequired();
    await user.click(screen.getByLabelText("Trust the provider's MFA for every sign-in"));
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() =>
      expect(bodyOf(calls, "PUT", "/api/v1/sso/connection")).toEqual({
        name: "Acme Entra",
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: true, values: [] },
        protocol: "saml",
        idpEntityId: "https://sts.windows.net/tenant-id/",
        idpSsoUrl: "https://login.microsoftonline.com/tenant-id/saml2",
      }),
    );
  }, 20_000);

  it("deletes the connection behind a confirmation", async () => {
    let connection: ReturnType<typeof oidcConnection> | null = oidcConnection();
    const { calls } = handlers({
      "GET /api/v1/sso/connection": () => [200, connectionResponse(connection)],
      "DELETE /api/v1/sso/connection": () => {
        connection = null;
        return new Response(null, { status: 204 });
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Delete connection" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Staff signed in through it are signed out/u)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Delete connection" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/sso/connection")).toBe(
        true,
      ),
    );
    expect(await screen.findByText(/No identity provider is connected/u)).toBeVisible();
  }, 20_000);
});

describe("sso admin: test sign-in", () => {
  it("starts a test sign-in at the identity provider", async () => {
    const assign = vi.spyOn(ssoTestNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "POST /api/v1/auth/sso/begin": () => [200, { url: "https://acme.okta.com/authorize?x=1" }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Test sign-in" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://acme.okta.com/authorize?x=1"));
    expect(bodyOf(calls, "POST", "/api/v1/auth/sso/begin")).toEqual({ test: true });
  }, 20_000);

  it("shows a successful test's banner and strips it from the address", async () => {
    handlers({
      "GET /api/v1/sso/connection": () => [
        200,
        connectionResponse(oidcConnection({ lastTestedAt: "2026-09-27T10:05:00.000Z" })),
      ],
    });
    const r = await openScreen("/admin/sso?sso_test=ok");
    expect(await screen.findByText("Test sign-in worked", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText(/Nobody was signed in/u)).toBeVisible();
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/sso"));
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Test sign-in worked")).toBeNull();
  }, 20_000);

  it("explains a failed test and never echoes an unknown code", async () => {
    handlers();
    await openScreen("/admin/sso?sso_test=binding_mismatch");
    expect(await screen.findByText("Test sign-in failed", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText(/finished in a different browser/u)).toBeVisible();
  }, 20_000);

  it("reads an unknown result code as a generic failure", async () => {
    handlers();
    await openScreen("/admin/sso?sso_test=%3Cscript%3E");
    expect(await screen.findByText("Test sign-in failed", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText(/The test did not complete/u)).toBeVisible();
    expect(screen.queryByText(/script/u)).toBeNull();
  }, 20_000);
});

describe("sso admin: sign-in policy", () => {
  it("warns about the break-glass and names the enforcement precondition", async () => {
    const { calls } = handlers({
      "GET /api/v1/sso/connection": () => [
        200,
        connectionResponse(oidcConnection({ enabled: true })),
      ],
      "PUT /api/v1/sso/connection/state": () =>
        apiError(409, "sso_enforce_precondition", { reason: "never_signed_in" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const required = await screen.findByRole(
      "radio",
      { name: "Required for staff" },
      { timeout: 5000 },
    );
    expect(screen.queryByText("Owners keep a way in")).toBeNull();
    await user.click(required);
    expect(screen.getByText("Owners keep a way in")).toBeVisible();
    // API keys are not sessions: enforcement does not stop them, and the page says where to go.
    expect(screen.getByText(/Existing API keys keep working/u)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open API keys" })).toHaveAttribute(
      "href",
      "/admin/api-keys",
    );
    expect(screen.getByText(/owner who has a passkey or an authenticator app/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The policy was not changed")).toBeVisible();
    expect(within(alert).getByText(/Run a successful test sign-in first/u)).toBeVisible();
    expect(bodyOf(calls, "PUT", "/api/v1/sso/connection/state")).toEqual({
      enabled: true,
      enforce: "staff",
    });
  }, 20_000);

  it("cannot require a connection that is off", async () => {
    handlers();
    await openScreen();
    const required = await screen.findByRole(
      "radio",
      { name: "Required for staff" },
      { timeout: 5000 },
    );
    expect(required).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Staff can sign in with Acme Okta"));
    expect(screen.getByRole("radio", { name: "Required for staff" })).toBeEnabled();
  }, 20_000);

  it("sends a stale admin to step-up when saving the policy", async () => {
    handlers({
      "PUT /api/v1/sso/connection/state": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByLabelText("Staff can sign in with Acme Okta", {}, { timeout: 5000 }),
    );
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fsso");
  }, 20_000);
});

describe("sso admin: domains", () => {
  it("adds a domain, shows its TXT record and why the check failed, then verifies it", async () => {
    let domains = [] as ReturnType<typeof ssoDomain>[];
    const { calls } = handlers({
      "GET /api/v1/sso/domains": () => [200, { domains }],
      "POST /api/v1/sso/domains": ({ body }) => {
        const d = ssoDomain({ domain: (body as { domain: string }).domain });
        domains = [d];
        return [201, { domain: d }];
      },
      "POST /api/v1/sso/domains/{id}/verify": () => {
        domains = [
          ssoDomain({
            lastError: "No TXT record at _fundroom-sso.acme.com",
            lastCheckedAt: "2026-09-27T10:10:00.000Z",
          }),
        ];
        return [200, { domain: domains[0] }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    expect(await screen.findByText("No domains yet.", {}, { timeout: 5000 })).toBeVisible();
    await user.type(screen.getByLabelText("Domain"), " Acme.COM ");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/sso/domains")).toEqual({ domain: "acme.com" }),
    );
    expect(await screen.findByRole("heading", { name: "acme.com" })).toBeVisible();
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.getByText("_fundroom-sso.acme.com")).toBeVisible();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy TXT value for acme.com" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ssoDomain().txtValue));
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Check DNS for acme.com" }));
    expect(await screen.findByText(/No TXT record at _fundroom-sso\.acme\.com/u)).toBeVisible();
  }, 20_000);

  it("says when another workspace already verified the domain", async () => {
    handlers({
      "POST /api/v1/sso/domains": () => apiError(409, "sso_domain_taken"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Domain", {}, { timeout: 5000 }), "acme.com");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/already verified this domain/u)).toBeVisible();
  }, 20_000);

  it("explains an invalid domain and a failed DNS check", async () => {
    handlers({
      "GET /api/v1/sso/domains": () => [200, { domains: [ssoDomain()] }],
      "POST /api/v1/sso/domains": () => apiError(400, "sso_domain_invalid"),
      "POST /api/v1/sso/domains/{id}/verify": () =>
        apiError(409, "sso_domain_unverified", { reason: "no_record" }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Domain", {}, { timeout: 5000 }), "not a domain");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    expect(await screen.findByText(/That is not a valid domain name/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Check DNS for acme.com" }));
    expect(await screen.findByText(/The TXT record was not found yet/u)).toBeVisible();
  }, 20_000);
});

describe("sso admin: SCIM", () => {
  it("shows a new token once, then only its prefix", async () => {
    let tokens = [scimToken()];
    const { calls } = handlers({
      "GET /api/v1/sso/scim": () => [
        200,
        scimAdmin({ tokens, counts: { users: 4, activeUsers: 3, groups: 2 } }),
      ],
      "POST /api/v1/sso/scim/tokens": () => {
        const view = scimToken({
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9e02",
          name: "Okta",
          displayPrefix: "frs_Zz9Y",
        });
        tokens = [...tokens, view];
        return [201, { token: "frs_Zz9Yverysecretvalue", view }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    expect(await screen.findByText("frs_AbCd…", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText(/keeps working after the person who created it leaves/u)).toBeVisible();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy SCIM base URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(scimAdmin().baseUrl));
    await user.type(screen.getByLabelText("Token name"), "Okta");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() =>
      expect(bodyOf(calls, "POST", "/api/v1/sso/scim/tokens")).toEqual({ name: "Okta" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("frs_Zz9Yverysecretvalue")).toBeVisible();
    expect(within(dialog).getByText(/only time it is shown/u)).toBeVisible();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("frs_Zz9Yverysecretvalue"));
    await user.click(within(dialog).getByRole("button", { name: "I have copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("frs_Zz9Yverysecretvalue")).toBeNull();
    // Two live tokens is the limit: rotation means revoking one first.
    expect(await screen.findByText("frs_Zz9Y…")).toBeVisible();
    expect(screen.getByText(/Two tokens is the limit/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("revokes a token behind a confirmation", async () => {
    const { calls } = handlers({
      "GET /api/v1/sso/scim": () => [200, scimAdmin({ tokens: [scimToken()] })],
      "DELETE /api/v1/sso/scim/tokens/{id}": () => new Response(null, { status: 204 }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Revoke Entra ID" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/sso/scim/tokens/${scimToken().id}`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("maps a group to a role and lists provisioned users", async () => {
    let group = scimGroup();
    const { calls } = handlers({
      "GET /api/v1/sso/scim/groups": () => [200, { groups: [group] }],
      "GET /api/v1/sso/scim/users": () => [
        200,
        {
          items: [
            scimUser(),
            scimUser({
              id: "u2",
              userName: "bob@acme.com",
              displayName: null,
              active: false,
              role: null,
              groups: [],
            }),
          ],
          nextCursor: null,
        },
      ],
      "PUT /api/v1/sso/scim/groups/{id}/role": ({ body }) => {
        group = scimGroup({ role: (body as { role: "admin" }).role });
        return [200, { group }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const select = await screen.findByRole(
      "combobox",
      { name: "Role for Engineering" },
      { timeout: 5000 },
    );
    expect(select).toHaveValue("");
    expect(screen.getByText(/Owners are never changed/u)).toBeVisible();
    expect(screen.getByText(/Admin, then Legal, Finance, Editor, Viewer/u)).toBeVisible();
    expect(screen.getByText("ada@acme.com")).toBeVisible();
    expect(screen.getByText("Suspended")).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.selectOptions(select, "admin");
    await waitFor(() =>
      expect(bodyOf(calls, "PUT", `/api/v1/sso/scim/groups/${scimGroup().id}/role`)).toEqual({
        role: "admin",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Role for Engineering" })).toHaveValue("admin"),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Role for Engineering" }), "");
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PUT" && c.path.endsWith("/role")).at(-1)?.body,
      ).toEqual({ role: null }),
    );
  }, 20_000);

  it("explains that an SSO session cannot change security settings", async () => {
    handlers({
      "GET /api/v1/sso/scim/groups": () => [200, { groups: [scimGroup()] }],
      "PUT /api/v1/sso/scim/groups/{id}/role": () => apiError(403, "sso_session_restricted"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Engineering" }, { timeout: 5000 }),
      "viewer",
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("That change was not made")).toBeVisible();
    expect(within(alert).getByText(/sign in with your email to do this/u)).toBeVisible();
  }, 20_000);

  it("says SCIM is off when the operator turned it off", async () => {
    handlers({ "GET /api/v1/sso/scim": () => [200, scimAdmin({ enabled: false })] });
    const r = await openScreen();
    expect(await screen.findByText("SCIM is turned off", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("sso admin: permissions", () => {
  it("shows a reader everything and no controls", async () => {
    const { calls } = handlers(
      {
        "GET /api/v1/sso/connection": () => [
          200,
          connectionResponse(oidcConnection({ enabled: true, enforce: "staff" })),
        ],
        "GET /api/v1/sso/domains": () => [200, { domains: [ssoDomain()] }],
        "GET /api/v1/sso/scim": () => [200, scimAdmin({ tokens: [scimToken()] })],
        "GET /api/v1/sso/scim/groups": () => [200, { groups: [scimGroup({ role: "legal" })] }],
      },
      ["sso.read"],
      "admin",
    );
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "Acme Okta" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText(/Only the workspace owner can change single sign-on/u)).toBeVisible();
    expect(screen.getByText(/Required for staff\. Owners with a passkey/u)).toBeVisible();
    expect(await screen.findByText("Legal")).toBeVisible();
    for (const name of [
      "Test sign-in",
      "Edit settings",
      "Delete connection",
      "Save policy",
      "Add domain",
      "Check DNS for acme.com",
      "Revoke Entra ID",
      "Create token",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("combobox")).toBeNull();
    await expectNoA11yViolations(r.container);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  }, 20_000);

  it("refuses a staff member without sso.read", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/sso");
    expect(
      await screen.findByText(
        "You need single sign-on access to see this page.",
        {},
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(calls.some((c) => c.path.startsWith("/api/v1/sso"))).toBe(false);
  }, 20_000);
});

// A-3 (ADR-0063): a plan without `sso` / `scim` freezes the configuration — what is set up keeps
// working and can be maintained (same protocol, token rotation, group roles); nothing new is added.
describe("SSO admin on a plan without SSO or SCIM", () => {
  it("keeps the connection, domains and tokens maintainable, and greys out what is new", async () => {
    handlers({
      "GET /api/v1/sso/domains": () => [200, { domains: [ssoDomain()] }],
      "GET /api/v1/sso/scim": () => [200, scimAdmin({ tokens: [scimToken()] })],
      "GET /api/v1/sso/scim/groups": () => [200, { groups: [scimGroup()] }],
    });
    withPlanEntitlements({ features: ["api_keys"] });
    const r = await openScreen();
    expect(
      await screen.findByText(
        "Your plan doesn't include Single sign-on. What you've already set up keeps working.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your plan doesn't include SCIM provisioning. What you've already set up keeps working.",
      ),
    ).toBeInTheDocument();
    // The connection: test, edit and delete stay; it cannot be switched on or required.
    expect(await screen.findByRole("button", { name: "Test sign-in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete connection" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeEnabled();
    expect(screen.getByLabelText("Staff can sign in with Acme Okta")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Required for staff" })).toBeDisabled();
    // Domains: no new domain and no new verification, said beside the buttons (R3 L6).
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Domain"), "acme.org");
    const add = screen.getByRole("button", { name: "Add domain" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("Not available on your plan: Single sign-on.");
    const check = await screen.findByRole(
      "button",
      { name: "Check DNS for acme.com" },
      { timeout: 5000 },
    );
    expect(check).toBeDisabled();
    expect(check).toHaveAccessibleDescription("Not available on your plan: Single sign-on.");
    expect(screen.getByRole("button", { name: "Remove acme.com" })).toBeEnabled();
    // SCIM: a token is live, so a new one is a rotation; group roles stay editable.
    expect(screen.getByRole("button", { name: "Revoke Entra ID" })).toBeEnabled();
    await user.type(screen.getByLabelText("Token name"), "Okta");
    expect(screen.getByRole("button", { name: "Create token" })).toBeEnabled();
    expect(
      await screen.findByRole("combobox", { name: "Role for Engineering" }, { timeout: 5000 }),
    ).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets the connection be re-keyed on its own protocol, never moved to another", async () => {
    const { calls } = handlers({
      "PUT /api/v1/sso/connection": () => [200, { connection: oidcConnection() }],
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }),
    );
    expect(screen.getByRole("radio", { name: "SAML 2.0" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "OpenID Connect" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(bodyOf(calls, "PUT", "/api/v1/sso/connection")).toBeDefined());
  }, 20_000);

  it("will not set up a first connection or SCIM from scratch", async () => {
    handlers(noConnection);
    withPlanEntitlements({ features: [] });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("radio", { name: "OpenID Connect" }, { timeout: 5000 }),
    );
    // Even with every field filled in.
    await user.type(screen.getByLabelText(/^Name/u), "Acme Okta");
    await user.type(screen.getByLabelText(/^Issuer URL/u), "https://acme.okta.com");
    await user.type(screen.getByLabelText(/^Client ID/u), "0oa1client");
    await user.type(screen.getByLabelText(/^Client secret/u), "s3cret");
    expect(screen.getByRole("button", { name: "Check and save" })).toBeDisabled();
    await user.type(screen.getByLabelText("Token name"), "Okta");
    expect(screen.getByRole("button", { name: "Create token" })).toBeDisabled();
  }, 20_000);

  it("lets a connection that is on and required be switched off", async () => {
    handlers({
      "GET /api/v1/sso/connection": () => [
        200,
        connectionResponse(oidcConnection({ enabled: true, enforce: "staff" })),
      ],
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    expect(
      await screen.findByLabelText("Staff can sign in with Acme Okta", {}, { timeout: 5000 }),
    ).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Required for staff" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Optional" })).toBeEnabled();
  }, 20_000);

  // RR3 RM2 / decision 18: the form says what the plan allows before the server refuses.
  it("keeps the identity provider and its sign-in options as they are, and says why", async () => {
    handlers();
    withPlanEntitlements({ features: [] });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }),
    );
    const issuer = screen.getByLabelText(/^Issuer URL/u);
    expect(issuer).toHaveAccessibleDescription(
      /On your plan you can update this provider's credentials, not connect a different provider\./u,
    );
    // Turning JIT accounts or trusted IdP MFA on would be new; they are off here.
    expect(screen.getByLabelText("Create a staff account on first sign-in")).toBeDisabled();
    expect(screen.getByLabelText("Trust the provider's MFA for every sign-in")).toBeDisabled();
    const save = screen.getByRole("button", { name: "Check and save" });
    expect(save).toBeEnabled();
    await expectNoA11yViolations(r.container);

    await user.clear(issuer);
    await user.type(issuer, "https://other.example.com");
    // Even with that provider's secret filled in, so nothing else is missing.
    await user.type(screen.getByLabelText(/^Client secret/u), "other-secret");
    expect(
      screen.getByText(
        "Switching identity provider isn't on your plan. Keep the saved value to update this provider's credentials.",
      ),
    ).toBeInTheDocument();
    expect(issuer).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    // The "issuer changed, enter its secret" prompt would invite the switch: not shown.
    expect(screen.queryByText(/The issuer changed/u)).toBeNull();

    await user.clear(issuer);
    await user.type(issuer, "https://acme.okta.com");
    expect(save).toBeEnabled();
  }, 20_000);

  it("lets JIT and trusted MFA that are on be switched off", async () => {
    handlers({
      "GET /api/v1/sso/connection": () => [
        200,
        connectionResponse(
          oidcConnection({
            jit: { enabled: true, role: "viewer" },
            mfa: { trust: true, values: [] },
          }),
        ),
      ],
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }));
    expect(screen.getByLabelText("Create a staff account on first sign-in")).toBeEnabled();
    expect(screen.getByLabelText("Trust the provider's MFA for every sign-in")).toBeEnabled();
  }, 20_000);

  it("names the refused part when the server finds a different provider (pasted metadata)", async () => {
    handlers({
      "PUT /api/v1/sso/connection": () =>
        apiError(402, "plan_limit", { limit: "feature", feature: "sso" }),
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit settings" }, { timeout: 5000 }),
    );
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("The identity provider settings were not saved"),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(
        "Switching identity provider isn't on your plan. Keep the current issuer or entity ID to update this provider's credentials.",
      ),
    ).toBeInTheDocument();
  }, 20_000);

  // RR3 RL4: removals the plan would not let anyone redo say so.
  it("warns that deleting the connection or the last SCIM token cannot be undone on this plan", async () => {
    handlers({ "GET /api/v1/sso/scim": () => [200, scimAdmin({ tokens: [scimToken()] })] });
    withPlanEntitlements({ features: [] });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Delete connection" }, { timeout: 5000 }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Delete Acme Okta?" });
    expect(
      within(dialog).getByText(
        /Your plan doesn't include Single sign-on, so you won't be able to set this up again until it does\./u,
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Revoke Entra ID" }));
    dialog = await screen.findByRole("dialog", { name: "Revoke Entra ID?" });
    expect(
      within(dialog).getByText(
        /Your plan doesn't include SCIM provisioning, so you won't be able/u,
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("does not warn when another live SCIM token remains", async () => {
    handlers({
      "GET /api/v1/sso/scim": () => [
        200,
        scimAdmin({
          tokens: [
            scimToken(),
            scimToken({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9e02", name: "Okta" }),
          ],
        }),
      ],
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Revoke Entra ID" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke Entra ID?" });
    expect(within(dialog).queryByText(/you won't be able/u)).toBeNull();
  }, 20_000);
});
