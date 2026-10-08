import { randomUUID } from "node:crypto";
import { decryptBytes, type EnvelopeService, encryptBytes } from "@fundroom/crypto";
import {
  type Database,
  listActiveWorkspaceIds,
  listLiveWorkspaceIds,
  systemContext,
  type TenantContext,
  type Tx,
  workspaceIsActive,
} from "@fundroom/db";
import { EVENT_CATALOGUE, type EventTopic, parseWorkspaceSettings } from "@fundroom/domain";
import type {
  JobDefinition,
  JobQueuePort,
  JsonObject,
  JsonValue,
  OutboundFetch,
  OutboundHttpErrorCode,
} from "@fundroom/ports";
import { WebhookError } from "./errors.js";
import {
  nextRetryDelaySeconds,
  parseRetryAfter,
  projectWebhookData,
  redactUrl,
  requestHeaders,
  safeError,
  sanitizeExcerpt,
  storedPayload,
  urlDisplay,
  verdictOf,
} from "./policy.js";
import { WebhookDeliveryRepo } from "./repos/delivery-repo.js";
import { type EndpointPatch, WebhookEndpointRepo } from "./repos/endpoint-repo.js";
import { readWorkspaceSettings } from "./repos/workspace-repo.js";
import { mintWebhookSecret, signPayload } from "./signature.js";
import {
  bodyOf,
  type EndpointEncryption,
  MAX_WEBHOOK_ENDPOINTS,
  PERSON_LEVEL_WEBHOOK_TOPICS,
  type SealedRef,
  toDeliveryView,
  toEndpointView,
  WEBHOOK_AUTO_DISABLE_AFTER,
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_JOBS,
  WEBHOOK_KEY_PURPOSE,
  WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT,
  WEBHOOK_PING_TOPIC,
  WEBHOOK_RETENTION_DAYS,
  WEBHOOK_WORKER_CONCURRENCY,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStatus,
  type WebhookDeliveryView,
  type WebhookDisabledReason,
  type WebhookEndpointRecord,
  type WebhookEndpointView,
} from "./types.js";

/*
 * Outbound webhooks (E3.4, ADR-0052): endpoints, fan-out, delivery, retention.
 *
 * Secrets. The endpoint URL (receivers put tokens in paths and queries) and the signing secrets
 * are sealed (SHE1) under the workspace key of purpose `webhook-secret`, one key reference per
 * column (`encryption.{url,secret,secretPrev}`), and never leave this file in clear except as
 * the create/rotate response's `secret` and the POST itself. No log line, audit entry or stored
 * error carries them: errors go through `safeError`, audit meta carries ids, topics and flags.
 *
 * Fan-out runs inside the outbox subscriber's transaction and passes that `tx` to everything it
 * asks (enablement, consent, erasure) — a second pool connection while holding one deadlocks
 * the pool. Person-level topics (`PERSON_LEVEL_WEBHOOK_TOPICS`) pass the same gate analytics
 * applies to engagement tracking: the analytics module on, `analytics.mode = engagement`, the
 * member not erased, and `legal.allowsPurpose(member, "analytics_engagement")`. A refused event
 * creates no row at all (a log line counts it).
 *
 * Delivery: claim (short tx, SKIP LOCKED, 5-minute lease) → POST with no transaction open →
 * record (short tx). Lock order everywhere: [creation lock] → endpoint row → workspace row →
 * audit chain → outbox/queue (the global rule, E3.5 LX: every audit takes the workspace row FOR
 * NO KEY UPDATE, then the chain — `lockAuditChain`). The claim locks delivery rows only, so it
 * never waits on an endpoint writer.
 */

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** The guarded agent: `fetch` plus the static policy check used at save and send time. */
export interface WebhookHttp {
  readonly fetch: OutboundFetch;
  assess(
    url: string | URL,
  ):
    | { readonly ok: true; readonly url: URL; readonly exempt: boolean }
    | { readonly ok: false; readonly code: OutboundHttpErrorCode; readonly message: string };
}

/** What delivery needs of `@fundroom/audit` (structurally; `AuditService` satisfies it). */
export interface WebhookAudit {
  record(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly action: string;
      readonly resourceKind: string;
      readonly resourceId?: string | null | undefined;
      readonly actorKind?: "system" | undefined;
      readonly requestId?: string | null | undefined;
      readonly sessionId?: string | null | undefined;
      readonly apiKeyId?: string | undefined;
      readonly meta?: JsonObject | undefined;
    },
  ): Promise<unknown>;
}

/** The kernel's consent and erasure answers (`LegalServices` satisfies it). */
export interface WebhookLegal {
  allowsPurpose(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
    purpose: "analytics_engagement",
  ): Promise<boolean>;
  isErased(tx: Tx, ctx: TenantContext, membershipId: string): Promise<boolean>;
}

