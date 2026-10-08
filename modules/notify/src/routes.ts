import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { accessRequestSummaries } from "./repos/access-request-repo.js";
import {
  type InboxCursor,
  NotificationRepo,
  PreferenceRepo,
  SettingsRepo,
} from "./repos/notify-repo.js";
import {
  type ChannelEventType,
  effectiveCadence,
  isNotifyEventType,
  NOTIFY_EVENT_TYPES,
} from "./rules.js";
import { DEFAULT_DIGEST_HOUR, DEFAULT_TIMEZONE, DEFAULT_WEEKLY_DAY } from "./schedule.js";
import type { Cadence, Channel, MemberSettings } from "./schema/notify.js";
import {
  channelInputOf,
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannel,
} from "./service/channels.js";

/*
 * `/api/v1/notify/*`. Self-service routes (preferences, settings, the inbox) need `notify.read`
 * (every staff role); RLS additionally fences the inbox to the caller's own rows. Channel routes
 * (E2.6) need `notify.manage` (owner, admin): a channel posts into a room the whole team reads,
 * so it is workspace configuration, not a personal preference. Creating a channel, changing its
 * URL and deleting it need a fresh session. Investors get 404 from the guard: this module has no
 * investor surface.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
const TAGS = ["notify"];
const PERM = "notify.read";
const PERM_MANAGE = "notify.manage";
/** Test posts hit a third party; a handful per channel per ten minutes is plenty. */
const TEST_RATE = { max: 5, windowMs: 10 * 60_000 } as const;
/** Listing Slack channels calls Slack (E3.6): enough for a picker opened a few times. */
const SLACK_LIST_RATE = { max: 30, windowMs: 10 * 60_000 } as const;

type Vars = ModuleEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function settingsBody(settings: MemberSettings | undefined) {
  const start = settings?.quietStart ?? null;
  const end = settings?.quietEnd ?? null;
  return {
    emailEnabled: settings?.emailEnabled ?? true,
    timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
    digestHour: settings?.digestHour ?? DEFAULT_DIGEST_HOUR,
    weeklyDay: settings?.weeklyDay ?? DEFAULT_WEEKLY_DAY,
    quietHours: start !== null && end !== null ? { start, end } : null,
  };
}

