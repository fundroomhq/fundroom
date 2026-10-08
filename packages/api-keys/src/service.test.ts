import type { AuditRecorder } from "@fundroom/audit";
import type { Database, Membership, TenantContext } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import {
  ApiKeyError,
  createApiKeyService,
  creatorIsLive,
  decodeApiKeyCursor,
  encodeApiKeyCursor,
} from "./service.js";

/*
 * The service's pure checks (E3.4-A): every refusal that must happen before any database work,
 * the creator liveness rule, the cursor, and the in-process last-used memo. The database paths
 * are `apps/server/src/api-keys.integration.test.ts`.
 */
const WS = "01a0db00-0000-7000-8000-000000000001";
const ctx: TenantContext = {
  workspaceId: WS,
  actorKind: "staff",
  membershipId: "01a0db00-0000-7000-8000-0000000000bb",
  userId: "01a0db00-0000-7000-8000-0000000000cc",
};
const admin = {
  id: ctx.membershipId,
  kind: "staff",
  role: "admin",
  status: "active",
  expiresAt: null,
} as unknown as Membership;

function service(options: { now?: () => Date } = {}) {
  let transactions = 0;
  const db = {
    withTenant: async () => {
      transactions += 1;
      return false;
    },
  } as unknown as Database;
  const svc = createApiKeyService({
    db,
    audit: {} as AuditRecorder,
    hasPermission: (m, p) => m.role === "admin" && p !== "crm.manage",
    scopeCatalogue: () => [
      { id: "access.read", description: "People" },
      { id: "crm.manage", description: "CRM" },
    ],
    now: options.now,
  });
  return { svc, transactions: () => transactions };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ApiKeyError) return { code: error.code, reason: error.details["reason"] };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("createApiKeyService: refusals before any database work", () => {
  it("a scope no key-callable route needs is scope_not_offered", async () => {
    const { svc, transactions } = service();
    expect(await refusal(svc.create(ctx, admin, { name: "k", scopes: ["access.manage"] }))).toEqual(
      { code: "validation_failed", reason: "scope_not_offered" },
    );
    expect(transactions()).toBe(0);
  });

  it("a scope the caller does not hold is scope_not_held (create and rotate check the same)", async () => {
    const { svc, transactions } = service();
    expect(
      await refusal(svc.create(ctx, admin, { name: "k", scopes: ["access.read", "crm.manage"] })),
    ).toEqual({ code: "validation_failed", reason: "scope_not_held" });
    expect(transactions()).toBe(0);
  });

  it("expiry must be in the future and at most two years ahead", async () => {
    const at = new Date("2026-09-25T12:00:00Z");
    const { svc } = service({ now: () => at });
    const base = { name: "k", scopes: ["access.read"] };
    for (const expiresAt of [
      new Date(at.getTime() - 1),
      at,
      new Date(at.getTime() + 3 * 366 * 86_400_000),
      new Date(Number.NaN),
    ]) {
      expect(await refusal(svc.create(ctx, admin, { ...base, expiresAt }))).toEqual({
        code: "validation_failed",
        reason: "invalid_expiry",
      });
    }
  });

  it("names and notes are bounded; an empty scope list is refused", async () => {
    const { svc } = service();
    expect(
      (await refusal(svc.create(ctx, admin, { name: "   ", scopes: ["access.read"] }))).reason,
    ).toBe("invalid_name");
    expect(
      (
        await refusal(
          svc.create(ctx, admin, { name: "k", scopes: ["access.read"], note: "x".repeat(501) }),
        )
      ).reason,
    ).toBe("invalid_note");
    expect((await refusal(svc.create(ctx, admin, { name: "k", scopes: [] }))).reason).toBe(
      "scopes_empty",
    );
  });

  it("rotate refuses a grace outside 0..168 hours; a malformed id is not_found", async () => {
    const { svc, transactions } = service();
    const id = "01a0db00-0000-7000-8000-0000000000aa";
    for (const grace of [-1, 169, 1.5])
      expect((await refusal(svc.rotate(ctx, admin, id, grace))).reason).toBe("invalid_grace");
    expect((await refusal(svc.rotate(ctx, admin, "nope"))).code).toBe("not_found");
    expect((await refusal(svc.revoke(ctx, "nope"))).code).toBe("not_found");
    expect((await refusal(svc.update(ctx, "nope", { name: "x" }))).code).toBe("not_found");
    expect(transactions()).toBe(0);
  });

  it("a malformed token is never looked up", async () => {
    const { svc, transactions } = service();
    for (const token of [
      "",
      "shk_",
      "shk_short",
      "frk_short",
      `Bearer shk_${"A".repeat(43)}`,
      `Bearer frk_${"A".repeat(43)}`,
      `shk_${"!".repeat(43)}`,
      `frs_${"A".repeat(43)}`,
    ])
      expect(await svc.authenticate(WS, token)).toBeUndefined();
    expect(transactions()).toBe(0);
  });

  it("a bad list cursor is refused", async () => {
    const { svc } = service();
    expect((await refusal(svc.list(ctx, { cursor: "!!", limit: 10 }))).reason).toBe(
      "invalid_cursor",
    );
  });
});

