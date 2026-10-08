import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00";
const LEGAL = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const GATED = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03";
const VERSION = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const NOW = "2026-09-12T10:00:00.000Z";

const allowed: FundRoomSchemas["AccessDecision"] = {
  allowed: true,
  capabilities: ["view"],
  pendingGates: [],
  reason: "granted",
};
const gated: FundRoomSchemas["AccessDecision"] = {
  allowed: false,
  capabilities: ["view"],
  pendingGates: [{ kind: "nda", detail: { version: "v2" }, source: "workspace" }],
  reason: "gated",
};

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
    documents: [
      doc(DOC, ROOT, "Pitch deck", "2", allowed),
      { ...doc(GATED, ROOT, "Term sheet", "3", gated), renderStatus: "ready" },
      doc("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e05", LEGAL, "Articles", "1.1", allowed),
    ],
  };
}

function doc(
  id: string,
  folderId: string,
  title: string,
  index: string,
  access: FundRoomSchemas["AccessDecision"],
): FundRoomSchemas["DataRoomTreeDocument"] {
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
    access,
  };
}

function detail(
  over: Partial<FundRoomSchemas["DataRoomDocumentDetail"]> = {},
): FundRoomSchemas["DataRoomDocumentDetail"] {
  const { access: _a, ...d } = doc(DOC, ROOT, "Pitch deck", "2", allowed);
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
    ...over,
  };
}

const enabledBootstrap = () =>
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
          "investor.nav": [{ id: "data-room", label: "Data room", to: "/data-room", order: 20 }],
        },
      },
    ],
  });

function handlers(over: Record<string, Parameters<typeof installMockApi>[0][string]> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, enabledBootstrap()],
    "GET /api/v1/data-room/tree": () => [200, tree()],
    "GET /api/v1/data-room/documents/{id}": () => [200, detail()],
    "POST /api/v1/data-room/documents/{id}/viewed": () => [200, { recorded: true }],
    // Q&A (E3.3) is off here; data-room-qa.test.tsx covers it.
    "GET /api/v1/data-room/qa/status": () => [
      200,
      { enabled: false, canAsk: false, allowFolderQuestions: true },
    ],
    "GET /api/v1/data-room/documents/{id}/pages/{n}/text": ({ params }) => [
      200,
      { pageNo: Number(params["n"]), pageCount: 3, text: `Text of page ${params["n"]}` },
    ],
    "GET /api/v1/data-room/documents/{id}/search": ({ url }) => [
      200,
      {
        hits:
          url.searchParams.get("q") === "runway"
            ? [{ pageNo: 3, snippet: "18 months of «runway» left" }]
            : [],
      },
    ],
    ...over,
  });
}

