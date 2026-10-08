import type { ReactElement } from "react";
import { render } from "react-email";
import type { EmailBrand } from "./brand.js";
import {
  AccessRequestCodeEmail,
  type AccessRequestCodeProps,
  AccessRequestDeniedEmail,
  type AccessRequestDeniedProps,
  AccessRequestExistingEmail,
  type AccessRequestExistingProps,
  InviteEmail,
  type InviteProps,
  MagicLinkEmail,
  type MagicLinkProps,
  NewDeviceEmail,
  type NewDeviceProps,
  OtpEmail,
  type OtpProps,
  ShareLinkOtpEmail,
  type ShareLinkOtpProps,
} from "./templates/auth.js";
import { NotificationEmail, type NotificationProps } from "./templates/notification.js";

/**
 * Template registry. Names are `<area>.<purpose>`; the identity kernel attaches
 * `template: { name, props }` to its `OutboundEmail`s and `createTemplatedMailer` renders
 * here. Modules register extra templates through `registerTemplate` at boot.
 */
export interface TemplateProps {
  "auth.otp": OtpProps;
  "auth.magic_link": MagicLinkProps;
  "auth.new_device": NewDeviceProps;
  "auth.invite": InviteProps;
  "auth.share_link_otp": ShareLinkOtpProps;
  "auth.access_request_code": AccessRequestCodeProps;
  "auth.access_request_existing": AccessRequestExistingProps;
  "auth.access_request_denied": AccessRequestDeniedProps;
  notification: NotificationProps;
}

export type TemplateName = keyof TemplateProps;

export const TEMPLATE_NAMES: readonly TemplateName[] = [
  "auth.otp",
  "auth.magic_link",
  "auth.new_device",
  "auth.invite",
  "auth.share_link_otp",
  "auth.access_request_code",
  "auth.access_request_existing",
  "auth.access_request_denied",
  "notification",
];

export type TemplateComponent<P> = (props: P & { brand: EmailBrand }) => ReactElement;

const registry = new Map<string, TemplateComponent<never>>([
  ["auth.otp", OtpEmail as TemplateComponent<never>],
  ["auth.magic_link", MagicLinkEmail as TemplateComponent<never>],
  ["auth.new_device", NewDeviceEmail as TemplateComponent<never>],
  ["auth.invite", InviteEmail as TemplateComponent<never>],
  ["auth.share_link_otp", ShareLinkOtpEmail as TemplateComponent<never>],
  ["auth.access_request_code", AccessRequestCodeEmail as TemplateComponent<never>],
  ["auth.access_request_existing", AccessRequestExistingEmail as TemplateComponent<never>],
  ["auth.access_request_denied", AccessRequestDeniedEmail as TemplateComponent<never>],
  ["notification", NotificationEmail as TemplateComponent<never>],
]);

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/u;

/** Adds (or replaces) a template; modules call this from their manifest wiring. */
export function registerTemplate<P extends Record<string, unknown>>(
  name: string,
  component: TemplateComponent<P>,
): void {
  if (!TEMPLATE_NAME_RE.test(name))
    throw new Error(`invalid template name ${JSON.stringify(name)}`);
  registry.set(name, component as TemplateComponent<never>);
}

export function hasTemplate(name: string): boolean {
  return registry.has(name);
}

export interface RenderedEmail {
  readonly html: string;
  /** Plain-text rendering of the same tree; identity supplies its own, this is the fallback. */
  readonly text: string;
}

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

/** Renders a registered template to HTML and plain text. Throws `TemplateError` for unknown names. */
export async function renderTemplate<N extends TemplateName>(
  name: N,
  props: TemplateProps[N],
  brand: EmailBrand,
): Promise<RenderedEmail>;
export async function renderTemplate(
  name: string,
  props: Record<string, unknown>,
  brand: EmailBrand,
): Promise<RenderedEmail>;
export async function renderTemplate(
  name: string,
  props: Record<string, unknown>,
  brand: EmailBrand,
): Promise<RenderedEmail> {
  const component = registry.get(name);
  if (!component) throw new TemplateError(`unknown email template ${JSON.stringify(name)}`);
  const element = (component as TemplateComponent<Record<string, unknown>>)({ ...props, brand });
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