export interface WebhookServiceDeps {
  readonly db: Database;
  readonly keys: Pick<EnvelopeService, "currentKey" | "keyById">;
  readonly audit: WebhookAudit;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly http: WebhookHttp;
  /** Every declared webhook topic and its module (`registry.webhookTopics()`). */
  readonly topics: () => readonly { readonly topic: string; readonly moduleId: string }[];
  /** The modules enabled for the workspace, read through `tx` (fresh, not cached). */
  readonly enabledModules: (tx: Tx, ctx: TenantContext) => Promise<ReadonlySet<string>>;
  readonly legal: WebhookLegal;
  /**
   * Workspaces the due sweep walks. Default: every active workspace (E3.10 FR1: a held or
   * suspended one sends nothing). Retention walks every live workspace whatever its status.
   */
  readonly workspaceIds?: (() => Promise<readonly string[]>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

/** Who asked, for the audit row. `sessionId`/`apiKeyId` as the request authenticated. */
export interface WebhookActor {
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface WebhookTopicOption {
  readonly topic: string;
  readonly moduleId: string;
  readonly description: string;
  readonly personLevel: boolean;
}

export interface CreateEndpointInput {
  readonly url: string;
  readonly description?: string | null | undefined;
  readonly events: readonly string[];
}

export interface UpdateEndpointInput {
  readonly url?: string | undefined;
  readonly description?: string | null | undefined;
  readonly events?: readonly string[] | undefined;
  readonly enabled?: boolean | undefined;
}

export interface UpdateEndpointOptions {
  /**
   * Plan entitlements (A-3, ADR-0063): called, with the endpoint row locked and before anything
   * is written, when the update adds something — a topic the endpoint does not have, a URL other
   * than the stored one, or re-enabling an endpoint switched off by a person (`manual`). Throws to
   * refuse (the server passes its 402 `plan_limit` check). Removing topics, the same URL, a
   * description, disabling, and re-enabling an endpoint the system disabled (`failing` / `gone`)
   * never call it.
   */
  readonly assertMayTurnOn?: (() => void) | undefined;
}

export interface DeliveryListQuery {
  readonly endpointId?: string | undefined;
  readonly status?: WebhookDeliveryStatus | undefined;
  readonly topic?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface DeliverOutcome {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  readonly cancelled: number;
  /** The turn ended with rows possibly left (the job re-enqueues the workspace). */
  readonly more: boolean;
  /** The workspace is held or suspended (E3.10 FR1): nothing was claimed; its rows stay due. */
  readonly deferred: boolean;
}

/** The analytics module's id: person-level topics need it on (it owns the tracking gate). */
const ANALYTICS_MODULE = "analytics";
const CLAIM_BATCH = 20;
/**
 * One workspace's turn (fix D3): no new claim round starts after this long, so one backed-up
 * workspace cannot hold a worker; the job re-enqueues itself when rows are left. A round in
 * flight finishes (worst case ≈ batch / concurrency × the 10 s timeout, several minutes with
 * every job sharing the process semaphore), which keeps a job far below its 15-minute expiry.
 */
const WORKSPACE_TURN_MS = 30_000;
/**
 * The one topic whose delivery about an erased member is still sent: the erasure's own
 * `membership.revoked` (reason `erased`) is what tells a receiver to erase its copy.
 */
const ERASURE_NOTICE_TOPIC = "membership.revoked";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const REFUSALS = {
  subject_erased: "this delivery names a member whose data was erased; it cannot be re-sent",
  tracking_not_allowed:
    "this person-level event is no longer allowed by the member's tracking consent or the workspace's analytics mode",
  topic_unavailable:
    "this topic is no longer offered (its module is off) or the endpoint no longer subscribes to it",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Every membership id a payload names: uuid strings under any key mentioning a membership. */
export function membershipIdsIn(value: JsonValue | undefined, key = ""): string[] {
  const out = new Set<string>();
  const walk = (v: JsonValue | undefined, k: string): void => {
    if (typeof v === "string") {
      if (/membership/iu.test(k) && UUID_RE.test(v)) out.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, k);
    } else if (v !== null && typeof v === "object") {
      for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    }
  };
  walk(value, key);
  return [...out];
}

/** Opaque delivery-list cursor: base64url of the last row's id. */
export function encodeDeliveryCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeDeliveryCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
    throw new WebhookError("validation_failed", "invalid_cursor", "that cursor is not valid");
  }
  return id;
}

/** A tiny counting semaphore: the process-wide cap on concurrent POSTs. */
function semaphore(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A released slot is handed straight to the next waiter, so the count never overshoots.
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

interface Unsealed {
  readonly url: string | undefined;
  readonly secrets: readonly string[];
}

type Attempt =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly excerpt: string | null;
      readonly retryAfter: number | undefined;
      readonly durationMs: number;
    }
  | { readonly kind: "error"; readonly error: string; readonly durationMs: number | null };

export type WebhookService = ReturnType<typeof createWebhookService>;

export function createWebhookService(deps: WebhookServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const log: Log = deps.log ?? (() => {});
  const limit = semaphore(WEBHOOK_WORKER_CONCURRENCY);
  const workspaceIds = deps.workspaceIds ?? (() => listActiveWorkspaceIds(deps.db));

  // --- sealing -------------------------------------------------------------------------------

  async function seal(tx: Tx, ctx: TenantContext, text: string) {
    const dek = await deps.keys.currentKey(tx, ctx, WEBHOOK_KEY_PURPOSE);
    const enc = await encryptBytes(dek.key, Buffer.from(text, "utf8"));
    const ref: SealedRef = { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
    return { enc, ref };
  }

  async function open(
    tx: Tx,
    ctx: TenantContext,
    ref: SealedRef | undefined,
    enc: Uint8Array | null,
  ): Promise<string | undefined> {
    if (ref === undefined || enc === null) return undefined;
    const key = await deps.keys.keyById(tx, ctx, ref.keyId);
    if (key === undefined) return undefined;
    try {
      return Buffer.from(await decryptBytes(key.key, enc)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  async function unseal(tx: Tx, ctx: TenantContext, e: WebhookEndpointRecord): Promise<Unsealed> {
    const url = await open(tx, ctx, e.encryption.url, e.urlEnc);
    const secret = await open(tx, ctx, e.encryption.secret, e.secretEnc);
    const secrets: string[] = secret === undefined ? [] : [secret];
    if (
      e.secretPrevEnc !== null &&
      e.secretPrevExpiresAt !== null &&
      e.secretPrevExpiresAt.getTime() > now().getTime()
    ) {
      const prev = await open(tx, ctx, e.encryption.secretPrev, e.secretPrevEnc);
      if (prev !== undefined) secrets.push(prev);
    }
    return { url, secrets };
  }

  // --- validation ----------------------------------------------------------------------------

  /** Parses and checks a receiver URL: absolute, https (http only for an exempt host), guard OK. */
  function checkUrl(raw: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new WebhookError("validation_failed", "invalid_url", "that is not an absolute URL", {
        field: "url",
      });
    }
    parsed.hash = "";
    const verdict = deps.http.assess(parsed);
    if (!verdict.ok) {
      // The guard's code names a rule ("blocked_address"); its message may quote the host, so
      // only the code is passed on.
      throw new WebhookError(
        "validation_failed",
        "url_not_allowed",
        "that URL points somewhere this install does not deliver to",
        { field: "url", rule: verdict.code },
      );
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && verdict.exempt)) {
      throw new WebhookError("validation_failed", "https_required", "the URL must use https", {
        field: "url",
      });
    }
    return parsed;
  }

  function offered(enabled: ReadonlySet<string>): WebhookTopicOption[] {
    return deps
      .topics()
      .filter((t) => enabled.has(t.moduleId))
      .map((t) => ({
        topic: t.topic,
        moduleId: t.moduleId,
        description: EVENT_CATALOGUE[t.topic as EventTopic]?.description ?? t.topic,
        personLevel: PERSON_LEVEL_WEBHOOK_TOPICS.includes(t.topic),
      }));
  }

  async function checkEvents(
    tx: Tx,
    ctx: TenantContext,
    events: readonly string[],
  ): Promise<string[]> {
    const allowed = new Set(offered(await deps.enabledModules(tx, ctx)).map((t) => t.topic));
    const unique = [...new Set(events)];
    const unknown = unique.filter((t) => !allowed.has(t));
    if (unknown.length > 0 || unique.length === 0) {
      throw new WebhookError(
        "validation_failed",
        "unknown_topic",
        "subscribe only to topics from GET /webhooks/topics",
        { field: "events", topics: unknown },
      );
    }
    return unique;
  }

  function endpointDisabled(): never {
    throw new WebhookError(
      "conflict",
      "endpoint_disabled",
      "the endpoint is disabled; enable it first",
    );
  }

  function notFound(what = "webhook endpoint"): never {
    throw new WebhookError("not_found", "not_found", `no such ${what}`);
  }

  function audit(
    tx: Tx,
    ctx: TenantContext,
    actor: WebhookActor | "system",
    action: string,
    resourceKind: "webhook_endpoint" | "webhook_delivery",
    resourceId: string,
    meta: JsonObject,
  ) {
    return deps.audit.record(tx, ctx, {
      action,
      resourceKind,
      resourceId,
      meta,
      ...(actor === "system"
        ? { actorKind: "system" as const }
        : {
            requestId: actor.requestId ?? null,
            sessionId: actor.sessionId ?? null,
            ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
          }),
    });
  }

  /** Disables an endpoint (caller holds its row lock), cancels its queue, audits. */
  async function disable(
    tx: Tx,
    ctx: TenantContext,
    endpoint: WebhookEndpointRecord,
    reason: WebhookDisabledReason,
    actor: WebhookActor | "system",
  ): Promise<number> {
    await new WebhookEndpointRepo(ctx, tx).update(endpoint.id, {
      enabled: false,
      disabledReason: reason,
    });
    const cancelled = await new WebhookDeliveryRepo(ctx, tx).cancelQueuedForEndpoint(endpoint.id);
    if (actor === "system") {
      await audit(tx, ctx, "system", "webhook.endpoint_disabled", "webhook_endpoint", endpoint.id, {
        reason,
        cancelled,
        consecutiveFailures: endpoint.consecutiveFailures,
      });
      log("webhooks.endpoint_disabled", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        endpointId: endpoint.id,
        reason,
        cancelled,
      });
    }
    return cancelled;
  }

  // --- person-level gate ---------------------------------------------------------------------

  async function personLevelAllowed(
    tx: Tx,
    ctx: TenantContext,
    enabled: ReadonlySet<string>,
    membershipId: unknown,
  ): Promise<boolean> {
    if (typeof membershipId !== "string") return false;
    if (!enabled.has(ANALYTICS_MODULE)) return false;
    const settings = parseWorkspaceSettings(await readWorkspaceSettings(tx, ctx.workspaceId));
    if (settings.analytics.mode !== "engagement") return false;
    if (await deps.legal.isErased(tx, ctx, membershipId)) return false;
    return deps.legal.allowsPurpose(tx, ctx, membershipId, "analytics_engagement");
  }

  type SubjectVerdict = "ok" | "subject_erased" | "tracking_not_allowed" | "topic_unavailable";

  /**
   * Whether a stored delivery may (still) be sent: its topic still offered (declaring module
   * enabled) and subscribed by the endpoint, no member it names erased (except the erasure's own
   * revocation notice), and a person-level event still allowed by the tracking gate. Pings pass.
   */
  async function subjectCheck(
    tx: Tx,
    ctx: TenantContext,
    topic: string,
    payload: JsonObject,
    endpoint: WebhookEndpointRecord,
  ): Promise<SubjectVerdict> {
    if (topic === WEBHOOK_PING_TOPIC) return "ok";
    const moduleId = topicModule().get(topic);
    const enabled = await deps.enabledModules(tx, ctx);
    if (moduleId === undefined || !enabled.has(moduleId) || !endpoint.events.includes(topic)) {
      return "topic_unavailable";
    }
    const data = payload["data"];
    // The erasure's own notice (`membership.revoked`, reason `erased`) may still name its
    // subjects (fix R2): exactly the `membershipIds` of that notice, nothing else it carries.
    const notice =
      topic === ERASURE_NOTICE_TOPIC &&
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data["reason"] === "erased" &&
      Array.isArray(data["membershipIds"])
        ? new Set(data["membershipIds"].filter((x): x is string => typeof x === "string"))
        : new Set<string>();
    for (const m of membershipIdsIn(data)) {
      if (notice.has(m)) continue;
      if (await deps.legal.isErased(tx, ctx, m)) return "subject_erased";
    }
    if (
      PERSON_LEVEL_WEBHOOK_TOPICS.includes(topic) &&
      !(await personLevelAllowed(
        tx,
        ctx,
        enabled,
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? data["membershipId"]
          : undefined,
      ))
    ) {
      return "tracking_not_allowed";
    }
    return "ok";
  }

  // --- delivery ------------------------------------------------------------------------------

  async function post(d: WebhookDeliveryRecord, target: Unsealed): Promise<Attempt> {
    if (target.url === undefined || target.secrets.length === 0) {
      return {
        kind: "error",
        error: "the stored URL or secret could not be read",
        durationMs: null,
      };
    }
    const verdict = deps.http.assess(target.url);
    if (!verdict.ok) return { kind: "error", error: verdict.code, durationMs: null };
    if (verdict.url.protocol !== "https:" && !verdict.exempt) {
      return { kind: "error", error: "https_required", durationMs: null };
    }
    const body = JSON.stringify(bodyOf(d));
    const sentAt = now();
    const timestamp = Math.floor(sentAt.getTime() / 1000);
    const signature = await signPayload({ id: d.id, timestamp, body, secrets: target.secrets });
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    let res: Response;
    try {
      res = await deps.http.fetch(target.url, {
        method: "POST",
        headers: requestHeaders({ id: d.id, timestamp, signature }),
        body,
        redirect: "manual",
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        error: safeError(code === undefined ? `network: ${message}` : code, target.url),
        durationMs: elapsed(),
      };
    }
    let text: string | null = null;
    try {
      text = await res.text();
    } catch {
      // Over the cap or cut off: the status is still the answer.
    }
    return {
      kind: "response",
      status: res.status,
      excerpt: sanitizeExcerpt(text === null ? null : redactUrl(text, target.url)),
      retryAfter: parseRetryAfter(res.headers.get("retry-after"), sentAt),
      durationMs: elapsed(),
    };
  }

  type Result = "succeeded" | "retried" | "failed" | "cancelled" | "lost";

  /** One claimed delivery: prepare (short tx) → POST (no tx) → record (short tx). */
  async function attempt(ctx: TenantContext, d: WebhookDeliveryRecord): Promise<Result> {
    if (d.claimedAt === null) return "lost";
    // Re-stamped just before the POST (fix R4): the row may have waited minutes for a slot of
    // the process semaphore, and a lease that ran out meanwhile may have been claimed by another
    // worker. The re-stamp succeeds only while the claim is still ours; lost → nothing is sent.
    const claimedAt = now();
    const prepared = await deps.db.withTenant(ctx, async (tx) => {
      const ours = await new WebhookDeliveryRepo(ctx, tx).restampClaim(
        d.id,
        d.claimedAt as Date,
        claimedAt,
      );
      if (!ours) return undefined;
      const endpoint = await new WebhookEndpointRepo(ctx, tx).byId(d.endpointId);
      if (endpoint === undefined) return undefined;
      if (!endpoint.enabled) return { cancel: "endpoint_disabled" as const };
      // Re-checked at every attempt (fixes D1/D8): consent withdrawn, member erased, module
      // switched off or topic unsubscribed since the row was queued → it is not sent.
      const verdict = await subjectCheck(tx, ctx, d.topic, d.payload, endpoint);
      if (verdict !== "ok") return { cancel: verdict };
      // The ciphertext identifies the URL this attempt goes to (fix D5): a re-seal on PATCH
      // produces new bytes, so a changed column means the endpoint was re-pointed meanwhile.
      return { target: await unseal(tx, ctx, endpoint), urlEnc: Buffer.from(endpoint.urlEnc) };
    });
    if (prepared === undefined) return "lost";
    if ("cancel" in prepared) {
      const reason = prepared.cancel;
      const done = await deps.db.withTenant(ctx, (tx) =>
        new WebhookDeliveryRepo(ctx, tx).finishClaim(d.id, claimedAt, {
          status: "cancelled",
          nextAttemptAt: null,
          ...(reason === "endpoint_disabled"
            ? {}
            : { lastError: reason === "tracking_not_allowed" ? "consent_withdrawn" : reason }),
        }),
      );
      return done === undefined ? "lost" : "cancelled";
    }
    const outcome = await post(d, prepared.target);
    return deps.db.withTenant(ctx, async (tx) => {
      // Lock order: the endpoint row first, then the delivery row.
      const endpoints = new WebhookEndpointRepo(ctx, tx);
      const endpoint = await endpoints.byIdForUpdate(d.endpointId);
      if (endpoint === undefined) return "lost";
      const deliveries = new WebhookDeliveryRepo(ctx, tx);
      const at = now();
      const response =
        outcome.kind === "response"
          ? {
              lastStatusCode: outcome.status,
              lastResponseExcerpt: outcome.excerpt,
              lastDurationMs: outcome.durationMs,
            }
          : { lastStatusCode: null, lastResponseExcerpt: null, lastDurationMs: outcome.durationMs };
      const verdict = outcome.kind === "response" ? verdictOf(outcome.status) : "failed";
      if (!Buffer.from(endpoint.urlEnc).equals(prepared.urlEnc)) {
        // Re-pointed while this was in flight (fix D5): the answer came from the OLD URL, so it
        // says nothing about the endpoint — no success stamp, no 410 disable, no failure count.
        // The delivery itself succeeded, or is retried (against the new URL) on its schedule.
        if (verdict === "succeeded") {
          const done = await deliveries.finishClaim(d.id, claimedAt, {
            ...response,
            status: "succeeded",
            lastError: null,
            nextAttemptAt: null,
            deliveredAt: at,
          });
          return done === undefined ? "lost" : "succeeded";
        }
        const retry =
          d.topic === WEBHOOK_PING_TOPIC
            ? undefined
            : nextRetryDelaySeconds(
                d.attempts,
                outcome.kind === "response" ? outcome.retryAfter : undefined,
              );
        const done = await deliveries.finishClaim(d.id, claimedAt, {
          ...response,
          status: retry === undefined ? "failed" : "pending",
          lastError: outcome.kind === "response" ? `HTTP ${outcome.status}` : outcome.error,
          nextAttemptAt: retry === undefined ? null : new Date(at.getTime() + retry * 1000),
        });
        if (done === undefined) return "lost";
        return retry === undefined ? "failed" : "retried";
      }
      if (verdict === "succeeded") {
        const done = await deliveries.finishClaim(d.id, claimedAt, {
          ...response,
          status: "succeeded",
          lastError: null,
          nextAttemptAt: null,
          deliveredAt: at,
        });
        if (done === undefined) return "lost";
        await endpoints.update(endpoint.id, { consecutiveFailures: 0, lastSuccessAt: at });
        return "succeeded";
      }
      const error = outcome.kind === "response" ? `HTTP ${outcome.status}` : outcome.error;
      if (verdict === "gone") {
        const done = await deliveries.finishClaim(d.id, claimedAt, {
          ...response,
          status: "failed",
          lastError: error,
          nextAttemptAt: null,
        });
        if (done === undefined) return "lost";
        await endpoints.update(endpoint.id, { lastFailureAt: at });
        if (endpoint.enabled) await disable(tx, ctx, endpoint, "gone", "system");
        return "failed";
      }
      // An endpoint switched off while this was in flight: no retry.
      if (!endpoint.enabled) {
        const done = await deliveries.finishClaim(d.id, claimedAt, {
          ...response,
          status: "cancelled",
          lastError: error,
          nextAttemptAt: null,
        });
        return done === undefined ? "lost" : "cancelled";
      }
      // A test ping is one attempt: the admin is watching the screen, not waiting two days.
      const delay =
        d.topic === WEBHOOK_PING_TOPIC
          ? undefined
          : nextRetryDelaySeconds(
              d.attempts,
              outcome.kind === "response" ? outcome.retryAfter : undefined,
            );
      if (delay !== undefined) {
        const done = await deliveries.finishClaim(d.id, claimedAt, {
          ...response,
          status: "pending",
          lastError: error,
          nextAttemptAt: new Date(at.getTime() + delay * 1000),
        });
        if (done === undefined) return "lost";
        await endpoints.update(endpoint.id, { lastFailureAt: at });
        return "retried";
      }
      const done = await deliveries.finishClaim(d.id, claimedAt, {
        ...response,
        status: "failed",
        lastError: error,
        nextAttemptAt: null,
      });
      if (done === undefined) return "lost";
      if (d.manual) {
        await endpoints.update(endpoint.id, { lastFailureAt: at });
        return "failed";
      }
      // An exhausted fan-out delivery counts toward auto-disable (manual sends never do).
      const failures = endpoint.consecutiveFailures + 1;
      await endpoints.update(endpoint.id, { consecutiveFailures: failures, lastFailureAt: at });
      if (failures >= WEBHOOK_AUTO_DISABLE_AFTER && endpoint.enabled) {
        await disable(tx, ctx, { ...endpoint, consecutiveFailures: failures }, "failing", "system");
      }
      return "failed";
    });
  }

  async function deliverWorkspace(
    workspaceId: string,
    signal?: AbortSignal | undefined,
    options: {
      readonly turnMs?: number | undefined;
      /**
       * Test seam: runs after each claim, before its attempts (where a real worker may wait for
       * a semaphore slot). Lets a test re-claim a row underneath, as a second worker would.
       */
      readonly afterClaim?:
        | ((claimed: readonly WebhookDeliveryRecord[]) => Promise<void>)
        | undefined;
    } = {},
  ): Promise<DeliverOutcome> {
    const ctx = systemContext(workspaceId);
    const out = {
      claimed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      more: false,
      deferred: false,
    };
    const until = Date.now() + (options.turnMs ?? WORKSPACE_TURN_MS);
    for (;;) {
      if (signal?.aborted) break;
      if (Date.now() >= until) {
        // Out of turn with work possibly left: the caller re-enqueues.
        out.more = true;
        break;
      }
      const at = now();
      const claimed = await deps.db.withTenant(ctx, async (tx) => {
        // E3.10 FR1: a held or suspended workspace sends nothing. Its rows stay due (deferred,
        // not dropped) and the due sweep, which walks active workspaces only, picks them up
        // once it is active again. Checked per claim round, so a suspension mid-turn stops it.
        if (!(await workspaceIsActive(tx, workspaceId))) {
          out.deferred = true;
          return [];
        }
        return new WebhookDeliveryRepo(ctx, tx).claimDue(
          at,
          new Date(at.getTime() - WEBHOOK_CLAIM_LEASE_MS),
          CLAIM_BATCH,
          WEBHOOK_MAX_IN_FLIGHT_PER_ENDPOINT,
        );
      });
      // Empty: nothing due, or every endpoint with due rows is at its in-flight cap (the cap is
      // applied before the LIMIT, so one busy endpoint never hides another's rows from a claim).
      if (claimed.length === 0) break;
      out.claimed += claimed.length;
      if (options.afterClaim !== undefined) await options.afterClaim(claimed);
      const results = await Promise.all(
        claimed.map((d) =>
          limit(() =>
            attempt(ctx, d).catch((error: unknown) => {
              // A database error while recording: the lease runs out and the row is claimed again.
              log("webhooks.attempt_failed", {
                level: "warn",
                workspaceId,
                deliveryId: d.id,
                error: safeError(error instanceof Error ? error.message : String(error)),
              });
              return "lost" as const;
            }),
          ),
        ),
      );
      for (const r of results) {
        if (r === "succeeded") out.succeeded += 1;
        else if (r === "retried") out.retried += 1;
        else if (r === "failed") out.failed += 1;
        else if (r === "cancelled") out.cancelled += 1;
      }
      // No early exit on a short batch: the per-endpoint cap can shorten one while more rows
      // are due, and the next claim (after these finished) is the only way to know.
    }
    if (out.claimed > 0) log("webhooks.delivered", { workspaceId, ...out });
    return out;
  }

  /** Enqueues one `webhooks.deliver` per workspace (deduped per workspace while queued). */
  async function enqueueWorkspace(workspaceId: string): Promise<void> {
    await deps.queue.send(
      WEBHOOK_JOBS.deliver,
      { workspaceId },
      { idempotencyKey: `webhooks.deliver:ws:${workspaceId}` },
    );
  }

  /**
   * The per-minute sweep (retries, stale leases, missed wake-ups). It delivers nothing itself
   * (fix D3): a cheap probe per workspace, then one queued `webhooks.deliver` for each that has
   * due rows, so workspaces are served in parallel by the deliver queue's workers, each for a
   * bounded turn, instead of one after another inside a single cron job.
   */
  async function enqueueDue(signal?: AbortSignal | undefined): Promise<number> {
    let queued = 0;
    for (const workspaceId of await workspaceIds()) {
      if (signal?.aborted) break;
      const ctx = systemContext(workspaceId);
      const at = now();
      const due = await deps.db.withTenant(ctx, (tx) =>
        new WebhookDeliveryRepo(ctx, tx).hasDue(
          at,
          new Date(at.getTime() - WEBHOOK_CLAIM_LEASE_MS),
        ),
      );
      if (!due) continue;
      await enqueueWorkspace(workspaceId);
      queued += 1;
    }
    return queued;
  }

  /** Deletes finished deliveries older than 30 days; nothing while under legal hold. */
  async function applyRetention(
    workspaceId: string,
    at: Date = now(),
  ): Promise<{ readonly skipped: "legal_hold" | null; readonly deleted: number }> {
    const ctx = systemContext(workspaceId);
    const settings = parseWorkspaceSettings(
      await deps.db.withTenant(ctx, (tx) => readWorkspaceSettings(tx, workspaceId)),
    );
    if (settings.legal.legalHold) return { skipped: "legal_hold", deleted: 0 };
    const cutoff = new Date(at.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    for (;;) {
      const n = await deps.db.withTenant(ctx, (tx) =>
        new WebhookDeliveryRepo(ctx, tx).deleteCreatedBefore(cutoff, 1000),
      );
      deleted += n;
      if (n < 1000) break;
    }
    return { skipped: null, deleted };
  }

  // --- the service ---------------------------------------------------------------------------

  /**
   * Wakes the deliver job after a manual row committed. Deliberately after the commit and not
   * `sendInTransaction`: pg-boss resolves the queue through its own pool query on a cold cache,
   * which inside a request's transaction is a second connection — a pool of one deadlocks. The row
   * is durable either way; a lost wake-up only waits for the per-minute sweep.
   */
  async function wake(workspaceId: string): Promise<void> {
    try {
      // Keyed per workspace (fix R3): the deliver queue's `short` policy dedupes queued jobs by
      // key, so a keyless wake would share ONE slot across every workspace.
      await enqueueWorkspace(workspaceId);
    } catch (error) {
      log("webhooks.wake_failed", {
        level: "warn",
        workspaceId,
        error: safeError(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  const topicModule = () => new Map(deps.topics().map((t) => [t.topic, t.moduleId]));

  return {
    async listTopics(ctx: TenantContext): Promise<WebhookTopicOption[]> {
      return deps.db.withTenant(ctx, async (tx) => offered(await deps.enabledModules(tx, ctx)));
    },

    async listEndpoints(ctx: TenantContext): Promise<WebhookEndpointView[]> {
      const rows = await deps.db.withTenant(ctx, (tx) => new WebhookEndpointRepo(ctx, tx).list());
      const at = now();
      return rows.map((e) => toEndpointView(e, at));
    },

    async getEndpoint(ctx: TenantContext, id: string): Promise<WebhookEndpointView> {
      return deps.db.withTenant(ctx, async (tx) => {
        const e = await new WebhookEndpointRepo(ctx, tx).byId(id);
        if (e === undefined) notFound();
        const at = now();
        const stats = await new WebhookDeliveryRepo(ctx, tx).countsByStatusSince(
          id,
          new Date(at.getTime() - DAY_MS),
        );
        return toEndpointView(e, at, stats);
      });
    },

    async createEndpoint(
      ctx: TenantContext,
      input: CreateEndpointInput,
      actor: WebhookActor,
    ): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
      const url = checkUrl(input.url);
      const secret = mintWebhookSecret();
      const endpoint = await deps.db.withTenant(ctx, async (tx) => {
        const repo = new WebhookEndpointRepo(ctx, tx);
        await repo.lockCreation();
        if ((await repo.count()) >= MAX_WEBHOOK_ENDPOINTS) {
          throw new WebhookError(
            "conflict",
            "too_many_endpoints",
            `a workspace can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`,
          );
        }
        const events = await checkEvents(tx, ctx, input.events);
        const sealedUrl = await seal(tx, ctx, url.href);
        const sealedSecret = await seal(tx, ctx, secret);
        const row = await repo.insert({
          description: input.description ?? null,
          urlEnc: sealedUrl.enc,
          ...urlDisplay(url),
          secretEnc: sealedSecret.enc,
          encryption: { url: sealedUrl.ref, secret: sealedSecret.ref },
          events,
          createdByMembershipId: ctx.membershipId ?? null,
        });
        await audit(tx, ctx, actor, "webhook.endpoint_created", "webhook_endpoint", row.id, {
          events,
          urlHost: row.urlHost,
        });
        return row;
      });
      return { endpoint: toEndpointView(endpoint, now()), secret };
    },

    async updateEndpoint(
      ctx: TenantContext,
      id: string,
      input: UpdateEndpointInput,
      actor: WebhookActor,
      options: UpdateEndpointOptions = {},
    ): Promise<WebhookEndpointView> {
      const url = input.url === undefined ? undefined : checkUrl(input.url);
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const repo = new WebhookEndpointRepo(ctx, tx);
        const current = await repo.byIdForUpdate(id);
        if (current === undefined) notFound();
        const patch: { -readonly [K in keyof EndpointPatch]: EndpointPatch[K] } = {};
        const fields: string[] = [];
        if (input.description !== undefined) {
          patch.description = input.description;
          fields.push("description");
        }
        if (input.events !== undefined) {
          patch.events = await checkEvents(tx, ctx, input.events);
          fields.push("events");
        }
        if (url !== undefined) {
          const sealed = await seal(tx, ctx, url.href);
          patch.urlEnc = sealed.enc;
          patch.encryption = { ...current.encryption, url: sealed.ref };
          Object.assign(patch, urlDisplay(url));
          // A new receiver is a fresh start: the old one's failures say nothing about it.
          patch.consecutiveFailures = 0;
          fields.push("url");
        }
        // A-3 (decision 3): only adding something is gated — a topic the endpoint does not have,
        // another receiver, or switching back on an endpoint a person switched off. Removing
        // topics, resending the same URL and re-enabling one the system disabled (`failing`,
        // `gone`: the receiver recovered) are maintenance.
        if (options.assertMayTurnOn !== undefined) {
          const have = new Set(current.events);
          const turnsOn =
            patch.events?.some((t) => !have.has(t)) === true ||
            (input.enabled === true && !current.enabled && current.disabledReason === "manual") ||
            // A stored URL that cannot be decrypted reads as "another URL": fails closed (RR2 L1).
            (url !== undefined &&
              (await open(tx, ctx, current.encryption.url, current.urlEnc)) !== url.href);
          if (turnsOn) options.assertMayTurnOn();
        }
        let cancelled = 0;
        if (input.enabled !== undefined && input.enabled !== current.enabled) {
          fields.push("enabled");
          if (input.enabled) {
            patch.enabled = true;
            patch.disabledReason = null;
            patch.consecutiveFailures = 0;
          } else {
            cancelled = await new WebhookDeliveryRepo(ctx, tx).cancelQueuedForEndpoint(id);
            patch.enabled = false;
            patch.disabledReason = "manual";
          }
        }
        const updated = (await repo.update(id, patch)) ?? current;
        await audit(tx, ctx, actor, "webhook.endpoint_updated", "webhook_endpoint", id, {
          // Which fields changed, never the URL itself.
          fields,
          urlChanged: url !== undefined,
          ...(url === undefined ? {} : { urlHost: updated.urlHost }),
          enabled: updated.enabled,
          ...(cancelled > 0 ? { cancelled } : {}),
        });
        return updated;
      });
      return toEndpointView(row, now());
    },

    async deleteEndpoint(ctx: TenantContext, id: string, actor: WebhookActor): Promise<void> {
      await deps.db.withTenant(ctx, async (tx) => {
        const repo = new WebhookEndpointRepo(ctx, tx);
        const current = await repo.byIdForUpdate(id);
        if (current === undefined) notFound();
        await repo.delete(id);
        await audit(tx, ctx, actor, "webhook.endpoint_deleted", "webhook_endpoint", id, {
          events: [...current.events],
          urlHost: current.urlHost,
        });
      });
    },

    async rotateSecret(
      ctx: TenantContext,
      id: string,
      graceHours: number,
      actor: WebhookActor,
    ): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
      const secret = mintWebhookSecret();
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const repo = new WebhookEndpointRepo(ctx, tx);
        const current = await repo.byIdForUpdate(id);
        if (current === undefined) notFound();
        const keepPrev = graceHours > 0;
        // A second overlapping rotation would drop the first previous secret before its grace
        // ends (fix D6). `graceHours: 0` is the explicit "cut over now" and stays allowed.
        if (
          keepPrev &&
          current.secretPrevExpiresAt !== null &&
          current.secretPrevExpiresAt.getTime() > now().getTime()
        ) {
          throw new WebhookError(
            "conflict",
            "rotation_in_progress",
            "a rotation is still in its overlap window; wait for it to end or rotate with graceHours 0",
          );
        }
        const sealed = await seal(tx, ctx, secret);
        const encryption: EndpointEncryption = {
          url: current.encryption.url,
          secret: sealed.ref,
          ...(keepPrev ? { secretPrev: current.encryption.secret } : {}),
        };
        const updated =
          (await repo.update(id, {
            secretEnc: sealed.enc,
            secretPrevEnc: keepPrev ? current.secretEnc : null,
            secretPrevExpiresAt: keepPrev ? new Date(now().getTime() + graceHours * HOUR_MS) : null,
            encryption,
          })) ?? current;
        await audit(tx, ctx, actor, "webhook.secret_rotated", "webhook_endpoint", id, {
          graceHours,
        });
        return updated;
      });
      return { endpoint: toEndpointView(row, now()), secret };
    },

    /** Queues a `webhook.ping` (the route rate-limits). The endpoint must be enabled. */
    async testEndpoint(
      ctx: TenantContext,
      id: string,
      actor: WebhookActor,
    ): Promise<WebhookDeliveryView> {
      const at = now();
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const endpoint = await new WebhookEndpointRepo(ctx, tx).byIdForUpdate(id);
        if (endpoint === undefined) notFound();
        if (!endpoint.enabled) endpointDisabled();
        const delivery = await new WebhookDeliveryRepo(ctx, tx).insertManual({
          endpointId: id,
          topic: WEBHOOK_PING_TOPIC,
          eventId: `ping:${randomUUID()}`,
          payload: storedPayload({
            topic: WEBHOOK_PING_TOPIC,
            createdAt: at,
            workspaceId: ctx.workspaceId,
            data: { endpointId: id },
          }),
          nextAttemptAt: at,
        });
        await audit(tx, ctx, actor, "webhook.tested", "webhook_endpoint", id, {
          deliveryId: delivery.id,
        });
        return delivery;
      });
      await wake(ctx.workspaceId);
      return toDeliveryView(row);
    },

    /** A new manual delivery of the same topic, event and payload under a NEW id. */
    async redeliver(
      ctx: TenantContext,
      deliveryId: string,
      actor: WebhookActor,
    ): Promise<WebhookDeliveryView> {
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const source = await new WebhookDeliveryRepo(ctx, tx).byId(deliveryId);
        if (source === undefined) notFound("webhook delivery");
        // Lock order: the endpoint row first (it also orders us against a concurrent delete).
        const endpoint = await new WebhookEndpointRepo(ctx, tx).byIdForUpdate(source.endpointId);
        if (endpoint === undefined) notFound("webhook delivery");
        if (!endpoint.enabled) endpointDisabled();
        // The same gates a queued attempt re-checks (fixes D1/D8): never re-send data about an
        // erased member, a person-level event whose consent is gone, or a topic no longer offered.
        const verdict = await subjectCheck(tx, ctx, source.topic, source.payload, endpoint);
        if (verdict !== "ok") {
          throw new WebhookError("conflict", verdict, REFUSALS[verdict]);
        }
        const delivery = await new WebhookDeliveryRepo(ctx, tx).insertManual({
          endpointId: source.endpointId,
          topic: source.topic,
          eventId: source.eventId,
          payload: source.payload,
          nextAttemptAt: now(),
        });
        await audit(tx, ctx, actor, "webhook.redelivered", "webhook_delivery", delivery.id, {
          sourceDeliveryId: source.id,
          endpointId: source.endpointId,
          topic: source.topic,
        });
        return delivery;
      });
      await wake(ctx.workspaceId);
      return toDeliveryView(row);
    },

    async listDeliveries(
      ctx: TenantContext,
      query: DeliveryListQuery,
    ): Promise<{ items: WebhookDeliveryView[]; nextCursor: string | null }> {
      const cursor = query.cursor === undefined ? undefined : decodeDeliveryCursor(query.cursor);
      const rows = await deps.db.withTenant(ctx, (tx) =>
        new WebhookDeliveryRepo(ctx, tx).list({
          endpointId: query.endpointId,
          status: query.status,
          topic: query.topic,
          cursor: cursor === undefined ? undefined : { id: cursor },
          limit: query.limit + 1,
        }),
      );
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((d) => toDeliveryView(d)),
        nextCursor:
          rows.length > query.limit && last !== undefined ? encodeDeliveryCursor(last.id) : null,
      };
    },

