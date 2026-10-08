import { createSign, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import type { OutboundFetch } from "@fundroom/ports";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSesMailer,
  formatAddress,
  MailerError,
  type SesMailerOptions,
} from "./ses-mailer.js";
import { signRequest } from "./sigv4.js";
import { type SnsMessage, stringToSign } from "./sns.js";

/*
 * The SNS signing certificate is minted here, in-process, with node:crypto alone (a self-signed
 * RSA certificate valid for a day, DER-encoded by `selfSignedCert` below) and never committed:
 * no `openssl` binary on the test host, and no private key in the tree for secret scanners to
 * flag. The adapter only ever fetches it from the pinned `https://sns.<region>.amazonaws.com/…pem`
 * URL, which the fake fetch below answers.
 */

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const REGION = "eu-west-1";
const TOPIC = "arn:aws:sns:eu-west-1:123456789012:fundroom-ses";
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem`;
const SUBSCRIBE_URL = `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=tok`;

let keyPem = "";
let certPem = "";
let otherKeyPem = "";

/** DER TLV with a definite length (short or long form). */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const lengthBytes: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) lengthBytes.unshift(n % 256);
  const length = body.length < 0x80 ? [body.length] : [0x80 | lengthBytes.length, ...lengthBytes];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const group = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128))
      group.unshift(0x80 | (v & 0x7f));
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
}

/** RFC 5280 UTCTime (`YYMMDDHHMMSSZ`), which covers every date these tests use. */
function utcTime(at: Date): Buffer {
  return der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/gu, "").slice(2, 14)}Z`));
}

/** A minimal X.509 v3 certificate, self-signed with sha256WithRSAEncryption, as PEM. */
function selfSignedCert(privateKey: KeyObject, publicKey: KeyObject, from: Date, to: Date): string {
  const sha256WithRsa = der(0x30, oid("1.2.840.113549.1.1.11"), der(0x05));
  const name = der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from("sns.amazonaws.com"))));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    sha256WithRsa,
    der(0x30, name),
    der(0x30, utcTime(from), utcTime(to)),
    der(0x30, name),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const cert = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  const lines = cert.toString("base64").match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  certPem = selfSignedCert(
    privateKey,
    publicKey,
    new Date(NOW.getTime() - 3600_000),
    new Date(NOW.getTime() + 24 * 3600_000),
  );
  otherKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
});

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes SNS URLs by host; queued responses serve the SES API. */
function fakeFetch(responses: (Response | Error)[] = []) {
  const calls: Call[] = [];
  const state = { subscribeStatus: 200, certFetches: 0, byUrl: new Map<string, number>() };
  const fetch: OutboundFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === CERT_URL) {
      state.certFetches++;
      return new Response(certPem, { status: 200 });
    }
    // Other SNS-shaped certificate names: `dead…` ones 404, the rest serve the same cert.
    const other =
      /^https:\/\/sns\.eu-west-1\.amazonaws\.com\/SimpleNotificationService-([0-9a-f]+)\.pem$/u.exec(
        url,
      );
    if (other !== null) {
      state.byUrl.set(url, (state.byUrl.get(url) ?? 0) + 1);
      return other[1]?.startsWith("dead")
        ? new Response("nope", { status: 404 })
        : new Response(certPem, { status: 200 });
    }
    if (url.startsWith(`https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription`)) {
      return new Response("<ConfirmSubscriptionResponse/>", { status: state.subscribeStatus });
    }
    if (url.includes("sns.") || url.includes("evil")) {
      throw new Error(`unexpected fetch of ${url}`);
    }
    const next = responses.shift() ?? json({});
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls, state };
}

const BASE_OPTIONS = {
  region: REGION,
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  from: { address: "investors@acme.test", name: "Acme IR" },
  now: () => NOW,
};

