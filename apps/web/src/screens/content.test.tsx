import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

const PAGE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01";
const REV_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d02";
const DRAFT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d03";
const BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d04";
const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const NOW = "2026-09-11T10:00:00.000Z";

function doc(): FundRoomSchemas["PageDoc"] {
  return {
    sections: [
      {
        key: "welcome",
        title: null,
        blocks: [
          {
            id: "hero",
            type: "hero",
            schemaVersion: 1,
            data: {
              heading: "Acme investor portal",
              subheading: "Confidential.",
              imageUrl: null,
              cta: { label: "Deck", href: "/data-room" },
            },
          },
        ],
      },
      {
        key: "about",
        title: "About",
        blocks: [
          {
            id: "about-text",
            type: "rich_text",
            schemaVersion: 1,
            data: {
              format: "markdown",
              text: "## What we do\n\nWe make **widgets** for [everyone](https://acme.test).\n\n- fast\n- cheap\n\n<script>alert(1)</script>",
            },
          },
          {
            id: "faq",
            type: "faq",
            schemaVersion: 1,
            data: { items: [{ question: "Cap?", answer: "Ask us." }] },
          },
        ],
      },
      {
        key: "board",
        title: "Board pack",
        blocks: [
          {
            id: "m",
            type: "metric_grid",
            schemaVersion: 1,
            data: { definitionIds: [], columns: 3 },
          },
        ],
      },
    ],
  };
}

function rendered(
  over: Partial<FundRoomSchemas["RenderedPage"]> = {},
): FundRoomSchemas["RenderedPage"] {
  const d = doc();
  return {
    page: { id: PAGE_ID, slug: "home", kind: "home", title: "Overview" },
    revision: { id: REV_ID, revisionNo: 2, publishedAt: NOW },
    sections: d.sections.slice(0, 2).map((s) => ({
      key: s.key,
      title: s.title,
      visibility: { mode: "authenticated" as const },
      blocks: s.blocks.map((b) => ({ ...b })),
    })),
    viewer: "external",
    preview: false,
    ...over,
  };
}

