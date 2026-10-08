import type { Gate } from "@fundroom/authz";
import { describe, expect, it } from "vitest";
import type { ReviewMemberRow } from "../repos/access-review-repo.js";
import {
  ACCESS_REVIEW_INTERVAL_DAYS,
  type AccessReviewFacts,
  accessReviewDueAt,
  accessReviewEvidence,
  buildAccessReviewRows,
  canonicalJson,
  createAccessReviewJobs,
  isoWeekKey,
  isoWeekStart,
  remindOverdueAccessReviews,
  reportSha256,
  summarize,
} from "./access-review.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

function member(over: Partial<ReviewMemberRow> = {}): ReviewMemberRow {
  return {
    membershipId: "m1",
    userId: "u1",
    name: "Ada",
    email: "ada@example.com",
    userErased: false,
    kind: "external",
    role: "investor",
    status: "active",
    lastSeenAt: ago(1),
    expiresAt: null,
    ...over,
  };
}

function facts(over: Partial<AccessReviewFacts> = {}): AccessReviewFacts {
  return {
    members: [member()],
    truncated: false,
    groups: new Map(),
    grantCounts: new Map(),
    attestations: [],
    pending: [],
    gates: [],
    linkIds: new Map(),
    sessions: new Map(),
    ...over,
  };
}

const accreditedGate = (maxAgeDays: number | undefined, target: Gate["target"]): Gate => ({
  policyId: `p${String(maxAgeDays)}`,
  kind: "accredited",
  config: maxAgeDays === undefined ? {} : { maxAgeDays },
  target,
});

describe("buildAccessReviewRows", () => {
  it("flags nothing for a recently active member with nothing pending", () => {
    const [row] = buildAccessReviewRows(facts(), NOW);
    expect(row?.flags).toEqual([]);
    expect(row?.lastActiveAt).toBe(ago(1).toISOString());
  });

  it("takes the later of membership and this-workspace session activity", () => {
    const [row] = buildAccessReviewRows(
      facts({
        members: [member({ lastSeenAt: ago(200) })],
        sessions: new Map([["u1", { userId: "u1", lastSeenAt: ago(3), liveSessions: 2 }]]),
      }),
      NOW,
    );
    expect(row?.lastActiveAt).toBe(ago(3).toISOString());
    expect(row?.activeSessions).toBe(2);
    expect(row?.flags).not.toContain("stale");
  });

  it("stale after 90 days, never_active without any activity, expiring within 14 days", () => {
    const rows = buildAccessReviewRows(
      facts({
        members: [
          member({ membershipId: "a", lastSeenAt: ago(91) }),
          member({ membershipId: "b", userId: "u2", lastSeenAt: null }),
          member({ membershipId: "c", userId: "u3", expiresAt: ahead(13) }),
          member({ membershipId: "d", userId: "u4", expiresAt: ahead(15) }),
        ],
      }),
      NOW,
    );
    expect(rows.map((r) => r.flags)).toEqual([["stale"], ["never_active"], ["expiring"], []]);
  });

  it("does not call a dormant member stale (the status already says so)", () => {
    const [row] = buildAccessReviewRows(
      facts({ members: [member({ status: "dormant", lastSeenAt: ago(365) })] }),
      NOW,
    );
    expect(row?.flags).toEqual([]);
  });

  it("agrees with the default gate: a 12-month expiry and a 365-day window do not diverge", () => {
    const signed = new Date("2026-03-01T00:00:00.000Z");
    const [row] = buildAccessReviewRows(
      facts({
        attestations: [
          {
            membershipId: "m1",
            kind: "accredited",
            signedAt: signed,
            expiresAt: new Date("2027-03-01T00:00:00.000Z"),
          },
        ],
        gates: [accreditedGate(undefined, { kind: "workspace" })],
      }),
      NOW,
    );
    expect(row?.accreditation).toMatchObject({ gateMaxAgeDays: 365, diverges: false });
    expect(row?.flags).toEqual([]);
  });

  it("diverges when a configured window disagrees with expires_at, and lapses on the stricter", () => {
    const signed = ago(100);
    const [row] = buildAccessReviewRows(
      facts({
        members: [member()],
        groups: new Map([["m1", [{ id: "g1", name: "Angels" }]]]),
        attestations: [
          { membershipId: "m1", kind: "accredited", signedAt: signed, expiresAt: ahead(265) },
        ],
        gates: [
          accreditedGate(365, { kind: "workspace" }),
          accreditedGate(90, { kind: "group", id: "g1" }),
          // Names another member: must not bind this one.
          accreditedGate(30, { kind: "membership", id: "someone-else" }),
        ],
      }),
      NOW,
    );
    expect(row?.accreditation).toMatchObject({
      gateMaxAgeDays: 90,
      gateLapsesAt: new Date(signed.getTime() + 90 * DAY).toISOString(),
      diverges: true,
    });
    expect(row?.flags).toEqual(["accreditation_lapsed", "accreditation_diverges"]);
  });

  it("no applicable gate → no window, no divergence", () => {
    const [row] = buildAccessReviewRows(
      facts({
        attestations: [
          { membershipId: "m1", kind: "accredited", signedAt: ago(10), expiresAt: ahead(355) },
        ],
      }),
      NOW,
    );
    expect(row?.accreditation).toMatchObject({ gateMaxAgeDays: null, diverges: false });
  });

  it("reports attestation-bound pending gates only, and the newest NDA", () => {
    const [row] = buildAccessReviewRows(
      facts({
        attestations: [
          { membershipId: "m1", kind: "nda:v2", signedAt: ago(5), expiresAt: null },
          { membershipId: "m1", kind: "nda:v1", signedAt: ago(50), expiresAt: null },
        ],
        pending: [
          {
            membershipId: "m1",
            gates: [
              { kind: "nda", detail: { stamp: "nda:v3" }, source: "workspace" },
              { kind: "min_auth_level", detail: { level: 2 }, source: "workspace" },
            ],
          },
          { membershipId: "m1", gates: [{ kind: "nda", detail: { stamp: "nda:v3" } }] },
        ],
      }),
      NOW,
    );
    expect(row?.nda).toEqual({ kind: "nda:v2", signedAt: ago(5).toISOString() });
    expect(row?.pendingGates).toEqual(["nda:v3"]);
    expect(row?.flags).toEqual(["pending_gates"]);
  });

  it("hides erased names and pseudonymised emails", () => {
    const [row] = buildAccessReviewRows(
      facts({
        members: [
          member({ name: "", email: "erased+0123456789abcdef@erased.invalid", userErased: true }),
        ],
      }),
      NOW,
    );
    expect(row?.name).toBeNull();
    expect(row?.email).toBeNull();
  });
});