function preferencesBody(
  stored: ReadonlyMap<string, Cadence>,
  settings: MemberSettings | undefined,
) {
  return {
    preferences: NOTIFY_EVENT_TYPES.map((eventType) => ({
      eventType,
      cadence: effectiveCadence(eventType, stored),
      isDefault: !stored.has(eventType),
    })),
    settings: settingsBody(settings),
  };
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function encodeInboxCursor(c: InboxCursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

export function decodeInboxCursor(raw: string): InboxCursor {
  const [createdAt, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (
    extra !== undefined ||
    createdAt === undefined ||
    id === undefined ||
    !CURSOR_TS.test(createdAt) ||
    !UUID.test(id)
  ) {
    throw new ApiError("invalid_request", "malformed cursor", { field: "cursor" });
  }
  return { createdAt, id };
}

/** The URL never leaves the server: this is the only shape a channel is returned in. */
function channelBody(ch: Channel) {
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    urlHint: ch.urlHint,
    slackChannelId: ch.slackChannelId,
    slackChannelName: ch.slackChannelName,
    eventTypes: ch.eventTypes as ChannelEventType[],
    enabled: ch.enabled,
    disabledReason: ch.disabledReason ?? null,
    failureCount: ch.failureCount,
    lastSuccessAt: iso(ch.lastSuccessAt),
    lastError: ch.lastError,
    createdAt: ch.createdAt.toISOString(),
    updatedAt: ch.updatedAt.toISOString(),
  };
}

export function registerNotifyRoutes(api: ModuleRouter, services: ModuleServices): void {
  const perm = () => services.guards.requirePermission(PERM);
  const manage = (fresh = false) => services.guards.requirePermission(PERM_MANAGE, { fresh });

  api.openapi(
    createRoute({
      method: "get",
      path: "/preferences",
      tags: TAGS,
      summary: "My notification preferences, digest schedule and quiet hours",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      responses: { 200: jsonResponse(s.PreferencesSchema, "Preferences"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = await services.db.withTenant(sg.tenant, async (tx) =>
        preferencesBody(
          await new PreferenceRepo(sg.tenant, tx).forMember(sg.membership.id),
          await new SettingsRepo(sg.tenant, tx).forMember(sg.membership.id),
        ),
      );
      return c.json(body, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/preferences",
      tags: TAGS,
      summary: "Set my notification cadences, digest schedule and quiet hours",
      description:
        "Cadence is `instant`, `daily`, `weekly` or `off` per event type. The digest hour and quiet hours are local to `timezone` (an IANA name); daily and weekly digests go out at `digestHour`, the weekly one on `weeklyDay` (0 = Sunday). Quiet hours hold back instant emails until the window ends — the inbox fills immediately either way.",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      request: { body: jsonBody(s.UpdatePreferencesBody) },
      responses: { 200: jsonResponse(s.PreferencesSchema, "Preferences"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const input = c.req.valid("json");
      const body = await services.db.withTenant(sg.tenant, async (tx) => {
        const prefs = new PreferenceRepo(sg.tenant, tx);
        const settings = new SettingsRepo(sg.tenant, tx);
        const touched: string[] = [];
        for (const p of input.preferences) {
          if (!isNotifyEventType(p.eventType)) continue;
          await prefs.upsert(sg.membership.id, p.eventType, p.cadence);
          touched.push(p.eventType);
        }
        const st = input.settings;
        const changed = st
          ? Object.entries(st)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k)
          : [];
        if (st && changed.length > 0) {
          await settings.upsert(sg.membership.id, {
            emailEnabled: st.emailEnabled,
            timezone: st.timezone,
            digestHour: st.digestHour,
            weeklyDay: st.weeklyDay,
            quiet: st.quietHours,
          });
        }
        await services.audit.record(tx, sg.tenant, {
          action: "notify.preferences_changed",
          resourceKind: "notification_preference",
          subjectMembershipId: sg.membership.id,
          meta: { eventTypes: touched, ...(st ? { settings: changed } : {}) },
        });
        return preferencesBody(
          await prefs.forMember(sg.membership.id),
          await settings.forMember(sg.membership.id),
        );
      });
      return c.json(body, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/inbox",
      tags: TAGS,
      summary: "My notification inbox (newest first, keyset paged)",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      request: { query: s.InboxQuery },
      responses: { 200: jsonResponse(s.InboxSchema, "Inbox"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const cursor = q.cursor === undefined ? undefined : decodeInboxCursor(q.cursor);
      const body = await services.db.withTenant(sg.tenant, async (tx) => {
        const repo = new NotificationRepo(sg.tenant, tx);
        const page = await repo.inbox(sg.membership.id, {
          limit: q.limit + 1,
          cursor,
          includeArchived: q.archived === "true",
          unreadOnly: q.unread === "true",
        });
        const more = page.length > q.limit;
        const rows = more ? page.slice(0, q.limit) : page;
        const unread = await repo.unreadCount(sg.membership.id);
        const actorIds = [
          ...new Set(
            rows.map((r) => r.row.actorMembershipId).filter((x): x is string => x !== null),
          ),
        ];
        const names = await new MembershipRepo(sg.tenant, tx).namesFor(actorIds);
        // An access-request alert has no actor (the requester is not a member): name the
        // requester from the live row instead, so the inbox never says "removed contact".
        const requesters = await accessRequestSummaries(
          sg.tenant,
          tx,
          rows
            .filter(
              ({ row: r }) => r.eventType === "access_request.submitted" && r.resourceId !== null,
            )
            .map(({ row: r }) => r.resourceId as string),
        );
        const last = rows.at(-1);
        return {
          items: rows.map(({ row: r }) => {
            const a = r.actorMembershipId ? names.get(r.actorMembershipId) : undefined;
            return {
              id: r.id,
              eventType: r.eventType as (typeof NOTIFY_EVENT_TYPES)[number],
              createdAt: r.createdAt.toISOString(),
              sentAt: iso(r.sentAt),
              readAt: iso(r.readAt),
              archivedAt: iso(r.archivedAt),
              actor:
                a && r.actorMembershipId
                  ? {
                      membershipId: r.actorMembershipId,
                      displayName: a.displayName,
                      kind: a.kind,
                      role: a.role,
                    }
                  : null,
              subjectName:
                r.eventType === "access_request.submitted" && r.resourceId !== null
                  ? (requesters.get(r.resourceId)?.name ?? null)
                  : null,
              resourceKind: r.resourceKind,
              resourceId: r.resourceId,
              payload: r.payload,
            };
          }),
          unread,
          nextCursor:
            more && last !== undefined
              ? encodeInboxCursor({ createdAt: last.key, id: last.row.id })
              : null,
        };
      });
      return c.json(body, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/inbox/read",
      tags: TAGS,
      summary: "Mark notifications read (all when no ids are given)",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      request: { body: jsonBody(s.MarkReadBody) },
      responses: { 200: jsonResponse(s.MarkReadResultSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { ids } = c.req.valid("json");
      const updated = await services.db.withTenant(sg.tenant, (tx) =>
        new NotificationRepo(sg.tenant, tx).markRead(sg.membership.id, services.now(), ids),
      );
      return c.json({ updated }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/inbox/read-all",
      tags: TAGS,
      summary: "Mark every unread notification read, up to an instant",
      description:
        "`upTo` is the moment the screen was drawn: a notification that arrived after it stays unread, so a founder never dismisses an alert they did not see.",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      request: { body: jsonBody(s.ReadAllBody) },
      responses: { 200: jsonResponse(s.MarkReadResultSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { upTo } = c.req.valid("json");
      const now = services.now();
      const updated = await services.db.withTenant(sg.tenant, (tx) =>
        new NotificationRepo(sg.tenant, tx).markRead(
          sg.membership.id,
          now,
          undefined,
          upTo === undefined ? now : new Date(upTo),
        ),
      );
      return c.json({ updated }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/inbox/archive",
      tags: TAGS,
      summary: "Archive (or restore) my notifications",
      security: sessionSecurity,
      "x-requires": PERM,
      middleware: [perm()] as const,
      request: { body: jsonBody(s.ArchiveBody) },
      responses: { 200: jsonResponse(s.MarkReadResultSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { ids, archived } = c.req.valid("json");
      const updated = await services.db.withTenant(sg.tenant, (tx) =>
        new NotificationRepo(sg.tenant, tx).setArchived(
          sg.membership.id,
          ids,
          archived,
          services.now(),
        ),
      );
      return c.json({ updated }, 200);
    },
  );

  // --- channels (E2.6) ------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/channels",
      tags: TAGS,
      summary: "Workspace chat channels (the webhook URL is never returned)",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [manage()] as const,
      responses: { 200: jsonResponse(s.ChannelListSchema, "Channels"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const rows = await listChannels(services, sg.tenant);
      return c.json({ channels: rows.map(channelBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/channels",
      tags: TAGS,
      summary: "Add a Slack channel (incoming webhook, or a channel of the Slack app)",
      description:
        '`kind: "slack"` (or no kind): the URL is validated against the chat adapter\'s rules (https, `hooks.slack.com`, a webhook path) before anything is stored, then kept envelope-encrypted. It is write-only: no response ever contains it, only its last four characters as `urlHint`. `kind: "slack_app"`: `slackChannelId` must be one the connected Slack app lists (`GET /notify/slack/channels`) — `404 integration_not_connected` without a Slack connection, `422 slack_channel_unknown` for a channel it cannot post to, `409 conflict` (`reason: duplicate_channel`) when another channel already posts there. Needs a fresh session.',
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [manage(true)] as const,
      request: { body: jsonBody(s.CreateChannelBody) },
      responses: { 201: jsonResponse(s.ChannelSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const input = channelInputOf(c.req.valid("json"));
      const row = await createChannel(services, sg.tenant, input);
      return c.json(channelBody(row), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/channels/{id}",
      tags: TAGS,
      summary: "Rename, re-subscribe, enable/disable or re-point a channel",
      description:
        "A body carrying `url` (webhook channels) or `slackChannelId` (Slack app channels) additionally needs a fresh session (the same step-up as creating a channel) — pointing an existing channel somewhere else is as sensitive as adding one. Renaming, changing event types and switching it on or off do not. Re-enabling or re-pointing a channel clears its failure count.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [manage()] as const,
      request: { params: s.ChannelParams, body: jsonBody(s.UpdateChannelBody) },
      responses: { 200: jsonResponse(s.ChannelSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const input = c.req.valid("json");
      if (input.url !== undefined || input.slackChannelId !== undefined) {
        // Conditional step-up: the kernel guard itself, run for this body only.
        await manage(true)(c, async () => {});
      }
      const row = await updateChannel(services, sg.tenant, c.req.valid("param").id, input);
      return c.json(channelBody(row), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/channels/{id}",
      tags: TAGS,
      summary: "Remove a channel (queued posts to it are dropped)",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [manage(true)] as const,
      request: { params: s.ChannelParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      await deleteChannel(services, sg.tenant, c.req.valid("param").id);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/slack/channels",
      tags: TAGS,
      summary: "Slack channels the connected Slack app can post to",
      description:
        "Proxies the workspace's Slack app connection: `404 integration_not_connected` when Slack is not connected; `503 service_unavailable` with `reason` (the integration failure, e.g. `unauthorized` when Slack must be reconnected) when Slack did not answer. Names only — no member lists, no messages.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [manage()] as const,
      responses: { 200: jsonResponse(s.SlackChannelListSchema, "Channels"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const limit = await services.rateLimiter.hit(
        `notify.slack_channels:${sg.tenant.workspaceId}`,
        SLACK_LIST_RATE,
      );
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many Slack channel lookups", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      const listed = await services.integrations.slackChannels(sg.tenant);
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
      const channels = [...listed.value]
        .map((ch) => ({ id: ch.id, name: ch.name, isPrivate: ch.isPrivate }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ channels }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/channels/{id}/test",
      tags: TAGS,
      summary: "Post a test message to a channel now",
      description:
        "Reports what the chat service answered. `not_found` means the webhook was revoked (paste a new one); `rate_limited` / `unavailable` are temporary. A failed test is recorded as `lastError` but does not count toward the channel disabling itself.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [manage()] as const,
      request: { params: s.ChannelParams },
      responses: { 200: jsonResponse(s.ChannelTestResultSchema, "Result"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const id = c.req.valid("param").id;
      const limit = await services.rateLimiter.hit(`notify.channel_test:${id}`, TEST_RATE);
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many test posts", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      return c.json(await testChannel(services, sg.tenant, id), 200);
    },
  );
}