function detail(
  over: Partial<FundRoomSchemas["ContentPageDetail"]> = {},
): FundRoomSchemas["ContentPageDetail"] {
  return {
    page: {
      id: PAGE_ID,
      slug: "home",
      kind: "home",
      title: "Overview",
      publishedRevisionNo: 2,
      publishedAt: NOW,
      draftSavedAt: NOW,
      draftDirty: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
    draft: { revisionId: DRAFT_ID, doc: doc(), savedAt: NOW },
    visibility: {
      welcome: { mode: "authenticated" },
      about: { mode: "authenticated" },
      board: { mode: "groups", groupIds: [BOARD_ID] },
    },
    groups: [{ id: BOARD_ID, name: "Board" }],
    ...over,
  };
}

const staffBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "content",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            {
              id: "content-page",
              label: "Overview page",
              to: "/admin/content",
              order: 10,
              icon: "document",
            },
          ],
        },
      },
    ],
    permissions: ["content.read", "content.manage", "content.publish", "content.settings"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
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

describe("investor home", () => {
  it("renders the published page: hero, safe markdown, FAQ; no audience badges", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/content/render/home": () => [200, rendered()],
    });
    const r = await renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "Acme investor portal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deck" })).toHaveAttribute("href", "/data-room");
    expect(screen.getByRole("heading", { name: "What we do" })).toBeInTheDocument();
    expect(screen.getByText("widgets").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "everyone" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByText(/<script>alert\(1\)<\/script>/u)).toBeInTheDocument();
    expect(document.querySelector("script[src], body script:not([type])")).toBeNull();
    expect(screen.getByText("fast").tagName).toBe("LI");
    expect(screen.getByText("Cap?")).toBeInTheDocument();
    expect(screen.queryByText("All investors")).toBeNull();
    // Module tiles stay below the page.
    const tiles = screen.getByRole("region", { name: "What's here" });
    expect(within(tiles).getByRole("link", { name: /Updates/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });

  it("badges sections for staff and shows the reference-block placeholder", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/content/render/home": () => [
        200,
        rendered({
          viewer: "staff",
          sections: [
            ...rendered().sections,
            {
              key: "board",
              title: "Board pack",
              visibility: { mode: "groups", groupIds: [BOARD_ID] },
              blocks: [
                {
                  id: "m",
                  type: "metric_grid",
                  schemaVersion: 1,
                  data: { definitionIds: [] },
                  unavailable: "module_unavailable",
                },
              ],
            },
          ],
        }),
      ],
    });
    await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Board pack" })).toBeInTheDocument();
    expect(screen.getAllByText("All investors")).toHaveLength(2);
    expect(screen.getByText(/Metrics will appear here/u)).toBeInTheDocument();
  });

  it("renders a hydrated disclaimer with its version, and nothing for one that resolved to nothing", async () => {
    const legal = (
      id: string,
      hydrated: Record<string, unknown> | null,
    ): FundRoomSchemas["RenderedBlock"] => ({
      id,
      type: "disclaimer",
      schemaVersion: 1,
      data: hydrated === null ? { slug: null } : { slug: "offering-disclaimer", hydrated },
    });
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/content/render/home": () => [
        200,
        rendered({
          sections: [
            {
              key: "legal",
              title: "Legal",
              visibility: { mode: "authenticated" },
              blocks: [
                legal("d1", {
                  slug: "offering-disclaimer",
                  title: "Offering disclaimer",
                  versionNo: 3,
                  body: "This is **not** an offer of securities.",
                  effectiveAt: NOW,
                }),
                // A workspace that has never written a disclaimer: hydration is empty, not failed.
                legal("d2", null),
              ],
            },
          ],
        }),
      ],
    });
    const r = await renderApp("/");
    expect(await screen.findByText("Offering disclaimer · v3")).toBeInTheDocument();
    expect(screen.getByText("not").tagName).toBe("STRONG");
    expect(screen.getByRole("complementary", { name: "Offering disclaimer" })).toBeInTheDocument();
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    await expectNoA11yViolations(r.container);
  });

  it("shows a custom page at /p/<slug> and not-found for a missing one", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/content/render/{slug}": ({ params }) =>
        params["slug"] === "round"
          ? [
              200,
              rendered({
                page: { id: PAGE_ID, slug: "round", kind: "custom", title: "Seed round" },
              }),
            ]
          : apiError(404, "not_found"),
    });
    await renderApp("/p/round");
    expect(await screen.findByRole("heading", { name: "Seed round" })).toBeInTheDocument();
    await renderApp("/p/missing");
    expect(await screen.findByText(/Page not found/u)).toBeInTheDocument();
  });
});

