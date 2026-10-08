import { describe, expect, it } from "vitest";
import {
  addDays,
  createUsageJobs,
  retentionCutoff,
  sumModuleUsage,
  USAGE_RETENTION_DAYS,
  USAGE_ROLLUP_JOB,
  USAGE_ROLLUP_TODAY_JOB,
  utcDay,
} from "./usage.js";

/*
 * The usage rollup's arithmetic (E3.10): UTC day boundaries, the 400-day retention cutoff, the
 * sum of the modules' answers (junk and negatives count nothing), and the two schedules.
 */
describe("day arithmetic", () => {
  it("names the UTC day, whatever the local offset of the instant", () => {
    expect(utcDay(new Date("2026-09-27T23:59:59.999Z"))).toBe("2026-09-27");
    expect(utcDay(new Date("2026-09-28T01:30:00+02:00"))).toBe("2026-09-27");
  });

  it("moves across month, year and leap-day boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => addDays("27/09/2026", 1)).toThrow(RangeError);
  });

  it("keeps exactly 400 days: the cutoff is the first day kept", () => {
    expect(USAGE_RETENTION_DAYS).toBe(400);
    const cutoff = retentionCutoff("2026-09-27");
    expect(cutoff).toBe("2025-08-23");
    expect(addDays(cutoff, USAGE_RETENTION_DAYS)).toBe("2026-09-27");
  });
});

describe("sumModuleUsage", () => {
  it("sums what the modules report and ignores absent fields", () => {
    expect(
      sumModuleUsage([
        { storageBytes: 1_000 },
        { docsViewed: 7 },
        { storageBytes: 24, docsViewed: 3 },
      ]),
    ).toEqual({ storageBytes: 1_024, docsViewed: 10 });
    expect(sumModuleUsage([])).toEqual({ storageBytes: 0, docsViewed: 0 });
  });

  it("counts junk, negatives and fractions as nothing / floors them", () => {
    expect(
      sumModuleUsage([
        { storageBytes: -5, docsViewed: Number.NaN },
        { storageBytes: 10.9, docsViewed: Number.POSITIVE_INFINITY },
        { storageBytes: "7" as unknown as number },
      ]),
    ).toEqual({ storageBytes: 10, docsViewed: 0 });
  });

  it("clamps to the columns' ranges", () => {
    const big = sumModuleUsage([
      { storageBytes: Number.MAX_SAFE_INTEGER, docsViewed: 2_000_000_000 },
      { storageBytes: Number.MAX_SAFE_INTEGER, docsViewed: 2_000_000_000 },
    ]);
    expect(big.storageBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(big.docsViewed).toBe(2_147_483_647);
  });
});

describe("createUsageJobs", () => {
  it("schedules yesterday daily at 00:15 and today hourly at :05, both singleton", () => {
    const jobs = createUsageJobs({ db: {} as never, modules: () => [] });
    expect(jobs.map((j) => [j.name, j.cron, j.queue?.policy])).toEqual([
      [USAGE_ROLLUP_JOB, "15 0 * * *", "singleton"],
      [USAGE_ROLLUP_TODAY_JOB, "5 * * * *", "singleton"],
    ]);
  });
});
