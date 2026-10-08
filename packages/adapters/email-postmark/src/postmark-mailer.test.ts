import { createHash } from "node:crypto";
import { MailSuppressedError, type OutboundFetch } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createPostmarkMailer, MailerError } from "./postmark-mailer.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const HOOK = { user: "fundroom", password: "0123456789abcdef-hook" };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: (Response | Error)[]): { fetch: OutboundFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: OutboundFetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK = {
  To: "jane@example.com",
  SubmittedAt: NOW.toISOString(),
  MessageID: "pm-1",
  ErrorCode: 0,
  Message: "OK",
};

function mailer(fetch: OutboundFetch, extra: { broadcastStream?: string; hook?: boolean } = {}) {
  return createPostmarkMailer({
    serverToken: "pm-server-token",
    from: { address: "investors@acme.test", name: "Acme IR" },
    fetch,
    now: () => NOW,
    ...(extra.broadcastStream !== undefined ? { broadcastStream: extra.broadcastStream } : {}),
    ...(extra.hook === true ? { webhookBasicAuth: HOOK } : {}),
  });
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("createPostmarkMailer send", () => {
  it("maps a broadcast message with tracking onto POST /email", async () => {
    const { fetch, calls } = fakeFetch([json(OK)]);
    const sent = await mailer(fetch).send({
      to: "jane@example.com",
      subject: "Q3 update",
      text: "plain",
      html: "<p>html</p>",
      replyTo: "founder@acme.test",
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
      tags: ["updates", "second"],
      idempotencyKey:
        "updates:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002",
      stream: "broadcast",
      tracking: { opens: true, clicks: true },
    });
    expect(sent).toEqual({ messageId: "pm-1", acceptedAt: NOW });
    expect(calls[0]?.url).toBe("https://api.postmarkapp.com/email");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-postmark-server-token"]).toBe("pm-server-token");
    const digest = createHash("sha256")
      .update("updates:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002")
      .digest("hex")
      .slice(0, 32);
    expect(bodyOf(calls[0])).toEqual({
      From: '"Acme IR" <investors@acme.test>',
      To: "jane@example.com",
      Subject: "Q3 update",
      TextBody: "plain",
      HtmlBody: "<p>html</p>",
      ReplyTo: "founder@acme.test",
      Headers: [{ Name: "List-Unsubscribe", Value: "<https://x.test/u>" }],
      Tag: "updates",
      Metadata: { stream: "broadcast", idempotency_key: digest },
      TrackOpens: true,
      TrackLinks: "HtmlAndText",
      MessageStream: "broadcast",
    });
  });

  it("maps stream to MessageStream and turns tracking off explicitly by default", async () => {
    const { fetch, calls } = fakeFetch([json(OK), json(OK), json(OK), json(OK)]);
    const m = mailer(fetch, { broadcastStream: "investor-updates" });
    await m.send({ to: "jane@example.com", subject: "s", text: "t" });
    await m.send({ to: "jane@example.com", subject: "s", text: "t", stream: "transactional" });
    await m.send({
      to: "jane@example.com",
      subject: "s",
      text: "t",
      stream: "notification",
      tracking: { opens: true, clicks: false },
    });
    await m.send({ to: "jane@example.com", subject: "s", text: "t", stream: "broadcast" });
    expect(calls.map((c) => bodyOf(c)["MessageStream"])).toEqual([
      "outbound",
      "outbound",
      "outbound",
      "investor-updates",
    ]);
    expect(calls.map((c) => [bodyOf(c)["TrackOpens"], bodyOf(c)["TrackLinks"]])).toEqual([
      [false, "None"],
      [false, "None"],
      [true, "None"],
      [false, "None"],
    ]);
    expect(bodyOf(calls[0])["Metadata"]).toBeUndefined();
    expect(bodyOf(calls[0])["From"]).toBe('"Acme IR" <investors@acme.test>');
  });

  it("honours a per-message from with the default display name", async () => {
    const { fetch, calls } = fakeFetch([json(OK)]);
    await mailer(fetch).send({
      to: "jane@example.com",
      subject: "s",
      text: "t",
      from: { address: "ir@acme-ventures.test", name: 'Acme "Ventures"' },
    });
    expect(bodyOf(calls[0])["From"]).toBe('"Acme \\"Ventures\\"" <ir@acme-ventures.test>');
  });

  it("maps failures, including a 200 with a non-zero ErrorCode, without quoting the address", async () => {
    const cases: [Response, string, number | undefined][] = [
      [json({ ErrorCode: 10, Message: "bad token" }, 401), "unauthorized", 10],
      [json({ ErrorCode: 300, Message: "jane@example.com invalid" }, 422), "rejected", 300],
      [json({}, 429), "rate_limited", undefined],
      [new Response("oops", { status: 500 }), "connection_failed", undefined],
    ];
    for (const [response, code, providerCode] of cases) {
      const { fetch } = fakeFetch([response]);
      const error = (await mailer(fetch)
        .send({ to: "jane@example.com", subject: "s", text: "t" })
        .catch((e: unknown) => e)) as MailerError;
      expect(error).toBeInstanceOf(MailerError);
      expect(error.code).toBe(code);
      expect(error.providerCode).toBe(providerCode);
      expect(error.message).not.toContain("jane");
    }
    const { fetch } = fakeFetch([new Error("ECONNRESET")]);
    await expect(
      mailer(fetch).send({ to: "jane@example.com", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ code: "connection_failed" });
  });

  it("throws MailSuppressedError('provider') for Postmark's 406 inactive recipient", async () => {
    for (const response of [
      json({ ErrorCode: 406, Message: "jane@example.com inactive" }, 422),
      json({ ErrorCode: 406, Message: "inactive", MessageID: "" }, 200),
    ]) {
      const { fetch } = fakeFetch([response]);
      const error = await mailer(fetch)
        .send({ to: "jane@example.com", subject: "s", text: "t", stream: "broadcast" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailSuppressedError);
      expect(error).toMatchObject({ code: "suppressed", reason: "provider" });
    }
  });

  it("refuses bad options", () => {
    const { fetch } = fakeFetch([]);
    expect(() =>
      createPostmarkMailer({
        serverToken: "t",
        from: { address: "a@b.test" },
        broadcastStream: "Bad Stream",
        fetch,
      }),
    ).toThrow(MailerError);
    expect(() =>
      createPostmarkMailer({
        serverToken: "t",
        from: { address: "a@b.test" },
        webhookBasicAuth: { user: "u", password: "short" },
        fetch,
      }),
    ).toThrow(/16 characters/u);
  });

  it("advertises per-message tracking, and webhooks only with basic auth configured", () => {
    const { fetch } = fakeFetch([]);
    expect(mailer(fetch).capabilities).toEqual({ perMessageTracking: true, webhooks: false });
    expect(mailer(fetch).parseWebhook).toBeUndefined();
    expect(mailer(fetch, { hook: true }).capabilities).toEqual({
      perMessageTracking: true,
      webhooks: true,
    });
  });
});

describe("createPostmarkMailer healthCheck", () => {
  it("probes GET /server with the token", async () => {
    const { fetch, calls } = fakeFetch([
      json({ ID: 1 }),
      json({ ErrorCode: 10 }, 401),
      new Error("x"),
    ]);
    const m = mailer(fetch);
    await expect(m.healthCheck()).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://api.postmarkapp.com/server");
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["x-postmark-server-token"],
    ).toBe("pm-server-token");
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "connection_failed" });
  });
});