describe("scopes", () => {
  it("lists every offered scope with whether the caller holds it", () => {
    const { svc } = service();
    expect(svc.scopes(admin)).toEqual([
      { id: "access.read", description: "People", held: true },
      { id: "crm.manage", description: "CRM", held: false },
    ]);
  });
});

describe("creatorIsLive", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const m = (over: Partial<Membership>) =>
    ({ kind: "staff", status: "active", expiresAt: null, ...over }) as Membership;
  it("only an active, unexpired staff membership lends a key authority", () => {
    expect(creatorIsLive(m({}), now)).toBe(true);
    expect(creatorIsLive(m({ expiresAt: new Date(now.getTime() + 1) }), now)).toBe(true);
    expect(creatorIsLive(m({ expiresAt: now }), now)).toBe(false);
    for (const status of ["dormant", "suspended", "revoked", "invited"] as const)
      expect(creatorIsLive(m({ status: status as never }), now), status).toBe(false);
    expect(creatorIsLive(m({ kind: "external" }), now)).toBe(false);
    expect(creatorIsLive(undefined, now)).toBe(false);
  });
});

describe("cursor", () => {
  it("round-trips a uuid and refuses anything else", () => {
    const id = "01a0db00-0000-7000-8000-0000000000aa";
    expect(decodeApiKeyCursor(encodeApiKeyCursor(id))).toBe(id);
    expect(decodeApiKeyCursor(encodeApiKeyCursor("not-a-uuid"))).toBeUndefined();
    expect(decodeApiKeyCursor(`${encodeApiKeyCursor(id)}A`)).toBeUndefined();
    expect(decodeApiKeyCursor("")).toBeUndefined();
  });
});

describe("touchLastUsed", () => {
  it("writes at most once a minute per key per process; a failed write is retried next time", async () => {
    let t = 0;
    let writes = 0;
    let fail = false;
    const db = {
      withTenant: async () => {
        writes += 1;
        if (fail) throw new Error("db down");
        return true;
      },
    } as unknown as Database;
    const logs: string[] = [];
    const svc = createApiKeyService({
      db,
      audit: {} as AuditRecorder,
      hasPermission: () => true,
      scopeCatalogue: () => [],
      now: () => new Date(t),
      log: (e) => logs.push(e),
    });
    const key = "01a0db00-0000-7000-8000-0000000000aa";
    await svc.touchLastUsed(WS, key, "203.0.113.9");
    await svc.touchLastUsed(WS, key, "203.0.113.9");
    t = 59_999;
    await svc.touchLastUsed(WS, key, "203.0.113.9");
    expect(writes).toBe(1);
    t = 60_000;
    fail = true;
    await svc.touchLastUsed(WS, key, "203.0.113.9");
    expect(writes).toBe(2);
    expect(logs).toEqual(["api_keys.touch_failed"]);
    fail = false;
    await svc.touchLastUsed(WS, key, "203.0.113.9");
    expect(writes).toBe(3);
    await svc.touchLastUsed(WS, "01a0db00-0000-7000-8000-0000000000ab", undefined);
    expect(writes).toBe(4);
  });
});
