import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices, SearchEntryInput } from "@fundroom/module-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Audience, SectionRule } from "./model.js";

/*
 * What investor updates contribute to workspace search (E2.8): sent posts only, one entry per
 * section of the published version, with an ACL that is the intersection of the post's audience
 * and the section's rule — the two gates the archive applies.
 */
const H = vi.hoisted(() => ({
  posts: new Map<string, Record<string, unknown>>(),
  versions: new Map<string, Record<string, unknown>>(),
}));

vi.mock("./repos/updates-repo.js", () => ({
  PostRepo: class {
    async live(id: string) {
      const p = H.posts.get(id);
      return p && p["deletedAt"] === null ? p : undefined;
    }
    async archive() {
      return [...H.posts.values()].filter((p) => p["deletedAt"] === null && p["state"] === "sent");
    }
  },
  VersionRepo: class {
    async byId(id: string) {
      return H.versions.get(id);
    }
  },
}));

const { aclFor, indexPost, isSearchable, postHref, postSearchEntries, updatesSearch } =
  await import("./search.js");

const ALL: Audience = { kind: "all" };
const groups = (...groupIds: string[]): Audience => ({ kind: "groups", groupIds });
const AUTH: SectionRule = { mode: "authenticated" };
const STAFF: SectionRule = { mode: "staff_only" };
const ruleGroups = (...groupIds: string[]): SectionRule => ({ mode: "groups", groupIds });

describe("aclFor: audience × section visibility", () => {
  it.each([
    ["all × authenticated", ALL, AUTH, { kind: "members" }],
    ["all × groups", ALL, ruleGroups("a", "b"), { kind: "groups", groupIds: ["a", "b"] }],
    ["all × staff_only", ALL, STAFF, { kind: "staff" }],
    ["groups × authenticated", groups("a", "b"), AUTH, { kind: "groups", groupIds: ["a", "b"] }],
    [
      "groups × groups (overlap)",
      groups("a", "b"),
      ruleGroups("b", "c"),
      { kind: "groups", groupIds: ["b"] },
    ],
    ["groups × groups (disjoint)", groups("a"), ruleGroups("c"), null],
    ["groups × staff_only", groups("a"), STAFF, { kind: "staff" }],
    [
      "groups × groups (duplicates)",
      groups("a"),
      ruleGroups("a", "a"),
      { kind: "groups", groupIds: ["a"] },
    ],
  ] as const)("%s", (_name, audience, rule, expected) => {
    expect(aclFor(audience, rule)).toEqual(expected);
  });
});

describe("isSearchable / postHref", () => {
  const base = { state: "sent" as const, publishedVersionId: "v1", deletedAt: null };
  it("only a live, sent post with a published version", () => {
    expect(isSearchable(base)).toBe(true);
    for (const state of ["draft", "scheduled", "sending", "archived"] as const)
      expect(isSearchable({ ...base, state })).toBe(false);
    expect(isSearchable({ ...base, publishedVersionId: null })).toBe(false);
    expect(isSearchable({ ...base, deletedAt: new Date() })).toBe(false);
  });

  it("opens the archive page by slug", () => {
    expect(postHref({ slug: "q3-update" })).toBe("/updates/q3-update");
  });
});

const hero = (text: string) => ({
  id: `rt-${text.length}`,
  type: "rich_text",
  schemaVersion: 1,
  data: { format: "markdown", text },
});
const VERSION_AT = new Date("2026-09-10T00:00:00Z");
const VERSION = {
  id: "v1",
  title: "Q3 update",
  doc: {
    sections: [
      { key: "summary", title: null, blocks: [hero("Revenue **doubled**")] },
      { key: "board", title: "Board notes", blocks: [hero("Board only text")] },
      { key: "internal", title: null, blocks: [hero("Staff note")] },
    ],
  },
  visibility: {
    summary: { mode: "authenticated" },
    board: { mode: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01"] },
    internal: { mode: "staff_only" },
  },
  createdAt: VERSION_AT,
};
const POST = {
  id: "p1",
  slug: "q3-update",
  state: "sent",
  publishedVersionId: "v1",
  deletedAt: null as Date | null,
  audience: { kind: "all" },
  // The draft may already say something else; search reads the published version.
  title: "Q4 draft title",
  doc: { sections: [] },
};

describe("postSearchEntries", () => {
  it("indexes the published version per section, with the intersected ACL", () => {
    const entries = postSearchEntries(POST, VERSION);
    expect(entries.map((e) => [e.part, e.acl, e.title, e.body])).toEqual([
      ["summary", { kind: "members" }, "Q3 update", "Revenue doubled"],
      [
        "board",
        { kind: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01"] },
        "Q3 update — Board notes",
        "Board only text",
      ],
      ["internal", { kind: "staff" }, "Q3 update", "Staff note"],
    ]);
    for (const e of entries) {
      expect(e).toMatchObject({ kind: "post", refId: "p1", href: "/updates/q3-update" });
      expect(e.updatedAt).toEqual(VERSION_AT);
    }
  });

  it("a group audience narrows every section; a section outside it is not indexed at all", () => {
    const entries = postSearchEntries(
      { ...POST, audience: groups("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02") },
      VERSION,
    );
    expect(entries.map((e) => [e.part, e.acl])).toEqual([
      ["summary", { kind: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02"] }],
      ["internal", { kind: "staff" }],
    ]);
  });
});

describe("indexPost / updatesSearch.entries", () => {
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
    H.posts.clear();
    H.versions.clear();
    H.versions.set("v1", VERSION);
  });

  it("a sent post is replaced; a row passed in is used as is", async () => {
    H.posts.set("p1", POST);
    await indexPost(services, tx, ctx, "p1");
    await indexPost(services, tx, ctx, POST as never);
    expect(calls.map((c) => c.slice(0, 4))).toEqual([
      ["replace", "updates", "post", "p1"],
      ["replace", "updates", "post", "p1"],
    ]);
    expect(calls[0]?.[4] as SearchEntryInput[]).toHaveLength(3);
  });

  it("drafts, sending, archived and deleted posts are removed", async () => {
    for (const [id, over] of [
      ["d", { state: "draft", publishedVersionId: null }],
      ["s", { state: "sending" }],
      ["a", { state: "archived" }],
      ["x", { deletedAt: new Date() }],
    ] as const) {
      H.posts.set(id, { ...POST, id, ...over });
      await indexPost(services, tx, ctx, id);
    }
    expect(calls).toEqual(
      ["d", "s", "a", "x"].map((refId) => ["remove", "updates", { kind: "post", refId }]),
    );
  });

  it("the full rebuild yields sent posts only", async () => {
    H.posts.set("p1", POST);
    H.posts.set("p2", { ...POST, id: "p2", state: "draft", publishedVersionId: null });
    H.posts.set("p3", { ...POST, id: "p3", state: "archived" });
    const entries = (await updatesSearch.entries({ tx, ctx })) as SearchEntryInput[];
    expect(new Set(entries.map((e) => e.refId))).toEqual(new Set(["p1"]));
  });
});
