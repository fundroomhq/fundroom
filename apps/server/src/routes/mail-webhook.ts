import type { MailerPort } from "@fundroom/ports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import type { MailFeedback } from "../mail/feedback.js";
import { canonicalBaseOf } from "../path-mount.js";

/*
 * ESP delivery webhooks (E2.6): `POST /webhooks/email/{driver}` in the ops tree — no tenant, no
 * session, no CSRF (the classifier routes `/webhooks/email/*` to `ops`, which the tenant and session
 * middleware skip). The caller is the provider, and the only credential is the signature the
 * adapter verifies.
 *
 *  - **404** when `{driver}` is not the configured mailer's, or that mailer parses no webhooks —
 *    the same answer an unknown path gets, so the URL does not advertise which provider an
 *    install uses.
 *  - **413** past 256 KiB, before the adapter sees a byte (real batches are a few KiB).
 *  - **401** when the adapter says the signature is invalid (`parseWebhook` → `undefined`).
 *  - **429** past a global per-process budget of *authenticated* requests. The budget protects
 *    the database work behind a verified event, and it is counted only after the adapter has
 *    verified the signature: counting before it (as E2.6 first did) let 1,200 junk POSTs a
 *    minute starve the genuine provider, whose real bounces then got 429s and — after the
 *    provider's retries ran out — were lost. Junk can never touch this budget now.
 *    Unauthenticated traffic is *not* rate limited, because nothing can tell junk from the
 *    provider without verifying it, and refusing unverified requests wholesale is exactly the
 *    starvation above. That is affordable because verification is cheap and bounded: the body
 *    is capped at 256 KiB before the adapter sees a byte, Resend/Postmark check a header shape
 *    and a timestamp window before one HMAC or one digest compare, and SES checks its topic
 *    allow-list and certificate URL shape before one RSA verify against a cached (or briefly
 *    negative-cached) certificate. Failed attempts get their own counter, used only to log one
 *    summary line per minute instead of one line per junk request. The budget is global rather
 *    than per IP for the reason `/internal/tls/ask` gives — behind the shipped proxy the first
 *    `X-Forwarded-For` hop is attacker-supplied.
 *  - **500** when the adapter throws (an infrastructure failure such as SES's subscription
 *    confirmation) or ingest fails, so the provider retries the batch; consumers are idempotent.
 *  - **503** when an event names a message we do not know yet but that happened within the last
 *    `MAIL_EARLY_EVENT_WINDOW_MS`: the provider's webhook can beat the `core.mail_message` row
 *    the sender writes after the provider accepted the message, so we ask for a retry instead of
 *    losing the event. Consumers are idempotent, so re-delivering the rest of the batch is safe.
 *  - **200** otherwise, including for events naming messages we never sent (older than that
 *    window): an unknown id is ignored, and saying so would be an oracle for which ids exist.
 */
export const MAIL_WEBHOOK_MAX_BYTES = 256 * 1024;
/**
 * Authenticated requests per process per minute. A busy send produces a few events per
 * recipient, batched by the ESP.
 */
export const MAIL_WEBHOOK_MAX_PER_MINUTE = 1_200;
export const MAIL_WEBHOOK_PATH_PREFIX = "/webhooks/email/";

export interface MailWebhookOptions {
  /** Read per request: the container's mailer, after every decorator. */
  readonly mailer: () => MailerPort;
  readonly feedback: () => Pick<MailFeedback, "ingest">;
  readonly log: Log;
  /** Authenticated requests per minute (default `MAIL_WEBHOOK_MAX_PER_MINUTE`). */
  readonly maxPerMinute?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** `https://…/webhooks/email/<driver>`: what an admin pastes into the provider's console. */
export function mailWebhookUrl(baseUrl: URL, driver: string): string {
  return `${canonicalBaseOf(baseUrl)}${MAIL_WEBHOOK_PATH_PREFIX}${encodeURIComponent(driver)}`;
}

export function mailWebhookRoutes(options: MailWebhookOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const max = options.maxPerMinute ?? MAIL_WEBHOOK_MAX_PER_MINUTE;
  const clock = options.now ?? Date.now;
  let window = 0;
  let genuine = 0;
  let rejected = 0;
  const roll = () => {
    const minute = Math.floor(clock() / 60_000);
    if (minute === window) return;
    if (rejected > 1) {
      options.log("mail.webhook_rejected_summary", { level: "warn", rejected, window });
    }
    window = minute;
    genuine = 0;
    rejected = 0;
  };

  app.post(
    `${MAIL_WEBHOOK_PATH_PREFIX}:driver`,
    bodyLimit({
      maxSize: MAIL_WEBHOOK_MAX_BYTES,
      onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
    }),
    async (c) => {
      const mailer = options.mailer();
      const driver = c.req.param("driver");
      if (driver !== mailer.driver || mailer.parseWebhook === undefined) {
        return c.json({ error: { code: "not_found" } }, 404);
      }
      roll();
      // A fresh Request over the already-capped bytes: the adapter verifies the signature over
      // exactly what we read, and cannot stream past the limit.
      const body = await c.req.arrayBuffer();
      const request = new Request(c.req.url, {
        method: "POST",
        headers: c.req.raw.headers,
        body,
      });
      let events: Awaited<ReturnType<NonNullable<MailerPort["parseWebhook"]>>>;
      try {
        events = await mailer.parseWebhook(request);
      } catch (error) {
        // Adapters answer `undefined` for a bad signature; a *throw* is an infrastructure failure
        // on our side (SES confirming its subscription, a certificate fetch), so 5xx and let the
        // provider retry. Only the error's name is logged — a message may quote the payload.
        options.log("mail.webhook_parse_failed", {
          level: "error",
          driver,
          error: error instanceof Error ? error.name : "unknown",
        });
        return c.json({ error: { code: "internal_error" } }, 500);
      }
      if (events === undefined) {
        roll();
        rejected += 1;
        // One line for the first rejection of a minute, then a summary when the minute rolls.
        if (rejected === 1) options.log("mail.webhook_rejected", { level: "warn", driver });
        return c.json({ error: { code: "unauthenticated" } }, 401);
      }
      roll();
      genuine += 1;
      if (genuine > max) {
        c.header("Retry-After", "60");
        return c.json({ error: { code: "rate_limited" } }, 429);
      }
      try {
        const result = await options.feedback().ingest(mailer.driver, events);
        if (result.retry > 0) {
          c.header("Retry-After", "60");
          return c.json({ error: { code: "unavailable" } }, 503);
        }
        return c.json({ ok: true }, 200);
      } catch (error) {
        options.log("mail.webhook_ingest_failed", {
          level: "error",
          driver,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: { code: "internal_error" } }, 500);
      }
    },
  );

  return app;
}
