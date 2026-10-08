export {
  brandTitle,
  DEFAULT_ACCENT,
  type EmailBrand,
  safeBrand,
  TAGLINE_MAX_LENGTH,
} from "./brand.js";
export {
  type ClassifyOptions,
  classifyEngagement,
  type EngagementReason,
  type EngagementVerdict,
  isProviderSuppression,
  isUnsubscribeLink,
  LINK_MAX_LENGTH,
  PROVIDER_SUPPRESSED_PREFIX,
  type StripLinkOptions,
  stripLink,
  TOO_FAST_CLICK_MS,
} from "./engagement.js";
export {
  createLogMailer,
  createMemoryMailer,
  createTemplatedMailer,
  type EmailBrandResolver,
  type LogMailerOptions,
  type MemoryMailer,
  type TemplatedMailerOptions,
} from "./mailers.js";
export {
  hasTemplate,
  type RenderedEmail,
  registerTemplate,
  renderTemplate,
  TEMPLATE_NAMES,
  type TemplateComponent,
  TemplateError,
  type TemplateName,
  type TemplateProps,
} from "./render.js";
export type {
  AccessRequestCodeProps,
  AccessRequestDeniedProps,
  AccessRequestExistingProps,
  InviteProps,
  MagicLinkProps,
  NewDeviceProps,
  OtpProps,
  ShareLinkOtpProps,
} from "./templates/auth.js";
export type { NotificationProps } from "./templates/notification.js";
