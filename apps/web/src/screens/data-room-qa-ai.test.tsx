import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiPolling } from "../lib/ai-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session, testConfig } from "../test/fixtures.js";
import {
  AI_REQUEST_ID,
  type AiRequest,
  type AiStatus,
  aiOn,
  aiRequest,
} from "../test/fixtures-ai.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * "Suggest an answer" on a Q&A question (E3.12): offered only to someone who may answer, while the
 * workspace has it effectively on; the suggestion is polled, shown with its outcome and numbered
 * sources (each a link to the quoted page), and "Use this text" only fills the answer editor —
 * nothing is saved until staff press Save (the normal PUT, which makes them the author).
 */
const ME_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const ASKER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const VERSION = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e05";
const Q1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01";
const NOW = "2026-09-30T10:00:00.000Z";

type Detail = FundRoomSchemas["QaInboxDetail"];

beforeEach(() => {
  aiPolling.intervalMs = 20;
});
afterEach(() => {
  aiPolling.intervalMs = 1500;
  vi.unstubAllGlobals();
});

const ANSWERER = ["data-room.read", "data-room.qa_answer", "ai.read"];

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: ME_ID, kind: "staff", role: "editor" }),
  });

function detail(over: Partial<Detail> = {}): Detail {
  return {
    id: Q1,
    source: "portal",
    status: "open",
    asker: { membershipId: ASKER_ID, displayName: "Ada Lovelace", email: "ada@example.com" },
    target: { kind: "document", id: DOC, title: "Pitch deck", path: "3", deleted: false },
    assignee: null,
    subject: "Option pool",
    body: "Is the option pool pre-money?",
    publicText: null,
    category: null,
    internalNote: null,
    visibility: null,
    dueAt: "2026-10-03T10:00:00.000Z",
    sla: "on_track",
    answer: null,
    createdAt: NOW,
    releasedAt: null,
    publishedAt: null,
    closedAt: null,
    closedReason: null,
    ...over,
  };
}

const BODY =
  "Yes. The option pool is included in the pre-money valuation [1].\n\nSources:\n[1] Term sheet, p. 3";

function suggestion(
  over: Partial<FundRoomSchemas["AiQaAnswerResult"]> = {},
): FundRoomSchemas["AiQaAnswerResult"] {
  return {
    kind: "qa_answer",
    outcome: "answered",
    body: BODY,
    citations: [
      {
        n: 1,
        documentId: DOC,
        versionId: VERSION,
        pageNo: 3,
        documentTitle: "Term sheet",
        quote: "the option pool shall be included in the pre-money valuation",
      },
    ],
    droppedCitations: 1,
    searchedDocuments: 4,
    ...over,
  };
}

function done(result = suggestion()): AiRequest {
  return aiRequest({
    feature: "qa_answer",
    subjectId: Q1,
    status: "done",
    finishedAt: NOW,
    result,
    usage: { inputTokens: 3000, outputTokens: 200 },
  });
}

/** Queued on the first poll, then `final`. */
function polled(final: AiRequest): Handler {
  let n = 0;
  return () => {
    n += 1;
    return [200, n === 1 ? aiRequest({ feature: "qa_answer", subjectId: Q1 }) : final];
  };
}

function handlers(
  over: Record<string, Handler> = {},
  opts: { permissions?: string[]; status?: AiStatus; detail?: Detail } = {},
) {
  let current = opts.detail ?? detail();
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
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
            slots: {
              "admin.nav": [
                { id: "dr", label: "Data room", to: "/admin/data-room", order: 30, icon: "folder" },
              ],
            },
          },
        ],
        permissions: opts.permissions ?? ANSWERER,
        membership: { id: ME_ID, kind: "staff", role: "editor" },
      }),
    ],
    "GET /api/v1/ai/status": () => [200, opts.status ?? aiOn()],
    "GET /api/v1/data-room/qa/inbox/{id}": () => [200, current],
    "PUT /api/v1/data-room/qa/inbox/{id}/answer": ({ body }) => {
      current = detail({
        answer: {
          body: (body as { body: string }).body,
          author: { membershipId: ME_ID, displayName: "Grace Hopper" },
          submittedAt: null,
          approvedBy: null,
          approvedAt: null,
          approvalCurrent: false,
          rejectedNote: null,
        },
      });
      return [200, current];
    },
    "POST /api/v1/data-room/qa/inbox/{id}/ai-suggestion": () => [202, { requestId: AI_REQUEST_ID }],
    "GET /api/v1/ai/requests/{id}": polled(done()),
    "DELETE /api/v1/ai/requests/{id}": () => new Response(null, { status: 204 }),
    ...over,
  });
}

