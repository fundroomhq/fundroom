import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isWildcardMiddleware, methodNotAllowed } from "./method-not-allowed.js";

/*
 * The 405 gate in front of `/api/v1`. The routes here mimic what `createApiApp` registers: kernel
 * routes, a module sub-app behind a `use("*")` guard that answers before any route would, and a
 * route with a parameter.
 */
function harness(): Hono {
  const api = new Hono();
  api.post("/auth/logout", (c) => c.json({ ok: true }));
  api.get("/me", (c) => c.json({ ok: true }));
  api.get("/files/:id", (c) => c.json({ id: c.req.param("id") }));
  api.delete("/files/:id", (c) => c.body(null, 204));
  api.post("/files/search", (c) => c.json({ ok: true }));
  const mod = new Hono();
  mod.use("*", async (c) => c.json({ error: { code: "setup_required" } }, 503));
  mod.post("/notes", (c) => c.json({ ok: true }));
  api.route("/crm", mod);

  const mount = new Hono();
  mount.use(
    "*",
    methodNotAllowed({
      routes: () => api.routes.filter((r) => !isWildcardMiddleware(r)),
      apiPath: (path) => {
        const prefix = /^(?:\/w\/[^/]+)?\/api\/v1(?=\/|$)/u.exec(path);
        return prefix === null ? undefined : path.slice(prefix[0].length) || "/";
      },
    }),
  );
  mount.route("/", api);
  const app = new Hono();
  app.route("/api/v1", mount);
  app.route("/w/:slug/api/v1", mount);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found" } }, 404));
  return app;
}

describe("methodNotAllowed", () => {
  const app = harness();

  it("answers 405 with Allow for a known path and an unserved method", async () => {
    const res = await app.request("/api/v1/auth/logout");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  it("lists every served method, HEAD with GET, for a parameterised path", async () => {
    const res = await app.request("/api/v1/files/abc", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("DELETE, GET, HEAD");
  });

  it("decides before a module prefix's own middleware can answer", async () => {
    const res = await app.request("/api/v1/crm/notes");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("lets a concrete path win over a template that would also match it", async () => {
    const res = await app.request("/api/v1/files/search");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await app.request("/api/v1/files/search", { method: "POST" })).status).toBe(200);
  });

  it("works under the slug prefix too", async () => {
    const res = await app.request("/w/acme/api/v1/me", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("leaves served methods, HEAD on a GET route and unknown paths alone", async () => {
    expect((await app.request("/api/v1/me")).status).toBe(200);
    expect((await app.request("/api/v1/me", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("/api/v1/files/abc", { method: "DELETE" })).status).toBe(204);
    expect((await app.request("/api/v1/nope", { method: "POST" })).status).toBe(404);
    // A preflight is CORS's to answer, not a method mismatch.
    expect((await app.request("/api/v1/auth/logout", { method: "OPTIONS" })).status).not.toBe(405);
    // The module guard still answers for a served method.
    expect((await app.request("/api/v1/crm/notes", { method: "POST" })).status).toBe(503);
  });
});
