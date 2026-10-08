import {
  discoveryList,
  errorFields,
  isScimError,
  type JsonRecord,
  type Projection,
  parseAttributeList,
  parseFilter,
  parsePage,
  project,
  resourceTypeById,
  resourceTypes,
  type ScimPrincipal,
  type ScimService,
  schemaById,
  schemas,
  scimErrorBody,
  serviceProviderConfig,
  wantsMembers,
} from "@fundroom/scim";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";

/*
 * SCIM 2.0 (E3.8, ADR-0056) at `${BASE_URL}/scim/v2/*`: ops tree (canonical host, no slug, no
 * session, no CSRF), mounted in `app.ts` before the session chain. The workspace comes from the
 * bearer token, never the host. No authz-matrix rows (like the accreditation callback).
 *
 * Every answer under `/scim/v2` is `application/scim+json`; every failure is an RFC 7644 §3.12
 * error body (status as a string), never the API envelope:
 *  - 404 everywhere when `SCIM_ENABLED=false` (and for unknown paths);
 *  - 401 (+ `WWW-Authenticate: Bearer`) for a missing, malformed, unknown or revoked token;
 *  - 429 (+ `Retry-After`) past 1200 requests a minute per token (per process);
 *  - 413 past a 1 MiB body; 415 for a body that is neither `application/scim+json` nor
 *    `application/json` (a missing Content-Type is read as JSON); 400 `invalidSyntax` for bad JSON;
 *  - 500 with no detail for anything unexpected (logged).
 * Requests on any other tree (a tenant host, `/w/<slug>`) are not ours: `next()`.
 */

export const SCIM_MAX_BODY_BYTES = 1024 * 1024;
/** Requests one token may make per process per minute. */
export const SCIM_RATE_LIMIT_PER_MINUTE = 1200;
const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";

export interface ScimRouteOptions {
  /** Read per request (the container's service). */
  readonly scim: () => ScimService;
  /** `SCIM_ENABLED`: false answers 404 everywhere under `/scim/v2`. */
  readonly enabled: boolean;
  readonly log: Log;
  /** Tests shrink the budget or move the clock. */
  readonly rateLimit?:
    | { readonly perMinute?: number | undefined; readonly now?: (() => number) | undefined }
    | undefined;
}

type Ctx = Context<AppEnv>;

function scimJson(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, "Cache-Control": "no-store", ...headers },
  });
}

function scimFail(
  status: number,
  detail?: string,
  scimType?: Parameters<typeof scimErrorBody>[2],
  headers: Record<string, string> = {},
) {
  return scimJson(scimErrorBody(status, detail, scimType), status, headers);
}

const idOf = (c: Ctx): string => c.req.param("id") ?? "";

function bearerOf(c: Ctx): string | undefined {
  const h = c.req.header("authorization");
  if (h === undefined) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/iu.exec(h);
  return m?.[1];
}

