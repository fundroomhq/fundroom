import type { FundRoomSchemas } from "@fundroom/sdk";
import { toast } from "@fundroomhq/ui";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Data-room Q&A, staff side (E3.3): the inbox (tabs with counts, filters, export/import, new
 * entry), one question's detail per permission set (viewer, answerer, approver, coordinator)
 * and the Q&A block of the data-room settings.
 */
afterEach(() => vi.unstubAllGlobals());

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const LEGAL = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const ME_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const ASKER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03";
const EDITOR_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c04";
const VIEWER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c05";
const Q1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01";
const Q2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02";
const NOW = "2026-09-12T10:00:00.000Z";

type Detail = FundRoomSchemas["QaInboxDetail"];
type Item = FundRoomSchemas["QaInboxItem"];

const ALL = [
  "data-room.read",
  "data-room.manage",
  "data-room.settings",
  "data-room.qa_answer",
  "data-room.qa_approve",
  "data-room.qa_manage",
];
const VIEWER = ["data-room.read"];
const ANSWERER = ["data-room.read", "data-room.qa_answer"];
const APPROVER = ["data-room.read", "data-room.qa_answer", "data-room.qa_approve"];

const staffBootstrap = (permissions: string[]) =>
  bootstrap({
    modules: [
      {
        id: "data-room",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            { id: "dr", label: "Data room", to: "/admin/data-room", order: 30, icon: "folder" },
          ],
        },
      },
    ],
    permissions,
    membership: { id: ME_ID, kind: "staff", role: "owner" },
  });

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: ME_ID, kind: "staff", role: "owner" }),
  });

function qaSettings(
  over: Partial<FundRoomSchemas["QaSettings"]> = {},
): FundRoomSchemas["QaSettings"] {
  return {
    enabled: true,
    requireApproval: false,
    slaHours: 72,
    reminderLeadHours: 24,
    defaultVisibility: "asker",
    allowFolderQuestions: true,
    maxOpenPerAsker: 25,
    ...over,
  };
}

function settings(qa: Partial<FundRoomSchemas["QaSettings"]> = {}) {
  return {
    watermarkByDefault: true,
    forensicByDefault: false,
    downloadByDefault: false,
    allowUnscanned: false,
    purgeAfterDays: 30,
    maxUploadBytes: null,
    scanner: "clamd",
    limits: { uploadMaxBytes: 2_147_483_648, renderMaxBytes: 104_857_600 },
    qa: qaSettings(qa),
  };
}

function item(over: Partial<Item> = {}): Item {
  return {
    id: Q1,
    subject: "Cap table question",
    target: { kind: "document", id: DOC, title: "Pitch deck" },
    askerName: "Ada Lovelace",
    assigneeName: null,
    status: "open",
    dueAt: "2026-09-15T10:00:00.000Z",
    sla: "on_track",
    createdAt: NOW,
    hasDraft: false,
    ...over,
  };
}

const COUNTS = {
  open: 3,
  assigned: 1,
  awaiting_approval: 2,
  answered: 0,
  published: 5,
  closed: 0,
};

function detail(over: Partial<Detail> = {}): Detail {
  return {
    id: Q1,
    source: "portal",
    status: "assigned",
    asker: { membershipId: ASKER_ID, displayName: "Ada Lovelace", email: "ada@example.com" },
    target: { kind: "document", id: DOC, title: "Pitch deck", path: "3", deleted: false },
    assignee: { membershipId: EDITOR_ID, displayName: "Edith Editor" },
    subject: "Cap table question",
    body: "Ada here from Lovelace Capital: is the option pool pre-money?",
    publicText: null,
    category: null,
    internalNote: null,
    visibility: null,
    dueAt: "2026-09-15T10:00:00.000Z",
    sla: "due_soon",
    answer: null,
    createdAt: NOW,
    releasedAt: null,
    publishedAt: null,
    closedAt: null,
    closedReason: null,
    ...over,
  };
}

function answer(over: Partial<NonNullable<Detail["answer"]>> = {}): NonNullable<Detail["answer"]> {
  return {
    body: "Yes, the pool is included pre-money.",
    author: { membershipId: EDITOR_ID, displayName: "Edith Editor" },
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    approvalCurrent: false,
    rejectedNote: null,
    ...over,
  };
}

