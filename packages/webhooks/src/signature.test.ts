import { describe, expect, it } from "vitest";
import {
  mintWebhookSecret,
  signPayload,
  verifyWebhook,
  WebhookVerificationError,
  webhookSecretBytes,
} from "./signature.js";

// The official Standard Webhooks test vector (standard-webhooks/libraries).
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TS = 1614265330;
const BODY = '{"test": 2432232314}';
const EXPECTED = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

const headers = (signature: string, ts = String(TS), id = ID) => ({
  "webhook-id": id,
  "webhook-timestamp": ts,
  "webhook-signature": signature,
});

async function reason(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WebhookVerificationError);
  return (e as WebhookVerificationError).reason;
}

describe("signPayload", () => {
  it("matches the official Standard Webhooks test vector", async () => {
    expect(await signPayload({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] })).toBe(
      EXPECTED,
    );
    // Byte bodies sign the same as their string form; the prefix is optional on the secret.
    expect(
      await signPayload({
        id: ID,
        timestamp: TS,
        body: new TextEncoder().encode(BODY),
        secrets: [SECRET.slice("whsec_".length)],
      }),
    ).toBe(EXPECTED);
  });

  it("signs once per secret, space-separated, current first", async () => {
    const prev = mintWebhookSecret();
    const both = await signPayload({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET, prev] });
    const [first, second, ...rest] = both.split(" ");
    expect(first).toBe(EXPECTED);
    expect(second).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/u);
    expect(rest).toEqual([]);
  });

  it("refuses no secrets and a bad timestamp", async () => {
    expect(await reason(signPayload({ id: ID, timestamp: TS, body: BODY, secrets: [] }))).toBe(
      "invalid_secret",
    );
    expect(
      await reason(signPayload({ id: ID, timestamp: -1, body: BODY, secrets: [SECRET] })),
    ).toBe("invalid_timestamp");
  });
});

describe("verifyWebhook", () => {
  const now = new Date(TS * 1000);

  it("accepts the test vector, from a record or a Headers object", async () => {
    await expect(
      verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: SECRET, now }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
    await expect(
      verifyWebhook({
        headers: new Headers(headers(EXPECTED)),
        body: BODY,
        secret: SECRET,
        now: now.getTime(),
      }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
    // Header names are case-insensitive in a record too.
    await expect(
      verifyWebhook({
        headers: {
          "Webhook-Id": ID,
          "WEBHOOK-TIMESTAMP": String(TS),
          "Webhook-Signature": EXPECTED,
        },
        body: BODY,
        secret: SECRET,
        now,
      }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
  });

  it("accepts when any v1 signature matches (rotation overlap)", async () => {
    const other = await signPayload({
      id: ID,
      timestamp: TS,
      body: BODY,
      secrets: [mintWebhookSecret()],
    });
    await expect(
      verifyWebhook({
        headers: headers(`v2,abc ${other} ${EXPECTED}`),
        body: BODY,
        secret: SECRET,
        now,
      }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
  });

  it("rejects a tampered body, id or timestamp, and a wrong secret", async () => {
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED), body: `${BODY} `, secret: SECRET, now }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED, String(TS), "msg_other"),
          body: BODY,
          secret: SECRET,
          now,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED, String(TS + 1)),
          body: BODY,
          secret: SECRET,
          now,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED),
          body: BODY,
          secret: mintWebhookSecret(),
          now,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({ headers: headers("v1,***not-base64"), body: BODY, secret: SECRET, now }),
      ),
    ).toBe("no_matching_signature");
  });

  it("enforces the 5-minute tolerance both ways, and a custom one", async () => {
    const at = (s: number) => new Date((TS + s) * 1000);
    await expect(
      verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: SECRET, now: at(300) }),
    ).resolves.toBeDefined();
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: SECRET, now: at(301) }),
      ),
    ).toBe("timestamp_too_old");
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: SECRET, now: at(-301) }),
      ),
    ).toBe("timestamp_too_new");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED),
          body: BODY,
          secret: SECRET,
          now: at(61),
          toleranceSeconds: 60,
        }),
      ),
    ).toBe("timestamp_too_old");
  });

  it("rejects missing headers and a non-numeric timestamp", async () => {
    expect(
      await reason(
        verifyWebhook({
          headers: { "webhook-id": ID, "webhook-timestamp": String(TS) },
          body: BODY,
          secret: SECRET,
          now,
        }),
      ),
    ).toBe("missing_headers");
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED, "1e9"), body: BODY, secret: SECRET, now }),
      ),
    ).toBe("invalid_timestamp");
  });
});

describe("mintWebhookSecret", () => {
  it("is whsec_ + base64 of 32 random bytes", () => {
    const a = mintWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/u);
    expect(webhookSecretBytes(a)).toHaveLength(32);
    expect(mintWebhookSecret()).not.toBe(a);
  });

  it("refuses a secret that is not base64", () => {
    expect(() => webhookSecretBytes("whsec_***")).toThrow(WebhookVerificationError);
    expect(() => webhookSecretBytes("whsec_")).toThrow(WebhookVerificationError);
  });
});
