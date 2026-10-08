import { createHash } from "node:crypto";
import {
  awsRegionLocation,
  type MailDeliveryEvent,
  type MailerCapabilities,
  type MailerPort,
  type OutboundEmail,
  type OutboundFetch,
  type SentEmail,
  type SubProcessorMeta,
} from "@fundroom/ports";
import { type AwsCredentials, signRequest } from "./sigv4.js";
import { createSnsVerifier, isSnsUrl } from "./sns.js";

/*
 * `MailerPort` over the Amazon SES v2 API (E2.6, EXECUTION_PLAN §5.2).
 *
 * Send: SigV4-signed `POST https://email.<region>.amazonaws.com/v2/email/outbound-emails` with
 * `Content.Simple` (subject, text, html, and `Headers` for `List-Unsubscribe`), `EmailTags` and,
 * when configured, `ConfigurationSetName` — the configuration set is what publishes events.
 *
 * Tracking: SES switches open/click tracking per configuration set, never per message, so
 * `capabilities.perMessageTracking` is false; the ingress drops open/click events for recipients
 * who did not consent (E2.6 decision 1). Idempotency: SES has none; the key's digest rides along
 * as the `idempotency_key` tag so it is visible on every event.
 *
 * Webhooks: SES event publishing → SNS topic → HTTPS subscription to
 * `/webhooks/email/ses`. Every message is verified by `sns.ts` (allow-listed `TopicArn`, pinned
 * certificate host, RSA signature, replay window). A verified `SubscriptionConfirmation` is
 * confirmed by GETting its `SubscribeURL`, itself pinned to `sns.<region>.amazonaws.com`.
 *
 * Nothing here logs an unmasked address, a key, a subject or a body.
 */

/** SNS retries a failed delivery for a while; older signed messages are refused as replays. */
export const DEFAULT_SNS_MAX_AGE_MS = 60 * 60_000;

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
      readonly awsError?: string | undefined;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status;
    this.awsError = options?.awsError;
  }
  readonly status: number | undefined;
  /** AWS error type, e.g. `MessageRejected`, `TooManyRequestsException`. */
  readonly awsError: string | undefined;
  get retryable(): boolean {
    return this.code === "connection_failed" || this.code === "rate_limited";
  }
}

export interface MailAddress {
  readonly address: string;
  readonly name?: string | undefined;
}

