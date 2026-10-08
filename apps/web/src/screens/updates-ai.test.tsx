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
  aiStatus,
} from "../test/fixtures-ai.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * "Draft with AI" on the updates list (E3.12): offered only while the workspace has it
 * effectively on and the viewer manages updates; notes + template → start → poll until the request
 * is terminal → a read-only preview → "Create draft" saves through the normal paths (POST a blank
 * post, PUT the suggested doc as its draft) and opens the editor. Nothing is saved before that.
 */
const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05";
const NEW_POST = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f10";
const KPI_1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01";
const KPI_2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";
const LAST_POST = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b03";
const NOW = "2026-09-30T10:00:00.000Z";
const SAVED_AT = "2026-09-30T10:00:01.000Z";

beforeEach(() => {
  aiPolling.intervalMs = 20;
});
afterEach(() => {
  aiPolling.intervalMs = 1500;
  vi.unstubAllGlobals();
});

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const MANAGER = ["updates.read", "updates.manage", "updates.send", "ai.read"];

function draftResult(): FundRoomSchemas["AiUpdateDraftResult"] {
  return {
    kind: "update_draft",
    title: "October 2026 update",
    doc: {
      sections: [
        {
          key: "highlights",
          title: "Highlights",
          blocks: [
            {
              id: "ai-highlights-1",
              type: "rich_text",
              schemaVersion: 1,
              data: { format: "markdown", text: "We signed **two** pilots. [add detail]" },
            },
          ],
        },
        {
          key: "key-metrics",
          title: "Key metrics",
          blocks: [
            {
              id: "ai-metrics-1",
              type: "metric_grid",
              schemaVersion: 1,
              data: { definitionIds: [KPI_1, KPI_2], columns: 3 },
            },
          ],
        },
      ],
    },
    kpiDefinitionIds: [KPI_1, KPI_2],
    unverifiedNumbers: [],
    numbersFromLastUpdate: [],
    sources: {
      kpis: true,
      lastUpdate: { postId: LAST_POST, title: "September 2026 update", sentAt: NOW },
    },
  };
}

function post(over: Partial<FundRoomSchemas["UpdatePost"]> = {}): FundRoomSchemas["UpdatePost"] {
  return {
    id: NEW_POST,
    slug: "october-2026-update",
    title: "October 2026 update",
    state: "draft",
    audience: { kind: "all" },
    templateKey: "blank",
    scheduledFor: null,
    sentAt: null,
    publishedVersionNo: null,
    savedAt: SAVED_AT,
    authorMembershipId: OWNER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    lastSend: null,
    ...over,
  };
}

function detail(doc: FundRoomSchemas["PageDoc"] = { sections: [] }) {
  return { post: post(), doc, visibility: {}, groups: [], versions: [] };
}

/** A request that is queued for `pending` polls, then answers `final`. */
function polled(final: AiRequest, pending = 1): Handler {
  let n = 0;
  return () => {
    n += 1;
    return [200, n <= pending ? aiRequest({ status: n === 1 ? "queued" : "running" }) : final];
  };
}

function handlers(
  over: Record<string, Handler> = {},
  opts: { permissions?: string[]; status?: AiStatus } = {},
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        permissions: opts.permissions ?? MANAGER,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/ai/status": () => [200, opts.status ?? aiOn()],
    "GET /api/v1/updates/posts": () => [200, { posts: [] }],
    "GET /api/v1/updates/templates": () => [
      200,
      {
        templates: [
          { key: "yc", name: "YC monthly update", description: "Recap", doc: { sections: [] } },
          { key: "board", name: "Board update", description: "Board", doc: { sections: [] } },
        ],
      },
    ],
    "POST /api/v1/updates/ai/draft": () => [202, { requestId: AI_REQUEST_ID }],
    "GET /api/v1/ai/requests/{id}": polled(
      aiRequest({
        status: "done",
        finishedAt: NOW,
        result: draftResult(),
        usage: { inputTokens: 900, outputTokens: 400 },
      }),
    ),
    "DELETE /api/v1/ai/requests/{id}": () => new Response(null, { status: 204 }),
    "POST /api/v1/updates/posts": () => [201, detail()],
    "PUT /api/v1/updates/posts/{id}/draft": ({ body }) => [
      200,
      detail((body as { doc: FundRoomSchemas["PageDoc"] }).doc),
    ],
    "GET /api/v1/updates/posts/{id}": () => [200, detail(draftResult().doc as never)],
    "GET /api/v1/updates/posts/{id}/sends": () => [200, { sends: [] }],
    "GET /api/v1/updates/posts/{id}/replies": () => [200, { threads: [] }],
    ...over,
  });
}

const aiConfig = () => testConfig({ ai: true });

async function openList(config = aiConfig()) {
  const r = await renderApp("/admin/updates", config);
  await screen.findByRole("button", { name: "New update" }, { timeout: 5000 });
  return r;
}

