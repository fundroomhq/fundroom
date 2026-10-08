import type {
  ChatMessage,
  ChatPostFailure,
  ChatPostResult,
  ChatWebhookPort,
  OutboundFetch,
} from "@fundroom/ports";

/*
 * Slack incoming webhooks (E2.6, design/03 C2/F8).
 *
 * A pasted webhook URL is two things at once: a bearer credential (whoever holds it can post
 * into the channel) and a destination the server will send a request to. The second is the one
 * this file is about. An admin types it into a form, so without a pin the "post an alert" feature
 * is an outbound request to an address of the admin's choosing — the SSRF guard stops private
 * ranges, but not a request to any public host carrying our alert text. So:
 *
 *  - the host is **pinned** to `hooks.slack.com`, https only, default port, no userinfo, no
 *    query, no fragment, and the path must be one of Slack's two webhook shapes;
 *  - the request URL is **rebuilt** from the validated parts, never the pasted string, so a
 *    parser disagreement between `validateUrl` and the fetch cannot smuggle a different target;
 *  - **no redirect is followed**: `redirect: "manual"` here and `maxRedirects: 0` on the guarded
 *    agent the composition root gives this adapter. A 3xx is reported, not chased;
 *  - no failure `detail` ever contains the URL (or any part of its path, which *is* the secret),
 *    and nothing is logged here at all — the caller logs the typed reason.
 */

export const SLACK_WEBHOOK_HOST = "hooks.slack.com";
/** Slack's own URLs are ~80 characters; anything this long is not one. */
const URL_MAX_LENGTH = 500;
/** `/services/T…/B…/secret` or `/workflows/T…/A…/id/secret`; 2–5 opaque segments. */
const PATH_RE = /^\/(?:services|workflows)(?:\/[A-Za-z0-9_-]{1,128}){2,5}$/u;
/** Slack caps a message at 40 000 characters; alerts are a sentence or two. */
const TEXT_MAX_LENGTH = 3_000;
const LABEL_MAX_LENGTH = 100;
/** Never wait longer than this on a `Retry-After`, whatever the header says. */
const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;
/** Fallback when a 429 has no usable `Retry-After`. */
const RETRY_AFTER_DEFAULT_MS = 60_000;

export interface SlackChatOptions {
  /** Must be the SSRF-guarded fetch built for this adapter (5 s, 64 KiB, 0 redirects). */
  readonly fetch: OutboundFetch;
  readonly now?: (() => Date) | undefined;
}

type ValidUrl = { readonly ok: true; readonly target: string };
type InvalidUrl = { readonly ok: false; readonly reason: string };

/** Parses and pins; answers the canonical request URL, rebuilt from the validated path. */
function parseWebhookUrl(raw: string): ValidUrl | InvalidUrl {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "empty URL" };
  if (raw.length > URL_MAX_LENGTH) return { ok: false, reason: "URL is too long" };
  if (/[\s\\]/u.test(raw)) return { ok: false, reason: "URL contains whitespace or a backslash" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "must be an https URL" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "must not carry credentials" };
  if (url.hostname !== SLACK_WEBHOOK_HOST)
    return { ok: false, reason: `host must be ${SLACK_WEBHOOK_HOST}` };
  if (url.port !== "") return { ok: false, reason: "must use the default port" };
  if (url.search !== "" || url.hash !== "")
    return { ok: false, reason: "must not carry a query or fragment" };
  if (!PATH_RE.test(url.pathname))
    return { ok: false, reason: "not a Slack incoming-webhook path (/services/… or /workflows/…)" };
  return { ok: true, target: `https://${SLACK_WEBHOOK_HOST}${url.pathname}` };
}

/** Slack's mrkdwn treats `&`, `<` and `>` as control characters; everything else is literal. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The link must be an absolute https URL and cannot contain the characters that terminate a
 * `<url|label>` span; otherwise it is dropped rather than rendered half-parsed.
 */
