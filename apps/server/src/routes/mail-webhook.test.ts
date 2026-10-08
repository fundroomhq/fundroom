import type { MailDeliveryEvent, MailerPort } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import type { IngestResult } from "../mail/feedback.js";
import { mailWebhookRoutes } from "./mail-webhook.js";

/*
 * The webhook's budgets (E2.6 FX1): junk that fails authentication must never consume the budget
 * of the genuine provider, and an event for a message not recorded yet asks for a retry.
 */
const GOOD = "genuine";

function fixture(options: { maxPerMinute?: number; retry?: number } = {}) {
  const ingested: MailDeliveryEvent[][] = [];
  const mailer: MailerPort = {
    driver: "fake",
    async send() {
      throw new Error("unused");
    },
    async healthCheck() {},
    async parseWebhook(request) {
      if (request.headers.get("x-sig") !== GOOD) return undefined;
      return [
        {
          kind: "bounce",
          bounceType: "hard",
          recipient: "a@example.org",
          messageId: "m-1",
          occurredAt: new Date(),
          reason: undefined,
          provider: "fake",
        },
      ];
    },
  };
  const result: IngestResult = {
    recorded: 1,
    ignored: 0,
    dropped: 0,
    suppressed: 0,
    retry: options.retry ?? 0,
  };
  const app = mailWebhookRoutes({
    mailer: () => mailer,
    feedback: () => ({
      ingest: async (_provider, events) => {
        ingested.push([...events]);
        return result;
      },
    }),
    log: () => {},
    maxPerMinute: options.maxPerMinute,
    now: () => 1_000_000,
  });
  const post = (sig: string) =>
    app.request("https://x.test/webhooks/email/fake", {
      method: "POST",
      headers: { "x-sig": sig, "content-type": "application/json" },
      body: "[]",
    });
  return { post, ingested };
}

describe("mail webhook budgets", () => {
  it("a flood of unauthenticated junk never starves the genuine provider", async () => {
    const { post, ingested } = fixture({ maxPerMinute: 5 });
    for (let i = 0; i < 200; i++) {
      expect((await post(`forged-${i}`)).status).toBe(401);
    }
    const genuine = await post(GOOD);
    expect(genuine.status).toBe(200);
    expect(ingested).toHaveLength(1);
  });

  it("still limits authenticated traffic past its budget", async () => {
    const { post, ingested } = fixture({ maxPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await post(GOOD)).status).toBe(200);
    const over = await post(GOOD);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(ingested).toHaveLength(3);
  });

  it("answers 503 when ingest saw an event for a message it does not know yet", async () => {
    const { post } = fixture({ retry: 1 });
    const res = await post(GOOD);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});