function tree(): FundRoomSchemas["DataRoomTree"] {
  const access: FundRoomSchemas["AccessDecision"] = {
    allowed: true,
    capabilities: ["view"],
    pendingGates: [],
    reason: "granted",
  };
  return {
    rootId: ROOT,
    folders: [
      {
        id: LEGAL,
        parentId: ROOT,
        name: "Legal",
        path: "r.legal",
        index: "1",
        sortOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        purgeAfter: null,
        access,
        passthrough: false,
      },
    ],
    documents: [
      {
        id: DOC,
        folderId: ROOT,
        title: "Pitch deck",
        index: "2",
        sortOrder: 1,
        protection: { download: false, watermark: true, print: false },
        legalHold: false,
        currentVersionId: null,
        contentType: "application/pdf",
        sizeBytes: 1,
        pageCount: 1,
        renderStatus: "ready",
        scanStatus: "clean",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        purgeAfter: null,
        access,
      },
    ],
  } as FundRoomSchemas["DataRoomTree"];
}

const person = (membershipId: string, displayName: string, role: string) => ({
  membershipId,
  displayName,
  role,
  kind: "staff",
  status: "active",
});

function handlers(permissions: string[], extra: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/data-room/settings": () => [200, settings()],
    "GET /api/v1/data-room/tree": () => [200, tree()],
    "GET /api/v1/access/people": () => [
      200,
      {
        items: [
          person(ME_ID, "Grace Hopper", "owner"),
          person(EDITOR_ID, "Edith Editor", "editor"),
          person(VIEWER_ID, "Vera Viewer", "viewer"),
        ],
        nextCursor: null,
      },
    ],
    ...extra,
  });
}

/** One question whose state the action handlers replace. */
function detailRoutes(start: Detail, actions: Record<string, Handler> = {}) {
  let current = start;
  const set = (d: Detail) => {
    current = d;
    return [200, d] as [number, unknown];
  };
  return {
    routes: {
      "GET /api/v1/data-room/qa/inbox/{id}": () => [200, current],
      ...actions,
    } as Record<string, Handler>,
    set,
    get: () => current,
  };
}