describe("admin editor", () => {
  function handlers(state: { detail: FundRoomSchemas["ContentPageDetail"] }) {
    return {
      "GET /api/v1/me": () => [200, staffMe()] as [number, unknown],
      "GET /api/v1/modules": () => [200, staffBootstrap()] as [number, unknown],
      "GET /api/v1/content/pages": () => [200, { pages: [state.detail.page] }] as [number, unknown],
      "GET /api/v1/content/settings": () =>
        [200, { allowPublicSections: false }] as [number, unknown],
      "GET /api/v1/content/pages/{id}": () => [200, state.detail] as [number, unknown],
      "PUT /api/v1/content/pages/{id}/draft": ({ body }: { body: unknown }) => {
        const b = body as { doc: FundRoomSchemas["PageDoc"]; baseSavedAt?: string };
        state.detail = {
          ...state.detail,
          page: { ...state.detail.page, draftDirty: true },
          draft: { ...state.detail.draft, doc: b.doc, savedAt: "2026-09-11T10:05:00.000Z" },
        };
        return [200, state.detail] as [number, unknown];
      },
      "POST /api/v1/content/pages/{id}/publish": () => {
        state.detail = {
          ...state.detail,
          page: { ...state.detail.page, publishedRevisionNo: 3, draftDirty: false },
        };
        return [200, state.detail] as [number, unknown];
      },
      "GET /api/v1/content/pages/{id}/preview": ({ url }: { url: URL }) =>
        [
          200,
          rendered({
            preview: true,
            sections:
              url.searchParams.get("as") === "staff"
                ? rendered().sections
                : rendered().sections.slice(0, 1),
          }),
        ] as [number, unknown],
      "GET /api/v1/content/pages/{id}/revisions": () =>
        [
          200,
          {
            revisions: [
              {
                id: REV_ID,
                revisionNo: 2,
                createdAt: NOW,
                publishedAt: NOW,
                createdBy: OWNER_ID,
                note: "Board pack",
                isCurrent: true,
                isDraft: false,
              },
            ],
          },
        ] as [number, unknown],
    };
  }

  it("loads the draft, autosaves an edit with the base timestamp, then publishes", async () => {
    const state = { detail: detail() };
    const { calls } = installMockApi(handlers(state));
    const r = await renderApp("/admin/content");
    const user = userEvent.setup();
    const heading = await screen.findByLabelText(/^Heading/u);
    expect(heading).toHaveValue("Acme investor portal");
    expect(screen.getByText("Groups: Board")).toBeInTheDocument();
    await user.clear(heading);
    await user.type(heading, "Acme, for investors");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(
      () => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/draft"))).toBe(true),
      { timeout: 4000 },
    );
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/draft"));
    const body = put?.body as { doc: FundRoomSchemas["PageDoc"]; baseSavedAt: string };
    expect(body.baseSavedAt).toBe(NOW);
    const heroData = body.doc.sections[0]?.blocks[0]?.data as { heading: string } | undefined;
    expect(heroData?.heading).toBe("Acme, for investors");
    await screen.findByText(/Draft saved/u);
    await user.click(screen.getByRole("button", { name: /^Publish/u }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(true),
    );
    expect((await screen.findAllByText(/Published revision 3/u)).length).toBeGreaterThan(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds a section and removes a block; the audience select lists groups; history lists revisions", async () => {
    const state = { detail: detail() };
    installMockApi(handlers(state));
    await renderApp("/admin/content");
    const user = userEvent.setup();
    await screen.findByLabelText(/^Heading/u);
    await user.click(screen.getByRole("button", { name: "Remove FAQ block" }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add section" }));
    expect(screen.getAllByLabelText("Section title")).toHaveLength(4);
    expect(screen.getByRole("checkbox", { name: "Board" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "History" }));
    const dialog = await screen.findByRole("dialog", { name: "History" });
    expect(await within(dialog).findByText("Revision 2")).toBeInTheDocument();
    expect(within(dialog).getByText("Live")).toBeInTheDocument();
  });

  it("picks a disclaimer by name from the workspace's legal documents", async () => {
    // E1.6: the block used to take a hand-typed slug. It is a select over
    // `GET /compliance/documents` now, and the empty value means the workspace default.
    const base = detail();
    const state = {
      detail: {
        ...base,
        draft: {
          ...base.draft,
          doc: {
            ...base.draft.doc,
            sections: [
              ...base.draft.doc.sections,
              {
                key: "legal",
                title: "Legal",
                blocks: [
                  { id: "dc", type: "disclaimer" as const, schemaVersion: 1, data: { slug: null } },
                ],
              },
            ],
          },
        },
        visibility: { ...base.visibility, legal: { mode: "authenticated" as const } },
      },
    };
    const { calls } = installMockApi({
      ...handlers(state),
      "GET /api/v1/compliance/documents": () => [
        200,
        {
          documents: [
            {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e11",
              slug: "offering-disclaimer",
              title: "Offering disclaimer",
              kind: "disclaimer",
              audience: "external",
              requiresAcceptance: false,
              currentVersionNo: 3,
              stamp: "offering-disclaimer:v3",
              templateId: null,
              templateVersion: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      ],
    });
    await renderApp("/admin/content");
    const select = await screen.findByLabelText("Disclaimer name");
    expect(select).toHaveValue("");
    expect(
      within(select as HTMLElement).getByRole("option", { name: "Workspace default disclaimer" }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Offering disclaimer" });
    await user.selectOptions(select, "offering-disclaimer");
    await waitFor(
      () => {
        const put = calls.findLast((c) => c.method === "PUT" && c.path.endsWith("/draft"));
        const body = put?.body as { doc: FundRoomSchemas["PageDoc"] } | undefined;
        const block = body?.doc.sections.at(-1)?.blocks[0];
        expect(block?.data["slug"]).toBe("offering-disclaimer");
      },
      { timeout: 4000 },
    );
  });

  it("is read-only for a viewer without content.manage", async () => {
    const state = { detail: detail() };
    installMockApi({
      ...handlers(state),
      "GET /api/v1/modules": () => [200, { ...staffBootstrap(), permissions: ["content.read"] }],
    });
    await renderApp("/admin/content");
    expect(await screen.findByLabelText(/^Heading/u)).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /^Publish/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add section" })).toBeNull();
    expect(screen.queryByText("Public sections")).toBeNull();
  });
});
