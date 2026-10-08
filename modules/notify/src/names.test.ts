import { describe, expect, it } from "vitest";
import { NOTIFY_MAX_ATTEMPTS, retryDelayMs } from "./names.js";
import { errorCode } from "./service/notify.js";

describe("instant email retries", () => {
  it("back off exponentially from two minutes, capped at six hours", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([120_000, 240_000, 480_000, 960_000]);
    expect(retryDelayMs(20)).toBe(6 * 3_600_000);
    expect(retryDelayMs(0)).toBe(120_000);
  });

  it("are bounded", () => {
    expect(NOTIFY_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(NOTIFY_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it("record an error code, never the provider's text", () => {
    const e = Object.assign(new Error("550 5.1.1 <jane@example.com> unknown"), {
      name: "MailerError",
      code: "rejected",
    });
    expect(errorCode(e)).toBe("rejected");
    expect(errorCode(new Error("jane@example.com timed out"))).toBe("Error");
    expect(errorCode({ code: "not a code: jane@example.com" })).toBe("error");
    expect(errorCode(undefined)).toBe("error");
  });
});
