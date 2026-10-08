import { type AuthzMatrix, loadAuthzMatrix, roleHasPermission } from "@fundroom/authz";
import { createModuleRegistry } from "@fundroom/module-kit";
import { Hono } from "hono";
import { generateOpenApiDocument } from "../api.js";
import { COMPILED_IN_MODULES } from "../modules.js";

/*
 * Test support for the behavioural authz sweep (E3.2 WP-SWEEP, ASVS F-30). Not imported by the
 * server.
 *
 * `authz-matrix.test.ts` proves every OpenAPI operation *declares* the matrix's requirement;
 * nothing there proves the guard it mounts actually *answers* like that. The sweep does, and
 * this file is its pure half: the operation list (the generated OpenAPI document — the same
 * source the matrix test uses — plus every module raw route the document does not describe),
 * the expected outcome of every (operation, actor) cell, derived from the matrix and the
 * middleware table in `middleware/authz.ts`, and the explicit skip list. It is pure so the
 * coverage guard (`authz-sweep.test.ts`) runs in the unit project without Docker.
 *
 * The middleware table (`requirePermission`, `requireOwnerOrAdmin`, `requireMember`):
 *   no session                              → 401 unauthenticated
 *   no live membership here                 → 404 not_found  (e.g. another tenant's owner)
 *   external member on a staff route        → 404 not_found  (no oracle)
 *   session weaker than the role needs      → 403 step_up_required, reason `level`
 *   staff lacking the permission / role     → 403 forbidden
 *   `stepUp: true` and auth older than 10 m → 403 step_up_required, reason `fresh`
 *   an API key only, row not `apiKey: true`  → 401 unauthenticated, reason `api_key_not_allowed`
 *   an API key only, `apiKey: true` row but the scope or the creator's role lacks the permission
 *                                            → 403 forbidden, reason `scope_missing`
 *
 * The *liveness* rows (E3.2 review L-3): a membership that is expired, revoked, or a delegate
 * whose principal is no longer live gives the session no tenant context, exactly like another
 * tenant's owner — every workspace route is 404 — while its session still works for `session`
 * routes. The expected cells here are derived from the matrix, which is also what the runtime
 * reads, so `authz-sweep.test.ts` additionally pins a hand-written golden table of the
 * security-critical role × permission cells against it.
 */

export const API_PREFIX = "/api/v1";

/** Staff roles provisioned in the sweep workspace (the matrix's full staff list). */
export const STAFF_ACTORS = ["owner", "admin", "editor", "viewer", "finance", "legal"] as const;
/**
 * Every actor the sweep asks as.
 *  - `otherOwner`: the (MFA'd) owner of a *different* workspace — no membership here.
 *  - `ownerLevel1`: an owner here signed in with an email code only (level 1; owners need 2).
 *  - `staleOwner`: an owner here at level 2 whose last authentication is 11 minutes old.
 * Every staff actor except those two is at the level its role needs and freshly authenticated.
 */
/**
 * Liveness actors (E3.2 L-3), each signed in while live and then changed underneath its session:
 *  - `expiredAdmin`: a level-2 admin whose membership `expires_at` has passed.
 *  - `revokedAdmin`: a level-2 admin whose membership was revoked (the row only: its session is
 *    left alive on purpose, so the guard's own liveness check is what is tested).
 *  - `delegateAll` / `delegateDataRoom`: live delegates (scope `all` / `data_room`) of the
 *    investor. They hold no permission; the guard admits them to `member` routes only.
 *  - `orphanDelegate`: a delegate (scope `all`) whose principal has been suspended.
 */
export const LIVENESS_ACTORS = [
  "expiredAdmin",
  "revokedAdmin",
  "delegateAll",
  "delegateDataRoom",
  "orphanDelegate",
] as const;

/**
 * `apiKeyOwner` (E3.4): no session, only `Authorization: Bearer frk_…` — a key the owner created
 * with every scope in `apiKeyScopes()`. Allowed on `apiKey: true` rows (the owner holds every
 * key scope), 401 `unauthenticated` / `api_key_not_allowed` on every other row.
 */
export const ACTORS = [
  "anonymous",
  "apiKeyOwner",
  "otherOwner",
  "investor",
  ...STAFF_ACTORS,
  "ownerLevel1",
  "staleOwner",
  ...LIVENESS_ACTORS,
] as const;
export type ActorName = (typeof ACTORS)[number];

