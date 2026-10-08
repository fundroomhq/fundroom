import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  complianceSettings,
  dataRequest,
  type Handler,
  installMockApi,
  offeringState,
  W2_ADA_ID,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The "Data requests" tab of /admin/legal (E2.7): every kind of DSAR in one list with kind and
 * status filters, a detail view per request, recording access/rectification requests, the
 * subject export download (a `fresh` route) and "Mark complete" for access/rectification.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const RECT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a92";
const NOW = "2026-09-12T10:00:00.000Z";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const person = () => ({
  membershipId: W2_ADA_ID,
  userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02",
  kind: "external",
  role: "investor",
  status: "active",
  displayName: "Ada Lovelace",
  email: "ada@investor.test",
  groups: [],
  profile: {},
  source: "invite",
  principalMembershipId: null,
  delegateScope: null,
  principal: null,
  expiresAt: null,
  lastSeenAt: null,
  activatedAt: NOW,
  createdAt: NOW,
});

function handlers(
  over: Record<string, Handler> = {},
  permissions = ["compliance.read", "compliance.manage", "access.read"],
) {
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
    "GET /api/v1/compliance/offering": () => [200, offeringState()],
    "GET /api/v1/compliance/settings": () => [200, complianceSettings()],
    "GET /api/v1/compliance/documents": () => [200, { documents: [] }],
    "GET /api/v1/compliance/templates": () => [200, { templates: [] }],
    "GET /api/v1/access/people": () => [200, { items: [person()], nextCursor: null }],
    ...over,
  });
}

