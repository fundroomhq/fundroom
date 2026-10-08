import type { JobDefinition, JobQueuePort } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_RE } from "./idempotency.js";
import { registerJobs } from "./jobs.js";

function fakeQueue() {
  const calls: string[] = [];
  const queue = {
    calls,
    ensureQueue: async (name: string) => {
      calls.push(`ensure:${name}`);
    },
    work: async (name: string) => {
      calls.push(`work:${name}`);
    },
    schedule: async (name: string, cron: string) => {
      calls.push(`schedule:${name}:${cron}`);
    },
  } as unknown as JobQueuePort & { calls: string[] };
  return queue;
}

const defs: JobDefinition[] = [
  { name: "audit.checkpoint", cron: "10 2 * * *", handler: async () => {} },
  { name: "updates.send", handler: async () => {} },
];

describe("registerJobs", () => {
  it("ensures queues everywhere, attaches workers only on worker nodes, installs crons", async () => {
    const api = fakeQueue();
    await registerJobs({ queue: api, definitions: defs, worker: false });
    expect(api.calls).toEqual([
      "ensure:audit.checkpoint",
      "schedule:audit.checkpoint:10 2 * * *",
      "ensure:updates.send",
    ]);
    const worker = fakeQueue();
    await registerJobs({ queue: worker, definitions: defs, worker: true });
    expect(worker.calls).toEqual([
      "ensure:audit.checkpoint",
      "work:audit.checkpoint",
      "schedule:audit.checkpoint:10 2 * * *",
      "ensure:updates.send",
      "work:updates.send",
    ]);
  });

  it("rejects malformed and duplicate names", async () => {
    await expect(
      registerJobs({
        queue: fakeQueue(),
        definitions: [{ name: "Bad", handler: async () => {} }],
        worker: true,
      }),
    ).rejects.toThrow(/must match/u);
    await expect(
      registerJobs({
        queue: fakeQueue(),
        definitions: [defs[1] as JobDefinition, defs[1] as JobDefinition],
        worker: true,
      }),
    ).rejects.toThrow(/defined twice/u);
  });
});

describe("idempotency key shape", () => {
  it("is <scope>:<id>", () => {
    expect(IDEMPOTENCY_KEY_RE.test("updates.send:01920000-0000-7000-8000-000000000001")).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("outbox:42:analytics.record-view")).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("no-colon")).toBe(false);
    expect(IDEMPOTENCY_KEY_RE.test("scope:has space")).toBe(false);
  });
});
