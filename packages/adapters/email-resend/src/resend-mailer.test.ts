import { createHmac, randomBytes } from "node:crypto";
import type { OutboundFetch } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createResendMailer, MailerError, parseResendEvent } from "./resend-mailer.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

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

function mailer(fetch: OutboundFetch, extra: { webhookSecret?: string; log?: never } = {}) {
  return createResendMailer({
    apiKey: "re_test_key_123",
    from: { address: "investors@acme.test", name: "Acme IR" },
    fetch,
    now: () => NOW,
    ...extra,
  });
}

function sign(body: string, opts: { id?: string; ts?: number; key?: Buffer } = {}) {
  const id = opts.id ?? "msg_2abc";
  const ts = String(opts.ts ?? Math.floor(NOW.getTime() / 1000));
  const sig = createHmac("sha256", opts.key ?? SECRET_BYTES)
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

function webhook(body: string, headers: Record<string, string>): Request {
  return new Request("https://host.test/webhooks/email/resend", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const base = {
  created_at: "2026-09-22T11:59:00.000Z",
  data: {
    created_at: "2026-09-22T11:58:00.000Z",
    email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    from: "Acme <investors@acme.test>",
    to: ["jane@example.com"],
    subject: "Q3 update",
  },
};

describe("createResendMailer send", () => {
  it("maps a message onto POST /emails with bearer auth, idempotency key and tags", async () => {
    const { fetch, calls } = fakeFetch([json({ id: "re-id-1" })]);
    const sent = await mailer(fetch).send({
      to: "jane@example.com",
      subject: "Q3 update",
      text: "plain",
      html: "<p>html</p>",
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
      tags: ["updates", "post send"],
      idempotencyKey: "updates:s1:r1",
      stream: "broadcast",
      tracking: { opens: true, clicks: true },
    });
    expect(sent).toEqual({ messageId: "re-id-1", acceptedAt: NOW });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer re_test_key_123");
    expect(headers["idempotency-key"]).toBe("updates:s1:r1");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: '"Acme IR" <investors@acme.test>',
      to: ["jane@example.com"],
      subject: "Q3 update",
      text: "plain",
      html: "<p>html</p>",
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
      tags: [
        { name: "updates", value: "1" },
        { name: "post_send", value: "1" },
        { name: "stream", value: "broadcast" },
      ],
    });
  });

  it("omits the idempotency header when the message has no key and honours from/replyTo overrides", async () => {
    const { fetch, calls } = fakeFetch([json({ id: "re-id-2" })]);
    await mailer(fetch).send({
      to: "jane@example.com",
      subject: "s",
      text: "t",
      from: { address: "ir@acme-ventures.test" },
      replyTo: "founder@acme.test",
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["from"]).toBe('"Acme IR" <ir@acme-ventures.test>');
    expect(body["reply_to"]).toBe("founder@acme.test");
    expect(body["tags"]).toBeUndefined();
  });

  it("maps provider failures to typed errors without quoting the provider's message", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [422, "rejected"],
      [409, "rejected"],
      [429, "rate_limited"],
      [503, "connection_failed"],
    ];
    for (const [status, code] of cases) {
      const { fetch } = fakeFetch([
        json({ name: "validation_error", message: "jane@example.com is bad" }, status),
      ]);
      const error = await mailer(fetch)
        .send({ to: "jane@example.com", subject: "s", text: "t" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailerError);
      expect((error as MailerError).code).toBe(code);
      expect((error as MailerError).status).toBe(status);
      expect((error as MailerError).message).not.toContain("jane");
    }
    const { fetch } = fakeFetch([new Error("ECONNRESET")]);
    const error = await mailer(fetch)
      .send({ to: "jane@example.com", subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect((error as MailerError).code).toBe("connection_failed");
    expect((error as MailerError).retryable).toBe(true);
  });

  it("never logs the full address or the API key", async () => {
    const lines: string[] = [];
    const { fetch } = fakeFetch([json({ id: "x" })]);
    const m = createResendMailer({
      apiKey: "re_secret_value",
      from: { address: "investors@acme.test" },
      fetch,
      log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields)}`),
    });
    await m.send({ to: "jane@example.com", subject: "s", text: "t" });
    expect(lines.join("\n")).toContain("j***@example.com");
    expect(lines.join("\n")).not.toContain("jane@");
    expect(lines.join("\n")).not.toContain("re_secret_value");
  });

  it("refuses bad options and recipients", async () => {
    const { fetch } = fakeFetch([]);
    expect(() => createResendMailer({ apiKey: "k", from: { address: "nope" }, fetch })).toThrow(
      MailerError,
    );
    expect(() =>
      createResendMailer({
        apiKey: "k",
        from: { address: "a@b.test" },
        webhookSecret: "whsec_c2hvcnQ=",
        fetch,
      }),
    ).toThrow(/whsec_/u);
    await expect(
      mailer(fetch).send({ to: "not-an-address", subject: "s", text: "t" }),
    ).rejects.toThrow(MailerError);
  });

  it("advertises no per-message tracking, and webhooks only with a secret", () => {
    const { fetch } = fakeFetch([]);
    expect(mailer(fetch).capabilities).toEqual({ perMessageTracking: false, webhooks: false });
    expect(mailer(fetch).parseWebhook).toBeUndefined();
    const withSecret = mailer(fetch, { webhookSecret: SECRET });
    expect(withSecret.capabilities).toEqual({ perMessageTracking: false, webhooks: true });
    expect(withSecret.parseWebhook).toBeTypeOf("function");
  });
});

describe("createResendMailer healthCheck", () => {
  it("passes on 200 and on a sending-only (restricted) key", async () => {
    const { fetch, calls } = fakeFetch([
      json({ data: [] }),
      json({ name: "restricted_api_key", message: "restricted" }, 401),
    ]);
    const m = mailer(fetch);
    await expect(m.healthCheck()).resolves.toBeUndefined();
    await expect(m.healthCheck()).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://api.resend.com/domains");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer re_test_key_123",
    );
  });

  it("fails on an invalid key and on transport errors", async () => {
    const { fetch } = fakeFetch([
      json({ name: "validation_error", message: "API key is invalid" }, 401),
      new Error("down"),
    ]);
    const m = mailer(fetch);
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "connection_failed" });
  });
});

describe("createResendMailer parseWebhook", () => {
  const { fetch } = fakeFetch([]);
  const m = mailer(fetch, { webhookSecret: SECRET });
  const parse = (body: string, headers: Record<string, string>) =>
    m.parseWebhook?.(webhook(body, headers));

  it("maps every event kind", async () => {
    const delivered = JSON.stringify({ ...base, type: "email.delivered" });
    expect(await parse(delivered, sign(delivered))).toEqual([
      {
        kind: "delivered",
        recipient: "jane@example.com",
        messageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
        occurredAt: new Date("2026-09-22T11:59:00.000Z"),
        provider: "resend",
        reason: undefined,
      },
    ]);

    const kinds: [string, string][] = [
      ["email.delivery_delayed", "delay"],
      ["email.complained", "complaint"],
      ["email.opened", "open"],
    ];
    for (const [type, kind] of kinds) {
      const body = JSON.stringify({ ...base, type });
      const events = await parse(body, sign(body));
      expect(events?.[0]?.kind, type).toBe(kind);
      expect(events?.[0]?.userAgent).toBeUndefined();
      expect(events?.[0]?.machine).toBeUndefined();
    }

    const hard = JSON.stringify({
      ...base,
      type: "email.bounced",
      data: {
        ...base.data,
        bounce: { type: "Permanent", subType: "General", message: "550 5.1.1" },
      },
    });
    expect((await parse(hard, sign(hard)))?.[0]).toMatchObject({
      kind: "bounce",
      bounceType: "hard",
      reason: "550 5.1.1",
    });
    const soft = JSON.stringify({
      ...base,
      type: "email.bounced",
      data: { ...base.data, bounce: { type: "Transient", subType: "MailboxFull" } },
    });
    expect((await parse(soft, sign(soft)))?.[0]).toMatchObject({
      kind: "bounce",
      bounceType: "soft",
      reason: "MailboxFull",
    });

    const suppressed = JSON.stringify({
      ...base,
      type: "email.suppressed",
      data: {
        ...base.data,
        suppressed: {
          message: "Resend has suppressed sending to this address",
          type: "OnAccountSuppressionList",
        },
      },
    });
    expect((await parse(suppressed, sign(suppressed)))?.[0]).toMatchObject({
      kind: "bounce",
      bounceType: "hard",
      reason: "provider_suppressed:OnAccountSuppressionList",
    });

    const click = JSON.stringify({
      ...base,
      type: "email.clicked",
      data: {
        ...base.data,
        click: {
          ipAddress: "203.0.113.9",
          link: "https://acme.test/deck?t=1",
          timestamp: "2026-09-22T11:59:30.000Z",
          userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
        },
      },
    });
    expect((await parse(click, sign(click)))?.[0]).toMatchObject({
      kind: "click",
      url: "https://acme.test/deck?t=1",
      userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
      occurredAt: new Date("2026-09-22T11:59:30.000Z"),
    });
  });

  it("skips unknown types and unparseable bodies once the signature holds", async () => {
    const sent = JSON.stringify({ ...base, type: "email.sent" });
    expect(await parse(sent, sign(sent))).toEqual([]);
    expect(await parse("not json", sign("not json"))).toEqual([]);
    const noRecipient = JSON.stringify({ type: "email.delivered", data: { email_id: "x" } });
    expect(await parse(noRecipient, sign(noRecipient))).toEqual([]);
  });

  it("accepts any matching entry in a rotated signature list", async () => {
    const body = JSON.stringify({ ...base, type: "email.delivered" });
    const good = sign(body);
    const headers = { ...good, "svix-signature": `v1,AAAA ${good["svix-signature"]}` };
    expect(await parse(body, headers)).toHaveLength(1);
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ ...base, type: "email.delivered" });
    const tampered = body.replace("jane@example.com", "eve@example.com");
    expect(await parse(tampered, sign(body))).toBeUndefined();
  });

  it("rejects a signature made with a different secret", async () => {
    const body = JSON.stringify({ ...base, type: "email.delivered" });
    expect(await parse(body, sign(body, { key: randomBytes(24) }))).toBeUndefined();
  });

  it("rejects a stale or future timestamp even with a valid signature", async () => {
    const body = JSON.stringify({ ...base, type: "email.delivered" });
    const t = Math.floor(NOW.getTime() / 1000);
    expect(await parse(body, sign(body, { ts: t - 301 }))).toBeUndefined();
    expect(await parse(body, sign(body, { ts: t + 301 }))).toBeUndefined();
    expect(await parse(body, sign(body, { ts: t - 299 }))).toHaveLength(1);
  });

  it("rejects missing headers, a non-v1 scheme and a signature over a different id", async () => {
    const body = JSON.stringify({ ...base, type: "email.delivered" });
    const good = sign(body);
    expect(await parse(body, {})).toBeUndefined();
    expect(
      await parse(body, {
        ...good,
        "svix-signature": good["svix-signature"].replace("v1,", "v2,"),
      }),
    ).toBeUndefined();
    expect(await parse(body, { ...good, "svix-id": "msg_other" })).toBeUndefined();
  });
});

describe("parseResendEvent", () => {
  it("falls back to now when created_at is missing", () => {
    const e = parseResendEvent({ type: "email.delivered", data: base.data }, NOW);
    expect(e?.occurredAt).toEqual(NOW);
  });
});