export interface SesMailerOptions {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  /** `MAIL_FROM` (+ `MAIL_FROM_NAME`): a verified SES identity. */
  readonly from: MailAddress;
  readonly replyTo?: string | undefined;
  readonly configurationSet?: string | undefined;
  /** SNS topics whose notifications are accepted. Empty/absent = no `parseWebhook`. */
  readonly allowedTopicArns?: readonly string[] | undefined;
  /** Must be the SSRF-guarded fetch built for this adapter. Never global `fetch`. */
  readonly fetch: OutboundFetch;
  /** Test seam only; defaults to `https://email.<region>.amazonaws.com`. */
  readonly endpoint?: string | undefined;
  readonly snsMaxAgeMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface SesMailer extends MailerPort {
  readonly driver: "ses";
  readonly capabilities: MailerCapabilities;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;
const REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const TAG_RE = /[^A-Za-z0-9_-]/gu;
const AWS_ERROR_RE = /^[A-Za-z]{1,80}$/u;

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** RFC 5322 display name; RFC 2047 encoded-word when it is not plain ASCII (SES requires it). */
export function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  const name = a.name.replace(/[\r\n]+/gu, " ");
  if (/^[\x20-\x7e]*$/u.test(name)) {
    return `"${name.replace(/["\\]/gu, "\\$&")}" <${a.address}>`;
  }
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${a.address}>`;
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

function assertOptions(options: SesMailerOptions): void {
  if (!REGION_RE.test(options.region)) {
    throw new MailerError("invalid_options", "region must be an AWS region such as eu-west-1");
  }
  if (options.accessKeyId.length === 0 || options.secretAccessKey.length === 0) {
    throw new MailerError("invalid_options", "accessKeyId and secretAccessKey are required");
  }
  if (!EMAIL_RE.test(options.from.address)) {
    throw new MailerError("invalid_options", "from.address must be an email address");
  }
  if (options.replyTo !== undefined && !EMAIL_RE.test(options.replyTo)) {
    throw new MailerError("invalid_options", "replyTo must be an email address");
  }
}

/**
 * `MailDeliveryEvent.reason` prefix for "the provider refused this recipient from its own
 * suppression list". The kernel's webhook ingest (`apps/server/src/mail/feedback.ts`, via
 * `isProviderSuppression` in `@fundroom/mail`) suppresses such a hard bounce with reason
 * `provider`. Spelled out here because adapters depend on `@fundroom/ports` alone.
 */
export const PROVIDER_SUPPRESSED_PREFIX = "provider_suppressed:";

function sendFailure(status: number, awsError: string | undefined): MailerError {
  const detail = awsError === undefined ? `HTTP ${status}` : `HTTP ${status}, ${awsError}`;
  const extra = { status, awsError };
  if (
    status === 429 ||
    awsError === "TooManyRequestsException" ||
    awsError === "LimitExceededException" ||
    awsError === "ThrottlingException"
  ) {
    return new MailerError("rate_limited", `ses is rate limiting us (${detail})`, extra);
  }
  if (status === 401 || status === 403) {
    return new MailerError("unauthorized", `ses refused the credentials (${detail})`, extra);
  }
  if (status >= 500) {
    return new MailerError("connection_failed", `ses is unavailable (${detail})`, extra);
  }
  return new MailerError("rejected", `ses rejected the message (${detail})`, extra);
}

/** Only the AWS error *type* is kept; the message text can quote the address. */
async function awsErrorOf(response: Response): Promise<string | undefined> {
  const header = response.headers.get("x-amzn-errortype")?.split(":")[0];
  if (header !== undefined && AWS_ERROR_RE.test(header)) {
    response.body?.cancel().catch(() => {});
    return header;
  }
  try {
    const body = (await response.json()) as { __type?: unknown; code?: unknown };
    const raw = typeof body.__type === "string" ? body.__type : body.code;
    const type = typeof raw === "string" ? raw.split("#").pop() : undefined;
    return type !== undefined && AWS_ERROR_RE.test(type) ? type : undefined;
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * One SES event (the JSON inside an SNS `Message`) → events, one per affected recipient. Both
 * event publishing (`eventType`) and classic identity notifications (`notificationType`) parse.
 * `Send`, `Reject`, `Rendering Failure`, `Subscription` and unknown types are skipped.
 */
export function parseSesEvent(payload: unknown, now: Date): MailDeliveryEvent[] {
  const p = record(payload);
  const type = str(p["eventType"]) ?? str(p["notificationType"]);
  const mail = record(p["mail"]);
  const messageId = str(mail["messageId"]);
  if (messageId === undefined) return [];
  const base = { messageId, provider: "ses", reason: undefined };
  const destination = str(list(mail["destination"])[0]);

  switch (type) {
    case "Delivery": {
      const delivery = record(p["delivery"]);
      const at = dateOf(delivery["timestamp"], now);
      return list(delivery["recipients"]).flatMap((r) => {
        const recipient = str(r);
        return recipient === undefined
          ? []
          : [
              {
                ...base,
                kind: "delivered" as const,
                recipient,
                occurredAt: at,
                reason: str(delivery["smtpResponse"]),
              },
            ];
      });
    }
    case "Bounce": {
      const bounce = record(p["bounce"]);
      const at = dateOf(bounce["timestamp"], now);
      const hard = bounce["bounceType"] === "Permanent";
      // SES never sent it: the address is on the account-level suppression list. Marked with
      // the kernel's `provider_suppressed:` reason so it is listed as a *provider* suppression.
      const onList =
        bounce["bounceSubType"] === "OnAccountSuppressionList" ||
        bounce["bounceSubType"] === "OnSuppressionList";
      return list(bounce["bouncedRecipients"]).flatMap((r) => {
        const recipient = str(record(r)["emailAddress"]);
        return recipient === undefined
          ? []
          : [
              {
                ...base,
                kind: "bounce" as const,
                bounceType: hard || onList ? ("hard" as const) : ("soft" as const),
                recipient,
                occurredAt: at,
                reason: onList
                  ? `${PROVIDER_SUPPRESSED_PREFIX}${String(bounce["bounceSubType"])}`
                  : (str(record(r)["diagnosticCode"]) ?? str(bounce["bounceSubType"])),
              },
            ];
      });
    }
    case "Complaint": {
      const complaint = record(p["complaint"]);
      const at = dateOf(complaint["timestamp"], now);
      return list(complaint["complainedRecipients"]).flatMap((r) => {
        const recipient = str(record(r)["emailAddress"]);
        return recipient === undefined
          ? []
          : [
              {
                ...base,
                kind: "complaint" as const,
                recipient,
                occurredAt: at,
                reason: str(complaint["complaintFeedbackType"]),
              },
            ];
      });
    }
    case "DeliveryDelay": {
      const delay = record(p["deliveryDelay"]);
      const at = dateOf(delay["timestamp"], now);
      return list(delay["delayedRecipients"]).flatMap((r) => {
        const recipient = str(record(r)["emailAddress"]);
        return recipient === undefined
          ? []
          : [
              {
                ...base,
                kind: "delay" as const,
                recipient,
                occurredAt: at,
                reason: str(record(r)["diagnosticCode"]) ?? str(delay["delayType"]),
              },
            ];
      });
    }
    case "Open": {
      const open = record(p["open"]);
      if (destination === undefined) return [];
      return [
        {
          ...base,
          kind: "open",
          recipient: destination,
          occurredAt: dateOf(open["timestamp"], now),
          userAgent: str(open["userAgent"]),
        },
      ];
    }
    case "Click": {
      const click = record(p["click"]);
      if (destination === undefined) return [];
      return [
        {
          ...base,
          kind: "click",
          recipient: destination,
          occurredAt: dateOf(click["timestamp"], now),
          url: str(click["link"]),
          userAgent: str(click["userAgent"]),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * E3.11: Amazon SES as a sub-processor. SES processes mail in the region the adapter calls
 * (`AWS_REGION`), so the location follows it.
 */
export function sesSubProcessor(region: string): SubProcessorMeta {
  const where = awsRegionLocation(region);
  return {
    name: "Amazon Web Services, Inc. (Amazon SES)",
    purpose: "Email delivery (sign-in codes, invitations, updates, notifications)",
    dataProcessed:
      "Recipient email addresses and names, message subjects and content, delivery and engagement events",
    location: where.location,
    jurisdiction: where.jurisdiction,
    dpaUrl: "https://d1.awsstatic.com/legal/aws-dpa/aws-dpa.pdf",
  };
}

export function createSesMailer(options: SesMailerOptions): SesMailer {
  assertOptions(options);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const endpoint = options.endpoint ?? `https://email.${options.region}.amazonaws.com`;
  const credentials: AwsCredentials = {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
  };
  const topics = options.allowedTopicArns ?? [];

  async function signedFetch(
    method: "GET" | "POST",
    path: string,
    body: string,
  ): Promise<Response> {
    const url = new URL(path, endpoint);
    const signed = signRequest(
      {
        method,
        url,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        body,
      },
      { region: options.region, service: "ses", credentials, now: now() },
    );
    // `host` is set by the HTTP client from the URL; sending it explicitly is refused by undici.
    const { host: _host, ...headers } = signed.headers;
    return options.fetch(url, {
      method,
      headers: { ...headers, accept: "application/json" },
      ...(method === "POST" ? { body } : {}),
    });
  }

  const mailer: SesMailer = {
    driver: "ses",
    subProcessor: sesSubProcessor(options.region),
    capabilities: { perMessageTracking: false, webhooks: topics.length > 0 },

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
      const tags: { Name: string; Value: string }[] = [];
      const seen = new Set<string>();
      for (const raw of message.tags ?? []) {
        const name = raw.replace(TAG_RE, "_").slice(0, 256);
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        tags.push({ Name: name, Value: "1" });
      }
      if (message.stream !== undefined && !seen.has("stream")) {
        tags.push({ Name: "stream", Value: message.stream });
      }
      if (message.idempotencyKey !== undefined && !seen.has("idempotency_key")) {
        tags.push({ Name: "idempotency_key", Value: keyDigest(message.idempotencyKey) });
      }
      const utf8 = (Data: string) => ({ Data, Charset: "UTF-8" });
      const body = JSON.stringify({
        FromEmailAddress: from,
        Destination: { ToAddresses: [message.to] },
        ...(replyTo !== undefined ? { ReplyToAddresses: [replyTo] } : {}),
        Content: {
          Simple: {
            Subject: utf8(message.subject),
            Body: {
              Text: utf8(message.text),
              ...(message.html !== undefined ? { Html: utf8(message.html) } : {}),
            },
            ...(message.headers !== undefined
              ? {
                  Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
        ...(tags.length > 0 ? { EmailTags: tags.slice(0, 50) } : {}),
        ...(options.configurationSet !== undefined
          ? { ConfigurationSetName: options.configurationSet }
          : {}),
      });

      let response: Response;
      try {
        response = await signedFetch("POST", "/v2/email/outbound-emails", body);
      } catch (error) {
        log("mail.failed", {
          to: maskEmail(message.to),
          code: "connection_failed",
          durationMs: Math.round(performance.now() - started),
        });
        throw new MailerError("connection_failed", "could not reach ses", { cause: error });
      }
      if (!response.ok) {
        const failure = sendFailure(response.status, await awsErrorOf(response));
        log("mail.failed", {
          to: maskEmail(message.to),
          tags: message.tags ?? [],
          code: failure.code,
          status: response.status,
          awsError: failure.awsError,
          durationMs: Math.round(performance.now() - started),
        });
        throw failure;
      }
      let id: unknown;
      try {
        id = ((await response.json()) as { MessageId?: unknown }).MessageId;
      } catch {
        id = undefined;
      }
      if (typeof id !== "string" || id.length === 0) {
        throw new MailerError("send_failed", "ses answered without a MessageId", {
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
     * Signed `GET /v2/email/account`. A policy granting only `ses:SendEmail` answers
     * `AccessDeniedException` — which still proves the signature and key are good, so that is
     * healthy. Sending paused on the account is not.
     */
    async healthCheck(): Promise<void> {
      let response: Response;
      try {
        response = await signedFetch("GET", "/v2/email/account", "");
      } catch (error) {
        throw new MailerError("connection_failed", "ses is not reachable", { cause: error });
      }
      if (response.ok) {
        let enabled: unknown;
        try {
          enabled = ((await response.json()) as { SendingEnabled?: unknown }).SendingEnabled;
        } catch {
          enabled = undefined;
        }
        if (enabled === false) {
          throw new MailerError("rejected", "ses sending is paused for this account", {
            status: response.status,
          });
        }
        return;
      }
      const awsError = await awsErrorOf(response);
      if (response.status === 403 && awsError === "AccessDeniedException") return;
      throw sendFailure(response.status, awsError);
    },
  };

  if (topics.length === 0) return mailer;

  const verifier = createSnsVerifier({
    allowedTopicArns: topics,
    fetch: options.fetch,
    now,
    maxAgeMs: options.snsMaxAgeMs ?? DEFAULT_SNS_MAX_AGE_MS,
  });

  return {
    ...mailer,
    async parseWebhook(request: Request): Promise<readonly MailDeliveryEvent[] | undefined> {
      const verified = await verifier.verify(await request.text());
      if (!verified.ok) {
        log("mail.webhook_bad_signature", { provider: "ses", reason: verified.reason });
        return undefined;
      }
      const { message, region } = verified;
      switch (message.Type) {
        case "SubscriptionConfirmation": {
          const subscribeUrl = message.SubscribeURL;
          if (subscribeUrl === undefined || !isSnsUrl(subscribeUrl, region)) {
            log("mail.webhook_bad_signature", { provider: "ses", reason: "subscribe_url" });
            return undefined;
          }
          let response: Response;
          try {
            response = await options.fetch(subscribeUrl, { method: "GET" });
          } catch (error) {
            throw new MailerError("connection_failed", "could not confirm the SNS subscription", {
              cause: error,
            });
          }
          response.body?.cancel().catch(() => {});
          if (!response.ok) {
            throw new MailerError(
              "connection_failed",
              `SNS refused the subscription confirmation (HTTP ${response.status})`,
              { status: response.status },
            );
          }
          log("mail.sns_subscribed", { provider: "ses", topicArn: message.TopicArn });
          return [];
        }
        case "UnsubscribeConfirmation":
          log("mail.sns_unsubscribed", { provider: "ses", topicArn: message.TopicArn });
          return [];
        default: {
          let payload: unknown;
          try {
            payload = JSON.parse(message.Message) as unknown;
          } catch {
            log("mail.webhook_malformed", { provider: "ses" });
            return [];
          }
          return parseSesEvent(payload, now());
        }
      }
    },
  };
}
