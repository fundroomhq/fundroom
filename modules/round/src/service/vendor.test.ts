import type { TenantContext, Tx } from "@fundroom/db";
import type { AccreditationServices, ModuleServices } from "@fundroom/module-kit";
import {
  AccreditationProviderError,
  type AccreditationVendorCheck,
  type AccreditationVendorStartResult,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createVendorVerificationService,
  JOB_VERIFICATION_START,
  JOB_VERIFICATION_SYNC,
  VERIFICATION_START_RATE,
} from "./vendor.js";

/*
 * The vendor side of a verification (E3.7), with the kernel standing in: a fake
 * `AccreditationServices`, a fake queue, and a fake transaction holding ONE verification row that
 * answers the statements the service issues. What is pinned here is the contract §0 behaviour —
 * a vendor is never called with a transaction open, `accredited` verifies through the legal seam
 * with a provider actor, the certificate goes through the evidence pipeline, an admin who decided
 * first wins, and a changed connection stops polling.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const MEMBER = "01920000-0000-7000-8000-0000000000d1";
const STAFF = "01920000-0000-7000-8000-0000000000d9";
const VERIFICATION = "01920000-0000-7000-8000-0000000000c1";
const SUBMISSION = "01920000-0000-7000-8000-0000000000f1";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const DAY = 86_400_000;
const staff: TenantContext = { workspaceId: WORKSPACE, actorKind: "staff", membershipId: STAFF };
const external: TenantContext = {
  workspaceId: WORKSPACE,
  actorKind: "external",
  membershipId: MEMBER,
};

interface Chunk {
  readonly queryChunks?: unknown[];
  readonly value?: unknown;
  readonly encoder?: unknown;
}

/** The statement's text and, in order, its bound parameters. */
function parse(node: unknown, out = { text: [] as string[], params: [] as unknown[] }) {
  const c = node as Chunk;
  for (const k of c.queryChunks ?? []) {
    if (k !== null && typeof k === "object" && Array.isArray((k as Chunk).queryChunks)) {
      parse(k, out);
    } else if (k !== null && typeof k === "object" && "encoder" in (k as Chunk)) {
      out.params.push((k as Chunk).value);
    } else if (
      k !== null &&
      typeof k === "object" &&
      !(k instanceof Date) &&
      Array.isArray((k as Chunk).value)
    ) {
      out.text.push(...((k as Chunk).value as string[]));
    } else {
      out.params.push(k);
    }
  }
  return out;
}

interface Row {
  readonly [k: string]: unknown;
  readonly id: string;
  readonly status: string;
  readonly checkAttempts: number;
  readonly providerRef: unknown;
  readonly vendorStatus: unknown;
  readonly evidenceNote: unknown;
  readonly evidenceKey: unknown;
  readonly vendorError: unknown;
  readonly nextCheckAt: unknown;
}

