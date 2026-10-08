import type { KeyRing } from "@fundroom/config";
import type { Database } from "@fundroom/db";
import type { OutboundEmail } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  accessRequestCodeEmail,
  accessRequestDeniedEmail,
  accessRequestExistingEmail,
} from "../mail/templates.js";
import {
  ACCESS_REQUEST_CODE_TTL_MS,
  ACCESS_REQUEST_START_FLOOR_MS,
  type AccessRequestWorkspace,
  accessRequestCode,
  accessRequestCodeScope,
  createAccessRequestJobs,
  createAccessRequestService,
  decodeAccessRequestCursor,
  emailDomainMatches,
  encodeAccessRequestCursor,
} from "./access-requests.js";
import { accessRequestRateKey, createMemoryRateLimiter, RATE_LIMITS } from "./rate-limiter.js";
import type { IdentityDeps } from "./types.js";

const WS = "01920000-0000-7000-8000-0000000000aa";
const clock = new Date("2026-09-25T12:00:00Z");

const keyRing = {
  current: { id: "v1", key: new Uint8Array(32).fill(7) },
  entries: [{ id: "v1", key: new Uint8Array(32).fill(7) }],
} as unknown as KeyRing;

function workspace(requests: Record<string, unknown> = { enabled: true }): AccessRequestWorkspace {
  return {
    id: WS,
    name: "Acme",
    offeringStatus: "none",
    settings: { access: { requests } },
  };
}

/** A database that counts every connection asked for and fails it: the unit tests never need one. */
function countingDb() {
  const calls = { host: 0, tenant: 0 };
  const db = {
    withHost: async () => {
      calls.host += 1;
      throw new Error("no database in unit tests");
    },
    withTenant: async () => {
      calls.tenant += 1;
      throw new Error("no database in unit tests");
    },
  } as unknown as Database;
  return { db, calls };
}

function harness(now: () => Date = () => clock) {
  const { db, calls } = countingDb();
  const sent: OutboundEmail[] = [];
  const logs: { event: string; fields?: Readonly<Record<string, unknown>> | undefined }[] = [];
  const deps = {
    db,
    keyRing,
    mailer: {
      driver: "test",
      async send(m: OutboundEmail) {
        sent.push(m);
        return { messageId: "<1@test>", acceptedAt: clock };
      },
      async healthCheck() {},
    },
    rateLimiter: createMemoryRateLimiter({ now: () => clock }),
    audit: {} as IdentityDeps["audit"],
    baseUrl: new URL("https://investors.acme.test"),
    productName: "FundRoom",
    now,
    log: (event: string, fields?: Readonly<Record<string, unknown>>) =>
      logs.push({ event, fields }),
  } as unknown as IdentityDeps;
  const service = createAccessRequestService(deps, { requestAutoApprove: () => true });
  return { service, calls, sent, logs };
}

const base = { email: "pat@fund.test", name: "Pat" };

