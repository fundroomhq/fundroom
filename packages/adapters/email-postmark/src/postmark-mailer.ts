import { createHash, timingSafeEqual } from "node:crypto";
import {
  type MailDeliveryEvent,
  type MailerCapabilities,
  type MailerPort,
  MailSuppressedError,
  type OutboundEmail,
  type OutboundFetch,
  type SentEmail,
  type SubProcessorMeta,
} from "@fundroom/ports";

/** E3.11: who Postmark is, for the residency page and the DPA's sub-processor list. */
export const POSTMARK_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Postmark (ActiveCampaign, LLC)",
  purpose: "Email delivery (sign-in codes, invitations, updates, notifications)",
  dataProcessed:
    "Recipient email addresses and names, message subjects and content, delivery and engagement events",
  location: "United States",
  jurisdiction: "us",
  dpaUrl: "https://postmarkapp.com/dpa",
};

/*
 * `MailerPort` over the Postmark HTTPS API (E2.6, EXECUTION_PLAN §5.2).
 *
 * Send: `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`. Postmark is the
 * one provider here that switches tracking **per message**, so `TrackOpens` / `TrackLinks` are
 * always sent explicitly — `false` / `"None"` unless the sender set `OutboundEmail.tracking` —
 * which keeps a server-level "track by default" setting in Postmark's dashboard from tracking a
 * recipient who never consented (E2.6 decision 1).
 *
 * Streams: Postmark separates transactional and broadcast traffic into message streams with
 * separate reputations. `stream: "broadcast"` (investor updates) goes to `broadcastStream`
 * (default `broadcast`); everything else — sign-in codes, notifications, digests — to the
 * default transactional stream `outbound`.
 *
 * Idempotency: Postmark has no idempotency API. The key is carried as a short digest in
 * `Metadata.idempotency_key` so it comes back on every webhook and a duplicate is visible; dedupe
 * itself stays with the job queue's singleton key and `core.mail_message`.
 *
 * Webhooks: Postmark does not sign webhook bodies; it offers HTTP basic auth on the webhook URL
 * (`https://user:pass@host/webhooks/email/postmark`). The credentials are compared in constant
 * time over digests, so neither their content nor their length leaks through timing.
 *
 * Nothing here logs an unmasked address, the server token, the webhook password, a subject or a
 * body. All HTTP goes through the injected, SSRF-guarded `OutboundFetch`.
 */

export const POSTMARK_API_BASE = "https://api.postmarkapp.com";
export const DEFAULT_BROADCAST_STREAM = "broadcast";
export const TRANSACTIONAL_STREAM = "outbound";
/** Postmark `ErrorCode` for "you tried to send to a recipient that has been marked as inactive". */
export const INACTIVE_RECIPIENT_ERROR = 406;
/**
 * `MailDeliveryEvent.reason` prefix for "the provider suppressed this recipient on its side".
 * The kernel's webhook ingest (`isProviderSuppression` in `@fundroom/mail`) records such an
 * event as a `provider` suppression and does not publish it as a delivery. Spelled out here
 * because adapters depend on `@fundroom/ports` alone.
 */
export const PROVIDER_SUPPRESSED_PREFIX = "provider_suppressed:";

export type MailerErrorCode =
  | "invalid_options"
  | "connection_failed"
  | "unauthorized"
  | "rejected"
  | "rate_limited"
  | "send_failed";

export class MailerError extends Error {
  override readonly name = "MailerError";
  constructor(
    readonly code: MailerErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly status?: number | undefined;
      readonly providerCode?: number | undefined;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status;
    this.providerCode = options?.providerCode;
  }
  readonly status: number | undefined;
  /** Postmark's numeric `ErrorCode` (e.g. 406 = inactive recipient). */
  readonly providerCode: number | undefined;
  get retryable(): boolean {
    return this.code === "connection_failed" || this.code === "rate_limited";
  }
}

export interface MailAddress {
  readonly address: string;
  readonly name?: string | undefined;
}

