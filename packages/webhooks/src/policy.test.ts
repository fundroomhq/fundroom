import { EVENT_CATALOGUE } from "@fundroom/domain";
import type { JsonObject, JsonValue } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  nextRetryDelaySeconds,
  parseRetryAfter,
  projectWebhookData,
  redactUrl,
  requestHeaders,
  safeError,
  sanitizeExcerpt,
  storedPayload,
  urlDisplay,
  verdictOf,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_STRIPPED_DATA_FIELDS,
} from "./policy.js";
import { decodeDeliveryCursor, encodeDeliveryCursor } from "./service.js";
import { signPayload, verifyWebhook } from "./signature.js";
import { bodyOf, WEBHOOK_RETRY_DELAYS_SECONDS, WEBHOOK_USER_AGENT } from "./types.js";

describe("retry schedule", () => {
  it("walks 30s, 2m, 10m, 30m, 1h, 3h, 6h, 12h, 24h and then gives up", () => {
    const delays: number[] = [];
    for (let attempts = 1; ; attempts++) {
      const d = nextRetryDelaySeconds(attempts);
      if (d === undefined) break;
      delays.push(d);
    }
    expect(delays).toEqual([30, 120, 600, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(10);
    expect(nextRetryDelaySeconds(10)).toBeUndefined();
    expect(nextRetryDelaySeconds(0)).toBeUndefined();
    // ≈ 47 hours of retries in total.
    const total = WEBHOOK_RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0);
    expect(total / 3600).toBeGreaterThan(46);
    expect(total / 3600).toBeLessThan(48);
  });

  it("honours Retry-After as a floor, capped at an hour", () => {
    expect(nextRetryDelaySeconds(1, 5)).toBe(30);
    expect(nextRetryDelaySeconds(1, 300)).toBe(300);
    expect(nextRetryDelaySeconds(1, 7_200)).toBe(3_600);
    expect(nextRetryDelaySeconds(1, 999_999)).toBe(3_600);
    // A day-long scheduled wait is not shortened by a small Retry-After.
    expect(nextRetryDelaySeconds(9, 60)).toBe(86_400);
    // Exhausted stays exhausted whatever the receiver asks.
    expect(nextRetryDelaySeconds(10, 60)).toBeUndefined();
    expect(nextRetryDelaySeconds(1, Number.NaN)).toBe(30);
    expect(nextRetryDelaySeconds(1, -50)).toBe(30);
  });
});

describe("Retry-After parsing", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  it("reads delay-seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter(" 7 ", now)).toBe(7);
    expect(parseRetryAfter("Fri, 25 Sep 2026 12:10:00 GMT", now)).toBe(600);
    expect(parseRetryAfter("Fri, 25 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });
  it("ignores what it cannot read", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("verdicts", () => {
  it("2xx succeeds, 410 is gone, everything else fails", () => {
    expect(verdictOf(200)).toBe("succeeded");
    expect(verdictOf(204)).toBe("succeeded");
    expect(verdictOf(299)).toBe("succeeded");
    expect(verdictOf(410)).toBe("gone");
    for (const s of [301, 400, 404, 429, 500, 503]) expect(verdictOf(s)).toBe("failed");
  });
});

describe("response excerpt", () => {
  it("keeps printable text only, collapsed, at most 512 characters", () => {
    expect(sanitizeExcerpt("ok")).toBe("ok");
    expect(sanitizeExcerpt("line1\r\nline2\tx")).toBe("line1 line2 x");
    expect(sanitizeExcerpt("\u001b[31mred\u001b[0m")).toBe("[31mred [0m");
    expect(sanitizeExcerpt("a‮b​c⁦d﻿e")).toBe("a b c d e");
    expect(sanitizeExcerpt("\u0000\u0007")).toBeNull();
    expect(sanitizeExcerpt("")).toBeNull();
    expect(sanitizeExcerpt(null)).toBeNull();
    const long = sanitizeExcerpt("x".repeat(5_000));
    expect(long).toHaveLength(512);
  });

  it("never splits a surrogate pair at the cut", () => {
    const text = sanitizeExcerpt("😀".repeat(600)) ?? "";
    expect(Array.from(text)).toHaveLength(512);
    expect(text.endsWith("😀")).toBe(true);
  });
});

describe("safe errors", () => {
  it("never carries the URL, its path or its query", () => {
    const url = "https://hooks.example.com/catch/123/SECRETTOKEN?key=abc";
    const out = safeError(`request to ${url} failed at /catch/123/SECRETTOKEN and ?key=abc`, url);
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("key=abc");
    expect(out).toContain("[url]");
  });
  it("redacts without inventing text (an empty body stays empty)", () => {
    expect(redactUrl("", "https://h.example/p")).toBe("");
    expect(sanitizeExcerpt(redactUrl("", "https://h.example/p"))).toBeNull();
    expect(redactUrl("see /p?q=1 now", "https://h.example/p?q=1")).toBe("see [url][url] now");
  });
  it("is bounded and printable", () => {
    expect(Array.from(safeError("e\n".repeat(1_000)))).toHaveLength(300);
    expect(safeError("\u0000")).toBe("error");
  });
});

describe("display columns", () => {
  it("shows scheme + host and the last four characters", () => {
    expect(urlDisplay(new URL("https://hooks.example.com/catch/abcd1234"))).toEqual({
      urlHost: "https://hooks.example.com",
      urlHint: "1234",
    });
    expect(urlDisplay(new URL("http://127.0.0.1:8080/x")).urlHost).toBe("http://127.0.0.1:8080");
  });
});

describe("delivery cursor", () => {
  it("round-trips an id and refuses anything else", () => {
    const id = "01928f3a-0000-7000-8000-000000000001";
    expect(decodeDeliveryCursor(encodeDeliveryCursor(id))).toBe(id);
    expect(() => decodeDeliveryCursor("bm9wZQ")).toThrow(/cursor/);
  });
});

describe("the wire", () => {
  it("builds Standard Webhooks headers and a body a receiver verifies, under both secrets", async () => {
    const current = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const previous = "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD";
    const id = "01928f3a-0000-7000-8000-000000000002";
    const payload = storedPayload({
      topic: "update.published",
      createdAt: new Date("2026-09-25T12:00:00Z"),
      workspaceId: "01928f3a-0000-7000-8000-00000000000a",
      data: { postId: "01928f3a-0000-7000-8000-00000000000b" },
      schemaVersion: 1,
    });
    const body = JSON.stringify(bodyOf({ id, eventId: "4711", payload }));
    expect(JSON.parse(body).eventId).toBe("4711");
    expect(Object.keys(JSON.parse(body))).toEqual([
      "id",
      "eventId",
      "type",
      "timestamp",
      "workspaceId",
      "data",
      "schemaVersion",
    ]);
    const timestamp = 1_790_000_000;
    const signature = await signPayload({ id, timestamp, body, secrets: [current, previous] });
    const headers = requestHeaders({ id, timestamp, signature });
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBe(WEBHOOK_USER_AGENT);
    expect(headers["webhook-id"]).toBe(id);
    expect(headers["webhook-timestamp"]).toBe(String(timestamp));
    expect(signature.split(" ")).toHaveLength(2);
    for (const secret of [current, previous]) {
      const verified = await verifyWebhook({
        headers,
        body,
        secret,
        now: timestamp * 1000,
      });
      expect(verified.id).toBe(id);
    }
    await expect(
      verifyWebhook({
        headers,
        body: body.replace("update.published", "update.sent"),
        secret: current,
        now: timestamp * 1000,
      }),
    ).rejects.toThrow();
  });
});

/**
 * A sample value for a catalogue schema, duck-typed over zod (no zod import here): objects by
 * their `shape`, wrappers by `unwrap()`, arrays by `element`. Every key of every nested object
 * is present, so the projection sees every name the schema could ever send.
 */
function sampleOf(schema: unknown, depth = 0): JsonValue {
  if (depth > 8 || schema === null || typeof schema !== "object") return "x";
  const s = schema as {
    shape?: Record<string, unknown>;
    unwrap?: () => unknown;
    element?: unknown;
    options?: unknown[];
    def?: { innerType?: unknown; element?: unknown; options?: unknown[] };
  };
  if (s.shape !== undefined && typeof s.shape === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(s.shape)) out[k] = sampleOf(v, depth + 1);
    return out;
  }
  if (typeof s.unwrap === "function") return sampleOf(s.unwrap(), depth + 1);
  if (s.def?.innerType !== undefined) return sampleOf(s.def.innerType, depth + 1);
  const element = s.element ?? s.def?.element;
  if (element !== undefined) return [sampleOf(element, depth + 1)];
  const options = s.options ?? s.def?.options;
  if (Array.isArray(options)) {
    // A union: merge every object option's keys.
    const merged: JsonObject = {};
    for (const o of options) {
      const v = sampleOf(o, depth + 1);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) Object.assign(merged, v);
    }
    return Object.keys(merged).length > 0 ? merged : "x";
  }
  return "x";
}

function keysOf(value: JsonValue, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe("outbound projection", () => {
  it("no key naming a session reaches a body, for any topic in the catalogue", () => {
    let sawSession = 0;
    const sessionKeys = new Set<string>();
    for (const [topic, def] of Object.entries(EVENT_CATALOGUE)) {
      const sample = sampleOf(def.payload);
      expect(sample, topic).toBeTypeOf("object");
      const before = keysOf(sample);
      for (const k of before) if (/session|userid/iu.test(k)) sessionKeys.add(k);
      sawSession += before.filter((k) => /session/iu.test(k)).length;
      const projected = projectWebhookData(sample as JsonObject);
      const after = keysOf(projected);
      expect(
        after.filter((k) => /session|userid/iu.test(k)),
        topic,
      ).toEqual([]);
      // Everything else is kept.
      expect(after, topic).toEqual(before.filter((k) => !/session|userid/iu.test(k)));
    }
    // The walk really saw the keys it strips (document.viewed / update.viewed carry sessionId),
    // and the exported list (which the docs render) names exactly those.
    expect(sawSession).toBeGreaterThanOrEqual(2);
    expect([...sessionKeys].sort()).toEqual([...WEBHOOK_STRIPPED_DATA_FIELDS].sort());
  });

  it("strips nested and array-held session keys too", () => {
    expect(
      projectWebhookData({
        a: 1,
        sessionId: "s",
        nested: { viewSession: "v", keep: "k", list: [{ SESSION_KEY: 1, id: "i" }] },
      }),
    ).toEqual({ a: 1, nested: { keep: "k", list: [{ id: "i" }] } });
  });
});
