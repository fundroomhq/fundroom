import type { TenantContext, Tx } from "@fundroom/db";
import type { AccessDecision, ResourceRef } from "@fundroom/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateQuery, CandidateRow } from "./repos/search-repo.js";

const repo = vi.hoisted(() => ({
  candidates: [] as CandidateRow[],
  byTitle: [] as CandidateRow[],
  heads: new Map<string, string>(),
  lastQuery: undefined as CandidateQuery | undefined,
  fullQueries: [] as CandidateQuery[],
  titleQueries: 0,
  headIds: [] as string[],
}));

const keyOf = (r: CandidateRow) => `${r.aclResourceKind}:${r.aclResourceId}`;

vi.mock("./repos/search-repo.js", () => ({
  // Stands in for `to_tsvector('simple', word)`: lower-cased runs of letters/digits.
  queryLexemes: async (_tx: Tx, words: readonly string[]) =>
    words.map((w) =>
      [...new Set(w.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((x) => x.length > 0).sort(),
    ),
  searchCandidates: async (_tx: Tx, q: CandidateQuery) => {
    repo.lastQuery = q;
    repo.fullQueries.push(q);
    const out = new Set(q.excludeResources ?? []);
    return repo.candidates
      .filter((r) => r.aclKind !== "resource" || !out.has(keyOf(r)))
      .slice(0, q.limit);
  },
  titleCandidates: async (_tx: Tx, q: CandidateQuery) => {
    repo.titleQueries += 1;
    return repo.byTitle.slice(0, q.limit);
  },
  headlines: async (_tx: Tx, _ws: string, ids: readonly string[]) => {
    repo.headIds = [...ids];
    return new Map([...repo.heads].filter(([id]) => ids.includes(id)));
  },
}));

const { CANDIDATE_CAP, runSearch, SearchQueryError } = await import("./engine.js");

const WS = "0192f1a0-5c3e-7d2a-9a3b-00000000aaaa";
const ME = "0192f1a0-5c3e-7d2a-9a3b-00000000bbbb";
const investor: TenantContext = { workspaceId: WS, actorKind: "external", membershipId: ME };
const staff: TenantContext = { workspaceId: WS, actorKind: "staff", membershipId: ME };

let n = 0;
function row(over: Partial<CandidateRow> = {}): CandidateRow {
  n += 1;
  const id = `0192f1a0-5c3e-7d2a-9a3b-${String(n).padStart(12, "0")}`;
  return {
    id,
    module: "data-room",
    kind: "document",
    refId: id,
    title: `Doc ${n}`,
    href: `/data-room/documents/${id}`,
    sourceUpdatedAt: new Date("2026-09-01T00:00:00Z"),
    aclKind: "members",
    aclResourceKind: null,
    aclResourceId: null,
    aclPath: null,
    tier: 0,
    score: 1 / n,
    ...over,
  };
}

function resource(id: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return row({ aclKind: "resource", aclResourceKind: "document", aclResourceId: id, ...over });
}

type Decide = (r: ResourceRef) => AccessDecision["reason"];
function deps(decide: Decide = () => "granted") {
  const calls: ResourceRef[] = [];
  const db = {
    withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn({} as Tx),
  };
  return {
    calls,
    deps: {
      db,
      check: async (_p: unknown, r: ResourceRef) => {
        calls.push(r);
        const reason = decide(r);
        return { allowed: reason === "granted", reason };
      },
    },
  };
}

const req = (over: Partial<Parameters<typeof runSearch>[2]> = {}) => ({
  q: "runway",
  limit: 20,
  offset: 0,
  modules: ["data-room", "content"],
  ...over,
});

beforeEach(() => {
  repo.candidates = [];
  repo.byTitle = [];
  repo.heads = new Map();
  repo.lastQuery = undefined;
  repo.fullQueries = [];
  repo.titleQueries = 0;
  repo.headIds = [];
});

describe("runSearch", () => {
  it("refuses a query without a searchable word", async () => {
    await expect(runSearch(deps().deps, staff, req({ q: "':*&|!()" }))).rejects.toBeInstanceOf(
      SearchQueryError,
    );
  });

  it("returns nothing (and reads nothing) when no module is visible", async () => {
    repo.candidates = [row()];
    const out = await runSearch(deps().deps, staff, req({ modules: [] }));
    expect(out).toEqual({ query: "runway", hits: [], hasMore: false });
    expect(repo.lastQuery).toBeUndefined();
  });

  it("passes modules, kinds and the built queries to the repo; trigram only for ≥ 3 chars", async () => {
    await runSearch(deps().deps, staff, req({ q: "Pitch de", kinds: ["document"] }));
    expect(repo.lastQuery).toMatchObject({
      workspaceId: WS,
      modules: ["data-room", "content"],
      kinds: ["document"],
      trigram: true,
      trigramThreshold: 0.4,
      queries: { all: "'pitch' & 'de':*", title: "'pitch':A & 'de':*A", plain: "Pitch de" },
    });
    await runSearch(deps().deps, staff, req({ q: "ab" }));
    expect(repo.lastQuery?.trigram).toBe(false);
  });

  it("de-duplicates per (module, kind, ref), keeping the first (best-ranked) part", async () => {
    const a = row();
    repo.candidates = [
      a,
      { ...a, id: "0192f1a0-5c3e-7d2a-9a3b-ffffffffffff", title: "part 2" },
      row(),
      { ...a, kind: "page" },
    ];
    const out = await runSearch(deps().deps, staff, req());
    expect(out.hits.map((h) => [h.kind, h.refId, h.title])).toEqual([
      ["document", a.refId, a.title],
      ["document", repo.candidates[2]?.refId, repo.candidates[2]?.title],
      ["page", a.refId, a.title],
    ]);
  });

  it("pages with offset/limit and reports hasMore", async () => {
    repo.candidates = Array.from({ length: 7 }, () => row());
    const p1 = await runSearch(deps().deps, staff, req({ limit: 3 }));
    expect(p1.hits.map((h) => h.refId)).toEqual(repo.candidates.slice(0, 3).map((r) => r.refId));
    expect(p1.hasMore).toBe(true);
    const p3 = await runSearch(deps().deps, staff, req({ limit: 3, offset: 6 }));
    expect(p3.hits.map((h) => h.refId)).toEqual([repo.candidates[6]?.refId]);
    expect(p3.hasMore).toBe(false);
    const p2 = await runSearch(deps().deps, staff, req({ limit: 3, offset: 3 }));
    expect(p2.hasMore).toBe(true);
  });

  it("staff: no authz calls, resource hits in full", async () => {
    repo.candidates = [resource("0192f1a0-5c3e-7d2a-9a3b-0000000000d1")];
    const d = deps(() => "no_grant");
    const out = await runSearch(d.deps, staff, req());
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.gated).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it("external: resource hits are checked — denied dropped, granted kept, gated only by title", async () => {
    const granted = resource("0192f1a0-5c3e-7d2a-9a3b-0000000000a1", {
      aclPath: "root.x",
      score: 0.9,
    });
    const denied = resource("0192f1a0-5c3e-7d2a-9a3b-0000000000a2", { score: 0.8 });
    const gatedTitle = resource("0192f1a0-5c3e-7d2a-9a3b-0000000000a3", { score: 0.7 });
    const gatedBody = resource("0192f1a0-5c3e-7d2a-9a3b-0000000000a4", { score: 0.6 });
    const members = row({ score: 0.5 });
    repo.candidates = [granted, denied, gatedTitle, gatedBody, members];
    // Only gatedTitle's (and granted's) TITLE matches: the title list is all a gated hit may use.
    repo.byTitle = [
      { ...gatedTitle, score: 0.05 },
      { ...granted, score: 0.01 },
    ];
    for (const r of repo.candidates) repo.heads.set(r.id, `x \u0002runway\u0003 y`);
    const reasons: Record<string, AccessDecision["reason"]> = {
      [granted.aclResourceId ?? ""]: "granted",
      [denied.aclResourceId ?? ""]: "no_grant",
      [gatedTitle.aclResourceId ?? ""]: "gated",
      [gatedBody.aclResourceId ?? ""]: "gated",
    };
    const d = deps((r) => reasons[r.id] ?? "not_member");
    const out = await runSearch(d.deps, investor, req());
    expect(out.hits.map((h) => [h.refId, h.gated, h.snippet.length > 0])).toEqual([
      [granted.refId, false, true],
      [members.refId, false, true],
      [gatedTitle.refId, true, false],
    ]);
    // The gated hit's body is never even read for a headline.
    expect(repo.headIds).not.toContain(gatedTitle.id);
    expect(d.calls.find((c) => c.id === granted.aclResourceId)).toEqual({
      kind: "document",
      id: granted.aclResourceId,
      path: "root.x",
    });
  });

  it("external: a gated hit's inclusion and place depend on its title rank alone", async () => {
    const gated = resource("0192f1a0-5c3e-7d2a-9a3b-0000000000b1");
    const members = row();
    const run = async (full: CandidateRow[]) => {
      repo.candidates = full;
      repo.byTitle = [{ ...gated, tier: 1, score: 0.5 }];
      return runSearch(deps(() => "gated").deps, investor, req());
    };
    // The body matched (gated first in the whole-entry list) or it did not (absent): same answer.
    const withBody = await run([{ ...gated, score: 9 }, members]);
    const without = await run([members]);
    expect(withBody).toEqual(without);
    expect(without.hits.map((h) => [h.refId, h.gated])).toEqual([
      [members.refId, false],
      [gated.refId, true],
    ]);
  });

  it("external: not-openable rows that filled the capped list are excluded and it is re-read", async () => {
    const gatedMany = Array.from({ length: CANDIDATE_CAP }, (_, i) =>
      resource(`0192f1a0-5c3e-7d2a-9a3b-${String(5000 + i).padStart(12, "0")}`, { score: 10 }),
    );
    const members = [row(), row()];
    repo.candidates = [...gatedMany, ...members];
    const out = await runSearch(deps(() => "gated").deps, investor, req({ limit: 5 }));
    expect(out.hits.map((h) => h.refId)).toEqual(members.map((m) => m.refId));
    expect(out.hasMore).toBe(false);
    expect(repo.fullQueries).toHaveLength(2);
    expect(repo.fullQueries[1]?.excludeResources).toHaveLength(CANDIDATE_CAP);
    // Staff never need it.
    repo.fullQueries = [];
    await runSearch(deps().deps, staff, req({ limit: 5 }));
    expect(repo.fullQueries).toHaveLength(1);
    expect(repo.titleQueries).toBe(1);
  });

  it("external: one authz check per resource, and a staff-ACL row that slipped through is dropped", async () => {
    const id = "0192f1a0-5c3e-7d2a-9a3b-0000000000e1";
    repo.candidates = [
      resource(id),
      resource(id, { module: "content", kind: "page" }),
      row({ aclKind: "staff" }),
    ];
    const d = deps();
    const out = await runSearch(d.deps, investor, req());
    expect(out.hits).toHaveLength(2);
    expect(d.calls).toHaveLength(1);
  });

  it("stops checking once the page (plus one) is full", async () => {
    repo.candidates = Array.from({ length: 50 }, (_, i) =>
      resource(`0192f1a0-5c3e-7d2a-9a3b-${String(900 + i).padStart(12, "0")}`),
    );
    const d = deps();
    const out = await runSearch(d.deps, investor, req({ limit: 5 }));
    expect(out.hits).toHaveLength(5);
    expect(out.hasMore).toBe(true);
    expect(d.calls).toHaveLength(6);
  });

  it("snippets are segments; a hit without a body match has none", async () => {
    const a = row();
    const b = row();
    repo.candidates = [a, b];
    repo.heads.set(a.id, "The \u0002runway\u0003 is long");
    const out = await runSearch(deps().deps, staff, req());
    expect(out.hits[0]?.snippet).toEqual([
      { text: "The ", highlight: false },
      { text: "runway", highlight: true },
      { text: " is long", highlight: false },
    ]);
    expect(out.hits[1]?.snippet).toEqual([]);
    expect(out.hits[0]?.updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
