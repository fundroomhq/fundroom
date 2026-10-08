import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  customDomain,
  customDomainList,
  DOMAIN_CNAME_TARGET,
  type Handler,
  installMockApi,
  verifiedDomain,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/domains` (E2.1). The four states, the two records, and — the point of the screen —
 * one sentence per refusal: the server distinguishes an IP literal from a public suffix from a
 * hostname another workspace has already verified, and a client that showed "conflict" for all
 * three would make the admin guess which problem they have.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const HOST = "investors.acme.test";

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
  permissions = ["domains.read", "domains.manage"],
  role = "owner",
): ReturnType<typeof bootstrap> =>
  bootstrap({ modules: [], permissions, membership: { id: OWNER_ID, kind: "staff", role } });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
  role?: string,
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions, role)],
    "GET /api/v1/domains": () => [200, customDomainList()],
    ...over,
  });
}

async function openDomains(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/domains");
  expect(
    await screen.findByRole("heading", { name: "Domains", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("domains admin", () => {
  it("renders the domain the workspace has added, with both records", async () => {
    handlers();
    const r = await openDomains();
    const table = await screen.findByRole(
      "table",
      { name: `DNS records for ${HOST}` },
      { timeout: 5000 },
    );
    // The two records design/07 §2.2 asks for: routing and proof of control.
    expect(within(table).getByText(HOST)).toBeInTheDocument();
    expect(within(table).getByText(DOMAIN_CNAME_TARGET)).toBeInTheDocument();
    expect(within(table).getByText(`_fundroom-challenge.${HOST}`)).toBeInTheDocument();
    // Nothing has been looked up yet, so the status column says so rather than "missing".
    expect(within(table).getAllByText("Not checked")).toHaveLength(2);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();
    expect(screen.getByText(/give up on/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    // After `setup()`, which installs a clipboard of its own over whatever is there.
    const user = userEvent.setup();
    const writeText = stubClipboard();
    const txtRow = within(table).getByText(`_fundroom-challenge.${HOST}`).closest("tr");
    await user.click(within(txtRow as HTMLElement).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("k7q2v9x4m3n8b5c1z6t0r7y2w4e9u3i8"));
  }, 20_000);

  it("adds a domain and sends the hostname exactly as typed", async () => {
    let added: ReturnType<typeof customDomain> | undefined;
    const { calls } = handlers({
      "GET /api/v1/domains": () => [
        200,
        customDomainList({ domains: added === undefined ? [] : [added] }),
      ],
      "POST /api/v1/domains": ({ body }) => {
        const hostname = (body as { hostname: string }).hostname.toLowerCase();
        added = customDomain({ hostname });
        return [201, added];
      },
    });
    const r = await openDomains();
    expect(await screen.findByText("No custom domain yet")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    // Trailing space and mixed case on purpose: the client trims, and normalisation (IDNA,
    // lower-casing) is the server's job — so what goes on the wire is what was typed.
    await user.type(screen.getByLabelText("Hostname"), "  Investors.ACME.test  ");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/domains")?.body).toEqual({
        hostname: "Investors.ACME.test",
      }),
    );
    expect(
      await screen.findByRole("table", { name: `DNS records for ${HOST}` }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("gives each refusal its own sentence", async () => {
    handlers({
      "GET /api/v1/domains": () => [200, customDomainList({ domains: [] })],
      "POST /api/v1/domains": ({ body }) => {
        switch ((body as { hostname: string }).hostname) {
          case "203.0.113.10":
            return apiError(400, "invalid_request", { reason: "ip_literal" });
          case "taken.example.com":
            return apiError(409, "conflict", { reason: "claimed_elsewhere" });
          default:
            return apiError(409, "conflict", {
              reason: "workspace_already_verified",
              hostname: HOST,
            });
        }
      },
    });
    const r = await openDomains();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Hostname");

    await user.type(field, "203.0.113.10");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    expect(await screen.findByText(/That is an IP address/u, {}, { timeout: 5000 })).toBeVisible();
    await expectNoA11yViolations(r.container);

    await user.clear(field);
    await user.type(field, "taken.example.com");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    // Says what happened without naming the other workspace: whose hostname it is is not this
    // admin's business, and the server does not tell the client either.
    expect(await screen.findByText(/Another workspace on this install/u)).toBeVisible();

    await user.clear(field);
    await user.type(field, "second.example.com");
    await user.click(screen.getByRole("button", { name: "Add domain" }));
    // Their own hostname, so it is named: that is the only actionable answer.
    expect(await screen.findByText(new RegExp(`already serves ${HOST}`, "u"))).toBeVisible();
  }, 20_000);

  it("cloudflare-saas: shows Cloudflare's state and optional records, and no visit link", async () => {
    handlers({
      "GET /api/v1/domains": () => [
        200,
        customDomainList({
          driver: "cloudflare-saas",
          domains: [
            verifiedDomain({
              providerState: "pending",
              providerRecords: [
                {
                  type: "TXT",
                  name: `_cf-custom-hostname.${HOST}`,
                  value: "5cc07c04-ea62-4a5a-95f0-419334a875a4",
                  required: false,
                },
              ],
            }),
          ],
        }),
      ],
    });
    const r = await openDomains();
    const table = await screen.findByRole(
      "table",
      { name: `Cloudflare validation records for ${HOST}` },
      { timeout: 5000 },
    );
    expect(within(table).getByText(`_cf-custom-hostname.${HOST}`)).toBeInTheDocument();
    expect(within(table).getByText("advisory")).toBeInTheDocument();
    expect(screen.getByText("Being issued")).toBeInTheDocument();
    // Cloudflare issues the certificate itself: nothing for the founder to open.
    expect(screen.getByText(/goes live by itself/u)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open https://${HOST}` })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("verifies a pending domain and then explains that the certificate needs a visit", async () => {
    let current = customDomain();
    const { calls } = handlers({
      "GET /api/v1/domains": () => [200, customDomainList({ domains: [current] })],
      "POST /api/v1/domains/{id}/verify": () => {
        current = verifiedDomain();
        return [200, current];
      },
    });
    await openDomains();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Verify now" }, { timeout: 5000 }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === `/api/v1/domains/${current.id}/verify`),
      ).toBe(true),
    );
    expect(await screen.findByText("Verified", {}, { timeout: 5000 })).toBeInTheDocument();
    // The whole reason `dns_ok` needs copy: nothing else will happen until somebody loads it.
    expect(screen.getByText(/obtained on the first HTTPS request/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `Open https://${HOST}` })).toHaveAttribute(
      "href",
      `https://${HOST}`,
    );
    expect(screen.getByText("both records resolve")).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: `DNS records for ${HOST}` })).getAllByText("Found"),
    ).toHaveLength(2);
  }, 20_000);

  it("offers a member with only domains.read nothing to change", async () => {
    handlers({}, ["domains.read"], "member");
    const r = await openDomains();
    expect(await screen.findByLabelText("Hostname")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify now" })).toBeNull();
    // Read-only, not hidden: the records are still there to read and to send on.
    expect(screen.getByRole("table", { name: `DNS records for ${HOST}` })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("removes a domain only through the confirmation dialog", async () => {
    let removed = false;
    const { calls } = handlers({
      "GET /api/v1/domains": () => [
        200,
        customDomainList({ domains: removed ? [] : [verifiedDomain({ status: "active" })] }),
      ],
      "DELETE /api/v1/domains/{id}": () => {
        removed = true;
        return [200, { ok: true }];
      },
    });
    const r = await openDomains();
    expect(await screen.findByText("Live", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/primary origin/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove domain" }));
    const dialog = await screen.findByRole("dialog");
    // The two consequences that cannot be undone by re-adding it.
    expect(dialog).toHaveTextContent(/signed out/u);
    await user.click(within(dialog).getByRole("button", { name: "Remove domain" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path.startsWith("/api/v1/domains/")),
      ).toBe(true),
    );
    expect(await screen.findByText("No custom domain yet")).toBeInTheDocument();
  }, 20_000);

  it("does not promise a certificate on an install that only verifies ownership", async () => {
    handlers({
      "GET /api/v1/domains": () => [
        200,
        customDomainList({
          driver: "manual",
          domains: [
            customDomain({
              records: [
                {
                  type: "TXT",
                  name: `_fundroom-challenge.${HOST}`,
                  value: "k7q2v9x4m3n8b5c1z6t0r7y2w4e9u3i8",
                  required: true,
                },
              ],
            }),
          ],
        }),
      ],
    });
    const r = await openDomains();
    expect(
      await screen.findByText(/verifies who owns a hostname/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: `DNS records for ${HOST}` })).getAllByRole("row"),
    ).toHaveLength(2);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
