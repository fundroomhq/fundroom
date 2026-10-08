import type { AuthenticatedSession, AuthPort } from "@fundroom/ports";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type AuthEnv,
  clearSessionCookies,
  csrfMiddleware,
  issueAuthRequestCookie,
  issueSessionCookies,
  requireAuthLevel,
  requireFreshAuth,
  requireSession,
  sessionMiddleware,
} from "./index.js";

const NOW = new Date("2026-09-10T12:00:00Z");

function session(overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession {
  return {
    sessionId: "s1",
    userId: "u1",
    deviceId: "d1",
    population: "external",
    context: "first_party",
    authLevel: 1,
    authTime: NOW,
    createdAt: NOW,
    idleExpiresAt: new Date(NOW.getTime() + 3600_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000),
    lastWorkspaceId: undefined,
    user: { displayName: "Alice", mfaEnrolled: false },
    ...overrides,
  };
}

function fakeAuth(valid: Record<string, AuthenticatedSession>): Pick<AuthPort, "resolveSession"> {
  return { resolveSession: async (token) => valid[token] };
}

function app(
  auth: Pick<AuthPort, "resolveSession">,
  mode: "first_party" | "partitioned" = "first_party",
) {
  const a = new Hono<AuthEnv>();
  a.use("*", sessionMiddleware({ auth, cookieMode: () => mode }));
  a.use("*", csrfMiddleware({ selfOrigin: "https://portal.example" }));
  a.get("/me", (c) => c.json({ session: c.get("session") ?? null }));
  a.post("/mutate", requireSession(), (c) => c.json({ ok: true }));
  a.post("/admin", requireAuthLevel(2), (c) => c.json({ ok: true }));
  a.post(
    "/export",
    requireFreshAuth(600_000, () => new Date(NOW.getTime() + 1_000)),
    (c) => c.json({ ok: true }),
  );
  a.post("/login", (c) => {
    issueSessionCookies(c, {
      token: "tok".padEnd(43, "x"),
      deviceToken: "dev".padEnd(43, "y"),
      mode,
      maxAgeSeconds: 100,
    });
    return c.json({ ok: true });
  });
  a.post("/link", (c) => {
    issueAuthRequestCookie(c, { bindingToken: "bind", maxAgeSeconds: 900, mode });
    return c.json({ ok: true });
  });
  a.post("/logout", (c) => {
    clearSessionCookies(c, { mode, clearDevice: true });
    return c.json({ ok: true });
  });
  return a;
}

const TOKEN = "t".repeat(43);

describe("sessionMiddleware", () => {
  it("resolves the cookie for the current mode into c.get('session')", async () => {
    const a = app(fakeAuth({ [TOKEN]: session() }));
    const res = await a.request("/me", { headers: { cookie: `__Host-sid=${TOKEN}` } });
    const body = (await res.json()) as { session: { userId: string } | null };
    expect(body.session?.userId).toBe("u1");
    const wrongMode = await a.request("/me", { headers: { cookie: `__Secure-sid=${TOKEN}` } });
    expect(((await wrongMode.json()) as { session: unknown }).session).toBeNull();
    const unknown = await a.request("/me", { headers: { cookie: "__Host-sid=nope" } });
    expect(((await unknown.json()) as { session: unknown }).session).toBeNull();
  });
});

describe("csrfMiddleware", () => {
  it("rejects a cross-site POST that carries cookies and allows same-origin", async () => {
    const a = app(fakeAuth({ [TOKEN]: session() }));
    const bad = await a.request("/mutate", {
      method: "POST",
      headers: {
        cookie: `__Host-sid=${TOKEN}`,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({
      error: {
        code: "csrf_rejected",
        message: "request rejected (cross-site)",
        reason: "cross-site",
      },
    });
    const good = await a.request("/mutate", {
      method: "POST",
      headers: { cookie: `__Host-sid=${TOKEN}`, "sec-fetch-site": "same-origin" },
    });
    expect(good.status).toBe(200);
  });

  it("skips the check for cookie-less requests (bearer API clients)", async () => {
    const a = app(fakeAuth({}));
    const res = await a.request("/mutate", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    // Not CSRF-rejected; it fails later for lack of a session.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthenticated", message: "sign in to continue" },
    });
  });
});

describe("step-up guards", () => {
  it("requireAuthLevel reports the level gap", async () => {
    const a = app(fakeAuth({ [TOKEN]: session({ authLevel: 1 }) }));
    const res = await a.request("/admin", {
      method: "POST",
      headers: { cookie: `__Host-sid=${TOKEN}`, origin: "https://portal.example" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "step_up_required",
        message: "stronger authentication required",
        reason: "level",
        requiredLevel: 2,
        currentLevel: 1,
      },
    });
    const ok = await app(fakeAuth({ [TOKEN]: session({ authLevel: 2 }) })).request("/admin", {
      method: "POST",
      headers: { cookie: `__Host-sid=${TOKEN}`, origin: "https://portal.example" },
    });
    expect(ok.status).toBe(200);
  });

  it("requireFreshAuth compares auth_time against the max age", async () => {
    const fresh = await app(fakeAuth({ [TOKEN]: session() })).request("/export", {
      method: "POST",
      headers: { cookie: `__Host-sid=${TOKEN}`, origin: "https://portal.example" },
    });
    expect(fresh.status).toBe(200);
    const stale = await app(
      fakeAuth({ [TOKEN]: session({ authTime: new Date(NOW.getTime() - 3600_000) }) }),
    ).request("/export", {
      method: "POST",
      headers: { cookie: `__Host-sid=${TOKEN}`, origin: "https://portal.example" },
    });
    expect(stale.status).toBe(403);
    const body = (await stale.json()) as { error: { reason: string; maxAgeMs: number } };
    expect(body.error.reason).toBe("fresh");
    expect(body.error.maxAgeMs).toBe(600_000);
  });

  it("returns 401 without a session", async () => {
    const res = await app(fakeAuth({})).request("/export", {
      method: "POST",
      headers: { origin: "https://portal.example" },
    });
    expect(res.status).toBe(401);
  });
});

describe("cookie issuance helpers", () => {
  it("sets session + device cookies with the mode's recipe", async () => {
    const res = await app(fakeAuth({}), "partitioned").request("/login", { method: "POST" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual([
      `__Host-sid=${"tok".padEnd(43, "x")}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=100`,
      `__Host-did=${"dev".padEnd(43, "y")}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${400 * 24 * 3600}`,
    ]);
  });

  it("sets the magic-link binding cookie and clears on logout", async () => {
    const link = await app(fakeAuth({})).request("/link", { method: "POST" });
    expect(link.headers.getSetCookie()).toEqual([
      "__Host-auth_req=bind; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900",
    ]);
    const out = await app(fakeAuth({})).request("/logout", { method: "POST" });
    expect(out.headers.getSetCookie()).toEqual([
      "__Host-sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      "__Host-did=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
  });
});
