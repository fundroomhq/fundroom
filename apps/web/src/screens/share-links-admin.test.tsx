import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  type Handler,
  installMockApi,
  shareLink,
  shareLinkVisit,
} from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/admin/share-links` (E2.3). The three things the screen exists to say, and one it must not:
 *
 *  - the minted URL exists once, so it is pinned and copyable;
 *  - pausing suspends the people already inside, not merely new ones (contract A6);
 *  - revoking the link and revoking the access it gave are two different decisions;
 *  - and the Rule 506(b) audience rule is the **server's** — the screen renders the refusal and
 *    never decides for itself whether a link is too open.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const LINK_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5801";
const URL_SHOWN = "https://investors.acme.test/s/8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions = ["share-links.read", "share-links.manage"]) =>
  bootstrap({
    modules: [],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/links": () => [200, { links: [shareLink()] }],
    ...over,
  });
}

async function openScreen(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/share-links");
  expect(
    await screen.findByRole("heading", { name: "Share links", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("share links admin", () => {
  it("lists a link with its counters and audience, and never its token", async () => {
    handlers();
    const r = await openScreen();
    expect(
      await screen.findByText("Sent to Northwind at the Q3 meeting", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("northwind.test")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    // Nothing on this screen may show a secret: the row has neither digest and the list
    // response has no token field at all.
    expect(r.container.textContent).not.toContain("8Zr2Qk9v");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says that pausing suspends the people already inside", async () => {
    let current = shareLink();
    const { calls } = handlers({
      "GET /api/v1/links": () => [200, { links: [current] }],
      "POST /api/v1/links/{id}/pause": () => {
        current = shareLink({ status: "paused" });
        return [200, current];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pause" }, { timeout: 5000 }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/v1/links/${LINK_ID}/pause`)).toBe(true),
    );
    expect(await screen.findByText("Paused, for everyone")).toBeInTheDocument();
    // A6: the sentence an admin who reads "paused" as "no new visitors" would need.
    expect(
      screen.getByText(/suspends the access of everyone it has already admitted/u),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says an exhausted link still works for the people already inside", async () => {
    handlers({ "GET /api/v1/links": () => [200, { links: [shareLink({ maxUses: 2, uses: 2 })] }] });
    const r = await openScreen();
    expect(
      await screen.findByText("This link has reached its limit", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The people it already admitted keep their access/u)).toBeVisible();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("makes both halves of the revoke choice plain and sends the one that was picked", async () => {
    const { calls } = handlers({ "POST /api/v1/links/{id}/revoke": () => [200, { ok: true }] });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    // The default is the quieter option, and the dialog says what it means rather than
    // leaving the admin to infer it from the checkbox label.
    expect(within(dialog).getByText(/They keep the access this link gave them/u)).toBeVisible();
    const box = within(dialog).getByRole("checkbox", {
      name: /Also end the access this link gave/u,
    });
    expect(box).not.toBeChecked();
    // Scoped to the dialog, as the other dialog screens do: Radix marks the rest of the page
    // `aria-hidden` while it is open, and jsdom has no `inert` to go with it.
    await expectNoA11yViolations(dialog);

    await user.click(box);
    expect(within(dialog).getByText(/Their access through this link ends now/u)).toBeVisible();
    expect(within(dialog).getByText(/They stay members/u)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/api/v1/links/${LINK_ID}/revoke`)?.body).toEqual({
        revokeMemberships: true,
      }),
    );
  }, 20_000);

  it("shows the minted URL once and copies it", async () => {
    const { calls } = handlers({
      "GET /api/v1/links": () => [200, { links: [] }],
      "POST /api/v1/links": () => [
        201,
        {
          link: shareLink({ label: "Northwind" }),
          token: "8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA",
          url: URL_SHOWN,
        },
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    // After `setup()`, which installs a clipboard of its own over whatever is there.
    const writeText = stubClipboard();
    await user.type(
      await screen.findByLabelText(/What is this link for/u, {}, { timeout: 5000 }),
      "Northwind",
    );
    await user.type(screen.getByLabelText(/Email domains/u), "northwind.test");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByText("Here is the link — copy it now")).toBeInTheDocument();
    expect(screen.getByText(URL_SHOWN)).toBeInTheDocument();
    expect(screen.getByText(/This is the only time it is shown/u)).toBeVisible();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_SHOWN));
    expect(
      calls.find((c) => c.method === "POST" && c.path === "/api/v1/links")?.body,
    ).toMatchObject({ label: "Northwind", policy: { domains: ["northwind.test"], emails: [] } });
  }, 20_000);

  it("targets a folder by `{kind, id}` alone — the server derives the rule's path", async () => {
    // Review R1-A1/A2: a rule's path is a scope, so the browser never sends one. The server
    // files a folder grant under the folder's own path (covering its documents) and refuses a
    // path that is not that one.
    const FOLDER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03";
    const { calls } = handlers({
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          modules: [
            {
              id: "data-room",
              version: "0.1.0",
              enabled: true,
              hidden: false,
              readOnly: false,
              flags: {},
              slots: {},
            },
          ],
          permissions: ["share-links.read", "share-links.manage"],
          membership: { id: OWNER_ID, kind: "staff", role: "owner" },
        }),
      ],
      "GET /api/v1/data-room/tree": () => [
        200,
        {
          rootId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
          folders: [{ id: FOLDER_ID, name: "Financials", path: "r.fin", parentId: null }],
          documents: [],
        },
      ],
      "GET /api/v1/links": () => [200, { links: [] }],
      "POST /api/v1/links": () => [
        201,
        { link: shareLink({ label: "Financials" }), token: "t".repeat(43), url: URL_SHOWN },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/What is this link for/u, {}, { timeout: 5000 }),
      "Financials",
    );
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /Folder or document/u }, { timeout: 5000 }),
      await screen.findByRole("option", { name: "Financials" }, { timeout: 5000 }),
    );
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(
        (
          calls.find((c) => c.method === "POST" && c.path === "/api/v1/links")?.body as {
            grants?: unknown;
          }
        )?.grants,
      ).toEqual([{ resource: { kind: "folder", id: FOLDER_ID }, capabilities: ["view"] }]),
    );
  }, 20_000);

  it("renders the server's 506(b) refusal instead of deciding for itself", async () => {
    handlers({
      "GET /api/v1/links": () => [200, { links: [] }],
      "POST /api/v1/links": () =>
        apiError(403, "forbidden", { reason: "audience_too_open", offeringStatus: "506b" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    // Deliberately no audience: the browser must NOT pre-empt this — it sends the link and
    // shows what the server said, naming the offering mode the server named.
    await user.type(
      await screen.findByLabelText(/What is this link for/u, {}, { timeout: 5000 }),
      "Anyone",
    );
    const submit = screen.getByRole("button", { name: "Create link" });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(
      await screen.findByText(/Under Rule 506\(b\) a link has to name its audience/u),
    ).toBeVisible();
    expect(screen.getByLabelText(/Email domains/u)).toHaveAttribute("aria-invalid", "true");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("names the offering mode when links are refused outright", async () => {
    handlers({
      "GET /api/v1/links": () => [200, { links: [] }],
      "POST /api/v1/links": () =>
        apiError(403, "forbidden", {
          reason: "links_not_permitted",
          offeringStatus: "informational",
        }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(/What is this link for/u, {}, { timeout: 5000 }),
      "Anything",
    );
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect(
      await screen.findByText(/Share links are not permitted while the offering mode is/u),
    ).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lists who came in through the link, on demand", async () => {
    const { calls } = handlers({
      "GET /api/v1/links/{id}/visits": () => [200, { visits: [shareLinkVisit()] }],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: /Who came in/u }, { timeout: 5000 });
    // Not fetched until asked: the admin list is about the links, not their visitors.
    expect(calls.some((c) => c.path.endsWith("/visits"))).toBe(false);
    await user.click(toggle);
    expect(await screen.findByText("ada@northwind.test")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides every mutation from a reader", async () => {
    handlers({}, ["share-links.read"]);
    const r = await openScreen();
    expect(
      await screen.findByText("Sent to Northwind at the Q3 meeting", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create a share link" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
