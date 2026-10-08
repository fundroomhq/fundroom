import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
  webhooks as wh,
} from "@fundroom/contracts";
import {
  isWebhookError,
  WEBHOOK_REDELIVER_LIMIT,
  WEBHOOK_TEST_LIMIT,
  type WebhookActor,
  type WebhookDeliveryView,
  type WebhookEndpointView,
} from "@fundroom/webhooks";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { requireFeature } from "../middleware/entitlements.js";
import { type ApiDeps, principalOf } from "./deps.js";

/*
 * Outbound webhooks (E3.4, ADR-0052).
 *
 * Kernel routes behind the `required` `webhooks` manifest: delivery needs the guarded outbound
 * HTTP agent (kernel-only on purpose) and fans out events from every module. The endpoint URL is
 * write-only and the signing secret is shown once.
 *
 * `PATCH /webhooks/endpoints/{id}` runs the step-up check only when the body carries `url` (the
 * notify channels precedent): its matrix row and `x-requires` say `webhooks.manage`, and the
 * handler calls the fresh guard itself for that body.
 *
 * The two delivery-log reads are key-callable (`apiKey: true`): a Zapier/Make poll reconciles
 * what it received against what was sent. Everything else needs a signed-in admin.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 *
 * Plan entitlements (A-3, ADR-0063; round-1 decision 3): adding an endpoint, and a PATCH that adds
 * something — a topic it does not have, another URL, or switching back on an endpoint a person
 * switched off — need the plan's `webhooks` feature (402 `plan_limit`, after the permission and
 * step-up guards). After a downgrade the endpoints already set up keep delivering; test,
 * redeliver, rotate-secret, removing topics, re-enabling one the system disabled
 * (`failing`/`gone`), disable and delete stay open.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);
const TAGS = ["webhooks"];

/** `WebhookError` onto the closed API codes; `error.reason` carries the package's reason. */
function rethrow(error: unknown): never {
  if (isWebhookError(error)) {
    const code: ApiErrorCode = error.code;
    throw new ApiError(code, error.message, { ...error.details, reason: error.reason });
  }
  throw error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    rethrow(error);
  }
}

function actorOf(c: Context<AppEnv>): WebhookActor {
  const p = principalOf(c);
  return {
    requestId: requestIdOf(c),
    ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
  };
}

/** The contract's `WebhookEndpoint` (readonly arrays copied). */
function endpointBody(v: WebhookEndpointView) {
  return {
    ...v,
    events: [...v.events],
    ...(v.stats === undefined ? {} : { stats: { last24h: { ...v.stats.last24h } } }),
  };
}

function deliveryBody(v: WebhookDeliveryView) {
  const { payload: _payload, lastResponseExcerpt: _excerpt, ...rest } = v;
  return rest;
}

