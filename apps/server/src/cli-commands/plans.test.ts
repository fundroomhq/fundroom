import type { AuditRecorder } from "@fundroom/audit";
import { PlanError } from "@fundroom/control-plane";
import type { Database } from "@fundroom/db";
import { describe, expect, it, vi } from "vitest";
import {
  keepLists,
  limitsText,
  parseUpsert,
  plansCommand,
  unknownModuleSentence,
  withLists,
} from "./plans.js";

/*
 * `fundroom plan upsert` flag parsing (E3.10): the API's own schemas decide what a plan id and a
 * limits object are, and only the flags given end up in the patch (an existing plan keeps the rest).
 */
describe("parseUpsert", () => {
  it("collects repeated --metered-price flags; --no-metered-price clears; duplicates refused", () => {
    expect(
      parseUpsert(["pro", "--metered-price", "price_seats", "--metered-price", "price_gb"]),
    ).toEqual({
      ok: true,
      value: { id: "pro", patch: { billingMeteredPriceRefs: ["price_seats", "price_gb"] } },
    });
    expect(parseUpsert(["pro", "--no-metered-price"])).toEqual({
      ok: true,
      value: { id: "pro", patch: { billingMeteredPriceRefs: [] } },
    });
    expect(parseUpsert(["pro", "--metered-price", "p", "--metered-price", "p"]).ok).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ["--metered-price", `p${i}`]).flat();
    expect(parseUpsert(["pro", ...eleven]).ok).toBe(false);
  });

  it("builds a patch from the flags given, and only those", () => {
    const r = parseUpsert([
      "starter",
      "--name",
      " Starter ",
      "--limits",
      '{"staffSeats":3,"storageBytes":1000}',
      "--price",
      "price_123",
      "--trial-days",
      "14",
      "--public",
    ]);
    expect(r).toEqual({
      ok: true,
      value: {
        id: "starter",
        patch: {
          name: "Starter",
          limits: { staffSeats: 3, storageBytes: 1000 },
          billingPriceRef: "price_123",
          trialDays: 14,
          public: true,
        },
        // Decision 10: lists `--limits` does not mention are kept from the current plan.
        keep: ["modules", "features"],
      },
    });
    expect(parseUpsert(["starter", "--no-public", "--no-price"])).toEqual({
      ok: true,
      value: { id: "starter", patch: { public: false, billingPriceRef: null } },
    });
  });

  it("refuses a bad id, bad limits JSON, unknown or invalid limits and an out-of-range trial", () => {
    expect(parseUpsert(["Starter!"]).ok).toBe(false);
    expect(parseUpsert([]).ok).toBe(false);
    expect(parseUpsert(["p", "--limits", "{nope"]).ok).toBe(false);
    expect(parseUpsert(["p", "--limits", '{"seats":3}']).ok).toBe(false);
    expect(parseUpsert(["p", "--limits", '{"staffSeats":0}']).ok).toBe(false);
    expect(parseUpsert(["p", "--trial-days", "91"]).ok).toBe(false);
    expect(parseUpsert(["p", "--name", "   "]).ok).toBe(false);
  });

  describe("--modules / --features (A-3, ADR-0063)", () => {
    it("without --limits: carries the lists to apply to the plan's current limits", () => {
      expect(
        parseUpsert(["growth", "--modules", "updates,data-room", "--features", "none"]),
      ).toEqual({
        ok: true,
        value: {
          id: "growth",
          patch: {},
          lists: { modules: ["data-room", "updates"], features: [] },
        },
      });
      expect(parseUpsert(["growth", "--features", "all"])).toEqual({
        ok: true,
        value: { id: "growth", patch: {}, lists: { features: "all" } },
      });
      // No list flag: no `lists` at all (an existing plan's limits are not touched).
      const plain = parseUpsert(["growth", "--trial-days", "7"]);
      expect(plain.ok && "lists" in plain.value).toBe(false);
    });

    it("with --limits: a flag overrides the same key; `all` removes it; other keys stay", () => {
      expect(
        parseUpsert([
          "growth",
          "--limits",
          '{"staffSeats":5,"modules":["crm"],"features":["sso"]}',
          "--modules",
          "metrics, crm",
        ]),
      ).toEqual({
        ok: true,
        value: {
          id: "growth",
          patch: { limits: { staffSeats: 5, modules: ["crm", "metrics"], features: ["sso"] } },
        },
      });
      const all = parseUpsert([
        "growth",
        "--limits",
        '{"staffSeats":5,"modules":["crm"]}',
        "--modules",
        "all",
      ]);
      expect(all).toEqual({
        ok: true,
        value: { id: "growth", patch: { limits: { staffSeats: 5 } }, keep: ["features"] },
      });
      // `--limits` alone may carry the lists (the site's generated script does).
      expect(parseUpsert(["growth", "--limits", '{"features":["sso","ai"],"modules":[]}'])).toEqual(
        {
          ok: true,
          value: { id: "growth", patch: { limits: { features: ["sso", "ai"], modules: [] } } },
        },
      );
    });

    it("--limits without a list key keeps that list from the current plan (decision 10)", () => {
      const seats = parseUpsert(["growth", "--limits", '{"staffSeats":10}']);
      expect(seats).toEqual({
        ok: true,
        value: {
          id: "growth",
          patch: { limits: { staffSeats: 10 } },
          keep: ["modules", "features"],
        },
      });
      // A flag decides its own key (here: none), so only the other list is kept.
      expect(
        parseUpsert(["growth", "--limits", '{"staffSeats":10}', "--features", "none"]),
      ).toEqual({
        ok: true,
        value: {
          id: "growth",
          patch: { limits: { staffSeats: 10, features: [] } },
          keep: ["modules"],
        },
      });
      const current = { staffSeats: 3, modules: ["crm"], features: ["sso" as const] };
      expect(keepLists({ staffSeats: 10 }, current, ["modules", "features"])).toEqual({
        staffSeats: 10,
        modules: ["crm"],
        features: ["sso"],
      });
      // Nothing to keep when the current plan has no list (absent = all stays absent).
      expect(keepLists({ staffSeats: 10 }, { staffSeats: 3 }, ["modules", "features"])).toEqual({
        staffSeats: 10,
      });
      expect(keepLists({ staffSeats: 10, features: [] }, current, ["modules"])).toEqual({
        staffSeats: 10,
        modules: ["crm"],
        features: [],
      });
    });

    it("refuses unknown features (naming the valid ids), duplicates, empty ids and a missing value", () => {
      const unknown = parseUpsert(["p", "--features", "sso,telepathy"]);
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) {
        expect(unknown.error).toContain("telepathy is not a feature");
        expect(unknown.error).toContain("qa, api_keys, webhooks");
      }
      expect(parseUpsert(["p", "--modules", "crm,crm"]).ok).toBe(false);
      expect(parseUpsert(["p", "--modules", "crm,,metrics"]).ok).toBe(false);
      expect(parseUpsert(["p", "--modules"]).ok).toBe(false);
      expect(parseUpsert(["p", "--modules", "--public"]).ok).toBe(false);
      expect(parseUpsert(["p", "--modules", "Data Room"]).ok).toBe(false);
      expect(parseUpsert(["p", "--limits", '{"features":["telepathy"]}']).ok).toBe(false);
      expect(parseUpsert(["p", "--limits", '{"modules":["crm","crm"]}']).ok).toBe(false);
    });

    it("withLists replaces only the keys named and never drops the numbers", () => {
      const current = {
        staffSeats: 3,
        storageBytes: 10,
        modules: ["crm"],
        features: ["sso" as const],
      };
      expect(withLists(current, { features: ["ai"] })).toEqual({
        staffSeats: 3,
        storageBytes: 10,
        modules: ["crm"],
        features: ["ai"],
      });
      expect(withLists(current, { modules: "all", features: [] })).toEqual({
        staffSeats: 3,
        storageBytes: 10,
        features: [],
      });
      expect(withLists(current, {})).toEqual(current);
    });

    it("prints the lists unambiguously and names the valid modules for an unknown one", () => {
      expect(limitsText({})).toBe("unlimited modules=all features=all");
      expect(limitsText({ staffSeats: 3, modules: ["crm", "data-room"], features: [] })).toBe(
        "staffSeats=3 modules=[crm data-room] features=[]",
      );
      const sentence = unknownModuleSentence("content");
      expect(sentence).toContain("content is not an optional module of this build");
      expect(sentence).toContain("data-room");
      expect(sentence).not.toContain("content,");
    });
  });

  describe("plansCommand refusals", () => {
    const run = async (error: unknown) => {
      const db = { withHost: async () => Promise.reject(error) } as unknown as Database;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await plansCommand(["upsert", "growth", "--trial-days", "7"], {
          db,
          audit: {} as AuditRecorder,
          osUser: "tester",
          out: () => {},
        });
        return { code, err: err.mock.calls.map((c) => c.join(" ")).join("\n") };
      } finally {
        err.mockRestore();
      }
    };

    it("a concurrent change is a sentence and exit 1, never a stack trace", async () => {
      const r = await run(new PlanError("version_conflict", "plan growth is at version 4"));
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "plan growth changed while this command ran (someone else saved it first); nothing was written — run the command again",
      );
    });

    it("every other plan refusal is a sentence too; other errors still throw", async () => {
      expect((await run(new PlanError("not_found", "no plan"))).code).toBe(1);
      expect((await run(new PlanError("exists", "exists"))).err).toContain("was created while");
      expect(
        (await run(new PlanError("unknown_module", "x", undefined, undefined, "x"))).code,
      ).toBe(2);
      await expect(run(new Error("db down"))).rejects.toThrow("db down");
    });
  });
});
