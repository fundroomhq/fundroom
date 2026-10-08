import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyWebhook as verifyFromIndex } from "./index.js";
import {
  signPayload,
  verifyWebhook,
  WebhookVerificationError,
  type WebhookVerificationReason,
} from "./webhooks.js";

// The official Standard Webhooks test vector (standard-webhooks/libraries).
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TS = 1614265330;
const BODY = '{"test": 2432232314}';
const EXPECTED = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
// A second, unrelated secret (base64 of 32 bytes 0x01..0x20) for rotation and wrong-secret cases.
const OTHER = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)))}`;
const at = new Date(TS * 1000);

const headers = (signature: string, ts = String(TS), id = ID) => ({
  "webhook-id": id,
  "webhook-timestamp": ts,
  "webhook-signature": signature,
});

async function reason(p: Promise<unknown>): Promise<WebhookVerificationReason> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WebhookVerificationError);
  return (e as WebhookVerificationError).reason;
}

describe("the vendored verifier", () => {
  it("is the server's signature.ts below the header comment (edit the original, then copy)", () => {
    const code = (rel: string) => {
      const text = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(text.startsWith("/*")).toBe(true);
      return text.slice(text.indexOf("*/") + 2);
    };
    expect(code("./webhooks.ts")).toBe(code("../../webhooks/src/signature.ts"));
  });

  it("is re-exported from the package root", () => {
    expect(verifyFromIndex).toBe(verifyWebhook);
  });
});

describe("verifyWebhook", () => {
  it("accepts the Standard Webhooks test vector (record or Headers, any header case)", async () => {
    await expect(
      verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: SECRET, now: at }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
    await expect(
      verifyWebhook({
        headers: new Headers(headers(EXPECTED)),
        body: new TextEncoder().encode(BODY),
        secret: SECRET,
        now: at.getTime(),
      }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
    await expect(
      verifyWebhook({
        headers: {
          "Webhook-Id": ID,
          "Webhook-Timestamp": String(TS),
          "Webhook-Signature": EXPECTED,
        },
        body: BODY,
        secret: SECRET,
        now: at,
      }),
    ).resolves.toEqual({ id: ID, timestamp: TS });
  });

  it("enforces the 5-minute tolerance both ways, and a custom one", async () => {
    const verify = (nowSeconds: number, toleranceSeconds?: number) =>
      verifyWebhook({
        headers: headers(EXPECTED),
        body: BODY,
        secret: SECRET,
        now: nowSeconds * 1000,
        toleranceSeconds,
      });
    await expect(verify(TS + 300)).resolves.toBeDefined();
    await expect(verify(TS - 300)).resolves.toBeDefined();
    expect(await reason(verify(TS + 301))).toBe("timestamp_too_old");
    expect(await reason(verify(TS - 301))).toBe("timestamp_too_new");
    expect(await reason(verify(TS + 61, 60))).toBe("timestamp_too_old");
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED, "12x"), body: BODY, secret: SECRET, now: at }),
      ),
    ).toBe("invalid_timestamp");
  });

  it("accepts any matching v1 signature among several (rotation overlap)", async () => {
    const both = await signPayload({ id: ID, timestamp: TS, body: BODY, secrets: [OTHER, SECRET] });
    expect(both.split(" ")).toHaveLength(2);
    // The receiver still on the old secret and the one already on the new secret both pass.
    await expect(
      verifyWebhook({ headers: headers(both), body: BODY, secret: SECRET, now: at }),
    ).resolves.toBeDefined();
    await expect(
      verifyWebhook({ headers: headers(both), body: BODY, secret: OTHER, now: at }),
    ).resolves.toBeDefined();
    // Unknown versions and garbage entries are skipped, not fatal.
    await expect(
      verifyWebhook({
        headers: headers(`v2,abc v1,!!! ${EXPECTED}`),
        body: BODY,
        secret: SECRET,
        now: at,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a tampered body, a tampered id or timestamp, and a wrong secret", async () => {
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED),
          body: '{"test": 2432232315}',
          secret: SECRET,
          now: at,
        }),
      ),
    ).toBe("no_matching_signature");
    // Re-serialised JSON is a different body: verify the raw bytes.
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED),
          body: JSON.stringify(JSON.parse(BODY)),
          secret: SECRET,
          now: at,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED, String(TS), "msg_other"),
          body: BODY,
          secret: SECRET,
          now: at,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({
          headers: headers(EXPECTED, String(TS + 1)),
          body: BODY,
          secret: SECRET,
          now: at,
        }),
      ),
    ).toBe("no_matching_signature");
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: OTHER, now: at }),
      ),
    ).toBe("no_matching_signature");
  });

  it("names missing headers and an unusable secret", async () => {
    expect(
      await reason(
        verifyWebhook({ headers: { "webhook-id": ID }, body: BODY, secret: SECRET, now: at }),
      ),
    ).toBe("missing_headers");
    expect(
      await reason(
        verifyWebhook({ headers: headers(EXPECTED), body: BODY, secret: "whsec_%%%", now: at }),
      ),
    ).toBe("invalid_secret");
  });
});

describe("signPayload", () => {
  it("reproduces the test vector (so receivers can unit-test their handlers)", async () => {
    expect(await signPayload({ id: ID, timestamp: TS, body: BODY, secrets: [SECRET] })).toBe(
      EXPECTED,
    );
  });
});
