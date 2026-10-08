/*
 * `@fundroom/accreditation` (E3.7, ADR-0055) — the kernel accreditation-vendor service: the
 * per-workspace vendor connection (sealed credentials), `ModuleServices.accreditation` (effective
 * provider; vendor start/check/evidence outside transactions) and the ops callback wake-up.
 */
export {
  ACCREDITATION_ERROR_STATUS,
  AccreditationError,
  type AccreditationErrorCode,
  isAccreditationError,
} from "./errors.js";
export {
  accreditationCallbackUrl,
  boundRefs,
  checkCredentials,
  credentialHint,
  credentialHints,
  isUuid,
  MAX_CALLBACK_REFS,
  providerDetail,
} from "./policy.js";
export { createAccreditationService } from "./service.js";
export {
  ACCREDITATION_KEY_PURPOSE,
  type AccreditationActor,
  type AccreditationCallbackOutcome,
  type AccreditationConnectionDetail,
  type AccreditationKernel,
  type AccreditationProviderInfo,
  type AccreditationServiceDeps,
  MANUAL_LABEL,
  type SaveAccreditationConnectionInput,
} from "./types.js";
