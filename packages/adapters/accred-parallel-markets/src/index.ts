/*
 * `@fundroom/accred-parallel-markets` (E3.7, ADR-0055): AccreditationVendorPort over the
 * Parallel Markets Server API v2 — profile-first partner record + JS SDK widget handoff,
 * accreditation status, certification-letter download, signed callbacks.
 */
export {
  createParallelMarketsPort,
  mapParallelStatus,
  parallelMarketsAdapter,
  parallelMarketsCredentialFields,
  parallelMarketsMeta,
  pickAccreditation,
} from "./adapter.js";