describe("access request start: every outcome is the same answer", () => {
  it("a filled honeypot is a decoy that touches nothing and still takes the floor", async () => {
    const h = harness();
    const t0 = performance.now();
    const r = await h.service.start({ ...base, workspace: workspace(), honeypot: "http://spam" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(ACCESS_REQUEST_START_FLOOR_MS - 5);
    expect(r).toEqual({
      expiresAt: new Date(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS),
      throttled: null,
    });
    expect(h.calls).toEqual({ host: 0, tenant: 0 });
    expect(h.sent).toEqual([]);
  });

  it("a disabled form and a malformed address are decoys too, with the same answer", async () => {
    const h = harness();
    const off = await h.service.start({ ...base, workspace: workspace({ enabled: false }) });
    const bad = await h.service.start({ ...base, email: "not-an-address", workspace: workspace() });
    const blank = await h.service.start({ ...base, name: "   ", workspace: workspace() });
    for (const r of [off, bad, blank])
      expect(r.expiresAt.getTime()).toBe(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
    expect(h.calls).toEqual({ host: 0, tenant: 0 });
  });

  it("never throws: a database failure answers exactly like success", async () => {
    const h = harness();
    const r = await h.service.start({ ...base, workspace: workspace(), clientIp: "203.0.113.9" });
    expect(Object.keys(r).sort()).toEqual(["expiresAt", "throttled"]);
    expect(r.expiresAt.getTime()).toBe(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
    expect(h.calls.host).toBe(1);
    expect(h.sent).toEqual([]);
    // Logged for ops without the address.
    const failed = h.logs.find((l) => l.event === "auth.access_request_start_failed");
    expect(JSON.stringify(failed)).not.toContain("pat@fund.test");
  });

  it("expiresAt is the arrival instant + the code lifetime, however long the call takes (S2)", async () => {
    // A clock that moves a second on every read: any path that reads it again answers later.
    let ticks = 0;
    const h = harness(() => new Date(clock.getTime() + 1000 * ticks++));
    const real = await h.service.start({
      ...base,
      workspace: workspace(),
      clientIp: "203.0.113.9",
    });
    expect(real.expiresAt.getTime()).toBe(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
    const arrived = clock.getTime() + 1000 * ticks;
    const decoy = await h.service.start({ ...base, workspace: workspace(), honeypot: "x" });
    expect(decoy.expiresAt.getTime()).toBe(arrived + ACCESS_REQUEST_CODE_TTL_MS);
  });

  it("over the per-address limit it stops touching the database and answers the same", async () => {
    const h = harness();
    const max = RATE_LIMITS.accessRequestStartPerEmail.max;
    for (let i = 0; i < max; i++) await h.service.start({ ...base, workspace: workspace() });
    expect(h.calls.host).toBe(max);
    const over = await h.service.start({ ...base, workspace: workspace() });
    expect(over.expiresAt.getTime()).toBe(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
    // A per-address refusal is ordinary, not a security event.
    expect(over.throttled).toBeNull();
    expect(h.calls.host).toBe(max);
    // Another address is not held back by this one's bucket.
    await h.service.start({ ...base, email: "other@fund.test", workspace: workspace() });
    expect(h.calls.host).toBe(max + 1);
    expect(h.logs.some((l) => l.event === "auth.access_request_decoy")).toBe(true);
  });

  it("the address is normalised before it is counted", async () => {
    const h = harness();
    for (let i = 0; i < RATE_LIMITS.accessRequestStartPerEmail.max; i++)
      await h.service.start({ ...base, email: ` PAT@Fund.test `, workspace: workspace() });
    const before = h.calls.host;
    await h.service.start({ ...base, workspace: workspace() });
    expect(h.calls.host).toBe(before);
  });

  it("one client IP gets 20 starts an hour across addresses, then a flagged decoy (S4)", async () => {
    const h = harness();
    const max = RATE_LIMITS.accessRequestStartPerIp.max;
    expect(max).toBe(20);
    // Concurrently: every call sits out its own 250 ms floor.
    const first = await Promise.all(
      Array.from({ length: max }, (_, i) =>
        h.service.start({
          ...base,
          email: `p${i}@fund.test`,
          workspace: workspace(),
          clientIp: "203.0.113.9",
        }),
      ),
    );
    for (const r of first) expect(r.throttled).toBeNull();
    expect(h.calls.host).toBe(max);
    const over = await h.service.start({
      ...base,
      email: "fresh@fund.test",
      workspace: workspace(),
      clientIp: "203.0.113.9",
    });
    expect(over).toEqual({
      expiresAt: new Date(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS),
      throttled: "ip",
    });
    expect(h.calls.host).toBe(max);
    // Another client is unaffected.
    const other = await h.service.start({
      ...base,
      email: "fresh@fund.test",
      workspace: workspace(),
      clientIp: "198.51.100.7",
    });
    expect(other.throttled).toBeNull();
    expect(h.calls.host).toBe(max + 1);
  });

  it("the workspace budget is 1000 an hour and trips as a flagged decoy (S4)", async () => {
    const h = harness();
    expect(RATE_LIMITS.accessRequestStartPerWorkspace.max).toBe(1000);
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        h.service.start({ ...base, email: `p${i}@fund.test`, workspace: workspace() }),
      ),
    );
    const over = await h.service.start({ ...base, email: "x@fund.test", workspace: workspace() });
    expect(over.throttled).toBe("workspace");
    expect(h.calls.host).toBe(1000);
  }, 30_000);
});

describe("access request verify", () => {
  it("malformed addresses and codes are `ok: false` without a query", async () => {
    const h = harness();
    for (const [email, code] of [
      ["nope", "123456"],
      ["pat@fund.test", "12345"],
      ["pat@fund.test", "12345a"],
      ["pat@fund.test", ""],
    ] as const) {
      expect(await h.service.verify({ workspace: workspace(), email, code })).toEqual({
        ok: false,
      });
    }
    expect(h.calls).toEqual({ host: 0, tenant: 0 });
  });

  it("a database failure is the same `ok: false`", async () => {
    const h = harness();
    const r = await h.service.verify({
      workspace: workspace(),
      email: "pat@fund.test",
      code: "123456",
    });
    expect(r).toEqual({ ok: false });
    expect(h.calls.tenant).toBe(1);
  });

  it("5 attempts per address per 15 minutes, spent before any comparison", async () => {
    const h = harness();
    const max = RATE_LIMITS.accessRequestVerifyPerEmail.max;
    expect(max).toBe(5);
    expect(RATE_LIMITS.accessRequestVerifyPerEmail.windowMs).toBe(15 * 60_000);
    await Promise.all(
      Array.from({ length: max }, () =>
        h.service.verify({ workspace: workspace(), email: "pat@fund.test", code: "123456" }),
      ),
    );
    expect(h.calls.tenant).toBe(max);
    const over = await h.service.verify({
      workspace: workspace(),
      email: " PAT@fund.test",
      code: "654321",
    });
    expect(over).toEqual({ ok: false });
    expect(h.calls.tenant).toBe(max);
  });

  it("no workspace-wide verify budget: nobody can switch verification off for everyone (S3)", async () => {
    const h = harness();
    // Far more failed verifications than any workspace bucket would allow, spread over addresses.
    await Promise.all(
      Array.from({ length: 1200 }, (_, i) =>
        h.service.verify({ workspace: workspace(), email: `x${i}@evil.test`, code: "000000" }),
      ),
    );
    const before = h.calls.tenant;
    await h.service.verify({ workspace: workspace(), email: "pat@fund.test", code: "123456" });
    expect(h.calls.tenant).toBe(before + 1);
    expect(Object.keys(RATE_LIMITS).some((k) => /accessRequestVerifyPerWorkspace/u.test(k))).toBe(
      false,
    );
  }, 30_000);
});

describe("helpers", () => {
  it("codes are six digits, zero-padded, from the whole range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = accessRequestCode();
      expect(c).toMatch(/^[0-9]{6}$/u);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1990);
  });

  it("the code scope binds the workspace and the challenge", () => {
    expect(accessRequestCodeScope(WS, "r1")).not.toBe(accessRequestCodeScope(WS, "r2"));
    expect(accessRequestCodeScope("w1", "r1")).not.toBe(accessRequestCodeScope("w2", "r1"));
  });

  it("auto-approve domains match exactly, never a suffix or a look-alike", () => {
    expect(emailDomainMatches("pat@fund.test", ["fund.test"])).toBe(true);
    expect(emailDomainMatches("pat@FUND.test", ["fund.test"])).toBe(true);
    expect(emailDomainMatches("pat@evil-fund.test", ["fund.test"])).toBe(false);
    expect(emailDomainMatches("pat@sub.fund.test", ["fund.test"])).toBe(false);
    expect(emailDomainMatches("pat@fund.test.evil", ["fund.test"])).toBe(false);
    expect(emailDomainMatches("fund.test@evil.test", ["fund.test"])).toBe(false);
    expect(emailDomainMatches("pat@fund.test", [])).toBe(false);
  });

  it("cursors round-trip and anything else is refused", () => {
    const c = {
      createdAt: "2026-09-25T12:00:00.123456Z",
      id: "01920000-0000-7000-8000-000000000001",
    };
    expect(decodeAccessRequestCursor(encodeAccessRequestCursor(c))).toEqual(c);
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [
      "",
      "!!!",
      enc("2026-09-25T12:00:00Z|01920000-0000-7000-8000-000000000001"),
      enc("2026-09-25 12:00:00.123456+00|01920000-0000-7000-8000-000000000001"),
      enc("2026-09-25T12:00:00.123456Z|not-a-uuid"),
      enc("2026-09-25T12:00:00.123456Z|01920000-0000-7000-8000-000000000001|x"),
      enc("2026-13-45T12:00:00.123456Z|01920000-0000-7000-8000-000000000001"),
      enc("x'); DROP TABLE core.access_request; --|01920000-0000-7000-8000-000000000001"),
    ]) {
      expect(decodeAccessRequestCursor(bad), bad).toBeUndefined();
    }
  });

  it("rate-limit keys never carry the address", () => {
    const key = accessRequestRateKey("start_email", WS, "pat@fund.test");
    expect(key).not.toContain("pat");
    expect(key).not.toContain("fund.test");
    expect(key).toBe(accessRequestRateKey("start_email", WS, " PAT@fund.test"));
    expect(accessRequestRateKey("start_ws", WS)).toBe(`access_request:start_ws:${WS}`);
    const ip = accessRequestRateKey("start_ip", WS, "203.0.113.9");
    expect(ip).not.toContain("203.0.113");
    expect(accessRequestRateKey("verify_email", WS, "pat@fund.test")).not.toBe(key);
  });

  it("the sweep is an hourly kernel job", async () => {
    let swept = 0;
    const [job] = createAccessRequestJobs({
      service: {
        sweep: async () => {
          swept += 1;
          return { deleted: 0, expired: 0 };
        },
      },
    });
    expect(job?.name).toBe("access-requests.sweep");
    expect(job?.cron).toBe("23 * * * *");
    await job?.handler({} as never);
    expect(swept).toBe(1);
  });
});

describe("access request mail", () => {
  const brand = {
    productName: "FundRoom",
    workspaceName: "Acme",
    workspaceId: WS,
  };

  it("the code mail carries the code and its expiry, and says 'access', not 'sign in'", () => {
    const m = accessRequestCodeEmail("pat@fund.test", {
      ...brand,
      code: "042042",
      ttlMinutes: 10,
      expiresAt: new Date("2026-09-25T12:10:00Z"),
      name: "Pat Doe",
    });
    expect(m.subject).toContain("042042");
    expect(m.text).toContain("    042042");
    expect(m.text).toContain("access to Acme (FundRoom)");
    expect(m.text).toContain("10 minutes");
    expect(m.text.toLowerCase()).not.toContain("sign in");
    expect(m.workspaceId).toBe(WS);
    expect(m.template).toEqual({
      name: "auth.access_request_code",
      props: {
        code: "042042",
        ttlMinutes: 10,
        expiresAt: "2026-09-25T12:10:00.000Z",
        name: "Pat Doe",
      },
    });
    expect(JSON.parse(JSON.stringify(m.template?.props))).toEqual(m.template?.props);
  });

  it("the code mail restates who asked, so a stranger's request is recognisable (S6)", () => {
    const m = accessRequestCodeEmail("pat@fund.test", {
      ...brand,
      code: "042042",
      ttlMinutes: 10,
      expiresAt: new Date("2026-09-25T12:10:00Z"),
      name: "Mallory",
      firm: "Evil LP",
    });
    expect(m.text).toContain("in the name of Mallory (Evil LP)");
    expect(m.text).toContain("If this wasn't you, ignore this email");
    expect(m.template?.props).toMatchObject({ name: "Mallory", firm: "Evil LP" });
    const noFirm = accessRequestCodeEmail("pat@fund.test", {
      ...brand,
      code: "042042",
      ttlMinutes: 10,
      expiresAt: new Date("2026-09-25T12:10:00Z"),
      name: "Mallory",
    });
    expect(noFirm.text).toContain("in the name of Mallory.");
  });

  it("the 'already have access' mail links the sign-in page and nothing else", () => {
    const m = accessRequestExistingEmail("pat@fund.test", {
      ...brand,
      signInUrl: "https://investors.acme.test/login",
      locale: "en-XA",
    });
    expect(m.text).toContain("https://investors.acme.test/login");
    expect(m.template).toEqual({
      name: "auth.access_request_existing",
      props: { signInUrl: "https://investors.acme.test/login", locale: "en-XA" },
    });
    expect(m.subject).toMatch(/^⟦/u);
  });

  it("the denial is neutral: no reason, no note", () => {
    const m = accessRequestDeniedEmail("pat@fund.test", brand);
    expect(m.subject).toBe("Your request to access Acme");
    expect(m.text).toContain("not able to offer you access at this time");
    expect(m.template).toEqual({ name: "auth.access_request_denied", props: {} });
    expect(m.tags).toEqual(["auth", "access-request"]);
  });
});