function renderLink(link: ChatMessage["link"]): string | undefined {
  if (link === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const href = url.href;
  if (/[<>|\s]/u.test(href)) return undefined;
  const label = escapeSlackText(truncate(link.label.replace(/[|\n\r]/gu, " "), LABEL_MAX_LENGTH));
  return `<${href}|${label}>`;
}

/** The request body: plain `text`, escaped, with the link as a trailing mrkdwn link. */
export function slackPayload(message: ChatMessage): { text: string } {
  const body = escapeSlackText(truncate(message.text, TEXT_MAX_LENGTH));
  const link = renderLink(message.link);
  return { text: link === undefined ? body : `${body}\n${link}` };
}

/** `Retry-After` as seconds or an HTTP date, clamped to `[0, 1 h]`. */
function retryAfterMs(header: string | null, now: Date): number {
  if (header === null || header.trim() === "") return RETRY_AFTER_DEFAULT_MS;
  const trimmed = header.trim();
  let ms: number;
  if (/^\d+$/u.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return RETRY_AFTER_DEFAULT_MS;
    ms = at - now.getTime();
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
}

function failure(
  reason: ChatPostFailure,
  detail: string,
  retryAfter?: number,
): Extract<ChatPostResult, { ok: false }> {
  return retryAfter === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, retryAfterMs: retryAfter };
}

/**
 * Slack's error bodies are short fixed tokens (`no_service`, `invalid_payload`,
 * `channel_is_archived`); only such a token is echoed, never free text, so nothing the far side
 * or a proxy wrote can carry the URL back into a detail an admin reads.
 */
function slackErrorToken(body: string): string | undefined {
  const token = body.trim();
  return /^[a-z_]{1,64}$/u.test(token) ? token : undefined;
}

/** Status → typed failure (see `ChatPostFailure` for what each tells an admin to do). */
function mapStatus(status: number, token: string | undefined, retryAfter: number) {
  const suffix = token === undefined ? "" : ` (${token})`;
  if (status === 404 || status === 410)
    return failure("not_found", `Slack no longer accepts this webhook${suffix}`);
  if (status === 403) return failure("rejected", `Slack refused the post${suffix}`);
  if (status === 429)
    return failure("rate_limited", `Slack rate-limited the post${suffix}`, retryAfter);
  if (status >= 500) return failure("unavailable", `Slack answered HTTP ${status}${suffix}`);
  if (status >= 300 && status < 400)
    return failure("rejected", `the webhook answered with a redirect (HTTP ${status})`);
  return failure("rejected", `Slack answered HTTP ${status}${suffix}`);
}

export function createSlackChat(options: SlackChatOptions): ChatWebhookPort {
  const now = options.now ?? (() => new Date());
  return {
    driver: "slack",
    validateUrl(url) {
      const parsed = parseWebhookUrl(url);
      return parsed.ok ? { ok: true } : parsed;
    },
    async post(url, message) {
      const parsed = parseWebhookUrl(url);
      if (!parsed.ok)
        return failure("invalid_url", `the webhook URL is not usable: ${parsed.reason}`);
      let response: Response;
      try {
        response = await options.fetch(parsed.target, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(slackPayload(message)),
          redirect: "manual",
        });
      } catch (error) {
        // The guard's own errors carry the URL (`OutboundHttpError.url`) and sometimes quote it in
        // `message`; only the code, which is a fixed vocabulary, is safe to repeat.
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : undefined;
        const safe = code !== undefined && /^[a-z_]{1,40}$/u.test(code) ? ` (${code})` : "";
        if (code === "too_many_redirects")
          return failure("rejected", "the webhook answered with a redirect");
        return failure("unavailable", `could not reach Slack${safe}`);
      }
      let body = "";
      try {
        body = await response.text();
      } catch {
        // A body we could not read changes nothing about the status.
      }
      if (response.status >= 200 && response.status < 300) return { ok: true };
      return mapStatus(
        response.status,
        slackErrorToken(body),
        retryAfterMs(response.headers.get("retry-after"), now()),
      );
    },
  };
}
