export {
  createSmtpMailer,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  MailerError,
  type MailerErrorCode,
  maskEmail,
  type SmtpAddress,
  type SmtpMailer,
  type SmtpMailerOptions,
  smtpSubProcessor,
} from "./smtp-mailer.js";
