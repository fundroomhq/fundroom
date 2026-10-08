import { t } from "@fundroom/i18n";
import type { OutboundEmail } from "@fundroom/ports";

/*
 * `billing-past-due` (E3.10 §5.4): to each owner when a workspace's subscription enters its grace
 * period — a failed payment (`past_due` / `unpaid` / `paused`), a cancellation, or a trial that
 * ended with no subscription behind it. The kernel mail pattern (see `cli-commands/break-glass.ts`):
 * the sentences come from the server catalogue (`@fundroom/i18n`, `billing.past_due.*`) in the
 * owner's language, and the HTML part is the generic `notification` template of the same
 * paragraphs. It names the deadline and links the billing page on the workspace's BASE_URL host,
 * nothing else: no amount, no card, no provider detail.
 *
 * `transactional`: an owner whose address once bounced must still hear that the workspace is
 * about to close.
 */
export interface BillingPastDueInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly graceUntil: Date;
  /** `workspaceUrl(ws, "/admin/billing")`, never a custom domain. */
  readonly billingUrl: string;
  readonly locale: string;
}

/** `2026-10-11 14:00 UTC`: unambiguous in every language the catalogue has. */
export function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function billingPastDueEmail(to: string, input: BillingPastDueInput): OutboundEmail {
  const vars = { workspace: input.workspaceName };
  const title = t(input.locale, "billing.past_due.title", vars);
  const paragraphs = [
    t(input.locale, "billing.past_due.intro", vars),
    t(input.locale, "billing.past_due.deadline", { deadline: utcMinute(input.graceUntil) }),
    t(input.locale, "billing.past_due.action"),
  ];
  const cta = { label: t(input.locale, "billing.past_due.cta"), url: input.billingUrl };
  return {
    to,
    workspaceId: input.workspaceId,
    subject: t(input.locale, "billing.past_due.subject", vars),
    text: [title, ...paragraphs, `${cta.label}: ${cta.url}`].join("\n\n"),
    template: { name: "notification", props: { title, paragraphs, cta, locale: input.locale } },
    tags: ["billing", "past-due"],
    stream: "transactional",
  };
}
