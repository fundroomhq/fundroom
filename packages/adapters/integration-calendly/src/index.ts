/**
 * `@fundroom/integration-calendly` — Calendly personal access token + signed booking webhooks
 * (invitee.created / invitee.canceled) (E3.6, ADR-0054). Stateless; the kernel owns the token.
 */
export {
  CALENDLY_API_BASE_URL,
  CALENDLY_EVENTS,
  CALENDLY_SIGNATURE_HEADER,
  CALENDLY_SIGNATURE_TOLERANCE_MS,
  type CalendlyAdapterOptions,
  calendlyMeta,
  createCalendlyAdapter,
  parseCalendlyWebhook,
} from "./adapter.js";
