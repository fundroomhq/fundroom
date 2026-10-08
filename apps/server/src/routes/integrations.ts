import {
  ApiError,
  createRoute,
  errorResponses,
  integrations as ig,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { ResolvedWorkspace } from "@fundroom/db";
import type {
  BookingLinkView,
  IntegrationActor,
  IntegrationBookingRecord,
  IntegrationConnectionView,
} from "@fundroom/integrations";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requireMember, requirePermission } from "../middleware/authz.js";
import { type ApiDeps, principalOf } from "./deps.js";

/*
 * Integrations hub (E3.6, ADR-0054) — kernel routes behind the `required` `integrations` manifest.
 * The service is `@fundroom/integrations` (`IntegrationsKernel`, whose `services` modules see as
 * `ModuleServices.integrations`); it opens its own short transactions and makes every vendor call
 * outside them, so no handler here holds a transaction across a vendor call.
 *
 * - Credentials are write-only: no response carries a token, key or pasted secret. A booking
 *   provider's webhook signing secret exists once, in the response that minted it (connect,
 *   rotate-webhook-secret).
 * - Credential-bearing writes (connect, OAuth begin, account choice, re-key, disconnect) need a
 *   fresh session (`stepUp`); the bookings register is key-callable.
 * - OAuth: `POST …/oauth/begin` answers a single-use 2-minute `startUrl`; the SPA navigates the
 *   top-level window there. The vendor's callback only stores the verified grant as PENDING; the
 *   initiator confirms it with `POST …/oauth/complete` and the fragment token (fix round 1). The start/callback halves are ops routes (`./integrations-oauth.ts`),
 *   and the booking webhook is `./integrations-webhook.ts` — neither has a matrix row.
 * - `GET /integrations/me/booking-links` is the portal's "Book time" card: staff see every
 *   enabled link, external members (and their delegates) the ones whose audience admits them.
 *
 * Service errors (`IntegrationError`) carry an API error code and are adopted as they are.
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 502, 503);
/**
 * Connecting a provider the workspace has no live connection of (pasted secret, either half of
 * OAuth) is turning the `integrations` feature on (A-3, ADR-0063): 402 `plan_limit` when the plan
 * leaves it out. Reconnecting a connected provider (re-keying, re-authorising) is maintenance, as is
 * everything an existing connection does — syncs, KPI bindings, Slack, bookings, verify, choosing
 * the vendor account, rotating the webhook secret, disconnecting: never refused.
 */
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 503);
const TAGS = ["integrations"];

/**
 * Connects that MINT a booking-webhook connection id per workspace per hour. Each id that
 * authenticates a webhook takes a slot in the webhook route's bounded recent-auth LRU (the esign
 * reasoning, R3C), so one tenant must not be able to flush every other tenant's slot.
 */
export const INTEGRATION_CONNECTION_MINT_LIMIT = { max: 10, windowMs: 60 * 60_000 } as const;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** The contract's `IntegrationConnection`: an explicit allow-list, so nothing else rides along. */
export function connectionBody(v: IntegrationConnectionView) {
  return {
    id: v.id,
    provider: v.provider,
    status: v.status,
    environment: v.environment,
    accountLabel: v.accountLabel,
    externalAccountId: v.externalAccountId,
    ...(v.availableAccounts === undefined
      ? {}
      : { availableAccounts: v.availableAccounts.map((a) => ({ id: a.id, name: a.name })) }),
    scope: v.scope,
    lastSuccessAt: iso(v.lastSuccessAt),
    lastFailureAt: iso(v.lastFailureAt),
    lastError: v.lastError,
    consecutiveFailures: v.consecutiveFailures,
    connectedAt: v.connectedAt.toISOString(),
    webhookUrl: v.webhookUrl,
  };
}

