import { describe, expect, it } from "vitest";
import { createCryptoJobs } from "./envelope.js";

describe("createCryptoJobs", () => {
  it("defines the daily rewrap job", () => {
    const jobs = createCryptoJobs({
      db: {} as never,
      envelope: {} as never,
    });
    expect(jobs.map((j) => [j.name, j.cron])).toEqual([["crypto.rewrap", "20 3 * * *"]]);
  });
});
