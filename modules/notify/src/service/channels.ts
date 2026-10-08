import { ApiError } from "@fundroom/contracts";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import { pgErrorCode, type TenantContext, type Tx, workspaceIsActive } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { IntegrationNotConnected, ModuleServices } from "@fundroom/module-kit";
import type {
  ChatChannelRef,
  ChatMessage,
  ChatPostFailure,
  ChatPostResult,
  IntegrationResult,
} from "@fundroom/ports";
import {
  CHANNEL_CLAIM_STALE_MS,
  CHANNEL_DISABLE_AFTER,
  CHANNEL_MAX_ATTEMPTS,
  CHAT_KEY_PURPOSE,
  JOB_CHANNELS,
  MAX_CHANNELS,
} from "../names.js";
import { ChannelDeliveryRepo, ChannelRepo } from "../repos/notify-repo.js";
import {
  type ChannelEventType,
  integrationHealthSentence,
  isChannelEventType,
  VERB,
} from "../rules.js";
import type {
  Channel,
  ChannelDelivery,
  ChannelDisabledReason,
  ChannelKind,
} from "../schema/notify.js";
import { loadWorkspace, type Workspace } from "./notify.js";

/*
 * Workspace chat channels (E2.6, design/03 C2 "full"): an admin pastes a Slack incoming-webhook
 * URL, picks which workspace-level events it announces, and the fan-out posts there through
 * `services.chat` — never a general `fetch`.
 *
 * The URL is a bearer credential, so it is handled like metrics' sheet credential:
 *  - **validated before it is encrypted** (`chat.validateUrl`) — storing a typo would only fail
 *    at the first hot lead, in a job nobody is watching;
 *  - envelope-encrypted under the workspace data key purpose `notify-chat`, with the last four
 *    characters kept as a hint so an admin can tell two channels apart;
 *  - never returned by a route, never logged, never put in an audit row or an error detail —
 *    a failed validation says *why* in fixed words, not by quoting what was pasted.
 *
 * Delivery is a queue (`notify.channel_delivery`): the event handler writes one row per
 * subscribed channel inside the outbox transaction (deduped on the fact it announces) and
 * enqueues `notify.channels`, which claims rows with SKIP LOCKED and posts outside any
 * transaction. `rate_limited` / `unavailable` retry with backoff; `not_found` / `rejected` /
 * `invalid_url` are permanent for that post and count toward the channel disabling itself after
 * `CHANNEL_DISABLE_AFTER` in a row — a revoked webhook should stop being tried, and say so.
 *
 * E3.6 adds a second kind, `slack_app`: a channel of the workspace's Slack app connection (the
 * kernel's integrations hub), addressed by Slack's channel id and posted through
 * `services.integrations.slackPost` — outside any transaction, like a webhook post. It holds no
 * credential here at all (the bot token is the kernel's). The message is the same fixed text as a
 * webhook's, rendered as Slack mrkdwn with the link inline. The kernel's `not_connected`,
 * `unauthorized`, `forbidden` and `not_found` (channel gone, or the bot removed from it) are
 * permanent for the post and count toward the auto-disable; `rate_limited` and remote trouble
 * retry.
 */