function linkBody(v: BookingLinkView) {
  return {
    id: v.id,
    provider: v.provider,
    url: v.url,
    label: v.label,
    description: v.description,
    audience:
      v.audience.kind === "all"
        ? { kind: "all" as const }
        : { kind: "groups" as const, groupIds: [...v.audience.groupIds] },
    position: v.position,
    enabled: v.enabled,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function bookingBody(v: IntegrationBookingRecord) {
  return {
    id: v.id,
    provider: v.provider,
    status: v.status,
    startsAt: v.startsAt.toISOString(),
    endsAt: iso(v.endsAt),
    inviteeEmail: v.inviteeEmail,
    inviteeName: v.inviteeName,
    eventName: v.eventName,
    membershipId: v.membershipId,
    receivedAt: v.receivedAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function actorOf(c: Context<AppEnv>): IntegrationActor {
  const p = principalOf(c);
  return {
    membershipId: p.membership.id,
    requestId: requestIdOf(c),
    ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
    ...(p.apiKeyId === undefined ? {} : { apiKeyId: p.apiKeyId }),
  };
}

export function registerIntegrationRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  const perm = (p: string, extra: { readonly fresh?: boolean; readonly apiKey?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const service = () => deps.integrations;
  /** A-3: the plan's gate, called by the service only for a provider with no live connection. */
  const mayConnect = (workspace: ResolvedWorkspace) => {
    const entitlements = deps.entitlements.of(workspace);
    return () => deps.entitlements.assertFeature(entitlements, "integrations");
  };

  // --- providers & connections -------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/integrations/providers",
      tags: TAGS,
      summary: "The integrations this install offers",
      description:
        "Each provider's capabilities, how it connects (OAuth or a pasted credential and its form fields), what it reads (`scopeExplanation`), its sub-processor facts, its KPI metrics and booking-link hosts. `available: false` is an OAuth provider whose client the operator has not configured.",
      security: sessionSecurity,
      "x-requires": "integrations.read",
      middleware: [perm("integrations.read")] as const,
      responses: { 200: jsonResponse(ig.IntegrationProviderListSchema, "Providers"), ...ERRORS },
    }),
    async (c) => {
      const providers = service()
        .providers()
        .map((p) => ({
          provider: p.provider,
          displayName: p.displayName,
          capabilities: [...p.capabilities],
          auth: p.auth,
          available: p.available,
          credentialFields: p.credentialFields.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind,
            required: f.required,
            ...(f.help === undefined ? {} : { help: f.help }),
          })),
          scopeExplanation: [...p.scopeExplanation],
          kpiMetrics: p.kpiMetrics.map((m) => ({ ...m })),
          bookingLinkHosts: [...p.bookingLinkHosts],
          subProcessor: { ...p.subProcessor },
        }));
      return c.json({ providers }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/integrations/connections",
      tags: TAGS,
      summary: "The workspace's live connections",
      description:
        "Never a credential. `status`: `active`, `degraded` (3+ consecutive vendor failures) or `reauth_required` (the vendor refused the token; reconnect).",
      security: sessionSecurity,
      "x-requires": "integrations.read",
      middleware: [perm("integrations.read")] as const,
      responses: {
        200: jsonResponse(ig.IntegrationConnectionListSchema, "Connections"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const connections = (await service().list(tenant)).map(connectionBody);
      return c.json({ connections }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/{provider}/connect",
      tags: TAGS,
      summary: "Connect a provider with a pasted credential",
      description:
        'Secret providers only (Stripe restricted key, Calendly personal access token, Cal.com none); an OAuth provider answers 409 `integration_oauth_required`. The credential is verified live before anything is stored (422 `integration_credentials_rejected` + `reason`). Stripe refuses a full secret key `sk_…` (422 `integration_secret_key_refused`); the environment follows the `rk_live_`/`rk_test_` prefix. A booking provider\'s response carries `webhookSecret` ONCE (Calendly is subscribed automatically; for Cal.com paste the `webhookUrl` and secret into its webhook settings). Replaces any live connection of the provider. At most 10 booking connections an hour per workspace (429). 402 `plan_limit` (`feature: "integrations"`) when the workspace has no live connection of this provider and its plan does not include integrations; reconnecting a connected provider is always allowed. Needs a fresh session.',
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: {
        params: ig.IntegrationProviderParams,
        body: jsonBody(ig.IntegrationConnectBodySchema),
      },
      responses: {
        200: jsonResponse(ig.IntegrationConnectResultSchema, "Connected"),
        ...GATED_ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const booking = provider === "calendly" || provider === "calcom";
      const mintKey = `integrations.connection-mint:${workspace.id}`;
      if (booking) {
        const peek = await deps.rateLimiter.peek(mintKey, INTEGRATION_CONNECTION_MINT_LIMIT);
        if (!peek.allowed) {
          throw new ApiError(
            "rate_limited",
            "too many new booking connections in this workspace",
            { retryAfterMs: peek.retryAfterMs },
            {
              headers: {
                "Retry-After": String(Math.max(1, Math.ceil(peek.retryAfterMs / 1000))),
              },
            },
          );
        }
      }
      const saved = await service().connectWithSecret(
        tenant,
        provider,
        {
          credentials: body.credentials,
          ...(body.environment === undefined ? {} : { environment: body.environment }),
          assertMayConnect: mayConnect(workspace),
        },
        actorOf(c),
      );
      if (booking) await deps.rateLimiter.hit(mintKey, INTEGRATION_CONNECTION_MINT_LIMIT);
      return c.json(
        {
          connection: connectionBody(saved.connection),
          ...(saved.webhookSecret === undefined ? {} : { webhookSecret: saved.webhookSecret }),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/{provider}/oauth/begin",
      tags: TAGS,
      summary: "Start connecting an OAuth provider",
      description:
        "Returns a single-use `startUrl` valid for 2 minutes; navigate the top-level window there (`window.location.assign`). The browser is bound to the handshake by a cookie set at the start URL, and the vendor's consent screen returns to `returnPath` (default `/admin/integrations`) with `?integration=<provider>&result=pending#pending=<token>` — confirm it with `POST /integrations/{provider}/oauth/complete` — or `?integration=<provider>&result=error&reason=…`. 409 `integration_not_available` when the operator has not configured the provider's OAuth client. At most 10 open handshakes per member (429). 402 `plan_limit` (`feature: \"integrations\"`) when the workspace has no live connection of this provider and its plan does not include integrations; reconnecting a connected provider is always allowed. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: {
        params: ig.IntegrationProviderParams,
        body: jsonBody(ig.IntegrationOAuthBeginBodySchema),
      },
      responses: {
        200: jsonResponse(ig.IntegrationOAuthBeginResultSchema, "Start URL"),
        ...GATED_ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const begun = await service().beginOAuth(
        tenant,
        provider,
        {
          ...(body.environment === undefined ? {} : { environment: body.environment }),
          ...(body.returnPath === undefined ? {} : { returnPath: body.returnPath }),
          assertMayConnect: mayConnect(workspace),
        },
        actorOf(c),
      );
      return c.json({ startUrl: begun.startUrl, expiresAt: begun.expiresAt.toISOString() }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/{provider}/oauth/complete",
      tags: TAGS,
      summary: "Confirm an OAuth connection",
      description:
        "The second half of connecting an OAuth provider. The vendor's callback does not connect anything: it lands on `returnPath?integration=<provider>&result=pending` with a one-time token in the URL fragment (`#pending=…`, 10 minutes). The member who began the handshake — signed in here, still holding `integrations.manage`, with a fresh session — sends it here to create the connection (replacing any live one of the provider). Every refusal (unknown, expired, used, another member's or another provider's token) is 404 `integration_oauth_pending_invalid`. So a start link mailed to someone else can never put their vendor account into the sender's workspace. 402 `plan_limit` (`feature: \"integrations\"`) when the workspace has no live connection of this provider and its plan does not include integrations; reconnecting a connected provider is always allowed.",
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: {
        params: ig.IntegrationProviderParams,
        body: jsonBody(ig.IntegrationOAuthCompleteBodySchema),
      },
      responses: {
        200: jsonResponse(ig.IntegrationConnectionSchema, "Connected"),
        ...GATED_ERRORS,
      },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const view = await service().confirmOAuth(tenant, provider, body.pendingToken, actorOf(c), {
        assertMayConnect: mayConnect(workspace),
      });
      return c.json(connectionBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/{provider}/verify",
      tags: TAGS,
      summary: "Re-check a connection against the vendor",
      description:
        "Calls the vendor's cheapest authenticated endpoint (refreshing an OAuth token first when due) and records the outcome on the connection's health. 404 `integration_not_connected`.",
      security: sessionSecurity,
      "x-requires": "integrations.manage",
      middleware: [perm("integrations.manage")] as const,
      request: { params: ig.IntegrationProviderParams },
      responses: {
        200: jsonResponse(ig.IntegrationConnectionSchema, "Connection"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { provider } = c.req.valid("param");
      const view = await service().verify(tenant, provider, actorOf(c));
      return c.json(connectionBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/integrations/{provider}/account",
      tags: TAGS,
      summary: "Choose the vendor account (Xero organisation)",
      description:
        "`externalAccountId` must be one of the connection's `availableAccounts` (422 `integration_account_unknown`); the vendor is asked to confirm it before it is stored. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: {
        params: ig.IntegrationProviderParams,
        body: jsonBody(ig.IntegrationSelectAccountBodySchema),
      },
      responses: {
        200: jsonResponse(ig.IntegrationConnectionSchema, "Connection"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const view = await service().selectAccount(
        tenant,
        provider,
        body.externalAccountId,
        actorOf(c),
      );
      return c.json(connectionBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/{provider}/rotate-webhook-secret",
      tags: TAGS,
      summary: "Mint a new booking-webhook signing secret",
      description:
        "Booking providers only (409 `conflict` otherwise). The new secret is returned ONCE and the old one stops working immediately (Calendly is re-subscribed with it; for Cal.com paste it into the webhook settings). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: { params: ig.IntegrationProviderParams },
      responses: {
        200: jsonResponse(ig.IntegrationWebhookSecretResultSchema, "The new secret"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { provider } = c.req.valid("param");
      const rotated = await service().rotateWebhookSecret(tenant, provider, actorOf(c));
      return c.json(
        { connection: connectionBody(rotated.connection), webhookSecret: rotated.webhookSecret },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/integrations/{provider}",
      tags: TAGS,
      summary: "Disconnect a provider",
      description:
        "Always succeeds for a live connection (modules that used it see it disconnected and record failures). The vendor grant is revoked and a booking webhook subscription removed, best effort. Recorded bookings are kept. 404 `integration_not_connected`. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "integrations.manage+fresh",
      middleware: [perm("integrations.manage", { fresh: true })] as const,
      request: { params: ig.IntegrationProviderParams },
      responses: { 200: jsonResponse(OkSchema, "Disconnected"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { provider } = c.req.valid("param");
      await service().disconnect(tenant, provider, actorOf(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- recorded bookings --------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/integrations/bookings",
      tags: TAGS,
      summary: "Meetings booked through Calendly / Cal.com",
      description:
        "Newest meeting first, keyset-paginated (`nextCursor`). Recorded from verified booking webhooks; `membershipId` is the member whose address matched the invitee's. Kept 400 days after the meeting. Key-callable.",
      security: sessionOrApiKeySecurity,
      "x-requires": "integrations.read+apikey",
      middleware: [perm("integrations.read", { apiKey: true })] as const,
      request: { query: ig.IntegrationBookingListQuery },
      responses: { 200: jsonResponse(ig.IntegrationBookingPageSchema, "Bookings"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const q = c.req.valid("query");
      const page = await service().bookings(tenant, {
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      return c.json({ items: page.items.map(bookingBody), nextCursor: page.nextCursor }, 200);
    },
  );

  // --- booking links ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/integrations/booking-links",
      tags: TAGS,
      summary: "The portal's booking links",
      security: sessionSecurity,
      "x-requires": "integrations.read",
      middleware: [perm("integrations.read")] as const,
      responses: { 200: jsonResponse(ig.BookingLinkListSchema, "Links"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const links = (await service().bookingLinks.list(tenant)).map(linkBody);
      return c.json({ links }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/integrations/booking-links",
      tags: TAGS,
      summary: "Add a booking link",
      description:
        "`url` must be `https://` on one of the provider's `bookingLinkHosts`, with no user info and no port (422 `booking_link_invalid_url` + `reason`). A link needs no connection (it is just a URL); recording the bookings does. At most 10 links per workspace (409 `booking_link_limit`). `audience` defaults to everyone; a groups audience names 1–50 live groups.",
      security: sessionSecurity,
      "x-requires": "integrations.manage",
      middleware: [perm("integrations.manage")] as const,
      request: { body: jsonBody(ig.BookingLinkCreateBodySchema) },
      responses: { 200: jsonResponse(ig.BookingLinkSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const body = c.req.valid("json");
      const link = await service().bookingLinks.put(
        tenant,
        null,
        {
          provider: body.provider,
          url: body.url,
          label: body.label,
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.audience === undefined ? {} : { audience: body.audience }),
          ...(body.position === undefined ? {} : { position: body.position }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
        actorOf(c),
      );
      return c.json(linkBody(link), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/integrations/booking-links/{id}",
      tags: TAGS,
      summary: "Change a booking link",
      security: sessionSecurity,
      "x-requires": "integrations.manage",
      middleware: [perm("integrations.manage")] as const,
      request: {
        params: ig.BookingLinkIdParams,
        body: jsonBody(ig.BookingLinkPatchBodySchema),
      },
      responses: { 200: jsonResponse(ig.BookingLinkSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const link = await service().bookingLinks.put(
        tenant,
        id,
        {
          ...(body.url === undefined ? {} : { url: body.url }),
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.audience === undefined ? {} : { audience: body.audience }),
          ...(body.position === undefined ? {} : { position: body.position }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
        actorOf(c),
      );
      return c.json(linkBody(link), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/integrations/booking-links/{id}",
      tags: TAGS,
      summary: "Remove a booking link",
      security: sessionSecurity,
      "x-requires": "integrations.manage",
      middleware: [perm("integrations.manage")] as const,
      request: { params: ig.BookingLinkIdParams },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      await service().bookingLinks.remove(tenant, id, actorOf(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/integrations/me/booking-links",
      tags: TAGS,
      summary: "Booking links shown to the signed-in member",
      description:
        "Staff see every enabled link; an external member (or a delegate, with its principal's groups) the enabled links whose audience admits them. Links open in a new tab on the vendor's site.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [requireMember({ gate })] as const,
      responses: {
        200: jsonResponse(ig.BookingLinkPublicListSchema, "Links"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant, membership } = principalOf(c);
      const links = await service().bookingLinks.forMember(tenant, membership.id);
      return c.json(
        {
          links: links.map((l) => ({
            id: l.id,
            provider: l.provider,
            url: l.url,
            label: l.label,
            description: l.description,
          })),
        },
        200,
      );
    },
  );
}
