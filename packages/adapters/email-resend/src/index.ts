export {
  createResendMailer,
  type MailAddress,
  MailerError,
  type MailerErrorCode,
  maskEmail,
  PROVIDER_SUPPRESSED_PREFIX,
  parseResendEvent,
  RESEND_API_BASE,
  RESEND_SUB_PROCESSOR,
  type ResendMailer,
  type ResendMailerOptions,
  WEBHOOK_TOLERANCE_MS,
} from "./resend-mailer.js";