interface Encryption {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

export interface WebhookChannelInput {
  readonly kind?: "slack" | undefined;
  readonly name: string;
  readonly url: string;
  readonly eventTypes: readonly ChannelEventType[];
  readonly enabled?: boolean | undefined;
}

/** E3.6: a channel of the Slack app; the name defaults to `#<slack channel name>`. */
export interface SlackAppChannelInput {
  readonly kind: "slack_app";
  readonly name?: string | undefined;
  readonly slackChannelId: string;
  readonly eventTypes: readonly ChannelEventType[];
  readonly enabled?: boolean | undefined;
}

export type ChannelInput = WebhookChannelInput | SlackAppChannelInput;

export interface ChannelPatch {
  readonly name?: string | undefined;
  /** `slack` channels only. */
  readonly url?: string | undefined;
  /** `slack_app` channels only (E3.6): re-point at another Slack channel. */
  readonly slackChannelId?: string | undefined;
  readonly eventTypes?: readonly ChannelEventType[] | undefined;
  readonly enabled?: boolean | undefined;
}

/** The create body as the route receives it: one object for both kinds. */
export interface ChannelCreateBody {
  readonly kind?: ChannelKind | undefined;
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly slackChannelId?: string | undefined;
  readonly eventTypes: readonly ChannelEventType[];
  readonly enabled?: boolean | undefined;
}

function missing(field: string, why: string): ApiError {
  return new ApiError("validation_failed", why, { field });
}

/** Splits the create body by kind, refusing a field of the other kind (pure). */
export function channelInputOf(body: ChannelCreateBody): ChannelInput {
  const common = {
    eventTypes: body.eventTypes,
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
  };
  if (body.kind === "slack_app") {
    if (body.url !== undefined) throw missing("url", "a Slack app channel has no webhook URL");
    if (body.slackChannelId === undefined)
      throw missing("slackChannelId", "choose the Slack channel to post to");
    return {
      ...common,
      kind: "slack_app",
      slackChannelId: body.slackChannelId,
      ...(body.name === undefined ? {} : { name: body.name }),
    };
  }
  if (body.slackChannelId !== undefined)
    throw missing("slackChannelId", "a webhook channel has no Slack channel id");
  if (body.url === undefined) throw missing("url", "paste the incoming-webhook URL");
  if (body.name === undefined) throw missing("name", "name the channel");
  return { ...common, kind: "slack", name: body.name, url: body.url };
}

/** Why a post (or a test post) failed: the webhook port's reasons, plus the Slack app's. */
export type ChannelFailure = ChatPostFailure | "not_connected";

export interface ChannelTestResult {
  readonly ok: boolean;
  readonly reason: ChannelFailure | null;
  readonly detail: string | null;
}

/** Last four characters, for telling channels apart. Never more. */
export function urlHint(url: string): string {
  return url.trim().slice(-4);
}

/** Error text safe to store and show: bounded, and never containing the URL. */
function safeError(reason: string, detail: string | undefined, url?: string): string {
  let text = detail ? `${reason}: ${detail}` : reason;
  if (url !== undefined && url.length > 0 && text.includes(url)) text = reason;
  return text.slice(0, 300);
}

function validate(services: ModuleServices, url: string): void {
  const v = services.chat.validateUrl(url);
  if (!v.ok) {
    // `reason` comes from the adapter and names a rule ("host must be hooks.slack.com"); it is
    // passed on only when it does not quote the pasted value back.
    throw new ApiError("validation_failed", "that is not a webhook URL this install can post to", {
      field: "url",
      reason: v.reason.includes(url) ? "invalid_url" : v.reason,
    });
  }
}

async function seal(
  services: ModuleServices,
  tx: Tx,
  ctx: TenantContext,
  url: string,
): Promise<Pick<Channel, "urlEnc" | "encryption" | "urlHint">> {
  const dek = await services.crypto.currentKey(tx, ctx, CHAT_KEY_PURPOSE);
  const urlEnc = await encryptBytes(dek.key, Buffer.from(url, "utf8"));
  const encryption: Encryption = { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
  return {
    urlEnc,
    encryption: encryption as unknown as Record<string, unknown>,
    urlHint: urlHint(url),
  };
}

/** The stored URL, or `undefined` when its key is gone (never throws for that). */
async function unseal(
  services: ModuleServices,
  tx: Tx,
  ctx: TenantContext,
  row: Channel,
): Promise<string | undefined> {
  const enc = row.encryption as Partial<Encryption>;
  if (enc.keyId === undefined || row.urlEnc === null) return undefined;
  const key = await services.crypto.keyById(tx, ctx, enc.keyId);
  if (key === undefined) {
    services.log("notify.channel_key_missing", { level: "warn", channelId: row.id });
    return undefined;
  }
  return Buffer.from(await decryptBytes(key.key, row.urlEnc)).toString("utf8");
}

function uniqueTypes(types: readonly string[]): ChannelEventType[] {
  return [...new Set(types)].filter(isChannelEventType);
}

/** The channel name the admin sees by default for a Slack app channel. */
function slackAppName(ref: ChatChannelRef): string {
  return `#${ref.name}`.slice(0, 80);
}

/**
 * Looks `slackChannelId` up in the Slack app's channel list (E3.6). Runs **outside** any
 * transaction: `slackChannels` opens its own and calls Slack. A channel the bot cannot see is
 * refused with `slack_channel_unknown` rather than stored and discovered at the first alert.
 */
async function resolveSlackChannel(
  services: ModuleServices,
  ctx: TenantContext,
  slackChannelId: string,
): Promise<ChatChannelRef> {
  const listed = await services.integrations.slackChannels(ctx);
  if (!listed.ok) {
    if (listed.reason === "not_connected") {
      throw new ApiError("integration_not_connected", "connect the Slack app first", {
        provider: "slack",
      });
    }
    throw new ApiError("service_unavailable", "Slack did not list its channels", {
      reason: listed.reason,
    });
  }
  const ref = listed.value.find((c) => c.id === slackChannelId);
  if (ref === undefined) {
    throw new ApiError("slack_channel_unknown", "the Slack app cannot post to that channel", {
      field: "slackChannelId",
    });
  }
  return ref;
}

/** The partial unique index `channel_slack_app_idx`, said in words. */
function duplicateSlackChannel(): ApiError {
  return new ApiError("conflict", "a channel already posts to that Slack channel", {
    reason: "duplicate_channel",
    field: "slackChannelId",
  });
}

/** Runs `fn`, turning a unique violation on the Slack channel into a 409. */
async function guardDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (pgErrorCode(error) === "23505") throw duplicateSlackChannel();
    throw error;
  }
}