    async getDelivery(ctx: TenantContext, id: string): Promise<WebhookDeliveryView> {
      const row = await deps.db.withTenant(ctx, (tx) => new WebhookDeliveryRepo(ctx, tx).byId(id));
      if (row === undefined) notFound("webhook delivery");
      return toDeliveryView(row, true);
    },

    /**
     * The `webhooks.fanout` outbox subscriber, registered for every declared webhook topic.
     * Runs in the dispatcher's `system` transaction; everything it asks goes through `tx`.
     */
    async fanOut(
      event: {
        readonly outboxId: number;
        readonly topic: string;
        readonly payload: unknown;
        readonly schemaVersion: number;
        readonly createdAt: Date;
      },
      sc: { readonly tx: Tx; readonly ctx: { readonly actorKind: string } },
    ): Promise<number> {
      if (sc.ctx.actorKind === "host") return 0;
      const ctx = sc.ctx as TenantContext;
      const { tx } = sc;
      const moduleId = topicModule().get(event.topic);
      if (moduleId === undefined) return 0;
      const endpoints = await new WebhookEndpointRepo(ctx, tx).listSubscribed(event.topic);
      if (endpoints.length === 0) return 0;
      const enabled = await deps.enabledModules(tx, ctx);
      if (!enabled.has(moduleId)) {
        log("webhooks.fanout_skipped", {
          workspaceId: ctx.workspaceId,
          topic: event.topic,
          reason: "module_disabled",
          endpoints: endpoints.length,
        });
        return 0;
      }
      const data = projectWebhookData((event.payload ?? {}) as JsonObject);
      if (
        PERSON_LEVEL_WEBHOOK_TOPICS.includes(event.topic) &&
        !(await personLevelAllowed(tx, ctx, enabled, data["membershipId"]))
      ) {
        log("webhooks.fanout_skipped", {
          workspaceId: ctx.workspaceId,
          topic: event.topic,
          reason: "tracking_not_allowed",
          endpoints: endpoints.length,
        });
        return 0;
      }
      const at = now();
      const payload = storedPayload({
        topic: event.topic,
        createdAt: event.createdAt,
        workspaceId: ctx.workspaceId,
        data,
        schemaVersion: event.schemaVersion,
      });
      const inserted = await new WebhookDeliveryRepo(ctx, tx).insertFanout(
        endpoints.map((e) => ({
          endpointId: e.id,
          topic: event.topic,
          eventId: String(event.outboxId),
          payload,
          nextAttemptAt: at,
          manual: false,
        })),
      );
      if (inserted.length > 0) {
        await deps.queue.sendInTransaction(
          tx,
          WEBHOOK_JOBS.deliver,
          { workspaceId: ctx.workspaceId },
          { idempotencyKey: `webhooks.deliver:${event.outboxId}` },
        );
      }
      return inserted.length;
    },

