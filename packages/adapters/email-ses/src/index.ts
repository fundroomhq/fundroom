export {
  createSesMailer,
  DEFAULT_SNS_MAX_AGE_MS,
  formatAddress,
  type MailAddress,
  MailerError,
  type MailerErrorCode,
  maskEmail,
  PROVIDER_SUPPRESSED_PREFIX,
  parseSesEvent,
  type SesMailer,
  type SesMailerOptions,
  sesSubProcessor,
} from "./ses-mailer.js";
export { type AwsCredentials, amzDate, signingKey, signRequest } from "./sigv4.js";
export {
  createSnsVerifier,
  isSnsCertUrl,
  isSnsUrl,
  type SnsMessage,
  type SnsRejection,
  type SnsVerifier,
  type SnsVerifyResult,
  stringToSign,
  topicRegion,
} from "./sns.js";
