import type { MailerPort, OutboundEmail, SentEmail } from "@fundroom/ports";
import type { EmailBrand } from "./brand.js";
import { hasTemplate, renderTemplate } from "./render.js";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** Resolves the brand for one message; may be async, see `TemplatedMailerOptions.brand`. */
export type EmailBrandResolver = (message: OutboundEmail) => EmailBrand | Promise<EmailBrand>;

export interface TemplatedMailerOptions {
  /**
   * Static brand, or a resolver keyed off the message (E1.7 looks `message.workspaceId` up in
   * the workspace's `branding` settings). The resolver MAY be async, and that is the point:
   * a synchronous one could only read an in-memory cache, so the first email after every
   * restart — a cold cache, nothing to read — would silently go out unbranded while every
   * later one looked right. `renderTemplate` is already async, so awaiting here costs nothing.
   * A resolver that throws or rejects must not hold up the send: it is logged as
   * `mail.brand_failed` and the message renders with `defaultBrand`, exactly like the
   * template-failure path below — branding is never a reason to drop a sign-in code.
   */
  readonly brand: EmailBrand | EmailBrandResolver;
  /**
   * Brand used when `brand` is a resolver and the resolver fails. Defaults to the bare
   * `{ productName: "FundRoom" }`-shaped fallback only if omitted, so composition roots
   * should pass their instance brand.
   */
  readonly defaultBrand?: EmailBrand | undefined;
  readonly log?: Log | undefined;
}

const FALLBACK_BRAND: EmailBrand = { productName: "FundRoom" };

/**
 * Decorates any `MailerPort`: when a message names a known template and carries no `html`,
 * the template is rendered into `html`; the caller's `text` is always kept (it is the
 * wording of record). HTML is best-effort — an unknown template or a render failure is
 * logged and the text-only message still goes out, because a broken template must never
 * block a sign-in code.
 */
export function createTemplatedMailer(
  inner: MailerPort,
  options: TemplatedMailerOptions,
): MailerPort {
  const log = options.log ?? (() => {});
  const configured = options.brand;
  const fallbackBrand: EmailBrand =
    options.defaultBrand ?? (typeof configured === "function" ? FALLBACK_BRAND : configured);
  const resolve: EmailBrandResolver =
    typeof configured === "function" ? configured : () => configured;
  const brandFor = async (message: OutboundEmail): Promise<EmailBrand> => {
    try {
      return await resolve(message);
    } catch (error) {
      log("mail.brand_failed", {
        workspaceId: message.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackBrand;
    }
  };
  const mailer: MailerPort = {
    driver: inner.driver,
    async send(message) {
      let html = message.html;
      const template = message.template;
      if (html === undefined && template !== undefined) {
        if (!hasTemplate(template.name)) {
          log("mail.template_unknown", { template: template.name });
        } else {
          try {
            const props: Record<string, unknown> = { ...template.props };
            html = (await renderTemplate(template.name, props, await brandFor(message))).html;
          } catch (error) {
            log("mail.template_failed", {
              template: template.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return inner.send(html === undefined ? message : { ...message, html });
    },
    healthCheck: () => inner.healthCheck(),
    // E2.6: the webhook route and the updates sender read these through the wrapper.
    ...(inner.capabilities ? { capabilities: inner.capabilities } : {}),
  };
  if (inner.parseWebhook) {
    const parse = inner.parseWebhook.bind(inner);
    return { ...mailer, parseWebhook: parse };
  }
  return mailer;
}

export interface MemoryMailer extends MailerPort {
  readonly driver: "memory";
  readonly sent: OutboundEmail[];
  /**
   * Make the next `count` sends fail (default 1); tests use it for mail-down paths. With `to`,
   * only sends to that address count, so a concurrent detached mail cannot absorb the failure.
   */
  failNext(count?: number, to?: string): void;
  clear(): void;
}

/** Records messages for tests. */
export function createMemoryMailer(): MemoryMailer {
  const sent: OutboundEmail[] = [];
  let failures = 0;
  let failTo: string | undefined;
  let seq = 0;
  return {
    driver: "memory",
    sent,
    failNext(count = 1, to?: string) {
      failures = count;
      failTo = to;
    },
    clear() {
      sent.length = 0;
      failures = 0;
      failTo = undefined;
    },
    async send(message): Promise<SentEmail> {
      if (failures > 0 && (failTo === undefined || message.to === failTo)) {
        failures -= 1;
        throw new Error("memory mailer: simulated failure");
      }
      sent.push(message);
      seq += 1;
      return { messageId: `<memory-${seq}@fundroom.local>`, acceptedAt: new Date() };
    },
    async healthCheck() {},
  };
}

export interface LogMailerOptions {
  readonly log: Log;
}

/**
 * Dev-only sender for `APP_ENV=dev` without SMTP (design/07 §9: "magic links printed to
 * log only in dev"). It DELIBERATELY logs the recipient and the full text body — that is
 * the point — so the composition root must refuse to wire it outside dev/test.
 */
export function createLogMailer(options: LogMailerOptions): MailerPort {
  let seq = 0;
  return {
    driver: "log",
    async send(message): Promise<SentEmail> {
      seq += 1;
      const messageId = `<log-${seq}@fundroom.local>`;
      options.log("mail.dev_send", {
        messageId,
        to: message.to,
        subject: message.subject,
        text: message.text,
        tags: message.tags ?? [],
      });
      return { messageId, acceptedAt: new Date() };
    },
    async healthCheck() {},
  };
}