describe("summary and digest", () => {
  it("counts flags and flagged members", () => {
    const rows = buildAccessReviewRows(
      facts({
        members: [
          member({ membershipId: "a", lastSeenAt: null, expiresAt: ahead(1) }),
          member({ membershipId: "b", userId: "u2" }),
        ],
      }),
      NOW,
    );
    expect(summarize(rows, false)).toEqual({
      members: 2,
      flagged: 1,
      byFlag: { never_active: 1, expiring: 1 },
      truncated: false,
    });
  });

  it("canonical JSON sorts keys at every depth, so key order cannot change the digest", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    const rows = buildAccessReviewRows(facts(), NOW);
    const summary = summarize(rows, false);
    const a = reportSha256({ generatedAt: NOW.toISOString(), members: rows, summary });
    const b = reportSha256({
      summary: { ...summary },
      members: rows.map((r) => ({ ...r })),
      generatedAt: NOW.toISOString(),
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(b).toBe(a);
  });

  it("the evidence records activity to the day, so session touches do not move the digest", () => {
    const at = (lastSeenAt: Date) => {
      const rows = buildAccessReviewRows(facts({ members: [member({ lastSeenAt })] }), NOW);
      return { generatedAt: NOW.toISOString(), members: rows, summary: summarize(rows, false) };
    };
    const morning = at(new Date("2026-09-22T08:00:00.000Z"));
    const noon = at(new Date("2026-09-22T11:59:00.000Z"));
    const yesterday = at(new Date("2026-09-21T23:59:00.000Z"));
    // The on-screen report keeps the full timestamp …
    expect(morning.members[0]?.lastActiveAt).toBe("2026-09-22T08:00:00.000Z");
    // … the evidence keeps the day.
    expect(accessReviewEvidence(morning).members[0]?.lastActiveAt).toBe("2026-09-22T00:00:00.000Z");
    expect(reportSha256(noon)).toBe(reportSha256(morning));
    expect(reportSha256(yesterday)).not.toBe(reportSha256(morning));
    // The review history around the report is not part of it.
    expect(Object.keys(accessReviewEvidence(morning)).sort()).toEqual([
      "generatedAt",
      "members",
      "schemaVersion",
      "summary",
    ]);
  });
});

describe("overdue reminder (E3.2)", () => {
  it("due = last review + 90 days; never reviewed → workspace creation + 90 days", () => {
    expect(ACCESS_REVIEW_INTERVAL_DAYS).toBe(90);
    const created = new Date("2026-01-10T09:30:00.000Z");
    const reviewed = new Date("2026-05-01T12:00:00.000Z");
    expect(accessReviewDueAt(reviewed, created).toISOString()).toBe("2026-07-30T12:00:00.000Z");
    expect(accessReviewDueAt(null, created).toISOString()).toBe("2026-04-10T09:30:00.000Z");
    // A completed review always wins over the creation date, however old the workspace.
    expect(accessReviewDueAt(ago(89), ago(400)).getTime()).toBeGreaterThan(NOW.getTime());
    expect(accessReviewDueAt(ago(91), ago(1)).getTime()).toBeLessThan(NOW.getTime());
  });

  it("the ISO week starts Monday 00:00 UTC and carries the Thursday's year", () => {
    // NOW is Tuesday 2026-09-22.
    expect(isoWeekStart(NOW).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(isoWeekStart(new Date("2026-09-21T00:00:00.000Z")).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
    expect(isoWeekStart(new Date("2026-09-27T23:59:59.999Z")).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
    expect(isoWeekKey(NOW)).toBe("2026-W39");
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01");
  });

  it("one workspace's failure is logged and skipped; the rest of the run still happens", async () => {
    const workspaces = [
      { id: "11111111-1111-4111-8111-111111111111", createdAt: ago(400) },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: ago(400) },
      { id: "33333333-3333-4333-8333-333333333333", createdAt: ago(400) },
    ];
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => workspaces,
    };
    const visited: string[] = [];
    const logs: [string, Readonly<Record<string, unknown>> | undefined][] = [];
    const deps = {
      db: {
        withHost: async (fn: (tx: unknown) => unknown) => fn(chain),
        // Stands in for the tenant transaction: the second workspace's throws (a broken row, a
        // lock timeout); the others answer as a reminded workspace would.
        withTenant: async (ctx: { workspaceId: string }) => {
          visited.push(ctx.workspaceId);
          if (ctx.workspaceId === workspaces[1]?.id) throw new Error("boom");
          return "reminded";
        },
      },
      audit: {},
      log: (event: string, fields?: Readonly<Record<string, unknown>>) => {
        logs.push([event, fields]);
      },
    };
    const result = await remindOverdueAccessReviews(deps as never, NOW);
    expect(visited).toEqual(workspaces.map((w) => w.id));
    expect(result).toEqual({ workspaces: 3, overdue: 2, reminded: 2, failed: 1, notOnPlan: 0 });
    expect(logs).toContainEqual([
      "auth.access_review_overdue_failed",
      { workspaceId: workspaces[1]?.id, error: "boom" },
    ]);
  });

  it("counts workspaces skipped for their plan (A-3) apart from overdue ones", async () => {
    const workspaces = [
      { id: "11111111-1111-4111-8111-111111111111", createdAt: ago(400) },
      { id: "22222222-2222-4222-8222-222222222222", createdAt: ago(400) },
    ];
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => workspaces,
    };
    const deps = {
      db: {
        withHost: async (fn: (tx: unknown) => unknown) => fn(chain),
        // The real tenant transaction asks the plan first; this stands in for its answer.
        withTenant: async (ctx: { workspaceId: string }) =>
          ctx.workspaceId === workspaces[0]?.id ? "not_on_plan" : "reminded",
      },
      audit: {},
    };
    const result = await remindOverdueAccessReviews(deps as never, NOW);
    expect(result).toEqual({ workspaces: 2, overdue: 1, reminded: 1, failed: 0, notOnPlan: 1 });
  });

  it("registers one daily job", () => {
    const jobs = createAccessReviewJobs({ deps: {} as never });
    expect(jobs.map((j) => [j.name, j.cron])).toEqual([["access-review.overdue", "41 6 * * *"]]);
  });
});