/** Slack mrkdwn escaping for text we did not write (a workspace name can hold `<` or `&`). */
function mrkdwnEscape(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** The webhook message as one Slack app text: the sentence, then the link inline. */
export function slackAppText(message: ChatMessage): string {
  const text = mrkdwnEscape(message.text);
  if (message.link === undefined) return text;
  return `${text} <${message.link.url}|${mrkdwnEscape(message.link.label)}>`;
}

/**
 * The integrations port's answer, in the channel vocabulary (E3.6). `permanent` is the reason the
 * channel would disable itself with; `null` means "retry later".
 */
export type ChannelPostOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ChannelFailure;
      readonly permanent: ChannelDisabledReason | null;
      readonly retryAfterMs?: number | undefined;
      readonly detail?: string | undefined;
    };

export function fromSlackApp(
  result: IntegrationResult<void> | IntegrationNotConnected,
): ChannelPostOutcome {
  if (result.ok) return { ok: true };
  const detail = "detail" in result ? result.detail : undefined;
  const d = detail === undefined ? {} : { detail };
  switch (result.reason) {
    case "not_connected":
      return { ok: false, reason: "not_connected", permanent: "not_connected" };
    case "unauthorized":
    case "forbidden":
      return { ok: false, reason: "rejected", permanent: "rejected", ...d };
    case "not_found":
      return { ok: false, reason: "not_found", permanent: "not_found", ...d };
    case "rate_limited":
      return { ok: false, reason: "rate_limited", permanent: null, ...d };
    default:
      return { ok: false, reason: "unavailable", permanent: null, ...d };
  }
}

