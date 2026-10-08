/**
 * `@fundroom/integration-calcom` — Cal.com signed booking webhooks (BOOKING_CREATED / CANCELLED /
 * RESCHEDULED) (E3.6, ADR-0054). Connection-less: the only secret is our webhook signing secret.
 */
export {
  CALCOM_ACCOUNT_LABEL,
  CALCOM_SIGNATURE_HEADER,
  CALCOM_TRIGGERS,
  calcomMeta,
  createCalcomAdapter,
  parseCalcomWebhook,
} from "./adapter.js";
