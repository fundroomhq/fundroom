/**
 * `@fundroom/integration-quickbooks` — QuickBooks Online accounting API: monthly revenue,
 * expenses, net income and cash (E3.6, ADR-0054). See README.md.
 */
export {
  createQuickbooksAdapter,
  QUICKBOOKS_MINOR_VERSION,
  type QuickbooksAdapterOptions,
  quickbooksMeta,
  quickbooksMetrics,
} from "./quickbooks.js";
