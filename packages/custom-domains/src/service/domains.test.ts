import type { AuditRecorder } from "@fundroom/audit";
import type { CustomDomain, Database, TenantContext, Tx } from "@fundroom/db";
import type {
  CustomDomainProviderPort,
  CustomDomainProviderStatus,
  CustomDomainRequirements,
  DnsAnswer,
  DnsInstruction,
  DnsRecordType,
  DnsResolverPort,
  ProviderCallContext,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { CHALLENGE_LABEL, expectedRecords, LEGACY_CHALLENGE_LABEL } from "../records.js";
import type { AttemptFacts } from "../repos/domains-repo.js";
import { VERIFY_DEADLINE_MS } from "../state.js";
import { challengeToken } from "../token.js";
import {
  type CustomDomainStore,
  createCustomDomainService,
  isCustomDomainError,
  uniqueViolationOf,
} from "./domains.js";

/*
 * The service's two hard parts, neither of which needs a database to pin down:
 *
 *  - the 23505 fork (E2.1 §7): two unique indexes, the same SQLSTATE, opposite meanings, and a
 *    tenancy leak available to whoever conflates them;
 *  - the demotion (§1.4's `nextState` TSDoc): an `active` row demoted today must not be `failed`
 *    tomorrow, which is only true if `first_attempt_at` was reset in the same write.
 */

const WS = "01920000-0000-7000-8000-0000000000a1";
const OTHER_WS = "01920000-0000-7000-8000-0000000000a2";
const MEMBER = "01920000-0000-7000-8000-0000000000b1";
const CANONICAL = "portal.fundroom.app";
const TARGET = "edge.fundroom.app";
const KEY = new Uint8Array(32).fill(7);

const ctx: TenantContext = { workspaceId: WS, actorKind: "staff", membershipId: MEMBER };

/** A `pg` unique violation as drizzle hands it over: the code alone cannot tell them apart. */
function pgUnique(constraint: string, withProperty = true): Error {
  const inner = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    withProperty ? { code: "23505", constraint } : { code: "23505" },
  );
  return Object.assign(new Error("Failed query"), { cause: inner });
}

function rowOf(values: Partial<CustomDomain> & { hostname: string }): CustomDomain {
  const at = new Date("2026-09-01T00:00:00Z");
  return {
    id: "01920000-0000-7000-8000-0000000000c1",
    workspaceId: WS,
    status: "pending",
    token: challengeToken(KEY, WS, values.hostname),
    lastAnswer: null,
    lastAnswerSchemaVersion: 1,
    lastDetail: null,
    consecutiveFailures: 0,
    firstAttemptAt: at,
    lastCheckedAt: null,
    dnsOkAt: null,
    activatedAt: null,
    createdBy: MEMBER,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...values,
  };
}

/**
 * An in-memory stand-in for `CustomDomainRepo` with the same semantics — including the one that
 * matters: `demote` and `reopen` reset `firstAttemptAt`. `failOn` makes a named write raise the
 * unique violation a real index would.
 */
