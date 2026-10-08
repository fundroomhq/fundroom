import type {
  ChatChannelRef,
  IntegrationAdapter,
  IntegrationAdapterDeps,
  IntegrationAuth,
  IntegrationProviderMeta,
  IntegrationResult,
  OAuthClient,
  OAuthTokenSet,
} from "@fundroom/ports";
import {
  type Failure,
  failure,
  isRecord,
  parseJson,
  safeToken,
  send,
  statusFailure,
  str,
} from "./http.js";

/*
 * Slack app (OAuth v2 bot token) — E3.6, ADR-0054.
 *
 * Slack's Web API answers almost every application error with HTTP 200 and `{ok:false, error}`;
 * the `error` token is mapped by {@link mapSlackError}. Only the token is ever echoed in a detail.
 */

export const SLACK_API_BASE_URL = "https://slack.com/api";
export const SLACK_AUTH_BASE_URL = "https://slack.com";
export const SLACK_BOT_SCOPES = ["chat:write", "chat:write.public", "channels:read"] as const;

/** conversations.list page size (Slack recommends ≤ 200) and page cap (contract §1). */
export const CHANNEL_PAGE_LIMIT = 200;
export const CHANNEL_MAX_PAGES = 50;
/** Slack truncates `text` beyond 40 000 characters and recommends ≤ 4 000; alerts are short. */
export const TEXT_MAX_LENGTH = 4_000;
/** Slack's own cap on blocks per message. */
export const BLOCKS_MAX = 50;

export const slackMeta: IntegrationProviderMeta = {
  provider: "slack",
  displayName: "Slack",
  capabilities: ["chat"],
  auth: "oauth2",
  oauth: {
    authorizeUrl: `${SLACK_AUTH_BASE_URL}/oauth/v2/authorize`,
    tokenUrl: `${SLACK_API_BASE_URL}/oauth.v2.access`,
    revokeUrl: `${SLACK_API_BASE_URL}/auth.revoke`,
    scopes: SLACK_BOT_SCOPES,
    // Slack's PKCE (GA 2026-03) is enabled per app and marks the app a *public* client; a
    // server-side install keeps the client secret instead (see README).
    pkce: false,
    scopeSeparator: ",",
  },
  scopeExplanation: [
    "Lists the public channels in your Slack workspace so you can pick where alerts go.",
    "Posts the alert messages you configure into the channels you choose.",
    "Never reads messages, files, private channels, direct messages or your member list.",
  ],
  subProcessor: {
    name: "Slack Technologies, LLC",
    purpose: "Delivers the workspace's notification alerts to its Slack channels",
    region: "United States (or the Slack workspace's data residency region)",
    dpaUrl: "https://slack.com/terms-of-service/data-processing",
    jurisdiction: "varies",
  },
};

export interface SlackAdapterOptions {
  /** Test seam only (ContainerOptions.integrationAdapters): Web API root, default https://slack.com/api */
  readonly apiBaseUrl?: string | undefined;
  /** Test seam only: host of the authorize page, default https://slack.com */
  readonly authBaseUrl?: string | undefined;
}

/** Slack mrkdwn treats `&`, `<` and `>` as control characters; everything else is literal. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const UNAUTHORIZED = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_refresh_token",
  "invalid_grant",
  "invalid_code",
  "code_already_used",
  "invalid_client_id",
  "bad_client_secret",
  "bad_redirect_uri",
  "oauth_authorization_url_mismatch",
]);
const FORBIDDEN = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "no_permission",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "not_in_channel",
  "ekm_access_denied",
  "team_access_not_granted",
  "access_denied",
]);
const NOT_FOUND = new Set(["channel_not_found", "is_archived", "team_not_found"]);
const UNAVAILABLE = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "team_added_to_org",
]);

/** `{ok:false, error}` → typed failure. Unknown tokens are request problems (`malformed`). */
export function mapSlackError(error: unknown): Failure {
  const token = safeToken(error);
  if (token === undefined) return failure("malformed", "Slack refused the request");
  if (UNAUTHORIZED.has(token)) return failure("unauthorized", token);
  if (FORBIDDEN.has(token)) return failure("forbidden", token);
  if (NOT_FOUND.has(token)) return failure("not_found", token);
  if (token === "ratelimited" || token === "rate_limited") return failure("rate_limited", token);
  if (UNAVAILABLE.has(token)) return failure("unavailable", token);
  return failure("malformed", token);
}

