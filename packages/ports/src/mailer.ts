/**
 * Outbound email (EXECUTION_PLAN §5.2 `MailerPort`). Default adapter `@fundroom/email-smtp`
 * (nodemailer; Mailpit in dev). `@fundroom/mail` renders React Email templates into
 * `html` for messages that name one; the plain-text body is always present and is the
 * source of truth for wording (accessibility, text-only clients).
 */
import type { SubProcessorMeta } from "./residency.js";
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
  /**
   * Template the mail package renders into `html` when the composition root wraps the
   * mailer with `createTemplatedMailer`. Props are plain JSON: no functions, no dates.
   */
  readonly template?:
    | { readonly name: string; readonly props: Readonly<Record<string, unknown>> }
    | undefined;
  /** Free-form tags for the ESP / logs, e.g. `["auth", "otp"]`. Never PII. */
  readonly tags?: readonly string[] | undefined;
  /** Extra headers such as `List-Unsubscribe`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Overrides the adapter default (`MAIL_FROM`); used for per-workspace senders later. */
  readonly replyTo?: string | undefined;
  /**
   * Per-workspace sender (E1.4): only set once the workspace's sending domain is verified,
   * otherwise the adapter default applies. Adapters that cannot honour it keep their default.
   */
  readonly from?: { readonly address: string; readonly name?: string | undefined } | undefined;
  /** DKIM signature for `from.address`'s domain; the SMTP adapter signs, ESPs manage their own. */
  readonly dkim?:
    | { readonly domainName: string; readonly keySelector: string; readonly privateKey: string }
    | undefined;
  /** Dedupe/tracking key echoed by adapters that support it (ESP idempotency). */
  readonly idempotencyKey?: string | undefined;
  /**
   * Workspace this message is sent on behalf of (E1.7): the key the composition root's brand
   * resolver looks branding settings up by. Optional — instance-level mail (operator alerts,
   * sign-in to no workspace in particular) has none and falls back to the default brand.
   * It is a field of its own rather than a convention inside `tags` because `tags` is
   * free-form ESP metadata and sniffing an id out of it would be guesswork; `from` and `dkim`
   * already carry per-workspace facts on this interface, so this is the established shape.
   */
  readonly workspaceId?: string | undefined;
  /**
   * Which stream this message belongs to (E2.6). `transactional` (sign-in codes, invites, share
   * link OTPs) is never suppressed: a person whose address once bounced must still be able to
   * sign in. `broadcast` (investor updates) and `notification` (staff alerts and digests) are
   * checked against the workspace's suppression list by the composition root before they reach
   * the adapter, and a suppressed send fails with `MailSuppressedError` rather than silently
   * vanishing. Absent means `transactional`.
   */
  readonly stream?: MailStream | undefined;
  /**
   * Engagement tracking the sender asks the provider for (E2.6, design/04 §3.2). Set only when
   * the workspace's analytics mode is `engagement` *and* the recipient's `email_tracking`
   * consent allows it. Adapters that can switch tracking per message (Postmark) honour it;
   * adapters that cannot (`capabilities.perMessageTracking === false`) ignore it and the webhook
   * ingress discards open/click events for anyone who did not consent. Absent = no tracking.
   */
  readonly tracking?: { readonly opens: boolean; readonly clicks: boolean } | undefined;
  /**
   * What this message is about, recorded beside the provider message id so a later delivery
   * event can be routed back to a workspace, a resource and a member without the webhook
   * carrying anything but the id. Ids only — never an address or a title.
   */
  readonly ref?:
    | {
        readonly kind: string;
        readonly id: string;
        readonly membershipId?: string | undefined;
      }
    | undefined;
}

export type MailStream = "transactional" | "broadcast" | "notification";

/**
 * Thrown by the composition root's suppression wrapper (never by an adapter) when a
 * `broadcast`/`notification` message is addressed to an address the workspace has suppressed
 * after a hard bounce or complaint. Callers mark the recipient `skipped`, not `failed`.
 *
 * `provider`: an ESP adapter may also throw it (reason `provider`) when the provider itself
 * refuses the recipient as suppressed on its side (Postmark `406 Inactive recipient`), because
 * that is the same fact seen from the other end and the caller must treat it the same way.
 */
export class MailSuppressedError extends Error {
  override readonly name = "MailSuppressedError";
  readonly code = "suppressed" as const;
  constructor(readonly reason: "bounce" | "complaint" | "manual" | "provider") {
    super(`recipient suppressed (${reason})`);
  }
}

export interface SentEmail {
  /** Provider message id (SMTP `Message-ID`, ESP id); correlates delivery events. */
  readonly messageId: string;
  readonly acceptedAt: Date;
}

/**
 * Delivery feedback (bounces, complaints, deliveries) as ESP webhooks report it. The SMTP
 * adapter produces none (bounces arrive as mail to the return path); Resend/SES/Postmark
 * adapters (E2.6) parse their webhook into this shape and the notifications module
 * suppresses further sends to hard-bounced or complaining addresses.
 */
export type MailDeliveryEventKind =
  | "delivered"
  | "bounce"
  | "complaint"
  | "delay"
  | "open"
  | "click";

export interface MailDeliveryEvent {
  readonly kind: MailDeliveryEventKind;
  /** `hard` bounces suppress the address; `soft` ones are retried by the provider. */
  readonly bounceType?: "hard" | "soft" | undefined;
  readonly recipient: string;
  readonly messageId: string | undefined;
  readonly occurredAt: Date;
  /** Provider diagnostic, e.g. `550 5.1.1 user unknown`. */
  readonly reason: string | undefined;
  readonly provider: string;
  /** `click` only: the URL the recipient followed, as the provider reports it. */
  readonly url?: string | undefined;
  /**
   * `open`/`click` only: the provider's own verdict that a machine, not a person, produced the
   * event (Apple Mail Privacy Protection prefetch, a security scanner following links). `undefined`
   * when the provider says nothing; `classifyEngagement` in `@fundroom/mail` folds this with the
   * user agent and timing into the `automated` flag that analytics stores.
   */
  readonly machine?: boolean | undefined;
  /** `open`/`click` only: the user agent the provider saw, for MPP/scanner classification. Not stored. */
  readonly userAgent?: string | undefined;
}

export interface MailerCapabilities {
  /** The adapter can turn open/click tracking on or off per message (`OutboundEmail.tracking`). */
  readonly perMessageTracking: boolean;
  /** The adapter implements `parseWebhook`. */
  readonly webhooks: boolean;
}

export interface MailerPort {
  readonly driver: string;
  /**
   * E3.11: the third party this adapter sends tenant data to, for the residency page and the
   * DPA's sub-processor list. `null` = none (the operator's own infrastructure); absent = the
   * adapter does not say (test doubles).
   */
  readonly subProcessor?: SubProcessorMeta | null | undefined;
  /** Absent = `{ perMessageTracking: false, webhooks: false }` (SMTP, memory, log). */
  readonly capabilities?: MailerCapabilities | undefined;
  send(message: OutboundEmail): Promise<SentEmail>;
  /**
   * Parses a provider webhook (signature verified by the adapter) into delivery events.
   * Absent on adapters without webhooks. `undefined` result = signature invalid, respond 401.
   */
  parseWebhook?(request: Request): Promise<readonly MailDeliveryEvent[] | undefined>;
  /** SMTP `NOOP`/connection check or ESP auth probe for `/readyz`. */
  healthCheck(): Promise<void>;
}