function withObjectUrls(): { clicked: HTMLAnchorElement[]; undo: () => void } {
  const clicked: HTMLAnchorElement[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:1" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  return {
    clicked,
    undo: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

describe("data room Q&A inbox", () => {
  it("shows tabs with counts, the table, and sends the filters", async () => {
    const user = userEvent.setup();
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": ({ url }) => {
        const status = url.searchParams.get("status");
        if (url.searchParams.get("cursor") === "c2")
          return [
            200,
            {
              items: [item({ id: Q2, subject: "Second page" })],
              nextCursor: null,
              counts: COUNTS,
            },
          ];
        if (status === "awaiting_approval")
          return [
            200,
            {
              items: [
                item({
                  status: "awaiting_approval",
                  subject: "Imported FAQ",
                  askerName: null,
                  assigneeName: "Edith Editor",
                  sla: "overdue",
                }),
              ],
              nextCursor: "c2",
              counts: COUNTS,
            },
          ];
        return [200, { items: [item()], nextCursor: null, counts: COUNTS }];
      },
    });
    const r = await renderApp("/admin/data-room/questions");
    const link = await screen.findByRole("link", { name: "Cap table question" }, { timeout: 5000 });
    expect(link).toHaveAttribute("href", `/admin/data-room/questions/${Q1}`);
    expect(screen.getByRole("tab", { name: "Open (3)" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "Published (5)" })).toBeInTheDocument();
    const row = screen.getAllByRole("row")[1]!;
    expect(within(row).getByRole("link", { name: "Pitch deck" })).toHaveAttribute(
      "href",
      `/admin/data-room/documents/${DOC}`,
    );
    expect(within(row).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(row).getByText("On track")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Questions" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("tab", { name: "Awaiting approval (2)" }));
    const imported = await screen.findByRole("link", { name: "Imported FAQ" });
    const importedRow = imported.closest("tr")!;
    expect(within(importedRow).getByText("—")).toBeInTheDocument();
    expect(within(importedRow).getByText("Overdue")).toBeInTheDocument();
    expect(within(importedRow).getByText("Edith Editor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Second page" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Assigned to"), "me");
    await user.click(screen.getByRole("checkbox", { name: "Overdue only" }));
    await waitFor(() => {
      const last = mock.fetchMock.mock.calls
        .map((c) => new URL(new Request(c[0] as RequestInfo).url))
        .filter((u) => u.pathname === "/api/v1/data-room/qa/inbox")
        .at(-1)!;
      expect(Object.fromEntries(last.searchParams)).toEqual({
        status: "awaiting_approval",
        assignee: "me",
        overdue: "true",
      });
    });
  }, 20_000);

  it("hides export, import and new entry without qa_manage", async () => {
    handlers(VIEWER, {
      "GET /api/v1/data-room/qa/inbox": () => [
        200,
        { items: [item()], nextCursor: null, counts: COUNTS },
      ],
    });
    await renderApp("/admin/data-room/questions");
    await screen.findByRole("link", { name: "Cap table question" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import CSV" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New entry" })).toBeNull();
    expect(screen.getByText(/You can read the questions/u)).toBeInTheDocument();
  }, 20_000);

  it("downloads the CSV export and sends a stale session to step-up", async () => {
    const user = userEvent.setup();
    const urls = withObjectUrls();
    let stale = false;
    try {
      const mock = handlers(ALL, {
        "GET /api/v1/data-room/qa/inbox": () => [
          200,
          { items: [], nextCursor: null, counts: COUNTS },
        ],
        "GET /api/v1/data-room/qa/export": () =>
          stale
            ? apiError(401, "step_up_required", { reason: "fresh" })
            : new Response("id,subject\n", {
                status: 200,
                headers: { "content-type": "text/csv" },
              }),
      });
      const r = await renderApp("/admin/data-room/questions");
      await user.click(
        await screen.findByRole("button", { name: "Export CSV" }, { timeout: 5000 }),
      );
      await waitFor(() => expect(urls.clicked).toHaveLength(1));
      expect(urls.clicked[0]!.download).toMatch(/^data-room-qa-\d{4}-\d{2}-\d{2}\.csv$/u);
      expect(mock.calls.find((c) => c.path === "/api/v1/data-room/qa/export")?.method).toBe("GET");

      stale = true;
      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    } finally {
      urls.undo();
    }
  }, 20_000);

  it("imports a CSV after a dry run: errors first, then confirm", async () => {
    const user = userEvent.setup();
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": () => [
        200,
        { items: [], nextCursor: null, counts: COUNTS },
      ],
      "POST /api/v1/data-room/qa/import": ({ body }) => {
        const b = body as { csv: string; dryRun: boolean };
        if (b.csv.includes("bad"))
          return [
            200,
            { rows: 1, created: 0, errors: [{ line: 2, message: "target_id is not a uuid" }] },
          ];
        return [200, { rows: 1, created: b.dryRun ? 0 : 1, errors: [] }];
      },
    });
    await renderApp("/admin/data-room/questions");
    await user.click(await screen.findByRole("button", { name: "Import CSV" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("CSV");
    await user.clear(field);
    await user.type(
      field,
      "target_kind,target_id,subject,question,answer,category,publish{enter}document,bad,S,Q,,,false",
    );
    await user.click(within(dialog).getByRole("button", { name: "Check file" }));
    expect(await within(dialog).findByText("target_id is not a uuid")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Import 1 question$/u })).toBeDisabled();
    await expectNoA11yViolations(dialog);

    await user.clear(field);
    await user.type(
      field,
      `target_kind,target_id,subject,question,answer,category,publish{enter}document,${DOC},S,Q,,,false`,
    );
    await user.click(within(dialog).getByRole("button", { name: "Check file" }));
    expect(await within(dialog).findByText("1 row is ready to import.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Import 1 question" }));
    expect(await within(dialog).findByText("Imported 1 question.")).toBeInTheDocument();
    const posts = mock.calls.filter((c) => c.path === "/api/v1/data-room/qa/import");
    expect(posts.map((c) => (c.body as { dryRun: boolean }).dryRun)).toEqual([true, true, false]);
    expect((posts[2]!.body as { csv: string }).csv).toContain(DOC);
  }, 20_000);

  it("creates a staff-authored entry against a picked target", async () => {
    const user = userEvent.setup();
    const created = detail({ id: Q2, source: "staff", asker: null, subject: "FAQ" });
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": () => [
        200,
        { items: [], nextCursor: null, counts: COUNTS },
      ],
      "POST /api/v1/data-room/qa/inbox": () => [201, created],
      "GET /api/v1/data-room/qa/inbox/{id}": () => [200, created],
    });
    const r = await renderApp("/admin/data-room/questions");
    await user.click(await screen.findByRole("button", { name: "New entry" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    expect(within(dialog).getByText("Choose a document or folder.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole("option", { name: "1 Legal" })).toBeInTheDocument(),
    );
    await user.selectOptions(within(dialog).getByLabelText(/^Document or folder/u), "1 Legal");
    await user.type(within(dialog).getByLabelText(/^Subject/u), "FAQ");
    await user.type(within(dialog).getByLabelText(/^Question/u), "When is the close?");
    await user.type(within(dialog).getByLabelText(/^Answer/u), "End of Q4.");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create entry" }));
    await waitFor(() =>
      expect(
        mock.calls.find((c) => c.method === "POST" && c.path === "/api/v1/data-room/qa/inbox")
          ?.body,
      ).toEqual({
        targetKind: "folder",
        targetId: LEGAL,
        subject: "FAQ",
        body: "When is the close?",
        answer: "End of Q4.",
      }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe(`/admin/data-room/questions/${Q2}`));
  }, 20_000);
});

describe("data room Q&A detail", () => {
  it("is read-only for a viewer", async () => {
    const d = detailRoutes(detail({ answer: answer(), internalNote: "Check with counsel" }));
    handlers(VIEWER, d.routes);
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    expect(
      await screen.findByRole("heading", { name: "Cap table question" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Check with counsel")).toBeInTheDocument();
    expect(screen.getByText("Due soon")).toBeInTheDocument();
    expect(screen.getByText("Yes, the pool is included pre-money.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    for (const name of [
      "Assign",
      "Save draft",
      "Release answer",
      "Close question",
      "Approve answer",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("marks a trashed target", async () => {
    const d = detailRoutes(
      detail({ target: { kind: "folder", id: LEGAL, title: "Legal", path: null, deleted: true } }),
    );
    handlers(VIEWER, d.routes);
    await renderApp(`/admin/data-room/questions/${Q1}`);
    expect(await screen.findByText("In recycle bin", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Legal" })).toHaveAttribute(
      "href",
      `/admin/data-room/folders/${LEGAL}`,
    );
  }, 20_000);

  it("lets an answerer save a draft and submit it for approval", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail());
    d.routes["PUT /api/v1/data-room/qa/inbox/{id}/answer"] = ({ body }) =>
      d.set(detail({ answer: answer({ body: (body as { body: string }).body }) }));
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/submit"] = () =>
      d.set(
        detail({
          status: "awaiting_approval",
          answer: answer({ body: "Draft", submittedAt: NOW }),
        }),
      );
    const mock = handlers(ANSWERER, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
    });
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    const editor = await screen.findByLabelText("Answer", {}, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).toBeNull();
    await user.type(editor, "Draft");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({ body: "Draft" }),
    );
    await user.click(await screen.findByRole("button", { name: "Submit for approval" }));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.path === `/api/v1/data-room/qa/inbox/${Q1}/submit`)).toBe(
        true,
      ),
    );
    expect(await screen.findByText("Awaiting approval")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("tells an approver they wrote the answer and shows the server's self-approval refusal", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(
      detail({
        status: "awaiting_approval",
        answer: answer({
          author: { membershipId: ME_ID, displayName: "Grace Hopper" },
          submittedAt: NOW,
        }),
      }),
    );
    handlers(APPROVER, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
      "POST /api/v1/data-room/qa/inbox/{id}/approve": () =>
        apiError(409, "conflict", { reason: "self_approval" }),
    });
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    expect(
      await screen.findByText(
        "You wrote this answer. Another approver has to approve it.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send back" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve answer" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You wrote this answer, so someone else must approve it.");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets an approver send an answer back with a note", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(
      detail({ status: "awaiting_approval", answer: answer({ submittedAt: NOW }) }),
    );
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/reject"] = () =>
      d.set(detail({ answer: answer({ rejectedNote: "Cite the SHA" }) }));
    const mock = handlers(APPROVER, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
    });
    await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(await screen.findByRole("button", { name: "Send back" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/What needs changing/u), "Cite the SHA");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Send back" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.path.endsWith("/reject"))?.body).toEqual({
        note: "Cite the SHA",
      }),
    );
    expect(await screen.findByText("Sent back by an approver")).toBeInTheDocument();
  }, 20_000);

  it("lets a coordinator assign and publish to the target with edited public text", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail({ answer: answer() }));
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/assign"] = ({ body }) =>
      (body as { assigneeMembershipId: string | null }).assigneeMembershipId === VIEWER_ID
        ? apiError(400, "validation_failed", { reason: "invalid_assignee" })
        : d.set(
            detail({
              answer: answer(),
              assignee: { membershipId: ME_ID, displayName: "Grace Hopper" },
            }),
          );
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/release"] = ({ body }) => {
      const b = body as { publicText: string };
      return d.set(
        detail({
          status: "published",
          visibility: "target",
          publicText: b.publicText,
          answer: answer(),
          releasedAt: NOW,
          publishedAt: NOW,
        }),
      );
    };
    const mock = handlers(ALL, d.routes);
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    const select = await screen.findByLabelText("Assignee", {}, { timeout: 5000 });
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Grace Hopper" })).toBeInTheDocument(),
    );
    // Only roles that can answer are offered.
    expect(within(select).queryByRole("option", { name: "Vera Viewer" })).toBeNull();
    await expectNoA11yViolations(r.container);
    await user.selectOptions(select, "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.path.endsWith("/assign"))?.body).toEqual({
        assigneeMembershipId: ME_ID,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Release answer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /The investor who asked/u })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: /Everyone who can see/u }));
    expect(within(dialog).getByText("Check for identifying details")).toBeInTheDocument();
    const text = within(dialog).getByLabelText(/^Published question/u);
    expect(text).toHaveValue(
      "Cap table question\n\nAda here from Lovelace Capital: is the option pool pre-money?",
    );
    await expectNoA11yViolations(dialog);
    await user.clear(text);
    await user.type(text, "Is the option pool pre-money?");
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.path.endsWith("/release"))?.body).toEqual({
        visibility: "target",
        publicText: "Is the option pool pre-money?",
      }),
    );
    expect(await screen.findByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cap table question" })).toHaveFocus();
  }, 20_000);

  it("shows each refusal reason inline", async () => {
    const user = userEvent.setup();
    let reason = "approval_required";
    const d = detailRoutes(detail({ source: "import", asker: null, answer: answer() }));
    handlers(ALL, {
      ...d.routes,
      "POST /api/v1/data-room/qa/inbox/{id}/release": () =>
        apiError(
          reason === "no_asker" ? 400 : 409,
          reason === "no_asker" ? "validation_failed" : "conflict",
          { reason },
        ),
      "POST /api/v1/data-room/qa/inbox/{id}/assign": () =>
        apiError(400, "validation_failed", { reason: "invalid_assignee" }),
    });
    await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Release answer" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    // No asker: only the target audience is possible.
    expect(within(dialog).getByRole("radio", { name: /The investor who asked/u })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /Everyone who can see/u })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The answer needs an approval that covers its current text before it can be released.",
    );
    reason = "no_asker";
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/Nobody asked this question/u),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.selectOptions(screen.getByLabelText("Assignee"), "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText(/That person cannot answer questions/u)).toBeInTheDocument();
  }, 20_000);

  it("closes, reopens and edits the metadata", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail());
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/close"] = () =>
      d.set(detail({ status: "closed", closedReason: "declined", closedAt: NOW }));
    d.routes["POST /api/v1/data-room/qa/inbox/{id}/reopen"] = () => d.set(detail());
    d.routes["PATCH /api/v1/data-room/qa/inbox/{id}"] = () =>
      d.set(detail({ category: "Legal", internalNote: "Ask counsel" }));
    const mock = handlers(ALL, d.routes);
    await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Close question" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: /Email the investor/u }));
    await user.click(within(dialog).getByRole("button", { name: "Close question" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.path.endsWith("/close"))?.body).toEqual({
        reason: "declined",
        notifyAsker: true,
      }),
    );
    expect(await screen.findByText(/^Declined on/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Close question" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Category"), "Legal");
    await user.type(screen.getByLabelText(/^Internal note/u), "Ask counsel");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({
        category: "Legal",
        internalNote: "Ask counsel",
      }),
    );
  }, 20_000);
});

