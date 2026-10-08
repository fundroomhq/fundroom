import type {
  AccreditationActor,
  AccreditationConnectionDetail,
  AccreditationProviderInfo,
} from "@fundroom/accreditation";
import {
  ApiError,
  accreditation as ac,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { isPlanEntitlementError } from "@fundroom/control-plane";
import type { ResolvedWorkspace } from "@fundroom/db";
import { ACCREDITATION_HANDOFF_PATH } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { type ApiDeps, principalOf, workspaceUrl } from "./deps.js";

/*
 * Accreditation vendor connections (E3.7, ADR-0055) — kernel routes behind the `required`
 * `accreditation` manifest. The service is `@fundroom/accreditation`; it opens its own short
 * transactions and makes every vendor call outside them.
 *
 * - Credentials are write-only (`credentialHints` only).
 * - Saving, re-verifying and disconnecting need a fresh session (step-up).
 * - The vendor callback (`POST /webhooks/accreditation/{connectionId}`) is an ops route outside
 *   `/api/v1` (no row in the matrix): `./accreditation-callback.ts`.
 *
 * - Service errors (`AccreditationError`) carry an API error code and are adopted by the error
 *   handler as they are: `accreditation_credentials_invalid`, `accreditation_driver_not_offered`,
 *   `accreditation_provider_error`, `not_found` (no connection), `conflict`.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 502, 503);
/**
 * `PUT /accreditation/connection` only: creating a connection (none live, or a vendor switch) is
 * turning the `accreditation` feature on (A-3, ADR-0063) — 402 `plan_limit` when the plan leaves it
 * out. Re-keying the live connection, verify, verifications through it, callbacks and disconnecting
 * are maintenance: never refused.
 */
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 503);
const TAGS = ["accreditation"];

/**
 * Connection save ATTEMPTS per workspace per hour (contract §3: peek before, hit after). Every
 * attempt that got past the budget is charged — refused ones too — because each one makes a live
 * credential check against the vendor: the budget bounds how hard a workspace can make this
 * install probe a vendor's API with guessed keys, and (like `ESIGN_CONNECTION_MINT_LIMIT`) how many
 * connection ids it can mint into the callback route's recent-auth LRU.
 */
export const ACCREDITATION_CONNECTION_SAVE_LIMIT = { max: 10, windowMs: 60 * 60_000 } as const;

function providerBody(p: AccreditationProviderInfo) {
  return {
    driver: p.meta.driver,
    label: p.meta.label,
    handoff: p.meta.handoff,
    supportsEntities: p.meta.supportsEntities,
    certificate: p.meta.certificate,
    callbackSignature: p.meta.callbackSignature,
    subProcessor: { ...p.meta.subProcessor },
    credentialFields: p.credentialFields.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required,
      ...(f.options === undefined ? {} : { options: [...f.options] }),
      ...(f.help === undefined ? {} : { help: f.help }),
    })),
    offered: p.offered,
  };
}

function actorOf(c: Context<AppEnv>): AccreditationActor {
  const p = principalOf(c);
  return {
    membershipId: p.membership.id,
    requestId: requestIdOf(c),
    ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
    ...(p.apiKeyId === undefined ? {} : { apiKeyId: p.apiKeyId }),
  };
}

