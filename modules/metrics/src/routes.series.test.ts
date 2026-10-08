import { ApiError, createApi, errorResponse, isApiError } from "@fundroom/contracts";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { registerMetricsRoutes } from "./routes.js";

/*
 * `GET /series` on the wire — the one metrics route an investor can reach (`member`, because
 * what they see is decided by each metric's audience inside RLS and not by RBAC).
 *
 * What is pinned here is the query string, which is the only part of this route a caller
 * controls: `ids` is comma-separated text that ends up in `definition_id = ANY($1::uuid[])`,
 * and anything that is not a uuid used to reach Postgres as one. `?ids=abc` raised `22P02`,
 * which is not a `MetricsError`, so `rethrow` passed it through and the route answered 500 —
 * on a member-facing endpoint, to any investor who edits a URL.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const CASH = "01920000-0000-7000-8000-0000000000a1";
const ARR = "01920000-0000-7000-8000-0000000000a2";
const NOW = new Date("2026-09-19T10:00:00.000Z");

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

/** The bound parameters, in the order the statement interpolates them. */
function sqlParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object" || node instanceof Date) {
    out.push(node);
    return out;
  }
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlParams(k, out);
    return out;
  }
  if ("encoder" in c) {
    out.push(c["value"]);
    return out;
  }
  if (Array.isArray(c["value"])) return out;
  out.push(node);
  return out;
}

const definition = (over: Record<string, unknown>) => ({
  id: CASH,
  key: "cash",
  name: "Cash",
  description: null,
  unit: "currency",
  currency: "USD",
  aggregation: "last",
  direction: "up_good",
  periodKind: "month",
  decimals: 0,
  formula: null,
  display: {},
  audience: { kind: "all" },
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...over,
});

const DEFINITIONS = [definition({}), definition({ id: ARR, key: "arr", name: "ARR" })];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What `pg` raises when a string that is not a uuid reaches a `uuid[]` parameter. */
class PgInvalidTextRepresentation extends Error {
  readonly code = "22P02";
  constructor(value: string) {
    super(`invalid input syntax for type uuid: "${value}"`);
  }
}

function app() {
  /** Every id the repository was actually asked for — i.e. what reached `::uuid[]`. */
  const asked: string[][] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      if (text.includes("FROM metrics.definition")) {
        const ids = sqlParams(query).find((p) => Array.isArray(p));
        if (Array.isArray(ids)) {
          asked.push(ids as string[]);
          // The database's own reaction, which is the whole defect: this throw is what used to
          // leave the route as a 500 rather than as an empty series.
          const bad = (ids as string[]).find((x) => !UUID_RE.test(x));
          if (bad !== undefined) throw new PgInvalidTextRepresentation(bad);
        }
        // The real repository's filter, so an id that reaches it decides a row.
        return {
          rows: Array.isArray(ids)
            ? DEFINITIONS.filter((d) => (ids as string[]).includes(d.id))
            : DEFINITIONS,
        };
      }
      if (text.includes("FROM metrics.point_current")) return { rows: [] };
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  const noopMiddleware = async (_c: unknown, next: () => Promise<void>) => {
    await next();
  };
  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    guards: { requirePermission: () => noopMiddleware, requireMember: () => noopMiddleware },
    rateLimiter: {
      async hit() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        return {} as never;
      },
    },
    crypto: {},
    renderer: { driver: "fake" },
    now: () => NOW,
    log: () => {},
  } as unknown as ModuleServices;

  const api = createApi<ModuleEnv>();
  api.use("*", async (c, next) => {
    c.set("workspace", { id: WORKSPACE, slug: "acme", settings: {} } as never);
    c.set("session", { sessionId: "s-1" } as never);
    c.set("membership", { id: "01920000-0000-7000-8000-0000000000b1" } as never);
    c.set("tenant", { workspaceId: WORKSPACE, actorKind: "staff" } as never);
    await next();
  });
  registerMetricsRoutes(api as unknown as ModuleRouter, services);
  api.onError((error, c) =>
    isApiError(error) ? errorResponse(c, error) : errorResponse(c, new ApiError("internal_error")),
  );
  return { api, asked };
}

interface SeriesBody {
  readonly series: { readonly definitionId: string }[];
}

const get = async (a: ReturnType<typeof app>, path: string) => {
  const res = await a.api.request(path);
  return { res, body: (await res.json()) as SeriesBody };
};

describe("GET /series", () => {
  it("drops an id that is not a uuid instead of handing it to Postgres", async () => {
    /*
     * `22P02` — "invalid input syntax for type uuid" — is not a `MetricsError`, so it left the
     * route as a 500 that any investor could trigger by editing a URL. Dropping rather than
     * reporting is the same rule the hydrator follows for an id the reader may not see: the
     * answer must not say anything about what was not in it.
     */
    const a = app();
    const { res, body } = await get(a, "/series?ids=abc");
    expect(res.status).toBe(200);
    expect(body.series).toEqual([]);
    // Nothing malformed reached the repository at all — the fake raises `22P02` if it does,
    // exactly as Postgres does, and the route would answer 500.
    expect(a.asked).toEqual([]);
  });

  it("keeps the well-formed ids out of a mixed list", async () => {
    const a = app();
    const { res, body } = await get(a, `/series?ids=${CASH},abc,,${ARR},12345`);
    expect(res.status).toBe(200);
    expect(a.asked).toEqual([[CASH, ARR]]);
    expect(body.series.map((s) => s.definitionId)).toEqual([CASH, ARR]);
  });

  it("still means `every metric this reader may see` when ids is absent", async () => {
    const a = app();
    const { res, body } = await get(a, "/series");
    expect(res.status).toBe(200);
    expect(body.series.map((s) => s.definitionId)).toEqual([CASH, ARR]);
    expect(a.asked).toEqual([]);
  });

  it("answers with nothing when every id asked for was malformed", async () => {
    // Not "everything": a caller that named three metrics and spelled all three wrong asked
    // for those three, and the honest answer is that none of them came back.
    const a = app();
    const { res, body } = await get(a, "/series?ids=abc,def");
    expect(res.status).toBe(200);
    expect(body.series).toEqual([]);
    expect(a.asked).toEqual([]);
  });
});