/** Signed in, but no live membership in the swept workspace: every workspace route is 404. */
const NO_TENANT_CONTEXT: ReadonlySet<ActorName> = new Set([
  "otherOwner",
  "expiredAdmin",
  "revokedAdmin",
  "orphanDelegate",
]);
/** Live delegates: admitted by the guard to `member` routes, where a scope rule may still apply. */
const LIVE_DELEGATES: ReadonlySet<ActorName> = new Set(["delegateAll", "delegateDataRoom"]);
/** Live external members: staff routes are 404 for them (no oracle). */
const LIVE_EXTERNALS: ReadonlySet<ActorName> = new Set(["investor", ...LIVE_DELEGATES]);

export interface Denial {
  readonly kind: "deny";
  readonly status: 401 | 403 | 404;
  readonly code: "unauthenticated" | "forbidden" | "not_found" | "step_up_required";
  readonly reason?: "level" | "fresh" | "api_key_not_allowed" | "scope_missing";
}
/**
 * `allow`: nothing an authz layer says. `admit`: the kernel guard lets the actor through, but the
 * handler may still refuse by a delegate's scope (`forbidden`, or a 404 for what the scope hides)
 * — the scope rules have their own tests (`delegates.integration.test.ts`).
 */
export type Outcome = Denial | { readonly kind: "allow" } | { readonly kind: "admit" };

const UNAUTHENTICATED: Denial = { kind: "deny", status: 401, code: "unauthenticated" };
const KEY_NOT_ALLOWED: Denial = {
  kind: "deny",
  status: 401,
  code: "unauthenticated",
  reason: "api_key_not_allowed",
};
const SCOPE_MISSING: Denial = {
  kind: "deny",
  status: 403,
  code: "forbidden",
  reason: "scope_missing",
};
const NOT_FOUND: Denial = { kind: "deny", status: 404, code: "not_found" };
const FORBIDDEN: Denial = { kind: "deny", status: 403, code: "forbidden" };
const NEEDS_LEVEL: Denial = {
  kind: "deny",
  status: 403,
  code: "step_up_required",
  reason: "level",
};
const NEEDS_FRESH: Denial = {
  kind: "deny",
  status: 403,
  code: "step_up_required",
  reason: "fresh",
};
const ALLOW: Outcome = { kind: "allow" };
const ADMIT: Outcome = { kind: "admit" };

/** The only 404 messages the authz middleware answers with (`middleware/authz.ts`, `auth.ts`). */
export const AUTHZ_NOT_FOUND_MESSAGES = ["no such workspace for this account", "no such path"];

/**
 * Operations whose membership check lives in the handler, with the 404 message it answers. Only
 * acceptable where the sweep's request cannot reach a *later* 404 of the same handler.
 */
export const HANDLER_NOT_FOUND_MESSAGES: ReadonlyMap<string, string> = new Map([
  /*
   * A module raw route (`modules/round/src/raw-routes.ts`): it checks the membership itself and
   * answers "no such verification" so an id in another workspace looks like one that does not
   * exist. The sweep sends `application/json`, which a member gets 415 for *before* the id is
   * looked up, so this 404 can only be the membership check.
   */
  ["PUT /round/verifications/{id}/evidence", "no such verification"],
]);

export interface SweepOperation {
  readonly method: string;
  /** OpenAPI template relative to `/api/v1`, e.g. `/access/people/{id}`. */
  readonly path: string;
  /** `requires` from the matrix row (or the raw-route table), `undefined` when there is none. */
  readonly requires: string | undefined;
  readonly stepUp: boolean;
  /** The matrix row is `apiKey: true` (E3.4): a workspace API key may call it. */
  readonly apiKey: boolean;
  /** `raw`: a module raw route the OpenAPI document does not describe. */
  readonly source: "openapi" | "raw";
}

const key = (method: string, path: string) => `${method} ${path}`;

/**
 * `owner-or-admin` means two things in the matrix. On `/modules/*` it runs with the workspace
 * resolved (`requireOwnerOrAdmin`: external → 404, other staff → 403). On the setup probes there
 * is no workspace context: the matrix text is "staff owner/admin **anywhere**", enforced in the
 * handler by `requireStaffOwner` (listing the caller's memberships). So the owner of another
 * workspace is *allowed*, anybody signed in who owns/administers nothing gets 403 (investor
 * included — there is no workspace-scoped existence to hide), and the level check is the mail
 * probe's own (a founder without a second factor may mail themselves), so level 1 is allowed.
 */