function deliveryDetailBody(v: WebhookDeliveryView) {
  return {
    ...deliveryBody(v),
    payload: (v.payload ?? {}) as Record<string, unknown>,
    lastResponseExcerpt: v.lastResponseExcerpt ?? null,
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

export function registerWebhookRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean; readonly apiKey?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const service = () => deps.webhooks;

  api.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/topics",
      tags: TAGS,
      summary: "The topics this workspace may subscribe to",
      description:
        "Only topics of modules enabled here. `personLevel` topics are delivered only for members whose tracking consent allows it. The synthetic `webhook.ping` (test sends) is not subscribable.",
      security: sessionSecurity,
      "x-requires": "webhooks.read",
      middleware: [perm("webhooks.read")] as const,
      responses: { 200: jsonResponse(wh.WebhookTopicsSchema, "Topics"), ...ERRORS },
    }),
    async (c) => {
      const topics = await service().listTopics(principalOf(c).tenant);
      return c.json({ topics }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/endpoints",
      tags: TAGS,
      summary: "The workspace's webhook endpoints",
      description: "Never the URL or a secret: `urlHost` and `urlHint` only.",
      security: sessionSecurity,
      "x-requires": "webhooks.read",
      middleware: [perm("webhooks.read")] as const,
      responses: { 200: jsonResponse(wh.WebhookEndpointListSchema, "Endpoints"), ...ERRORS },
    }),
    async (c) => {
      const items = await service().listEndpoints(principalOf(c).tenant);
      return c.json({ items: items.map(endpointBody), nextCursor: null }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/endpoints",
      tags: TAGS,
      summary: "Add a webhook endpoint (the signing secret is shown once)",
      description:
        "The URL is validated (https; no private or link-local address) and stored encrypted. 409 `conflict` `too_many_endpoints` beyond 20. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage+fresh",
      middleware: [
        perm("webhooks.manage", { fresh: true }),
        requireFeature(deps, "webhooks"),
      ] as const,
      request: { body: jsonBody(wh.CreateWebhookEndpointBody) },
      responses: {
        201: jsonResponse(wh.CreatedWebhookEndpointSchema, "Created"),
        ...GATED_ERRORS,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = await guarded(() =>
        service().createEndpoint(principalOf(c).tenant, body, actorOf(c)),
      );
      return c.json({ endpoint: endpointBody(created.endpoint), secret: created.secret }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/endpoints/{id}",
      tags: TAGS,
      summary: "One webhook endpoint, with its last-24-hour delivery counts",
      security: sessionSecurity,
      "x-requires": "webhooks.read",
      middleware: [perm("webhooks.read")] as const,
      request: { params: wh.WebhookEndpointIdParams },
      responses: { 200: jsonResponse(wh.WebhookEndpointSchema, "Endpoint"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const endpoint = await guarded(() => service().getEndpoint(principalOf(c).tenant, id));
      return c.json(endpointBody(endpoint), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/webhooks/endpoints/{id}",
      tags: TAGS,
      summary: "Change an endpoint's URL, description, topics or enabled state",
      description:
        "A body carrying `url` additionally needs a fresh session — re-pointing an endpoint is as sensitive as adding one. Re-enabling clears `disabledReason` and the failure count; disabling cancels queued deliveries. 402 `plan_limit` (`feature: webhooks`) when the workspace's plan does not include webhooks and the body adds a topic, changes the URL to another one, or re-enables an endpoint disabled by a person (`manual`); removing topics and re-enabling an endpoint the system disabled stay allowed.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage",
      middleware: [perm("webhooks.manage")] as const,
      request: {
        params: wh.WebhookEndpointIdParams,
        body: jsonBody(wh.UpdateWebhookEndpointBody),
      },
      responses: { 200: jsonResponse(wh.WebhookEndpointSchema, "Updated"), ...GATED_ERRORS },
    }),
    async (c) => {
      const body = c.req.valid("json");
      if (body.url !== undefined) {
        // Conditional step-up: the kernel guard itself, run for this body only.
        await perm("webhooks.manage", { fresh: true })(c, async () => {});
      }
      const { id } = c.req.valid("param");
      const p = principalOf(c);
      const entitlements = deps.entitlements.of(p.workspace);
      // A transition gate: only the service, holding the endpoint row locked, knows whether this
      // body adds a topic, re-points it or re-enables a manual disable; it calls back before
      // writing anything.
      const endpoint = await guarded(() =>
        service().updateEndpoint(p.tenant, id, body, actorOf(c), {
          assertMayTurnOn: () => deps.entitlements.assertFeature(entitlements, "webhooks"),
        }),
      );
      return c.json(endpointBody(endpoint), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/webhooks/endpoints/{id}",
      tags: TAGS,
      summary: "Remove an endpoint (its deliveries go with it)",
      description: "Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage+fresh",
      middleware: [perm("webhooks.manage", { fresh: true })] as const,
      request: { params: wh.WebhookEndpointIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await guarded(() => service().deleteEndpoint(principalOf(c).tenant, id, actorOf(c)));
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/endpoints/{id}/rotate-secret",
      tags: TAGS,
      summary: "Rotate the signing secret (the new one is shown once)",
      description:
        "For `graceHours` deliveries carry two signatures (new and previous secret), so a receiver can switch over without dropping any. While a previous rotation is still in its overlap window, 409 `conflict` `rotation_in_progress` (unless `graceHours` is 0, which cuts over at once). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage+fresh",
      middleware: [perm("webhooks.manage", { fresh: true })] as const,
      request: {
        params: wh.WebhookEndpointIdParams,
        body: jsonBody(wh.RotateWebhookSecretBody),
      },
      responses: { 200: jsonResponse(wh.RotatedWebhookSecretSchema, "Rotated"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { graceHours } = c.req.valid("json");
      const rotated = await guarded(() =>
        service().rotateSecret(principalOf(c).tenant, id, graceHours, actorOf(c)),
      );
      return c.json({ endpoint: endpointBody(rotated.endpoint), secret: rotated.secret }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/endpoints/{id}/test",
      tags: TAGS,
      summary: "Send a `webhook.ping` to the endpoint",
      description:
        "Queues a manual `webhook.ping` delivery with `data: { endpointId }` (one attempt, no retries); watch it in the deliveries list. 409 `conflict` `endpoint_disabled` while the endpoint is disabled. Rate-limited to 10 a minute per endpoint.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage",
      middleware: [perm("webhooks.manage")] as const,
      request: { params: wh.WebhookEndpointIdParams },
      responses: { 202: jsonResponse(wh.WebhookDeliveryResultSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const p = principalOf(c);
      // Looked up first, keyed on workspace + endpoint (fix D7): another tenant's requests for
      // this id end in 404 before they can spend its budget.
      await guarded(() => service().getEndpoint(p.tenant, id));
      const hit = await deps.rateLimiter.hit(
        `webhooks.test:${p.workspace.id}:${id}`,
        WEBHOOK_TEST_LIMIT,
      );
      if (!hit.allowed) rateLimited(hit.retryAfterMs, "too many test sends to this endpoint");
      const delivery = await guarded(() => service().testEndpoint(p.tenant, id, actorOf(c)));
      return c.json({ delivery: deliveryBody(delivery) }, 202);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/deliveries",
      tags: TAGS,
      summary: "The delivery log (newest first)",
      description:
        "Filter by endpoint, status (`failed` is the dead-letter list) or topic. Kept 30 days.",
      security: sessionOrApiKeySecurity,
      "x-requires": "webhooks.read+apikey",
      middleware: [perm("webhooks.read", { apiKey: true })] as const,
      request: { query: wh.WebhookDeliveryListQuery },
      responses: { 200: jsonResponse(wh.WebhookDeliveryListSchema, "Deliveries"), ...ERRORS },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const page = await guarded(() => service().listDeliveries(principalOf(c).tenant, q));
      return c.json({ items: page.items.map(deliveryBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/deliveries/{id}",
      tags: TAGS,
      summary: "One delivery, with the payload sent and the last response",
      security: sessionOrApiKeySecurity,
      "x-requires": "webhooks.read+apikey",
      middleware: [perm("webhooks.read", { apiKey: true })] as const,
      request: { params: wh.WebhookDeliveryIdParams },
      responses: { 200: jsonResponse(wh.WebhookDeliveryDetailSchema, "Delivery"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const delivery = await guarded(() => service().getDelivery(principalOf(c).tenant, id));
      return c.json(deliveryDetailBody(delivery), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/deliveries/{id}/redeliver",
      tags: TAGS,
      summary: "Send a delivery again",
      description:
        "Queues a new manual delivery with the same topic, event and payload and a NEW `webhook-id` (receivers dedupe on it; this is a deliberate re-send). 409 `conflict` when the endpoint is disabled (`endpoint_disabled`), the delivery names an erased member (`subject_erased`), a person-level event is no longer allowed by tracking consent (`tracking_not_allowed`), or the topic is no longer offered or subscribed (`topic_unavailable`). Rate-limited to 60 an hour per workspace.",
      security: sessionSecurity,
      "x-requires": "webhooks.manage",
      middleware: [perm("webhooks.manage")] as const,
      request: { params: wh.WebhookDeliveryIdParams },
      responses: { 202: jsonResponse(wh.WebhookDeliveryResultSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const p = principalOf(c);
      const hit = await deps.rateLimiter.hit(
        `webhooks.redeliver:${p.workspace.id}`,
        WEBHOOK_REDELIVER_LIMIT,
      );
      if (!hit.allowed) rateLimited(hit.retryAfterMs, "too many redeliveries in this workspace");
      const delivery = await guarded(() => service().redeliver(p.tenant, id, actorOf(c)));
      return c.json({ delivery: deliveryBody(delivery) }, 202);
    },
  );
}