describe("data room Q&A settings", () => {
  it("saves the Q&A block through PATCH /data-room/settings", async () => {
    const user = userEvent.setup();
    let current = settings({ enabled: false });
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/settings": () => [200, current],
      "PATCH /api/v1/data-room/settings": ({ body }) => {
        const qa = (body as { qa: Partial<FundRoomSchemas["QaSettings"]> }).qa;
        current = { ...current, qa: { ...current.qa, ...qa } };
        return [200, current];
      },
    });
    const r = await renderApp("/admin/data-room/settings");
    const enabled = await screen.findByRole(
      "switch",
      { name: "Investors can ask questions" },
      { timeout: 5000 },
    );
    await expectNoA11yViolations(r.container);
    await user.click(enabled);
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        qa: { enabled: true },
      }),
    );
    await user.click(
      screen.getByRole("radio", { name: "Everyone who can see the document or folder" }),
    );
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        qa: { defaultVisibility: "target" },
      }),
    );
    const sla = screen.getByLabelText(/^Answer within/u);
    await user.clear(sla);
    await user.type(sla, "0");
    await user.click(screen.getByRole("button", { name: "Save Q&A settings" }));
    expect(await screen.findByText("Enter a whole number from 1 to 720.")).toBeInTheDocument();
    const patches = mock.calls.filter((c) => c.method === "PATCH").length;
    await user.clear(sla);
    await user.type(sla, "48");
    await user.click(screen.getByRole("button", { name: "Save Q&A settings" }));
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH")).toHaveLength(patches + 1),
    );
    expect(mock.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
      qa: { slaHours: 48 },
    });
  }, 20_000);

  it("sends a stale session to step-up when saving", async () => {
    const user = userEvent.setup();
    handlers(ALL, {
      "PATCH /api/v1/data-room/settings": () =>
        apiError(401, "step_up_required", { reason: "fresh" }),
    });
    const r = await renderApp("/admin/data-room/settings");
    await user.click(
      await screen.findByRole(
        "switch",
        { name: "Answers need approval before release" },
        { timeout: 5000 },
      ),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
  }, 20_000);
});

