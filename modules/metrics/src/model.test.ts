import { describe, expect, it } from "vitest";
import {
  audienceAdmits,
  DEFAULT_AUDIENCE,
  METRIC_KEY_RE,
  type MetricAudience,
  MetricAudienceSchema,
  type MetricReader,
  parseAudience,
} from "./model.js";

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";

const staff: MetricReader = { kind: "staff", groupIds: [] };
const investor = (...groupIds: string[]): MetricReader => ({ kind: "external", groupIds });

describe("METRIC_KEY_RE", () => {
  it("matches the definition_key_format CHECK", () => {
    for (const ok of ["a", "arr", "net_burn", "m1", `a${"b".repeat(62)}`]) {
      expect({ key: ok, ok: METRIC_KEY_RE.test(ok) }).toEqual({ key: ok, ok: true });
    }
    for (const bad of ["", "A", "1a", "_a", "net-burn", "net burn", `a${"b".repeat(63)}`]) {
      expect({ key: bad, ok: METRIC_KEY_RE.test(bad) }).toEqual({ key: bad, ok: false });
    }
  });
});

describe("parseAudience", () => {
  it("reads the three arms", () => {
    expect(parseAudience({ kind: "staff_only" })).toEqual({ kind: "staff_only" });
    expect(parseAudience({ kind: "all" })).toEqual({ kind: "all" });
    expect(parseAudience({ kind: "groups", groupIds: [GROUP_A] })).toEqual({
      kind: "groups",
      groupIds: [GROUP_A],
    });
  });

  it("never widens: anything it cannot read closes to staff_only", () => {
    /*
     * The TypeScript half of `metrics.audience_admits_current`'s `ELSE false`. Every one of
     * these is a row that could exist — hand-edited jsonb, a shape a later release writes, a
     * body that got past a route — and not one of them may publish a number.
     */
    const garbage: unknown[] = [
      undefined,
      null,
      {},
      "all",
      42,
      [],
      { kind: "everyone" },
      { kind: "all", groupIds: [GROUP_A] },
      { kind: "groups" },
      { kind: "groups", groupIds: [] },
      { kind: "groups", groupIds: ["not-a-uuid"] },
      { kind: "groups", groupIds: Array.from({ length: 51 }, () => GROUP_A) },
      { kind: "public" },
      { kind: null },
    ];
    for (const raw of garbage) {
      expect({ raw, parsed: parseAudience(raw) }).toEqual({ raw, parsed: DEFAULT_AUDIENCE });
    }
  });

  it("never throws", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => parseAudience(circular)).not.toThrow();
  });

  it("defaults closed, unlike updates, because a definition outlives the decision to publish", () => {
    expect(DEFAULT_AUDIENCE).toEqual({ kind: "staff_only" });
    expect(MetricAudienceSchema.safeParse(DEFAULT_AUDIENCE).success).toBe(true);
  });
});

describe("audienceAdmits", () => {
  const arms: MetricAudience[] = [
    { kind: "staff_only" },
    { kind: "all" },
    { kind: "groups", groupIds: [GROUP_A] },
  ];

  it("admits staff on every arm: the admin grid badges the audience rather than hiding rows", () => {
    for (const audience of arms) {
      expect({ audience, admits: audienceAdmits(audience, staff) }).toEqual({
        audience,
        admits: true,
      });
    }
  });

  it("refuses every external reader on staff_only", () => {
    expect(audienceAdmits({ kind: "staff_only" }, investor())).toBe(false);
    expect(audienceAdmits({ kind: "staff_only" }, investor(GROUP_A, GROUP_B))).toBe(false);
  });

  it("admits every external reader on all", () => {
    expect(audienceAdmits({ kind: "all" }, investor())).toBe(true);
    expect(audienceAdmits({ kind: "all" }, investor(GROUP_B))).toBe(true);
  });

  it("admits a groups reader only on an overlap", () => {
    const audience: MetricAudience = { kind: "groups", groupIds: [GROUP_A] };
    expect(audienceAdmits(audience, investor(GROUP_A))).toBe(true);
    expect(audienceAdmits(audience, investor(GROUP_B, GROUP_A))).toBe(true);
    expect(audienceAdmits(audience, investor(GROUP_B))).toBe(false);
    expect(audienceAdmits(audience, investor())).toBe(false);
  });

  it("admits a delegate only with scope `all` (F3: metrics are neither data room nor updates)", () => {
    const all: MetricAudience = { kind: "all" };
    const groups: MetricAudience = { kind: "groups", groupIds: [GROUP_A] };
    const as = (delegateScope: string) => ({ ...investor(GROUP_A), delegateScope });
    expect(audienceAdmits(all, as("all"))).toBe(true);
    expect(audienceAdmits(groups, as("all"))).toBe(true);
    for (const scope of ["data_room", "updates"]) {
      expect(audienceAdmits(all, as(scope))).toBe(false);
      expect(audienceAdmits(groups, as(scope))).toBe(false);
    }
  });
});
