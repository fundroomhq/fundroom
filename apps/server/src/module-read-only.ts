import { errorResponses } from "@fundroom/contracts";
import { planLimitError } from "@fundroom/control-plane";
import type { Entitlements } from "@fundroom/domain";
import { type ModuleManifest, moduleReadOnly } from "@fundroom/module-kit";
import type { Context } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "./env.js";

/*
 * Read-only modules (A-3 / E-UP-2, ADR-0063 §3.2).
 *
 * A plan gates turning a module on; a downgrade never deletes and never breaks what already runs.
 * A module that is on but outside the workspace's plan therefore stays on, and becomes read-only
 * **for staff**: nothing new and nothing changed — every staff write answers 402 `plan_limit`
 * `{ limit: "module", module }` — while reads keep working, withdrawing stays possible (every
 * DELETE and the withdraw/cancel routes below), and switching the module off stays allowed (a
 * kernel route). Investors are not affected, and scheduled jobs keep running (read-only stops
 * people, not the clock — which is why a scheduled send must always be cancellable).
 *
 * Where it is enforced, and why there:
 *  - the module mounts (`api.ts`, and the raw mount in `app.ts`) already resolve the workspace
 *    and its enablement for every module request, so they **mark** the request (`moduleMount`):
 *    which module, whether it is read-only here, and the mount's route prefix;
 *  - the guards **refuse**, after the caller has passed every check they make: the permission
 *    guard (`requirePermission`: session, membership, MFA level, permission, freshness; for an API
 *    key, its scope) for every caller, and the member guard (`requireMember`) for a **staff**
 *    caller only — some `member` routes serve staff too (a staff reply in an investor's thread,
 *    R1 M1), and a staff member writing through one is a staff write. So a 402 is never an
 *    oracle: an anonymous caller, an investor or staff without the permission get exactly the
 *    answer they got before plans existed (the entitlement sweep asserts it), and an API key is
 *    refused like a session.
 *
 * A write is any method but GET/HEAD/OPTIONS/DELETE, except the routes in `READ_ONLY_EXEMPT`.
 */

/**
 * Writes of the optional modules that a read-only module still serves, keyed
 * `METHOD /<module><OpenAPI path>` (the raw-route spelling for raw routes), each with why. Audited
 * over every permission- and member-guarded non-GET route of the eight optional modules (A-3,
 * fix round 1); everything else that writes answers 402 to staff. DELETE needs no entry: it is
 * exempt as a rule (`refusesWhileReadOnly`). A key that names no route fails
 * `module-read-only.test.ts`.
 */
