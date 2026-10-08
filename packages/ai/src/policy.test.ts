import { AiSettingsSchema } from "@fundroom/domain";
import { describe, expect, it } from "vitest";
import {
  acknowledged,
  aiProviderKey,
  effectiveAiFeatures,
  effectiveBudget,
  msUntilNextMonth,
  parseModelJson,
  Semaphore,
  sanitizeJson,
  sanitizeText,
  usageMonth,
} from "./policy.js";
import { createFakeModel } from "./testing/fake-model.js";

const info = createFakeModel().info;
const KEY = aiProviderKey(info);
const ack = {
  providerKey: KEY,
  hosting: "self_hosted" as const,
  at: "2026-09-30T00:00:00.000Z",
  byMembershipId: "01920000-0000-7000-8000-000000000001",
};
const on = AiSettingsSchema.parse({
  enabled: true,
  features: { updateDraft: true, qaAnswer: false },
  acknowledgement: ack,
});

describe("effectiveAiFeatures", () => {
  it("is off by default and when no model is configured", () => {
    expect(effectiveAiFeatures(AiSettingsSchema.parse({}), info)).toEqual({
      updateDraft: false,
      qaAnswer: false,
    });
    expect(effectiveAiFeatures(on, null)).toEqual({ updateDraft: false, qaAnswer: false });
  });

  it("needs enabled, the feature switch and an acknowledgement of THIS provider", () => {
    expect(effectiveAiFeatures(on, info)).toEqual({ updateDraft: true, qaAnswer: false });
    expect(effectiveAiFeatures({ ...on, enabled: false }, info).updateDraft).toBe(false);
    expect(effectiveAiFeatures({ ...on, acknowledgement: null }, info).updateDraft).toBe(false);
  });

  it("turns off when any part of the provider identity changes", () => {
    for (const change of [
      { label: "Other" },
      { model: "bigger" },
      { hosting: "third_party" as const },
    ]) {
      const other = createFakeModel({ info: change }).info;
      expect(acknowledged(on, other), JSON.stringify(change)).toBe(false);
      expect(effectiveAiFeatures(on, other).updateDraft).toBe(false);
    }
  });
});

describe("budget and months", () => {
  it("lets a workspace lower the operator cap, never raise it", () => {
    expect(effectiveBudget(on, 5000)).toBe(5000);
    expect(effectiveBudget({ ...on, monthlyTokenBudget: 2000 }, 5000)).toBe(2000);
    expect(effectiveBudget({ ...on, monthlyTokenBudget: 9000 }, 5000)).toBe(5000);
  });

  it("keys usage by UTC month and waits until the next one", () => {
    const at = new Date("2026-12-31T23:59:00.000Z");
    expect(usageMonth(at)).toBe("2026-12-01");
    expect(msUntilNextMonth(at)).toBe(60_000);
  });
});

describe("parseModelJson", () => {
  it("parses plain JSON, fenced JSON, think blocks and surrounding prose", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, json: { a: 1 } });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ ok: true, json: { a: 1 } });
    expect(parseModelJson('<think>{"no":1}</think>\n{"a":2}')).toEqual({
      ok: true,
      json: { a: 2 },
    });
    expect(parseModelJson('Here you go: {"a":3} hope it helps')).toEqual({
      ok: true,
      json: { a: 3 },
    });
  });

  it("refuses non-JSON, scalars and an unterminated think block", () => {
    expect(parseModelJson("sorry").ok).toBe(false);
    expect(parseModelJson("42").ok).toBe(false);
    expect(parseModelJson('<think>{"a":1}').ok).toBe(false);
  });
});

describe("Semaphore", () => {
  it("holds at most `size` and hands slots over in order", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const order: number[] = [];
    const p2 = s.acquire().then((r) => {
      order.push(2);
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    r1();
    const r2 = await p2;
    expect(order).toEqual([2]);
    expect(s.inUse).toBe(1);
    r2();
    r2(); // idempotent
    expect(s.inUse).toBe(0);
  });

  it("stops waiting when the signal aborts", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    ac.abort(new Error("expired"));
    await expect(p).rejects.toThrow("expired");
    r1();
    expect(s.inUse).toBe(0);
  });
});

describe("fix round 1", () => {
  it("R1-M4: the provider key binds location and jurisdiction, and stays within 400 chars", () => {
    const base = createFakeModel().info;
    expect(aiProviderKey(base)).toBe('["fake","self_hosted","Fake model","fake",null,null]');
    expect(aiProviderKey({ ...base, label: "A|B", model: "C" })).not.toBe(
      aiProviderKey({ ...base, label: "A", model: "B|C" }),
    );
    expect(aiProviderKey({ ...base, jurisdiction: "eu" })).not.toBe(
      aiProviderKey({ ...base, jurisdiction: "us" }),
    );
    expect(aiProviderKey({ ...base, location: "Frankfurt" })).not.toBe(aiProviderKey(base));
    const long = {
      ...base,
      label: "L".repeat(120),
      model: "M".repeat(200),
      location: "X".repeat(120),
    };
    const key = aiProviderKey(long);
    expect(key.length).toBeLessThanOrEqual(400);
    expect(key).toMatch(/^fake\|self_hosted\|sha256:[0-9a-f]{64}$/u);
    expect(aiProviderKey({ ...long, location: "Y".repeat(120) })).not.toBe(key);
  });

  it("R1-H2: sanitizeJson drops lone surrogates, NUL and noncharacters everywhere, keeps pairs", () => {
    const dirty = {
      "k\u0000ey": ["a\uD800b", { c: "\uDFFFd￾" }],
      ok: "😀",
      n: Number.NaN,
      u: undefined,
    };
    expect(sanitizeJson(dirty)).toEqual({ key: ["ab", { c: "d" }], ok: "😀", n: null });
    expect(sanitizeText("x😀y\uD83D")).toBe("x😀y");
  });
});
