import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi, viewAsState } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * Investor-side data-room Q&A (E3.3): the ask dialog on documents and folders, the per-target
 * "Questions and answers" panel, "My questions" and the question page. Everything hides behind
 * GET /qa/status; a question that is not the caller's shows its published wording only.
 */
afterEach(() => vi.unstubAllGlobals());

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00";
const LEGAL = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const VERSION = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const Q_MINE = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const Q_PUBLISHED = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";
const Q_ANSWERED = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f03";
const Q_CLOSED = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f04";
const NOW = "2026-09-12T10:00:00.000Z";

type QaStatus = FundRoomSchemas["QaStatus"];
type QaQuestionView = FundRoomSchemas["QaQuestionView"];

const allowed: FundRoomSchemas["AccessDecision"] = {
  allowed: true,
  capabilities: ["view"],
  pendingGates: [],
  reason: "granted",
};

function treeDoc(id: string, folderId: string, title: string, index: string) {
  return {
    id,
    folderId,
    title,
    index,
    sortOrder: 0,
    protection: { download: false, watermark: true, print: false, forensic: false },
    legalHold: false,
    currentVersionId: VERSION,
    contentType: "application/pdf",
    sizeBytes: 1234,
    pageCount: 3,
    renderStatus: "ready",
    scanStatus: "clean",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    access: allowed,
  } satisfies FundRoomSchemas["DataRoomTreeDocument"];
}

function tree(): FundRoomSchemas["DataRoomTree"] {
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
        access: allowed,
        passthrough: false,
      },
    ],
    documents: [treeDoc(DOC, ROOT, "Pitch deck", "2")],
  };
}

function detail(): FundRoomSchemas["DataRoomDocumentDetail"] {
  const { access: _a, ...d } = treeDoc(DOC, ROOT, "Pitch deck", "2");
  return {
    document: d,
    folder: { id: ROOT, name: "Data room", path: "r" },
    currentVersion: {
      id: VERSION,
      versionNo: 1,
      fileName: "deck.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      pageCount: 3,
      renderStatus: "ready",
      renderDetail: null,
      changeNote: null,
      uploadedBy: null,
      createdAt: NOW,
      isCurrent: true,
    },
    scan: { status: "clean", engine: "noop", detail: null, scannedAt: NOW },
    versions: [],
    access: allowed,
    availability: { viewable: true, download: null, reason: "ready" },
    legalHold: null,
  };
}

/** My own question, still with the team. */
function mine(over: Partial<QaQuestionView> = {}): QaQuestionView {
  return {
    id: Q_MINE,
    targetKind: "document",
    targetId: DOC,
    targetTitle: "Pitch deck",
    mine: true,
    status: "open",
    subject: "Runway assumptions",
    body: "How many months of runway does the plan assume?",
    publicText: null,
    answer: null,
    createdAt: NOW,
    publishedAt: null,
    releasedAt: null,
    visibility: null,
    ...over,
  };
}

/** Someone else's question, published: the server sends the public wording only. */
function published(over: Partial<QaQuestionView> = {}): QaQuestionView {
  return {
    id: Q_PUBLISHED,
    targetKind: "document",
    targetId: DOC,
    targetTitle: "Pitch deck",
    mine: false,
    status: "published",
    subject: null,
    body: null,
    publicText: "Customer concentration\n\nWhat share of revenue comes from the top customer?",
    answer: { body: "About 18% of ARR.", releasedAt: "2026-09-13T09:00:00.000Z" },
    // S7: a non-asker never learns when the question was asked, only when it was published.
    createdAt: null,
    publishedAt: "2026-09-13T09:00:00.000Z",
    releasedAt: "2026-09-13T09:00:00.000Z",
    visibility: "target",
    ...over,
  };
}

const enabled: QaStatus = { enabled: true, canAsk: true, allowFolderQuestions: true };

const drBootstrap = (over: Partial<FundRoomSchemas["ModulesBootstrap"]> = {}) =>
  bootstrap({
    ...over,
    modules: [
      {
        id: "data-room",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [{ id: "data-room", label: "Data room", to: "/data-room", order: 20 }],
        },
      },
    ],
  });

