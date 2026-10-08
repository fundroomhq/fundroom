import type { OutboundFetch } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createSlackChat, escapeSlackText, slackPayload } from "./chat-slack.js";

const SECRET = "xoxSECRETtoken0123456789";
const URL_OK = `https://hooks.slack.com/services/T0001/B0002/${SECRET}`;
const NOW = new Date("2026-09-22T12:00:00.000Z");

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetch: OutboundFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: OutboundFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { fetch, calls };
}

function chatWith(respond: () => Response | Promise<Response>) {
  const f = fakeFetch(respond);
  return { chat: createSlackChat({ fetch: f.fetch, now: () => NOW }), calls: f.calls };
}

describe("validateUrl: host pinning", () => {
  const { chat } = chatWith(() => new Response("ok"));
  it.each([
    URL_OK,
    "https://hooks.slack.com/workflows/T0001/A0002/123456/abcdef",
    "https://HOOKS.SLACK.COM/services/T0001/B0002/abc",
    "https://hooks.slack.com:443/services/T0001/B0002/abc",
  ])("accepts %s", (url) => {
    expect(chat.validateUrl(url)).toEqual({ ok: true });
  });

  it.each([
    ["http scheme", "http://hooks.slack.com/services/T/B/x"],
    ["other host", "https://evil.example.com/services/T/B/x"],
    ["suffix trick", "https://hooks.slack.com.evil.example/services/T/B/x"],
    ["prefix trick", "https://evilhooks.slack.com/services/T/B/x"],
    ["subdomain", "https://a.hooks.slack.com/services/T/B/x"],
    ["userinfo", "https://user:pw@hooks.slack.com/services/T/B/x"],
    ["userinfo host confusion", "https://hooks.slack.com@evil.example/services/T/B/x"],
    ["non-default port", "https://hooks.slack.com:8443/services/T/B/x"],
    ["query", "https://hooks.slack.com/services/T/B/x?next=https://evil.example"],
    ["fragment", "https://hooks.slack.com/services/T/B/x#frag"],
    ["api path", "https://hooks.slack.com/api/chat.postMessage"],
    ["dot segments", "https://hooks.slack.com/services/T/../../api/x"],
    ["encoded slash", "https://hooks.slack.com/services/T/B%2F..%2Fx/y"],
    ["single segment", "https://hooks.slack.com/services/T"],
    ["backslash", "https://hooks.slack.com\\@evil.example/services/T/B/x"],
    ["ip literal", "https://52.1.2.3/services/T/B/x"],
    ["not a url", "hooks.slack.com/services/T/B/x"],
    ["empty", ""],
    ["too long", `https://hooks.slack.com/services/T/B/${"a".repeat(600)}`],
  ])("refuses %s", (_label, url) => {
    const result = chat.validateUrl(url);
    expect(result.ok).toBe(false);
  });
});

describe("post", () => {
  it("posts JSON to the rebuilt URL with no redirects", async () => {
    const { chat, calls } = chatWith(() => new Response("ok", { status: 200 }));
    const result = await chat.post("https://HOOKS.slack.com:443/services/T0001/B0002/abc", {
      text: "Hot lead: <b>Ada</b> & co",
      link: { url: "https://acme.example/admin/crm/1", label: "Open | now" },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T0001/B0002/abc");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    const body = JSON.parse(String(calls[0]?.init?.body)) as { text: string };
    expect(body.text).toBe(
      "Hot lead: &lt;b&gt;Ada&lt;/b&gt; &amp; co\n<https://acme.example/admin/crm/1|Open   now>",
    );
  });

  it("never fetches an invalid URL", async () => {
    const { chat, calls } = chatWith(() => new Response("ok"));
    const result = await chat.post("https://evil.example/services/T/B/x", { text: "hi" });
    expect(result).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [404, "no_service", "not_found"],
    [410, "channel_is_archived", "not_found"],
    [403, "action_prohibited", "rejected"],
    [400, "invalid_payload", "rejected"],
    [302, "", "rejected"],
    [500, "", "unavailable"],
    [503, "", "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, body, reason) => {
    const { chat } = chatWith(
      () =>
        new Response(body === "" ? null : body, {
          status,
          headers: status === 302 ? { location: "https://evil.example/" } : {},
        }),
    );
    const result = await chat.post(URL_OK, { text: "x" });
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok) expect(result.detail).not.toContain(SECRET);
  });

  it("maps 429 with Retry-After seconds", async () => {
    const { chat } = chatWith(
      () => new Response("rate_limited", { status: 429, headers: { "retry-after": "30" } }),
    );
    expect(await chat.post(URL_OK, { text: "x" })).toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("maps 429 with an HTTP-date Retry-After and clamps huge values", async () => {
    const at = new Date(NOW.getTime() + 5_000).toUTCString();
    const a = chatWith(() => new Response(null, { status: 429, headers: { "retry-after": at } }));
    expect(await a.chat.post(URL_OK, { text: "x" })).toMatchObject({ retryAfterMs: 5_000 });
    const b = chatWith(
      () => new Response(null, { status: 429, headers: { "retry-after": "999999" } }),
    );
    expect(await b.chat.post(URL_OK, { text: "x" })).toMatchObject({ retryAfterMs: 3_600_000 });
    const c = chatWith(() => new Response(null, { status: 429 }));
    expect(await c.chat.post(URL_OK, { text: "x" })).toMatchObject({ retryAfterMs: 60_000 });
  });

  it("maps transport errors to unavailable without quoting the URL", async () => {
    const { chat } = chatWith(() => {
      const error = Object.assign(new Error(`connect ECONNREFUSED for ${URL_OK}`), {
        code: "timeout",
        url: URL_OK,
      });
      throw error;
    });
    const result = await chat.post(URL_OK, { text: "x" });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("hooks.slack.com");
  });

  it("treats the guard's redirect refusal as rejected", async () => {
    const { chat } = chatWith(() => {
      throw Object.assign(new Error(`redirect from ${URL_OK}`), { code: "too_many_redirects" });
    });
    const result = await chat.post(URL_OK, { text: "x" });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("never echoes a free-text body that could carry the URL", async () => {
    const { chat } = chatWith(() => new Response(`error at ${URL_OK}`, { status: 400 }));
    const result = await chat.post(URL_OK, { text: "x" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("hooks.slack.com");
  });
});

describe("payload", () => {
  it("escapes Slack control characters", () => {
    expect(escapeSlackText("<!channel> & <@U1>")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt;");
  });

  it("drops a non-https or malformed link", () => {
    expect(slackPayload({ text: "a", link: { url: "javascript:alert(1)", label: "x" } })).toEqual({
      text: "a",
    });
    expect(slackPayload({ text: "a", link: { url: "http://x.example/", label: "x" } })).toEqual({
      text: "a",
    });
  });

  it("truncates long text", () => {
    expect(slackPayload({ text: "a".repeat(5_000) }).text.length).toBe(3_000);
  });
});