export function scimRoutes(options: ScimRouteOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const perMinute = options.rateLimit?.perMinute ?? SCIM_RATE_LIMIT_PER_MINUTE;
  const clock = options.rateLimit?.now ?? Date.now;
  // Keyed by the Context: `bodyLimit` swaps `c.req.raw` for a re-buffered Request.
  const principals = new WeakMap<Ctx, ScimPrincipal>();
  let window = Math.floor(clock() / 60_000);
  /** Requests this minute per AUTHENTICATED token id (bounded by live tokens). */
  let counts = new Map<string, number>();

  const principalOf = (c: Ctx): ScimPrincipal => {
    const p = principals.get(c);
    if (p === undefined) throw new Error("scim principal missing");
    return p;
  };

  // Gate: tree, feature switch, token, rate limit, content type.
  app.use("/scim/v2", gate);
  app.use("/scim/v2/*", gate);

  async function gate(c: Ctx, next: () => Promise<void>) {
    if (c.get("classification")?.tree !== "ops") return next();
    if (!options.enabled) return scimFail(404, "SCIM is not enabled on this server");
    const bearer = bearerOf(c);
    let principal: ScimPrincipal | null = null;
    if (bearer !== undefined) {
      try {
        principal = await options.scim().authenticate(bearer);
      } catch (e) {
        options.log("scim.auth_error", { level: "error", ...errorFields(e) });
        return scimFail(500);
      }
    }
    if (principal === null) {
      return scimFail(401, "a valid SCIM bearer token is required", undefined, {
        "WWW-Authenticate": 'Bearer realm="scim"',
      });
    }
    const minute = Math.floor(clock() / 60_000);
    if (minute !== window) {
      window = minute;
      counts = new Map();
    }
    const n = (counts.get(principal.tokenId) ?? 0) + 1;
    counts.set(principal.tokenId, n);
    if (n > perMinute) {
      const retry = Math.max(1, Math.ceil(((minute + 1) * 60_000 - clock()) / 1000));
      if (n === perMinute + 1) {
        options.log("scim.rate_limited", {
          level: "warn",
          workspaceId: principal.workspaceId,
          tokenId: principal.tokenId,
        });
      }
      return scimFail(429, "too many SCIM requests; slow down", undefined, {
        "Retry-After": String(retry),
      });
    }
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      const ct = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (ct !== "" && ct !== "application/scim+json" && ct !== "application/json") {
        return scimFail(415, "send application/scim+json or application/json");
      }
    }
    principals.set(c, principal);
    return next();
  }

  const limit = bodyLimit({
    maxSize: SCIM_MAX_BODY_BYTES,
    onError: () => scimFail(413, `the request body is larger than 1 MiB`),
  });

  /** Runs a handler; renders ScimError, logs and hides anything else. */
  const handle =
    (fn: (c: Ctx, p: ScimPrincipal) => Promise<Response>) =>
    async (c: Ctx, next: () => Promise<void>): Promise<Response | undefined> => {
      if (c.get("classification")?.tree !== "ops") {
        await next();
        return undefined;
      }
      try {
        return await fn(c, principalOf(c));
      } catch (e) {
        if (isScimError(e)) return scimJson(e.toBody(), e.status);
        // Never the message or stack: a failed query's message carries its parameters (R2-M5).
        options.log("scim.error", {
          level: "error",
          method: c.req.method,
          route: c.req.routePath,
          ...errorFields(e),
        });
        return scimFail(500, "internal error");
      }
    };

  /** The JSON body; bad JSON is 400 `invalidSyntax` (a body over the limit throws through). */
  const withBody =
    (fn: (c: Ctx, p: ScimPrincipal, b: unknown) => Promise<Response>) =>
    async (c: Ctx, p: ScimPrincipal): Promise<Response> => {
      const text = await c.req.text();
      let b: unknown;
      try {
        b = JSON.parse(text) as unknown;
      } catch {
        return scimFail(400, "the body is not valid JSON", "invalidSyntax");
      }
      return fn(c, p, b);
    };

  function projection(c: Ctx): Projection {
    return {
      attributes: parseAttributeList(c.req.query("attributes")),
      excludedAttributes: parseAttributeList(c.req.query("excludedAttributes")),
    };
  }

  function listQuery(c: Ctx) {
    const raw = c.req.query("filter");
    const page = parsePage(c.req.query("startIndex"), c.req.query("count"));
    return {
      ...(raw === undefined || raw.trim() === "" ? {} : { filter: parseFilter(raw) }),
      startIndex: page.startIndex,
      count: page.count,
    };
  }

  function projectList(list: JsonRecord, p: Projection): JsonRecord {
    const resources = list["Resources"];
    if (!Array.isArray(resources)) return list;
    return { ...list, Resources: resources.map((r) => project(r as JsonRecord, p)) };
  }

  const svc = () => options.scim().protocol;
  const created = (c: Ctx, resource: JsonRecord) => {
    const location = (resource["meta"] as JsonRecord | undefined)?.["location"];
    return scimJson(
      project(resource, projection(c)),
      201,
      typeof location === "string" ? { Location: location } : {},
    );
  };

  // --- discovery ---------------------------------------------------------------------------------
  app.get(
    "/scim/v2/ServiceProviderConfig",
    handle(async () => scimJson(serviceProviderConfig(svc().baseUrl), 200)),
  );
  app.get(
    "/scim/v2/ResourceTypes",
    handle(async () => scimJson(discoveryList(resourceTypes(svc().baseUrl)), 200)),
  );
  app.get(
    "/scim/v2/ResourceTypes/:id",
    handle(async (c) => {
      const r = resourceTypeById(svc().baseUrl, idOf(c));
      return r === undefined ? scimFail(404, "no such resource type") : scimJson(r, 200);
    }),
  );
  app.get(
    "/scim/v2/Schemas",
    handle(async () => scimJson(discoveryList(schemas(svc().baseUrl)), 200)),
  );
  app.get(
    "/scim/v2/Schemas/:id",
    handle(async (c) => {
      const s = schemaById(svc().baseUrl, idOf(c));
      return s === undefined ? scimFail(404, "no such schema") : scimJson(s, 200);
    }),
  );

  // --- users -------------------------------------------------------------------------------------
  app.get(
    "/scim/v2/Users",
    handle(async (c, p) =>
      scimJson(projectList(await svc().listUsers(p, listQuery(c)), projection(c)), 200),
    ),
  );
  app.post(
    "/scim/v2/Users",
    limit,
    handle(withBody(async (c, p, b) => created(c, await svc().createUser(p, b)))),
  );
  app.get(
    "/scim/v2/Users/:id",
    handle(async (c, p) => scimJson(project(await svc().getUser(p, idOf(c)), projection(c)), 200)),
  );
  app.put(
    "/scim/v2/Users/:id",
    limit,
    handle(
      withBody(async (c, p, b) =>
        scimJson(project(await svc().replaceUser(p, idOf(c), b), projection(c)), 200),
      ),
    ),
  );
  app.patch(
    "/scim/v2/Users/:id",
    limit,
    handle(
      withBody(async (c, p, b) =>
        scimJson(project(await svc().patchUser(p, idOf(c), b), projection(c)), 200),
      ),
    ),
  );
  app.delete(
    "/scim/v2/Users/:id",
    handle(async (c, p) => {
      await svc().deleteUser(p, idOf(c));
      return new Response(null, { status: 204 });
    }),
  );

  // --- groups ------------------------------------------------------------------------------------
  app.get(
    "/scim/v2/Groups",
    handle(async (c, p) => {
      const proj = projection(c);
      const list = await svc().listGroups(p, listQuery(c), { members: wantsMembers(proj) });
      return scimJson(projectList(list, proj), 200);
    }),
  );
  app.post(
    "/scim/v2/Groups",
    limit,
    handle(withBody(async (c, p, b) => created(c, await svc().createGroup(p, b)))),
  );
  app.get(
    "/scim/v2/Groups/:id",
    handle(async (c, p) => {
      const proj = projection(c);
      const g = await svc().getGroup(p, idOf(c), { members: wantsMembers(proj) });
      return scimJson(project(g, proj), 200);
    }),
  );
  app.put(
    "/scim/v2/Groups/:id",
    limit,
    handle(
      withBody(async (c, p, b) =>
        scimJson(project(await svc().replaceGroup(p, idOf(c), b), projection(c)), 200),
      ),
    ),
  );
  app.patch(
    "/scim/v2/Groups/:id",
    limit,
    handle(
      withBody(async (c, p, b) => {
        await svc().patchGroup(p, idOf(c), b);
        return new Response(null, { status: 204 });
      }),
    ),
  );
  app.delete(
    "/scim/v2/Groups/:id",
    handle(async (c, p) => {
      await svc().deleteGroup(p, idOf(c));
      return new Response(null, { status: 204 });
    }),
  );

  // Anything else under /scim/v2 (Bulk, /Me, unknown paths or methods): a SCIM 404.
  const notFound = handle(async () => scimFail(404, "no such SCIM endpoint"));
  app.all("/scim/v2", notFound);
  app.all("/scim/v2/*", notFound);

  return app;
}