export const READ_ONLY_EXEMPT: ReadonlyMap<string, string> = new Map([
  // --- reads that are POSTs ---------------------------------------------------------------------
  [
    "POST /captable/import/dry-run",
    "previews a CSV import and writes nothing (the import itself is refused)",
  ],
  [
    "POST /metrics/import/dry-run",
    "previews a CSV import and writes nothing (the import itself is refused)",
  ],
  [
    "POST /data-room/documents/{id}/forensic/detect",
    "traces a leaked page to its recipient: a read of existing marks (audited), a POST only for the image upload; a leak investigation must never need an upgrade",
  ],
  // --- telemetry and a person's own state, not module content ----------------------------------
  [
    "POST /analytics/heartbeat",
    "view telemetry (member route): records that somebody is reading, creates no content",
  ],
  [
    "POST /analytics/close",
    "view telemetry (member route): flushes a reading session's dwell, creates no content",
  ],
  [
    "POST /data-room/documents/{id}/viewed",
    "view telemetry (member route): records that a document was opened, creates no content",
  ],
  [
    "PUT /updates/subscription",
    "the caller's own email opt-out (member route): turning mail down must never need an upgrade",
  ],
  [
    "POST /notify/inbox/read",
    "marks the caller's own notifications read: reading bookkeeping, nobody else sees it",
  ],
  [
    "POST /notify/inbox/read-all",
    "marks the caller's own notifications read: reading bookkeeping, nobody else sees it",
  ],
  [
    "POST /notify/inbox/archive",
    "archives the caller's own notifications: reading bookkeeping, nobody else sees it",
  ],
  [
    "PUT /notify/preferences",
    "the caller's own notification cadence: notifications keep being sent while read-only, so a person must still be able to turn mail down",
  ],
  // --- withdrawing, cancelling, erasing (ROUND-1 decision 8; DELETE is exempt as a rule) ------
  [
    "POST /updates/posts/{id}/unschedule",
    "cancels a scheduled send: the dispatcher keeps running, so a queued mass email must always be stoppable",
  ],
  [
    "POST /data-room/qa/inbox/{id}/unpublish",
    "takes a published answer back: withdrawing, nothing new",
  ],
  [
    "POST /data-room/qa/inbox/{id}/close",
    "declines and closes a question: investors can still ask while read-only, so staff must be able to turn questions down",
  ],
  [
    "POST /data-room/qa/questions/{id}/withdraw",
    "withdraws the caller's own question (member route): withdrawing, nothing new",
  ],
  [
    "POST /round/interest/{id}/decline",
    "declines an investor's submission: investors can still submit while read-only, so staff must be able to say no",
  ],
  [
    "POST /round/current/interest/{id}/withdraw",
    "withdraws the caller's own submission (member route): withdrawing, nothing new",
  ],
  [
    "POST /round/signature-requests/{id}/void",
    "voids an outstanding signature request: cancelling, nothing new",
  ],
  [
    "POST /analytics/members/{membershipId}/anonymise",
    "erases one member's analytics (DSAR): removes data, adds nothing",
  ],
  // --- a preservation duty ----------------------------------------------------------------------
  [
    "PUT /data-room/documents/{id}/legal-hold",
    "a legal hold preserves evidence against the purge job, which keeps running; a plan must not stand between a company and a preservation duty",
  ],
]);

/**
 * Routes exempt only for some bodies: the route both withdraws and un-withdraws, and only the
 * withdrawing direction is allowed (ROUND-2 decision 16). The guard reads the JSON body for these
 * (Hono caches it, so the route's validator reads the same bytes); a body that does not parse, or
 * asks for the other direction, is refused. Data-room `restore` is deliberately NOT here or above
 * (ROUND-2 decision 14): delete + restore would move read-only content, so undeleting waits for an
 * upgrade (the trash keeps items until its purge).
 */
export const READ_ONLY_EXEMPT_WHEN: ReadonlyMap<
  string,
  { readonly reason: string; readonly allows: (body: unknown) => boolean }
> = new Map([
  [
    "PUT /updates/posts/{id}/archived",
    {
      reason:
        "archiving hides a published update from investors (withdrawing); un-archiving would re-publish it and is refused",
      allows: (body: unknown) =>
        typeof body === "object" &&
        body !== null &&
        (body as { archived?: unknown }).archived === true,
    },
  ],
]);

/** Reads, and DELETE: withdrawing is always allowed (ROUND-1 decision 8). */
const NEVER_REFUSED: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

/** `/x/:id/y` → `/x/{id}/y` (the OpenAPI spelling `READ_ONLY_EXEMPT` is keyed by). */
const toTemplate = (honoPath: string) => honoPath.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");

/** `READ_ONLY_EXEMPT`'s key for a module-relative route. */
export const readOnlyKey = (method: string, moduleId: string, path: string) =>
  `${method.toUpperCase()} /${moduleId}${toTemplate(path)}`;

/**
 * Whether a read-only module refuses `method` on its route `path` (module-relative, OpenAPI or
 * Hono spelling) with this request `body`. Pure: the guard and the OpenAPI decoration both ask
 * this; the decoration passes no body, so a route exempt only for some bodies is documented as
 * one that can answer 402.
 */
