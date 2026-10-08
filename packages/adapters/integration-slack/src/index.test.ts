import { OutboundHttpError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_MAX_PAGES,
  createSlackAdapter,
  escapeSlackText,
  mapSlackError,
  slackMeta,
} from "./index.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const AUTH = {
  accessToken: "xoxb-secret-token",
  externalAccountId: "T123",
  environment: "production" as const,
};
const CLIENT = {
  clientId: "111.222",
  clientSecret: "shh-client-secret",
  environment: "production" as const,
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestInit["redirect"];
}

type Reply = Response | (() => Response) | Error;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(replies: Reply[] | ((seen: Seen) => Reply)) {
  const seen: Seen[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const s: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect,
    };
    seen.push(s);
    const next = queue !== undefined ? queue.shift() : (replies as (seen: Seen) => Reply)(s);
    if (next === undefined) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch, seen };
}

function adapter(replies: Reply[] | ((seen: Seen) => Reply), options = {}) {
  const f = fakeFetch(replies);
  const logs: string[] = [];
  const a = createSlackAdapter(
    { fetch: f.fetch, now: () => NOW, log: (e) => void logs.push(e) },
    options,
  );
  return { a, seen: f.seen, logs };
}

describe("slackMeta", () => {
  it("describes an OAuth v2 bot install without PKCE", () => {
    expect(slackMeta.provider).toBe("slack");
    expect(slackMeta.auth).toBe("oauth2");
    expect(slackMeta.capabilities).toEqual(["chat"]);
    expect(slackMeta.oauth).toEqual({
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      revokeUrl: "https://slack.com/api/auth.revoke",
      scopes: ["chat:write", "chat:write.public", "channels:read"],
      pkce: false,
      scopeSeparator: ",",
    });
    expect(slackMeta.scopeExplanation.length).toBeGreaterThan(0);
    expect(slackMeta.subProcessor.dpaUrl).toMatch(/^https:\/\//u);
  });

  it("keeps the shared meta by default and rebases URLs only through the test seam", () => {
    expect(adapter([]).a.meta).toBe(slackMeta);
    const { a } = adapter([], {
      apiBaseUrl: "http://slack.test/api/",
      authBaseUrl: "http://slack.test",
    });
    expect(a.meta.oauth?.authorizeUrl).toBe("http://slack.test/oauth/v2/authorize");
    expect(a.meta.oauth?.tokenUrl).toBe("http://slack.test/api/oauth.v2.access");
    expect(slackMeta.oauth?.authorizeUrl).toBe("https://slack.com/oauth/v2/authorize");
  });
});

describe("exchangeCode / refresh / revoke", () => {
  it("exchanges the code with HTTP Basic client auth and maps the bot token set", async () => {
    const { a, seen } = adapter([
      json({
        ok: true,
        access_token: "xoxb-new",
        token_type: "bot",
        scope: "chat:write,chat:write.public,channels:read",
        bot_user_id: "U0BOT",
        app_id: "A0APP",
        team: { id: "T9", name: "Acme" },
        enterprise: null,
      }),
    ]);
    const res = await a.exchangeCode?.({
      code: "the-code",
      redirectUri: "https://seed.example/oauth/integrations/callback",
      codeVerifier: null,
      query: {},
      client: CLIENT,
    });
    expect(res).toEqual({
      ok: true,
      value: {
        accessToken: "xoxb-new",
        refreshToken: null,
        expiresAt: null,
        scope: "chat:write,chat:write.public,channels:read",
        externalAccountId: "T9",
        extra: { teamName: "Acme", botUserId: "U0BOT", appId: "A0APP" },
      },
    });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req?.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(req?.method).toBe("POST");
    expect(req?.redirect).toBe("manual");
    expect(req?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("111.222:shh-client-secret").toString("base64")}`,
    );
    const form = new URLSearchParams(req?.body);
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe("https://seed.example/oauth/integrations/callback");
    expect(form.get("client_secret")).toBeNull();
  });

  it("handles token rotation fields when present", async () => {
    const { a, seen } = adapter([
      json({
        ok: true,
        access_token: "xoxe.xoxb-1-rotated",
        token_type: "bot",
        refresh_token: "xoxe-1-refresh",
        expires_in: 43200,
        team: { id: "T9", name: "Acme" },
      }),
    ]);
    const res = await a.refresh?.({ refreshToken: "xoxe-1-old", client: CLIENT });
    expect(res?.ok).toBe(true);
    if (res?.ok !== true) return;
    expect(res.value.refreshToken).toBe("xoxe-1-refresh");
    expect(res.value.expiresAt?.toISOString()).toBe("2026-09-27T00:00:00.000Z");
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("xoxe-1-old");
  });

  it("maps a rejected refresh to unauthorized (invalid_grant → reauth)", async () => {
    const { a } = adapter([json({ ok: false, error: "invalid_refresh_token" })]);
    expect(await a.refresh?.({ refreshToken: "x", client: CLIENT })).toEqual({
      ok: false,
      reason: "unauthorized",
      detail: "invalid_refresh_token",
    });
  });

  it("refuses a user token and an answer without access_token", async () => {
    const user = adapter([json({ ok: true, access_token: "xoxp-1", token_type: "user" })]);
    expect(
      (
        await user.a.exchangeCode?.({
          code: "c",
          redirectUri: "r",
          codeVerifier: null,
          query: {},
          client: CLIENT,
        })
      )?.ok,
    ).toBe(false);
    const none = adapter([json({ ok: true, token_type: "bot" })]);
    expect(
      await none.a.exchangeCode?.({
        code: "c",
        redirectUri: "r",
        codeVerifier: null,
        query: {},
        client: CLIENT,
      }),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("maps a bad code to unauthorized without echoing secrets", async () => {
    const { a } = adapter([json({ ok: false, error: "invalid_code" })]);
    const res = await a.exchangeCode?.({
      code: "c",
      redirectUri: "r",
      codeVerifier: null,
      query: {},
      client: CLIENT,
    });
    expect(res).toEqual({ ok: false, reason: "unauthorized", detail: "invalid_code" });
    expect(JSON.stringify(res)).not.toContain("shh-client-secret");
  });

  it("revokes with the bearer token and never throws", async () => {
    const ok = adapter([json({ ok: true, revoked: true })]);
    await ok.a.revoke?.({ token: "xoxb-old", client: CLIENT });
    expect(ok.seen[0]?.url).toBe("https://slack.com/api/auth.revoke");
    expect(ok.seen[0]?.headers["authorization"]).toBe("Bearer xoxb-old");
    const broken = adapter([new Error("boom")]);
    await expect(broken.a.revoke?.({ token: "t", client: null })).resolves.toBeUndefined();
    expect(broken.logs).toEqual(["integration.slack.revoke_failed"]);
  });
});

describe("verify", () => {
  it("uses auth.test: team name as label, team id as account", async () => {
    const { a, seen } = adapter([
      json({
        ok: true,
        url: "https://acme.slack.com/",
        team: "Acme",
        team_id: "T9",
        user_id: "U0BOT",
        bot_id: "B1",
      }),
    ]);
    expect(await a.verify(AUTH)).toEqual({
      ok: true,
      value: { accountLabel: "Acme", externalAccountId: "T9" },
    });
    expect(seen[0]?.url).toBe("https://slack.com/api/auth.test");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer xoxb-secret-token");
  });

  it.each([
    ["invalid_auth", "unauthorized"],
    ["token_revoked", "unauthorized"],
    ["account_inactive", "unauthorized"],
    ["not_authed", "unauthorized"],
    ["missing_scope", "forbidden"],
  ])("maps %s → %s", async (error, reason) => {
    const { a } = adapter([json({ ok: false, error })]);
    expect(await a.verify(AUTH)).toEqual({ ok: false, reason, detail: error });
  });

  it("refuses an answer without team_id", async () => {
    const { a } = adapter([json({ ok: true, team: "Acme" })]);
    expect(await a.verify(AUTH)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("HTTP-level failures", () => {
  it.each([
    [
      json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "30" }),
      "rate_limited",
      "retry after 30s",
    ],
    [new Response("x", { status: 503 }), "unavailable", "HTTP 503"],
    [
      new Response("", { status: 302, headers: { location: "https://evil.example" } }),
      "malformed",
      undefined,
    ],
    [new Response("<html>", { status: 200 }), "malformed", undefined],
    [json({ channels: [] }), "malformed", undefined],
    [new Response("", { status: 401 }), "unauthorized", "HTTP 401"],
  ])("response %# → %s", async (reply, reason, detail) => {
    const { a } = adapter([reply as Response]);
    const res = await a.verify(AUTH);
    expect(res).toMatchObject({ ok: false, reason });
    if (detail !== undefined) expect(res).toMatchObject({ detail });
  });

  it("maps guard errors and a thrown fetch", async () => {
    expect(
      await adapter([
        new OutboundHttpError("response_too_large", "too big https://slack.com/api/x?token=1"),
      ]).a.verify(AUTH),
    ).toEqual({ ok: false, reason: "too_large", detail: "response too large" });
    const t = await adapter([new OutboundHttpError("timeout", "timed out")]).a.verify(AUTH);
    expect(t).toEqual({
      ok: false,
      reason: "transport",
      detail: "could not reach the vendor (timeout)",
    });
    const r = await adapter([new OutboundHttpError("too_many_redirects", "x")]).a.verify(AUTH);
    expect(r).toMatchObject({ reason: "malformed" });
    expect(await adapter([new TypeError("fetch failed")]).a.verify(AUTH)).toMatchObject({
      reason: "transport",
    });
  });

  it("refuses a body over 2 MiB even when the transport does not cap it", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    expect(await adapter([new Response(big)]).a.verify(AUTH)).toMatchObject({
      reason: "too_large",
    });
  });
});

describe("mapSlackError", () => {
  it.each([
    ["channel_not_found", "not_found"],
    ["is_archived", "not_found"],
    ["ratelimited", "rate_limited"],
    ["not_in_channel", "forbidden"],
    ["internal_error", "unavailable"],
    ["msg_too_long", "malformed"],
  ])("%s → %s", (error, reason) => {
    expect(mapSlackError(error)).toEqual({ ok: false, reason, detail: error });
  });

  it("never echoes a free-text error", () => {
    expect(mapSlackError("Token xoxb-123 is bad")).toEqual({
      ok: false,
      reason: "malformed",
      detail: "Slack refused the request",
    });
    expect(mapSlackError(undefined)).toMatchObject({ reason: "malformed" });
  });
});

describe("chat.listChannels", () => {
  it("pages with the cursor, asks for public non-archived channels and sorts by name", async () => {
    const { a, seen } = adapter([
      json({
        ok: true,
        channels: [
          { id: "C2", name: "zeta", is_private: false },
          { id: "C3", name: "old", is_archived: true },
        ],
        response_metadata: { next_cursor: "dGVhbTpDMDYx" },
      }),
      json({
        ok: true,
        channels: [{ id: "C1", name: "alpha", is_private: false }, { id: 7 }, "junk"],
        response_metadata: { next_cursor: "" },
      }),
    ]);
    expect(await a.chat?.listChannels(AUTH)).toEqual({
      ok: true,
      value: [
        { id: "C1", name: "alpha", isPrivate: false },
        { id: "C2", name: "zeta", isPrivate: false },
      ],
    });
    expect(seen.map((s) => s.url)).toEqual([
      "https://slack.com/api/conversations.list",
      "https://slack.com/api/conversations.list",
    ]);
    const first = new URLSearchParams(seen[0]?.body);
    expect(first.get("types")).toBe("public_channel");
    expect(first.get("exclude_archived")).toBe("true");
    expect(first.get("limit")).toBe("200");
    expect(first.get("cursor")).toBeNull();
    expect(new URLSearchParams(seen[1]?.body).get("cursor")).toBe("dGVhbTpDMDYx");
  });

  it("stops at 50 pages with too_large", async () => {
    let n = 0;
    const { a, seen } = adapter(() =>
      json({
        ok: true,
        channels: [{ id: `C${n}`, name: `c${n++}` }],
        response_metadata: { next_cursor: "more" },
      }),
    );
    expect(await a.chat?.listChannels(AUTH)).toMatchObject({ ok: false, reason: "too_large" });
    expect(seen).toHaveLength(CHANNEL_MAX_PAGES);
  });

  it("surfaces a mid-pagination failure", async () => {
    const { a } = adapter([
      json({ ok: true, channels: [], response_metadata: { next_cursor: "x" } }),
      json({ ok: false, error: "ratelimited" }),
    ]);
    expect(await a.chat?.listChannels(AUTH)).toEqual({
      ok: false,
      reason: "rate_limited",
      detail: "ratelimited",
    });
  });

  it("refuses an answer without channels", async () => {
    const { a } = adapter([json({ ok: true })]);
    expect(await a.chat?.listChannels(AUTH)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("chat.post", () => {
  it("posts escaped text as JSON with unfurls off", async () => {
    const { a, seen } = adapter([json({ ok: true, channel: "C1", ts: "1.2" })]);
    expect(
      await a.chat?.post(AUTH, "C1", { text: "Q3 <b>&</b> <!channel> <https://x|y>" }),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    expect(seen[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(seen[0]?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer xoxb-secret-token");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      channel: "C1",
      text: "Q3 &lt;b&gt;&amp;&lt;/b&gt; &lt;!channel&gt; &lt;https://x|y&gt;",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("passes blocks through and truncates long text", async () => {
    const { a, seen } = adapter([json({ ok: true })]);
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    await a.chat?.post(AUTH, "C1", { text: "a".repeat(5000), blocks });
    const body = JSON.parse(seen[0]?.body ?? "") as { text: string; blocks: unknown };
    expect(body.blocks).toEqual(blocks);
    expect(body.text).toHaveLength(4000);
    expect(body.text.endsWith("…")).toBe(true);
  });

  it("refuses more than 50 blocks and a malformed channel id without calling Slack", async () => {
    const { a, seen } = adapter([]);
    expect(
      await a.chat?.post(AUTH, "C1", { text: "x", blocks: Array.from({ length: 51 }, () => ({})) }),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(await a.chat?.post(AUTH, "../auth.revoke", { text: "x" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(seen).toHaveLength(0);
  });

  it.each([
    ["channel_not_found", "not_found"],
    ["is_archived", "not_found"],
    ["token_revoked", "unauthorized"],
    ["missing_scope", "forbidden"],
    ["ratelimited", "rate_limited"],
  ])("maps %s → %s", async (error, reason) => {
    const { a } = adapter([json({ ok: false, error })]);
    expect(await a.chat?.post(AUTH, "C1", { text: "x" })).toEqual({
      ok: false,
      reason,
      detail: error,
    });
  });
});

describe("escapeSlackText", () => {
  it("escapes only the three control characters, & first", () => {
    expect(escapeSlackText("a & b < c > d &amp;")).toBe("a &amp; b &lt; c &gt; d &amp;amp;");
    expect(escapeSlackText("*bold* _it_ `code`")).toBe("*bold* _it_ `code`");
  });
});

describe("secrets never leak into failures", () => {
  it("keeps the bearer token out of every failure detail", async () => {
    const replies: Reply[] = [
      json({ ok: false, error: "invalid_auth" }),
      new Response("xoxb-secret-token", { status: 500 }),
      new OutboundHttpError("timeout", "https://slack.com/api/auth.test xoxb-secret-token"),
    ];
    for (const r of replies) {
      const res = await adapter([r]).a.verify(AUTH);
      expect(JSON.stringify(res)).not.toContain("xoxb-secret-token");
    }
  });
});
