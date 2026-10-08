import { ApiError } from "@fundroom/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { apiErrorHandler } from "./errors.js";

describe("apiErrorHandler logging", () => {
  async function logged(error: Error) {
    const lines: [string, Record<string, unknown>][] = [];
    const app = new Hono();
    app.onError(apiErrorHandler((event, fields) => lines.push([event, fields ?? {}])));
    app.get("/x", () => {
      throw error;
    });
    const res = await app.request("/x");
    return { status: res.status, lines };
  }

  it("logs a real 5xx at error level with its stack", async () => {
    const r = await logged(new Error("boom"));
    expect(r.status).toBe(500);
    expect(r.lines.map(([e, f]) => [e, f["level"]])).toEqual([["http.error", "error"]]);
  });

  it("answers forensic_busy (retryable load shedding) like a 429: no error log", async () => {
    const r = await logged(new ApiError("forensic_busy", "busy"));
    expect(r.status).toBe(503);
    expect(r.lines).toEqual([]);
    const limited = await logged(new ApiError("rate_limited", "slow down"));
    expect(limited.lines).toEqual([]);
  });
});
