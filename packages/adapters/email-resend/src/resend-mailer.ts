import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MailDeliveryEvent,
  MailerCapabilities,
  MailerPort,
  OutboundEmail,
  OutboundFetch,
  SentEmail,
  SubProcessorMeta,
} from "@fundroom/ports";

/** E3.11: who Resend is, for the residency page and the DPA's sub-processor list. */
export const RESEND_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Resend, Inc.",
  purpose: "Email delivery (sign-in codes, invitations, updates, notifications)",
  dataProcessed:
    "Recipient email addresses and names, message subjects and content, delivery and engagement events",
  location: "United States",
  jurisdiction: "us",
  dpaUrl: "https://resend.com/legal/dpa",
};

/*
 * `MailerPort` over the Resend HTTPS API (E2.6, EXECUTION_PLAN §5.2).
 *
 * Send: `POST https://api.resend.com/emails` with a bearer API key, JSON body, and Resend's
 * `Idempotency-Key` header (24 h window) when the message carries `idempotencyKey`.
 *
 * Webhooks: Resend signs them with Svix — `svix-id`, `svix-timestamp` and `svix-signature`
 * headers, HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` under the base64 half of the
 * `whsec_…` secret, `v1,<base64>` entries separated by spaces (several during a secret rotation).
 * A signature is only trusted inside ±5 minutes of our clock, which is what makes a captured
 * request useless to replay later.
 *
 * Tracking: Resend switches open/click tracking per *domain* in its dashboard, never per message,
 * so `capabilities.perMessageTracking` is false and `OutboundEmail.tracking` is ignored here; the
 * webhook ingress drops open/click events for recipients who did not consent (E2.6 decision 1).
 *
 * Nothing here logs an unmasked address, the API key, the webhook secret, a subject or a body.
 * All HTTP goes through the injected, SSRF-guarded `OutboundFetch` — never the global `fetch`.
 */

export const RESEND_API_BASE = "https://api.resend.com";
/**
 * `MailDeliveryEvent.reason` prefix for "the provider suppressed this recipient on its side".
 * The kernel's webhook ingest (`isProviderSuppression` in `@fundroom/mail`) records such an
 * event as a `provider` suppression and does not publish it as a delivery. Spelled out here
 * because adapters depend on `@fundroom/ports` alone.
 */
export const PROVIDER_SUPPRESSED_PREFIX = "provider_suppressed:";
/** Svix's own tolerance: a signed request older or newer than this is refused. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

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
    options?: { readonly cause?: unknown; readonly status?: number | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status;
  }
  /** The provider's HTTP status, when there was one. */
  readonly status: number | undefined;
  /** A retry later can succeed: transport failures, 5xx and rate limits. */
  get retryable(): boolean {
    return this.code === "connection_failed" || this.code === "rate_limited";
  }
}

export interface MailAddress {
  readonly address: string;
  readonly name?: string | undefined;
}