async function startDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Draft with AI" }, { timeout: 5000 }));
  const dialog = await screen.findByRole("dialog");
  await user.selectOptions(
    await within(dialog).findByRole("combobox", { name: "Template" }),
    "board",
  );
  await user.type(within(dialog).getByLabelText("Notes for the draft"), "Signed two pilots.");
  await user.click(within(dialog).getByRole("button", { name: "Draft it" }));
  return dialog;
}

describe("Draft with AI", () => {
  it("is not offered unless the feature is effectively on, and asks nothing when the host has no model", async () => {
    const off = handlers({}, { status: aiStatus() });
    const r = await openList();
    await waitFor(() => expect(off.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true));
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
    r.unmount();

    const noModel = handlers();
    await openList(testConfig());
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
    expect(noModel.calls.some((c) => c.path.startsWith("/api/v1/ai/"))).toBe(false);
  }, 20_000);

  it("is not offered without updates.manage", async () => {
    const mock = handlers({}, { permissions: ["updates.read", "ai.read"] });
    await renderApp("/admin/updates", aiConfig());
    await screen.findByRole("heading", { name: "Updates", level: 1 }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
    expect(mock.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(false);
  }, 20_000);

  it("drafts, polls until done, previews and applies the suggestion as a new draft", async () => {
    const mock = handlers();
    const r = await openList();
    const user = userEvent.setup();
    await expectNoA11yViolations(r.container);
    const dialog = await startDraft(user);
    await waitFor(() =>
      expect(
        mock.calls.find((c) => c.method === "POST" && c.path === "/api/v1/updates/ai/draft")?.body,
      ).toEqual({ notes: "Signed two pilots.", template: "board" }),
    );
    // Polled until terminal, then the read-only preview.
    expect(
      await within(dialog).findByRole(
        "heading",
        { name: "October 2026 update" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      mock.calls.filter(
        (c) => c.method === "GET" && c.path === `/api/v1/ai/requests/${AI_REQUEST_ID}`,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
    expect(within(dialog).getByText("two").tagName).toBe("STRONG");
    expect(
      within(dialog).getByText("Key metrics grid (2 metrics) — shows live values in the editor."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Used your last sent update, “September 2026 update”/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Used your KPIs from Metrics.")).toBeInTheDocument();
    expect(within(dialog).queryByText("Figures not found in your material")).toBeNull();
    expect(within(dialog).queryByText("Figures from your previous update")).toBeNull();
    // Nothing is saved before "Create draft".
    expect(
      mock.calls.some((c) => c.method !== "GET" && c.path.startsWith("/api/v1/updates/posts")),
    ).toBe(false);
    await expectNoA11yViolations(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(pathOf(r.router)).toBe(`/admin/updates/${NEW_POST}`));
    const writes = mock.calls.filter(
      (c) => c.method !== "GET" && c.path.startsWith("/api/v1/updates/posts"),
    );
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/updates/posts",
      `PUT /api/v1/updates/posts/${NEW_POST}/draft`,
    ]);
    expect(writes[0]?.body).toEqual({ title: "October 2026 update", template: "blank" });
    expect(writes[1]?.body).toEqual({ doc: draftResult().doc, baseSavedAt: SAVED_AT });
    await waitFor(() =>
      expect(
        mock.calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/ai/requests/${AI_REQUEST_ID}`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("discards the request and saves nothing", async () => {
    const mock = handlers();
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    await within(dialog).findByRole("heading", { name: "October 2026 update" }, { timeout: 5000 });
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      mock.calls.some(
        (c) => c.method === "DELETE" && c.path === `/api/v1/ai/requests/${AI_REQUEST_ID}`,
      ),
    ).toBe(true);
    expect(
      mock.calls.some((c) => c.method !== "GET" && c.path.startsWith("/api/v1/updates/posts")),
    ).toBe(false);
  }, 20_000);

  it("names a start refusal", async () => {
    handlers({ "POST /api/v1/updates/ai/draft": () => apiError(429, "ai_busy") });
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    expect(await within(dialog).findByText("AI assist is busy")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Draft it" })).toBeInTheDocument();
  }, 20_000);

  it("says why a request produced nothing, and starts over on Try again", async () => {
    const mock = handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({ status: "failed", errorCode: "output_truncated", finishedAt: NOW }),
      ),
    });
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    expect(
      await within(dialog).findByText(
        "The model's reply was cut off before it finished. Try again with shorter notes.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Create draft" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("button", { name: "Draft it" })).toBeInTheDocument();
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true);
  }, 20_000);

  it("lists figures the draft uses that are not in the material", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({
          status: "done",
          finishedAt: NOW,
          result: {
            ...draftResult(),
            unverifiedNumbers: ["$4.2M", "37%"],
            numbersFromLastUpdate: ["1,200"],
          },
        }),
      ),
    });
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    const alert = (
      await within(dialog).findByText("Figures not found in your material", {}, { timeout: 5000 })
    ).closest("[data-slot=alert]") as HTMLElement;
    expect(
      within(alert).getByText("Check these figures — they don't appear in your KPIs or notes."),
    ).toBeInTheDocument();
    expect(
      within(alert)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["$4.2M", "37%"]);
    const stale = (await within(dialog).findByText("Figures from your previous update")).closest(
      "[data-slot=alert]",
    ) as HTMLElement;
    expect(
      within(stale).getByText(
        "These figures only appear in your previous update — are they still current?",
      ),
    ).toBeInTheDocument();
    expect(within(stale).getByRole("listitem")).toHaveTextContent("1,200");
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("retries the draft once, then deletes the empty post and says so", async () => {
    let puts = 0;
    const mock = handlers({
      "PUT /api/v1/updates/posts/{id}/draft": () => {
        puts += 1;
        return apiError(500, "internal_error");
      },
      "DELETE /api/v1/updates/posts/{id}": () => new Response(null, { status: 204 }),
    });
    const r = await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Create draft" }, { timeout: 5000 }),
    );
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(puts).toBe(2);
    expect(
      mock.calls.some(
        (c) => c.method === "DELETE" && c.path === `/api/v1/updates/posts/${NEW_POST}`,
      ),
    ).toBe(true);
    expect(pathOf(r.router)).toBe("/admin/updates");
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("keeps the post when the retried draft save succeeds", async () => {
    let puts = 0;
    const mock = handlers({
      "PUT /api/v1/updates/posts/{id}/draft": ({ body }) => {
        puts += 1;
        return puts === 1
          ? apiError(503, "service_unavailable")
          : [200, detail((body as { doc: FundRoomSchemas["PageDoc"] }).doc)];
      },
    });
    const r = await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Create draft" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe(`/admin/updates/${NEW_POST}`));
    expect(puts).toBe(2);
    expect(
      mock.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/api/v1/updates/posts/")),
    ).toBe(false);
  }, 20_000);

  it("keeps polling through a transient failure", async () => {
    let n = 0;
    handlers({
      "GET /api/v1/ai/requests/{id}": () => {
        n += 1;
        if (n === 1) return [200, aiRequest({ status: "running" })];
        if (n === 2) return apiError(503, "service_unavailable");
        return [200, aiRequest({ status: "done", finishedAt: NOW, result: draftResult() })];
      },
    });
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    expect(
      await within(dialog).findByRole(
        "heading",
        { name: "October 2026 update" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(n).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it("gives up after the polling window, and checks again on request", async () => {
    aiPolling.giveUpMs = 300;
    let finished = false;
    handlers({
      "GET /api/v1/ai/requests/{id}": () => [
        200,
        finished
          ? aiRequest({ status: "done", finishedAt: NOW, result: draftResult() })
          : aiRequest({ status: "queued" }),
      ],
    });
    try {
      await openList();
      const user = userEvent.setup();
      const dialog = await startDraft(user);
      expect(
        await within(dialog).findByText("Still no suggestion", {}, { timeout: 5000 }),
      ).toBeInTheDocument();
      await expectNoA11yViolations(dialog);
      finished = true;
      aiPolling.giveUpMs = 60_000;
      await user.click(within(dialog).getByRole("button", { name: "Check again" }));
      expect(
        await within(dialog).findByRole(
          "heading",
          { name: "October 2026 update" },
          { timeout: 5000 },
        ),
      ).toBeInTheDocument();
    } finally {
      aiPolling.giveUpMs = 15 * 60_000;
    }
  }, 20_000);

  it("reads a refused request's code", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({ status: "refused", errorCode: "input_too_large", finishedAt: NOW }),
        0,
      ),
    });
    await openList();
    const user = userEvent.setup();
    const dialog = await startDraft(user);
    expect(
      await within(dialog).findByText(
        /There is too much material for the configured model/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);
});

// A-3 (ADR-0063): on a plan without `ai` every start is refused (402), whatever the settings say.
describe("Draft with AI on a plan without AI", () => {
  it("is not offered when the AI status says the plan leaves it out", async () => {
    const mock = handlers({}, { status: aiOn({ planAllows: false }) });
    await openList();
    await waitFor(() => expect(mock.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true));
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
  }, 20_000);

  it("is not offered when the bootstrap's plan leaves it out", async () => {
    const mock = handlers();
    withPlanEntitlements({ features: [] });
    await openList();
    await waitFor(() => expect(mock.calls.some((c) => c.path === "/api/v1/ai/status")).toBe(true));
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
  }, 20_000);

  it("names a queued request the plan refused, with no Try again", async () => {
    handlers({
      "GET /api/v1/ai/requests/{id}": polled(
        aiRequest({ status: "refused", errorCode: "plan_limit", finishedAt: NOW }),
      ),
    });
    await openList();
    const dialog = await startDraft(userEvent.setup());
    expect(
      await within(dialog).findByText(
        "Your plan doesn't include AI drafting assist.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
  }, 20_000);
});