// A-3 (ADR-0063): the data-room settings under a plan without Q&A or forensic watermarks.
describe("data room settings on a plan without Q&A or forensic watermarks", () => {
  it("will not switch either on, and leaves every other setting", async () => {
    handlers(ALL, {
      "GET /api/v1/data-room/settings": () => [200, settings({ enabled: false })],
    });
    withPlanEntitlements({ features: [] });
    const r = await renderApp("/admin/data-room/settings");
    const qa = await screen.findByRole(
      "switch",
      { name: "Investors can ask questions" },
      { timeout: 5000 },
    );
    expect(qa).toBeDisabled();
    expect(
      screen.getByText(
        "Your plan doesn't include Data-room Q&A. What you've already set up keeps working.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your plan doesn't include Forensic watermarks. What you've already set up keeps working.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Forensic watermark on new documents by default" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Watermark new documents by default" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("switch", { name: "Answers need approval before release" }),
    ).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets Q&A and the forensic default that are already on be switched off", async () => {
    const user = userEvent.setup();
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/settings": () => [
        200,
        { ...settings({ enabled: true }), forensicByDefault: true },
      ],
      "PATCH /api/v1/data-room/settings": () => [200, settings({ enabled: false })],
    });
    withPlanEntitlements({ features: [] });
    await renderApp("/admin/data-room/settings");
    const qa = await screen.findByRole(
      "switch",
      { name: "Investors can ask questions" },
      { timeout: 5000 },
    );
    expect(
      screen.getByRole("switch", { name: "Forensic watermark on new documents by default" }),
    ).toBeEnabled();
    expect(qa).toBeEnabled();
    await user.click(qa);
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({
        qa: { enabled: false },
      }),
    );
  }, 20_000);
});

