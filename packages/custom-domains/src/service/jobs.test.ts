import type { Database, TenantContext, Tx } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import type { SweepRow } from "../repos/domains-repo.js";
import { VERIFY_DEADLINE_MS } from "../state.js";
import type { CustomDomainService } from "./domains.js";
import {
  createDomainJobs,
  type DomainJobsOptions,
  isDueForProviderPoll,
  isDueForVerify,
  JOB_REVERIFY,
  JOB_VERIFY,
  runProviderRelease,
  runReverifySweep,
  runVerifySweep,
  VERIFY_BACKOFF_BASE_MS,
  VERIFY_BACKOFF_MAX_MS,
  verifyBackoffMs,
} from "./jobs.js";

/*
 * The sweeps own two decisions and nothing else: which rows to look at, and when. What a verdict
 * *means* lives in `state.ts` and `service.check()`, which is why nothing here resolves a name.
 */

const WS_A = "01920000-0000-7000-8000-0000000000a1";
const WS_B = "01920000-0000-7000-8000-0000000000a2";
const NOW = new Date("2026-09-13T12:00:00Z");

function sweepRow(values: Partial<SweepRow> & { readonly id: string }): SweepRow {
  return {
    workspaceId: WS_A,
    hostname: `${values.id}.example.com`,
    status: "pending",
    consecutiveFailures: 0,
    firstAttemptAt: new Date(NOW.getTime() - 3600_000),
    lastCheckedAt: null,
    dnsOkAt: null,
    ...values,
  };
}

function fixture(
  rows: readonly SweepRow[],
  options: { readonly throwOn?: string; readonly pollsProvider?: boolean } = {},
) {
  const queries: { statuses: readonly string[]; workspaceId: string | undefined }[] = [];
  const checked: { workspaceId: string; actorKind: string; id: string }[] = [];
  let hostReads = 0;

  const db = {
    withHost: async <T>(fn: (tx: Tx) => Promise<T>) => {
      hostReads++;
      return fn({} as Tx);
    },
  } as unknown as Pick<Database, "withHost">;

  const service: Pick<CustomDomainService, "check"> &
    Partial<Pick<CustomDomainService, "pollsProvider">> = {
    ...(options.pollsProvider === undefined ? {} : { pollsProvider: options.pollsProvider }),
    async check(ctx: TenantContext, id: string) {
      if (options.throwOn === id) throw new Error("that zone is on fire");
      checked.push({ workspaceId: ctx.workspaceId, actorKind: ctx.actorKind, id });
      return undefined;
    },
  };

  const jobOptions: DomainJobsOptions = {
    db,
    service,
    now: () => NOW,
    candidates: async (query) => {
      queries.push({ statuses: query.statuses, workspaceId: query.workspaceId });
      return rows.filter(
        (r) =>
          query.statuses.includes(r.status) &&
          (query.workspaceId === undefined || r.workspaceId === query.workspaceId),
      );
    },
  };

  return {
    jobOptions,
    queries,
    checked,
    get hostReads() {
      return hostReads;
    },
    db,
    service,
  };
}

describe("verifyBackoffMs", () => {
  it("doubles from 5 minutes and caps, so a zone that will never be fixed is not hammered", () => {
    expect(verifyBackoffMs(0)).toBe(VERIFY_BACKOFF_BASE_MS);
    expect(verifyBackoffMs(1)).toBe(10 * 60_000);
    expect(verifyBackoffMs(4)).toBe(80 * 60_000);
    expect(verifyBackoffMs(99)).toBe(VERIFY_BACKOFF_MAX_MS);
    expect(verifyBackoffMs(-3)).toBe(VERIFY_BACKOFF_BASE_MS);
  });
});