function mailer(fetch: OutboundFetch, extra: Partial<SesMailerOptions> = {}) {
  return createSesMailer({ ...BASE_OPTIONS, fetch, ...extra });
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("createSesMailer send", () => {
  it("POSTs a SigV4-signed SES v2 request with Simple content, headers, tags and the configuration set", async () => {
    const { fetch, calls } = fakeFetch([json({ MessageId: "ses-1" })]);
    const m = mailer(fetch, { configurationSet: "fundroom", sessionToken: "sts-token" });
    const sent = await m.send({
      to: "jane@example.com",
      subject: "Q3 update",
      text: "plain",
      html: "<p>html</p>",
      replyTo: "founder@acme.test",
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
      tags: ["updates"],
      idempotencyKey: "updates:s1:r1",
      stream: "broadcast",
      tracking: { opens: true, clicks: true },
    });
    expect(sent).toEqual({ messageId: "ses-1", acceptedAt: NOW });
    const call = calls[0];
    expect(call?.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(call?.init.method).toBe("POST");
    const body = bodyOf(call);
    expect(body).toMatchObject({
      FromEmailAddress: '"Acme IR" <investors@acme.test>',
      Destination: { ToAddresses: ["jane@example.com"] },
      ReplyToAddresses: ["founder@acme.test"],
      Content: {
        Simple: {
          Subject: { Data: "Q3 update", Charset: "UTF-8" },
          Body: {
            Text: { Data: "plain", Charset: "UTF-8" },
            Html: { Data: "<p>html</p>", Charset: "UTF-8" },
          },
          Headers: [{ Name: "List-Unsubscribe", Value: "<https://x.test/u>" }],
        },
      },
      ConfigurationSetName: "fundroom",
    });
    const tags = body["EmailTags"] as { Name: string; Value: string }[];
    expect(tags.map((t) => t.Name)).toEqual(["updates", "stream", "idempotency_key"]);
    expect(tags[2]?.Value).toMatch(/^[0-9a-f]{32}$/u);
    // No tracking switch exists in the SES API; nothing about it goes on the wire.
    expect(JSON.stringify(body)).not.toMatch(/track/iu);

    const headers = call?.init.headers as Record<string, string>;
    expect(headers["host"]).toBeUndefined();
    expect(headers["x-amz-date"]).toBe(
      NOW.toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}/u, ""),
    );
    expect(headers["x-amz-security-token"]).toBe("sts-token");
    const expected = signRequest(
      {
        method: "POST",
        url: new URL("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails"),
        headers: { "content-type": "application/json" },
        body: String(call?.init.body),
      },
      {
        region: REGION,
        service: "ses",
        credentials: {
          accessKeyId: BASE_OPTIONS.accessKeyId,
          secretAccessKey: BASE_OPTIONS.secretAccessKey,
          sessionToken: "sts-token",
        },
        now: NOW,
      },
    );
    expect(headers["authorization"]).toBe(expected.authorization);
    expect(headers["authorization"]).toContain(
      `Credential=AKIAIOSFODNN7EXAMPLE/${expected.headers["x-amz-date"]?.slice(0, 8)}/eu-west-1/ses/aws4_request`,
    );
  });

  it("encodes a non-ASCII display name and honours a per-message from", async () => {
    const { fetch, calls } = fakeFetch([json({ MessageId: "ses-2" })]);
    await mailer(fetch).send({
      to: "jane@example.com",
      subject: "s",
      text: "t",
      from: { address: "ir@acme-ventures.test", name: "Zoë Ventures" },
    });
    const body = bodyOf(calls[0]);
    expect(body["FromEmailAddress"]).toBe(
      `=?UTF-8?B?${Buffer.from("Zoë Ventures").toString("base64")}?= <ir@acme-ventures.test>`,
    );
    expect(body["ReplyToAddresses"]).toBeUndefined();
    expect(body["EmailTags"]).toBeUndefined();
    expect(body["ConfigurationSetName"]).toBeUndefined();
    expect(formatAddress({ address: "a@b.test" })).toBe("a@b.test");
  });

  it("maps AWS errors by type, never quoting the message", async () => {
    const cases: [Response, string, string | undefined][] = [
      [
        json({ message: "Email address is not verified: jane@example.com" }, 400, {
          "x-amzn-ErrorType": "MessageRejected:http://internal",
        }),
        "rejected",
        "MessageRejected",
      ],
      [
        json({ __type: "com.amazon#TooManyRequestsException", message: "slow" }, 429),
        "rate_limited",
        "TooManyRequestsException",
      ],
      [
        json({ message: "bad sig" }, 403, { "x-amzn-ErrorType": "InvalidSignatureException" }),
        "unauthorized",
        "InvalidSignatureException",
      ],
      [json({ message: "boom" }, 500), "connection_failed", undefined],
    ];
    for (const [response, code, awsError] of cases) {
      const { fetch } = fakeFetch([response]);
      const error = (await mailer(fetch)
        .send({ to: "jane@example.com", subject: "s", text: "t" })
        .catch((e: unknown) => e)) as MailerError;
      expect(error).toBeInstanceOf(MailerError);
      expect(error.code).toBe(code);
      expect(error.awsError).toBe(awsError);
      expect(error.message).not.toContain("jane");
    }
    const { fetch } = fakeFetch([new Error("ECONNRESET")]);
    await expect(
      mailer(fetch).send({ to: "jane@example.com", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ code: "connection_failed", retryable: true });
  });

  it("refuses bad options and advertises its capabilities", () => {
    const { fetch } = fakeFetch();
    expect(() => mailer(fetch, { region: "Europe" })).toThrow(MailerError);
    expect(() => mailer(fetch, { from: { address: "x" } })).toThrow(MailerError);
    expect(mailer(fetch).capabilities).toEqual({ perMessageTracking: false, webhooks: false });
    expect(mailer(fetch).parseWebhook).toBeUndefined();
    expect(mailer(fetch, { allowedTopicArns: [] }).parseWebhook).toBeUndefined();
    expect(mailer(fetch, { allowedTopicArns: [TOPIC] }).capabilities).toEqual({
      perMessageTracking: false,
      webhooks: true,
    });
  });
});

describe("createSesMailer healthCheck", () => {
  it("signs GET /v2/email/account and reads the verdict", async () => {
    const { fetch, calls } = fakeFetch([
      json({ SendingEnabled: true }),
      json({ message: "no" }, 403, { "x-amzn-ErrorType": "AccessDeniedException" }),
      json({ SendingEnabled: false }),
      json({ message: "no" }, 403, { "x-amzn-ErrorType": "UnrecognizedClientException" }),
      new Error("down"),
    ]);
    const m = mailer(fetch);
    await expect(m.healthCheck()).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/account");
    expect(calls[0]?.init.method).toBe("GET");
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["authorization"],
    ).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//u);
    await expect(m.healthCheck()).resolves.toBeUndefined();
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "rejected" });
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(m.healthCheck()).rejects.toMatchObject({ code: "connection_failed" });
  });
});

