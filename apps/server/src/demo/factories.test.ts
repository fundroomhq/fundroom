import { describe, expect, it } from "vitest";
import { createRandom, DEMO_DOMAINS, demoPeople, isDemoDomain } from "./factories.js";

describe("demo factories", () => {
  it("is deterministic for a seed and distinct across seeds", () => {
    const a = demoPeople({ seed: 1, investors: 12 });
    const b = demoPeople({ seed: 1, investors: 12 });
    const c = demoPeople({ seed: 2, investors: 12 });
    expect(a).toEqual(b);
    expect(a.investors.map((i) => i.email)).not.toEqual(c.investors.map((i) => i.email));
    const r1 = createRandom(7);
    const r2 = createRandom(7);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it("only ever produces reserved demo domains (the lint rule from design/07 §7)", () => {
    for (const seed of [1, 2, 3, 42, 0x5eed]) {
      const people = demoPeople({ seed, investors: 50 });
      const emails = [
        people.owner.email,
        ...people.staff.map((s) => s.email),
        ...people.investors.map((i) => i.email),
      ];
      expect(new Set(emails).size).toBe(emails.length);
      for (const email of emails) expect(isDemoDomain(email), email).toBe(true);
    }
    expect(isDemoDomain("ada@gmail.com")).toBe(false);
    expect(isDemoDomain("ada@sub.example.com")).toBe(true);
    expect(() => demoPeople({ ownerEmail: "ceo@acme.com" })).toThrow(/reserved demo domain/u);
    expect(DEMO_DOMAINS).toContain("example.com");
  });

  it("spreads investors across tiers and marks every fourth as invited", () => {
    const { investors, staff } = demoPeople({ investors: 12 });
    expect(investors).toHaveLength(12);
    expect(staff.map((s) => s.role)).toEqual(["admin", "editor"]);
    expect(new Set(investors.map((i) => i.tier))).toEqual(
      new Set(["board", "lead", "fund", "angel"]),
    );
    expect(investors.filter((i) => i.invited)).toHaveLength(3);
    for (const i of investors) expect(i.firm === undefined).toBe(i.tier === "angel");
  });
});
