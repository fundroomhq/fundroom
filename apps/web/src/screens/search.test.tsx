import type { FundRoomSchemas } from "@fundroom/sdk";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Workspace search (E2.8): the header search landmark and its shortcuts, the results page
 * (query in the URL, live count, highlighted snippets as text, gated hits, load more, empty
 * and error states), and the admin variant.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const DOC_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01";
const POST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02";
const NDA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a03";
const STAFF_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";

function hit(over: Partial<FundRoomSchemas["SearchHit"]> = {}): FundRoomSchemas["SearchHit"] {
  return {
    module: "data-room",
    kind: "document",
    refId: DOC_ID,
    title: "Pitch deck",
    snippet: [
      { text: "Our ", highlight: false },
      { text: "pitch", highlight: true },
      { text: " for the seed round", highlight: false },
    ],
    href: `/data-room/documents/${DOC_ID}`,
    updatedAt: "2026-09-12T10:00:00.000Z",
    gated: false,
    ...over,
  };
}

function results(
  hits: FundRoomSchemas["SearchHit"][],
  hasMore = false,
  query = "pitch",
): FundRoomSchemas["SearchResults"] {
  return { query, hits, hasMore };
}

function investor(search: Handler) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, bootstrap()],
    "GET /api/v1/search": search,
  });
}

async function openSearch(path: string) {
  const r = await renderApp(path);
  await screen.findByRole("heading", { name: "Search", level: 1 }, { timeout: 5000 });
  return r;
}

function searchUrls(fetchMock: ReturnType<typeof installMockApi>["fetchMock"]): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
    .filter((u) => u.pathname === "/api/v1/search");
}

describe("header search", () => {
  it("is a labelled search landmark that / and Ctrl/Cmd+K focus", async () => {
    investor(() => [200, results([])]);
    const r = await openSearch("/search");
    const landmark = screen.getByRole("search", { name: "Workspace" });
    const field = within(landmark).getByRole("searchbox", { name: "Search this workspace" });
    expect(field).toHaveAttribute("aria-keyshortcuts", "/ Control+K Meta+K");
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    expect(field).not.toHaveFocus();
    await user.keyboard("/");
    expect(field).toHaveFocus();
    // The slash went to focusing, not into the field.
    expect(field).toHaveValue("");

    field.blur();
    await user.keyboard("{Control>}k{/Control}");
    expect(field).toHaveFocus();

    field.blur();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(field).toHaveFocus();
  }, 20_000);

  it("leaves / and Ctrl+K alone while the user is typing into another field", async () => {
    investor(() => [200, results([])]);
    await openSearch("/search");
    const header = within(screen.getByRole("search", { name: "Workspace" })).getByRole("searchbox");
    const page = screen.getByRole("searchbox", { name: "Search for" });
    const user = userEvent.setup();
    await user.click(page);
    await user.keyboard("a/b");
    expect(page).toHaveFocus();
    expect(page).toHaveValue("a/b");
    const event = fireEvent.keyDown(page, { key: "k", ctrlKey: true });
    expect(event).toBe(true); // not prevented
    expect(page).toHaveFocus();
    expect(header).not.toHaveFocus();
  }, 20_000);

  it("opens the results page with the query in the URL", async () => {
    const { fetchMock } = investor(() => [200, results([hit()])]);
    const r = await openSearch("/search");
    const user = userEvent.setup();
    const field = within(screen.getByRole("search", { name: "Workspace" })).getByRole("searchbox");
    await user.type(field, "pitch deck{Enter}");
    await waitFor(() => expect(pathOf(r.router)).toBe("/search?q=pitch+deck"));
    expect(await screen.findByRole("link", { name: "Pitch deck" })).toBeInTheDocument();
    expect(searchUrls(fetchMock).at(-1)?.searchParams.get("q")).toBe("pitch deck");
  }, 20_000);
});