export const HOST_LEVEL_OWNER_OR_ADMIN = new Set([
  key("POST", "/setup/probes/mail"),
  key("POST", "/setup/probes/storage"),
]);

/**
 * Module raw routes (`ModuleManifest.rawRoutes`) that are not OpenAPI operations, so the matrix
 * has no row for them. Keyed by the Hono registration (`METHOD /<module><path>`); `requires` is
 * what the handler enforces (read from the code), `send` the concrete requests the sweep makes.
 */
export const RAW_ROUTES: ReadonlyMap<
  string,
  {
    readonly requires: string;
    readonly send: readonly { method: string; path: string }[];
    readonly note: string;
  }
> = new Map([
  [
    "ALL /data-room/uploads/tus",
    {
      requires: "data-room.manage",
      send: [{ method: "POST", path: "/data-room/uploads/tus" }],
      note: "tus resumable upload endpoint (modules/data-room/src/raw-routes.ts), behind requirePermission; no matrix row",
    },
  ],
  [
    "ALL /data-room/uploads/tus/*",
    {
      requires: "data-room.manage",
      send: [{ method: "PATCH", path: "/data-room/uploads/tus/{id}" }],
      note: "tus upload resource (PATCH/HEAD/DELETE); no matrix row",
    },
  ],
]);

/**
 * Operations the sweep deliberately does not send, with the reason. Public operations are
 * skipped by category (no denial cell exists); list anything else here — the coverage guard
 * fails on an operation that is neither planned nor listed, and on an entry that names no
 * operation.
 */
export const SKIPPED_OPERATIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // E3.7 FOUNDATION: these GET handlers answer 501 until the kernel / round agents land them (an
  // allowed GET cell must not see a 5xx). REMOVE each entry together with its real handler.
]);

/**
 * Behaviour that contradicts the matrix / middleware table, found by the sweep and reported as
 * security findings. Keyed
 * `METHOD /path actor`; `got` is the observed `status code[/reason]`. The sweep accepts exactly
 * that observation for the cell and FAILS once the cell behaves (or changes), so each entry is
 * removed together with its fix.
 */
export const KNOWN_FINDINGS: ReadonlyMap<string, { readonly got: string; readonly note: string }> =
  /*
   * Empty since E3.2 WP-FIX. SWEEP-1 (the tus upload endpoint answered 412 to a level-1 owner,
   * 401 to a non-member and 403 to an investor) and SWEEP-2 (the round evidence upload skipped the
   * MFA level check and the legal-acceptance gate) were fixed by mounting the kernel guards
   * (`services.guards.requirePermission` / `requireMember`) in front of both raw routes.
   */
  new Map<string, { readonly got: string; readonly note: string }>([]);

export const cellKey = (op: Pick<SweepOperation, "method" | "path">, actor: ActorName) =>
  `${op.method} ${op.path} ${actor}`;

/** Every raw route the compiled-in modules register, as `METHOD /<module><hono path>`. */
export function listRawRoutes(): string[] {
  const out: string[] = [];
  for (const m of COMPILED_IN_MODULES) {
    if (m.rawRoutes === undefined) continue;
    const app = new Hono();
    // Registration only: no handler runs, so the services are never read.
    m.rawRoutes(app as never, {} as never);
    for (const r of app.routes) out.push(key(r.method, `/${m.id}${r.path}`));
  }
  return [...new Set(out)].sort();
}

/** `/x/:id/y` → `/x/{id}/y`. */
const toTemplate = (honoPath: string) => honoPath.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");

/**
 * Every operation in the generated OpenAPI document joined with its matrix row, plus the raw
 * routes the document does not describe (from `RAW_ROUTES`). A raw route that is neither an
 * OpenAPI operation nor in `RAW_ROUTES` is returned with `requires: undefined` (→ unplanned).
 */