    deliverWorkspace,

    enqueueDue,

    applyRetention,

    /** The three jobs; the container spreads them into its list. */
    jobs(): JobDefinition<JsonObject>[] {
      return [
        {
          name: WEBHOOK_JOBS.deliver,
          queue: {
            policy: "short",
            retryLimit: 2,
            retryDelaySeconds: 30,
            expireInSeconds: 15 * 60,
          },
          // Several workspaces at once (fix D3); POSTs stay capped by the process semaphore.
          work: { concurrency: WEBHOOK_WORKER_CONCURRENCY },
          handler: async (job) => {
            const workspaceId = (job.data as { workspaceId?: unknown }).workspaceId;
            if (typeof workspaceId !== "string") return;
            const r = await deliverWorkspace(workspaceId, job.signal);
            if (r.more && !job.signal.aborted) await enqueueWorkspace(workspaceId);
          },
        },
        {
          name: WEBHOOK_JOBS.deliverDue,
          cron: "* * * * *",
          queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 5 * 60 },
          handler: async (job) => {
            const workspaceId = (job.data as { workspaceId?: unknown }).workspaceId;
            if (typeof workspaceId === "string") await enqueueWorkspace(workspaceId);
            else await enqueueDue(job.signal);
          },
        },
        {
          name: WEBHOOK_JOBS.retention,
          cron: "23 4 * * *",
          queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
          handler: async (job) => {
            const only = (job.data as { workspaceId?: unknown }).workspaceId;
            const ids = typeof only === "string" ? [only] : await listLiveWorkspaceIds(deps.db);
            for (const workspaceId of ids) {
              if (job.signal.aborted) return;
              const r = await applyRetention(workspaceId);
              if (r.skipped !== null || r.deleted > 0) {
                log("webhooks.retention", { workspaceId, ...r });
              }
            }
          },
        },
      ];
    },
  };
}