describe("data room browser", () => {
  it("lists folders and documents with index numbers, badges and thumbnails", async () => {
    handlers();
    const r = await renderApp("/data-room");
    expect(await screen.findByRole("heading", { name: "Data room" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1\s*Legal/u })).toHaveAttribute(
      "href",
      `/data-room/folders/${LEGAL}`,
    );
    expect(screen.getByRole("link", { name: /2\s*Pitch deck/u })).toHaveAttribute(
      "href",
      `/data-room/documents/${DOC}`,
    );
    // The lock is a way in, not a dead end (E2.3 S6.3): it is the button that opens the sheet.
    expect(
      screen.getByRole("button", { name: "Locked — sign to open Term sheet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/NDA/u)).toBeInTheDocument();
    expect(screen.queryByText("Articles")).toBeNull();
    const img = r.container.querySelector(`img[src$="/data-room/documents/${DOC}/thumbnail"]`);
    expect(img).not.toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("browses into a folder with a breadcrumb and filters titles", async () => {
    handlers();
    const r = await renderApp(`/data-room/folders/${LEGAL}`);
    expect(await screen.findByText("Articles")).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Folder path" });
    expect(within(crumbs).getByText("Legal")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Pitch deck")).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Filter by title"), "pitch");
    expect(await screen.findByText("Pitch deck")).toBeInTheDocument();
    expect(screen.queryByText("Articles")).toBeNull();
    await expectNoA11yViolations(r.container);
  });
});

describe("secure viewer", () => {
  it("records the view, shows pages lazily, searches and navigates with the keyboard", async () => {
    const { calls } = handlers();
    const r = await renderApp(`/data-room/documents/${DOC}`);
    expect(await screen.findByRole("heading", { name: "2 Pitch deck" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path.endsWith(`/documents/${DOC}/viewed`)),
      ).toBe(true),
    );
    const page1 = screen.getByRole("img", { name: "Page 1 of Pitch deck" });
    expect(page1).toHaveAttribute(
      "src",
      `http://localhost/api/v1/data-room/documents/${DOC}/pages/1`,
    );
    expect(screen.getByRole("img", { name: "Page 2 of Pitch deck" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Page 3 of Pitch deck" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Download/u })).toBeNull();

    const user = userEvent.setup();
    const stage = screen.getByLabelText(/Use the arrow keys/u);
    stage.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await user.keyboard("{PageDown}");
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Page 3 of Pitch deck" })).toBeInTheDocument();
    // Toolbar items stay focusable when unavailable (APG toolbar): aria-disabled, not disabled.
    expect(screen.getByRole("button", { name: "Next page" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.type(screen.getByRole("searchbox", { name: "Search in document" }), "runway{Enter}");
    const hit = await screen.findByRole("button", { name: /Page 3.*runway/u });
    expect(hit).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await user.click(hit);
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });

  it("offers the watermarked download when allowed and explains unavailable states", async () => {
    handlers({
      "GET /api/v1/data-room/documents/{id}": () => [
        200,
        detail({
          availability: { viewable: false, download: "watermarked", reason: "unsupported" },
        }),
      ],
    });
    const r = await renderApp(`/data-room/documents/${DOC}`);
    expect(await screen.findByText("No preview for this file type")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download \(watermarked\)/u })).toHaveAttribute(
      "href",
      `http://localhost/api/v1/data-room/documents/${DOC}/download`,
    );
    expect(screen.queryByRole("img", { name: /Page 1/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("shows the pending gate instead of pages and does not record a view", async () => {
    const { calls } = handlers({
      "GET /api/v1/data-room/documents/{id}": () => [200, detail({ access: gated })],
    });
    const r = await renderApp(`/data-room/documents/${DOC}`);
    expect(await screen.findByText("Access requirement pending")).toBeInTheDocument();
    expect(screen.getByText(/NDA/u)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Page 1/u })).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/viewed"))).toBe(false);
    await expectNoA11yViolations(r.container);
  });
});

describe("keyboard-complete viewer (E2.8)", () => {
  const stageOf = () => screen.getByLabelText(/Use the arrow keys/u);
  const figure = (n: number, root: HTMLElement) =>
    root.querySelector<HTMLElement>(`figure[data-page="${n}"]`) as HTMLElement;

  it("zooms with + = - 0 on the stage, announces the level and ignores Ctrl/Cmd", async () => {
    handlers();
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const user = userEvent.setup();
    stageOf().focus();
    const status = screen.getByRole("status", { name: "" });
    expect(status).toHaveTextContent("Zoom: Fit width");
    await user.keyboard("+");
    expect(status).toHaveTextContent("Zoom: 150%");
    expect(figure(1, r.container).style.width).toBe("150%");
    await user.keyboard("=");
    expect(status).toHaveTextContent("Zoom: 200%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("-");
    expect(status).toHaveTextContent("Zoom: 150%");
    await user.keyboard("{Control>}-{/Control}");
    expect(status).toHaveTextContent("Zoom: 150%");
    await user.keyboard("0");
    expect(status).toHaveTextContent("Zoom: Fit width");
    expect(figure(1, r.container).style.width).toBe("100%");
    expect(screen.getByRole("button", { name: "Fit width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{End}");
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(document.activeElement).toBe(stageOf());
    await expectNoA11yViolations(r.container);
  });

  it("goes to a typed page, moves focus to it and rejects an out-of-range number", async () => {
    handlers();
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const user = userEvent.setup();
    const field = screen.getByRole("spinbutton", { name: "Go to page" });
    await user.type(field, "9{Enter}");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Enter a page number from 1 to 3.");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await user.clear(field);
    expect(field).not.toHaveAttribute("aria-invalid");
    await user.type(field, "3");
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(document.activeElement).toBe(figure(3, r.container));
    expect(figure(3, r.container)).toHaveAccessibleName("Page 3");
    // Paging keys still work from the focused page (events bubble to the stage).
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });

  it("opens at the page an AI citation links to (#page-<n>)", async () => {
    handlers();
    const r = await renderApp(`/data-room/documents/${DOC}#page-3`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    await waitFor(() => expect(screen.getByText("Page 3 of 3")).toBeInTheDocument());
    expect(document.activeElement).toBe(figure(3, r.container));
  });

  it("lazily loads a thumbnail for every page and focuses the page a thumbnail opens", async () => {
    handlers();
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const thumbs = nav.querySelectorAll("img");
    expect(thumbs).toHaveLength(3);
    thumbs.forEach((img, i) => {
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("alt", "");
      expect(img.getAttribute("src")).toMatch(new RegExp(`/pages/${i + 1}$`, "u"));
    });
    const user = userEvent.setup();
    await user.click(within(nav).getByRole("button", { name: "Page 2" }));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(document.activeElement).toBe(figure(2, r.container));
    expect(within(nav).getByRole("button", { name: "Page 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("makes the toolbar a single tab stop with arrow-key roving focus", async () => {
    handlers();
    await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const toolbar = screen.getByRole("toolbar", { name: "Viewer controls" });
    const items = within(toolbar).getAllByRole("button");
    expect(items.map((b) => b.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    const user = userEvent.setup();
    const prev = within(toolbar).getByRole("button", { name: "Previous page" });
    prev.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Next page" }));
    await user.keyboard("{End}");
    const help = within(toolbar).getByRole("button", { name: "Keyboard shortcuts" });
    expect(document.activeElement).toBe(help);
    expect(help).toHaveAttribute("tabindex", "0");
    expect(prev).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(prev);
    await user.keyboard("{ArrowLeft}{Home}");
    expect(document.activeElement).toBe(prev);
    // Arrow keys in the toolbar move focus, not pages.
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    // An unavailable control stays focusable but does nothing.
    await user.keyboard("{Enter}");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("opens the shortcut list with ? and returns focus on Escape", async () => {
    handlers();
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const user = userEvent.setup();
    stageOf().focus();
    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByRole("cell", { name: "+ or =" })).toBeInTheDocument();
    expect(within(dialog).getByRole("cell", { name: "First page" })).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(stageOf());

    // `?` typed into a text field is text, not a shortcut.
    await user.type(screen.getByRole("searchbox", { name: "Search in document" }), "?");
    expect(screen.queryByRole("dialog")).toBeNull();

    const help = screen.getByRole("button", { name: "Keyboard shortcuts" });
    await user.click(help);
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(help);
    await expectNoA11yViolations(r.container);
  });

  it("renders each mounted page's text as a hidden text layer, with a fallback", async () => {
    handlers({
      "GET /api/v1/data-room/documents/{id}/pages/{n}/text": ({ params }) =>
        params["n"] === "1"
          ? [
              200,
              { pageNo: 1, pageCount: 3, text: "Seed round\n\nWe raise 2M to reach 18 months." },
            ]
          : params["n"] === "2"
            ? [200, { pageNo: 2, pageCount: 3, text: "   " }]
            : apiError(403, "forbidden"),
    });
    const r = await renderApp(`/data-room/documents/${DOC}`);
    await screen.findByRole("heading", { name: "2 Pitch deck" });
    const layer = (n: number) =>
      figure(n, r.container).querySelector<HTMLElement>("[data-text-layer]");
    await waitFor(() => expect(layer(1)).toHaveAttribute("data-text-layer", "text"));
    const paragraphs = Array.from(layer(1)?.querySelectorAll("p") ?? [], (p) => p.textContent);
    expect(paragraphs).toEqual(["Seed round", "We raise 2M to reach 18 months."]);
    expect(layer(1)).toHaveClass("sr-only");
    await waitFor(() => expect(layer(2)).toHaveAttribute("data-text-layer", "none"));
    expect(layer(2)).toHaveTextContent("This page has no text layer.");
    // Page 3 is not mounted yet: no image, no text request.
    expect(layer(3)).toBeNull();
    const user = userEvent.setup();
    stageOf().focus();
    await user.keyboard("{End}");
    await waitFor(() => expect(layer(3)).toHaveAttribute("data-text-layer", "none"));
    expect(layer(3)).toHaveTextContent("This page has no text layer.");
    await expectNoA11yViolations(r.container);
  });
});
