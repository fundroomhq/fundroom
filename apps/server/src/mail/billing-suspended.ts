import { t } from "@fundroom/i18n";
import type { OutboundEmail } from "@fundroom/ports";

/*
 * `billing-suspended` (E3.10 §5.4): to each owner when `billing.enforce` suspended the workspace
 * after its grace period. Same pattern as `billing-past-due.ts`: catalogue sentences
 * (`billing.suspended.*`) in the owner's language, the generic `notification` template for the
 * HTML part, a link to the billing page on the BASE_URL host (which a suspended workspace still
 * serves to billing holders), `transactional` so no suppression swallows it.
 */
export interface BillingSuspendedInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** `workspaceUrl(ws, "/admin/billing")`, never a custom domain. */
  readonly billingUrl: string;
  readonly locale: string;
}

export function billingSuspendedEmail(to: string, input: BillingSuspendedInput): OutboundEmail {
  const vars = { workspace: input.workspaceName };
  const title = t(input.locale, "billing.suspended.title", vars);
  const paragraphs = [
    t(input.locale, "billing.suspended.intro", vars),
    t(input.locale, "billing.suspended.effect"),
    t(input.locale, "billing.suspended.data"),
  ];
  const cta = { label: t(input.locale, "billing.suspended.cta"), url: input.billingUrl };
  return {
    to,
    workspaceId: input.workspaceId,
    subject: t(input.locale, "billing.suspended.subject", vars),
    text: [title, ...paragraphs, `${cta.label}: ${cta.url}`].join("\n\n"),
    template: { name: "notification", props: { title, paragraphs, cta, locale: input.locale } },
    tags: ["billing", "suspended"],
    stream: "transactional",
  };
}