function handlers(status: QaStatus | null, over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, drBootstrap()],
    "GET /api/v1/data-room/tree": () => [200, tree()],
    "GET /api/v1/data-room/documents/{id}": () => [200, detail()],
    "POST /api/v1/data-room/documents/{id}/viewed": () => [200, { recorded: true }],
    "GET /api/v1/data-room/documents/{id}/pages/{n}/text": ({ params }) => [
      200,
      { pageNo: Number(params["n"]), pageCount: 3, text: "" },
    ],
    // `null`: an older server without the route — the portal must simply show no Q&A.
    ...(status === null
      ? {}
      : { "GET /api/v1/data-room/qa/status": () => [200, status] as [number, unknown] }),
    "GET /api/v1/data-room/qa/questions": () => [200, { items: [], nextCursor: null }],
    ...over,
  });
}

const qaRequests = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.startsWith("/api/v1/data-room/qa/questions"));

describe("Q&A off", () => {
  it.each([
    ["disabled", { enabled: false, canAsk: false, allowFolderQuestions: true }],
    ["unavailable (404)", null],
  ] as const)("shows no Q&A anywhere when %s", async (_label, status) => {
    const { calls } = handlers(status);
    const r = await renderApp(`/data-room/folders/${LEGAL}`);
    await screen.findByRole("heading", { name: "Data room", level: 1 });
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/qa/status"))).toBe(true));
    expect(screen.queryByRole("link", { name: /My questions/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ask about this folder/u })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Questions and answers" })).toBeNull();
    await expectNoA11yViolations(r.container);
    r.unmount();

    await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    expect(screen.queryByRole("button", { name: "Ask a question" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Questions and answers" })).toBeNull();
    expect(qaRequests(calls)).toEqual([]);
  });
});

describe("asking about a document", () => {
  it("validates, sends the question, confirms and returns focus to the button", async () => {
    let asked = false;
    const { calls } = handlers(enabled, {
      "GET /api/v1/data-room/qa/questions": ({ url }) => {
        expect(url.searchParams.get("scope")).toBe("target");
        expect(url.searchParams.get("targetKind")).toBe("document");
        expect(url.searchParams.get("targetId")).toBe(DOC);
        return [200, { items: asked ? [mine(), published()] : [published()], nextCursor: null }];
      },
      "POST /api/v1/data-room/qa/questions": () => {
        asked = true;
        return [201, mine()];
      },
    });
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const panel = await screen.findByRole("region", { name: "Questions and answers" });
    expect(await within(panel).findByText("Customer concentration")).toBeInTheDocument();

    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Ask a question" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Ask a question" });
    expect(dialog).toHaveAccessibleDescription(/Pitch deck/u);
    await expectNoA11yViolations(dialog);

    // Empty → both fields explain themselves and nothing is sent.
    await user.click(within(dialog).getByRole("button", { name: "Send question" }));
    const subject = within(dialog).getByRole("textbox", { name: /Subject/u });
    const body = within(dialog).getByRole("textbox", { name: /Question/u });
    expect(subject).toHaveAttribute("aria-invalid", "true");
    expect(subject).toHaveAccessibleDescription(/Enter a subject\./u);
    expect(body).toHaveAccessibleDescription(/Enter your question\./u);
    expect(document.activeElement).toBe(subject);

    // Too long → the limit is named; the counter follows the text.
    await user.click(subject);
    await user.paste("x".repeat(201));
    expect(subject).toHaveAccessibleDescription(/200 characters or fewer/u);
    expect(subject).toHaveAccessibleDescription(/201 of 200 characters/u);
    await user.clear(subject);
    await user.type(subject, "Runway assumptions");
    await user.type(body, "How many months of runway does the plan assume?");
    expect(subject).not.toHaveAttribute("aria-invalid");
    expect(body).toHaveAccessibleDescription("47 of 5000 characters");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/qa/questions"))).toBe(false);
    await expectNoA11yViolations(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Send question" }));
    expect(await screen.findByText(/Question sent/u)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/qa/questions"));
    expect(post?.body).toEqual({
      targetKind: "document",
      targetId: DOC,
      subject: "Runway assumptions",
      body: "How many months of runway does the plan assume?",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    // The panel reloads and now lists my question with its status.
    expect(await within(panel).findByRole("link", { name: "Runway assumptions" })).toHaveAttribute(
      "href",
      `/data-room/questions/${Q_MINE}`,
    );
    expect(within(panel).getByText("Awaiting answer")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });

  it.each([
    [
      "too many open questions",
      () => apiError(409, "conflict", { reason: "too_many_open" }),
      "Too many open questions",
    ],
    ["the daily limit", () => apiError(429, "rate_limited"), "Too many questions today"],
    [
      "a delegate refusal",
      () => apiError(403, "forbidden", { reason: "delegate_read_only" }),
      "Delegates can't ask questions",
    ],
    [
      "a pending gate",
      () =>
        apiError(403, "forbidden", {
          pendingGates: [{ kind: "nda", detail: {}, source: "workspace" }],
        }),
      "Access requirement pending",
    ],
  ])("explains %s and keeps the draft", async (_label, reply, title) => {
    handlers(enabled, { "POST /api/v1/data-room/qa/questions": reply });
    await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ask a question" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask a question" });
    await user.type(within(dialog).getByRole("textbox", { name: /Subject/u }), "Cap table");
    await user.type(within(dialog).getByRole("textbox", { name: /Question/u }), "Fully diluted?");
    await user.click(within(dialog).getByRole("button", { name: "Send question" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(title);
    expect(within(dialog).getByRole("textbox", { name: /Subject/u })).toHaveValue("Cap table");
    await expectNoA11yViolations(dialog);
  });

  it("shows a delegate the published answers but no ask button, and no asker", async () => {
    handlers(
      { enabled: true, canAsk: false, allowFolderQuestions: true },
      {
        "GET /api/v1/data-room/qa/questions": () => [
          200,
          { items: [published()], nextCursor: null },
        ],
      },
    );
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const panel = await screen.findByRole("region", { name: "Questions and answers" });
    const item = await within(panel).findByRole("article", { name: "Customer concentration" });
    expect(within(item).getByText(/What share of revenue/u)).toBeInTheDocument();
    expect(within(item).getByText("About 18% of ARR.")).toBeInTheDocument();
    expect(within(item).queryByText("Your question")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask a question" })).toBeNull();
    await expectNoA11yViolations(r.container);
  });
});

describe("folders", () => {
  it("hides folder questions when the workspace turned them off", async () => {
    const { calls } = handlers({ enabled: true, canAsk: true, allowFolderQuestions: false });
    const r = await renderApp(`/data-room/folders/${LEGAL}`);
    await screen.findByRole("heading", { name: "Data room", level: 1 });
    expect(await screen.findByRole("link", { name: "My questions" })).toHaveAttribute(
      "href",
      "/data-room/questions",
    );
    expect(screen.queryByRole("button", { name: "Ask about this folder" })).toBeNull();
    const panel = await screen.findByRole("region", { name: "Questions and answers" });
    expect(
      await within(panel).findByText("No published questions about this folder yet."),
    ).toBeInTheDocument();
    const get = qaRequests(calls)[0];
    expect(get?.path).toBe("/api/v1/data-room/qa/questions");
    await expectNoA11yViolations(r.container);
  });

  it("asks about the open folder", async () => {
    const { calls } = handlers(enabled, {
      "POST /api/v1/data-room/qa/questions": () => [
        201,
        mine({ targetKind: "folder", targetId: LEGAL, targetTitle: "Legal" }),
      ],
    });
    await renderApp(`/data-room/folders/${LEGAL}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ask about this folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask a question" });
    expect(dialog).toHaveAccessibleDescription(/folder “Legal”/u);
    await user.type(within(dialog).getByRole("textbox", { name: /Subject/u }), "Board minutes");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Question/u }),
      "Are 2025 ones here?",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send question" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      targetKind: "folder",
      targetId: LEGAL,
      subject: "Board minutes",
      body: "Are 2025 ones here?",
    });
  });
});

describe("my questions", () => {
  it("lists my questions with investor-facing statuses", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions": ({ url }) => {
        expect(url.searchParams.get("scope")).toBe("mine");
        return [
          200,
          {
            items: [
              mine(),
              mine({ id: Q_ANSWERED, subject: "Hiring plan", status: "assigned" }),
              mine({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05",
                subject: "Churn",
                status: "awaiting_approval",
              }),
              mine({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f06",
                subject: "Pricing",
                status: "answered",
                visibility: "asker",
                answer: { body: "Annual.", releasedAt: NOW },
              }),
              mine({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07",
                subject: "Burn",
                status: "published",
              }),
              mine({ id: Q_CLOSED, subject: "Old", status: "closed", targetTitle: "" }),
            ],
            nextCursor: null,
          },
        ];
      },
    });
    const r = await renderApp("/data-room/questions");
    expect(await screen.findByRole("heading", { name: "My questions", level: 1 })).toBeVisible();
    const rows = screen.getAllByRole("listitem");
    const statusOf = (name: string) =>
      rows.find((li) => within(li).queryByRole("link", { name }) !== null);
    expect(
      within(statusOf("Runway assumptions") as HTMLElement).getByText("Awaiting answer"),
    ).toBeInTheDocument();
    expect(
      within(statusOf("Hiring plan") as HTMLElement).getByText("Awaiting answer"),
    ).toBeInTheDocument();
    expect(
      within(statusOf("Churn") as HTMLElement).getByText("Awaiting answer"),
    ).toBeInTheDocument();
    expect(within(statusOf("Pricing") as HTMLElement).getByText("Answered")).toBeInTheDocument();
    expect(within(statusOf("Burn") as HTMLElement).getByText("Published")).toBeInTheDocument();
    expect(within(statusOf("Old") as HTMLElement).getByText("Closed")).toBeInTheDocument();
    expect(
      within(statusOf("Runway assumptions") as HTMLElement).getByText(/About Pitch deck/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runway assumptions" })).toHaveAttribute(
      "href",
      `/data-room/questions/${Q_MINE}`,
    );
    await expectNoA11yViolations(r.container);
  });

  it("says so when there are none, and answers 404 as not found", async () => {
    handlers(enabled);
    const r = await renderApp("/data-room/questions");
    expect(await screen.findByText("You have not asked any questions")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    r.unmount();

    handlers(
      { enabled: false, canAsk: false, allowFolderQuestions: false },
      {
        "GET /api/v1/data-room/qa/questions": () => apiError(404, "not_found"),
      },
    );
    await renderApp("/data-room/questions");
    expect(await screen.findByRole("heading", { name: /not found/iu })).toBeInTheDocument();
  });
});

describe("question page", () => {
  it("shows my pending question and withdraws it after confirming", async () => {
    let current = mine();
    const { calls } = handlers(enabled, {
      "GET /api/v1/data-room/qa/questions/{id}": () => [200, current],
      "POST /api/v1/data-room/qa/questions/{id}/withdraw": () => {
        current = mine({ status: "closed" });
        return [200, current];
      },
    });
    const r = await renderApp(`/data-room/questions/${Q_MINE}`);
    const heading = await screen.findByRole("heading", { name: "Runway assumptions", level: 1 });
    expect(screen.getByText("How many months of runway does the plan assume?")).toBeInTheDocument();
    expect(screen.getByText("Awaiting answer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pitch deck" })).toHaveAttribute(
      "href",
      `/data-room/documents/${DOC}`,
    );
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    // Cancelling sends nothing.
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    let dialog = await screen.findByRole("dialog", { name: "Withdraw this question?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.path.endsWith("/withdraw"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    dialog = await screen.findByRole("dialog", { name: "Withdraw this question?" });
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Withdraw question" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.path.endsWith(`/qa/questions/${Q_MINE}/withdraw`))).toHaveLength(
      1,
    );
    expect(await screen.findByText("Closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    // Focus lands on the page heading, not on the vanished button.
    await waitFor(() => expect(heading.contains(document.activeElement)).toBe(true));
    await expectNoA11yViolations(r.container);
  });

  it("renders a published question for someone who did not ask it", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions/{id}": () => [200, published()],
    });
    const r = await renderApp(`/data-room/questions/${Q_PUBLISHED}`);
    expect(
      await screen.findByRole("heading", { name: "Customer concentration", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What share of revenue comes from the top customer?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Answer" })).toBeInTheDocument();
    expect(screen.getByText("About 18% of ARR.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pitch deck" })).toHaveAttribute(
      "href",
      `/data-room/documents/${DOC}`,
    );
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.queryByText("Your question")).toBeNull();
    // No status badge for someone else's question (the "Published" date label is a <dt>).
    expect(screen.queryByText("Published", { selector: ":not(dt)" })).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("shows my released answer and a target I can no longer open without a link", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions/{id}": () => [
        200,
        mine({
          id: Q_ANSWERED,
          targetKind: "folder",
          targetId: LEGAL,
          targetTitle: "",
          status: "answered",
          visibility: "asker",
          answer: { body: "Yes, 24 months.", releasedAt: NOW },
          releasedAt: NOW,
        }),
      ],
    });
    const r = await renderApp(`/data-room/questions/${Q_ANSWERED}`);
    expect(await screen.findByText("Yes, 24 months.")).toBeInTheDocument();
    expect(screen.getByText("Only you can see this answer.")).toBeInTheDocument();
    expect(screen.getByText("No longer available to you")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Legal/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("answers an unknown question with the not-found screen", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions/{id}": () => apiError(404, "not_found"),
    });
    await renderApp(`/data-room/questions/${Q_CLOSED}`);
    expect(await screen.findByRole("heading", { name: /not found/iu })).toBeInTheDocument();
  });
});

describe("E3.3 fixes", () => {
  it("dates someone else's question by publication and mine by asking (S7)", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions": () => [
        200,
        { items: [mine(), published()], nextCursor: null },
      ],
      "GET /api/v1/data-room/qa/questions/{id}": () => [200, published()],
    });
    const r = await renderApp(`/data-room/documents/${DOC}`);
    const panel = await screen.findByRole("region", { name: "Questions and answers" });
    const theirs = await within(panel).findByRole("article", { name: "Customer concentration" });
    expect(within(theirs).getByText(/^Published /u)).toBeInTheDocument();
    expect(within(theirs).queryByText(/^Asked /u)).toBeNull();
    const ours = within(panel).getByRole("article", { name: /Runway assumptions/u });
    expect(within(ours).getByText(/^Asked /u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    r.unmount();

    const d = await renderApp(`/data-room/questions/${Q_PUBLISHED}`);
    await screen.findByRole("heading", { name: "Customer concentration", level: 1 });
    expect(screen.getByText("Published", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByText("Asked", { selector: "dt" })).toBeNull();
    await expectNoA11yViolations(d.container);
  });

  it("shows a delegate no 'My questions' and no folder ask (C15)", async () => {
    handlers({ enabled: true, canAsk: false, allowFolderQuestions: true });
    const r = await renderApp(`/data-room/folders/${LEGAL}`);
    await screen.findByRole("region", { name: "Questions and answers" });
    expect(screen.queryByRole("link", { name: "My questions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about this folder" })).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("offers no folder ask while staff view the portal as the investor (C14)", async () => {
    handlers(enabled, {
      "GET /api/v1/me": () => [200, me({ viewAs: viewAsState() })],
      "GET /api/v1/modules": () => [200, drBootstrap({ viewAs: viewAsState() })],
    });
    const r = await renderApp(`/data-room/folders/${LEGAL}`);
    await screen.findByRole("region", { name: "Questions and answers" });
    expect(await screen.findByRole("link", { name: "My questions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask about this folder" })).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("explains a pending access requirement on a question page and shows nothing of it (S1)", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions/{id}": () =>
        apiError(403, "forbidden", {
          pendingGates: [{ kind: "nda", detail: {}, source: "workspace" }],
        }),
    });
    const r = await renderApp(`/data-room/questions/${Q_PUBLISHED}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Access requirement pending");
    expect(screen.queryByText("About 18% of ARR.")).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("explains a stale cursor when loading more of my questions (C13)", async () => {
    handlers(enabled, {
      "GET /api/v1/data-room/qa/questions": ({ url }) =>
        url.searchParams.get("cursor") === null
          ? [200, { items: [mine()], nextCursor: "stale" }]
          : apiError(400, "validation_failed", { reason: "cursor" }),
    });
    const r = await renderApp("/data-room/questions");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The list changed");
    await expectNoA11yViolations(r.container);
  });
});