function fromWebhook(result: ChatPostResult): ChannelPostOutcome {
  if (result.ok) return { ok: true };
  const reason = result.reason;
  return {
    ok: false,
    reason,
    permanent: reason === "rate_limited" || reason === "unavailable" ? null : reason,
    retryAfterMs: result.retryAfterMs,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

export async function listChannels(services: ModuleServices, ctx: TenantContext) {
  return services.db.withTenant(ctx, (tx) => new ChannelRepo(ctx, tx).list());
}

export async function createChannel(
  services: ModuleServices,
  ctx: TenantContext,
  input: ChannelInput,
): Promise<Channel> {
  let slack: ChatChannelRef | undefined;
  if (input.kind === "slack_app")
    slack = await resolveSlackChannel(services, ctx, input.slackChannelId);
  else validate(services, input.url);
  return guardDuplicate(() =>
    services.db.withTenant(ctx, async (tx) => {
      const repo = new ChannelRepo(ctx, tx);
      if ((await repo.count()) >= MAX_CHANNELS) {
        throw new ApiError("conflict", `a workspace can have at most ${MAX_CHANNELS} channels`, {
          reason: "too_many_channels",
        });
      }
      const eventTypes = uniqueTypes(input.eventTypes);
      const common = {
        eventTypes,
        enabled: input.enabled ?? true,
        createdBy: ctx.membershipId ?? null,
      };
      let row: Channel;
      if (input.kind === "slack_app" && slack !== undefined) {
        if ((await repo.bySlackChannelId(slack.id)) !== undefined) throw duplicateSlackChannel();
        row = await repo.create({
          ...common,
          kind: "slack_app",
          name: input.name ?? slackAppName(slack),
          urlEnc: null,
          urlHint: null,
          slackChannelId: slack.id,
          slackChannelName: slack.name.slice(0, 200),
        });
      } else {
        row = await repo.create({
          ...common,
          kind: "slack",
          name: (input as WebhookChannelInput).name,
          ...(await seal(services, tx, ctx, (input as WebhookChannelInput).url)),
        });
      }
      await services.audit.record(tx, ctx, {
        action: "notify.channel_created",
        resourceKind: "notify_channel",
        resourceId: row.id,
        meta: { kind: row.kind, eventTypes, enabled: row.enabled },
      });
      return row;
    }),
  );
}

export async function updateChannel(
  services: ModuleServices,
  ctx: TenantContext,
  id: string,
  patch: ChannelPatch,
): Promise<Channel> {
  if (patch.url !== undefined && patch.slackChannelId !== undefined) {
    throw new ApiError(
      "validation_failed",
      "a channel has a webhook URL or a Slack channel, not both",
      {
        field: "slackChannelId",
      },
    );
  }
  if (patch.url !== undefined) validate(services, patch.url);
  // Outside the transaction: the lookup calls Slack.
  const slack =
    patch.slackChannelId === undefined
      ? undefined
      : await resolveSlackChannel(services, ctx, patch.slackChannelId);
  return guardDuplicate(() =>
    services.db.withTenant(ctx, async (tx) => {
      const repo = new ChannelRepo(ctx, tx);
      const current = await repo.byId(id);
      if (current === undefined) throw new ApiError("not_found", "no such channel");
      if (patch.url !== undefined && current.kind !== "slack") {
        throw new ApiError("validation_failed", "a Slack app channel has no webhook URL", {
          field: "url",
        });
      }
      if (slack !== undefined && current.kind !== "slack_app") {
        throw new ApiError("validation_failed", "a webhook channel has no Slack channel id", {
          field: "slackChannelId",
        });
      }
      const set: Parameters<ChannelRepo["update"]>[1] = {};
      const fields: string[] = [];
      if (patch.name !== undefined) {
        set.name = patch.name;
        fields.push("name");
      }
      if (patch.eventTypes !== undefined) {
        set.eventTypes = uniqueTypes(patch.eventTypes);
        fields.push("eventTypes");
      }
      if (patch.url !== undefined) {
        Object.assign(set, await seal(services, tx, ctx, patch.url));
        // A new URL is a fresh start: the old one's failures say nothing about it.
        set.failureCount = 0;
        set.lastError = null;
        set.disabledReason = null;
        fields.push("url");
      }
      if (slack !== undefined) {
        const taken = await repo.bySlackChannelId(slack.id);
        if (taken !== undefined && taken.id !== id) throw duplicateSlackChannel();
        set.slackChannelId = slack.id;
        set.slackChannelName = slack.name.slice(0, 200);
        // Like a new URL: the previous channel's failures say nothing about this one.
        set.failureCount = 0;
        set.lastError = null;
        set.disabledReason = null;
        fields.push("slackChannelId");
      }
      if (patch.enabled !== undefined) {
        set.enabled = patch.enabled;
        if (patch.enabled) {
          set.failureCount = 0;
          set.disabledReason = null;
        }
        fields.push("enabled");
      }
      const row = (await repo.update(id, set)) ?? current;
      if (patch.enabled === false) {
        await new ChannelDeliveryRepo(ctx, tx).dropQueued(id, "channel disabled");
      }
      await services.audit.record(tx, ctx, {
        action: "notify.channel_updated",
        resourceKind: "notify_channel",
        resourceId: id,
        // Which fields changed, never their values: the URL is a credential.
        meta: {
          fields,
          urlChanged: patch.url !== undefined,
          slackChannelChanged: slack !== undefined,
          enabled: row.enabled,
        },
      });
      return row;
    }),
  );
}

export async function deleteChannel(
  services: ModuleServices,
  ctx: TenantContext,
  id: string,
): Promise<void> {
  await services.db.withTenant(ctx, async (tx) => {
    if (!(await new ChannelRepo(ctx, tx).remove(id))) {
      throw new ApiError("not_found", "no such channel");
    }
    await services.audit.record(tx, ctx, {
      action: "notify.channel_deleted",
      resourceKind: "notify_channel",
      resourceId: id,
    });
  });
}

/** Posts a test message now and records the outcome (without counting toward auto-disable). */
export async function testChannel(
  services: ModuleServices,
  ctx: TenantContext,
  id: string,
): Promise<ChannelTestResult> {
  const loaded = await services.db.withTenant(ctx, async (tx) => {
    const row = await new ChannelRepo(ctx, tx).byId(id);
    if (row === undefined) throw new ApiError("not_found", "no such channel");
    return { row, url: row.kind === "slack" ? await unseal(services, tx, ctx, row) : undefined };
  });
  const ws = await loadWorkspace(services, ctx.workspaceId);
  const message: ChatMessage = {
    text: `Test message from ${ws.name}: this channel will receive the alerts you chose.`,
    link: {
      url: services.workspaceUrl(ws, "/admin/notify/channels").href,
      label: "Notification settings",
    },
  };
  let result: ChannelPostOutcome;
  if (loaded.row.kind === "slack_app" && loaded.row.slackChannelId !== null) {
    result = fromSlackApp(
      await services.integrations.slackPost(ctx, loaded.row.slackChannelId, {
        text: slackAppText(message),
      }),
    );
  } else if (loaded.url === undefined) {
    result = {
      ok: false,
      reason: "invalid_url",
      permanent: "invalid_url",
      detail: "the stored URL could not be read",
    };
  } else {
    result = fromWebhook(await services.chat.post(loaded.url, message));
  }
  const now = services.now();
  const out: ChannelTestResult = result.ok
    ? { ok: true, reason: null, detail: null }
    : {
        ok: false,
        reason: result.reason,
        detail: safeError(result.reason, result.detail, loaded.url),
      };
  await services.db.withTenant(ctx, async (tx) => {
    const repo = new ChannelRepo(ctx, tx);
    if (result.ok) await repo.recordSuccess(id, now);
    else await repo.recordTransientFailure(id, out.detail ?? result.reason);
    await services.audit.record(tx, ctx, {
      action: "notify.channel_tested",
      resourceKind: "notify_channel",
      resourceId: id,
      meta: { ok: out.ok, reason: out.reason },
    });
  });
  return out;
}

export interface ChannelAnnouncement {
  readonly eventType: ChannelEventType;
  /** `<event type>:<id of the fact>` — the dedupe key per channel. */
  readonly sourceKey: string;
  readonly actorMembershipId: string | null;
  /** Ids and numbers only. */
  readonly payload: Record<string, string | number>;
  /** Only channels of these kinds (default: every kind). */
  readonly kinds?: readonly ChannelKind[] | undefined;
}

/**
 * Queues one delivery per enabled channel subscribed to the event, inside the caller's
 * (outbox) transaction, and enqueues the poster job in the same transaction when anything was
 * queued. A redelivered event finds its rows already there and queues nothing.
 */
export async function enqueueChannelPosts(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  a: ChannelAnnouncement,
): Promise<number> {
  const channels = (await new ChannelRepo(ctx, tx).forEventType(a.eventType)).filter(
    (ch) => a.kinds === undefined || a.kinds.includes(ch.kind),
  );
  if (channels.length === 0) return 0;
  // An announcement about a member being erased would re-publish their name (see `fanOut`).
  if (a.actorMembershipId !== null && (await services.legal.isErased(tx, ctx, a.actorMembershipId)))
    return 0;
  const deliveries = new ChannelDeliveryRepo(ctx, tx);
  let queued = 0;
  for (const ch of channels) {
    const fresh = await deliveries.enqueue({
      channelId: ch.id,
      sourceKey: a.sourceKey,
      eventType: a.eventType,
      actorMembershipId: a.actorMembershipId,
      payload: a.payload,
    });
    if (fresh) queued += 1;
  }
  if (queued > 0) {
    await services.queue.sendInTransaction(tx, JOB_CHANNELS, { workspaceId: ctx.workspaceId });
  }
  return queued;
}

/** The chat message for one delivery; names are resolved now, never stored. */
export function renderChannelMessage(
  services: ModuleServices,
  ws: Workspace,
  d: Pick<ChannelDelivery, "eventType" | "payload" | "actorMembershipId">,
  actorName: string | null,
): ChatMessage {
  const type = d.eventType as ChannelEventType;
  const id = (k: string) => {
    const v = d.payload[k];
    return typeof v === "string" ? v : "";
  };
  const who = actorName ?? "Someone";
  switch (type) {
    case "analytics.hot_lead": {
      const score = d.payload["score"];
      return {
        text: `${who} ${VERB[type]} in ${ws.name}${typeof score === "number" ? ` (score ${score})` : ""}.`,
        link: {
          url: services.workspaceUrl(ws, `/admin/analytics/members/${id("membershipId")}`).href,
          label: "See their activity",
        },
      };
    }
    case "round.commitment_created":
      return {
        text:
          actorName === null
            ? `A new commitment was recorded in ${ws.name}.`
            : `${who} ${VERB[type]} in ${ws.name}.`,
        link: {
          url: services.workspaceUrl(ws, `/admin/round/rounds/${id("roundId")}`).href,
          label: "Open the round",
        },
      };
    case "round.interest_submitted":
      return {
        text: `${who} ${VERB[type]} in ${ws.name}.`,
        link: {
          url: services.workspaceUrl(ws, `/admin/round/rounds/${id("roundId")}`).href,
          label: "Open the interest queue",
        },
      };
    case "round.verification_requested":
      return {
        text: `${who} ${VERB[type]} in ${ws.name}.`,
        link: {
          url: services.workspaceUrl(ws, "/admin/round/verifications").href,
          label: "Open the verification queue",
        },
      };
    case "access_request.submitted":
      // Generic on purpose (E3.1): the requester is not a member, and a chat service is a third
      // party — no name, address, firm or reason, whatever `actorName` says.
      return {
        text: `A new access request is waiting for review in ${ws.name}.`,
        link: {
          url: services.workspaceUrl(ws, "/admin/access-requests").href,
          label: "Review access requests",
        },
      };
    case "access_review.overdue":
      return {
        text: `The periodic access review of ${ws.name} is overdue.`,
        link: {
          url: services.workspaceUrl(ws, "/admin/access-review").href,
          label: "Open the access review",
        },
      };
    case "qa.question_asked":
      // Generic on purpose (E3.3): no asker, no target, no question text reaches a third party.
      return {
        text: `A new data-room question is waiting in ${ws.name}.`,
        link: {
          url: services.workspaceUrl(ws, `/admin/data-room/questions/${id("questionId")}`).href,
          label: "Open the question",
        },
      };
    case "integration.connection_unhealthy":
      // A vendor name and a state (E3.6): no account label, no error text.
      return {
        text: integrationHealthSentence(id("provider"), id("status"), ws.name),
        link: {
          url: services.workspaceUrl(ws, "/admin/integrations").href,
          label: "Open integrations",
        },
      };
  }
}

function backoffMs(attempts: number, retryAfterMs: number | undefined): number {
  const exp = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return Math.max(exp, retryAfterMs ?? 0);
}

export interface PostOutcome {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly dropped: number;
  readonly disabled: number;
}

/**
 * Claims and posts the workspace's due channel deliveries. Posting happens outside any
 * transaction (a slow webhook must not hold a row lock or a pooled connection).
 */
export async function postDueDeliveries(
  services: ModuleServices,
  ctx: TenantContext,
  limit = 50,
): Promise<PostOutcome> {
  const now = services.now();
  const claimed = await services.db.withTenant(ctx, async (tx) =>
    // A held or suspended workspace posts nothing (E3.10 FR1): its deliveries stay due, unclaimed,
    // until `notify.deliver` finds it active again.
    (await workspaceIsActive(tx, ctx.workspaceId))
      ? new ChannelDeliveryRepo(ctx, tx).claimDue(
          now,
          new Date(now.getTime() - CHANNEL_CLAIM_STALE_MS),
          limit,
        )
      : [],
  );
  const out = { sent: 0, retried: 0, failed: 0, dropped: 0, disabled: 0 };
  if (claimed.length === 0) return out;
  const ws = await loadWorkspace(services, ctx.workspaceId);
  for (const d of claimed) {
    const prepared = await services.db.withTenant(ctx, async (tx) => {
      const ch = await new ChannelRepo(ctx, tx).byId(d.channelId);
      if (ch === undefined || !ch.enabled) return { drop: "channel disabled" as const };
      let target: { readonly url: string } | { readonly slackChannelId: string };
      if (ch.kind === "slack_app") {
        if (ch.slackChannelId === null) return { drop: "no Slack channel" as const };
        target = { slackChannelId: ch.slackChannelId };
      } else {
        const url = await unseal(services, tx, ctx, ch);
        if (url === undefined) return { drop: "stored URL unreadable" as const };
        target = { url };
      }
      const names = d.actorMembershipId
        ? await new MembershipRepo(ctx, tx).namesFor([d.actorMembershipId])
        : undefined;
      const actorName = d.actorMembershipId
        ? (names?.get(d.actorMembershipId)?.displayName ?? "Someone")
        : null;
      return { target, message: renderChannelMessage(services, ws, d, actorName) };
    });
    if ("drop" in prepared) {
      const why: string = prepared.drop;
      await services.db.withTenant(ctx, (tx) =>
        new ChannelDeliveryRepo(ctx, tx).finish(d.id, "dropped", now, why),
      );
      out.dropped += 1;
      continue;
    }
    const { target, message } = prepared;
    const url = "url" in target ? target.url : undefined;
    // Outside any transaction: a slow chat service must not hold a row lock or a connection.
    let result: ChannelPostOutcome;
    try {
      result =
        "url" in target
          ? fromWebhook(await services.chat.post(target.url, message))
          : fromSlackApp(
              await services.integrations.slackPost(ctx, target.slackChannelId, {
                text: slackAppText(message),
              }),
            );
    } catch {
      // Both ports promise not to throw for a remote problem; a throw is ours. Retry it.
      result = {
        ok: false,
        reason: "unavailable",
        permanent: null,
        detail: "the chat adapter failed",
      };
    }
    await services.db.withTenant(ctx, async (tx) => {
      const deliveries = new ChannelDeliveryRepo(ctx, tx);
      const channels = new ChannelRepo(ctx, tx);
      const at = services.now();
      if (result.ok) {
        await deliveries.finish(d.id, "sent", at, null);
        await channels.recordSuccess(d.channelId, at);
        out.sent += 1;
        return;
      }
      const error = safeError(result.reason, result.detail, url);
      if (result.permanent === null) {
        await channels.recordTransientFailure(d.channelId, error);
        if (d.attempts >= CHANNEL_MAX_ATTEMPTS) {
          await deliveries.finish(d.id, "failed", at, error);
          out.failed += 1;
        } else {
          await deliveries.retryAt(
            d.id,
            new Date(at.getTime() + backoffMs(d.attempts, result.retryAfterMs)),
            error,
          );
          out.retried += 1;
        }
        return;
      }
      await deliveries.finish(d.id, "failed", at, error);
      out.failed += 1;
      const reason: ChannelDisabledReason = result.permanent;
      if (
        await channels.recordPermanentFailure(d.channelId, reason, error, CHANNEL_DISABLE_AFTER)
      ) {
        out.disabled += 1;
        await deliveries.dropQueued(d.channelId, "channel disabled");
        await services.audit.record(tx, ctx, {
          action: "notify.channel_disabled",
          resourceKind: "notify_channel",
          resourceId: d.channelId,
          meta: { reason, after: CHANNEL_DISABLE_AFTER },
        });
        services.log("notify.channel_disabled", {
          level: "warn",
          workspaceId: ctx.workspaceId,
          channelId: d.channelId,
          reason,
        });
      }
    });
  }
  return out;
}