describe("createPostmarkMailer parseWebhook", () => {
  const { fetch } = fakeFetch([]);
  const m = mailer(fetch, { hook: true });
  const basic = (user: string, password: string) =>
    `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const post = (body: unknown, authorization: string | null = basic(HOOK.user, HOOK.password)) =>
    m.parseWebhook?.(
      new Request("https://host.test/webhooks/email/postmark", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === null ? {} : { authorization }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("maps Delivery", async () => {
    expect(
      await post({
        RecordType: "Delivery",
        MessageID: "pm-1",
        Recipient: "jane@example.com",
        DeliveredAt: "2026-09-22T11:00:00Z",
        Details: "250 OK",
      }),
    ).toEqual([
      {
        kind: "delivered",
        messageId: "pm-1",
        recipient: "jane@example.com",
        occurredAt: new Date("2026-09-22T11:00:00Z"),
        provider: "postmark",
        reason: "250 OK",
      },
    ]);
  });

  it("maps Bounce types to hard, soft or nothing", async () => {
    const bounce = (Type: string, extra: Record<string, unknown> = {}) =>
      post({
        RecordType: "Bounce",
        MessageID: "pm-1",
        Email: "jane@example.com",
        BouncedAt: "2026-09-22T11:00:00Z",
        Type,
        Description: "The server was unable to deliver",
        ...extra,
      });
    expect((await bounce("HardBounce"))?.[0]).toMatchObject({ kind: "bounce", bounceType: "hard" });
    expect((await bounce("BadEmailAddress"))?.[0]).toMatchObject({ bounceType: "hard" });
    expect((await bounce("SoftBounce"))?.[0]).toMatchObject({ kind: "bounce", bounceType: "soft" });
    expect((await bounce("Transient"))?.[0]).toMatchObject({ bounceType: "soft" });
    expect((await bounce("DnsError", { Inactive: true }))?.[0]).toMatchObject({
      bounceType: "hard",
    });
    expect(await bounce("AutoResponder")).toEqual([]);
    expect((await bounce("SpamComplaint"))?.[0]).toMatchObject({ kind: "complaint" });
  });

  it("maps SpamComplaint", async () => {
    expect(
      (
        await post({
          RecordType: "SpamComplaint",
          MessageID: "pm-1",
          Email: "jane@example.com",
          BouncedAt: "2026-09-22T11:00:00Z",
          Type: "SpamComplaint",
        })
      )?.[0],
    ).toMatchObject({ kind: "complaint", recipient: "jane@example.com", messageId: "pm-1" });
  });

  it("maps Open and Click with user agent and link", async () => {
    const open = await post({
      RecordType: "Open",
      MessageID: "pm-1",
      Recipient: "jane@example.com",
      ReceivedAt: "2026-09-22T11:05:00Z",
      FirstOpen: true,
      UserAgent: "Mozilla/5.0",
      Platform: "Unknown",
    });
    expect(open).toEqual([
      {
        kind: "open",
        messageId: "pm-1",
        recipient: "jane@example.com",
        occurredAt: new Date("2026-09-22T11:05:00Z"),
        provider: "postmark",
        reason: undefined,
        userAgent: "Mozilla/5.0",
      },
    ]);
    expect(open?.[0]?.machine).toBeUndefined();
    const click = await post({
      RecordType: "Click",
      MessageID: "pm-1",
      Recipient: "jane@example.com",
      ReceivedAt: "2026-09-22T11:06:00Z",
      OriginalLink: "https://acme.test/deck?x=1",
      UserAgent: "Mozilla/5.0 Chrome/140",
    });
    expect(click?.[0]).toMatchObject({
      kind: "click",
      url: "https://acme.test/deck?x=1",
      userAgent: "Mozilla/5.0 Chrome/140",
    });
  });

  it("maps a SubscriptionChange that suppresses sending to a provider-suppression hard bounce", async () => {
    const change = {
      RecordType: "SubscriptionChange",
      MessageID: "pm-1",
      MessageStream: "broadcast",
      ChangedAt: "2026-09-22T11:10:00Z",
      Recipient: "jane@example.com",
      Origin: "Recipient",
      SuppressSending: true,
      SuppressionReason: "ManualSuppression",
    };
    expect(await post(change)).toEqual([
      {
        kind: "bounce",
        bounceType: "hard",
        messageId: "pm-1",
        recipient: "jane@example.com",
        occurredAt: new Date("2026-09-22T11:10:00Z"),
        provider: "postmark",
        reason: "provider_suppressed:ManualSuppression",
      },
    ]);
    // Reactivation is not mirrored.
    expect(await post({ ...change, SuppressSending: false })).toEqual([]);
  });

  it("skips unknown record types and malformed bodies once authenticated", async () => {
    expect(await post({ RecordType: "SubscriptionChange", MessageID: "pm-1" })).toEqual([]);
    expect(await post({ RecordType: "Inbound", MessageID: "pm-1" })).toEqual([]);
    expect(await post("{not json")).toEqual([]);
  });

  it("rejects a missing header, a wrong password, a wrong user and another scheme", async () => {
    const body = { RecordType: "Delivery", MessageID: "pm-1", Recipient: "jane@example.com" };
    expect(await post(body, null)).toBeUndefined();
    expect(await post(body, basic(HOOK.user, `${HOOK.password}x`))).toBeUndefined();
    expect(await post(body, basic("admin", HOOK.password))).toBeUndefined();
    expect(await post(body, `Bearer ${HOOK.password}`)).toBeUndefined();
    expect(await post(body)).toHaveLength(1);
  });
});
