import type { ApiKeyService, AuthenticatedApiKey } from "@fundroom/api-keys";
import type { AuthzService } from "@fundroom/authz";
import type { Membership } from "@fundroom/db";
import type { RateLimitDecision, RateLimiterPort } from "@fundroom/ports";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { currentApiKeyId } from "../api-key-context.js";
import type { AppEnv } from "../env.js";
import { apiKeyResolution, requireAuthLevel, requireFreshAuth, requireSession } from "./auth.js";
import { requireMember, requireOwnerOrAdmin, requirePermission } from "./authz.js";
import { apiErrorHandler } from "./errors.js";

/*
 * The bearer resolver and the guards' key path (E3.4-A), without a database: a fake key service
 * and rate limiter behind a real Hono chain. The integration file
 * (`api-keys.integration.test.ts`) proves the same rules end to end; this pins the branches that
 * are awkward to reach there (the security-event mark, the embed tree, every guard's refusal).
 */
const WS = "01a0db00-0000-7000-8000-000000000001";
const TOKEN = `frk_${"A".repeat(43)}`;
const KEY_ID = "01a0db00-0000-7000-8000-0000000000aa";

const creator = {
  id: "01a0db00-0000-7000-8000-0000000000bb",
  userId: "01a0db00-0000-7000-8000-0000000000cc",
  workspaceId: WS,
  kind: "staff",
  role: "legal",
  status: "active",
  expiresAt: null,
} as unknown as Membership;

const hit: AuthenticatedApiKey = {
  key: {
    id: KEY_ID,
    workspaceId: WS,
    name: "k",
    prefix: TOKEN.slice(0, 12),
    scopes: ["access.read", "audit.export"],
    createdByMembershipId: creator.id,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    lastUsedAt: null,
    lastUsedIp: null,
    note: null,
  },
  creator,
};

// The fake RBAC: the creator (`legal`) holds access.read and audit.read, not audit.export.
const authz = {
  hasPermission: (m: { role: string }, p: string) =>
    m.role === "legal" && (p === "access.read" || p === "audit.read"),
} as unknown as AuthzService;