export interface ResendMailerOptions {
  readonly apiKey: string;
  /** `MAIL_FROM` (+ `MAIL_FROM_NAME`): an address on a domain verified in Resend. */
  readonly from: MailAddress;
  readonly replyTo?: string | undefined;
  /** `whsec_…`; without it the adapter has no `parseWebhook` and the webhook route answers 404. */
  readonly webhookSecret?: string | undefined;
  /** Must be the SSRF-guarded fetch built for this adapter. Never global `fetch`. */
  readonly fetch: OutboundFetch;
  /** Test seam only. */
  readonly apiBaseUrl?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /** Never receives addresses in full, subjects, bodies, the key or the secret. */
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface ResendMailer extends MailerPort {
  readonly driver: "resend";
  readonly capabilities: MailerCapabilities;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;
const TAG_RE = /[^A-Za-z0-9_-]/gu;

/** `a***@example.com`: enough to correlate a log line without recording the address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  return `"${a.name.replace(/["\\]/gu, "\\$&").replace(/[\r\n]+/gu, " ")}" <${a.address}>`;
}

function decodeSecret(secret: string): Buffer {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(b64, "base64");
  if (key.length < 16) {
    throw new MailerError("invalid_options", "webhookSecret is not a whsec_… signing secret");
  }
  return key;
}

function assertOptions(options: ResendMailerOptions): void {
  if (options.apiKey.trim().length === 0) {
    throw new MailerError("invalid_options", "apiKey is required");
  }
  if (!EMAIL_RE.test(options.from.address)) {
    throw new MailerError("invalid_options", "from.address must be an email address");
  }
  if (options.replyTo !== undefined && !EMAIL_RE.test(options.replyTo)) {
    throw new MailerError("invalid_options", "replyTo must be an email address");
  }
}

function sendFailure(status: number, name: string | undefined): MailerError {
  const detail = name === undefined ? `HTTP ${status}` : `HTTP ${status}, ${name}`;
  if (status === 401 || status === 403) {
    return new MailerError("unauthorized", `resend refused the API key (${detail})`, { status });
  }
  if (status === 429) {
    return new MailerError("rate_limited", `resend is rate limiting us (${detail})`, { status });
  }
  if (status >= 500) {
    return new MailerError("connection_failed", `resend is unavailable (${detail})`, { status });
  }
  // 400/422 (validation, unverified domain), 409 (idempotency conflict).
  return new MailerError("rejected", `resend rejected the message (${detail})`, { status });
}

/** Only Resend's machine-readable error `name` is kept; its `message` can quote the address. */
async function errorName(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === "string" && /^[a-z_]{1,64}$/u.test(body.name)
      ? body.name
      : undefined;
  } catch {
    return undefined;
  }
}

function tagsOf(message: OutboundEmail): { name: string; value: string }[] {
  const seen = new Set<string>();
  const tags: { name: string; value: string }[] = [];
  for (const raw of message.tags ?? []) {
    const name = raw.replace(TAG_RE, "_").slice(0, 256);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    tags.push({ name, value: "1" });
  }
  if (message.stream !== undefined && !seen.has("stream")) {
    tags.push({ name: "stream", value: message.stream });
  }
  return tags;
}

/** Svix: `v1,<base64>` entries, space separated. Constant-time against each. */
function signatureMatches(key: Buffer, signedContent: string, header: string): boolean {
  const expected = createHmac("sha256", key).update(signedContent, "utf8").digest();
  let ok = false;
  for (const entry of header.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(entry.slice(comma + 1), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}

function dateOf(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One Resend webhook body → at most one event. `email.sent` and anything unknown are skipped:
 * a provider adding event types must not turn into 4xx answers and a retry storm.
 */
export function parseResendEvent(payload: unknown, now: Date): MailDeliveryEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  const data = (typeof body.data === "object" && body.data !== null ? body.data : {}) as Record<
    string,
    unknown
  >;
  const to = Array.isArray(data["to"]) ? (data["to"] as unknown[]) : [data["to"]];
  const recipient = str(to[0]);
  const messageId = str(data["email_id"]);
  if (recipient === undefined || messageId === undefined) return undefined;
  const occurredAt = dateOf(body.created_at, now);
  const base = { recipient, messageId, occurredAt, provider: "resend", reason: undefined };

  switch (body.type) {
    case "email.delivered":
      return { ...base, kind: "delivered" };
    case "email.delivery_delayed":
      return { ...base, kind: "delay" };
    case "email.complained":
      return { ...base, kind: "complaint" };
    case "email.bounced": {
      const bounce = (data["bounce"] ?? {}) as Record<string, unknown>;
      return {
        ...base,
        kind: "bounce",
        // Resend reports SES's vocabulary: Permanent | Transient | Undetermined.
        bounceType: bounce["type"] === "Permanent" ? "hard" : "soft",
        reason: str(bounce["message"]) ?? str(bounce["subType"]),
      };
    }
    case "email.suppressed": {
      // Resend refused to send: the address is on the account-level suppression list
      // (`suppressed.type`, today always `OnAccountSuppressionList`).
      const suppressed = (data["suppressed"] ?? {}) as Record<string, unknown>;
      const type =
        str(suppressed["type"])
          ?.replace(/[^A-Za-z]/gu, "")
          .slice(0, 64) || "Unknown";
      return {
        ...base,
        kind: "bounce",
        bounceType: "hard",
        reason: `${PROVIDER_SUPPRESSED_PREFIX}${type}`,
      };
    }
    case "email.opened":
      // Resend's open event carries no user agent, so nothing can show a person opened it (an
      // Apple MPP prefetch or a scanner looks the same): `classifyEngagement` flags an open
      // without a user agent `automated` with reason `unverified`.
      return { ...base, kind: "open" };
    case "email.clicked": {
      const click = (data["click"] ?? {}) as Record<string, unknown>;
      return {
        ...base,
        kind: "click",
        occurredAt: dateOf(click["timestamp"], occurredAt),
        url: str(click["link"]),
        userAgent: str(click["userAgent"]),
      };
    }
    default:
      return undefined;
  }
}

export function createResendMailer(options: ResendMailerOptions): ResendMailer {
  assertOptions(options);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const apiBase = options.apiBaseUrl ?? RESEND_API_BASE;
  const webhookKey =
    options.webhookSecret === undefined ? undefined : decodeSecret(options.webhookSecret);
  const auth = `Bearer ${options.apiKey}`;

  const mailer: ResendMailer = {
    driver: "resend",
    subProcessor: RESEND_SUB_PROCESSOR,
    capabilities: { perMessageTracking: false, webhooks: webhookKey !== undefined },

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
      const tags = tagsOf(message);
      const body = {
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };
      const headers: Record<string, string> = {
        authorization: auth,
        "content-type": "application/json",
        accept: "application/json",
      };
      if (message.idempotencyKey !== undefined) {
        headers["idempotency-key"] = message.idempotencyKey.slice(0, 256);
      }

      let response: Response;
      try {
        response = await options.fetch(new URL("/emails", apiBase), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (error) {
        log("mail.failed", {
          to: maskEmail(message.to),
          code: "connection_failed",
          durationMs: Math.round(performance.now() - started),
        });
        throw new MailerError("connection_failed", "could not reach resend", { cause: error });
      }
      if (!response.ok) {
        const failure = sendFailure(response.status, await errorName(response));
        log("mail.failed", {
          to: maskEmail(message.to),
          tags: message.tags ?? [],
          code: failure.code,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        });
        throw failure;
      }
      let id: unknown;
      try {
        id = ((await response.json()) as { id?: unknown }).id;
      } catch {
        id = undefined;
      }
      if (typeof id !== "string" || id.length === 0) {
        throw new MailerError("send_failed", "resend answered without a message id", {
          status: response.status,
        });
      }
      const acceptedAt = now();
      log("mail.sent", {
        messageId: id,
        to: maskEmail(message.to),
        tags: message.tags ?? [],
        durationMs: Math.round(performance.now() - started),
      });
      return { messageId: id, acceptedAt };
    },

    /**
     * An authenticated call that proves the key. `GET /domains` is refused for a *sending-only*
     * key with `restricted_api_key` — which still proves the key is real and live, so that
     * answer is healthy too. Anything else non-2xx is a key Resend does not accept.
     */
    async healthCheck(): Promise<void> {
      let response: Response;
      try {
        response = await options.fetch(new URL("/domains", apiBase), {
          method: "GET",
          headers: { authorization: auth, accept: "application/json" },
        });
      } catch (error) {
        throw new MailerError("connection_failed", "resend is not reachable", { cause: error });
      }
      if (response.ok) {
        response.body?.cancel().catch(() => {});
        return;
      }
      const name = await errorName(response);
      if (response.status === 401 && name === "restricted_api_key") return;
      throw sendFailure(response.status, name);
    },
  };

  if (webhookKey === undefined) return mailer;

  return {
    ...mailer,
    async parseWebhook(request: Request): Promise<readonly MailDeliveryEvent[] | undefined> {
      const id = request.headers.get("svix-id") ?? request.headers.get("webhook-id");
      const timestamp =
        request.headers.get("svix-timestamp") ?? request.headers.get("webhook-timestamp");
      const signature =
        request.headers.get("svix-signature") ?? request.headers.get("webhook-signature");
      if (id === null || timestamp === null || signature === null) return undefined;
      if (!/^\d{1,12}$/u.test(timestamp)) return undefined;
      const at = now().getTime();
      if (Math.abs(at - Number(timestamp) * 1000) > WEBHOOK_TOLERANCE_MS) {
        log("mail.webhook_stale", { provider: "resend" });
        return undefined;
      }
      const raw = await request.text();
      if (!signatureMatches(webhookKey, `${id}.${timestamp}.${raw}`, signature)) {
        log("mail.webhook_bad_signature", { provider: "resend" });
        return undefined;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        log("mail.webhook_malformed", { provider: "resend" });
        return [];
      }
      const event = parseResendEvent(payload, now());
      return event === undefined ? [] : [event];
    },
  };
}
