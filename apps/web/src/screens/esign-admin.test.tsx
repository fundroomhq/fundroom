import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  CALLBACK_SECRET,
  COMPLETED_ENVELOPE_ID,
  completedNdaEnvelope,
  ENVELOPE_ID,
  esignConnection,
  esignDrivers,
  esignEnvelope,
} from "../test/fixtures-esign.js";
import {
  apiError,
  type Handler,
  installMockApi,
  json,
  withPlanEntitlements,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/esign` (E3.5). What the screen owes the admin:
 *
 *  - the connection form is generated from the driver's credential fields, and a base-URL field
 *    appears only for a vendor that can be self-hosted;
 *  - credentials are verified live before anything is saved, and a refusal says why;
 *  - the callback secret of an "ours" vendor is shown exactly once, with where to paste it, and
 *    a "vendor"-secret driver says the opposite (paste their key into our form);
 *  - disconnecting is typed-confirmed and a 409 says what is in the way;
 *  - envelopes: status tabs, purpose filter, paging, a detail dialog with downloads, void and
 *    "check status now";
 *  - readers see everything and can change nothing; without `esign.read` there is no nav entry.
 */
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

const ALL = ["esign.read", "esign.manage"];

function handlers(over: Record<string, Handler> = {}, permissions: string[] = ALL) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/esign/drivers": () => [200, esignDrivers()],
    "GET /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
    "GET /api/v1/esign/envelopes": () => [
      200,
      { items: [esignEnvelope(), completedNdaEnvelope()], nextCursor: null },
    ],
    "GET /api/v1/esign/envelopes/{id}": ({ params }) => [
      200,
      params["id"] === COMPLETED_ENVELOPE_ID ? completedNdaEnvelope() : esignEnvelope(),
    ],
    ...over,
  });
}

const notConnected: Record<string, Handler> = {
  "GET /api/v1/esign/connection": () => [200, { connection: null }],
  "GET /api/v1/esign/envelopes": () => [200, { items: [], nextCursor: null }],
};

async function openScreen() {
  const r = await renderApp("/admin/esign");
  expect(
    await screen.findByRole("heading", { name: "E-signature", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("e-signature admin: connection", () => {
  it("shows the connected vendor, masked credentials and the callback URL — never a secret", async () => {
    handlers();
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "Documenso" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("sign.acme.test")).toBeInTheDocument();
    expect(screen.getByText("••••ab12")).toBeInTheDocument();
    expect(screen.getByText(/esign\/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7a01$/u)).toBeInTheDocument();
    // Documenso's own setup steps, and the "ours" secret is not on the page.
    expect(screen.getByText(/Settings → Webhooks and create a webhook/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate callback secret" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "E-signature" })).toBeInTheDocument();
    expect(r.container.textContent).not.toContain(CALLBACK_SECRET);
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy callback URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(esignConnection().callbackUrl));
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("connects Documenso with a self-hosted address and shows the callback secret once", async () => {
    const { calls } = handlers({
      ...notConnected,
      "PUT /api/v1/esign/connection": () => [
        200,
        { connection: esignConnection(), callbackSecret: CALLBACK_SECRET },
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const documenso = await screen.findByRole("radio", { name: "Documenso" }, { timeout: 5000 });
    expect(documenso).toBeChecked();
    // A self-hostable vendor offers the instance address, optional, defaulting to the cloud.
    const baseUrl = screen.getByLabelText("Instance address");
    expect(baseUrl).not.toBeRequired();
    expect(screen.getByText(/Leave empty to use https:\/\/app\.documenso\.com/u)).toBeVisible();
    const submit = screen.getByRole("button", { name: "Verify and connect" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/API token/u), "  tok_live_123  ");
    await user.type(baseUrl, "https://sign.acme.test");
    await expectNoA11yViolations(r.container);
    await user.click(submit);

    expect(
      await screen.findByText("Here is the callback secret for Documenso — copy it now"),
    ).toBeInTheDocument();
    expect(screen.getByText(CALLBACK_SECRET)).toBeInTheDocument();
    expect(screen.getByText(/This is the only time it is shown/u)).toBeVisible();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      driver: "documenso",
      credentials: { apiToken: "tok_live_123" },
      baseUrl: "https://sign.acme.test",
    });
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy secret" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CALLBACK_SECRET));
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText(CALLBACK_SECRET)).toBeNull();
  }, 20_000);

  it("builds DocuSign's form from its fields and says its key goes into our form", async () => {
    const docusign = esignConnection({
      driver: "docusign",
      displayName: "DocuSign",
      baseUrlHost: null,
      callbackSecretKind: "vendor",
      credentialHints: { integrationKey: "••••1234", connectHmacKey: "••••zz99" },
    });
    let saved = false;
    const { calls } = handlers({
      ...notConnected,
      "GET /api/v1/esign/connection": () => [200, { connection: saved ? docusign : null }],
      "PUT /api/v1/esign/connection": () => {
        saved = true;
        return [200, { connection: docusign }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "DocuSign" }, { timeout: 5000 }));
    // Not self-hostable: DocuSign's base URI comes from its OAuth userinfo, so no address field.
    expect(screen.queryByLabelText("Instance address")).toBeNull();
    const env = screen.getByRole("combobox", { name: /Environment/u });
    expect(env).toHaveValue("demo");
    await user.selectOptions(env, "production");
    await user.type(screen.getByLabelText(/Integration key/u), "ik-1");
    await user.type(screen.getByLabelText(/User ID/u), "user-1");
    const pem = screen.getByLabelText(/RSA private key/u);
    expect(pem.tagName).toBe("TEXTAREA");
    await user.type(pem, "-----BEGIN RSA PRIVATE KEY-----");
    await user.type(screen.getByLabelText(/^Connect HMAC key/u), "hmac-1");
    expect(screen.getByText(/a key the vendor generates, entered above/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Verify and connect" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        driver: "docusign",
        credentials: {
          environment: "production",
          integrationKey: "ik-1",
          userId: "user-1",
          privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----",
          connectHmacKey: "hmac-1",
        },
      }),
    );
    // A "vendor"-secret driver has no secret of ours to show, and none to rotate.
    expect(await screen.findByRole("heading", { name: "DocuSign" })).toBeVisible();
    expect(screen.queryByText(/copy it now/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate callback secret" })).toBeNull();
    expect(screen.getByText(/paste it into the Connect HMAC key field/u)).toBeVisible();
  }, 20_000);

  it("says Dropbox Sign signs by email and has no address or secret of its own", async () => {
    handlers(notConnected);
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Dropbox Sign" }, { timeout: 5000 }));
    expect(screen.queryByLabelText("Instance address")).toBeNull();
    expect(screen.getByRole("combobox", { name: /Mode/u })).toHaveValue("test");
    expect(screen.getByLabelText(/API key/u)).toHaveAttribute("type", "password");
    expect(
      within(
        screen.getByRole("radio", { name: "Dropbox Sign" }).closest("div") as HTMLElement,
      ).getByText(/Signers get the link by email/u),
    ).toBeVisible();
  }, 20_000);

  it("names why the vendor refused the credentials", async () => {
    handlers({
      ...notConnected,
      "PUT /api/v1/esign/connection": () =>
        apiError(422, "esign_credentials_rejected", {
          reason: "unauthorized",
          detail: "401 from the vendor",
        }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/API token/u, {}, { timeout: 5000 }), "bad");
    await user.click(screen.getByRole("button", { name: "Verify and connect" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The vendor did not accept the connection")).toBeVisible();
    expect(within(alert).getByText("The vendor did not accept these credentials.")).toBeVisible();
    expect(within(alert).getByText("401 from the vendor")).toBeVisible();
  }, 20_000);

  it("re-saves the same vendor with an empty address: the saved one and its secrets are kept", async () => {
    const { calls } = handlers({
      "PUT /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    // Only the host is ever shown: it is the placeholder, and an empty field keeps the address.
    const address = screen.getByLabelText("Instance address");
    expect(address).toHaveAttribute("placeholder", "sign.acme.test");
    expect(address).toHaveValue("");
    expect(address).not.toBeRequired();
    expect(
      screen.getByText(/Saved address: sign\.acme\.test\. Leave empty to keep it/u),
    ).toBeVisible();
    const token = screen.getByLabelText(/API token/u);
    expect(screen.getByText(/Leave empty to keep the saved value \(••••ab12\)/u)).toBeVisible();
    expect(screen.queryByText("A new address needs every secret again")).toBeNull();
    expect(token).not.toBeRequired();
    // A required secret has no "remove" box: only an optional one can be dropped.
    expect(screen.queryByRole("checkbox", { name: /Remove the saved/u })).toBeNull();
    await expectNoA11yViolations(document.body);
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    // No `baseUrl` in the body: the server keeps the stored address (and so the secrets).
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        driver: "documenso",
        credentials: {},
      }),
    );
    // Same vendor, same callback secret: nothing new to show.
    expect((await screen.findAllByText("Connected to Documenso")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/copy it now/u)).toBeNull();
  }, 20_000);

  it("typing the saved address again keeps the secrets; emptying a changed one keeps them too", async () => {
    const { calls } = handlers({
      "PUT /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    const address = screen.getByLabelText("Instance address");
    await user.type(address, "https://sign2.acme.test");
    expect(screen.getByText("A new address needs every secret again")).toBeVisible();
    expect(screen.getByLabelText(/API token/u)).toBeRequired();
    // Back to empty: the saved address again, no warning, nothing to retype.
    await user.clear(address);
    expect(screen.queryByText("A new address needs every secret again")).toBeNull();
    expect(screen.getByLabelText(/API token/u)).not.toBeRequired();
    // The saved host typed in full is the same address too.
    await user.type(address, "https://sign.acme.test");
    expect(screen.queryByText("A new address needs every secret again")).toBeNull();
    expect(screen.getByLabelText(/API token/u)).not.toBeRequired();
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        driver: "documenso",
        credentials: {},
        baseUrl: "https://sign.acme.test",
      }),
    );
  }, 20_000);

  it("asks for every secret again when the address changes", async () => {
    let n = 0;
    const { calls } = handlers({
      "PUT /api/v1/esign/connection": () => {
        n += 1;
        return n === 1
          ? apiError(422, "esign_credentials_required", {
              reason: "base_url_changed",
              fields: ["apiToken"],
            })
          : [200, { connection: esignConnection() }];
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    const address = screen.getByLabelText("Instance address");
    // A different host is flagged before the save, and its secrets are required at once.
    await user.type(address, "https://sign2.acme.test");
    expect(screen.getByText("A new address needs every secret again")).toBeVisible();
    expect(screen.getByLabelText(/API token/u)).toBeRequired();
    // Same host, different path: only the server can tell it is a new address.
    await user.clear(address);
    await user.type(address, "https://sign.acme.test/v2");
    expect(screen.queryByText("A new address needs every secret again")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Enter the secrets again")).toBeVisible();
    expect(within(alert).getByText(/saved secrets cannot be reused/u)).toBeVisible();
    expect(within(alert).getByText("Needed: API token.")).toBeVisible();
    await expectNoA11yViolations(document.body);
    // The field named by the server is no longer "leave empty to keep": it must be typed.
    const token = screen.getByLabelText(/API token/u);
    expect(token).toBeRequired();
    expect(screen.getByRole("button", { name: "Verify and replace" })).toBeDisabled();
    await user.type(token, "tok-new");
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
        driver: "documenso",
        credentials: { apiToken: "tok-new" },
        baseUrl: "https://sign.acme.test/v2",
      }),
    );
  }, 20_000);

  it("removes a saved optional secret only when asked", async () => {
    const docusign = esignConnection({
      driver: "docusign",
      displayName: "DocuSign",
      baseUrlHost: null,
      callbackSecretKind: "vendor",
      credentialHints: {
        privateKeyPem: "••••KEY-",
        connectHmacKey: "••••hm01",
        connectHmacKeySecondary: "••••hm02",
      },
    });
    const { calls } = handlers({
      "GET /api/v1/esign/connection": () => [200, { connection: docusign }],
      "PUT /api/v1/esign/connection": () => [200, { connection: docusign }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    // Only the optional secret can be removed; the required ones keep "leave empty".
    const boxes = screen.getAllByRole("checkbox", { name: /Remove the saved/u });
    expect(boxes).toHaveLength(1);
    const box = screen.getByRole("checkbox", {
      name: "Remove the saved Secondary Connect HMAC key",
    });
    expect(box).not.toBeChecked();
    await user.type(screen.getByLabelText(/Integration key/u), "ik");
    await user.type(screen.getByLabelText(/User ID/u), "uid");
    await user.click(box);
    expect(screen.getByLabelText(/^Secondary Connect HMAC key/u)).toBeDisabled();
    expect(screen.getByText(/The saved value is removed when you save\./u)).toBeVisible();
    await expectNoA11yViolations(document.body);
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        driver: "docusign",
        credentials: { environment: "demo", integrationKey: "ik", userId: "uid" },
        clearCredentials: ["connectHmacKeySecondary"],
      }),
    );
  }, 20_000);

  it("refuses to switch vendors while envelopes are open", async () => {
    handlers({
      "PUT /api/v1/esign/connection": () => apiError(409, "envelopes_open"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Replace credentials" }, { timeout: 5000 }),
    );
    expect(screen.getByText("Replacing the Documenso connection")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "DocuSeal" }));
    await user.type(screen.getByLabelText(/API token/u), "tok");
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    expect(await screen.findByText("The vendor cannot be changed yet")).toBeVisible();
    expect(screen.getByText(/still waiting for a signature/u)).toBeVisible();
  }, 20_000);

  it("re-verifies and shows a failing connection's last error", async () => {
    const { calls } = handlers({
      "GET /api/v1/esign/connection": () => [
        200,
        { connection: esignConnection({ status: "error", lastError: "401 Unauthorized" }) },
      ],
      "POST /api/v1/esign/connection/verify": () => [
        200,
        { connection: esignConnection({ status: "active" }) },
      ],
    });
    const r = await openScreen();
    expect(
      await screen.findByText("The vendor connection is not working", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("401 Unauthorized")).toBeVisible();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/verify"))).toBe(true),
    );
    expect(await screen.findByText("The vendor accepted the credentials")).toBeInTheDocument();
  }, 20_000);

  it("rotates the callback secret behind a confirmation and shows the new one once", async () => {
    const rotated = "whsec_Tm90VGhlT2xkT25lQXRBbGxSZWFsbHk";
    const { calls } = handlers({
      "POST /api/v1/esign/connection/rotate-callback-secret": () => [
        200,
        { connection: esignConnection(), callbackSecret: rotated },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Rotate callback secret" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Rotate the callback secret?" });
    expect(calls.some((c) => c.path.endsWith("/rotate-callback-secret"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Rotate callback secret" }));
    expect(
      await screen.findByText("Here is the new callback secret for Documenso — copy it now"),
    ).toBeInTheDocument();
    expect(screen.getByText(rotated)).toBeInTheDocument();
  }, 20_000);

  it("sends a stale admin to step-up when rotating", async () => {
    handlers({
      "POST /api/v1/esign/connection/rotate-callback-secret": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Rotate callback secret" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Rotate callback secret" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fesign");
  }, 20_000);

  it("disconnects only after the driver is typed back", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/esign/connection": () => [200, { ok: true }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Documenso?" });
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type documenso to confirm"), "documenso");
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  }, 20_000);

  it("explains a refused disconnect: a legal document still uses e-signature", async () => {
    handlers({
      "DELETE /api/v1/esign/connection": () => apiError(409, "esign_ceremony_in_use"),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Type documenso to confirm"), "documenso");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("The vendor cannot be disconnected yet")).toBeVisible();
    expect(screen.getByText(/Switch it back to click-wrap first/u)).toBeVisible();
    const link = screen.getByRole("link", { name: "Go to legal documents" });
    expect(link).toHaveAttribute("href", "/admin/legal");
    expect(link.className).toContain("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a refused disconnect: envelopes are still open", async () => {
    handlers({
      "DELETE /api/v1/esign/connection": () => apiError(409, "envelopes_open"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Type documenso to confirm"), "documenso");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Void the open envelopes below/u)).toBeVisible();
  }, 20_000);
});

describe("e-signature admin: envelopes", () => {
  it("lists envelopes, filters by status tab and purpose, and pages with the cursor", async () => {
    const { calls } = handlers({
      "GET /api/v1/esign/envelopes": ({ url }) =>
        url.searchParams.get("cursor") === "c2"
          ? [
              200,
              {
                items: [
                  esignEnvelope({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b09", title: "Older" }),
                ],
                nextCursor: null,
              },
            ]
          : [200, { items: [esignEnvelope(), completedNdaEnvelope()], nextCursor: "c2" }],
    });
    const r = await openScreen();
    const table = await screen.findByRole("table", { name: "Envelopes: All" }, { timeout: 5000 });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1] as HTMLElement).getByText("Seed 2026 subscription agreement"),
    ).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText("Round closing")).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText("Sent")).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText("Opened")).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText("NDA")).toBeVisible();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Older")).toBeVisible();
    expect(calls.some((c) => c.path === "/api/v1/esign/envelopes")).toBe(true);

    const urls: URL[] = [];
    const seen = handlers({
      "GET /api/v1/esign/envelopes": ({ url }) => {
        urls.push(url);
        return [200, { items: [], nextCursor: null }];
      },
    });
    void seen;
    await user.click(screen.getByRole("tab", { name: "Declined" }));
    expect(await screen.findByText("No envelopes here.")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Purpose"), "nda");
    await waitFor(() =>
      expect(
        urls.some(
          (u) =>
            u.searchParams.get("status") === "declined" && u.searchParams.get("purpose") === "nda",
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("voids an open envelope with a reason", async () => {
    const { calls } = handlers({
      "POST /api/v1/esign/envelopes/{id}/void": () => [200, esignEnvelope({ status: "voided" })],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Details for Seed 2026 subscription agreement (Ada Lovelace)" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", { name: "Seed 2026 subscription agreement" });
    expect(within(dialog).getByText("ada@example.com")).toBeVisible();
    // Nothing signed yet: no downloads.
    expect(within(dialog).queryByRole("button", { name: /Download/u })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Void" }));
    const submit = within(dialog).getByRole("button", { name: "Void envelope" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/u), "Wrong amount");
    await expectNoA11yViolations(dialog);
    await user.click(submit);
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "POST" && c.path === `/api/v1/esign/envelopes/${ENVELOPE_ID}/void`,
        )?.body,
      ).toEqual({ reason: "Wrong amount" }),
    );
    expect(await screen.findByText("Envelope voided")).toBeInTheDocument();
  }, 20_000);

  it("says why a void was refused", async () => {
    handlers({
      "POST /api/v1/esign/envelopes/{id}/void": () => apiError(409, "envelope_not_open"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Details for Seed 2026 subscription agreement (Ada Lovelace)" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Void" }));
    await user.type(within(dialog).getByLabelText(/Reason/u), "Duplicate");
    await user.click(within(dialog).getByRole("button", { name: "Void envelope" }));
    expect(
      await within(dialog).findByText("This envelope is already finished, so it cannot be voided."),
    ).toBeVisible();
  }, 20_000);

  it("queues a status check and names a rate limit", async () => {
    let n = 0;
    handlers({
      "POST /api/v1/esign/envelopes/{id}/sync": () => {
        n += 1;
        return n === 1
          ? [202, { ok: true }]
          : json(
              429,
              { error: { code: "rate_limited", message: "slow down", requestId: "r" } },
              { "retry-after": "30" },
            );
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Details for Seed 2026 subscription agreement (Ada Lovelace)" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Check status now" }));
    expect(await screen.findByText("Status check queued")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Check status now" }));
    expect(await within(dialog).findByText(/30 seconds/u)).toBeVisible();
  }, 20_000);

  it("downloads the signed PDF and the certificate of a completed envelope", async () => {
    const created: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        created.push(blob.type);
        return `blob:${created.length}`;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    try {
      const pdf = () =>
        new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      handlers({
        "GET /api/v1/esign/envelopes/{id}/signed.pdf": pdf,
        "GET /api/v1/esign/envelopes/{id}/certificate.pdf": pdf,
      });
      await openScreen();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole(
          "button",
          { name: "Details for Mutual NDA (Grace Brewster)" },
          { timeout: 5000 },
        ),
      );
      const dialog = await screen.findByRole("dialog", { name: "Mutual NDA" });
      expect(within(dialog).getByText("Yes")).toBeVisible();
      // Completed and collected: nothing left to void or nudge.
      expect(within(dialog).queryByRole("button", { name: "Void" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Check status now" })).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Download signed PDF" }));
      await waitFor(() => expect(clicked).toContain("mutual-nda-signed.pdf"));
      await user.click(within(dialog).getByRole("button", { name: "Download certificate" }));
      await waitFor(() => expect(clicked).toContain("mutual-nda-certificate.pdf"));
      expect(created).toEqual(["application/pdf", "application/pdf"]);
    } finally {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  }, 20_000);

  /** One envelope in the list and in its detail; opens the dialog. */
  async function openOnly(envelope: ReturnType<typeof esignEnvelope>) {
    handlers({
      "GET /api/v1/esign/envelopes": () => [200, { items: [envelope], nextCursor: null }],
      "GET /api/v1/esign/envelopes/{id}": () => [200, envelope],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Details for/u }, { timeout: 5000 }),
    );
    return screen.findByRole("dialog");
  }

  it("explains an envelope that failed the malware scan and offers no resync", async () => {
    // The real shape: the row stays `completed` (a trigger forbids leaving it), no artifacts.
    const dialog = await openOnly(
      esignEnvelope({
        status: "completed",
        signerStatus: "signed",
        completedAt: "2026-09-22T10:00:00.000Z",
        errorCode: "artifact_infected",
      }),
    );
    expect(await within(dialog).findByText(/failed the malware scan/u)).toBeVisible();
    // The server never collects an infected artifact again, so "check status now" would lie.
    expect(within(dialog).queryByRole("button", { name: "Check status now" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Void" })).toBeNull();
    expect(within(dialog).queryByText(/being collected/u)).toBeNull();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("offers a retry for a signed copy that failed to collect", async () => {
    const dialog = await openOnly(
      esignEnvelope({
        status: "completed",
        signerStatus: "signed",
        completedAt: "2026-09-22T10:00:00.000Z",
        errorCode: "artifact_too_large",
      }),
    );
    expect(await within(dialog).findByText(/larger than this server accepts/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Check status now" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Void" })).toBeNull();
  }, 20_000);

  it("treats an errored envelope the vendor accepted as still open: void and resync", async () => {
    let voided = false;
    let synced = false;
    handlers({
      "GET /api/v1/esign/envelopes": () => [
        200,
        { items: [esignEnvelope({ status: "error", errorCode: "unavailable" })], nextCursor: null },
      ],
      "GET /api/v1/esign/envelopes/{id}": () => [
        200,
        esignEnvelope({ status: "error", errorCode: "unavailable" }),
      ],
      "POST /api/v1/esign/envelopes/{id}/sync": () => {
        synced = true;
        return [202, { ok: true }];
      },
      "POST /api/v1/esign/envelopes/{id}/void": () => {
        voided = true;
        return [200, esignEnvelope({ status: "voided", errorCode: null })];
      },
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Details for/u }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/vendor still has this envelope/u)).toBeVisible();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Check status now" }));
    await waitFor(() => expect(synced).toBe(true));
    await user.click(within(dialog).getByRole("button", { name: "Void" }));
    await user.type(within(dialog).getByLabelText(/Reason/u), "Wrong investor");
    await user.click(within(dialog).getByRole("button", { name: "Void envelope" }));
    await waitFor(() => expect(voided).toBe(true));
  }, 20_000);

  it("offers nothing to void or pull for an envelope that never reached the vendor", async () => {
    const dialog = await openOnly(
      esignEnvelope({
        status: "error",
        signerStatus: null,
        sentAt: null,
        errorCode: "orphaned_draft",
      }),
    );
    expect(await within(dialog).findByText(/never confirmed creating/u)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Check status now" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Void" })).toBeNull();
    expect(within(dialog).queryByText(/vendor still has this envelope/u)).toBeNull();
  }, 20_000);
});

describe("e-signature admin: permissions", () => {
  it("hides every write from a reader", async () => {
    handlers({}, ["esign.read"]);
    const r = await openScreen();
    expect(
      await screen.findByRole("heading", { name: "Documenso" }, { timeout: 5000 }),
    ).toBeVisible();
    await expectNoA11yViolations(r.container);
    for (const name of [
      "Verify again",
      "Replace credentials",
      "Rotate callback secret",
      "Disconnect",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Details for Mutual NDA (Grace Brewster)" }),
    );
    const dialog = await screen.findByRole("dialog");
    // Reading includes the signed copy; acting on the envelope does not.
    expect(within(dialog).getByRole("button", { name: "Download signed PDF" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(
      screen.getByRole("button", {
        name: "Details for Seed 2026 subscription agreement (Ada Lovelace)",
      }),
    );
    const open = await screen.findByRole("dialog");
    expect(within(open).queryByRole("button", { name: "Void" })).toBeNull();
    expect(within(open).queryByRole("button", { name: "Check status now" })).toBeNull();
    await expectNoA11yViolations(open);
  }, 20_000);

  it("tells a reader nobody has connected a vendor yet, without a form", async () => {
    handlers(notConnected, ["esign.read"]);
    await openScreen();
    expect(
      await screen.findByText(/An owner or admin can connect one/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("radio")).toBeNull();
  }, 20_000);

  it("hides the nav entry and refuses the screen without esign.read", async () => {
    const { calls } = handlers({}, []);
    const r = await renderApp("/admin/esign");
    expect(
      await screen.findByText(
        "You need e-signature access to see this page.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "E-signature" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/esign"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

// A-3 (ADR-0063): a downgrade freezes the configuration — the connection can be maintained
// (re-checked, its credentials replaced for the same vendor), not moved to another vendor.
describe("e-signature admin on a plan without e-signature", () => {
  it("keeps verify, replace, rotate and disconnect, and locks the other vendors", async () => {
    const { calls } = handlers({
      "PUT /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
    });
    withPlanEntitlements({ features: ["sso"] });
    const r = await openScreen();
    expect(
      await screen.findByText(
        "Your plan doesn't include E-signature services. What you've already set up keeps working.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Verify again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rotate callback secret" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Replace credentials" }));
    expect(screen.getByRole("radio", { name: "DocuSeal" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Documenso" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Verify and replace" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/esign/connection")).toBe(
        true,
      ),
    );
  }, 20_000);

  it("warns that disconnecting cannot be undone on this plan (RR3 RL4)", async () => {
    handlers();
    withPlanEntitlements({ features: [] });
    await openScreen();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Your plan doesn't include E-signature services, so you won't/u),
    ).toBeInTheDocument();
  }, 20_000);

  it("will not connect a vendor for the first time", async () => {
    handlers(notConnected);
    withPlanEntitlements({ features: [] });
    await openScreen();
    expect(
      await screen.findByRole("button", { name: "Verify and connect" }, { timeout: 5000 }),
    ).toBeDisabled();
  }, 20_000);
});
