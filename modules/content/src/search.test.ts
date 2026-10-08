import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices, SearchEntryInput } from "@fundroom/module-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What the overview page contributes to workspace search (E2.8): the text of static blocks only,
 * one entry per section of the PUBLISHED revision, and an ACL taken from that revision's
 * visibility snapshot.
 */
const H = vi.hoisted(() => ({
  pages: new Map<string, Record<string, unknown>>(),
  revisions: new Map<string, Record<string, unknown>>(),
}));

vi.mock("./repos/content-repo.js", () => ({
  PageRepo: class {
    async byId(id: string) {
      return H.pages.get(id);
    }
    async list() {
      return [...H.pages.values()].filter((p) => p["deletedAt"] === null);
    }
  },
  RevisionRepo: class {
    async byId(id: string) {
      return H.revisions.get(id);
    }
  },
}));

const {
  aclForRule,
  blockText,
  contentSearch,
  indexPage,
  pageHref,
  pageSearchEntries,
  sectionText,
  sectionTitle,
} = await import("./search.js");

const block = (type: string, data: Record<string, unknown>) => ({
  id: `${type}-1`,
  type,
  schemaVersion: 1,
  data,
});

describe("text extraction", () => {
  it("hero: heading and subheading", () => {
    expect(blockText(block("hero", { heading: "Acme", subheading: "Robots for farms" }))).toBe(
      "Acme\nRobots for farms",
    );
  });

  it("rich_text: markdown stripped to text (marks, links, headings, lists)", () => {
    const text = blockText(
      block("rich_text", {
        format: "markdown",
        text: "## Traction\n\nWe grew **3x** with [partners](https://example.com).\n\n- one\n- two",
      }),
    );
    expect(text).toContain("Traction");
    expect(text).toContain("We grew 3x with partners");
    // `markdownToText` (shared with email text parts) keeps a link's target after its label.
    expect(text).not.toMatch(/[*#[\]]/u);
    expect(text).toContain("- one");
  });

  it("faq: questions and answers; team: names, roles and bios; embed: its title", () => {
    expect(
      blockText(block("faq", { items: [{ question: "When close?", answer: "In May." }] })),
    ).toBe("When close?\nIn May.");
    expect(
      blockText(
        block("team", {
          members: [
            { name: "Ada", title: "CEO", bio: null },
            { name: "Grace", title: null, bio: "Compilers" },
          ],
        }),
      ),
    ).toBe("Ada\nCEO\nGrace\nCompilers");
    expect(blockText(block("embed", { url: "https://youtu.be/x", title: "Demo day" }))).toBe(
      "Demo day",
    );
  });

  it("reference blocks are skipped: their content belongs to (and is indexed by) other modules", () => {
    for (const type of ["metric_grid", "document_list", "disclaimer", "round_summary"]) {
      expect(blockText(block(type, { title: "Secret folder", definitionIds: [] }))).toBe("");
    }
  });

  it("tolerates unreadable data instead of throwing", () => {
    expect(blockText(block("team", { members: "nope" }))).toBe("");
    expect(blockText(block("faq", { items: [null, { question: 3 }] }))).toBe("");
    expect(blockText({ type: "hero", data: undefined as never })).toBe("");
  });

  it("a section joins its blocks' text; the title adds the section heading when there is one", () => {
    const section = {
      blocks: [
        block("hero", { heading: "A" }),
        block("metric_grid", {}),
        block("faq", { items: [] }),
        block("rich_text", { format: "markdown", text: "B" }),
      ],
    };
    expect(sectionText(section)).toBe("A\n\nB");
    expect(sectionTitle("Overview", { title: "Team" })).toBe("Overview — Team");
    expect(sectionTitle("Overview", { title: null })).toBe("Overview");
    expect(sectionTitle("Overview", { title: "  " })).toBe("Overview");
  });
});

describe("ACL and href", () => {
  it("maps every visibility mode", () => {
    expect(aclForRule({ mode: "public" })).toEqual({ kind: "members" });
    expect(aclForRule({ mode: "authenticated" })).toEqual({ kind: "members" });
    expect(aclForRule({ mode: "groups", groupIds: ["g1", "g2"] })).toEqual({
      kind: "groups",
      groupIds: ["g1", "g2"],
    });
    expect(aclForRule({ mode: "staff_only" })).toEqual({ kind: "staff" });
  });

  it("the home page opens at /, custom pages at /p/<slug>", () => {
    expect(pageHref({ kind: "home", slug: "home" })).toBe("/");
    expect(pageHref({ kind: "custom", slug: "team" })).toBe("/p/team");
  });
});

const PAGE = {
  id: "p1",
  kind: "custom" as const,
  slug: "about",
  title: "About",
  publishedRevisionId: "r1",
  deletedAt: null as Date | null,
};
const PUBLISHED_AT = new Date("2026-09-01T00:00:00Z");
const REVISION = {
  id: "r1",
  doc: {
    sections: [
      { key: "intro", title: null, blocks: [block("hero", { heading: "Hello investors" })] },
      { key: "board", title: "Board", blocks: [block("rich_text", { text: "Board only" })] },
      { key: "ops", title: "Internal", blocks: [block("rich_text", { text: "Staff only" })] },
      { key: "new", title: null, blocks: [] },
    ],
  },
  visibility: {
    intro: { mode: "authenticated" },
    board: { mode: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01"] },
    ops: { mode: "staff_only" },
    // `new` has no rule in the snapshot: the default (authenticated).
  },
  publishedAt: PUBLISHED_AT,
  createdAt: new Date(0),
};

describe("pageSearchEntries", () => {
  it("one entry per section of the published revision, ACL from its snapshot", () => {
    const entries = pageSearchEntries(PAGE, REVISION);
    expect(entries.map((e) => [e.part, e.acl.kind, e.title, e.body])).toEqual([
      ["intro", "members", "About", "Hello investors"],
      ["board", "groups", "About — Board", "Board only"],
      ["ops", "staff", "About — Internal", "Staff only"],
      ["new", "members", "About", ""],
    ]);
    for (const e of entries) {
      expect(e).toMatchObject({ kind: "page", refId: "p1", href: "/p/about" });
      expect(e.updatedAt).toEqual(PUBLISHED_AT);
    }
    expect(entries[1]?.acl).toEqual({
      kind: "groups",
      groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01"],
    });
  });

  it("an unreadable rule falls back to members, never to something wider", () => {
    const entries = pageSearchEntries(PAGE, { ...REVISION, visibility: { intro: { mode: "x" } } });
    expect(entries[0]?.acl).toEqual({ kind: "members" });
  });
});

describe("indexPage / contentSearch.entries", () => {
  const calls: unknown[][] = [];
  const services = {
    search: {
      replace: async (...args: unknown[]) => {
        calls.push(["replace", ...args.slice(2)]);
      },
      remove: async (...args: unknown[]) => {
        calls.push(["remove", ...args.slice(2)]);
      },
    },
  } as unknown as Pick<ModuleServices, "search">;
  const tx = {} as Tx;
  const ctx = { workspaceId: "w1" } as TenantContext;

  beforeEach(() => {
    calls.length = 0;
    H.pages.clear();
    H.revisions.clear();
    H.revisions.set("r1", REVISION);
  });

  it("replaces a published page's entries on the caller's transaction", async () => {
    H.pages.set("p1", PAGE);
    await indexPage(services, tx, ctx, "p1");
    expect(calls).toHaveLength(1);
    const [op, module, kind, refId, entries] = calls[0] as [
      string,
      string,
      string,
      string,
      SearchEntryInput[],
    ];
    expect([op, module, kind, refId]).toEqual(["replace", "content", "page", "p1"]);
    expect(entries).toHaveLength(4);
  });

  it("removes a deleted, unpublished or missing page", async () => {
    H.pages.set("p1", { ...PAGE, deletedAt: new Date() });
    H.pages.set("p2", { ...PAGE, id: "p2", publishedRevisionId: null });
    for (const id of ["p1", "p2", "p3"]) await indexPage(services, tx, ctx, id);
    expect(calls).toEqual([
      ["remove", "content", { kind: "page", refId: "p1" }],
      ["remove", "content", { kind: "page", refId: "p2" }],
      ["remove", "content", { kind: "page", refId: "p3" }],
    ]);
  });

  it("the full rebuild yields every live published page and nothing else", async () => {
    H.pages.set("p1", PAGE);
    H.pages.set("p2", { ...PAGE, id: "p2", publishedRevisionId: null });
    H.pages.set("p3", { ...PAGE, id: "p3", deletedAt: new Date() });
    expect(contentSearch.version).toBe(1);
    const entries = (await contentSearch.entries({ tx, ctx })) as SearchEntryInput[];
    expect(new Set(entries.map((e) => e.refId))).toEqual(new Set(["p1"]));
  });
});