function fakeStore(initial: readonly CustomDomain[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  const failOn = new Map<string, string>();
  /** A raw driver error to raise instead of a unique violation (the 23514 cases). */
  const raiseOn = new Map<string, Error>();
  /** Set true to model the bug this file exists to prevent: a demotion that keeps the old date. */
  let demoteForgetsReset = false;
  /** Every `lockHostname` call, in order (E3.10 FR3). */
  const locks: string[] = [];

  function patch(id: string, values: Partial<CustomDomain>): CustomDomain | undefined {
    const current = rows.get(id);
    if (current === undefined || current.deletedAt !== null) return undefined;
    const raise = raiseOn.get(values.status ?? "");
    if (raise !== undefined) throw raise;
    const failure = failOn.get(values.status ?? "");
    if (failure !== undefined) throw pgUnique(failure);
    const updated = { ...current, ...values };
    rows.set(id, updated);
    return updated;
  }
  function attempt(facts: AttemptFacts): Partial<CustomDomain> {
    return {
      lastCheckedAt: facts.checkedAt,
      ...(facts.detail === undefined ? {} : { lastDetail: facts.detail }),
      ...(facts.answer === undefined ? {} : { lastAnswer: facts.answer }),
    };
  }

  const store: CustomDomainStore = {
    async list() {
      return [...rows.values()].filter((r) => r.deletedAt === null);
    },
    async byId(id) {
      const row = rows.get(id);
      return row === undefined || row.deletedAt !== null ? undefined : row;
    },
    async byHostname(hostname) {
      return [...rows.values()].find((r) => r.deletedAt === null && r.hostname === hostname);
    },
    async verified() {
      return [...rows.values()].find(
        (r) => r.deletedAt === null && (r.status === "dns_ok" || r.status === "active"),
      );
    },
    async create(values) {
      const raise = raiseOn.get("insert");
      if (raise !== undefined) throw raise;
      const failure = failOn.get("insert");
      if (failure !== undefined) throw pgUnique(failure);
      const row = rowOf({
        ...values,
        id: `01920000-0000-7000-8000-00000000c${rows.size + 2}`,
        createdBy: values.createdBy ?? null,
      });
      rows.set(row.id, row);
      return row;
    },
    async recordAttempt(id, facts) {
      return patch(id, { ...attempt(facts), consecutiveFailures: facts.consecutiveFailures });
    },
    async markDnsOk(id, facts) {
      return patch(id, {
        ...attempt(facts),
        status: "dns_ok",
        consecutiveFailures: 0,
        dnsOkAt: facts.checkedAt,
      });
    },
    async markActive(id, facts) {
      return patch(id, {
        ...attempt(facts),
        status: "active",
        consecutiveFailures: 0,
        activatedAt: facts.checkedAt,
      });
    },
    async markServing(id, at) {
      // Mirrors the repo's `WHERE status = 'dns_ok'` and its deliberate refusal to touch any of
      // the DNS columns: nothing was resolved on the serving path.
      const current = rows.get(id);
      if (current === undefined || current.deletedAt !== null || current.status !== "dns_ok") {
        return undefined;
      }
      return patch(id, { status: "active", consecutiveFailures: 0, activatedAt: at });
    },
    async markFailed(id, facts) {
      return patch(id, {
        ...attempt(facts),
        status: "failed",
        consecutiveFailures: facts.consecutiveFailures,
      });
    },
    async demote(id, facts) {
      return patch(id, {
        ...attempt(facts),
        status: "pending",
        consecutiveFailures: 0,
        ...(demoteForgetsReset ? {} : { firstAttemptAt: facts.checkedAt }),
        dnsOkAt: null,
        activatedAt: null,
      });
    },
    async reopen(id, at) {
      return patch(id, {
        status: "pending",
        consecutiveFailures: 0,
        firstAttemptAt: at,
        lastDetail: null,
      });
    },
    async recordProvider(id, provider) {
      const current = rows.get(id);
      if (current === undefined || current.deletedAt !== null) return undefined;
      const lastAnswer = { ...((current.lastAnswer as object | null) ?? {}), provider };
      return patch(id, { lastAnswer });
    },
    async lockHostname(hostname) {
      locks.push(hostname);
    },
    async softDelete(id, at) {
      const row = rows.get(id);
      if (row === undefined || row.deletedAt !== null) return false;
      rows.set(id, { ...row, deletedAt: at });
      return true;
    },
  };

  return {
    store,
    rows,
    locks,
    fail(statusOrInsert: string, constraint: string) {
      failOn.set(statusOrInsert, constraint);
    },
    /** Raise an arbitrary driver error, for the codes that are not 23505. */
    failWith(statusOrInsert: string, error: Error) {
      raiseOn.set(statusOrInsert, error);
    },
    clearFailures() {
      failOn.clear();
      raiseOn.clear();
    },
    breakDemotion() {
      demoteForgetsReset = true;
    },
  };
}

function answer(values: readonly string[], type: DnsRecordType, name: string): DnsAnswer {
  return {
    name,
    type,
    values,
    rcode: values.length === 0 ? "nxdomain" : "ok",
    resolver: "1.1.1.1",
  };
}

/** What an auditor actually filters on: the action, its outcome and the demotion flag. */
interface AuditRow {
  readonly action: string;
  readonly outcome: string | undefined;
  readonly demoted: boolean;
}

interface Harness {
  readonly service: ReturnType<typeof createCustomDomainService>;
  readonly fake: ReturnType<typeof fakeStore>;
  readonly audited: string[];
  readonly auditRows: AuditRow[];
  readonly invalidated: string[];
  readonly resolverBumped: number[];
  readonly provider: {
    activated: string[];
    deactivated: string[];
    polled: string[];
    /** The `ref` each `status` / `deactivate` call was handed (E3.10 FR1). */
    polledRefs: (string | undefined)[];
    deactivatedRefs: (string | undefined)[];
    /** `method priority workspaceId` of every call's context (E3.10 FR3). */
    contexts: string[];
    /** Events in order: `lock <host>` from the store and `activate <host>` (FR3). */
    order: string[];
  };
  /** `sendInTransaction` calls when built with `queue: true`. */
  readonly queued: { name: string; data: Record<string, unknown> }[];
  /** `quota.check` calls when built with `quota`. */
  readonly quotaChecks: { kind: string; delta: number }[];
  setDns(input: DnsFixture): void;
  setNow(at: Date): void;
  /** Every (name, type) the fake resolver was asked for, in order. */
  readonly resolved: readonly string[];
}

/**
 * What the fake zone answers.
 *
 * `cnameRcode` exists because a **flattened apex is NOERROR/NODATA, not NXDOMAIN**: the name
 * exists and holds address records, it simply has no CNAME. Defaulting empty values to NXDOMAIN
 * (which is what a name that does not exist answers) modelled the wrong thing, and the apex path
 * deliberately does not spend two lookups on a name that does not exist.
 *
 * `targetA` / `targetAaaa` are the CNAME *target's* own addresses — what the verifier resolves
 * when no `CUSTOM_DOMAIN_EDGE_ADDRESSES` override is configured (E2.1 S1).
 */
interface DnsFixture {
  cname?: readonly string[];
  cnameRcode?: DnsAnswer["rcode"];
  /** TXT at the current label, `_fundroom-challenge.<host>`. */
  txt?: readonly string[];
  /** Overrides the rcode of the current-label TXT answer (a SERVFAIL, a resolver split). */
  txtRcode?: DnsAnswer["rcode"];
  /** TXT at the pre-rename label, `_seedhost-challenge.<host>` (A-2's permanent fallback). */
  legacyTxt?: readonly string[];
  a?: readonly string[];
  aaaa?: readonly string[];
  targetA?: readonly string[];
  targetAaaa?: readonly string[];
}

interface HarnessOptions {
  edgeAddresses?: string[];
  /** Which provider the service is built with. Defaults to a `caddy-ask` stand-in. */
  driver?: string;
  /** What that provider requires proven. Defaults to both records. */
  requires?: CustomDomainRequirements;
  /** `CUSTOM_DOMAIN_CNAME_TARGET`. A `manual` install legitimately has none. */
  cnameTarget?: string;
  /**
   * E3.10: a provider with `status()` (the `cloudflare-saas` shape). Each call answers the next
   * queued value; an `Error` is thrown. `activate` answers `activateRecords` (or throws the
   * queued `activateError`).
   */
  providerStatus?: (CustomDomainProviderStatus | Error)[];
  activateRecords?: DnsInstruction[];
  activateErrors?: Error[];
  /** The `ref` `activate` answers with (E3.10 FR1). */
  activateRef?: string;
  /** Build with a recording outbox queue. */
  queue?: boolean;
  /** Build with a quota gate; `refuse` makes it throw. */
  quota?: { refuse: boolean };
  /** Every `now()` call advances the clock by this much (default 0). */
  clockStepMs?: number;
  /** E3.11: a recording cell directory; `claim` is what `claimHost` answers (or throws). */
  directory?: {
    claim: "claimed" | "taken" | Error;
    calls: string[];
    /** RR1-8: what `claimHost` answers after `repairEntry` ran (default: `claim` again). */
    afterRepair?: "claimed" | "taken" | Error;
  };
}

function harness(initial: readonly CustomDomain[], options: HarnessOptions = {}) {
  const fake = fakeStore(initial);
  const audited: string[] = [];
  const auditRows: AuditRow[] = [];
  const invalidated: string[] = [];
  const resolverBumped: number[] = [];
  const provider = {
    activated: [] as string[],
    deactivated: [] as string[],
    polled: [] as string[],
    polledRefs: [] as (string | undefined)[],
    deactivatedRefs: [] as (string | undefined)[],
    contexts: [] as string[],
    order: [] as string[],
  };
  const ctxOf = (method: string, c: ProviderCallContext | undefined) =>
    provider.contexts.push(`${method} ${c?.priority ?? "-"} ${c?.workspaceId ?? "-"}`);
  const queued: { name: string; data: Record<string, unknown> }[] = [];
  const quotaChecks: { kind: string; delta: number }[] = [];
  let dns: DnsFixture = {};
  const resolved: string[] = [];
  let clock = new Date("2026-09-02T00:00:00Z");

  const db = {
    withTenant: async <T>(_c: TenantContext, fn: (tx: Tx) => Promise<T>) => fn({} as Tx),
  } as unknown as Database;

  const requires: CustomDomainRequirements = options.requires ?? { cname: true, txt: true };
  const cnameTarget = options.cnameTarget ?? TARGET;

  const resolver: DnsResolverPort = {
    driver: "fake",
    async resolve(name, type) {
      resolved.push(`${name}/${type}`);
      if (type === "TXT") {
        if (name.startsWith(`${LEGACY_CHALLENGE_LABEL}.`)) {
          return answer(dns.legacyTxt ?? [], type, name);
        }
        const base = answer(dns.txt ?? [], type, name);
        return dns.txtRcode === undefined ? base : { ...base, rcode: dns.txtRcode };
      }
      if (type === "CNAME") {
        const base = answer(dns.cname ?? [], type, name);
        return dns.cnameRcode === undefined ? base : { ...base, rcode: dns.cnameRcode };
      }
      // The target's own addresses are a different question from the hostname's, and the whole
      // point of S1 is that the verifier asks the first one.
      const forTarget = name === cnameTarget;
      const values =
        type === "A"
          ? ((forTarget ? dns.targetA : dns.a) ?? [])
          : ((forTarget ? dns.targetAaaa : dns.aaaa) ?? []);
      return answer(values, type, name);
    },
    async healthCheck() {},
  };

  const statuses = options.providerStatus;
  const providerPort: CustomDomainProviderPort = {
    driver: options.driver ?? (statuses === undefined ? "caddy-ask" : "cloudflare-saas"),
    requires,
    async activate(hostname, c) {
      provider.activated.push(hostname);
      ctxOf("activate", c);
      provider.order.push(`activate ${hostname} after ${fake.locks.length} lock(s)`);
      const failure = options.activateErrors?.shift();
      if (failure !== undefined) throw failure;
      if (statuses !== undefined) {
        return {
          records: options.activateRecords ?? [],
          ...(options.activateRef === undefined ? {} : { ref: options.activateRef }),
        };
      }
    },
    ...(statuses === undefined
      ? {}
      : {
          async status(hostname: string, ref?: string, c?: ProviderCallContext) {
            provider.polled.push(hostname);
            provider.polledRefs.push(ref);
            ctxOf("status", c);
            const next = statuses.shift() ?? new Error("no status queued");
            if (next instanceof Error) throw next;
            return next;
          },
        }),
    async deactivate(hostname, ref, c) {
      provider.deactivated.push(hostname);
      provider.deactivatedRefs.push(ref);
      ctxOf("deactivate", c);
    },
    instructions(input) {
      const records = expectedRecords({ ...input, cnameTarget });
      if (requires.cname) return records;
      // Mirror `@fundroom/domain-manual`: with no CNAME to check there is no CNAME row unless
      // the operator named an edge, and then only as advisory guidance.
      return records.flatMap((r) =>
        r.type !== "CNAME" ? [r] : cnameTarget === "" ? [] : [{ ...r, required: false }],
      );
    },
  };

  const audit = {
    async record(
      _tx: Tx,
      _c: TenantContext,
      input: { action: string; outcome?: string; meta?: Record<string, unknown> },
    ) {
      audited.push(input.action);
      auditRows.push({
        action: input.action,
        outcome: input.outcome,
        demoted: input.meta?.["demoted"] === true,
      });
      return undefined as never;
    },
  } as unknown as Pick<AuditRecorder, "record">;

  const service = createCustomDomainService({
    db,
    audit,
    resolver,
    provider: providerPort,
    caches: {
      lookup: {
        invalidate(hostname) {
          invalidated.push(hostname ?? "*");
        },
      },
      workspaces: {
        invalidate() {
          resolverBumped.push(resolverBumped.length + 1);
        },
      },
    },
    canonicalHost: CANONICAL,
    cnameTarget,
    tokenKey: KEY,
    ...(options.edgeAddresses === undefined ? {} : { edgeAddresses: options.edgeAddresses }),
    now: () => {
      const at = clock;
      clock = new Date(clock.getTime() + (options.clockStepMs ?? 0));
      return at;
    },
    store: () => fake.store,
    ...(options.directory === undefined
      ? {}
      : {
          directory: {
            async claimHost(input: { hostname: string; workspaceId: string }) {
              const d = options.directory as NonNullable<HarnessOptions["directory"]>;
              d.calls.push(`claim ${input.hostname} ${input.workspaceId}`);
              const answer =
                d.afterRepair !== undefined && d.calls.includes(`repair ${input.workspaceId}`)
                  ? d.afterRepair
                  : d.claim;
              if (answer instanceof Error) throw answer;
              return answer;
            },
            async releaseHost(input: { hostname: string; workspaceId: string }) {
              options.directory?.calls.push(`release ${input.hostname} ${input.workspaceId}`);
            },
          },
          async repairEntry(workspaceId: string) {
            options.directory?.calls.push(`repair ${workspaceId}`);
          },
        }),
    ...(options.queue === true
      ? {
          queue: {
            async sendInTransaction(_tx, name, data) {
              queued.push({ name, data: data as Record<string, unknown> });
              return "job-1";
            },
          },
        }
      : {}),
    ...(options.quota === undefined
      ? {}
      : {
          quota: {
            async check(_tx, input) {
              quotaChecks.push({ kind: input.kind, delta: input.delta });
              if (options.quota?.refuse === true) throw new Error("plan_limit");
            },
          },
        }),
  });

  const h: Harness = {
    service,
    fake,
    audited,
    auditRows,
    invalidated,
    resolverBumped,
    provider,
    queued,
    quotaChecks,
    resolved,
    setDns(input) {
      dns = input;
      resolved.length = 0;
    },
    setNow(at) {
      clock = at;
    },
  };
  return h;
}

describe("uniqueViolationOf", () => {
  it("names the index, because all three violations share SQLSTATE 23505", () => {
    expect(uniqueViolationOf(pgUnique("custom_domain_claim_idx"))).toBe("custom_domain_claim_idx");
    expect(uniqueViolationOf(pgUnique("custom_domain_one_per_workspace_idx"))).toBe(
      "custom_domain_one_per_workspace_idx",
    );
    expect(uniqueViolationOf(pgUnique("custom_domain_ws_host_idx"))).toBe(
      "custom_domain_ws_host_idx",
    );
  });

  it("falls back to the message when the driver error carries no `constraint`", () => {
    expect(uniqueViolationOf(pgUnique("custom_domain_claim_idx", false))).toBe(
      "custom_domain_claim_idx",
    );
  });

  it("ignores anything that is not one of ours, so it can be rethrown", () => {
    expect(uniqueViolationOf(pgUnique("workspace_slug_active_idx"))).toBeUndefined();
    expect(uniqueViolationOf(new Error("nope"))).toBeUndefined();
    expect(uniqueViolationOf(Object.assign(new Error("x"), { code: "23514" }))).toBeUndefined();
  });
});

describe("add", () => {
  it("refuses the canonical host and its subdomains with the reason attached", async () => {
    const h = harness([]);
    for (const [input, reason] of [
      [CANONICAL, "canonical_host"],
      [`acme.${CANONICAL}`, "canonical_subdomain"],
      ["*.acme.com", "wildcard"],
      ["127.0.0.1", "ip_literal"],
      ["co.uk", "public_suffix"],
      ["", "empty"],
    ] as const) {
      const error = await h.service.add(ctx, { hostname: input }).catch((e: unknown) => e);
      if (!isCustomDomainError(error)) throw new Error(`expected a refusal for ${input}`);
      expect(error.code).toBe("invalid_hostname");
      expect(error.details["reason"]).toBe(reason);
    }
  });

  it("stores the normalised spelling, mints the derived token and audits the creation", async () => {
    const h = harness([]);
    const view = await h.service.add(ctx, {
      hostname: " INVESTORS.Acme.com. ",
      actor: { membershipId: MEMBER },
    });
    expect(view.hostname).toBe("investors.acme.com");
    expect(view.status).toBe("pending");
    expect(view.records.map((r) => r.type)).toEqual(["CNAME", "TXT"]);
    expect(view.records[1]?.value).toBe(challengeToken(KEY, WS, "investors.acme.com"));
    expect(view.deadlineAt.getTime() - view.firstAttemptAt.getTime()).toBe(VERIFY_DEADLINE_MS);
    expect(h.audited).toEqual(["custom_domain.created"]);
  });

  it("answers `duplicate` for a hostname already on this workspace's list", async () => {
    const h = harness([rowOf({ hostname: "investors.acme.com" })]);
    const error = await h.service
      .add(ctx, { hostname: "investors.acme.com" })
      .catch((e: unknown) => e);
    if (!isCustomDomainError(error)) throw new Error("expected a refusal");
    expect(error.code).toBe("duplicate");
  });

  it("names the workspace's own verified hostname rather than leaking a constraint (§6.2)", async () => {
    const h = harness([rowOf({ hostname: "investors.acme.com", status: "active" })]);
    const error = await h.service.add(ctx, { hostname: "ir.acme.com" }).catch((e: unknown) => e);
    if (!isCustomDomainError(error)) throw new Error("expected a refusal");
    expect(error.code).toBe("workspace_already_verified");
    expect(error.message).toContain("investors.acme.com");
    expect(error.details["hostname"]).toBe("investors.acme.com");
  });

  it("maps a raced insert to `duplicate` instead of letting 23505 escape as a 500", async () => {
    const h = harness([]);
    h.fake.fail("insert", "custom_domain_ws_host_idx");
    const error = await h.service.add(ctx, { hostname: "ir.acme.com" }).catch((e: unknown) => e);
    if (!isCustomDomainError(error)) throw new Error("expected a refusal");
    expect(error.code).toBe("duplicate");
  });
});

describe("check: the two claims", () => {
  const row = rowOf({ hostname: "investors.acme.com" });

  it("verifies, activates the provider and invalidates both caches", async () => {
    const h = harness([row]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.dnsOkAt).toEqual(new Date("2026-09-02T00:00:00Z"));
    expect(h.audited).toEqual(["custom_domain.verified"]);
    expect(h.provider.activated).toEqual(["investors.acme.com"]);
    expect(h.invalidated).toEqual(["investors.acme.com"]);
    expect(h.resolverBumped).toHaveLength(1);
  });

  it("does not name the other workspace when the claim is taken (tenancy leak)", async () => {
    const h = harness([row]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.fake.fail("dns_ok", "custom_domain_claim_idx");
    const view = await h.service.check(ctx, row.id);
    // The row stays put, the reason is recorded, and nothing about the other workspace is said.
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain("already verified for another workspace");
    expect(view?.detail).not.toContain(OTHER_WS);
    expect(h.audited).toEqual([]);
    expect(h.invalidated).toEqual([]);
  });

  it("names the workspace's own hostname when it is the one-per-workspace index", async () => {
    const existing = rowOf({
      id: "01920000-0000-7000-8000-0000000000c9",
      hostname: "ir.acme.com",
      status: "active",
    });
    const h = harness([row, existing]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.fake.fail("dns_ok", "custom_domain_one_per_workspace_idx");
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain("ir.acme.com");
  });

  it("reports what DNS actually said when the records are wrong, and writes no audit row", async () => {
    const h = harness([row]);
    h.setDns({ cname: ["shops.myshopify.com"], txt: [] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain("shops.myshopify.com");
    expect(view?.consecutiveFailures).toBe(1);
    expect(h.audited).toEqual([]);
  });

  /*
   * Apex / A-record domains (E2.1 S1, design/07 §2.3(a)).
   *
   * This whole branch was dead in every shipped configuration: it only ran when
   * `deps.edgeAddresses` was non-empty, the container never passed it, and no config key existed
   * — so a self-hoster whose customer published a plain `A` record (the only thing a zone apex
   * can hold) sat `pending` for 72 h and then `failed`, while the screen, `verify.ts` and
   * `records.ts` all said apex worked.
   *
   * The fix resolves the *target's* own addresses, which is what flattening means, needs no
   * configuration, and follows the edge when it moves. The override stays for an anycast edge.
   */
  describe("apex flattening", () => {
    it("accepts an apex by resolving the CNAME target's own addresses, with no config at all", async () => {
      const h = harness([row]);
      // A real flattened apex: the name exists (NOERROR) with no CNAME, and holds the same
      // address the edge does.
      h.setDns({
        cname: [],
        cnameRcode: "ok",
        txt: [row.token],
        a: ["203.0.113.7"],
        targetA: ["203.0.113.7"],
      });
      const view = await h.service.check(ctx, row.id);
      expect(view?.status).toBe("dns_ok");
      expect(view?.answer?.a?.values).toEqual(["203.0.113.7"]);
      // It asked the target, not the operator.
      expect(h.resolved).toContain(`${TARGET}/A`);
    });

    it("resolves the target once per sweep, not once per row", async () => {
      const second = rowOf({
        hostname: "ir2.acme.com",
        id: "01920000-0000-7000-8000-0000000000c2",
      });
      const h = harness([row, second]);
      h.setDns({
        cname: [],
        cnameRcode: "ok",
        txt: [row.token],
        a: ["203.0.113.7"],
        targetA: ["203.0.113.7"],
      });
      await h.service.check(ctx, row.id);
      await h.service.check(ctx, second.id);
      expect(h.resolved.filter((q) => q === `${TARGET}/A`)).toHaveLength(1);
    });

    it("refuses an apex pointing somewhere else, and says where it points", async () => {
      const h = harness([row]);
      h.setDns({
        cname: [],
        cnameRcode: "ok",
        txt: [row.token],
        a: ["198.51.100.4"],
        targetA: ["203.0.113.7"],
      });
      const view = await h.service.check(ctx, row.id);
      expect(view?.status).toBe("pending");
      // The apex sentence, not "there is no CNAME": the customer published an A record, so
      // telling them nothing is there would send them looking for the wrong thing.
      expect(view?.detail).toContain("198.51.100.4");
      expect(view?.detail).toContain("203.0.113.7");
    });

    it("takes the configured override instead of resolving the target when one is set", async () => {
      const h = harness([row], { edgeAddresses: ["203.0.113.7"] });
      h.setDns({ cname: [], cnameRcode: "ok", txt: [row.token], a: ["203.0.113.7"] });
      const view = await h.service.check(ctx, row.id);
      expect(view?.status).toBe("dns_ok");
      expect(view?.answer?.a?.values).toEqual(["203.0.113.7"]);
      // The override is the answer; the target is never asked.
      expect(h.resolved).not.toContain(`${TARGET}/A`);
    });

    it("matches an AAAA-only apex against the target's AAAA", async () => {
      const h = harness([row]);
      h.setDns({
        cname: [],
        cnameRcode: "ok",
        txt: [row.token],
        aaaa: ["2001:db8::7"],
        targetAaaa: ["2001:db8::7"],
      });
      expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    });

    it("spends no lookups on a name that does not exist", async () => {
      const h = harness([row]);
      h.setDns({ cname: [], txt: [row.token] });
      expect((await h.service.check(ctx, row.id))?.status).toBe("pending");
      expect(h.resolved.filter((q) => q.endsWith("/A"))).toEqual([]);
    });
  });

  it("gives up at the 72 h deadline, and an admin retry reopens the window", async () => {
    const h = harness([row]);
    h.setDns({ cname: [], txt: [] });
    h.setNow(new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 1_000));
    expect((await h.service.check(ctx, row.id))?.status).toBe("failed");
    expect(h.audited).toEqual(["custom_domain.failed"]);

    const retryAt = new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 60_000);
    h.setNow(retryAt);
    const reopened = await h.service.verifyNow(ctx, row.id, { membershipId: MEMBER });
    // Reopened with a fresh deadline rather than confirming the failure again.
    expect(reopened.status).toBe("pending");
    expect(reopened.firstAttemptAt).toEqual(retryAt);
  });

  it("reopening a failed row runs the customDomains plan quota first (E3.10 FR1)", async () => {
    const failed = rowOf({ hostname: row.hostname, status: "failed" });
    const refused = harness([failed], { quota: { refuse: true } });
    await expect(refused.service.verifyNow(ctx, failed.id)).rejects.toThrow(/plan_limit/u);
    expect(refused.quotaChecks).toEqual([{ kind: "customDomains", delta: 1 }]);
    // Still failed: the reopen rolled back with the refusal.
    expect(refused.fake.rows.get(failed.id)?.status).toBe("failed");

    const allowed = harness([failed], { quota: { refuse: false } });
    allowed.setDns({ cname: [], txt: [] });
    expect((await allowed.service.verifyNow(ctx, failed.id)).status).toBe("pending");
    expect(allowed.quotaChecks).toHaveLength(1);
    // A row that is not failed is already counted: no check.
    await allowed.service.verifyNow(ctx, failed.id);
    expect(allowed.quotaChecks).toHaveLength(1);
  });
});

/*
 * A-2: `_seedhost-challenge` → `_fundroom-challenge`, with a PERMANENT fallback. The weekly
 * `domains.reverify` re-checks every verified row and demotes after REVERIFY_GRACE misses, so a
 * verifier that stopped reading the old label would take every pre-rename portal offline three
 * weeks after the upgrade. The rule: either label carrying the row's token proves control; the
 * old label is looked up only when the new one did not carry it; the sentence and the stored
 * answer are the ones that decided.
 */
describe("the pre-rename challenge label", () => {
  const HOST = "investors.acme.com";
  const NEW = `${CHALLENGE_LABEL}.${HOST}`;
  const OLD = `${LEGACY_CHALLENGE_LABEL}.${HOST}`;
  const pending = rowOf({ hostname: HOST });
  const active = rowOf({
    hostname: HOST,
    status: "active",
    firstAttemptAt: new Date("2026-01-01T00:00:00Z"),
    dnsOkAt: new Date("2026-01-01T00:00:00Z"),
    activatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const txtLookups = (h: Harness) => h.resolved.filter((r) => r.endsWith("/TXT"));

  it("verifies a domain that only publishes the old label, naming the old label", async () => {
    const h = harness([pending]);
    h.setDns({ cname: [TARGET], legacyTxt: [pending.token] });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.detail).toContain(`${LEGACY_CHALLENGE_LABEL} TXT matches`);
    expect(view?.detail).not.toContain(`${CHALLENGE_LABEL} TXT matches`);
    // The stored answer is the one that decided, so the screen shows the record doing the work.
    expect(view?.answer?.txt?.name).toBe(OLD);
    // New label first, old one only after it.
    expect(txtLookups(h)).toEqual([`${NEW}/TXT`, `${OLD}/TXT`]);
    // The instructions still show only the new label.
    expect(view?.records.map((r) => r.name)).toContain(NEW);
    expect(JSON.stringify(view?.records)).not.toContain(LEGACY_CHALLENGE_LABEL);
  });

  it("keeps an old-label-only ACTIVE domain active through every weekly re-check", async () => {
    const h = harness([active]);
    h.setDns({ cname: [TARGET], legacyTxt: [active.token] });
    // Past REVERIFY_GRACE (3): without the fallback the third of these demotes the portal.
    for (let week = 1; week <= 5; week++) {
      const view = await h.service.check(ctx, active.id);
      expect(view?.status, `week ${week}`).toBe("active");
      expect(view?.consecutiveFailures, `week ${week}`).toBe(0);
    }
    expect(h.audited).toEqual([]);
    expect(h.provider.deactivated).toEqual([]);
  });

  it("verifies on the new label without spending a lookup on the old one", async () => {
    const h = harness([pending]);
    h.setDns({ cname: [TARGET], txt: [pending.token], legacyTxt: ["stale-token"] });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.detail).toContain(`${CHALLENGE_LABEL} TXT matches`);
    expect(view?.detail).not.toContain(LEGACY_CHALLENGE_LABEL);
    expect(view?.answer?.txt?.name).toBe(NEW);
    expect(txtLookups(h)).toEqual([`${NEW}/TXT`]);
  });

  it("a wrong token under the new label + the right one under the old passes, naming the old", async () => {
    // Both names sit under the customer's hostname, so either is proof of control on its own
    // merits: the wrong value under the new label neither blocks the old proof nor is rescued.
    const h = harness([pending]);
    h.setDns({ cname: [TARGET], txt: ["somebody-elses-token"], legacyTxt: [pending.token] });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.detail).toContain(`${LEGACY_CHALLENGE_LABEL} TXT matches`);
    expect(view?.answer?.txt?.name).toBe(OLD);
  });

  it("a resolver split on the new label does not block a quorate proof on the old one", async () => {
    const h = harness([pending]);
    h.setDns({
      cname: [TARGET],
      txt: [pending.token],
      txtRcode: "other",
      legacyTxt: [pending.token],
    });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.answer?.txt?.name).toBe(OLD);
    expect(view?.answer?.txt?.rcode).toBe("ok");
  });

  it("a wrong token under both labels fails, described against the new label", async () => {
    const h = harness([pending]);
    h.setDns({ cname: [TARGET], txt: ["wrong-new"], legacyTxt: ["wrong-old"] });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("pending");
    expect(view?.consecutiveFailures).toBe(1);
    expect(view?.detail).toContain(`${NEW} returned a different token`);
    expect(view?.detail).not.toContain(LEGACY_CHALLENGE_LABEL);
    expect(view?.answer?.txt?.name).toBe(NEW);
    expect(txtLookups(h)).toEqual([`${NEW}/TXT`, `${OLD}/TXT`]);
  });

  it("an old-label proof never stands in for the CNAME", async () => {
    const h = harness([pending]);
    h.setDns({ cname: ["shops.myshopify.com"], legacyTxt: [pending.token] });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain("shops.myshopify.com");
    expect(view?.detail).toContain(`${LEGACY_CHALLENGE_LABEL} TXT matches`);
  });

  it("an old-label proof serves a flattened apex too", async () => {
    const h = harness([pending]);
    h.setDns({
      cname: [],
      cnameRcode: "ok",
      a: ["203.0.113.7"],
      targetA: ["203.0.113.7"],
      legacyTxt: [pending.token],
    });
    const view = await h.service.check(ctx, pending.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.detail).toContain(`${LEGACY_CHALLENGE_LABEL} TXT matches`);
  });
});

describe("demotion", () => {
  /** `active`, two failures deep: the next failure is the one that demotes (REVERIFY_GRACE 3). */
  const active = rowOf({
    hostname: "investors.acme.com",
    status: "active",
    consecutiveFailures: 2,
    firstAttemptAt: new Date("2026-01-01T00:00:00Z"),
    dnsOkAt: new Date("2026-01-01T00:00:00Z"),
    activatedAt: new Date("2026-01-01T00:00:00Z"),
  });

  it("resets first_attempt_at, so a row demoted today is not `failed` tomorrow", async () => {
    const h = harness([active]);
    h.setDns({ cname: [], txt: [] });
    const today = new Date("2026-09-13T00:00:00Z");
    h.setNow(today);

    const demoted = await h.service.check(ctx, active.id);
    expect(demoted?.status).toBe("pending");
    expect(demoted?.firstAttemptAt).toEqual(today);
    expect(demoted?.activatedAt).toBeNull();
    expect(demoted?.consecutiveFailures).toBe(0);
    expect(h.audited).toEqual(["custom_domain.failed"]);
    expect(h.provider.deactivated).toEqual(["investors.acme.com"]);
    expect(h.invalidated).toEqual(["investors.acme.com"]);
    expect(h.resolverBumped).toHaveLength(1);
    // A demotion is a `custom_domain.failed` row, so its outcome must be `failure` too. It was
    // recorded as `success`, which means "did a portal stop being reachable" — asked the only
    // way an auditor can ask it, by filtering on failed outcomes — answered no every time.
    expect(h.auditRows).toEqual([
      { action: "custom_domain.failed", outcome: "failure", demoted: true },
    ]);

    h.setNow(new Date("2026-09-14T00:00:00Z"));
    const tomorrow = await h.service.check(ctx, active.id);
    expect(tomorrow?.status).toBe("pending");
  });

  it("would flip straight to `failed` if the reset were dropped — the trap this guards", async () => {
    const h = harness([active]);
    h.fake.breakDemotion();
    h.setDns({ cname: [], txt: [] });
    h.setNow(new Date("2026-09-13T00:00:00Z"));
    expect((await h.service.check(ctx, active.id))?.status).toBe("pending");
    h.setNow(new Date("2026-09-14T00:00:00Z"));
    expect((await h.service.check(ctx, active.id))?.status).toBe("failed");
  });

  it("survives one bad answer: an active domain is not demoted before the grace runs out", async () => {
    const h = harness([rowOf({ hostname: "investors.acme.com", status: "active" })]);
    h.setDns({ cname: [], txt: [] });
    const view = await h.service.check(ctx, "01920000-0000-7000-8000-0000000000c1");
    expect(view?.status).toBe("active");
    expect(view?.consecutiveFailures).toBe(1);
    expect(h.invalidated).toEqual([]);
  });
});

describe("remove", () => {
  it("soft-deletes, audits, deactivates and invalidates both caches", async () => {
    const row = rowOf({ hostname: "investors.acme.com", status: "active" });
    const h = harness([row]);
    expect(await h.service.remove(ctx, row.id, { membershipId: MEMBER })).toBe(true);
    expect(h.audited).toEqual(["custom_domain.deleted"]);
    expect(h.provider.deactivated).toEqual(["investors.acme.com"]);
    expect(h.invalidated).toEqual(["investors.acme.com"]);
    expect(h.resolverBumped).toHaveLength(1);
    expect(await h.service.list(ctx)).toEqual([]);
    // Idempotent: a second removal is false, not an error.
    expect(await h.service.remove(ctx, row.id)).toBe(false);
  });

  it("404s a row that is not this workspace's to remove", async () => {
    const h = harness([]);
    expect(await h.service.remove(ctx, "01920000-0000-7000-8000-0000000000ff")).toBe(false);
    await expect(h.service.verifyNow(ctx, "01920000-0000-7000-8000-0000000000ff")).rejects.toThrow(
      /no such domain/u,
    );
  });
});

/*
 * E2.1 defect 1: the `manual` provider and the verdict disagreed. `evaluate` hardcoded
 * `ok = cnameOk && txtOk`, so on a `manual` install — where the operator terminates TLS on their
 * own edge and there is no hostname of ours to CNAME at — a founder published the one TXT record
 * the screen asked for and then failed on a CNAME nobody had mentioned. With no target configured
 * at all (`cnameTarget: ""`, the honest default there) `cnameOk` was false for every possible
 * answer and the domain could never verify. The verdict now honours `provider.requires`.
 */
describe("check: the provider decides which records gate verification", () => {
  const row = rowOf({ hostname: "investors.acme.com" });
  const MANUAL = {
    driver: "manual",
    requires: { cname: false, txt: true },
    cnameTarget: "",
  } as const;

  it("verifies a `manual` domain on the TXT alone, with no CNAME and no target", async () => {
    const h = harness([row], MANUAL);
    h.setDns({ cname: [], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    expect(h.audited).toEqual(["custom_domain.verified"]);
  });

  it("verifies a `manual` domain whose CNAME points at the operator's own proxy", async () => {
    const h = harness([row], MANUAL);
    h.setDns({ cname: ["proxy.acme.internal"], txt: [row.token] });
    expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
  });

  it("says nothing about a CNAME when a `manual` verification fails", async () => {
    const h = harness([row], MANUAL);
    h.setDns({ cname: [], txt: [] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).not.toBeNull();
    expect(view?.detail?.toLowerCase()).not.toContain("cname");
    // It still names the record that *is* missing.
    expect(view?.detail).toContain("_fundroom-challenge.investors.acme.com");
  });

  it("only asks a `manual` operator for records it actually checks", async () => {
    const h = harness([row], MANUAL);
    const [view] = await h.service.list(ctx);
    expect(view?.records.map((r) => ({ type: r.type, required: r.required }))).toEqual([
      { type: "TXT", required: true },
    ]);
  });

  it("still requires both records on `caddy-ask`, given the very same DNS", async () => {
    const h = harness([row]);
    h.setDns({ cname: [], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain(TARGET);
  });

  it("does not spend apex A/AAAA queries for a CNAME it does not check", async () => {
    const h = harness([row], { ...MANUAL, edgeAddresses: ["203.0.113.7"] });
    h.setDns({ cname: [], txt: [row.token], a: ["203.0.113.7"] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    // The apex probe exists only to satisfy a required CNAME, so it was never made.
    expect(view?.answer?.a).toBeUndefined();
  });
});

describe("createCustomDomainService: refusals at construction", () => {
  it("refuses a CNAME-checking provider with an empty CNAME target", () => {
    // The `cnameTarget === ""` trap: `cnameOk` would be false for every answer, so every domain
    // on the install would sit `pending` for 72 h with nothing wrong in anybody's zone. Refused
    // here rather than typed away, because the value arrives from the environment as a string.
    expect(() => harness([], { cnameTarget: "" })).toThrow(/CUSTOM_DOMAIN_CNAME_TARGET is empty/u);
    expect(() => harness([], { cnameTarget: "  " })).toThrow(/"manual" driver/u);
  });

  it("allows an empty CNAME target when the provider does not check it", () => {
    expect(() =>
      harness([], { driver: "manual", requires: { cname: false, txt: true }, cnameTarget: "" }),
    ).not.toThrow();
  });

  it("refuses a provider that requires no proof of control at all", () => {
    // Verifying on no evidence is a tenant-resolution bypass: anyone who can point DNS at us
    // could claim somebody else's hostname.
    expect(() =>
      harness([], { driver: "reckless", requires: { cname: true, txt: false } }),
    ).toThrow(/requires no TXT challenge/u);
  });
});

/*
 * `markServing` — the only writer of `active` (E2.1 S2).
 *
 * `runVerifySweep` used to include `dns_ok` rows and `nextState("dns_ok", ok=true)` returned
 * `active`, so a second successful DNS poll promoted the row. Nothing on the serving path ever
 * wrote, which made `active` mean "DNS verified twice" while `state.ts`, the migration comment
 * and ADR decision 3 all said it meant *serving* — and `primaryHost` keys off it, so
 * `workspaceUrl`, `canonicalOrigin` and `brandingLogoUrl` started minting links at a hostname
 * that may answer a TLS error.
 */
describe("markServing", () => {
  const row = rowOf({
    hostname: "investors.acme.com",
    status: "dns_ok",
    dnsOkAt: new Date("2026-09-01T12:00:00Z"),
    lastCheckedAt: new Date("2026-09-01T12:00:00Z"),
    lastDetail: "investors.acme.com points at edge.fundroom.app; TXT matches.",
  });

  it("promotes dns_ok → active, audits it, and invalidates both caches", async () => {
    const h = harness([row]);
    expect(await h.service.markServing(ctx, row.id)).toBe(true);
    const view = (await h.service.list(ctx))[0];
    expect(view?.status).toBe("active");
    expect(view?.activatedAt).toEqual(new Date("2026-09-02T00:00:00Z"));
    expect(h.audited).toEqual(["custom_domain.activated"]);
    expect(h.invalidated).toEqual(["investors.acme.com"]);
    expect(h.resolverBumped).toHaveLength(1);
  });

  it("writes no DNS facts: nothing was resolved on the serving path", async () => {
    const h = harness([row]);
    await h.service.markServing(ctx, row.id);
    const view = (await h.service.list(ctx))[0];
    // The last resolver answer §9.2 puts on screen is the verifier's, not "a request arrived".
    expect(view?.lastCheckedAt).toEqual(row.lastCheckedAt);
    expect(view?.detail).toBe(row.lastDetail);
  });

  it("is a no-op for any status but dns_ok, and audits nothing", async () => {
    for (const status of ["pending", "active", "failed"] as const) {
      const h = harness([rowOf({ hostname: "investors.acme.com", status })]);
      expect(await h.service.markServing(ctx, row.id), status).toBe(false);
      expect(h.audited, status).toEqual([]);
      expect(h.invalidated, status).toEqual([]);
    }
  });

  it("is a no-op for a row that is gone", async () => {
    const h = harness([]);
    expect(await h.service.markServing(ctx, row.id)).toBe(false);
  });

  it("no DNS verdict can reach `active`, however good", async () => {
    // The other half of the same fix: `check()` is the DNS path and it must never promote.
    const h = harness([row]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    for (let i = 0; i < 5; i++) {
      expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    }
    expect(h.audited).toEqual([]);
  });
});

/*
 * A refused promotion is a failed attempt (E2.1 M7).
 *
 * The 23505 catch path called `recordAttempt` with `consecutiveFailures` unincremented, and
 * `nextState`'s deadline only applies when `ok === false` — so a row whose verdict was `ok` and
 * whose promotion was permanently refused never reached `failed`. Its backoff never grew, and
 * past 72 h `isDueForVerify` bypasses backoff entirely: ~1 150 DoH queries a day against the
 * customer's nameservers, forever, with nothing in the audit log to tell an operator why.
 */
describe("a permanently refused promotion", () => {
  const row = rowOf({ hostname: "investors.acme.com" });

  it("counts the attempt, so the backoff actually grows", async () => {
    const h = harness([row]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.fake.fail("dns_ok", "custom_domain_claim_idx");
    expect((await h.service.check(ctx, row.id))?.consecutiveFailures).toBe(1);
    expect((await h.service.check(ctx, row.id))?.consecutiveFailures).toBe(2);
    expect((await h.service.check(ctx, row.id))?.consecutiveFailures).toBe(3);
  });

  it("reaches `failed` at the 72 h deadline instead of polling forever", async () => {
    const h = harness([row]);
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.fake.fail("dns_ok", "custom_domain_claim_idx");
    h.setNow(new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 1_000));
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("failed");
    // And an operator can see why: the audit row, and the claim named in the detail.
    expect(h.audited).toEqual(["custom_domain.failed"]);
    expect(view?.detail).toContain("already verified for another workspace");
    expect(h.invalidated).toEqual(["investors.acme.com"]);
  });

  it("still never demotes a serving row over somebody else's claim", async () => {
    const active = rowOf({ hostname: "investors.acme.com", status: "active" });
    const h = harness([active]);
    h.setDns({ cname: [TARGET], txt: [active.token] });
    h.fake.fail("pending", "custom_domain_claim_idx");
    h.setNow(new Date(active.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS * 10));
    expect((await h.service.check(ctx, active.id))?.status).toBe("active");
  });
});

/*
 * A CHECK violation is a 400, not a 500 (E2.1 M6).
 *
 * `normalizeHostname` is now aligned with `custom_domain_hostname_format`, so this should be
 * unreachable — but that is two regexes in two languages in two files, and when they last
 * diverged (`q.123abc` passed the validator) the violation escaped as a 500 because
 * `mapViolation` only recognised 23505.
 */
describe("a CHECK violation", () => {
  function pgCheck(constraint: string): Error {
    const inner = Object.assign(
      new Error(`new row for relation "custom_domain" violates check constraint "${constraint}"`),
      { code: "23514", constraint },
    );
    return Object.assign(new Error("Failed query"), { cause: inner });
  }

  it("becomes invalid_hostname rather than escaping as an internal error", async () => {
    const h = harness([]);
    h.fake.failWith("insert", pgCheck("custom_domain_hostname_format"));
    await expect(h.service.add(ctx, { hostname: "q.abc" })).rejects.toMatchObject({
      code: "invalid_hostname",
      details: { reason: "not_a_hostname" },
    });
  });

  it("degrades honestly for a constraint nobody has thought about yet", async () => {
    const h = harness([]);
    h.fake.failWith("insert", pgCheck("custom_domain_token_length"));
    await expect(h.service.add(ctx, { hostname: "q.abc" })).rejects.toMatchObject({
      code: "invalid_hostname",
      details: { constraint: "custom_domain_token_length" },
    });
  });

  it("leaves an error that is none of ours alone, so it is not mislabelled a 400", async () => {
    const h = harness([]);
    h.fake.failWith("insert", Object.assign(new Error("connection terminated"), { code: "57P01" }));
    await expect(h.service.add(ctx, { hostname: "q.abc" })).rejects.toThrow(
      /connection terminated/u,
    );
  });
});

/*
 * E3.10: a provider that issues the certificate itself (`cloudflare-saas`). Its `status()` is the
 * only evidence that a certificate exists, so `dns_ok → active` is its verdict — never DNS, never
 * a request that reached us (Cloudflare routes the hostname before its certificate is active).
 */
describe("check with a provider that has status() (E3.10)", () => {
  const HOSTNAME = "investors.acme.com";
  const CF_TXT: DnsInstruction = {
    type: "TXT",
    name: `_cf-custom-hostname.${HOSTNAME}`,
    value: "own-1",
    required: false,
  };
  const pending = (detail: string | null = "waiting on DCV"): CustomDomainProviderStatus => ({
    state: "pending",
    detail,
    records: [CF_TXT],
  });
  const active: CustomDomainProviderStatus = { state: "active", detail: null, records: [] };
  const ok = (h: Harness, row: CustomDomain) => h.setDns({ cname: [TARGET], txt: [row.token] });
  /** A clock that moves past `PROVIDER_RECHECK_MS` on every read, so each check asks afresh. */
  const cfHarness = (rows: readonly CustomDomain[], options: HarnessOptions = {}) =>
    harness(rows, { clockStepMs: 61_000, ...options });

  it("registers on pending → dns_ok, after the TXT proved control, and stores its records", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [], activateRecords: [CF_TXT] });
    // No proof of control yet: the provider is never asked to issue.
    h.setDns({ cname: [TARGET], txt: [] });
    await h.service.check(ctx, row.id);
    expect(h.provider.activated).toEqual([]);

    ok(h, row);
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    expect(h.provider.activated).toEqual([HOSTNAME]);
    expect(view?.providerState).toBe("pending");
    expect(view?.providerRecords).toEqual([CF_TXT]);
    expect(h.service.pollsProvider).toBe(true);
  });

  it("is never active before the provider says active, then promotes and audits", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [pending(), pending(null), active] });
    ok(h, row);
    expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    h.audited.length = 0;

    // DNS is perfect on every pass; only the provider's verdict moves the row.
    const first = await h.service.check(ctx, row.id);
    expect(first?.status).toBe("dns_ok");
    expect(first?.detail).toMatch(/waiting on DCV/u);
    // The serving path cannot promote either: a request reaching us proves nothing here.
    expect(await h.service.markServing(ctx, row.id)).toBe(false);
    expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    expect(h.audited).toEqual([]);

    const promoted = await h.service.check(ctx, row.id);
    expect(promoted?.status).toBe("active");
    expect(promoted?.activatedAt).not.toBeNull();
    expect(promoted?.providerState).toBe("active");
    expect(h.audited).toEqual(["custom_domain.activated"]);
    expect(h.provider.polled).toHaveLength(3);
  });

  it("does not consult the provider when DNS stopped verifying", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [active] });
    ok(h, row);
    await h.service.check(ctx, row.id);
    h.setDns({ cname: [TARGET], txt: [] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    expect(h.provider.polled).toEqual([]);
  });

  it("fails a dns_ok row the provider gave up on, with its reason, and deregisters it", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], {
      providerStatus: [
        {
          state: "failed",
          detail: "Cloudflare reports the custom hostname as moved.",
          records: [],
        },
      ],
    });
    ok(h, row);
    await h.service.check(ctx, row.id);
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("failed");
    expect(view?.detail).toMatch(/moved/u);
    expect(view?.providerState).toBe("failed");
    expect(h.auditRows.at(-1)).toMatchObject({
      action: "custom_domain.failed",
      outcome: "failure",
    });
    expect(h.provider.deactivated).toEqual([HOSTNAME]);

    // An admin retry registers it afresh rather than polling a hostname that no longer exists.
    const retried = await h.service.verifyNow(ctx, row.id);
    expect(retried.status).toBe("dns_ok");
    expect(h.provider.activated).toEqual([HOSTNAME, HOSTNAME]);
  });

  it("keeps a failed provider call from failing or promoting the row, and says so", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], {
      providerStatus: [new Error("Cloudflare rate limit (429): retrying in 30 s"), active],
    });
    ok(h, row);
    await h.service.check(ctx, row.id);
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("dns_ok");
    expect(view?.detail).toMatch(/could not be asked just now \(Cloudflare rate limit/u);
    expect(view?.providerState).toBe("pending");
    expect((await h.service.check(ctx, row.id))?.status).toBe("active");
  });

  it("retries a registration that failed, instead of asking for a status that cannot exist", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], {
      providerStatus: [active],
      activateErrors: [new Error("timeout")],
    });
    ok(h, row);
    const first = await h.service.check(ctx, row.id);
    expect(first?.status).toBe("dns_ok");
    expect(h.provider.activated).toEqual([HOSTNAME]);

    // Next sweep: activate again (succeeds), no status call in the same pass.
    await h.service.check(ctx, row.id);
    expect(h.provider.activated).toEqual([HOSTNAME, HOSTNAME]);
    expect(h.provider.polled).toEqual([]);
    expect((await h.service.check(ctx, row.id))?.status).toBe("active");
  });

  it("gives an active row the re-verify grace when the provider reports it failed", async () => {
    const failed: CustomDomainProviderStatus = { state: "failed", detail: "moved", records: [] };
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [active, failed, failed, failed] });
    ok(h, row);
    await h.service.check(ctx, row.id);
    expect((await h.service.check(ctx, row.id))?.status).toBe("active");
    expect((await h.service.check(ctx, row.id))?.status).toBe("active");
    expect((await h.service.check(ctx, row.id))?.status).toBe("active");
    expect((await h.service.check(ctx, row.id))?.status).toBe("pending");
  });

  it("leaves caddy-ask exactly as it was: no providerState, and serving still promotes", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row]);
    ok(h, row);
    const view = await h.service.check(ctx, row.id);
    expect(view?.providerState).toBeUndefined();
    expect(view?.providerRecords).toBeUndefined();
    expect(h.service.pollsProvider).toBe(false);
    expect(await h.service.markServing(ctx, row.id)).toBe(true);
  });
  it("stores the provider's id and addresses the hostname by it from then on (FR1)", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], {
      providerStatus: [
        pending(),
        { state: "failed", detail: "Cloudflare reports it moved.", records: [], ref: "ch-9" },
      ],
      activateRef: "ch-9",
    });
    ok(h, row);
    const registered = await h.service.check(ctx, row.id);
    expect(registered?.answer?.provider?.ref).toBe("ch-9");
    await h.service.check(ctx, row.id);
    await h.service.check(ctx, row.id);
    expect(h.provider.polledRefs).toEqual(["ch-9", "ch-9"]);
    // …and the release after the failure names it too.
    expect(h.provider.deactivatedRefs).toEqual(["ch-9"]);
  });

  it("asks the provider at most once a minute per domain; Verify now answers from the cache (FR1)", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = harness([row], { providerStatus: [pending("first answer"), active] });
    ok(h, row);
    await h.service.check(ctx, row.id);
    expect(h.provider.activated).toEqual([HOSTNAME]);
    // Same minute: no call at all, and the view carries what was stored.
    const cached = await h.service.verifyNow(ctx, row.id);
    expect(cached.status).toBe("dns_ok");
    expect(cached.providerState).toBe("pending");
    expect(h.provider.polled).toEqual([]);
    h.setNow(new Date(new Date("2026-09-02T00:00:00Z").getTime() + 59_000));
    await h.service.verifyNow(ctx, row.id);
    expect(h.provider.polled).toEqual([]);
    // A minute on: asked again.
    h.setNow(new Date(new Date("2026-09-02T00:00:00Z").getTime() + 61_000));
    expect((await h.service.verifyNow(ctx, row.id)).detail).toMatch(/first answer/u);
    expect(h.provider.polled).toEqual([HOSTNAME]);
  });

  it("queues the release in the status-change transaction instead of calling the provider (FR1)", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], {
      providerStatus: [{ state: "failed", detail: "moved", records: [], ref: "ch-3" }],
      activateRef: "ch-3",
      queue: true,
    });
    ok(h, row);
    await h.service.check(ctx, row.id);
    expect((await h.service.check(ctx, row.id))?.status).toBe("failed");
    expect(h.provider.deactivated).toEqual([]);
    expect(h.queued).toEqual([
      {
        name: "domains.provider-release",
        data: { workspaceId: WS, domainId: row.id, hostname: HOSTNAME, ref: "ch-3" },
      },
    ]);
    // Removal: the same job, from the soft-delete transaction.
    expect(await h.service.remove(ctx, row.id)).toBe(true);
    expect(h.provider.deactivated).toEqual([]);
    expect(h.queued).toHaveLength(2);
    expect(h.queued[1]?.data).toMatchObject({ hostname: HOSTNAME, ref: "ch-3" });
  });
  it("takes the hostname lock before every registration, so an in-flight release finishes first (FR3)", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [], activateErrors: [new Error("timeout")] });
    ok(h, row);
    await h.service.check(ctx, row.id); // pending → dns_ok, registration fails
    await h.service.check(ctx, row.id); // the sweep retries it
    expect(h.provider.order).toEqual([
      `activate ${HOSTNAME} after 1 lock(s)`,
      `activate ${HOSTNAME} after 2 lock(s)`,
    ]);
    expect(h.fake.locks).toEqual([HOSTNAME, HOSTNAME]);
  });

  it("tells the provider whose call it is: the workspace, and sweep vs Verify now (FR3)", async () => {
    const row = rowOf({ hostname: HOSTNAME });
    const h = cfHarness([row], { providerStatus: [pending(), pending()], activateRef: "ch-1" });
    ok(h, row);
    await h.service.check(ctx, row.id);
    await h.service.check(ctx, row.id);
    await h.service.verifyNow(ctx, row.id);
    expect(h.provider.contexts).toEqual([
      `activate background ${WS}`,
      `status background ${WS}`,
      `status interactive ${WS}`,
    ]);
  });
});