describe("isDueForVerify", () => {
  it("always checks a row that has never been checked", () => {
    expect(isDueForVerify(sweepRow({ id: "a" }), NOW)).toBe(true);
  });

  it("waits out the backoff", () => {
    const row = sweepRow({
      id: "a",
      consecutiveFailures: 2,
      lastCheckedAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(isDueForVerify(row, NOW)).toBe(false);
    expect(
      isDueForVerify({ ...row, lastCheckedAt: new Date(NOW.getTime() - 21 * 60_000) }, NOW),
    ).toBe(true);
  });

  it("is always due past the 72 h deadline: only the sweep can move the row to `failed`", () => {
    const row = sweepRow({
      id: "a",
      consecutiveFailures: 20,
      firstAttemptAt: new Date(NOW.getTime() - VERIFY_DEADLINE_MS - 1),
      lastCheckedAt: new Date(NOW.getTime() - 1_000),
    });
    expect(isDueForVerify(row, NOW)).toBe(true);
  });
});

describe("the 5-minute verify sweep", () => {
  it("looks at pending rows only: a poll cannot promote to `active` any more", async () => {
    // E2.1 S2. `dns_ok` was swept here so a second good poll would reach `active`, which meant
    // `active` — the state `primaryHost` and every emailed link key off — was earned by DNS
    // looking right twice rather than by anything being served. A `dns_ok` row's DNS is already
    // right; `domains.reverify` is what re-checks it, weekly, instead of this sweep hitting the
    // customer's nameservers every five minutes forever.
    const f = fixture([]);
    await runVerifySweep(f.jobOptions);
    expect(f.queries[0]?.statuses).toEqual(["pending"]);
  });

  it("acts on every workspace's row in its own `system` tenant context", async () => {
    const rows = [
      sweepRow({ id: "d1" }),
      sweepRow({ id: "d2", workspaceId: WS_B }),
      sweepRow({ id: "d3", status: "pending", workspaceId: WS_B }),
      // Not in the sweep's statuses at all.
      sweepRow({ id: "d4", status: "failed" }),
    ];
    const f = fixture(rows);
    const result = await runVerifySweep(f.jobOptions);
    expect(result).toEqual({ looked: 3, checked: 3 });
    expect(f.checked.map((c) => c.id)).toEqual(["d1", "d2", "d3"]);
    expect(new Set(f.checked.map((c) => c.actorKind))).toEqual(new Set(["system"]));
    expect(f.checked.map((c) => c.workspaceId)).toEqual([WS_A, WS_B, WS_B]);
  });

  it("skips rows whose backoff has not elapsed", async () => {
    const f = fixture([
      sweepRow({ id: "fresh", lastCheckedAt: new Date(NOW.getTime() - 60_000) }),
      sweepRow({ id: "stale", lastCheckedAt: new Date(NOW.getTime() - 20 * 60_000) }),
    ]);
    const result = await runVerifySweep(f.jobOptions);
    expect(result).toEqual({ looked: 2, checked: 1 });
    expect(f.checked.map((c) => c.id)).toEqual(["stale"]);
  });

  it("narrows to one workspace when the job data names one (the repo convention)", async () => {
    const f = fixture([sweepRow({ id: "d1" }), sweepRow({ id: "d2", workspaceId: WS_B })]);
    await runVerifySweep(f.jobOptions, { workspaceId: WS_B });
    expect(f.queries[0]?.workspaceId).toBe(WS_B);
    expect(f.checked.map((c) => c.id)).toEqual(["d2"]);
  });

  it("contains one broken row: the rest of the sweep still runs", async () => {
    const f = fixture([sweepRow({ id: "bad" }), sweepRow({ id: "good" })], { throwOn: "bad" });
    const result = await runVerifySweep(f.jobOptions);
    expect(result).toEqual({ looked: 2, checked: 1 });
    expect(f.checked.map((c) => c.id)).toEqual(["good"]);
  });

  it("stops when the worker is shutting down", async () => {
    const f = fixture([sweepRow({ id: "d1" })]);
    const controller = new AbortController();
    controller.abort();
    const result = await runVerifySweep(f.jobOptions, { signal: controller.signal });
    expect(result.checked).toBe(0);
  });
});

describe("the verify sweep with a provider that has status() (E3.10)", () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it("leaves dns_ok rows alone when the provider has no status()", async () => {
    const f = fixture([sweepRow({ id: "v", status: "dns_ok" })]);
    await runVerifySweep(f.jobOptions);
    expect(f.queries[0]?.statuses).toEqual(["pending"]);
    expect(f.checked).toHaveLength(0);
  });

  it("also polls dns_ok rows, at most once per row per run, on their own schedule", async () => {
    const f = fixture(
      [
        sweepRow({ id: "p" }),
        // Verified 10 minutes ago, checked 6 minutes ago: first hour, every tick.
        sweepRow({
          id: "young",
          status: "dns_ok",
          dnsOkAt: minutesAgo(10),
          lastCheckedAt: minutesAgo(6),
        }),
        // Verified two hours ago, checked 6 minutes ago: every 15 minutes now, not due.
        sweepRow({
          id: "older",
          status: "dns_ok",
          dnsOkAt: minutesAgo(120),
          lastCheckedAt: minutesAgo(6),
        }),
      ],
      { pollsProvider: true },
    );
    const result = await runVerifySweep(f.jobOptions);
    expect(f.queries[0]?.statuses).toEqual(["pending", "dns_ok"]);
    expect(result).toEqual({ looked: 3, checked: 2 });
    expect(f.checked.map((c) => c.id)).toEqual(["p", "young"]);
  });

  it("isDueForProviderPoll backs off with the row's age since dns_ok", () => {
    const row = (dnsOk: number, checked: number) => ({
      dnsOkAt: minutesAgo(dnsOk),
      lastCheckedAt: minutesAgo(checked),
    });
    expect(isDueForProviderPoll({ dnsOkAt: null, lastCheckedAt: null }, NOW)).toBe(true);
    expect(isDueForProviderPoll(row(30, 5), NOW)).toBe(true);
    expect(isDueForProviderPoll(row(30, 3), NOW)).toBe(false);
    expect(isDueForProviderPoll(row(300, 10), NOW)).toBe(false);
    expect(isDueForProviderPoll(row(300, 15), NOW)).toBe(true);
    expect(isDueForProviderPoll(row(3000, 30), NOW)).toBe(false);
    expect(isDueForProviderPoll(row(3000, 60), NOW)).toBe(true);
  });
});

describe("the weekly re-verify sweep", () => {
  it("re-checks every verified row, with no backoff to wait out", async () => {
    const f = fixture([
      sweepRow({ id: "a", status: "active", lastCheckedAt: new Date(NOW.getTime() - 1_000) }),
      sweepRow({ id: "b", status: "dns_ok", lastCheckedAt: new Date(NOW.getTime() - 1_000) }),
      sweepRow({ id: "c", status: "pending" }),
    ]);
    const result = await runReverifySweep(f.jobOptions);
    expect(f.queries[0]?.statuses).toEqual(["active", "dns_ok"]);
    expect(result).toEqual({ looked: 2, checked: 2 });
    // The demotion after REVERIFY_GRACE failures is `nextState`'s call, not the sweep's: the
    // sweep must not second-guess it, which is why it simply checks everything it is given.
    expect(f.checked.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("createDomainJobs", () => {
  it("registers the two contract-fixed crons and passes data.workspaceId through", async () => {
    const f = fixture([sweepRow({ id: "d1" }), sweepRow({ id: "d2", workspaceId: WS_B })]);
    const jobs = createDomainJobs(f.jobOptions);
    expect(jobs.map((j) => j.name)).toEqual([JOB_VERIFY, JOB_REVERIFY]);
    expect(jobs[0]?.cron).toBe("*/5 * * * *");
    expect(jobs[1]?.cron).toBe("40 4 * * 1");

    const signal = new AbortController().signal;
    await jobs[0]?.handler({ id: "j1", name: JOB_VERIFY, data: { workspaceId: WS_B }, signal });
    expect(f.checked.map((c) => c.id)).toEqual(["d2"]);
  });

  it("defaults to every workspace when the cron fires with no data", async () => {
    const f = fixture([sweepRow({ id: "d1" }), sweepRow({ id: "d2", workspaceId: WS_B })]);
    const jobs = createDomainJobs(f.jobOptions);
    const signal = new AbortController().signal;
    await jobs[0]?.handler({ id: "j1", name: JOB_VERIFY, data: {}, signal });
    expect(f.queries[0]?.workspaceId).toBeUndefined();
    expect(f.checked).toHaveLength(2);
  });
});

describe("the default candidate read", () => {
  it("goes through withHost, because the sweep spans workspaces", async () => {
    const f = fixture([]);
    // No `candidates` override: the repo's query runs against a stub `Tx` and throws. The point
    // is only that it was reached inside host context.
    const bare: DomainJobsOptions = { db: f.db, service: f.service, now: () => NOW };
    await runVerifySweep(bare).catch(() => undefined);
    await runReverifySweep(bare).catch(() => undefined);
    expect(f.hostReads).toBe(2);
  });
});

/*
 * `domains.provider-release` (E3.10 FR1): the outbox job that tells the provider a hostname is no
 * longer ours. The host-context claim read is faked at the query-builder level: the job only
 * needs "is this hostname verified anywhere right now".
 */
describe("runProviderRelease", () => {
  const job = { workspaceId: WS_A, domainId: "d1", hostname: "ir.acme.test", ref: "ch-1" };
  /** A host-context db whose one transaction records what ran inside it (FR3). */
  function db(claimed: boolean, events: string[]) {
    let inTx = false;
    const chain = {
      execute: async (q: unknown) => {
        events.push(`execute${inTx ? " (tx)" : ""}`);
        return q;
      },
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => {
        events.push(`held? ${claimed}${inTx ? " (tx)" : ""}`);
        return claimed ? [{ id: "d2" }] : [];
      },
    };
    return {
      db: {
        withHost: async <T>(fn: (tx: Tx) => Promise<T>) => {
          inTx = true;
          try {
            return await fn(chain as unknown as Tx);
          } finally {
            inTx = false;
            events.push("commit");
          }
        },
      } as unknown as Pick<Database, "withHost">,
      inTx: () => inTx,
    };
  }
  function provider(events: string[], inTx: () => boolean, fail = false) {
    return {
      admit: async (c: { workspaceId?: string | undefined }) => {
        events.push(`admit ${c.workspaceId}${inTx() ? " (tx)" : ""}`);
      },
      deactivate: async (h: string, r?: string, c?: { admitted?: boolean | undefined }) => {
        events.push(
          `deactivate ${h} ${r} admitted=${c?.admitted === true}${inTx() ? " (tx)" : ""}`,
        );
        if (fail) throw new Error("Cloudflare API DELETE failed (500)");
      },
    };
  }

  it("pays up front, then reads 'held?' and deletes under the hostname lock in one tx (FR3)", async () => {
    const events: string[] = [];
    const d = db(false, events);
    const out = await runProviderRelease({ db: d.db, provider: provider(events, d.inTx) }, job);
    expect(out).toBe("released");
    expect(events).toEqual([
      `admit ${WS_A}`,
      "execute (tx)", // pg_advisory_xact_lock(24303, …)
      "held? false (tx)",
      "deactivate ir.acme.test ch-1 admitted=true (tx)",
      "commit",
    ]);
  });

  it("throws on a failed release so the queue retries it", async () => {
    const events: string[] = [];
    const d = db(false, events);
    await expect(
      runProviderRelease({ db: d.db, provider: provider(events, d.inTx, true) }, job),
    ).rejects.toThrow(/500/u);
  });

  it("skips the release when the hostname is verified again (re-registered live)", async () => {
    const events: string[] = [];
    const d = db(true, events);
    const out = await runProviderRelease({ db: d.db, provider: provider(events, d.inTx) }, job);
    expect(out).toBe("in_use");
    expect(events.some((e) => e.startsWith("deactivate"))).toBe(false);
  });

  it("a legacy job without a ref searches outside the lock, charged normally", async () => {
    const events: string[] = [];
    const d = db(false, events);
    const { ref: _ref, ...legacy } = job;
    await runProviderRelease({ db: d.db, provider: provider(events, d.inTx) }, legacy);
    expect(events).toEqual([
      "held? false (tx)",
      "commit",
      "deactivate ir.acme.test undefined admitted=false",
    ]);
  });

  it("is a retrying queue job, defined only when a provider is passed", () => {
    const none = createDomainJobs({ db: {} as never, service: { check: async () => undefined } });
    expect(none.map((j) => j.name)).not.toContain("domains.provider-release");
    const withProvider = createDomainJobs({
      db: {} as never,
      service: { check: async () => undefined },
      provider: { deactivate: async () => {} },
    });
    const release = withProvider.find((j) => j.name === "domains.provider-release");
    expect(release?.cron).toBeUndefined();
    expect(release?.queue?.retryLimit).toBeGreaterThanOrEqual(10);
  });
});