describe("E3.3 fixes (staff)", () => {
  it("offers only active staff who can answer as assignees (C11)", async () => {
    const d = detailRoutes(detail({ assignee: null, status: "open" }));
    const mock = handlers(ALL, {
      ...d.routes,
      "GET /api/v1/access/people": () => [
        200,
        {
          items: [
            person(ME_ID, "Grace Hopper", "owner"),
            { ...person(EDITOR_ID, "Dora Dormant", "editor"), status: "dormant" },
          ],
          nextCursor: null,
        },
      ],
    });
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    const select = await screen.findByLabelText("Assignee", {}, { timeout: 5000 });
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Grace Hopper" })).toBeInTheDocument(),
    );
    expect(within(select).queryByRole("option", { name: "Dora Dormant" })).toBeNull();
    const people = mock.fetchMock.mock.calls
      .map((c) => new URL(new Request(c[0] as RequestInfo).url))
      .find((u) => u.pathname === "/api/v1/access/people");
    expect(people?.searchParams.get("status")).toBe("active");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("warns that editing a released answer under approval takes it offline (S2)", async () => {
    const user = userEvent.setup();
    const approved = answer({ approvedBy: { membershipId: ME_ID, displayName: "Grace Hopper" } });
    const d = detailRoutes(
      detail({
        status: "published",
        visibility: "target",
        publicText: "Is the pool pre-money?",
        releasedAt: NOW,
        publishedAt: NOW,
        answer: { ...approved, approvedAt: NOW, approvalCurrent: true },
      }),
    );
    d.routes["PUT /api/v1/data-room/qa/inbox/{id}/answer"] = ({ body }) =>
      d.set(detail({ answer: answer({ body: (body as { body: string }).body }) }));
    handlers(ALL, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
    });
    const r = await renderApp(`/admin/data-room/questions/${Q1}`);
    const editor = await screen.findByLabelText("Answer", {}, { timeout: 5000 });
    expect(editor).toHaveAccessibleDescription(/takes it offline until it is approved/u);
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.type(editor, " Updated.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/It is offline until it is approved/u)).toBeInTheDocument();
    // The server moved it back to the team: the status follows, and release waits for approval.
    expect(await screen.findByText("Assigned", { selector: "[data-slot=badge]" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release answer" })).toBeNull();
    expect(screen.getByText(/can be released once an approver has approved/u)).toBeInTheDocument();
  }, 20_000);

  it("holds release until the current answer is approved, and publishes an asker-less answer (C12)", async () => {
    const unapproved = detailRoutes(detail({ answer: answer() }));
    handlers(ALL, {
      ...unapproved.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
    });
    let r = await renderApp(`/admin/data-room/questions/${Q1}`);
    expect(
      await screen.findByText(
        /can be released once an approver has approved/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release answer" })).toBeNull();
    await expectNoA11yViolations(r.container);
    r.unmount();

    const approved = detailRoutes(
      detail({ answer: answer({ approvalCurrent: true, approvedAt: NOW }) }),
    );
    handlers(ALL, {
      ...approved.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ requireApproval: true })],
    });
    r = await renderApp(`/admin/data-room/questions/${Q1}`);
    expect(
      await screen.findByRole("button", { name: "Release answer" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    r.unmount();

    const orphan = detailRoutes(
      detail({ status: "answered", asker: null, visibility: "asker", answer: answer() }),
    );
    handlers(ALL, orphan.routes);
    r = await renderApp(`/admin/data-room/questions/${Q1}`);
    await screen.findByRole("heading", { name: "Cap table question" }, { timeout: 5000 });
    expect(await screen.findByRole("button", { name: "Publish to everyone" })).toBeInTheDocument();
  }, 20_000);

  it("preselects the workspace's default visibility in the release dialog", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail({ answer: answer() }));
    handlers(ALL, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ defaultVisibility: "target" })],
    });
    await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Release answer" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Everyone who can see/u })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /The investor who asked/u })).toBeEnabled();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("releases an asker-less entry to the target even when the default is the asker", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail({ source: "staff", asker: null, answer: answer() }));
    handlers(ALL, {
      ...d.routes,
      "GET /api/v1/data-room/settings": () => [200, settings({ defaultVisibility: "asker" })],
    });
    await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Release answer" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Everyone who can see/u })).toBeChecked();
    const asker = within(dialog).getByRole("radio", { name: /The investor who asked/u });
    expect(asker).toBeDisabled();
    expect(asker).not.toBeChecked();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("offers the decline email only when there is an asker (C2)", async () => {
    const user = userEvent.setup();
    const d = detailRoutes(detail());
    handlers(ALL, d.routes);
    let r = await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Close question" }, { timeout: 5000 }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("checkbox", { name: "Email the investor that it was declined" }),
    ).not.toBeChecked();
    await expectNoA11yViolations(dialog);
    r.unmount();

    const staff = detailRoutes(detail({ source: "staff", asker: null }));
    handlers(ALL, staff.routes);
    r = await renderApp(`/admin/data-room/questions/${Q1}`);
    await user.click(
      await screen.findByRole("button", { name: "Close question" }, { timeout: 5000 }),
    );
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  }, 20_000);

  it.each([
    ["withdrawn", /The investor withdrew this question/u],
    ["erased", /has been erased, so it stays closed/u],
  ] as const)(
    "does not offer to reopen a %s question (S4/C6)",
    async (reason, text) => {
      const d = detailRoutes(
        detail({ status: "closed", closedReason: reason, closedAt: NOW, asker: null }),
      );
      handlers(ALL, d.routes);
      const r = await renderApp(`/admin/data-room/questions/${Q1}`);
      expect(await screen.findByText(text, {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("words the new refusals and any unexplained conflict (C13)", async () => {
    const user = userEvent.setup();
    let reply: () => Response = () =>
      apiError(400, "validation_failed", { reason: "public_text_required" });
    const d = detailRoutes(detail({ status: "closed", closedReason: "declined", closedAt: NOW }));
    handlers(ALL, {
      ...d.routes,
      "POST /api/v1/data-room/qa/inbox/{id}/reopen": () => reply(),
    });
    await renderApp(`/admin/data-room/questions/${Q1}`);
    const reopen = await screen.findByRole("button", { name: "Reopen" }, { timeout: 5000 });
    await user.click(reopen);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Enter the published question/u);
    for (const [r, text] of [
      ["erased", /has been erased/u],
      ["withdrawn", /withdrew this question/u],
    ] as const) {
      reply = () => apiError(409, "conflict", { reason: r });
      await user.click(screen.getByRole("button", { name: "Reopen" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    }
    reply = () => apiError(409, "conflict");
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/changed while you were working on it/u),
    );
  }, 20_000);

  it("explains a stale inbox cursor (C13)", async () => {
    const user = userEvent.setup();
    handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": ({ url }) =>
        url.searchParams.get("cursor") === null
          ? [200, { items: [item()], nextCursor: "stale", counts: COUNTS }]
          : apiError(400, "validation_failed", { reason: "cursor" }),
    });
    const r = await renderApp("/admin/data-room/questions");
    await user.click(await screen.findByRole("button", { name: "Load more" }, { timeout: 5000 }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reload the page to start again/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("keeps an unsaved number when a switch saves (C16)", async () => {
    const user = userEvent.setup();
    let current = settings();
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/settings": () => [200, current],
      "PATCH /api/v1/data-room/settings": ({ body }) => {
        const qa = (body as { qa: Partial<FundRoomSchemas["QaSettings"]> }).qa;
        current = { ...current, qa: { ...current.qa, ...qa } };
        return [200, current];
      },
    });
    const r = await renderApp("/admin/data-room/settings");
    const sla = await screen.findByLabelText(/^Answer within/u, {}, { timeout: 5000 });
    await user.clear(sla);
    await user.type(sla, "48");
    await user.click(screen.getByRole("switch", { name: "Answers need approval before release" }));
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        qa: { requireApproval: true },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Answers need approval before release" }),
      ).toBeChecked(),
    );
    expect(screen.getByLabelText(/^Answer within/u)).toHaveValue(48);
    await user.click(screen.getByRole("button", { name: "Save Q&A settings" }));
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        qa: { slaHours: 48 },
      }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains an import that is too large (413)", async () => {
    const user = userEvent.setup();
    handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": () => [
        200,
        { items: [], nextCursor: null, counts: COUNTS },
      ],
      "POST /api/v1/data-room/qa/import": () => apiError(413, "payload_too_large"),
    });
    await renderApp("/admin/data-room/questions");
    await user.click(await screen.findByRole("button", { name: "Import CSV" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Check file" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The file is too large");
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("refuses a file over 1 MiB before sending it (C8)", async () => {
    const user = userEvent.setup();
    const mock = handlers(ALL, {
      "GET /api/v1/data-room/qa/inbox": () => [
        200,
        { items: [], nextCursor: null, counts: COUNTS },
      ],
    });
    await renderApp("/admin/data-room/questions");
    await user.click(await screen.findByRole("button", { name: "Import CSV" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    const big = new File(["x".repeat(1_048_577)], "big.csv", { type: "text/csv" });
    await user.upload(within(dialog).getByLabelText(/file/iu), big);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/larger than 1 MiB/u);
    expect(within(dialog).getByRole("button", { name: "Check file" })).toBeDisabled();
    expect(mock.calls.some((c) => c.path === "/api/v1/data-room/qa/import")).toBe(false);
    await expectNoA11yViolations(dialog);
  }, 20_000);

  // A-2: the new header, and the pre-rename one a server from before the rename sends.
  it.each(["x-fundroom-export-truncated", "x-seedhost-export-truncated"])(
    "warns when the export was cut at the server's cap (C19, %s)",
    async (truncatedHeader) => {
      // Sonner keeps toasts in a module-level store: the other case's warning must be gone first.
      toast.dismiss();
      await waitFor(() =>
        expect(screen.queryAllByText(/does not contain every question/u)).toHaveLength(0),
      );
      const user = userEvent.setup();
      const urls = withObjectUrls();
      try {
        handlers(ALL, {
          "GET /api/v1/data-room/qa/inbox": () => [
            200,
            { items: [], nextCursor: null, counts: COUNTS },
          ],
          "GET /api/v1/data-room/qa/export": () =>
            new Response("id,subject\n", {
              status: 200,
              headers: { "content-type": "text/csv", [truncatedHeader]: "true" },
            }),
        });
        await renderApp("/admin/data-room/questions");
        await user.click(
          await screen.findByRole("button", { name: "Export CSV" }, { timeout: 5000 }),
        );
        await waitFor(() => expect(urls.clicked).toHaveLength(1));
        expect(await screen.findByText(/does not contain every question/u)).toBeInTheDocument();
      } finally {
        urls.undo();
      }
    },
    20_000,
  );
});