const vrow = (over: Record<string, unknown> = {}): Row => ({
  id: VERIFICATION,
  membershipId: MEMBER,
  interestSubmissionId: SUBMISSION,
  provider: "verifyinvestor",
  providerRef: "inv:42",
  method: null,
  status: "pending",
  evidenceKey: null,
  evidenceSha256: null,
  evidenceContentType: null,
  evidenceBytes: null,
  evidenceNote: null,
  evidenceUploadedAt: null,
  evidencePurgedAt: null,
  evidenceEncryption: null,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  expiresAt: null,
  vendorStatus: null,
  vendorError: null,
  vendorCheckedAt: null,
  nextCheckAt: null,
  checkAttempts: 0,
  handoff: null,
  decidedByProvider: null,
  reverificationOf: null,
  reminderSentAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

interface HarnessOptions {
  readonly row?: Record<string, unknown> | null | undefined;
  /** The row a decision finds once it takes the lock (an admin decided in between). */
  readonly lockedRow?: Record<string, unknown> | undefined;
  readonly check?: AccreditationVendorCheck | Error | undefined;
  readonly start?: AccreditationVendorStartResult | Error | undefined;
  readonly certificate?: Uint8Array | null | Error | undefined;
  readonly erased?: boolean | undefined;
  readonly email?: string | null | undefined;
  readonly displayName?: string | undefined;
  readonly allowed?: boolean | undefined;
  readonly effective?: "manual" | "verifyinvestor" | undefined;
  readonly refRows?: Record<string, unknown>[] | undefined;
  readonly invRows?: Record<string, unknown>[] | undefined;
  /** The latest expiry of an earlier verification this row renews (E3.7 fix round 1). */
  readonly previousExpiry?: Date | undefined;
  /** …and the renewed row's vendor certification date (fix round 2). */
  readonly previousVendorDecidedAt?: Date | undefined;
  /** Vendor verifications the workspace opened in the last hour. */
  readonly openedLastHour?: number | undefined;
  /** `legal.isErased` answers true from the Nth call on (1-based): an erasure mid-flight. */
  readonly erasedFromCall?: number | undefined;
  /** The row `reverification_of` names (fix round 3): its expiry and status. */
  readonly renewedRow?: { expiresAt: Date | null; status: string } | undefined;
  /** Runs while the vendor is being asked (e.g. an erasure landing mid-call). */
  readonly duringVendorCall?: ((state: { row: Row | undefined }) => void) | undefined;
  readonly memberStatus?: string | undefined;
  /** Rate-limit keys that answer "not allowed" (hit or peek). */
  readonly limited?: readonly string[] | undefined;
}

function harness(options: HarnessOptions = {}) {
  const state = {
    row: options.row === null ? undefined : vrow(options.row ?? {}),
    inTx: 0,
  };
  const audits: Record<string, unknown>[] = [];
  const events: { topic: string; payload: Record<string, unknown> }[] = [];
  const jobs: { name: string; data: Record<string, unknown>; key: string | undefined }[] = [];
  const recorded: Record<string, unknown>[] = [];
  const puts: string[] = [];
  const deleted: string[] = [];
  const statements: string[] = [];
  const vendorCalls: { kind: string; inTx: boolean; input: Record<string, unknown> }[] = [];
  let locks = 0;
  let erasedCalls = 0;
  const limits: string[] = [];

  const tx = {
    async execute(query: unknown) {
      const { text: parts, params } = parse(query);
      const text = parts.join("?").replace(/\s+/gu, " ").trim();
      // The text, then any string parameters (advisory-lock keys are parameters).
      statements.push(
        `${text} | ${params.filter((p): p is string => typeof p === "string").join(",")}`,
      );
      const row = state.row;
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM round.interest_submission")) {
        return { rows: [{ subject: "individual", entityName: null }] };
      }
      if (text.includes('expires_at AS "expiresAt", status FROM round.verification')) {
        return { rows: options.renewedRow === undefined ? [] : [options.renewedRow] };
      }
      if (text.includes("max(expires_at) AS at")) {
        return {
          rows: [
            { at: options.previousExpiry ?? null, vd: options.previousVendorDecidedAt ?? null },
          ],
        };
      }
      if (text.includes("count(*)::int AS n, min(created_at)")) {
        return { rows: [{ n: options.openedLastHour ?? 0, oldest: NOW }] };
      }
      if (text.includes("FROM core.membership")) {
        return { rows: [{ status: options.memberStatus ?? "active" }] };
      }
      if (text.includes("SELECT name FROM core.workspace")) {
        return { rows: [{ name: "Acme Robotics" }] };
      }
      if (text.includes("provider_ref = ANY(")) {
        return { rows: (options.refRows ?? []).map((r) => vrow(r)) };
      }
      if (text.includes("starts_with(provider_ref")) {
        return { rows: (options.invRows ?? []).map((r) => vrow(r)) };
      }
      if (text.startsWith("SELECT") && text.includes("FROM round.verification")) {
        if (text.includes("FOR UPDATE")) {
          locks += 1;
          if (options.lockedRow !== undefined && row !== undefined) {
            state.row = { ...row, ...options.lockedRow };
          }
        }
        if (text.includes("status = 'pending'") && state.row?.status !== "pending") {
          return { rows: [] };
        }
        return { rows: state.row === undefined ? [] : [state.row] };
      }
      if (text.startsWith("INSERT INTO round.verification")) {
        state.row = vrow({
          provider: params[3],
          providerRef: null,
          handoff: params[4] === null ? null : JSON.parse(String(params[4])),
          reverificationOf: params[5],
        });
        return { rows: [state.row] };
      }
      if (text.startsWith("UPDATE round.verification") && row !== undefined) {
        if (row.status !== "pending") return { rows: [] };
        // The erasure guard (fix round 3), as the SQL spells it.
        if (
          row.vendorError === "member_erased" &&
          text.includes("IS DISTINCT FROM 'member_erased'") &&
          !(text.includes("OR ?::text = 'member_erased'") && params[0] === "member_erased")
        ) {
          return { rows: [] };
        }
        if (text.includes("check_attempts = check_attempts + 1, next_check_at =")) {
          // beginStart: an attempt that runs, leased.
          if (row.providerRef !== null) return { rows: [] };
          if (
            text.includes("next_check_at <=") &&
            row.nextCheckAt instanceof Date &&
            row.nextCheckAt > NOW
          ) {
            return { rows: [] };
          }
          if (
            text.includes("check_attempts <") &&
            row.checkAttempts >= Number(params[params.length - 1])
          ) {
            return { rows: [] };
          }
          state.row = {
            ...row,
            checkAttempts: row.checkAttempts + 1,
            nextCheckAt: params[0] as null,
          };
          return { rows: [{ id: row.id }] };
        }
        if (text.includes("decided_by_provider =")) {
          state.row = {
            ...row,
            status: String(params[0]),
            method: params[1] as null,
            decidedByProvider: String(params[2]),
            providerRef: String(params[3]),
            vendorStatus: String(params[4]),
            vendorDecidedAt: params[6] as null,
            decidedAt: params[7] as null,
            decisionNote: params[8] as null,
            evidenceNote: (params[9] as null) ?? row.evidenceNote,
            expiresAt: params[10] as null,
            evidenceKey: (params[11] as null) ?? row.evidenceKey,
          };
        } else if (text.includes("handoff =")) {
          state.row = {
            ...row,
            providerRef: String(params[0]),
            handoff: JSON.parse(String(params[1])),
            vendorStatus: params[2] as null,
            nextCheckAt: params[4] as null,
          };
        } else if (text.includes("vendor_error =") && text.includes("check_attempts + ?")) {
          state.row = {
            ...row,
            vendorError: String(params[0]),
            checkAttempts: row.checkAttempts + Number(params[1]),
            nextCheckAt: params[2] as null,
            vendorStatus: (params[3] as null) ?? row.vendorStatus,
          };
        } else if (text.includes("check_attempts = check_attempts + 1")) {
          state.row = {
            ...row,
            vendorStatus: String(params[0]),
            providerRef: (params[1] as null) ?? row.providerRef,
            nextCheckAt: params[3] as null,
            vendorError: params[4] as null,
            checkAttempts: row.checkAttempts + 1,
          };
        } else if (text.includes("verification SET next_check_at =")) {
          state.row = { ...row, nextCheckAt: params[0] as null };
        }
        return { rows: [state.row] };
      }
      return { rows: [] };
    },
    // `publish` (outbox) and `MembershipRepo.namesFor` use drizzle's builders, not `execute`.
    insert: () => ({
      values: (v: { topic: string; payload: Record<string, unknown> }) => ({
        returning: async () => {
          events.push({ topic: v.topic, payload: v.payload });
          return [{ id: events.length }];
        },
      }),
    }),
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: a drizzle query is a thenable.
        then: (resolve: (rows: unknown[]) => void) =>
          resolve([
            {
              id: MEMBER,
              kind: "external",
              role: "investor",
              displayName: options.displayName ?? "Jane Q Investor",
              email: options.email === undefined ? "jane@example.com" : options.email,
            },
          ]),
      };
      return chain;
    },
  };

  const vendor = (kind: string, input: Record<string, unknown>) => {
    vendorCalls.push({ kind, inTx: state.inTx > 0, input });
    options.duringVendorCall?.(state);
  };

  const accreditation: AccreditationServices = {
    async effective() {
      const driver = options.effective ?? "verifyinvestor";
      return driver === "manual"
        ? {
            driver,
            label: "Manual review",
            requires: { evidenceUpload: true, adminDecision: true },
          }
        : {
            driver,
            label: "VerifyInvestor.com",
            requires: { evidenceUpload: false, adminDecision: false },
            connectionId: "01920000-0000-7000-8000-0000000000b1",
          };
    },
    async start(_ctx, input) {
      vendor("start", input as unknown as Record<string, unknown>);
      const s = options.start ?? { providerRef: "inv:42", handoff: { kind: "invite_sent" } };
      if (s instanceof Error) throw s;
      return s;
    },
    async check(_ctx, input) {
      vendor("check", input as unknown as Record<string, unknown>);
      const c = options.check ?? { status: "in_progress", vendorStatus: "waiting_for_review" };
      if (c instanceof Error) throw c;
      return c;
    },
    async fetchEvidence(_ctx, input) {
      vendor("fetchEvidence", input as unknown as Record<string, unknown>);
      const c = options.certificate === undefined ? null : options.certificate;
      if (c instanceof Error) throw c;
      return c === null ? null : { contentType: "application/pdf", bytes: c };
    },
    label: () => "VerifyInvestor.com",
  };

  const services = {
    db: {
      withTenant: async <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => {
        state.inTx += 1;
        try {
          return await fn(tx as unknown as Tx);
        } finally {
          state.inTx -= 1;
        }
      },
    },
    accreditation,
    enablement: {
      async get() {
        return { enabled: new Set(["round"]), flags: new Map() };
      },
    },
    queue: {
      async sendInTransaction(
        _tx: unknown,
        name: string,
        data: Record<string, unknown>,
        opts?: { idempotencyKey?: string },
      ) {
        jobs.push({ name, data, key: opts?.idempotencyKey });
        return "job";
      },
      async send(name: string, data: Record<string, unknown>, opts?: { idempotencyKey?: string }) {
        jobs.push({ name, data, key: opts?.idempotencyKey });
        return "job";
      },
    },
    rateLimiter: {
      async hit(key: string) {
        limits.push(`hit ${key}`);
        const allowed = (options.allowed ?? true) && !(options.limited ?? []).includes(key);
        return { allowed, remaining: 0, retryAfterMs: allowed ? 0 : 60_000 };
      },
      async peek(key: string) {
        limits.push(`peek ${key}`);
        const allowed = (options.allowed ?? true) && !(options.limited ?? []).includes(key);
        return { allowed, remaining: 0, retryAfterMs: allowed ? 0 : 60_000 };
      },
    },
    scanner: {
      async scan() {
        return { verdict: "clean", engine: "noop" };
      },
    },
    crypto: {
      async currentKey() {
        return { keyId: "key-a", keyRef: "local", key: new Uint8Array(32).fill(7) };
      },
    },
    storage: {
      async put(key: string) {
        puts.push(key);
        return { key, size: 1 };
      },
      async delete(key: string) {
        deleted.push(key);
      },
    },
    legal: {
      async isErased() {
        erasedCalls += 1;
        if (options.erasedFromCall !== undefined) return erasedCalls >= options.erasedFromCall;
        return options.erased ?? false;
      },
      async recordVerifiedAccreditation(_tx: unknown, _ctx: unknown, input: unknown) {
        recorded.push(input as Record<string, unknown>);
        return { attestationId: "att-1" };
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: Record<string, unknown>) {
        audits.push(input);
        return {};
      },
    },
    now: () => NOW,
    log: () => undefined,
  } as unknown as ModuleServices;

  return {
    services,
    svc: createVendorVerificationService(services),
    tx: tx as unknown as Tx,
    state,
    audits,
    events,
    jobs,
    recorded,
    puts,
    deleted,
    statements,
    vendorCalls,
    locks: () => locks,
    limits,
  };
}