type SlackOk = { ok: true; data: Record<string, unknown> };

export function createSlackAdapter(
  deps: IntegrationAdapterDeps,
  options: SlackAdapterOptions = {},
): IntegrationAdapter {
  const apiBase = (options.apiBaseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/u, "");
  const meta: IntegrationProviderMeta =
    options.apiBaseUrl === undefined && options.authBaseUrl === undefined
      ? slackMeta
      : {
          ...slackMeta,
          oauth: {
            ...(slackMeta.oauth as NonNullable<IntegrationProviderMeta["oauth"]>),
            authorizeUrl: `${(options.authBaseUrl ?? SLACK_AUTH_BASE_URL).replace(/\/+$/u, "")}/oauth/v2/authorize`,
            tokenUrl: `${apiBase}/oauth.v2.access`,
            revokeUrl: `${apiBase}/auth.revoke`,
          },
        };

  /** One Web API call: HTTP status first, then Slack's `{ok}` envelope. */
  async function call(
    method: string,
    init: { token?: string; client?: OAuthClient; form?: Record<string, string>; json?: unknown },
  ): Promise<SlackOk | Failure> {
    const headers: Record<string, string> = { accept: "application/json" };
    let body: string | undefined;
    if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
    if (init.client !== undefined) {
      const basic = Buffer.from(
        `${encodeURIComponent(init.client.clientId)}:${encodeURIComponent(init.client.clientSecret)}`,
      ).toString("base64");
      headers["authorization"] = `Basic ${basic}`;
    }
    if (init.json !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(init.json);
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form ?? {}).toString();
    }
    const sent = await send(deps.fetch, `${apiBase}/${method}`, { method: "POST", headers, body });
    if (!sent.ok) return sent;
    const parsed = parseJson(sent.body);
    const token = isRecord(parsed) ? safeToken(parsed["error"]) : undefined;
    if (sent.status === 429) {
      const retry = sent.headers.get("retry-after");
      return failure(
        "rate_limited",
        retry !== null && /^\d{1,6}$/u.test(retry.trim())
          ? `retry after ${retry.trim()}s`
          : "ratelimited",
      );
    }
    const bad = statusFailure(sent.status, token);
    if (bad !== undefined) return bad;
    if (!isRecord(parsed)) return failure("malformed", `${method} answered a non-JSON body`);
    if (parsed["ok"] !== true) {
      if (parsed["ok"] === false) return mapSlackError(parsed["error"]);
      return failure("malformed", `${method} answered without "ok"`);
    }
    return { ok: true, data: parsed };
  }

  function tokenSet(data: Record<string, unknown>): IntegrationResult<OAuthTokenSet> {
    const accessToken = str(data["access_token"]);
    if (accessToken === undefined) return failure("malformed", "no access_token in the answer");
    const tokenType = str(data["token_type"]);
    if (tokenType !== undefined && tokenType !== "bot")
      return failure("malformed", "Slack did not issue a bot token");
    const team = isRecord(data["team"]) ? data["team"] : undefined;
    const enterprise = isRecord(data["enterprise"]) ? data["enterprise"] : undefined;
    const expiresIn =
      typeof data["expires_in"] === "number" &&
      Number.isFinite(data["expires_in"]) &&
      data["expires_in"] > 0
        ? data["expires_in"]
        : undefined;
    const extra: Record<string, string> = {};
    const teamName = str(team?.["name"]);
    const botUserId = str(data["bot_user_id"]);
    const appId = str(data["app_id"]);
    const enterpriseId = str(enterprise?.["id"]);
    if (teamName !== undefined) extra["teamName"] = teamName;
    if (botUserId !== undefined) extra["botUserId"] = botUserId;
    if (appId !== undefined) extra["appId"] = appId;
    if (enterpriseId !== undefined) extra["enterpriseId"] = enterpriseId;
    return {
      ok: true,
      value: {
        accessToken,
        refreshToken: str(data["refresh_token"]) ?? null,
        expiresAt:
          expiresIn === undefined ? null : new Date(deps.now().getTime() + expiresIn * 1000),
        scope: str(data["scope"]) ?? null,
        externalAccountId: str(team?.["id"]) ?? null,
        extra,
      },
    };
  }

  return {
    meta,

    async exchangeCode({ code, redirectUri, client }) {
      const res = await call("oauth.v2.access", {
        client,
        form: { code, redirect_uri: redirectUri },
      });
      return res.ok ? tokenSet(res.data) : res;
    },

    async refresh({ refreshToken, client }) {
      const res = await call("oauth.v2.access", {
        client,
        form: { grant_type: "refresh_token", refresh_token: refreshToken },
      });
      return res.ok ? tokenSet(res.data) : res;
    },

    async revoke({ token }) {
      try {
        const res = await call("auth.revoke", { token, form: {} });
        if (!res.ok) deps.log?.("integration.slack.revoke_failed", { reason: res.reason });
      } catch {
        // best effort, never throws
      }
    },

    async verify(auth: IntegrationAuth) {
      const res = await call("auth.test", { token: auth.accessToken, form: {} });
      if (!res.ok) return res;
      const teamId = str(res.data["team_id"]);
      const team = str(res.data["team"]);
      if (teamId === undefined) return failure("malformed", "auth.test answered without team_id");
      return { ok: true, value: { accountLabel: team ?? teamId, externalAccountId: teamId } };
    },

    chat: {
      async listChannels(auth) {
        const channels: ChatChannelRef[] = [];
        let cursor = "";
        for (let page = 0; page < CHANNEL_MAX_PAGES; page++) {
          const form: Record<string, string> = {
            types: "public_channel",
            exclude_archived: "true",
            limit: String(CHANNEL_PAGE_LIMIT),
          };
          if (cursor !== "") form["cursor"] = cursor;
          const res = await call("conversations.list", { token: auth.accessToken, form });
          if (!res.ok) return res;
          if (!Array.isArray(res.data["channels"]))
            return failure("malformed", "conversations.list answered without channels");
          for (const c of res.data["channels"]) {
            if (!isRecord(c)) continue;
            const id = str(c["id"]);
            const name = str(c["name"]);
            if (id === undefined || name === undefined) continue;
            if (c["is_archived"] === true) continue;
            channels.push({ id, name, isPrivate: c["is_private"] === true });
          }
          const meta = isRecord(res.data["response_metadata"])
            ? res.data["response_metadata"]
            : undefined;
          cursor = str(meta?.["next_cursor"]) ?? "";
          if (cursor === "") {
            channels.sort((a, b) => a.name.localeCompare(b.name));
            return { ok: true, value: channels };
          }
        }
        return failure("too_large", `more than ${CHANNEL_MAX_PAGES} pages of channels`);
      },

      async post(auth, channelId, message) {
        if (!/^[A-Z0-9]{1,40}$/u.test(channelId)) return failure("not_found", "invalid channel id");
        const payload: Record<string, unknown> = {
          channel: channelId,
          text: escapeSlackText(truncate(message.text, TEXT_MAX_LENGTH)),
          unfurl_links: false,
          unfurl_media: false,
        };
        if (message.blocks !== undefined && message.blocks.length > 0) {
          if (message.blocks.length > BLOCKS_MAX)
            return failure("malformed", `more than ${BLOCKS_MAX} blocks`);
          payload["blocks"] = message.blocks;
        }
        const res = await call("chat.postMessage", { token: auth.accessToken, json: payload });
        return res.ok ? { ok: true, value: undefined } : res;
      },
    },
  };
}
