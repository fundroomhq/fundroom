import type { DeadLetterJob, DeadLetterQueue } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { jobsDlqCommand } from "./jobs-dlq.js";

const WS = "01920000-0000-7000-8000-00000000000a";
const ID = "01920000-0000-7000-8000-0000000000d1";

function fake(jobs: DeadLetterJob[]) {
  const calls: string[] = [];
  const deadLetters: DeadLetterQueue = {
    async list(o) {
      calls.push(`list:${o?.workspaceId ?? "*"}:${o?.limit}`);
      return jobs.filter((j) => !o?.workspaceId || j.data["workspaceId"] === o.workspaceId);
    },
    async count(o) {
      return jobs.filter((j) => !o?.workspaceId || j.data["workspaceId"] === o.workspaceId).length;
    },
    async get(id) {
      return jobs.find((j) => j.id === id) ?? null;
    },
    async retry(id) {
      calls.push(`retry:${id}`);
      return jobs.some((j) => j.id === id);
    },
    async discard(id) {
      calls.push(`discard:${id}`);
      return jobs.some((j) => j.id === id);
    },
  };
  const audited: { action: string; meta: unknown; workspaceId: string }[] = [];
  const audit = {
    recordDetached: async (
      ctx: { workspaceId: string },
      input: { action: string; meta?: unknown },
    ) => {
      audited.push({ action: input.action, meta: input.meta, workspaceId: ctx.workspaceId });
      return {} as never;
    },
  };
  const out: string[] = [];
  return { deadLetters, audit, calls, audited, out, outFn: (l: string) => void out.push(l) };
}

const job: DeadLetterJob = {
  id: ID,
  sourceQueue: "event.acl.changed",
  data: { workspaceId: WS, topic: "acl.changed", outboxId: 7, email: "carol@example.com" },
  error: { message: "boom\n  at stack", stack: "secret stack" },
  failedAt: new Date("2026-09-01T00:00:00Z"),
  retries: 3,
};

describe("fundroom jobs dlq", () => {
  it("lists without the payload, filtered by --workspace", async () => {
    const f = fake([job]);
    const code = await jobsDlqCommand(["list", "--workspace", WS, "--limit", "5"], {
      deadLetters: f.deadLetters,
      audit: f.audit,
      out: f.outFn,
    });
    expect(code).toBe(0);
    expect(f.calls).toContain(`list:${WS}:5`);
    expect(f.out).toHaveLength(1);
    expect(f.out[0]).toContain(ID);
    expect(f.out[0]).toContain("acl.changed");
    expect(f.out[0]).not.toContain("carol@example.com");
    expect(f.out[0]).not.toContain("secret stack");
  });

  it("retries and discards with a platform audit row; unknown ids exit 1, bad input 2", async () => {
    const f = fake([job]);
    const deps = { deadLetters: f.deadLetters, audit: f.audit, out: f.outFn };
    expect(await jobsDlqCommand(["retry", ID], deps)).toBe(0);
    expect(f.audited[0]).toMatchObject({
      action: "ops.dead_letter_retried",
      workspaceId: "00000000-0000-7000-8000-000000000000",
      meta: { via: "cli", workspaceId: WS, sourceQueue: "event.acl.changed", eventId: "7" },
    });
    expect(JSON.stringify(f.audited)).not.toContain("carol@example.com");
    expect(await jobsDlqCommand(["discard", ID], deps)).toBe(0);
    expect(f.audited[1]?.action).toBe("ops.dead_letter_discarded");
    expect(await jobsDlqCommand(["discard", "01920000-0000-7000-8000-0000000000ff"], deps)).toBe(1);
    expect(await jobsDlqCommand(["retry", "nope"], deps)).toBe(2);
    expect(await jobsDlqCommand(["list", "--workspace", "acme"], deps)).toBe(2);
    expect(await jobsDlqCommand(["frobnicate"], deps)).toBe(2);
    expect(f.audited).toHaveLength(2);
  });
});