describe("results page", () => {
  it("lists hits with a badge, a highlighted snippet and a live count", async () => {
    investor(() => [
      200,
      results([
        hit(),
        hit({
          module: "updates",
          kind: "post",
          refId: POST_ID,
          title: "Q3 update",
          href: `/updates/${POST_ID}`,
          snippet: [],
        }),
      ]),
    ]);
    const r = await openSearch("/search?q=pitch");
    const link = await screen.findByRole("link", { name: "Pitch deck" });
    expect(link).toHaveAttribute("href", `/data-room/documents/${DOC_ID}`);
    expect(screen.getByRole("link", { name: "Q3 update" })).toHaveAttribute(
      "href",
      `/updates/${POST_ID}`,
    );
    const list = screen.getByRole("list", { name: "Results for “pitch”" });
    expect(within(list).getByText("Document")).toBeInTheDocument();
    expect(within(list).getByText("Update")).toBeInTheDocument();
    const mark = list.querySelector("mark");
    expect(mark?.textContent).toBe("pitch");
    expect(screen.getByRole("status")).toHaveTextContent("Results for “pitch”: 2.");
    expect(screen.getByRole("searchbox", { name: "Search for" })).toHaveValue("pitch");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("labels a Q&A hit as Q&A (its title is the document's name)", async () => {
    const QA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a09";
    investor(() => [
      200,
      results([hit({ kind: "qa", refId: QA_ID, href: `/data-room/questions/${QA_ID}` })]),
    ]);
    const r = await openSearch("/search?q=pitch");
    const link = await screen.findByRole("link", { name: "Pitch deck" });
    expect(link).toHaveAttribute("href", `/data-room/questions/${QA_ID}`);
    const list = screen.getByRole("list", { name: "Results for “pitch”" });
    expect(within(list).getByText("Q&A")).toBeInTheDocument();
    expect(within(list).queryByText("qa")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("renders snippet text as text, never as markup", async () => {
    investor(() => [
      200,
      results([
        hit({
          title: '<img src=x onerror="window.__pwned=1">Deck',
          snippet: [
            { text: "before <img src=x onerror=alert(1)> ", highlight: false },
            { text: "<script>window.__pwned=1</script>pitch", highlight: true },
          ],
        }),
      ]),
    ]);
    const r = await openSearch("/search?q=pitch");
    await screen.findByRole("link", { name: '<img src=x onerror="window.__pwned=1">Deck' });
    expect(r.container.querySelector("img[src=x]")).toBeNull();
    expect(r.container.querySelector("script")).toBeNull();
    expect(screen.getByText(/before <img src=x onerror=alert\(1\)>/u)).toBeInTheDocument();
    expect(r.container.querySelector("mark")?.textContent).toBe(
      "<script>window.__pwned=1</script>pitch",
    );
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  }, 20_000);

  it("marks a gated hit and shows no body text for it", async () => {
    investor(() => [
      200,
      results([hit({ refId: NDA_ID, title: "Cap table", snippet: [], gated: true })]),
    ]);
    const r = await openSearch("/search?q=cap");
    const item = (await screen.findByRole("link", { name: "Cap table" })).closest("li");
    if (item === null) throw new Error("no list item");
    expect(within(item).getByText("Requires agreement")).toBeInTheDocument();
    expect(
      within(item).getByText("Accept the required agreement to open this and see what it says."),
    ).toBeInTheDocument();
    expect(item.querySelector("mark")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("loads more with the next offset", async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      hit({
        refId: `0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c${String(6000 + i).padStart(4, "0")}`,
        title: `Doc ${i + 1}`,
      }),
    );
    const { fetchMock } = investor(({ url }) =>
      url.searchParams.get("offset") === "20"
        ? [200, results([hit({ refId: POST_ID, title: "Doc 21" })], false)]
        : [200, results(first, true)],
    );
    await openSearch("/search?q=doc");
    await screen.findByRole("link", { name: "Doc 20" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Results for “doc”: 20 shown, more available.",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Doc 21" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Results for “doc”: 21.");
    const urls = searchUrls(fetchMock);
    expect(urls.map((u) => u.searchParams.get("offset"))).toEqual(["0", "20"]);
    expect(urls[0]?.searchParams.get("limit")).toBe("20");
  }, 20_000);

  it("shows an empty state", async () => {
    investor(() => [200, results([], false, "zebra")]);
    const r = await openSearch("/search?q=zebra");
    expect(await screen.findByRole("heading", { name: "Nothing found" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No results for “zebra”.");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a refused query through describeError", async () => {
    investor(() => apiError(400, "search_query_invalid"));
    const r = await openSearch("/search?q=%2B%2B%2B");
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to search for");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Type at least one word or number to search.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Search failed.");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("debounces typing into the page's field and keeps the query in the URL", async () => {
    const { fetchMock } = investor(({ url }) => [
      200,
      results([hit({ title: `Hit for ${url.searchParams.get("q")}` })], false, "x"),
    ]);
    const r = await openSearch("/search");
    expect(screen.getByText(/Type a word or two/u)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search for" }), "runway");
    await waitFor(() => expect(pathOf(r.router)).toBe("/search?q=runway"));
    expect(await screen.findByRole("link", { name: "Hit for runway" })).toBeInTheDocument();
    // One request for the settled query, not one per keystroke.
    expect(searchUrls(fetchMock).map((u) => u.searchParams.get("q"))).toEqual(["runway"]);
    // The header field follows the URL.
    expect(
      within(screen.getByRole("search", { name: "Workspace" })).getByRole("searchbox"),
    ).toHaveValue("runway");
  }, 20_000);
});

describe("admin search", () => {
  it("searches from the admin shell at /admin/search", async () => {
    const { fetchMock } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({
          session: session({
            population: "staff",
            authLevel: 2,
            user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
          }),
          membership: membership({ id: STAFF_ID, kind: "staff", role: "owner" }),
        }),
      ],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          permissions: ["access.read"],
          membership: { id: STAFF_ID, kind: "staff", role: "owner" },
        }),
      ],
      "GET /api/v1/search": () => [
        200,
        results([hit({ title: "Board notes", href: "/admin/crm", snippet: [] })], false, "board"),
      ],
    });
    const r = await renderApp("/admin");
    const field = within(
      await screen.findByRole("search", { name: "Workspace" }, { timeout: 5000 }),
    ).getByRole("searchbox", { name: "Search this workspace" });
    const user = userEvent.setup();
    await user.keyboard("/");
    expect(field).toHaveFocus();
    await user.keyboard("board{Enter}");
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/search?q=board"));
    expect(
      await screen.findByRole("link", { name: "Board notes" }, { timeout: 5000 }),
    ).toHaveAttribute("href", "/admin/crm");
    expect(searchUrls(fetchMock).at(-1)?.searchParams.get("q")).toBe("board");
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