export function refusesWhileReadOnly(
  method: string,
  moduleId: string,
  path: string,
  body?: unknown,
): boolean {
  if (NEVER_REFUSED.has(method.toUpperCase())) return false;
  const key = readOnlyKey(method, moduleId, path);
  if (READ_ONLY_EXEMPT.has(key)) return false;
  const when = READ_ONLY_EXEMPT_WHEN.get(key);
  return when === undefined || !when.allows(body);
}

/**
 * Called by a module mount once it has let the request through (workspace resolved, module
 * enabled, offering status allows it): the module is on here by construction.
 */
export function markModuleMount(
  c: Context<AppEnv>,
  m: Pick<ModuleManifest, "id" | "required">,
  entitlements: Entitlements,
): void {
  c.set("moduleMount", {
    id: m.id,
    readOnly: moduleReadOnly(entitlements, m, true),
    // The mount's own `use("*")` route: `<prefix>/<module>/*`.
    routePrefix: routePath(c).replace(/\/\*$/u, ""),
  });
}

/**
 * The guards' half: throws 402 `plan_limit` `{ limit: "module", module }` when this request is a
 * write to a read-only module. Call it only after the caller passed the guard's own checks, and
 * from the member guard only for a staff caller. A kernel route carries no mark, and a required
 * module is never read-only, so neither is ever refused here.
 */
export async function assertModuleWritable(c: Context<AppEnv>): Promise<void> {
  const mount = c.get("moduleMount");
  if (mount === undefined || !mount.readOnly) return;
  const route = routePath(c);
  // A route outside its own mount's prefix cannot happen; if it ever did, refusing is the safe
  // reading (no exemption matches the empty path).
  const path = route.startsWith(mount.routePrefix) ? route.slice(mount.routePrefix.length) : "";
  // The body is read only for a route whose exemption depends on it.
  const body = READ_ONLY_EXEMPT_WHEN.has(readOnlyKey(c.req.method, mount.id, path))
    ? await c.req.json<unknown>().catch(() => undefined)
    : undefined;
  if (refusesWhileReadOnly(c.req.method, mount.id, path, body))
    throw planLimitError({ limit: "module", module: mount.id });
}

/**
 * The `x-requires` words (`authz-matrix.yaml`) whose guard never asks `assertModuleWritable`:
 * everything but a permission and `member` (where a staff caller is refused).
 */
const NOT_GUARDED_FOR_READ_ONLY: ReadonlySet<string> = new Set([
  "public",
  "session",
  "owner-or-admin",
  "platform-operator",
]);

interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly "x-requires"?: string;
  readonly responses: Record<string, unknown>;
}

const PLAN_LIMIT_RESPONSE = errorResponses(402);

/**
 * Adds 402 to the documented responses of every route a read-only module refuses — a permission-
 * or member-guarded write that `refusesWhileReadOnly` — so the modules need no edit and
 * Schemathesis' status conformance stays true. A required module is never read-only and is left
 * alone. Run on a module's router after its `routes()` registered and before it is mounted
 * (`OpenAPIHono.route` copies the definitions at that moment).
 */
export function documentReadOnlyRefusals(
  router: { readonly openAPIRegistry: { readonly definitions: readonly unknown[] } },
  m: Pick<ModuleManifest, "id" | "required">,
): void {
  if (m.required === true) return;
  for (const def of router.openAPIRegistry.definitions as { type: string; route?: unknown }[]) {
    if (def.type !== "route") continue;
    const route = def.route as RegisteredRoute;
    const requires = route["x-requires"]?.split("+")[0];
    if (requires === undefined || NOT_GUARDED_FOR_READ_ONLY.has(requires)) continue;
    if (!refusesWhileReadOnly(route.method, m.id, route.path)) continue;
    def.route = { ...route, responses: { ...route.responses, ...PLAN_LIMIT_RESPONSE } };
  }
}