function build(
  options: {
    authenticate?: (ws: string, token: string) => Promise<AuthenticatedApiKey | undefined>;
    budget?: RateLimitDecision;
  } = {},
) {
  const touched: string[] = [];
  const service = {
    authenticate: options.authenticate ?? (async (_ws, t) => (t === TOKEN ? hit : undefined)),
    touchLastUsed: async (_ws: string, id: string) => {
      touched.push(id);
    },
  } as unknown as ApiKeyService;
  const limiter = {
    hit: async () => options.budget ?? { allowed: true, remaining: 1, retryAfterMs: 0 },
  } as unknown as RateLimiterPort;
  const app = new Hono<AppEnv>();
  app.onError(apiErrorHandler(() => {}));
  app.use("*", async (c, next) => {
    const embed = c.req.header("x-embed") === "1";
    c.set("classification", {
      tree: c.req.header("x-tree") === "app" ? "app" : "api",
      host: "tenant",
      slug: "acme",
      path: c.req.path,
      embed,
    });
    c.set("embed", embed);
    c.set("workspace", { id: WS, settings: {} } as never);
    await next();
  });
  app.use(
    "*",
    apiKeyResolution({
      service: () => service,
      rateLimiter: () => limiter,
      clientIp: () => "203.0.113.9",
    }),
  );
  let seen: Record<string, unknown> = {};
  const probe = (c: import("hono").Context<AppEnv>) => {
    seen = {
      membership: c.get("membership")?.id,
      tenant: c.get("tenant"),
      apiKey: c.get("apiKey")?.id,
      als: currentApiKeyId(),
      mark: c.get("securityEvent"),
    };
    return c.json({ ok: true });
  };
  const opts = { authz: () => authz };
  app.get("/open", probe);
  app.get("/key", requirePermission(opts, "access.read", { apiKey: true }), probe);
  app.get("/key-audit", requirePermission(opts, "audit.read", { apiKey: true }), probe);
  app.get("/key-export", requirePermission(opts, "audit.export", { apiKey: true }), probe);
  app.get("/nokey", requirePermission(opts, "access.read"), probe);
  app.get("/fresh", requirePermission(opts, "access.read", { apiKey: true, fresh: true }), probe);
  app.get("/session", requireSession(), probe);
  app.get("/member", requireMember(), probe);
  app.get("/owner", requireOwnerOrAdmin(), probe);
  app.get("/level", requireAuthLevel(1), probe);
  app.get("/recent", requireFreshAuth(), probe);
  const send = async (path: string, headers: Record<string, string> = {}) => {
    seen = {};
    const res = await app.request(`http://acme.test${path}`, { headers });
    const body = (await res.json()) as { error?: { code: string; reason?: string } };
    return { status: res.status, body, seen: { ...seen }, res };
  };
  return { send, touched, markOf: () => seen["mark"] };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("the bearer resolver", () => {
  it("admits a key on an apiKey route as its creator, inside the key's async context", async () => {
    const { send, touched } = await build();
    const r = await send("/key", auth);
    expect(r.status).toBe(200);
    expect(r.seen).toMatchObject({
      membership: creator.id,
      apiKey: KEY_ID,
      als: KEY_ID,
      tenant: {
        workspaceId: WS,
        actorKind: "staff",
        membershipId: creator.id,
        userId: creator.userId,
      },
    });
    expect(touched).toEqual([KEY_ID]);
  });

  it("sets no membership or tenant for a route that does not admit the key", async () => {
    const { send } = await build();
    const r = await send("/open", auth);
    expect(r.status).toBe(200);
    expect(r.seen).toMatchObject({ apiKey: KEY_ID, membership: undefined, tenant: undefined });
    expect(r.seen["als"]).toBeUndefined();
  });

  it("refuses the key on every guard but an apiKey requirePermission (401 api_key_not_allowed)", async () => {
    const { send } = await build();
    for (const path of ["/nokey", "/fresh", "/session", "/member", "/owner", "/level", "/recent"]) {
      const r = await send(path, auth);
      expect(r.status, path).toBe(401);
      expect(r.body.error, path).toMatchObject({
        code: "unauthenticated",
        reason: "api_key_not_allowed",
      });
    }
  });

  it("403 scope_missing when the scope is absent or the creator's role lacks it", async () => {
    const { send } = await build();
    // Held by the creator, not a scope of the key.
    const notScoped = await send("/key-audit", auth);
    expect(notScoped.status).toBe(403);
    expect(notScoped.body.error).toMatchObject({ code: "forbidden", reason: "scope_missing" });
    // A scope of the key, not held by the creator's current role.
    const notHeld = await send("/key-export", auth);
    expect(notHeld.status).toBe(403);
    expect(notHeld.body.error?.reason).toBe("scope_missing");
  });

  it("an unknown key is 401 invalid_api_key with a security event naming only the prefix", async () => {
    const { send } = await build({ authenticate: async () => undefined });
    const r = await send("/key", auth);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "unauthenticated", reason: "invalid_api_key" });
    expect(r.seen).toEqual({});
  });

  it("marks api_key_rejected with the display prefix, never the token", async () => {
    const marks: unknown[] = [];
    const service = { authenticate: async () => undefined } as unknown as ApiKeyService;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("classification", { tree: "api" } as never);
      c.set("embed", false);
      c.set("workspace", { id: WS } as never);
      await next();
      marks.push(c.get("securityEvent"));
    });
    app.use(
      "*",
      apiKeyResolution({
        service: () => service,
        rateLimiter: () => ({}) as RateLimiterPort,
        clientIp: () => undefined,
      }),
    );
    app.get("/x", (c) => c.text("no"));
    await app.request("http://acme.test/x", { headers: auth });
    await app.request("http://acme.test/x", { headers: { authorization: "Bearer shk_bad" } });
    expect(marks[0]).toEqual({
      event: "api_key_rejected",
      code: "unauthenticated",
      reason: "invalid_api_key",
      keyPrefix: TOKEN.slice(0, 12),
    });
    expect(JSON.stringify(marks[0])).not.toContain(TOKEN);
    expect(marks[1]).toEqual({
      event: "api_key_rejected",
      code: "unauthenticated",
      reason: "invalid_api_key",
    });
  });

  it("a session cookie with a key is 400 ambiguous_credentials, before any lookup", async () => {
    let looked = false;
    const { send } = await build({
      authenticate: async () => {
        looked = true;
        return hit;
      },
    });
    const r = await send("/key", { ...auth, cookie: "__Host-sid=whatever" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({
      code: "validation_failed",
      reason: "ambiguous_credentials",
    });
    expect(looked).toBe(false);
  });

  it("the embed tree refuses keys; other trees and other bearer values are ignored", async () => {
    const { send } = await build();
    const embed = await send("/key", { ...auth, "x-embed": "1" });
    expect(embed.status).toBe(401);
    expect(embed.body.error?.reason).toBe("api_key_not_allowed");
    // A page request: the resolver does not run, so the key is simply not a credential.
    const page = await send("/key", { ...auth, "x-tree": "app" });
    expect(page.status).toBe(401);
    expect(page.body.error?.reason).toBeUndefined();
    const other = await send("/key", { authorization: "Bearer metrics-token" });
    expect(other.status).toBe(401);
    expect(other.body.error?.reason).toBeUndefined();
  });

  it("429 with Retry-After once the key's budget is spent", async () => {
    const { send, touched } = await build({
      budget: { allowed: false, remaining: 0, retryAfterMs: 12_300 },
    });
    const r = await send("/key", auth);
    expect(r.status).toBe(429);
    expect(r.res.headers.get("retry-after")).toBe("13");
    expect(r.body.error?.code).toBe("rate_limited");
    expect(touched).toEqual([]);
  });
});