export interface PostmarkMailerOptions {
  readonly serverToken: string;
  /** `MAIL_FROM` (+ `MAIL_FROM_NAME`): a confirmed sender signature or domain in Postmark. */
  readonly from: MailAddress;
  readonly replyTo?: string | undefined;
  /** Message stream for `stream: "broadcast"`. Default `broadcast`. */
  readonly broadcastStream?: string | undefined;
  /** Without it the adapter has no `parseWebhook` and the webhook route answers 404. */
  readonly webhookBasicAuth?: { readonly user: string; readonly password: string } | undefined;
  /** Must be the SSRF-guarded fetch built for this adapter. Never global `fetch`. */
  readonly fetch: OutboundFetch;
  /** Test seam only. */
  readonly apiBaseUrl?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface PostmarkMailer extends MailerPort {
  readonly driver: "postmark";
  readonly capabilities: MailerCapabilities;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;
const STREAM_RE = /^[a-z0-9-]{1,64}$/u;
/** Postmark: one `Tag` per message, at most 1000 characters. */
const TAG_MAX = 1000;

/**
 * Bounce `Type`s that are not bounces at all (auto-replies, subscription chatter): skipped.
 * `HardBounce`, `BadEmailAddress` and `ManuallyDeactivated` are hard; everything else soft,
 * unless Postmark marked the address `Inactive` — then it will refuse to send to it anyway.
 */
const NOT_A_BOUNCE = new Set([
  "AutoResponder",
  "AddressChange",
  "Subscribe",
  "Unsubscribe",
  "ChallengeVerification",
  "OpenRelayTest",
]);
const HARD_BOUNCE = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated"]);

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  return `"${a.name.replace(/["\\]/gu, "\\$&").replace(/[\r\n]+/gu, " ")}" <${a.address}>`;
}

/** A 32-hex digest: fits Postmark's 80-character metadata values, reveals nothing. */
function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function assertOptions(options: PostmarkMailerOptions): void {
  if (options.serverToken.trim().length === 0) {
    throw new MailerError("invalid_options", "serverToken is required");
  }
  if (!EMAIL_RE.test(options.from.address)) {
    throw new MailerError("invalid_options", "from.address must be an email address");
  }
  if (options.replyTo !== undefined && !EMAIL_RE.test(options.replyTo)) {
    throw new MailerError("invalid_options", "replyTo must be an email address");
  }
  if (options.broadcastStream !== undefined && !STREAM_RE.test(options.broadcastStream)) {
    throw new MailerError("invalid_options", "broadcastStream must be a message stream id");
  }
  const auth = options.webhookBasicAuth;
  if (auth !== undefined && (auth.user.length === 0 || auth.password.length < 16)) {
    throw new MailerError(
      "invalid_options",
      "webhookBasicAuth needs a user and a password of at least 16 characters",
    );
  }
}

function sendFailure(status: number, providerCode: number | undefined): MailerError {
  const detail =
    providerCode === undefined ? `HTTP ${status}` : `HTTP ${status}, ErrorCode ${providerCode}`;
  const extra = { status, providerCode };
  if (status === 401 || status === 403) {
    return new MailerError("unauthorized", `postmark refused the server token (${detail})`, extra);
  }
  if (status === 429) {
    return new MailerError("rate_limited", `postmark is rate limiting us (${detail})`, extra);
  }
  if (status >= 500) {
    return new MailerError("connection_failed", `postmark is unavailable (${detail})`, extra);
  }
  // 422: invalid address (300), inactive recipient (406), unconfirmed sender (400)…
  return new MailerError("rejected", `postmark rejected the message (${detail})`, extra);
}

/** Only the numeric `ErrorCode` is kept; Postmark's `Message` quotes the address back. */
async function errorCode(response: Response): Promise<number | undefined> {
  try {
    const body = (await response.json()) as { ErrorCode?: unknown };
    return typeof body.ErrorCode === "number" ? body.ErrorCode : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dateOf(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** One Postmark webhook body (they post one record per request) → at most one event. */
export function parsePostmarkEvent(payload: unknown, now: Date): MailDeliveryEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const messageId = str(p["MessageID"]);
  if (messageId === undefined) return undefined;
  const base = { messageId, provider: "postmark", reason: undefined };

  switch (p["RecordType"]) {
    case "Delivery": {
      const recipient = str(p["Recipient"]);
      if (recipient === undefined) return undefined;
      return {
        ...base,
        kind: "delivered",
        recipient,
        occurredAt: dateOf(p["DeliveredAt"], now),
        reason: str(p["Details"]),
      };
    }
    case "Bounce": {
      const recipient = str(p["Email"]);
      const type = str(p["Type"]) ?? "Unknown";
      if (recipient === undefined || NOT_A_BOUNCE.has(type)) return undefined;
      if (type === "SpamComplaint") {
        return { ...base, kind: "complaint", recipient, occurredAt: dateOf(p["BouncedAt"], now) };
      }
      return {
        ...base,
        kind: "bounce",
        recipient,
        bounceType: HARD_BOUNCE.has(type) || p["Inactive"] === true ? "hard" : "soft",
        occurredAt: dateOf(p["BouncedAt"], now),
        reason: str(p["Description"]) ?? type,
      };
    }
    case "SpamComplaint": {
      const recipient = str(p["Email"]);
      if (recipient === undefined) return undefined;
      return { ...base, kind: "complaint", recipient, occurredAt: dateOf(p["BouncedAt"], now) };
    }
    case "SubscriptionChange": {
      // Postmark's suppression list changed for this recipient: `SuppressSending: true` means
      // Postmark will refuse to send to it (hard bounce, spam complaint, an unsubscribe via
      // Postmark's own link, or a manual suppression in its dashboard). A reactivation
      // (`false`) is not mirrored: lifting a local suppression stays an admin's decision.
      const recipient = str(p["Recipient"]);
      if (recipient === undefined || p["SuppressSending"] !== true) return undefined;
      const why = str(p["SuppressionReason"]) ?? "Unknown";
      return {
        ...base,
        kind: "bounce",
        bounceType: "hard",
        recipient,
        occurredAt: dateOf(p["ChangedAt"], now),
        reason: `${PROVIDER_SUPPRESSED_PREFIX}${why.replace(/[^A-Za-z]/gu, "").slice(0, 64)}`,
      };
    }
    case "Open":
    case "Click": {
      const recipient = str(p["Recipient"]);
      if (recipient === undefined) return undefined;
      const open = p["RecordType"] === "Open";
      return {
        ...base,
        kind: open ? "open" : "click",
        recipient,
        occurredAt: dateOf(p["ReceivedAt"], now),
        userAgent: str(p["UserAgent"]),
        // Postmark does not flag machine opens; the classifier reads the user agent.
        ...(open ? {} : { url: str(p["OriginalLink"]) }),
      };
    }
    default:
      return undefined;
  }
}

export function createPostmarkMailer(options: PostmarkMailerOptions): PostmarkMailer {
  assertOptions(options);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const apiBase = options.apiBaseUrl ?? POSTMARK_API_BASE;
  const broadcastStream = options.broadcastStream ?? DEFAULT_BROADCAST_STREAM;
  const auth = options.webhookBasicAuth;
  const expectedAuth =
    auth === undefined
      ? undefined
      : digest(`Basic ${Buffer.from(`${auth.user}:${auth.password}`, "utf8").toString("base64")}`);
  const tokenHeaders = {
    "x-postmark-server-token": options.serverToken,
    accept: "application/json",
  };

  const mailer: PostmarkMailer = {
    driver: "postmark",
    subProcessor: POSTMARK_SUB_PROCESSOR,
    capabilities: { perMessageTracking: true, webhooks: expectedAuth !== undefined },

    async send(message: OutboundEmail): Promise<SentEmail> {
      if (!EMAIL_RE.test(message.to)) {
        throw new MailerError("send_failed", "recipient is not an email address");
      }
      const started = performance.now();
      const replyTo = message.replyTo ?? options.replyTo;
      const from = message.from
        ? formatAddress({
            address: message.from.address,
            name: message.from.name ?? options.from.name,
          })
        : formatAddress(options.from);
      const tag = message.tags?.[0]?.slice(0, TAG_MAX);
      const metadata: Record<string, string> = {};
      if (message.stream !== undefined) metadata["stream"] = message.stream;
      if (message.idempotencyKey !== undefined) {
        metadata["idempotency_key"] = keyDigest(message.idempotencyKey);
      }
      const body = {
        From: from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html !== undefined ? { HtmlBody: message.html } : {}),
        ...(replyTo !== undefined ? { ReplyTo: replyTo } : {}),
        ...(message.headers !== undefined
          ? {
              Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
            }
          : {}),
        ...(tag !== undefined && tag.length > 0 ? { Tag: tag } : {}),
        ...(Object.keys(metadata).length > 0 ? { Metadata: metadata } : {}),
        TrackOpens: message.tracking?.opens === true,
        TrackLinks: message.tracking?.clicks === true ? "HtmlAndText" : "None",
        MessageStream: message.stream === "broadcast" ? broadcastStream : TRANSACTIONAL_STREAM,
      };

      let response: Response;
      try {
        response = await options.fetch(new URL("/email", apiBase), {
          method: "POST",
          headers: { ...tokenHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        log("mail.failed", {
          to: maskEmail(message.to),
          code: "connection_failed",
          durationMs: Math.round(performance.now() - started),
        });
        throw new MailerError("connection_failed", "could not reach postmark", { cause: error });
      }
      let payload: { MessageID?: unknown; ErrorCode?: unknown } | undefined;
      if (response.ok) {
        try {
          payload = (await response.json()) as { MessageID?: unknown; ErrorCode?: unknown };
        } catch {
          payload = undefined;
        }
      }
      // Postmark answers 200 with ErrorCode 0 on success; a non-zero code is a refusal.
      const providerCode =
        payload === undefined
          ? await errorCode(response)
          : typeof payload.ErrorCode === "number"
            ? payload.ErrorCode
            : undefined;
      if (!response.ok || (providerCode !== undefined && providerCode !== 0)) {
        if (providerCode === INACTIVE_RECIPIENT_ERROR) {
          // Postmark's own suppression list refused the recipient: not a failure to retry but
          // a suppression, which callers already handle (`skipped`, no retry).
          log("mail.suppressed_by_provider", {
            to: maskEmail(message.to),
            tags: message.tags ?? [],
            status: response.status,
            providerCode,
          });
          throw new MailSuppressedError("provider");
        }
        const failure = sendFailure(response.ok ? 422 : response.status, providerCode);
        log("mail.failed", {
          to: maskEmail(message.to),
          tags: message.tags ?? [],
          code: failure.code,
          status: response.status,
          providerCode,
          durationMs: Math.round(performance.now() - started),
        });
        throw failure;
      }
      const id = payload?.MessageID;
      if (typeof id !== "string" || id.length === 0) {
        throw new MailerError("send_failed", "postmark answered without a MessageID", {
          status: response.status,
        });
      }
      const acceptedAt = now();
      log("mail.sent", {
        messageId: id,
        to: maskEmail(message.to),
        tags: message.tags ?? [],
        stream: body.MessageStream,
        durationMs: Math.round(performance.now() - started),
      });
      return { messageId: id, acceptedAt };
    },

    /** `GET /server` is the cheapest call a server token can make; 200 proves it. */
    async healthCheck(): Promise<void> {
      let response: Response;
      try {
        response = await options.fetch(new URL("/server", apiBase), {
          method: "GET",
          headers: tokenHeaders,
        });
      } catch (error) {
        throw new MailerError("connection_failed", "postmark is not reachable", { cause: error });
      }
      response.body?.cancel().catch(() => {});
      if (!response.ok) throw sendFailure(response.status, undefined);
    },
  };

  if (expectedAuth === undefined) return mailer;

  return {
    ...mailer,
    async parseWebhook(request: Request): Promise<readonly MailDeliveryEvent[] | undefined> {
      const given = request.headers.get("authorization");
      if (given === null || !timingSafeEqual(digest(given), expectedAuth)) {
        log("mail.webhook_bad_signature", { provider: "postmark" });
        return undefined;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await request.text()) as unknown;
      } catch {
        log("mail.webhook_malformed", { provider: "postmark" });
        return [];
      }
      const event = parsePostmarkEvent(payload, now());
      return event === undefined ? [] : [event];
    },
  };
}