type Unsigned = Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL"> & {
  SignatureVersion?: "1" | "2";
  SigningCertURL?: string;
};

function signSns(m: Unsigned, key = keyPem): SnsMessage {
  const full = {
    SignatureVersion: "2" as const,
    SigningCertURL: CERT_URL,
    ...m,
    Signature: "",
  } as SnsMessage;
  const signature = createSign(full.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
    .update(stringToSign(full))
    .sign(key, "base64");
  return { ...full, Signature: signature };
}

function notification(event: unknown, overrides: Partial<Unsigned> = {}): Unsigned {
  return {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC,
    Message: JSON.stringify(event),
    Timestamp: NOW.toISOString(),
    ...overrides,
  };
}

const MAIL = {
  timestamp: "2026-09-22T10:00:00.000Z",
  messageId: "ses-msg-1",
  source: "investors@acme.test",
  destination: ["jane@example.com"],
  tags: { stream: ["broadcast"] },
};

describe("createSesMailer parseWebhook", () => {
  const post = (m: ReturnType<typeof mailer>, body: unknown) =>
    m.parseWebhook?.(
      new Request("https://host.test/webhooks/email/ses", {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=UTF-8",
          "x-amz-sns-message-type": "Notification",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("maps every SES event type, one event per recipient", async () => {
    const { fetch, state } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const events = async (event: unknown) => post(m, signSns(notification(event)));

    expect(
      await events({
        eventType: "Delivery",
        mail: MAIL,
        delivery: {
          timestamp: "2026-09-22T10:00:02.000Z",
          recipients: ["jane@example.com"],
          smtpResponse: "250 2.6.0 Message received",
        },
      }),
    ).toEqual([
      {
        kind: "delivered",
        messageId: "ses-msg-1",
        recipient: "jane@example.com",
        occurredAt: new Date("2026-09-22T10:00:02.000Z"),
        provider: "ses",
        reason: "250 2.6.0 Message received",
      },
    ]);

    expect(
      await events({
        eventType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          timestamp: "2026-09-22T10:00:03.000Z",
          bouncedRecipients: [
            { emailAddress: "jane@example.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" },
            { emailAddress: "joe@example.com" },
          ],
        },
      }),
    ).toMatchObject([
      {
        kind: "bounce",
        bounceType: "hard",
        recipient: "jane@example.com",
        reason: "smtp; 550 5.1.1 user unknown",
      },
      { kind: "bounce", bounceType: "hard", recipient: "joe@example.com", reason: "General" },
    ]);
    // Account-level suppression list: SES never tried; marked for a `provider` suppression.
    expect(
      await events({
        eventType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "OnAccountSuppressionList",
          bouncedRecipients: [{ emailAddress: "jane@example.com", diagnosticCode: "x" }],
        },
      }),
    ).toMatchObject([
      {
        kind: "bounce",
        bounceType: "hard",
        reason: "provider_suppressed:OnAccountSuppressionList",
      },
    ]);
    for (const bounceType of ["Transient", "Undetermined"]) {
      expect(
        (
          await events({
            eventType: "Bounce",
            mail: MAIL,
            bounce: {
              bounceType,
              bounceSubType: "MailboxFull",
              bouncedRecipients: [{ emailAddress: "jane@example.com" }],
            },
          })
        )?.[0],
      ).toMatchObject({ kind: "bounce", bounceType: "soft" });
    }

    expect(
      await events({
        eventType: "Complaint",
        mail: MAIL,
        complaint: {
          timestamp: "2026-09-22T10:05:00.000Z",
          complaintFeedbackType: "abuse",
          complainedRecipients: [{ emailAddress: "jane@example.com" }],
        },
      }),
    ).toMatchObject([{ kind: "complaint", recipient: "jane@example.com", reason: "abuse" }]);

    expect(
      await events({
        eventType: "DeliveryDelay",
        mail: MAIL,
        deliveryDelay: {
          timestamp: "2026-09-22T10:10:00.000Z",
          delayType: "MailboxFull",
          delayedRecipients: [{ emailAddress: "jane@example.com", status: "4.2.2" }],
        },
      }),
    ).toMatchObject([{ kind: "delay", recipient: "jane@example.com", reason: "MailboxFull" }]);

    const open = await events({
      eventType: "Open",
      mail: MAIL,
      open: {
        ipAddress: "17.58.0.1",
        timestamp: "2026-09-22T10:20:00.000Z",
        userAgent: "Mozilla/5.0",
      },
    });
    expect(open).toEqual([
      {
        kind: "open",
        messageId: "ses-msg-1",
        recipient: "jane@example.com",
        occurredAt: new Date("2026-09-22T10:20:00.000Z"),
        provider: "ses",
        reason: undefined,
        userAgent: "Mozilla/5.0",
      },
    ]);
    expect(open?.[0]?.machine).toBeUndefined();

    expect(
      await events({
        eventType: "Click",
        mail: MAIL,
        click: {
          ipAddress: "203.0.113.1",
          timestamp: "2026-09-22T10:21:00.000Z",
          userAgent: "Mozilla/5.0 Chrome/140",
          link: "https://acme.test/deck?x=1",
          linkTags: {},
        },
      }),
    ).toMatchObject([
      { kind: "click", url: "https://acme.test/deck?x=1", userAgent: "Mozilla/5.0 Chrome/140" },
    ]);

    // Classic identity notifications use notificationType.
    expect(
      await events({
        notificationType: "Bounce",
        mail: MAIL,
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "jane@example.com" }],
        },
      }),
    ).toMatchObject([{ kind: "bounce", bounceType: "hard" }]);

    expect(await events({ eventType: "Send", mail: MAIL, send: {} })).toEqual([]);
    expect(await post(m, signSns(notification(undefined, { Message: "not json" })))).toEqual([]);
    // The certificate was fetched once and cached.
    expect(state.certFetches).toBe(1);
  });

  it("accepts SignatureVersion 1 (SHA1) and a Subject line", async () => {
    const { fetch } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    expect(
      await post(
        m,
        signSns({
          ...notification(event),
          SignatureVersion: "1",
          Subject: "Amazon SES Email Event Notification",
        }),
      ),
    ).toHaveLength(1);
  });

  it("confirms a verified SubscriptionConfirmation by GETting the pinned SubscribeURL", async () => {
    const { fetch, calls, state } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const confirmation = {
      Type: "SubscriptionConfirmation" as const,
      MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
      Token: "tok",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe to the topic",
      SubscribeURL: SUBSCRIBE_URL,
      Timestamp: NOW.toISOString(),
    };
    expect(await post(m, signSns(confirmation))).toEqual([]);
    expect(calls.some((c) => c.url === SUBSCRIBE_URL && c.init.method === "GET")).toBe(true);

    // A SubscribeURL off the SNS host is never fetched, even when the signature holds.
    const before = calls.length;
    expect(
      await post(
        m,
        signSns({ ...confirmation, SubscribeURL: "https://evil.test/?Action=ConfirmSubscription" }),
      ),
    ).toBeUndefined();
    expect(calls.slice(before).some((c) => c.url.includes("evil"))).toBe(false);

    state.subscribeStatus = 403;
    await expect(post(m, signSns(confirmation))).rejects.toThrow(/subscription confirmation/u);

    expect(await post(m, signSns({ ...confirmation, Type: "UnsubscribeConfirmation" }))).toEqual(
      [],
    );
  });

  it("rejects a tampered body", async () => {
    const { fetch } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Complaint",
      mail: MAIL,
      complaint: { complainedRecipients: [{ emailAddress: "jane@example.com" }] },
    };
    const signed = signSns(notification(event));
    const tampered = {
      ...signed,
      Message: signed.Message.replace("jane@example.com", "eve@example.com"),
    };
    expect(await post(m, tampered)).toBeUndefined();
    expect(await post(m, signed)).toHaveLength(1);
  });

  it("rejects a signature made by another key", async () => {
    const { fetch } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    expect(await post(m, signSns(notification(event), otherKeyPem))).toBeUndefined();
  });

  it("rejects a stale or future Timestamp", async () => {
    const { fetch } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(
      await post(m, signSns(notification(event, { Timestamp: at(-61 * 60_000) }))),
    ).toBeUndefined();
    expect(
      await post(m, signSns(notification(event, { Timestamp: at(6 * 60_000) }))),
    ).toBeUndefined();
    expect(
      await post(m, signSns(notification(event, { Timestamp: at(-59 * 60_000) }))),
    ).toHaveLength(1);
  });

  it("never fetches a SigningCertURL on a foreign host", async () => {
    const { fetch, calls } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    for (const url of [
      "https://evil.test/SimpleNotificationService-abc123.pem",
      "https://sns.eu-west-1.amazonaws.com.evil.test/cert.pem",
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
      "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem",
      "https://sns.eu-west-1.amazonaws.com:8443/SimpleNotificationService-abc123.pem",
      "https://user@sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem",
      "https://sns.eu-west-1.amazonaws.com/cert.txt",
      // The right host, but not the one path shape SNS signs with.
      "https://sns.eu-west-1.amazonaws.com/cert.pem",
      "https://sns.eu-west-1.amazonaws.com/x/SimpleNotificationService-9c6465fa7f48f5ca.pem",
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-not-hex.pem",
      "https://sns.eu-west-1.amazonaws.com/c.pem?x=https://evil.test/c.pem",
    ]) {
      // Signed with the real key, so only the URL rule can refuse it.
      expect(
        await post(m, signSns(notification(event, { SigningCertURL: url }))),
        url,
      ).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("negative-caches a certificate URL that failed, then retries it after the TTL", async () => {
    const { fetch, state } = fakeFetch();
    let clock = NOW.getTime();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC], now: () => new Date(clock) });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["j@example.com"] },
    };
    const bad = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-deadbeef00112233.pem`;
    for (let i = 0; i < 5; i++) {
      expect(await post(m, signSns(notification(event, { SigningCertURL: bad })))).toBeUndefined();
    }
    expect(state.byUrl.get(bad)).toBe(1);
    clock += 61_000;
    const fresh = notification(event, {
      SigningCertURL: bad,
      Timestamp: new Date(clock).toISOString(),
    });
    expect(await post(m, signSns(fresh))).toBeUndefined();
    expect(state.byUrl.get(bad)).toBe(2);
  });

  it("keeps a hot certificate across a flood of other certificate names (LRU, not a full clear)", async () => {
    const { fetch, state } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["j@example.com"] },
    };
    expect(await post(m, signSns(notification(event)))).toHaveLength(1);
    for (let i = 0; i < 40; i++) {
      const hex = (0x1000_0000 + i).toString(16);
      const url = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex}.pem`;
      await post(m, signSns(notification(event, { SigningCertURL: url })));
      expect(await post(m, signSns(notification(event)))).toHaveLength(1);
    }
    expect(state.certFetches).toBe(1);
  });

  it("rejects an unknown TopicArn before fetching anything", async () => {
    const { fetch, calls } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    expect(
      await post(
        m,
        signSns(notification(event, { TopicArn: "arn:aws:sns:eu-west-1:999999999999:attacker" })),
      ),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects bodies that are not SNS messages", async () => {
    const { fetch } = fakeFetch();
    const m = mailer(fetch, { allowedTopicArns: [TOPIC] });
    expect(await post(m, "not json")).toBeUndefined();
    expect(await post(m, { Type: "Notification" })).toBeUndefined();
    const event = {
      eventType: "Delivery",
      mail: MAIL,
      delivery: { recipients: ["jane@example.com"] },
    };
    const signed = signSns(notification(event));
    expect(await post(m, { ...signed, SignatureVersion: "3" })).toBeUndefined();
    expect(await post(m, { ...signed, Signature: "" })).toBeUndefined();
  });
});
