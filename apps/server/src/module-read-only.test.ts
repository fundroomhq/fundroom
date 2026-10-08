import { entitlementsOf } from "@fundroom/domain";
import { createModuleRegistry, moduleReadOnly } from "@fundroom/module-kit";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./api.js";
import type { AppEnv } from "./env.js";
import { apiErrorHandler } from "./middleware/errors.js";
import {
  assertModuleWritable,
  markModuleMount,
  READ_ONLY_EXEMPT,
  READ_ONLY_EXEMPT_WHEN,
  readOnlyKey,
  refusesWhileReadOnly,
} from "./module-read-only.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { listRawRoutes } from "./test/authz-sweep-plan.js";

/*
 * The read-only decision (A-3, ADR-0063 §3.2) without a database: when a module is read-only,
 * which methods and routes it refuses, the guard's 402 on a mounted router, and the OpenAPI
 * document agreeing with the guard. The behaviour against a real server is in
 * `entitlements-modules.integration.test.ts` and `entitlements-sweep.integration.test.ts`.
 */

const enforced = (modules: string[] | undefined) =>
  entitlementsOf({
    enforced: true,
    planId: "p",
    limits: modules === undefined ? {} : { modules },
  });
const crm = { id: "crm", required: false };
const content = { id: "content", required: true };

const OPTIONAL = new Set(COMPILED_IN_MODULES.filter((m) => m.required !== true).map((m) => m.id));
/** Required manifests that mount routes of their own (`content`); the kernel manifests mount none. */
const REQUIRED_MOUNTED = new Set(
  COMPILED_IN_MODULES.filter((m) => m.required === true && m.routes !== undefined).map((m) => m.id),
);
/** `x-requires` words whose guard never refuses for read-only (permission and `member` do). */
const UNGUARDED = new Set(["public", "session", "owner-or-admin"]);
/** DELETE is never refused (withdrawing is allowed), so it is never an exemption either. */
const REFUSABLE_METHODS = ["post", "put", "patch"];

describe("moduleReadOnly", () => {
  it("is on, optional and outside an enforced plan — nothing else", () => {
    expect(moduleReadOnly(enforced([]), crm, true)).toBe(true);
    expect(moduleReadOnly(enforced(["metrics"]), crm, true)).toBe(true);
    // Off: nothing to read. In the plan, or no list at all: writable.
    expect(moduleReadOnly(enforced([]), crm, false)).toBe(false);
    expect(moduleReadOnly(enforced(["crm"]), crm, true)).toBe(false);
    expect(moduleReadOnly(enforced(undefined), crm, true)).toBe(false);
    // A required module is never on a plan's list and never read-only.
    expect(moduleReadOnly(enforced([]), content, true)).toBe(false);
    // CONTROL_PLANE=off, or no plan: nothing is enforced.
    const off = entitlementsOf({ enforced: false, planId: "p", limits: { modules: [] } });
    expect(moduleReadOnly(off, crm, true)).toBe(false);
    const noPlan = entitlementsOf({ enforced: true, planId: null, limits: null });
    expect(moduleReadOnly(noPlan, crm, true)).toBe(false);
  });
});

describe("refusesWhileReadOnly", () => {
  it("lets reads and every DELETE through, and refuses every other method", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "DELETE", "delete"])
      expect(refusesWhileReadOnly(method, "crm", "/contacts/{id}")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "post"])
      expect(refusesWhileReadOnly(method, "crm", "/contacts/{id}")).toBe(true);
  });

  it("lets the exempt routes through, in either path spelling, and nothing that merely resembles one", () => {
    expect(refusesWhileReadOnly("POST", "captable", "/import/dry-run")).toBe(false);
    expect(refusesWhileReadOnly("POST", "captable", "/import")).toBe(true);
    expect(refusesWhileReadOnly("POST", "data-room", "/documents/{id}/forensic/detect")).toBe(
      false,
    );
    expect(refusesWhileReadOnly("POST", "data-room", "/documents/:id/forensic/detect")).toBe(false);
    // Same path, other module; same path, other method.
    expect(refusesWhileReadOnly("POST", "metrics", "/documents/{id}/forensic/detect")).toBe(true);
    expect(refusesWhileReadOnly("PUT", "notify", "/inbox/read")).toBe(true);
    // Withdrawing: a scheduled send can always be cancelled (ROUND-1 decision 8).
    expect(refusesWhileReadOnly("POST", "updates", "/posts/{id}/unschedule")).toBe(false);
    expect(refusesWhileReadOnly("POST", "updates", "/posts/{id}/schedule")).toBe(true);
    // Deleting is allowed, undeleting is not: delete + restore would move content (decision 14).
    expect(refusesWhileReadOnly("DELETE", "data-room", "/documents/{id}")).toBe(false);
    expect(refusesWhileReadOnly("POST", "data-room", "/documents/{id}/restore")).toBe(true);
    expect(refusesWhileReadOnly("POST", "data-room", "/folders/{id}/restore")).toBe(true);
  });

  it("exempts archiving an update but not un-archiving it (decision 16)", () => {
    const archived = (body: unknown) =>
      refusesWhileReadOnly("PUT", "updates", "/posts/:id/archived", body);
    expect(archived({ archived: true })).toBe(false);
    expect(archived({ archived: false })).toBe(true);
    expect(archived({ archived: "true" })).toBe(true);
    expect(archived(undefined)).toBe(true);
    expect(archived(null)).toBe(true);
    expect(readOnlyKey("put", "data-room", "/documents/:id/legal-hold")).toBe(
      "PUT /data-room/documents/{id}/legal-hold",
    );
  });
});