async function openRequests() {
  const user = userEvent.setup();
  const r = await renderApp("/admin/legal");
  expect(
    await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Data requests" }));
  return { user, r };
}

function withObjectUrls(): { created: string[]; clicked: HTMLAnchorElement[]; undo: () => void } {
  const created: string[] = [];
  const clicked: HTMLAnchorElement[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      created.push(blob.type);
      return `blob:${created.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  return {
    created,
    clicked,
    undo: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

describe("data requests", () => {
  it("lists every kind, filters by kind and status, and loads more", async () => {
    const queries: URLSearchParams[] = [];
    handlers({
      "GET /api/v1/compliance/data-requests": ({ url }) => {
        queries.push(url.searchParams);
        if (url.searchParams.get("kind") === "rectification") {
          return [
            200,
            {
              items: [dataRequest({ id: RECT_ID, kind: "rectification" })],
              nextCursor: null,
            },
          ];
        }
        if (url.searchParams.get("cursor") === "next-1") {
          return [
            200,
            {
              items: [
                dataRequest({
                  id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a93",
                  kind: "erasure",
                  subjectName: null,
                  status: "completed",
                  completedAt: NOW,
                }),
              ],
              nextCursor: null,
            },
          ];
        }
        return [200, { items: [dataRequest({ overdue: true })], nextCursor: "next-1" }];
      },
    });
    const { user, r } = await openRequests();
    const table = await screen.findByRole("table", { name: "Data requests" });
    expect(within(table).getByText("Access")).toBeInTheDocument();
    expect(within(table).getByText("Overdue")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    // An erased subject has no name any more: a short reference stands in.
    expect(await within(table).findByText("Member 0192f1a0")).toBeInTheDocument();
    expect(within(table).getByText("Erasure")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Kind"), "rectification");
    expect(await screen.findByText("Rectification", { selector: "td" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "requested");
    await waitFor(() =>
      expect(
        queries.some((q) => q.get("kind") === "rectification" && q.get("status") === "requested"),
      ).toBe(true),
    );
  }, 20_000);

  it("shows a request's detail: steps with counts, completion note and export fingerprint", async () => {
    handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        {
          items: [
            dataRequest({
              status: "completed",
              completedAt: NOW,
              note: "Asked by email",
              completionNote: "Sent the zip",
              exportSha256: "a".repeat(64),
              steps: [{ module: "crm", completedAt: NOW, counts: { contacts: 1, notes: 3 } }],
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    const { user, r } = await openRequests();
    await user.click(
      await screen.findByRole(
        "button",
        { name: /Details.*Access request from Ada Lovelace/u },
        { timeout: 5000 },
      ),
    );
    expect(await screen.findByText("Access request: Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Asked by email")).toBeInTheDocument();
    expect(screen.getByText("Sent the zip")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    const steps = screen.getByRole("table", { name: "Steps" });
    expect(within(steps).getByText("crm")).toBeInTheDocument();
    expect(within(steps).getByText("contacts: 1, notes: 3")).toBeInTheDocument();
    // Closed: nothing left to complete.
    expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("records an access or rectification request for a picked member, and explains an open one", async () => {
    let refuse = false;
    const { calls } = handlers({
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/data-requests": () =>
        refuse
          ? apiError(409, "conflict", { reason: "request_open" })
          : [201, dataRequest({ kind: "rectification" })],
    });
    const { user, r } = await openRequests();
    expect(await screen.findByText("No data requests match.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Rectification/u }));
    const picker = screen.getByLabelText("Subject");
    await within(picker).findByRole("option", { name: /Ada Lovelace/u });
    await user.selectOptions(picker, W2_ADA_ID);
    await user.type(screen.getByLabelText("Request note"), "Wrong firm name");
    await user.click(screen.getByRole("button", { name: "Record request" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/compliance/data-requests")
          ?.body,
      ).toEqual({ kind: "rectification", membershipId: W2_ADA_ID, note: "Wrong firm name" }),
    );
    await expectNoA11yViolations(r.container);

    refuse = true;
    await user.selectOptions(screen.getByLabelText("Subject"), W2_ADA_ID);
    await user.click(screen.getByRole("button", { name: "Record request" }));
    expect(
      await screen.findByText(/already has an open request of this kind/u),
    ).toBeInTheDocument();
  }, 20_000);

  it("downloads the subject export, then marks the access request complete with its fingerprint", async () => {
    const urls = withObjectUrls();
    const SHA = "b".repeat(64);
    const { calls } = handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        { items: [dataRequest()], nextCursor: null },
      ],
      "GET /api/v1/compliance/subjects/{membershipId}/export": ({ params }) => {
        expect(params["membershipId"]).toBe(W2_ADA_ID);
        return new Response("PK\u0003\u0004", {
          status: 200,
          headers: { "content-type": "application/zip", "x-content-sha256": SHA },
        });
      },
      "POST /api/v1/compliance/data-requests/{id}/complete": () => [
        200,
        dataRequest({ status: "completed", completedAt: NOW, completionNote: "Sent" }),
      ],
    });
    const { user } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "Download export" }));
    await waitFor(() => expect(urls.clicked).toHaveLength(1));
    expect(urls.clicked[0]?.download).toBe("data-export-0192f1a0.zip");
    expect(urls.created).toEqual(["application/zip"]);
    urls.undo();
    // The download changed nothing on the server: no completion was sent by it.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    // Its fingerprint is remembered and offered back.
    const field = await screen.findByLabelText("Export fingerprint (SHA-256)");
    expect(field).toHaveValue(SHA);
    expect(screen.getByText(/Filled in from the export you just downloaded/u)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Completion note"), "Sent");
    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/compliance/data-requests/${dataRequest().id}/complete`,
        )?.body,
      ).toEqual({ note: "Sent", exportSha256: SHA }),
    );
  }, 20_000);

  it("explains a fingerprint the server does not recognise", async () => {
    handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        { items: [dataRequest()], nextCursor: null },
      ],
      "POST /api/v1/compliance/data-requests/{id}/complete": () =>
        apiError(409, "conflict", { reason: "export_unknown" }),
    });
    const { user } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    await user.type(await screen.findByLabelText("Export fingerprint (SHA-256)"), "c".repeat(64));
    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    expect(
      await screen.findByText(/does not match any export of this person/u),
    ).toBeInTheDocument();
  }, 20_000);

  it("explains an erasure blocked because its subject is the last owner, and finishes it", async () => {
    let reason = "last_owner";
    const { calls } = handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        {
          items: [
            dataRequest({
              kind: "erasure",
              expectedModules: ["crm"],
              pendingModules: [],
              steps: [{ module: "crm", completedAt: NOW, counts: { contacts: 1 } }],
              blockedReason: "last_owner",
            }),
          ],
          nextCursor: null,
        },
      ],
      "POST /api/v1/compliance/data-requests/{id}/complete": () =>
        reason === "last_owner"
          ? apiError(409, "conflict", { reason: "last_owner" })
          : [200, dataRequest({ kind: "erasure", status: "completed", completedAt: NOW })],
    });
    const { user, r } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    expect(await screen.findByText("Waiting: this person is the last owner")).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace is now the workspace's only owner/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Finish erasure" }));
    expect(await screen.findByText(/still the workspace's only owner/u)).toBeInTheDocument();
    reason = "";
    await user.click(screen.getByRole("button", { name: "Finish erasure" }));
    await waitFor(() =>
      expect(
        calls.filter(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/compliance/data-requests/${dataRequest().id}/complete`,
        ),
      ).toHaveLength(2),
    );
    expect(await screen.findByText("Erasure finished")).toBeInTheDocument();
  }, 20_000);

  it("sends a stale session through step-up before downloading the export", async () => {
    handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        { items: [dataRequest()], nextCursor: null },
      ],
      "GET /api/v1/compliance/subjects/{membershipId}/export": () =>
        apiError(401, "step_up_required", { reason: "fresh" }),
    });
    const { user, r } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "Download export" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("guides a rectification to the person's page", async () => {
    handlers({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        { items: [dataRequest({ id: RECT_ID, kind: "rectification" })], nextCursor: null },
      ],
    });
    const { user, r } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    const link = await screen.findByRole("link", { name: "Open Ada Lovelace's page" });
    expect(link).toHaveAttribute("href", `/admin/people/${W2_ADA_ID}`);
    // Body-text links keep a persistent underline (jsdom axe cannot check contrast).
    expect(link.className).toContain("underline");
    expect(screen.getByRole("button", { name: "Mark complete" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("is read-only without compliance.manage", async () => {
    handlers(
      {
        "GET /api/v1/compliance/data-requests": () => [
          200,
          { items: [dataRequest()], nextCursor: null },
        ],
      },
      ["compliance.read"],
    );
    const { user } = await openRequests();
    await user.click(await screen.findByRole("button", { name: /Details/u }, { timeout: 5000 }));
    expect(await screen.findByText("Access request: Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download export" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record request" })).toBeNull();
  }, 20_000);
});