export function listOperations(matrix: AuthzMatrix = loadAuthzMatrix()): SweepOperation[] {
  const doc = generateOpenApiDocument(createModuleRegistry(COMPILED_IN_MODULES));
  const ops: SweepOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const m = method.toUpperCase();
      const row = matrix.routes.find((r) => r.method === m && r.path === path);
      ops.push({
        method: m,
        path,
        requires: row?.requires,
        stepUp: row?.stepUp ?? false,
        apiKey: row?.apiKey ?? false,
        source: "openapi",
      });
    }
  }
  const documented = new Set(ops.map((op) => key(op.method, op.path)));
  for (const raw of listRawRoutes()) {
    const [method = "", honoPath = ""] = raw.split(" ");
    if (documented.has(key(method, toTemplate(honoPath)))) continue;
    const planned = RAW_ROUTES.get(raw);
    if (planned === undefined) {
      ops.push({
        method,
        path: honoPath,
        requires: undefined,
        stepUp: false,
        apiKey: false,
        source: "raw",
      });
      continue;
    }
    for (const s of planned.send)
      ops.push({ ...s, requires: planned.requires, stepUp: false, apiKey: false, source: "raw" });
  }
  return ops.sort((a, b) => key(a.method, a.path).localeCompare(key(b.method, b.path)));
}

export type Plan =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "sweep"; readonly cells: ReadonlyMap<ActorName, Outcome> }
  | { readonly kind: "unplanned"; readonly reason: string };

function expectedFor(
  op: SweepOperation,
  requires: string,
  actor: ActorName,
  matrix: AuthzMatrix,
): Outcome | undefined {
  // E3.10: the operator surface answers every tenant actor — anonymous and API keys included —
  // with the same plain 404 (`requirePlatformOperator()`); no sweep actor holds an operator session.
  if (requires === "platform-operator") return NOT_FOUND;
  if (actor === "anonymous") return UNAUTHENTICATED;
  if (actor === "apiKeyOwner") {
    // A key acts as the owner who created it, capped by its scopes (every key scope).
    if (!op.apiKey) return KEY_NOT_ALLOWED;
    return roleHasPermission("owner", requires, matrix) ? ALLOW : SCOPE_MISSING;
  }
  const hostLevel =
    requires === "owner-or-admin" && HOST_LEVEL_OWNER_OR_ADMIN.has(key(op.method, op.path));
  if (actor === "staleOwner") return op.stepUp ? NEEDS_FRESH : ALLOW;
  if (requires === "session") return ALLOW;
  if (hostLevel) {
    // A live staff owner/admin membership *somewhere*: not an expired or revoked one.
    if (["otherOwner", "owner", "admin", "ownerLevel1"].includes(actor)) return ALLOW;
    return FORBIDDEN;
  }
  if (NO_TENANT_CONTEXT.has(actor)) return NOT_FOUND;
  // `requireMember` checks the level too; an investor's needed level is 1 by default.
  if (actor === "ownerLevel1") return NEEDS_LEVEL;
  if (requires === "member") return LIVE_DELEGATES.has(actor) ? ADMIT : ALLOW;
  if (LIVE_EXTERNALS.has(actor)) return NOT_FOUND;
  if (requires === "owner-or-admin")
    return actor === "owner" || actor === "admin" ? ALLOW : FORBIDDEN;
  if (!matrix.permissions.has(requires)) return undefined;
  return roleHasPermission(actor, requires, matrix) ? ALLOW : FORBIDDEN;
}

/** The expected outcome of every actor on `op`, or why it is not swept. */
export function planFor(op: SweepOperation, matrix: AuthzMatrix = loadAuthzMatrix()): Plan {
  const skip = SKIPPED_OPERATIONS.get(key(op.method, op.path));
  if (skip !== undefined) return { kind: "skip", reason: skip };
  if (op.requires === undefined)
    return {
      kind: "unplanned",
      reason:
        op.source === "raw"
          ? "a raw route with no OpenAPI operation and no RAW_ROUTES entry"
          : "no row in authz-matrix.yaml",
    };
  if (op.requires === "public")
    return { kind: "skip", reason: "public: every actor is allowed, no denial cell" };
  const cells = new Map<ActorName, Outcome>();
  for (const actor of ACTORS) {
    const outcome = expectedFor(op, op.requires, actor, matrix);
    if (outcome === undefined)
      return { kind: "unplanned", reason: `requirement ${op.requires} is unknown to the sweep` };
    cells.set(actor, outcome);
  }
  return { kind: "sweep", cells };
}

/** A concrete URL for an OpenAPI template: fixed values nothing in the database matches. */
export const SWEEP_UUID = "7e57a11c-0000-4000-8000-00000000f030";
export function concretePath(template: string): string {
  return (
    API_PREFIX +
    template.replace(/\{([^}]+)\}/gu, (_, name: string) => {
      if (name === "n") return "1";
      if (name === "kind") return "document";
      if (name === "token") return "sweep-token-that-matches-nothing";
      if (name === "slug") return "sweep-slug";
      return SWEEP_UUID;
    })
  );
}