const aiConfig = () => testConfig({ ai: true });

async function openQuestion(config = aiConfig()) {
  const r = await renderApp(`/admin/data-room/questions/${Q1}`, config);
  await screen.findByLabelText("Answer", {}, { timeout: 5000 });
  return r;
}

async function suggest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Suggest an answer" }, { timeout: 5000 }),
  );
  return screen.findByRole("region", { name: "AI suggestion" });
}

describe("Suggest an answer", () => {
  it("is not offered while the feature is off, nor to a viewer who cannot answer", async () => {
    const off = handlers(
      {},
      { status: aiOn({ effective: { updateDraft: true, qaAnswer: false } }) },
    );
    const r = await openQuestion();
    await waitFor(() => expect(off.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true));
    expect(screen.queryByRole("button", { name: "Suggest an answer" })).toBeNull();
    r.unmount();

    const viewer = handlers({}, { permissions: ["data-room.read", "ai.read"] });
    await renderApp(`/admin/data-room/questions/${Q1}`, aiConfig());
    await screen.findByRole("heading", { name: "Option pool" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Suggest an answer" })).toBeNull();
    expect(viewer.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(false);
  }, 20_000);

  it("polls the suggestion, shows it with its sources, and fills the editor without saving", async () => {
    const mock = handlers();
    const r = await openQuestion();
    const user = userEvent.setup();
    const panel = await suggest(user);
    expect(
      await within(panel).findByText(
        "AI suggestion — check every statement against its source before saving.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    const start = mock.calls.find((c) => c.path.endsWith("/ai-suggestion"));
    expect(start?.method).toBe("POST");
    expect(start?.path).toBe(`/api/v1/data-room/qa/inbox/${Q1}/ai-suggestion`);
    expect(
      mock.calls.filter((c) => c.path === `/api/v1/ai/requests/${AI_REQUEST_ID}`).length,
    ).toBeGreaterThanOrEqual(2);
    const source = within(panel).getByRole("link", {
      name: "Term sheet, page 3 (opens in a new tab)",
    });
    expect(source.getAttribute("href")).toBe(`/data-room/documents/${DOC}#page-3`);
    // A new tab: checking a source must not lose the unsaved answer or this panel.
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      within(panel).getByText("the option pool shall be included in the pre-money valuation"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /Searched 4 documents the asker can view\. Sources were checked against the folder's audience when the suggestion was made\. 1 citation was left out/u,
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(within(panel).getByRole("button", { name: "Use this text" }));
    expect(screen.getByLabelText("Answer")).toHaveValue(BODY);
    expect(screen.queryByRole("dialog")).toBeNull(); // the editor was empty: nothing to confirm
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({ body: BODY }),
    );
    // The save remounts the editor; the suggestion stays beside it.
    expect(
      await screen.findByRole("region", { name: "AI suggestion" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("asks before replacing different text in the editor", async () => {
    const mock = handlers();
    await openQuestion();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Answer"), "My own words");
    const panel = await suggest(user);
    await user.click(
      await within(panel).findByRole("button", { name: "Use this text" }, { timeout: 5000 }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Replace the answer text?")).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Answer")).toHaveValue("My own words");

    await user.click(within(panel).getByRole("button", { name: "Use this text" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Replace text" }));
    expect(screen.getByLabelText("Answer")).toHaveValue(BODY);
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  }, 20_000);

  it("warns when the documents do not answer it, or no citation could be verified", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        done(
          suggestion({
            outcome: "insufficient",
            body: "The documents do not say whether the pool is pre-money.",
            citations: [],
            droppedCitations: 0,
          }),
        ),
      ),
    });
    const r = await openQuestion();
    const user = userEvent.setup();
    const panel = await suggest(user);
    expect(
      await within(panel).findByText("Not enough in the documents", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: "Sources" })).toBeNull();
    r.unmount();

    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        done(suggestion({ outcome: "unsupported", citations: [], droppedCitations: 2 })),
      ),
    });
    await openQuestion();
    const panel2 = await suggest(userEvent.setup());
    expect(
      await within(panel2).findByText("No verified sources", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("says why there is no suggestion, per error code, and discards", async () => {
    const mock = handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({
          feature: "qa_answer",
          subjectId: Q1,
          status: "refused",
          errorCode: "no_sources",
          finishedAt: NOW,
        }),
      ),
    });
    await openQuestion();
    const user = userEvent.setup();
    const panel = await suggest(user);
    expect(
      await within(panel).findByText(
        /that everyone who can see the folder can also see/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Use this text" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
    await expectNoA11yViolations(panel);
    await user.click(within(panel).getByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("button", { name: "Suggest an answer" })).toBeInTheDocument();
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true);
  }, 20_000);

  it("says a request did not run because the workspace is unavailable, with no Try again", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({
          feature: "qa_answer",
          subjectId: Q1,
          status: "refused",
          errorCode: "workspace_unavailable",
          finishedAt: NOW,
        }),
      ),
    });
    await openQuestion();
    const panel = await suggest(userEvent.setup());
    expect(
      await within(panel).findByText(
        "The workspace is unavailable (suspended or being moved), so the request did not run.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
    await expectNoA11yViolations(panel);
  }, 20_000);

  it("says the documents changed when a bin discarded the suggestion, and offers Try again", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({
          feature: "qa_answer",
          subjectId: Q1,
          status: "cancelled",
          errorCode: "sources_changed",
          finishedAt: NOW,
        }),
      ),
    });
    await openQuestion();
    const panel = await suggest(userEvent.setup());
    expect(
      await within(panel).findByText(
        "The documents changed while this suggestion was being made — try again.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await expectNoA11yViolations(panel);
  }, 20_000);

  it("is not offered for a question without an investor asker, and explains a no_asker refusal", async () => {
    const mock = handlers({}, { detail: detail({ asker: null, source: "staff" }) });
    const r = await openQuestion();
    expect(screen.queryByRole("button", { name: "Suggest an answer" })).toBeNull();
    expect(mock.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(false);
    r.unmount();

    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({
          feature: "qa_answer",
          subjectId: Q1,
          status: "refused",
          errorCode: "no_asker",
          finishedAt: NOW,
        }),
      ),
    });
    await openQuestion();
    const panel = await suggest(userEvent.setup());
    expect(
      await within(panel).findByText(/This question has no investor asker/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Starting again would be refused again (and spend the hourly allowance): no "Try again".
    expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
  }, 20_000);

  it("names a start refusal (flattened error code)", async () => {
    handlers({
      "POST /api/v1/data-room/qa/inbox/{id}/ai-suggestion": () =>
        apiError(429, "ai_budget_exhausted"),
    });
    await openQuestion();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Suggest an answer" }, { timeout: 5000 }),
    );
    expect(await screen.findByText("Monthly AI budget used up")).toBeInTheDocument();
  }, 20_000);

  it("shows a lost request (404 on poll) as an error, not a spinner", async () => {
    handlers({ "GET /api/v1/ai/requests/{id}": () => apiError(404, "not_found") });
    await openQuestion();
    const panel = await suggest(userEvent.setup());
    expect(await within(panel).findByRole("alert", {}, { timeout: 5000 })).toHaveTextContent(
      "This suggestion is no longer available — it may have been discarded because a document changed.",
    );
    await expectNoA11yViolations(panel);
    expect(within(panel).queryByRole("status")).toBeNull();
  }, 20_000);
});

// A-3 (ADR-0063): on a plan without `ai` every start is refused (402), whatever the settings say.
describe("Suggest an answer on a plan without AI", () => {
  it("is not offered when the AI status or the bootstrap says the plan leaves it out", async () => {
    const byStatus = handlers({}, { status: aiOn({ planAllows: false }) });
    const r = await openQuestion();
    await waitFor(() =>
      expect(byStatus.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Suggest an answer" })).toBeNull();
    r.unmount();

    const byPlan = handlers();
    withPlanEntitlements({ features: [] });
    await openQuestion();
    await waitFor(() =>
      expect(byPlan.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Suggest an answer" })).toBeNull();
  }, 20_000);
});
