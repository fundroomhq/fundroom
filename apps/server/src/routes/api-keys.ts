import type { ApiKeyView } from "@fundroom/api-keys";
import {
  ApiError,
  apiKeys as ak,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { requireFeature } from "../middleware/entitlements.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * Workspace API keys (E3.4, ADR-0052).
 *
 * Kernel routes behind the `required` `api-keys` manifest: the bearer lookup runs during tenant
 * resolution, before module enablement is knowable, so the thing that decides who a caller is
 * cannot have an off switch. No route here is key-callable (matrix rows without `apiKey`): a key
 * never sees or mints keys. Every mutation needs step-up.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 *
 * Key errors from `@fundroom/api-keys` (`ApiKeyError`) carry an API error code and are adopted by
 * the error handler as they are: `validation_failed` (`scope_not_held`, `scope_not_offered`,
 * `invalid_expiry`, `invalid_cursor`), `not_found`, `conflict` (`too_many_keys`, `key_not_live`,
 * `already_rotated`).
 *
 * Plan entitlements (A-3, ADR-0063): only minting a new key needs the plan's `api_keys` feature
 * (402 `plan_limit`, after the permission guard). Existing keys keep authenticating after a
 * downgrade, and rotate, rename and revoke stay open — rotating after a leak must never need an
 * upgrade.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);
const TAGS = ["api-keys"];

/** `ApiKeyView` → the contract's (mutable) `ApiKey`. */
function keyBody(v: ApiKeyView) {
  return { ...v, scopes: [...v.scopes], createdBy: { ...v.createdBy } };
}

/** The session caller (every route here is session-only; the guard has already admitted it). */
function signed(c: Context<AppEnv>) {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  if (session === undefined || membership === undefined || tenant === undefined)
    throw new ApiError("unauthenticated", "sign in to continue");
  return { session, membership, tenant };
}

export function registerApiKeyRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const meta = (c: Context<AppEnv>) => ({
    sessionId: c.get("session")?.sessionId,
    requestId: requestIdOf(c),
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent"),
  });

  api.openapi(
    createRoute({
      method: "get",
      path: "/api-keys",
      tags: TAGS,
      summary: "The workspace's API keys",
      description:
        "Newest first. Never the token or its hash: `prefix` (the token's first 12 characters) is how a key is recognised. `status` is computed at read time (`expired` once `expiresAt` has passed).",
      security: sessionSecurity,
      "x-requires": "api-keys.read",
      middleware: [perm("api-keys.read")] as const,
      request: { query: ak.ApiKeyListQuery },
      responses: { 200: jsonResponse(ak.ApiKeyListSchema, "Keys"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = signed(c);
      const q = c.req.valid("query");
      const page = await deps.apiKeys.list(tenant, q);
      return c.json({ items: page.items.map(keyBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/api-keys/scopes",
      tags: TAGS,
      summary: "The scopes a key may be given, and which the caller holds",
      description:
        "Every permission some key-callable route requires. A key can only be given scopes its creator holds (`held`).",
      security: sessionSecurity,
      "x-requires": "api-keys.read",
      middleware: [perm("api-keys.read")] as const,
      responses: { 200: jsonResponse(ak.ApiKeyScopesSchema, "Scopes"), ...ERRORS },
    }),
    async (c) => {
      const { membership } = signed(c);
      return c.json({ scopes: deps.apiKeys.scopes(membership) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/api-keys",
      tags: TAGS,
      summary: "Create an API key (the token is shown once)",
      description:
        "The key acts as the caller, capped by `scopes`. 400 `validation_failed` with `reason` `scope_not_held` (a scope the caller lacks) or `scope_not_offered`; 409 `conflict` `too_many_keys` beyond 50 live keys. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "api-keys.manage+fresh",
      middleware: [
        perm("api-keys.manage", { fresh: true }),
        requireFeature(deps, "api_keys"),
      ] as const,
      request: { body: jsonBody(ak.CreateApiKeyBody) },
      responses: { 201: jsonResponse(ak.CreatedApiKeySchema, "Created"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = signed(c);
      const body = c.req.valid("json");
      const created = await deps.apiKeys.create(
        tenant,
        membership,
        {
          name: body.name,
          scopes: body.scopes,
          expiresAt:
            body.expiresAt === undefined || body.expiresAt === null
              ? null
              : new Date(body.expiresAt),
          note: body.note ?? null,
        },
        meta(c),
      );
      return c.json({ key: keyBody(created.key), token: created.token }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/api-keys/{id}",
      tags: TAGS,
      summary: "Rename a key or change its note",
      description: "Scopes are immutable: create a new key to change them. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "api-keys.manage+fresh",
      middleware: [perm("api-keys.manage", { fresh: true })] as const,
      request: { params: ak.ApiKeyIdParams, body: jsonBody(ak.UpdateApiKeyBody) },
      responses: { 200: jsonResponse(ak.ApiKeyResultSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = signed(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const key = await deps.apiKeys.update(
        tenant,
        id,
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
        },
        meta(c),
      );
      return c.json({ key: keyBody(key) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/api-keys/{id}/rotate",
      tags: TAGS,
      summary: "Rotate a key (the new token is shown once)",
      description:
        "Mints a new key with the same name, scopes, note and expiry, created by the caller (whose permissions must cover the scopes). The old key keeps working for `graceHours` (0 revokes it at once). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "api-keys.manage+fresh",
      middleware: [perm("api-keys.manage", { fresh: true })] as const,
      request: { params: ak.ApiKeyIdParams, body: jsonBody(ak.RotateApiKeyBody) },
      responses: { 201: jsonResponse(ak.RotatedApiKeySchema, "Rotated"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = signed(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const rotated = await deps.apiKeys.rotate(tenant, membership, id, body.graceHours, meta(c));
      return c.json(
        { key: keyBody(rotated.key), token: rotated.token, previous: keyBody(rotated.previous) },
        201,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/api-keys/{id}/revoke",
      tags: TAGS,
      summary: "Revoke a key",
      description: "Idempotent: revoking a revoked key answers the key. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "api-keys.manage+fresh",
      middleware: [perm("api-keys.manage", { fresh: true })] as const,
      request: { params: ak.ApiKeyIdParams },
      responses: { 200: jsonResponse(ak.ApiKeyResultSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = signed(c);
      const { id } = c.req.valid("param");
      const key = await deps.apiKeys.revoke(tenant, id, meta(c));
      return c.json({ key: keyBody(key) }, 200);
    },
  );
}
