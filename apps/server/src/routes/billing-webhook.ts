import { BILLING_WEBHOOK_MAX_BYTES } from "@fundroom/billing";
import { BillingSignatureError } from "@fundroom/ports";
import { Hono } from "hono";
import type { BillingKernel } from "../control-plane/kernel.js";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";

/*
 * `POST /webhooks/billing/stripe` (E3.10, ADR-0058; owner: agent B) — ops tree, canonical host
 * only (the classifier's `WEBHOOK_BILLING_PATHS`), no session, no rate limit before the
 * signature check. 256 KiB cap; a bad signature is 400; a verified event we could not process may
 * be non-2xx (Stripe retries for 3 days); an unknown workspace is 200 + a log line; an event for
 * a non-active workspace is accepted and dropped (200). Mounted in `app.ts` before the session
 * chain; steps aside unless the classifier said `ops`.
 *
 *  - **404** (falls through to the app's not-found) unless billing is on with the `stripe` driver:
 *    the manual driver has no webhook, and the URL must not advertise which provider is in use.
 *  - **413** past 256 KiB, before the adapter sees a byte (real events are a few KiB).
 *  - **400** when the signature, its timestamp (300 s) or the body does not verify. Nothing else
 *    happens first: the raw bytes are verified before they are parsed, and no database row or
 *    provider call is touched by an unverified request. Not rate limited, for the reason
 *    `mail-webhook.ts` gives: counting unverified traffic lets junk starve the real provider,
 *    and verification is one bounded HMAC.
 *  - **500** when a verified event could not be processed (the re-read failed, the database):
 *    Stripe retries it for three days, and the ingest is idempotent (`core.billing_event`).
 *  - **200** otherwise — applied, duplicate, stale, ignored type, unknown customer, forged or
 *    confused metadata, a workspace that is held or suspended. The provider learns nothing from
 *    the answer, and a retry would change nothing.
 */
export interface BillingWebhookOptions {
  /** Read per request (tests swap the kernel). */
  readonly billing: () => BillingKernel;
  readonly log: Log;
  readonly now?: (() => Date) | undefined;
}

/** The body, or `undefined` once it passes `max` bytes (declared or counted). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function billingWebhookRoutes(options: BillingWebhookOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  const clock = options.now ?? (() => new Date());
  app.post("/webhooks/billing/stripe", async (c, next) => {
    if (c.get("classification")?.tree !== "ops") return next();
    const kernel = options.billing();
    const port = kernel.port;
    const service = kernel.service;
    if (!kernel.enabled || kernel.driver !== "stripe" || port === null || service === null) {
      return next();
    }
    const rawBody = await readCapped(c.req.raw, BILLING_WEBHOOK_MAX_BYTES);
    if (rawBody === undefined) return c.json({ error: { code: "payload_too_large" } }, 413);
    let event: ReturnType<typeof port.parseWebhook>;
    try {
      event = port.parseWebhook({ rawBody, headers: c.req.raw.headers, now: clock() });
    } catch (error) {
      if (error instanceof BillingSignatureError) {
        options.log("billing.webhook_rejected", { level: "warn", reason: error.message });
        return c.json({ error: { code: "invalid_signature" } }, 400);
      }
      throw error;
    }
    try {
      const result = await service.ingest(event);
      options.log("billing.webhook", {
        eventId: event.eventId,
        outcome: result.outcome,
        ...(result.workspaceId === null ? {} : { workspaceId: result.workspaceId }),
      });
      return c.json({ ok: true }, 200);
    } catch (error) {
      // Verified but not processed: a non-2xx makes Stripe retry. Our own messages only
      // (provider errors name a status and Stripe's error type, never the payload).
      options.log("billing.webhook_failed", {
        level: "error",
        eventId: event.eventId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "error",
      });
      return c.json({ error: { code: "internal_error" } }, 500);
    }
  });
  return app;
}
