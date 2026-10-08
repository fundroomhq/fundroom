/**
 * `@fundroom/integration-stripe` — Stripe API over a restricted key: gross and net volume, new
 * customers, MRR and active subscriptions (E3.6, ADR-0054). See README.md.
 */
export {
  createStripeAdapter,
  currencyExponent,
  STRIPE_API_VERSION,
  STRIPE_MAX_PAGES_PER_READ,
  STRIPE_PAGES_PER_MONTH,
  type StripeAdapterOptions,
  stripeMeta,
  stripeMetrics,
} from "./stripe.js";
