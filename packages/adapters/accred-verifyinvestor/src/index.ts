/*
 * `@fundroom/accred-verifyinvestor` (E3.7, ADR-0055): AccreditationVendorPort over the
 * VerifyInvestor.com API — invitation start, verification-request status, certificate download,
 * signed callbacks.
 */
export {
  createVerifyInvestorPort,
  mapVerifyInvestorStatus,
  parseVerifiedExpiresAt,
  verifyInvestorAdapter,
  verifyInvestorCredentialFields,
  verifyInvestorMeta,
} from "./adapter.js";