const actions = (h: ReturnType<typeof harness>) => h.audits.map((a) => a["action"]);
const job = { workspaceId: WORKSPACE, verificationId: VERIFICATION };

describe("the start job", () => {
  it("calls the vendor with no transaction open, with the investor's name and the portal", async () => {
    const h = harness({ row: { providerRef: null } });
    await h.svc.start(job);
    expect(h.vendorCalls).toEqual([
      {
        kind: "start",
        inTx: false,
        input: {
          driver: "verifyinvestor",
          verificationId: VERIFICATION,
          subject: "individual",
          email: "jane@example.com",
          firstName: "Jane",
          lastName: "Q Investor",
          legalName: "Jane Q Investor",
          portalName: "Acme Robotics",
        },
      },
    ]);
  });

  it("stores the ref and the handoff, schedules the first check, and audits the start", async () => {
    const h = harness({ row: { providerRef: null } });
    await h.svc.start(job);
    expect(h.state.row).toMatchObject({
      providerRef: "inv:42",
      handoff: { kind: "invite_sent" },
      nextCheckAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    expect(actions(h)).toEqual(["round.verification_started"]);
    expect(h.audits[0]?.["meta"]).toMatchObject({ provider: "verifyinvestor" });
  });

  it("does nothing for a row that already started, was decided, or is manual", async () => {
    for (const row of [
      { providerRef: "inv:1" },
      { providerRef: null, status: "verified" },
      { providerRef: null, provider: "manual" },
    ]) {
      const h = harness({ row });
      await h.svc.start(job);
      expect(h.vendorCalls).toEqual([]);
    }
  });

  it("keeps the submission when the provider cannot be reached: counts, rethrows, then gives up", async () => {
    // `rate_limited` is unambiguous (nothing was created); see the timeout test for `unavailable`.
    const down = new AccreditationProviderError("slow down", "rate_limited", true, 429);
    const h = harness({ row: { providerRef: null }, start: down });
    await expect(h.svc.start(job)).rejects.toBe(down);
    expect(h.state.row).toMatchObject({
      status: "pending",
      checkAttempts: 1,
      vendorError: "rate_limited",
    });
    await expect(h.svc.start(job)).rejects.toBe(down);
    // The third attempt is the last: no throw, the row says so, and it is audited.
    await h.svc.start(job);
    expect(h.state.row).toMatchObject({ vendorStatus: "start_failed", nextCheckAt: null });
    expect(actions(h)).toEqual(["round.verification_start_failed"]);
  });

  it("gives up at once on a refusal that will not change (a driver switch)", async () => {
    const h = harness({
      row: { providerRef: null },
      start: new AccreditationProviderError("switched", "not_connected", false),
    });
    await h.svc.start(job);
    expect(h.state.row).toMatchObject({
      vendorStatus: "start_failed",
      vendorError: "connection_changed",
    });
  });

  it("refuses a vendor answer that is not a handoff it can show", async () => {
    const h = harness({
      row: { providerRef: null },
      start: { providerRef: "x", handoff: { kind: "redirect", url: "javascript:alert(1)" } },
    });
    await h.svc.start(job);
    expect(h.state.row).toMatchObject({
      vendorStatus: "start_failed",
      vendorError: "invalid_response",
    });
  });

  it("never calls the vendor for an erased member", async () => {
    const h = harness({ row: { providerRef: null }, erased: true });
    await h.svc.start(job);
    expect(h.vendorCalls).toEqual([]);
    expect(h.state.row).toMatchObject({ vendorError: "member_erased" });
  });

  it("rethrows on abort (counted once, recorded as ambiguous)", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness({ row: { providerRef: null }, start: new Error("aborted") });
    await expect(h.svc.start(job, ac.signal)).rejects.toThrow("aborted");
    expect(h.state.row).toMatchObject({ checkAttempts: 1, vendorError: "unavailable" });
  });
});

describe("the sync job", () => {
  const accredited = (over: Partial<AccreditationVendorCheck> = {}): AccreditationVendorCheck => ({
    status: "accredited",
    vendorStatus: "accredited",
    providerRef: "vr:90",
    decidedAt: new Date(NOW.getTime() - DAY),
    expiresAt: new Date(NOW.getTime() + 89 * DAY),
    ...over,
  });

  it("verifies through the legal seam with a provider actor, never a person", async () => {
    const h = harness({ check: accredited() });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "verified",
      method: "third_party",
      decidedByProvider: "verifyinvestor",
      providerRef: "vr:90",
      evidenceNote: "vendor:verifyinvestor:vr:90",
    });
    expect(h.recorded).toEqual([
      {
        membershipId: MEMBER,
        method: "third_party",
        evidenceRef: "vendor:verifyinvestor:vr:90",
        expiresAt: new Date(NOW.getTime() + 89 * DAY),
        actor: { provider: "verifyinvestor" },
      },
    ]);
    expect(actions(h)).toEqual(["round.verification_synced"]);
    expect(h.events).toEqual([
      {
        topic: "round.verification_decided",
        payload: { verificationId: VERIFICATION, membershipId: MEMBER, status: "verified" },
      },
    ]);
  });

  it("never calls the vendor inside a transaction, and passes the job's signal", async () => {
    const ac = new AbortController();
    const h = harness({ check: accredited(), certificate: new Uint8Array([1, 2, 3]) });
    await h.svc.sync(job, ac.signal);
    expect(h.vendorCalls.map((c) => [c.kind, c.inTx])).toEqual([
      ["check", false],
      ["fetchEvidence", false],
    ]);
    expect(h.vendorCalls.every((c) => c.input["signal"] === ac.signal)).toBe(true);
  });

  it("stores the certificate through the evidence pipeline and references it on the attestation", async () => {
    const h = harness({ check: accredited(), certificate: new Uint8Array([1, 2, 3]) });
    await h.svc.sync(job);
    const key = `round/verification/${WORKSPACE}/${VERIFICATION}`;
    expect(h.puts).toEqual([key]);
    expect(h.state.row).toMatchObject({ evidenceKey: key, evidenceNote: null });
    expect(h.recorded[0]?.["evidenceRef"]).toBe(`storage:${key}`);
  });

  it("falls back to the vendor note when the certificate cannot be fetched", async () => {
    const h = harness({ check: accredited(), certificate: new Error("gone") });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "verified",
      evidenceNote: "vendor:verifyinvestor:vr:90",
    });
  });

  it("clamps the vendor's expiry to twelve months and defaults a missing one to 90 days", async () => {
    const far = harness({
      check: accredited({ decidedAt: NOW, expiresAt: new Date(NOW.getTime() + 900 * DAY) }),
    });
    await far.svc.sync(job);
    expect(far.recorded[0]?.["expiresAt"]).toEqual(new Date("2027-03-15T12:00:00.000Z"));
    const none = harness({ check: accredited({ decidedAt: NOW, expiresAt: undefined }) });
    await none.svc.sync(job);
    expect(none.recorded[0]?.["expiresAt"]).toEqual(new Date(NOW.getTime() + 90 * DAY));
  });

  it("does not verify an answer that has already run out: the row is expired", async () => {
    const h = harness({ check: accredited({ expiresAt: new Date(NOW.getTime() - DAY) }) });
    await h.svc.sync(job);
    expect(h.state.row?.status).toBe("expired");
    expect(h.recorded).toEqual([]);
  });

  it("rejects on not accredited, and on a cancelled or lapsed request, keeping the vendor's word", async () => {
    for (const [status, vendorStatus] of [
      ["not_accredited", "not_accredited"],
      ["canceled", "declined_by_investor"],
      ["expired", "accepted_expire"],
    ] as const) {
      const h = harness({ check: { status, vendorStatus, rejectionReason: "no" } });
      await h.svc.sync(job);
      expect(h.state.row).toMatchObject({ status: "rejected", vendorStatus, method: null });
      expect(h.recorded).toEqual([]);
      expect(h.events[0]?.payload["status"]).toBe("rejected");
    }
  });

  it("lets an admin who decided first win, and removes the certificate nobody will reference", async () => {
    const h = harness({
      check: accredited(),
      certificate: new Uint8Array([1]),
      lockedRow: { status: "rejected", decidedBy: STAFF },
    });
    await h.svc.sync(job);
    expect(h.recorded).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.state.row?.status).toBe("rejected");
    expect(h.deleted).toEqual([`round/verification/${WORKSPACE}/${VERIFICATION}`]);
  });

  it("takes the row lock before the attestation, the audit and the outbox", async () => {
    const h = harness({ check: accredited() });
    await h.svc.sync(job);
    const lockAt = h.statements.findIndex((s) => s.includes("FOR UPDATE"));
    const decideAt = h.statements.findIndex((s) => s.includes("decided_by_provider ="));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(decideAt);
  });

  it("keeps polling an answer that settles nothing, on the backoff schedule", async () => {
    const h = harness({
      row: { checkAttempts: 2 },
      check: { status: "under_review", vendorStatus: "in_review", providerRef: "vr:90" },
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "pending",
      vendorStatus: "in_review",
      providerRef: "vr:90",
      checkAttempts: 3,
      nextCheckAt: new Date(NOW.getTime() + 6 * 3_600_000),
    });
    expect(h.audits).toEqual([]);
  });

  it("stops polling when the workspace's connection is no longer this vendor", async () => {
    const h = harness({
      check: new AccreditationProviderError("switched", "not_connected", false),
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "pending",
      vendorError: "connection_changed",
      nextCheckAt: null,
    });
  });

  it("backs off on a vendor failure instead of throwing", async () => {
    const h = harness({ check: new AccreditationProviderError("down", "unavailable", true) });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      vendorError: "unavailable",
      checkAttempts: 1,
      nextCheckAt: new Date(NOW.getTime() + 15 * 60_000),
    });
  });

  it("defers, not fails, when the job is aborted mid-call", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness({ check: new Error("aborted") });
    await h.svc.sync(job, ac.signal);
    expect(h.state.row).toMatchObject({
      vendorError: null,
      checkAttempts: 0,
      nextCheckAt: new Date(NOW.getTime() + 2 * 60_000),
    });
  });

  it("stops after 120 days pending without asking the vendor", async () => {
    const h = harness({ row: { createdAt: new Date(NOW.getTime() - 121 * DAY) } });
    await h.svc.sync(job);
    expect(h.vendorCalls).toEqual([]);
    expect(h.state.row).toMatchObject({ vendorError: "polling_stopped", nextCheckAt: null });
  });

  it("ignores a row that is manual, decided, or has no ref yet", async () => {
    for (const row of [{ provider: "manual" }, { status: "verified" }, { providerRef: null }]) {
      const h = harness({ row });
      await h.svc.sync(job);
      expect(h.vendorCalls).toEqual([]);
    }
  });
});

