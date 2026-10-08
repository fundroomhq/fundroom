import { SanctionsProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createSanctionsJobs, SANCTIONS_REFRESH_CRON } from "./jobs.js";
import { type SanctionsService, type ScreenOutcome, UnscreenableNameError } from "./service.js";

/*
 * The job shells (E3.10): names, schedule, queue policies, and that a provider error surfaces as
 * a thrown error (so pg-boss retries) while bad job data is dropped.
 */
function jobsWith(outcome: ScreenOutcome) {
  const calls: unknown[] = [];
  const service: Pick<SanctionsService, "screenWorkspace" | "refresh" | "rescreenAll"> = {
    async screenWorkspace(input) {
      calls.push(["screen", input.workspaceId, input.reason]);
      return outcome;
    },
    async refresh() {
      calls.push(["refresh"]);
      return { listVersion: "v" };
    },
    async rescreenAll(input) {
      calls.push(["rescreen", input.listVersion]);
      return { enqueued: 0 };
    },
  };
  const jobs = createSanctionsJobs(service);
  const run = (name: string, data: Record<string, string | number>) => {
    const def = jobs.find((j) => j.name === name);
    if (def === undefined) throw new Error(name);
    return def.handler({ id: "1", name, data, signal: new AbortController().signal });
  };
  return { jobs, calls, run };
}

describe("createSanctionsJobs", () => {
  it("defines the three jobs with the refresh schedule and per-workspace dedupe", () => {
    const { jobs } = jobsWith({ outcome: "skipped", why: "disabled" });
    expect(jobs.map((j) => [j.name, j.cron ?? null, j.queue?.policy ?? "standard"])).toEqual([
      ["sanctions.screen", null, "short"],
      ["sanctions.refresh", SANCTIONS_REFRESH_CRON, "standard"],
      ["sanctions.rescreen", null, "singleton"],
    ]);
    expect(jobs[0]?.queue).toMatchObject({ retryBackoff: true });
  });

  it("throws on a provider error so the screen is retried", async () => {
    const error = new SanctionsProviderError("down");
    const { run } = jobsWith({
      outcome: "error",
      screeningId: null,
      listVersion: "ofac:unavailable",
      released: false,
      error,
    });
    await expect(run("sanctions.screen", { workspaceId: "w" })).rejects.toBe(error);
  });

  it("does not retry a name that has nothing to screen (the error row is the record)", async () => {
    const { run } = jobsWith({
      outcome: "error",
      screeningId: "s1",
      listVersion: "ofac:unscreenable",
      released: false,
      error: new UnscreenableNameError(),
    });
    await expect(run("sanctions.screen", { workspaceId: "w" })).resolves.toBeUndefined();
  });

  it("completes on a result, passes the reason, and drops malformed data", async () => {
    const { run, calls } = jobsWith({
      outcome: "clear",
      screeningId: "s",
      listVersion: "v",
      released: true,
    });
    await run("sanctions.screen", { workspaceId: "w", reason: "rescreen" });
    await run("sanctions.screen", { workspaceId: "w", reason: "bogus" });
    await run("sanctions.screen", { workspaceId: 7 });
    await run("sanctions.rescreen", { listVersion: "v2" });
    await run("sanctions.rescreen", {});
    await run("sanctions.refresh", {});
    expect(calls).toEqual([
      ["screen", "w", "rescreen"],
      ["screen", "w", undefined],
      ["rescreen", "v2"],
      ["refresh"],
    ]);
  });
});