function rateLimited(retryAfterMs: number, message: string): never {
  throw new ApiError(
    "rate_limited",
    message,
    { retryAfterMs },
    { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  );
}

export function registerAccreditationRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const service = () => deps.accreditation;
  /**
   * The contract's `AccreditationConnection`: the service's detail plus the workspace's handoff
   * page (its own origin — custom domain, tenant host or base URL — as the investor sees it; a
   * widget vendor's redirect URI must equal it exactly).
   */
  const connectionBody = (
    v: AccreditationConnectionDetail,
    workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
  ) => ({
    id: v.id,
    driver: v.driver,
    label: v.label,
    environment: v.environment,
    credentialHints: { ...v.credentialHints },
    status: v.status,
    lastVerifiedAt: v.lastVerifiedAt,
    lastError: v.lastError,
    lastCallbackAt: v.lastCallbackAt,
    callbackUrl: v.callbackUrl,
    // Relative to BASE_URL, which already carries the base path (E3.9: no double prefix).
    handoffUrl: workspaceUrl(
      deps.baseUrl,
      deps.tenancy,
      workspace,
      ACCREDITATION_HANDOFF_PATH,
      deps.basePath,
    ).href,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  });

  api.openapi(
    createRoute({
      method: "get",
      path: "/accreditation/providers",
      tags: TAGS,
      summary: "The accreditation vendors this instance knows",
      description:
        "Each vendor's metadata (handoff kind, entity support, certificate, callback signature, sub-processor facts) and the credential fields its connection form asks for. `offered` is false for a vendor the operator does not offer (`ACCREDITATION_DRIVERS`). Manual review is always available and is not listed.",
      security: sessionSecurity,
      "x-requires": "accreditation.read",
      middleware: [perm("accreditation.read")] as const,
      responses: { 200: jsonResponse(ac.AccreditationProviderListSchema, "Providers"), ...ERRORS },
    }),
    async (c) => {
      const providers = service().providers().map(providerBody);
      return c.json({ providers }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/accreditation/connection",
      tags: TAGS,
      summary: "The workspace's accreditation vendor connection",
      description:
        "Never a credential: `credentialHints` only. `connection: null` when none is configured (verifications are reviewed manually). `callbackUrl` is what to paste into the vendor's webhook settings; `handoffUrl` is the redirect URI to register with a widget vendor.",
      security: sessionSecurity,
      "x-requires": "accreditation.read",
      middleware: [perm("accreditation.read")] as const,
      responses: {
        200: jsonResponse(ac.AccreditationConnectionResponseSchema, "Connection"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const detail = await service().connection(tenant);
      return c.json(
        { connection: detail === undefined ? null : connectionBody(detail, workspace) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/accreditation/connection",
      tags: TAGS,
      summary: "Connect (or replace) the accreditation vendor",
      description:
        'The credentials are verified live against the vendor before anything is stored (422 `accreditation_credentials_invalid`, `details.fields` when the vendor names them). 422 `accreditation_driver_not_offered` for a vendor the operator does not offer. A same-driver save keeps blank secret fields; `clearCredentials` forgets optional secrets. At most 10 saves an hour per workspace (429 `rate_limited` with `Retry-After`). 402 `plan_limit` (`feature: "accreditation"`) when the save would create a connection (none live, or a different vendor) and the workspace\'s plan does not include accreditation; re-keying the live connection is always allowed. New verifications use the vendor from then on; pending ones keep their provider. Needs a fresh session.',
      security: sessionSecurity,
      "x-requires": "accreditation.manage+fresh",
      middleware: [perm("accreditation.manage", { fresh: true })] as const,
      request: { body: jsonBody(ac.AccreditationConnectionPutSchema) },
      responses: {
        200: jsonResponse(ac.AccreditationConnectionSavedSchema, "Saved"),
        ...GATED_ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const body = c.req.valid("json");
      const key = `accreditation.connection-save:${workspace.id}`;
      const peek = await deps.rateLimiter.peek(key, ACCREDITATION_CONNECTION_SAVE_LIMIT);
      if (!peek.allowed) {
        rateLimited(peek.retryAfterMs, "too many accreditation connection saves in this workspace");
      }
      const entitlements = deps.entitlements.of(workspace);
      // A plan refusal never reaches the vendor, so it is not charged to the save budget.
      let charge = true;
      try {
        const saved = await service().saveConnection(
          tenant,
          {
            driver: body.driver,
            credentials: body.credentials,
            ...(body.clearCredentials === undefined
              ? {}
              : { clearCredentials: body.clearCredentials }),
            // The service calls it only for a new connection or a vendor switch (A-3).
            assertMayConnect: () => deps.entitlements.assertFeature(entitlements, "accreditation"),
          },
          actorOf(c),
        );
        return c.json({ connection: connectionBody(saved, workspace) }, 200);
      } catch (error) {
        if (isPlanEntitlementError(error)) charge = false;
        throw error;
      } finally {
        if (charge) await deps.rateLimiter.hit(key, ACCREDITATION_CONNECTION_SAVE_LIMIT);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/accreditation/connection/verify",
      tags: TAGS,
      summary: "Re-verify the vendor credentials",
      description:
        "Re-runs the live credential check and records the outcome on the connection (`status`, `lastError`). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "accreditation.manage+fresh",
      middleware: [perm("accreditation.manage", { fresh: true })] as const,
      responses: {
        200: jsonResponse(ac.AccreditationConnectionSavedSchema, "Connection"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const detail = await service().verifyConnection(tenant, actorOf(c));
      return c.json({ connection: connectionBody(detail, workspace) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/accreditation/connection",
      tags: TAGS,
      summary: "Disconnect the accreditation vendor",
      description:
        "New verifications are reviewed manually from then on. Pending vendor verifications stop being polled and are left for an admin to decide. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "accreditation.manage+fresh",
      middleware: [perm("accreditation.manage", { fresh: true })] as const,
      responses: { 200: jsonResponse(OkSchema, "Disconnected"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      await service().deleteConnection(tenant, actorOf(c));
      return c.json({ ok: true as const }, 200);
    },
  );
}
