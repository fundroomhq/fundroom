import {
  isOperatorRunEndpoint,
  type MailerPort,
  type OutboundEmail,
  type SentEmail,
  type SubProcessorMeta,
} from "@fundroom/ports";
import { createTransport, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

/*
 * `MailerPort` over nodemailer SMTP (EXECUTION_PLAN §5.2, design/01 §2 "SMTP is the only
 * zero-vendor default", E0.5). Dev uses Mailpit (`smtp://localhost:1025`); production points
 * at the company's relay or an ESP's SMTP endpoint. ESP-native adapters (Resend, SES,
 * Postmark) implement the same port with webhooks; this one has none — bounces come back
 * as mail to the return path.
 *
 * The connection URL is nodemailer's: `smtp://user:pass@host:587` (STARTTLS when offered),
 * `smtps://host:465` (implicit TLS). Query flags map to transport options, e.g.
 * `?requireTLS=true` (refuse to send in the clear), `?pool=true`, `?tls.rejectUnauthorized=false`
 * (self-signed relays on a LAN; never in prod).
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

export type MailerErrorCode = "invalid_options" | "connection_failed" | "send_failed";

export class MailerError extends Error {
  override readonly name = "MailerError";
  constructor(
    readonly code: MailerErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface SmtpAddress {
  readonly address: string;
  readonly name?: string | undefined;
}

export interface SmtpMailerOptions {
  /** `smtp://` or `smtps://` URL; `SMTP_URL` from config. */
  readonly url: string;
  /** `MAIL_FROM` (+ `MAIL_FROM_NAME`). */
  readonly from: SmtpAddress;
  readonly replyTo?: string | undefined;
  /** Keep connections open between sends (bulk sends from the worker). Default false. */
  readonly pool?: boolean | undefined;
  readonly connectionTimeoutMs?: number | undefined;
  readonly socketTimeoutMs?: number | undefined;
  /** Never receives addresses in full, subjects or bodies. */
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SmtpMailer extends MailerPort {
  readonly driver: "smtp";
  /** Closes pooled connections; idempotent. */
  close(): void;
}

const SMTP_URL_RE = /^smtps?:\/\/\S+$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** `a***@example.com`: enough to correlate a log line without recording the address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function assertOptions(options: SmtpMailerOptions): void {
  if (!SMTP_URL_RE.test(options.url)) {
    throw new MailerError("invalid_options", "url must be an smtp:// or smtps:// URL");
  }
  if (!EMAIL_RE.test(options.from.address)) {
    throw new MailerError("invalid_options", "from.address must be an email address");
  }
  if (options.replyTo !== undefined && !EMAIL_RE.test(options.replyTo)) {
    throw new MailerError("invalid_options", "replyTo must be an email address");
  }
}

function formatAddress(a: SmtpAddress): string {
  if (!a.name) return a.address;
  // RFC 5322 display name: quote and escape.
  return `"${a.name.replace(/["\\]/gu, "\\$&")}" <${a.address}>`;
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "EDNS", "ENOTFOUND", "EAUTH"].includes(
      code,
    )
  );
}

/**
 * E3.11: who relays mail for an SMTP_URL. A relay next to the app (localhost, a private address,
 * a compose service name) is the operator's own → `null`. Any public host (SendGrid, Mailgun,
 * Gmail, an ISP relay…) is a third party the software cannot name: it is listed as an
 * unidentified relay with jurisdiction `varies`, never with its hostname.
 */
export function smtpSubProcessor(url: string): SubProcessorMeta | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host.length > 0 && isOperatorRunEndpoint(host)) return null;
  return {
    name: "Email relay (SMTP, not identified)",
    purpose: "Email delivery (sign-in codes, invitations, updates, notifications)",
    dataProcessed: "Recipient email addresses and names, message subjects and content",
    location: "Not identified by the software",
    jurisdiction: "varies",
  };
}

export function createSmtpMailer(options: SmtpMailerOptions): SmtpMailer {
  assertOptions(options);
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());

  const transportOptions: SMTPTransport.Options = {
    url: options.url,
    connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    greetingTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
    ...(options.pool ? { pool: true } : {}),
  };
  // nodemailer merges `url` into the options when it is given as a field.
  const transport: Transporter<SMTPTransport.SentMessageInfo> = createTransport(transportOptions);
  const from = formatAddress(options.from);

  return {
    driver: "smtp",
    subProcessor: smtpSubProcessor(options.url),

    async send(message: OutboundEmail): Promise<SentEmail> {
      if (!EMAIL_RE.test(message.to)) {
        throw new MailerError("send_failed", "recipient is not an email address");
      }
      const started = performance.now();
      const replyTo = message.replyTo ?? options.replyTo;
      try {
        const info = await transport.sendMail({
          from: message.from
            ? formatAddress({
                address: message.from.address,
                name: message.from.name ?? options.from.name,
              })
            : from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
          ...(replyTo !== undefined ? { replyTo } : {}),
          ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
          ...(message.dkim !== undefined ? { dkim: { ...message.dkim } } : {}),
        });
        const acceptedAt = now();
        if (info.rejected.length > 0) {
          throw new MailerError("send_failed", "the server rejected the recipient");
        }
        log("mail.sent", {
          messageId: info.messageId,
          to: maskEmail(message.to),
          tags: message.tags ?? [],
          durationMs: Math.round(performance.now() - started),
        });
        return { messageId: info.messageId, acceptedAt };
      } catch (error) {
        const wrapped =
          error instanceof MailerError
            ? error
            : new MailerError(
                isConnectionError(error) ? "connection_failed" : "send_failed",
                "could not send the message",
                { cause: error },
              );
        log("mail.failed", {
          to: maskEmail(message.to),
          tags: message.tags ?? [],
          code: wrapped.code,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Math.round(performance.now() - started),
        });
        throw wrapped;
      }
    },

    async healthCheck(): Promise<void> {
      try {
        await transport.verify();
      } catch (error) {
        throw new MailerError("connection_failed", "SMTP server is not reachable", {
          cause: error,
        });
      }
    },

    close(): void {
      transport.close();
    },
  };
}