describe("the cell directory's hostname claim (E3.11)", () => {
  const row = rowOf({ hostname: "investors.acme.com" });

  it("claims before promoting to dns_ok, and keeps the claim", async () => {
    const directory = { claim: "claimed" as const, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    expect(directory.calls).toEqual([`claim investors.acme.com ${WS}`]);
  });

  it("refuses the promotion when another cell's workspace holds it, never naming it", async () => {
    const directory = { claim: "taken" as const, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.detail).toContain("already verified for another workspace");
    expect(view?.detail).not.toContain(OTHER_WS);
    // A refused promotion is a failed attempt (E2.1 M7), not a free retry.
    expect(view?.consecutiveFailures).toBe(1);
    expect(h.audited).toEqual([]);
    expect(h.provider.activated).toEqual([]);
    expect(directory.calls).toEqual([`claim investors.acme.com ${WS}`]);
  });

  it("fails the domain at the deadline when the directory keeps refusing it", async () => {
    const directory = { claim: "taken" as const, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.setNow(new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 1));
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("failed");
    expect(h.audited).toEqual(["custom_domain.failed"]);
  });

  it("an unreachable directory neither promotes nor counts the attempt (not a verdict)", async () => {
    const directory = { claim: new Error("connect ECONNREFUSED"), calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.consecutiveFailures).toBe(0);
    expect(view?.detail).toContain("could not be claimed just now");
    expect(view?.detail).not.toContain("ECONNREFUSED");
    // Not even past the deadline: an outage never fails a domain.
    h.setNow(new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 1));
    expect((await h.service.check(ctx, row.id))?.status).toBe("pending");
    expect(h.audited).toEqual([]);
  });

  it("says exactly what the local claim index says (R2-11): no tell of another cell", async () => {
    const remote = harness([row], { directory: { claim: "taken", calls: [] } });
    remote.setDns({ cname: [TARGET], txt: [row.token] });
    const local = harness([row]);
    local.setDns({ cname: [TARGET], txt: [row.token] });
    local.fake.fail("dns_ok", "custom_domain_claim_idx");
    const a = await remote.service.check(ctx, row.id);
    const b = await local.service.check(ctx, row.id);
    expect(a?.detail).toBe(b?.detail);
    expect(a?.detail).toContain("on this install");
  });

  it("gives the claim back when the local write is refused after it", async () => {
    const directory = { claim: "claimed" as const, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    h.fake.fail("dns_ok", "custom_domain_claim_idx");
    expect((await h.service.check(ctx, row.id))?.status).toBe("pending");
    expect(directory.calls).toEqual([
      `claim investors.acme.com ${WS}`,
      `release investors.acme.com ${WS}`,
    ]);
  });

  it("releases when a verified row is demoted, and when a verified row is removed", async () => {
    const directory = { claim: "claimed" as const, calls: [] as string[] };
    const active = rowOf({
      hostname: "investors.acme.com",
      status: "active",
      consecutiveFailures: 2,
    });
    const h = harness([active], { directory });
    h.setDns({ cname: [], txt: [] });
    expect((await h.service.check(ctx, active.id))?.status).toBe("pending");
    expect(directory.calls).toEqual([`release investors.acme.com ${WS}`]);

    const other = rowOf({ hostname: "ir.acme.com", status: "dns_ok" });
    const h2 = harness([other], { directory });
    directory.calls.length = 0;
    expect(await h2.service.remove(ctx, other.id)).toBe(true);
    expect(directory.calls).toEqual([`release ir.acme.com ${WS}`]);
  });

  it("does not touch the directory for a pending row that is removed or stays pending", async () => {
    const directory = { claim: "claimed" as const, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [], txt: [] });
    expect((await h.service.check(ctx, row.id))?.status).toBe("pending");
    expect(await h.service.remove(ctx, row.id)).toBe(true);
    expect(directory.calls).toEqual([]);
  });
});

describe("RR1-8: a missing directory entry is not an outage", () => {
  const row = rowOf({ hostname: "investors.acme.com" });
  const noEntry = () => Object.assign(new Error("no entry"), { details: { reason: "no_entry" } });

  it("repairs the entry once and claims again", async () => {
    const directory = {
      claim: noEntry() as Error,
      afterRepair: "claimed" as const,
      calls: [] as string[],
    };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    expect((await h.service.check(ctx, row.id))?.status).toBe("dns_ok");
    expect(directory.calls).toEqual([
      `claim investors.acme.com ${WS}`,
      `repair ${WS}`,
      `claim investors.acme.com ${WS}`,
    ]);
  });

  it("still missing after the repair: a counted failed attempt that reaches the deadline", async () => {
    const directory = { claim: noEntry() as Error, calls: [] as string[] };
    const h = harness([row], { directory });
    h.setDns({ cname: [TARGET], txt: [row.token] });
    const view = await h.service.check(ctx, row.id);
    expect(view?.status).toBe("pending");
    expect(view?.consecutiveFailures).toBe(1);
    h.setNow(new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS + 1));
    expect((await h.service.check(ctx, row.id))?.status).toBe("failed");
  });
});