describe("fix round 1 (E3.7 review)", () => {
  const accredited = (over: Partial<AccreditationVendorCheck> = {}): AccreditationVendorCheck => ({
    status: "accredited",
    vendorStatus: "current",
    decidedAt: new Date(NOW.getTime() - 200 * DAY),
    expiresAt: new Date(NOW.getTime() + 20 * DAY),
    ...over,
  });

  it("does not verify a renewal with the old accreditation: it keeps polling", async () => {
    // The row renews one that stands until +20 days; the vendor answers with that same one.
    const h = harness({
      row: { reverificationOf: "01920000-0000-7000-8000-0000000000c0", checkAttempts: 1 },
      previousExpiry: new Date(NOW.getTime() + 20 * DAY),
      check: accredited(),
      certificate: new Uint8Array([1]),
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "pending",
      vendorStatus: "current",
      nextCheckAt: new Date(NOW.getTime() + 60 * 60_000),
    });
    expect(h.recorded).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.puts).toEqual([]);
  });

  it("verifies a renewal once the vendor certified after it was opened, or until later", async () => {
    const certifiedAfter = harness({
      row: { createdAt: new Date(NOW.getTime() - DAY) },
      previousExpiry: new Date(NOW.getTime() + 20 * DAY),
      check: accredited({ decidedAt: new Date(NOW.getTime() - 1000), expiresAt: undefined }),
    });
    await certifiedAfter.svc.sync(job);
    expect(certifiedAfter.state.row?.status).toBe("verified");
    // Certified after the renewed row's own certification (fix round 2: dates, not expiries).
    const later = harness({
      previousExpiry: new Date(NOW.getTime() + 20 * DAY),
      previousVendorDecidedAt: new Date(NOW.getTime() - 200 * DAY),
      check: accredited({
        decidedAt: new Date(NOW.getTime() - 30 * DAY),
        expiresAt: new Date(NOW.getTime() + 60 * DAY),
      }),
    });
    await later.svc.sync(job);
    expect(later.state.row?.status).toBe("verified");
  });

  it("holds a renewal answered with the SAME certification, even with a later expiry, and says why", async () => {
    const certified = new Date(NOW.getTime() - 200 * DAY);
    const h = harness({
      previousExpiry: new Date(NOW.getTime() + 20 * DAY),
      previousVendorDecidedAt: certified,
      check: accredited({ decidedAt: certified, expiresAt: new Date(NOW.getTime() + 160 * DAY) }),
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({ status: "pending" });
    expect(
      h.statements.some(
        (s) => s.includes("check_attempts = check_attempts + 1") && s.includes("vendor_error ="),
      ),
    ).toBe(true);
    const updated = h.statements.find((s) => s.includes("verification SET vendor_status ="));
    expect(updated).toBeDefined();
    expect(h.recorded).toEqual([]);
  });

  it("records the decision now; the vendor's certification date bounds the expiry and is audited", async () => {
    const vendorDate = new Date(NOW.getTime() - 100 * DAY);
    const h = harness({ check: accredited({ decidedAt: vendorDate, expiresAt: undefined }) });
    await h.svc.sync(job);
    expect(h.state.row?.["decidedAt"]).toEqual(NOW);
    // 90 days from the vendor's certification, not from now.
    expect(h.recorded[0]?.["expiresAt"]).toBeUndefined();
    expect(h.state.row?.status).toBe("expired");
    const fresh = harness({
      check: accredited({ decidedAt: new Date(NOW.getTime() - 10 * DAY), expiresAt: undefined }),
    });
    await fresh.svc.sync(job);
    expect(fresh.recorded[0]?.["expiresAt"]).toEqual(new Date(NOW.getTime() + 80 * DAY));
    expect(fresh.audits[0]?.["meta"]).toMatchObject({
      vendorDecidedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    });
  });

  it("reduces the handoff to its kind when the vendor decides", async () => {
    const h = harness({ check: accredited({ decidedAt: NOW, expiresAt: undefined }) });
    await h.svc.sync(job);
    const decision = h.statements.find((s) => s.includes("decided_by_provider ="));
    expect(decision).toContain("jsonb_build_object('kind', handoff->'kind')");
  });

  it("never calls the vendor to start a member who is not active", async () => {
    const h = harness({ row: { providerRef: null }, memberStatus: "suspended" });
    await h.svc.start(job);
    expect(h.vendorCalls).toEqual([]);
    expect(h.state.row).toMatchObject({
      vendorStatus: "start_failed",
      vendorError: "member_inactive",
    });
    expect(actions(h)).toEqual(["round.verification_start_failed"]);
  });

  it("retries a start at most once after an ambiguous failure (a timeout may have invited)", async () => {
    const h = harness({
      row: { providerRef: null, vendorError: "unavailable", checkAttempts: 1 },
      start: new AccreditationProviderError("timeout", "unavailable", true),
    });
    await h.svc.start(job);
    expect(h.state.row).toMatchObject({ vendorStatus: "start_failed" });
  });

  it("never asks a vendor about an imported row", async () => {
    const synced = harness({ row: { vendorError: "imported" } });
    await synced.svc.sync(job);
    const startedRow = harness({ row: { providerRef: null, vendorError: "imported" } });
    await startedRow.svc.start(job);
    expect([...synced.vendorCalls, ...startedRow.vendorCalls]).toEqual([]);
    await expect(
      harness({ row: { vendorError: "imported" } }).svc.requestCheck(staff, VERIFICATION),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  const startAsInvestor = (h: ReturnType<typeof harness>) =>
    h.svc.startForMember({
      ctx: external,
      membershipId: MEMBER,
      subject: "individual",
      reminderDays: 14,
      actor: { membershipId: MEMBER },
    });

  it("checks the member's budgets and spends them only when a verification opens", async () => {
    const daily = harness({ row: null, limited: [`round.verification_start_day:${MEMBER}`] });
    await expect(startAsInvestor(daily)).rejects.toMatchObject({ code: "rate_limited" });
    const ok = harness({ row: null });
    await startAsInvestor(ok);
    expect(ok.limits).toEqual([
      `peek round.verification_start:${MEMBER}`,
      `peek round.verification_start_day:${MEMBER}`,
      `hit round.verification_start:${MEMBER}`,
      `hit round.verification_start_day:${MEMBER}`,
    ]);
    // A 409 (pending) spends nothing.
    const pending = harness();
    await startAsInvestor(pending);
    expect(pending.limits.some((l) => l.startsWith("hit"))).toBe(false);
  });

  it("counts the workspace's vendor starts under its own lock, after the member's", async () => {
    const busy = harness({ row: null, openedLastHour: 50 });
    await expect(startAsInvestor(busy)).rejects.toMatchObject({ code: "rate_limited" });
    expect(busy.limits.some((l) => l.startsWith("hit"))).toBe(false);
    expect(busy.jobs).toEqual([]);
    const member = busy.statements.findIndex((q) => q.includes("round.verification:"));
    const workspace = busy.statements.findIndex(
      (q) => q.includes("pg_advisory_xact_lock") && q.includes("verification_starts"),
    );
    const count = busy.statements.findIndex((q) =>
      q.includes("count(*)::int AS n, min(created_at)"),
    );
    expect(member).toBeGreaterThanOrEqual(0);
    expect(member).toBeLessThan(workspace);
    expect(workspace).toBeLessThan(count);
    const under = harness({ row: null, openedLastHour: 49 });
    expect((await startAsInvestor(under)).kind).toBe("started");
  });

  it("an erasure during the vendor start stores none of the handoff and stops (late writer)", async () => {
    // isErased: false when the start begins (call 1), true once the vendor has answered (call 2).
    const h = harness({
      row: { providerRef: null },
      erasedFromCall: 2,
      start: {
        providerRef: "rec_1",
        handoff: {
          kind: "widget",
          sdk: "parallel-markets",
          config: {
            clientId: "c",
            environment: "demo",
            requiredEntityId: "rec_1",
            email: "jane@example.com",
            entityType: "self",
          },
        },
      },
    });
    await h.svc.start(job);
    expect(h.vendorCalls.map((c) => c.kind)).toEqual(["start"]);
    expect(h.state.row).toMatchObject({
      providerRef: null,
      handoff: null,
      vendorError: "member_erased",
      vendorStatus: "start_failed",
      nextCheckAt: null,
    });
    expect(actions(h)).toEqual([]);
  });

  it("an erasure during the vendor check decides nothing and removes the stored certificate", async () => {
    const h = harness({
      erasedFromCall: 2,
      check: accredited({ decidedAt: NOW, expiresAt: undefined }),
      certificate: new Uint8Array([1, 2]),
    });
    await h.svc.sync(job);
    const key = `round/verification/${WORKSPACE}/${VERIFICATION}`;
    expect(h.state.row).toMatchObject({
      status: "pending",
      vendorError: "member_erased",
      nextCheckAt: null,
    });
    expect(h.recorded).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.puts).toEqual([key]);
    expect(h.deleted).toEqual([key]);
  });

  it("the stale-start sweep counts nothing itself: only a start that ran is an attempt", async () => {
    const h = harness({
      row: { providerRef: null, checkAttempts: 0, createdAt: new Date(NOW.getTime() - DAY) },
    });
    await h.svc.syncDue({ workspaceId: WORKSPACE });
    await h.svc.syncDue({ workspaceId: WORKSPACE });
    expect(h.jobs.map((j) => j.name)).toEqual([JOB_VERIFICATION_START, JOB_VERIFICATION_START]);
    expect(h.state.row?.checkAttempts).toBe(0);
    // The start job leases and counts when it actually begins.
    await h.svc.start(job);
    expect(
      h.statements.some((q) => q.includes("check_attempts = check_attempts + 1, next_check_at =")),
    ).toBe(true);
  });

  it("wakes VerifyInvestor inv: rows newest first", async () => {
    const h = harness({ refRows: [], invRows: [] });
    await h.svc.onProviderUpdated(h.tx, external, { driver: "verifyinvestor", refs: ["vr:1"] });
    const q = h.statements.find((s) => s.includes("starts_with(provider_ref"));
    expect(q).toContain("ORDER BY created_at DESC");
  });
});

describe("fix round 3 (E3.7 re-review)", () => {
  const erase = (st: { row: Row | undefined }) => {
    if (st.row !== undefined)
      st.row = { ...st.row, vendorError: "member_erased", nextCheckAt: null };
  };

  it("an erasure during a check that settles nothing is not undone (no polling, marker kept)", async () => {
    const h = harness({
      duringVendorCall: erase,
      check: { status: "in_progress", vendorStatus: "in_review", providerRef: "vr:9" },
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      vendorError: "member_erased",
      nextCheckAt: null,
      providerRef: "inv:42",
    });
  });

  it("nor by a vendor failure, nor by an abort", async () => {
    const failed = harness({
      duringVendorCall: erase,
      check: new AccreditationProviderError("down", "unavailable", true),
    });
    await failed.svc.sync(job);
    expect(failed.state.row).toMatchObject({ vendorError: "member_erased", nextCheckAt: null });
    const ac = new AbortController();
    ac.abort();
    const aborted = harness({ duringVendorCall: erase, check: new Error("aborted") });
    await aborted.svc.sync(job, ac.signal);
    expect(aborted.state.row).toMatchObject({ vendorError: "member_erased", nextCheckAt: null });
  });

  const accredited = (over: Partial<AccreditationVendorCheck> = {}): AccreditationVendorCheck => ({
    status: "accredited",
    vendorStatus: "current",
    decidedAt: new Date(NOW.getTime() - 10 * DAY),
    expiresAt: new Date(NOW.getTime() + 80 * DAY),
    ...over,
  });

  it("a renewal of another provider's (or an expired) decision accepts an earlier certification", async () => {
    // Manual verification ran out; the workspace now uses a vendor that certified 10 days ago.
    const expired = harness({
      row: { reverificationOf: "01920000-0000-7000-8000-0000000000c0" },
      renewedRow: { expiresAt: new Date(NOW.getTime() - DAY), status: "expired" },
      check: accredited(),
    });
    await expired.svc.sync(job);
    expect(expired.state.row?.status).toBe("verified");
    // Still verified elsewhere: accepted when it stands until later…
    const later = harness({
      row: { reverificationOf: "01920000-0000-7000-8000-0000000000c0" },
      renewedRow: { expiresAt: new Date(NOW.getTime() + 5 * DAY), status: "verified" },
      check: accredited(),
    });
    await later.svc.sync(job);
    expect(later.state.row?.status).toBe("verified");
    // …and held when it does not.
    const earlier = harness({
      row: { reverificationOf: "01920000-0000-7000-8000-0000000000c0" },
      renewedRow: { expiresAt: new Date(NOW.getTime() + 100 * DAY), status: "verified" },
      check: accredited(),
    });
    await earlier.svc.sync(job);
    expect(earlier.state.row).toMatchObject({
      status: "pending",
      vendorError: "renewal_not_recertified",
    });
  });

  it("an answer with no dates never verifies a renewal of the same accreditation", async () => {
    const h = harness({
      previousExpiry: new Date(NOW.getTime() + 20 * DAY),
      check: accredited({ decidedAt: undefined, expiresAt: undefined }),
    });
    await h.svc.sync(job);
    expect(h.state.row).toMatchObject({
      status: "pending",
      vendorError: "renewal_not_recertified",
    });
    expect(h.recorded).toEqual([]);
  });

  it("a redelivered start never calls the vendor while another attempt's lease is live", async () => {
    const h = harness({
      row: { providerRef: null, nextCheckAt: new Date(NOW.getTime() + 60_000) },
    });
    await h.svc.start(job);
    expect(h.vendorCalls).toEqual([]);
  });

  it("gives up with start_timeout at the attempt cap, without calling the vendor", async () => {
    const h = harness({ row: { providerRef: null, checkAttempts: 5 } });
    await h.svc.start(job);
    expect(h.vendorCalls).toEqual([]);
    expect(h.state.row).toMatchObject({
      vendorStatus: "start_failed",
      vendorError: "start_timeout",
    });
  });

  it("an aborted start counts as ambiguous: recorded, lease released, the next abort is final", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness({ row: { providerRef: null }, start: new Error("aborted") });
    await expect(h.svc.start(job, ac.signal)).rejects.toThrow("aborted");
    expect(h.state.row).toMatchObject({
      vendorError: "unavailable",
      nextCheckAt: null,
      checkAttempts: 1,
    });
    await h.svc.start(job, ac.signal);
    expect(h.state.row).toMatchObject({ vendorStatus: "start_failed", checkAttempts: 2 });
    expect(h.vendorCalls).toHaveLength(2);
  });
});

describe("the callback wake-up", () => {
  it("enqueues one sync per matching pending row, keyed by the verification", async () => {
    const h = harness({ refRows: [{ providerRef: "vr:90" }] });
    const n = await h.svc.onProviderUpdated(h.tx, external, {
      driver: "verifyinvestor",
      refs: ["vr:90", "vr:90"],
    });
    expect(n).toBe(1);
    expect(h.jobs).toEqual([
      {
        name: JOB_VERIFICATION_SYNC,
        data: { workspaceId: WORKSPACE, verificationId: VERIFICATION },
        key: `${JOB_VERIFICATION_SYNC}:${VERIFICATION}`,
      },
    ]);
  });

  it("wakes the workspace's inv: rows when a VerifyInvestor ref matches nothing", async () => {
    const other = "01920000-0000-7000-8000-0000000000c2";
    const h = harness({ refRows: [], invRows: [{ id: other, providerRef: "inv:7" }] });
    await h.svc.onProviderUpdated(h.tx, external, { driver: "verifyinvestor", refs: ["vr:1"] });
    expect(h.jobs.map((j) => j.data["verificationId"])).toEqual([other]);
    expect(h.statements.some((s) => s.includes("starts_with(provider_ref"))).toBe(true);
  });

  it("never widens a Parallel callback beyond its refs", async () => {
    const h = harness({ refRows: [], invRows: [{ providerRef: "inv:7" }] });
    await h.svc.onProviderUpdated(h.tx, external, { driver: "parallel-markets", refs: ["x"] });
    expect(h.jobs).toEqual([]);
  });
});

describe("check now", () => {
  it("queues a sync for a pending vendor row", async () => {
    const h = harness();
    await h.svc.requestCheck(staff, VERIFICATION);
    expect(h.jobs.map((j) => j.name)).toEqual([JOB_VERIFICATION_SYNC]);
  });

  it("re-runs a start that gave up", async () => {
    const h = harness({ row: { providerRef: null, vendorStatus: "start_failed" } });
    await h.svc.requestCheck(staff, VERIFICATION);
    expect(h.jobs.map((j) => j.name)).toEqual([JOB_VERIFICATION_START]);
    expect(h.statements.some((s) => s.includes("vendor_error = NULL, vendor_status = NULL"))).toBe(
      true,
    );
  });

  it("refuses a manual row and a decided one", async () => {
    await expect(
      harness({ row: { provider: "manual" } }).svc.requestCheck(staff, VERIFICATION),
    ).rejects.toMatchObject({ code: "verification_not_vendor" });
    await expect(
      harness({ row: { status: "verified" } }).svc.requestCheck(staff, VERIFICATION),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      harness({ row: null }).svc.requestCheck(staff, VERIFICATION),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("the investor starting a verification", () => {
  const start = (h: ReturnType<typeof harness>) =>
    h.svc.startForMember({
      ctx: external,
      membershipId: MEMBER,
      subject: "entity",
      reminderDays: 14,
      actor: { membershipId: MEMBER },
    });

  it("is five an hour per member, refused before anything is read", async () => {
    expect(VERIFICATION_START_RATE).toEqual({ max: 5, windowMs: 3_600_000 });
    const h = harness({ limited: [`round.verification_start:${MEMBER}`] });
    await expect(start(h)).rejects.toMatchObject({ code: "rate_limited" });
    expect(h.statements).toEqual([]);
  });

  it("answers the pending one instead of opening a second", async () => {
    const h = harness();
    const result = await start(h);
    expect(result.kind).toBe("pending");
    expect(h.jobs).toEqual([]);
    expect(h.statements[0]).toContain("pg_advisory_xact_lock");
  });

  it("opens a vendor verification and enqueues its start in the same transaction", async () => {
    const h = harness({ row: null });
    const result = await start(h);
    expect(result.kind).toBe("started");
    expect(h.state.row).toMatchObject({ provider: "verifyinvestor", handoff: null });
    expect(h.jobs).toEqual([
      {
        name: JOB_VERIFICATION_START,
        data: { workspaceId: WORKSPACE, verificationId: VERIFICATION, subject: "entity" },
        key: `${JOB_VERIFICATION_START}:${VERIFICATION}`,
      },
    ]);
    expect(actions(h)).toEqual(["round.verification_requested"]);
    expect(h.events.map((e) => e.topic)).toEqual(["round.verification_requested"]);
    expect(h.vendorCalls).toEqual([]);
  });

  it("opens a manual one with the upload handoff and no job", async () => {
    const h = harness({ row: null, effective: "manual" });
    await start(h);
    expect(h.state.row).toMatchObject({ provider: "manual", handoff: { kind: "upload" } });
    expect(h.jobs).toEqual([]);
  });
});