describe("READ_ONLY_EXEMPT", () => {
  const doc = generateOpenApiDocument(createModuleRegistry(COMPILED_IN_MODULES));
  const operations = new Map<string, Record<string, unknown>>();
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>))
      operations.set(`${method.toUpperCase()} ${path}`, op);
  const raw = new Set(listRawRoutes());

  it("names only guarded (permission or member) non-DELETE writes of optional modules, each with a reason", () => {
    expect(READ_ONLY_EXEMPT.size).toBeGreaterThan(0);
    for (const [key, reason] of READ_ONLY_EXEMPT) {
      const [method = "", path = ""] = key.split(" ");
      expect(OPTIONAL.has(path.split("/")[1] ?? ""), key).toBe(true);
      expect(REFUSABLE_METHODS.includes(method.toLowerCase()), key).toBe(true);
      const op = operations.get(key);
      expect(op !== undefined || raw.has(key), `${key} names no route`).toBe(true);
      if (op !== undefined) {
        const requires = String(op["x-requires"]).split("+")[0] ?? "";
        expect(UNGUARDED.has(requires), `${key} is not guarded`).toBe(false);
      }
      expect(reason.length, key).toBeGreaterThan(20);
    }
    for (const [key, { reason }] of READ_ONLY_EXEMPT_WHEN) {
      expect(operations.has(key), `${key} names no route`).toBe(true);
      expect(READ_ONLY_EXEMPT.has(key), `${key} is in both lists`).toBe(false);
      expect(reason.length, key).toBeGreaterThan(20);
    }
  });

  it("the OpenAPI document lists 402 on exactly the module routes a read-only module refuses", () => {
    const wrong: string[] = [];
    for (const [key, op] of operations) {
      const [method = "", path = ""] = key.split(" ");
      const moduleId = path.split("/")[1] ?? "";
      const documented = (op["responses"] as Record<string, unknown>)["402"] !== undefined;
      // A required module is never read-only (R2 L1); nothing else gates its routes.
      if (REQUIRED_MOUNTED.has(moduleId) && documented)
        wrong.push(`${key}: required module documents 402`);
      if (!OPTIONAL.has(moduleId)) continue;
      const requires = String(op["x-requires"]).split("+")[0] ?? "";
      const refused =
        REFUSABLE_METHODS.includes(method.toLowerCase()) &&
        !UNGUARDED.has(requires) &&
        !READ_ONLY_EXEMPT.has(key);
      if (refused && !documented) wrong.push(`${key}: refused but 402 not documented`);
      if (!refused && documented) wrong.push(`${key}: documents 402 but nothing refuses it`);
    }
    expect(wrong).toEqual([]);
    expect([...REQUIRED_MOUNTED]).toContain("content");
    // The member route a staff member writes through (R1 M1) is documented; telemetry is not.
    const responses = (k: string) => operations.get(k)?.["responses"] as Record<string, unknown>;
    expect(responses("POST /updates/posts/{id}/replies")["402"]).toBeDefined();
    expect(responses("POST /analytics/heartbeat")["402"]).toBeUndefined();
    expect(responses("POST /content/pages")?.["402"]).toBeUndefined();
  });
});

describe("the guard on a mounted router", () => {
  /** A module mount like `api.ts`'s, then a route whose guard is just the read-only check. */
  function app(modules: string[] | undefined, m = crm) {
    const root = new Hono<AppEnv>();
    root.onError(apiErrorHandler(() => {}));
    const sub = new Hono<AppEnv>();
    sub.use("*", async (c, next) => {
      markModuleMount(c, m, enforced(modules));
      await next();
    });
    const guard = async (
      c: Parameters<typeof assertModuleWritable>[0],
      next: () => Promise<void>,
    ) => {
      await assertModuleWritable(c);
      await next();
    };
    sub.get("/contacts", guard, (c) => c.json({ ok: true }));
    sub.post("/contacts/:id", guard, (c) => c.json({ ok: true }));
    sub.delete("/contacts/:id", guard, (c) => c.json({ ok: true }));
    root.route("/w/:slug/api/v1/crm", sub);
    // A kernel route: never marked, never refused.
    root.post("/w/:slug/api/v1/people", guard, (c) => c.json({ ok: true }));
    return root;
  }

  it("answers 402 plan_limit {limit: module} to a write, and lets reads and kernel routes through", async () => {
    const readOnly = app([]);
    const write = await readOnly.request("/w/acme/api/v1/crm/contacts/1", { method: "POST" });
    expect(write.status).toBe(402);
    const body = (await write.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "plan_limit", limit: "module", module: "crm" });
    expect((await readOnly.request("/w/acme/api/v1/crm/contacts")).status).toBe(200);
    expect((await readOnly.request("/w/acme/api/v1/people", { method: "POST" })).status).toBe(200);
    // Withdrawing is allowed.
    const del = await readOnly.request("/w/acme/api/v1/crm/contacts/1", { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("never refuses a required module, whatever the plan lists (R2 L1)", async () => {
    const res = await app([], content).request("/w/acme/api/v1/crm/contacts/1", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("lets writes through while the plan includes the module", async () => {
    const res = await app(["crm"]).request("/w/acme/api/v1/crm/contacts/1", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
