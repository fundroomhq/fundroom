/**
 * `@fundroom/integrations` — kernel integrations hub (E3.6, ADR-0054): third-party connections
 * with sealed credentials, the OAuth 2.0 authorization-code flow with browser binding,
 * refresh-token rotation under a lease, connection health, booking links, verified booking
 * webhooks, and the `ModuleServices.integrations` port.
 */
export {
  integrationSubjectBookings,
  lockIntegrationBookingsOfMember,
  pseudonymiseIntegrationBookingsOfMember,
} from "./erasure.js";
export {
  INTEGRATION_ERROR_STATUS,
  IntegrationError,
  type IntegrationErrorCode,
  isIntegrationError,
} from "./errors.js";
export {
  audienceAdmits,
  BOOKING_LINK_MAX,
  bookingUpdate,
  checkBookingLinkUrl,
  checkReturnPath,
  checkSecretCredentials,
  DEGRADED_AFTER_FAILURES,
  decodeBookingCursor,
  encodeBookingCursor,
  failureText,
  nextHealth,
  parseAccounts,
  pkceChallenge,
  stripeKeyEnvironment,
} from "./policy.js";
export {
  BOOKING_RETENTION_DAYS,
  createIntegrationsService,
  OAUTH_OPEN_PER_MEMBER,
} from "./service.js";
export {
  type BookingSuppressionKeys,
  bookingSuppressionChecker,
  SUPPRESSION_KEY_PURPOSE,
  suppressBookingEmails,
} from "./suppression.js";
export {
  BOOKING_WEBHOOK_PATH_PREFIX,
  type BookingLinkAudience,
  type BookingLinkInput,
  type BookingLinkPublic,
  type BookingLinkView,
  type BookingProvider,
  type BookingWebhookOutcome,
  DEFAULT_RETURN_PATH,
  INTEGRATION_CRONS,
  INTEGRATION_JOBS,
  INTEGRATION_KEY_PURPOSE,
  type IntegrationAccountRef,
  type IntegrationActor,
  type IntegrationBookingRecord,
  type IntegrationBookingView,
  type IntegrationConnectGate,
  type IntegrationConnectionSummary,
  type IntegrationConnectionView,
  type IntegrationProviderInfo,
  type IntegrationServices,
  type IntegrationsKernel,
  type IntegrationsServiceDeps,
  OAUTH_CALLBACK_PATH,
  OAUTH_START_PATH,
  type OAuthStartError,
} from "./types.js";

/** Kept for the placeholder test and tooling that names the package. */
export const INTEGRATIONS_PACKAGE = "@fundroom/integrations";
