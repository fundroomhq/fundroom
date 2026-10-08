export type { ESignRequestInput, ESignSubjectRef } from "@fundroom/module-kit";
export {
  consentData,
  ESIGN_CONSENT_KIND,
  ESIGN_DISCLOSURE_SHA256,
  ESIGN_DISCLOSURE_TEXT,
  ESIGN_DISCLOSURE_VERSION,
  type ESignConsentData,
} from "./consent.js";
export {
  esignSubjectEnvelopes,
  lockESignEnvelopesOfMember,
  pseudonymiseESignEnvelopesOfMember,
} from "./erasure.js";
export {
  ESIGN_ERROR_STATUS,
  ESignError,
  type ESignErrorCode,
  isESignError,
} from "./errors.js";
export { assertESignConnected } from "./guards.js";
export {
  assertNdaTextRenderable,
  markdownBlocks,
  NDA_PAGE_HEIGHT,
  NDA_PAGE_WIDTH,
  NDA_SIGNATURE_BOXES,
  type NdaPdf,
  type NdaPdfInput,
  type NdaTextProblem,
  ndaSignatureFields,
  ndaTextProblem,
  renderNdaPdf,
  winAnsiUnsupported,
} from "./nda-pdf.js";
export {
  checkBaseUrl,
  checkCredentials,
  credentialHint,
  credentialHints,
  decodeEnvelopeCursor,
  ESIGN_CALLBACK_PATH_PREFIX,
  encodeEnvelopeCursor,
  esignCallbackUrl,
  isOpen,
  isTerminal,
  nextEnvelopeStatus,
  nextSignerStatus,
  SYNC_BACKOFF_MS,
  SYNC_GRACE_MAX_DELAY_MS,
  SYNC_GRACE_MS,
  SYNC_MAX_AGE_MS,
  syncDelayMs,
} from "./policy.js";
export {
  asProviderError,
  createESignJobs,
  createESignService,
  ndaStatusOf,
  toEnvelopeView,
} from "./service.js";
export {
  type Assess,
  type AssessVerdict,
  type CallbackOutcome,
  type EnvelopeListQuery,
  ESIGN_JOBS,
  ESIGN_KEY_PURPOSES,
  ESIGN_SYNC_DUE_CRON,
  type ESignAcceptances,
  type ESignActor,
  type ESignConnectionDetail,
  type ESignConnectionSummary,
  type ESignDriverInfo,
  type ESignEnvelopeRowStatus,
  type ESignEnvelopeView,
  type ESignKernel,
  type ESignLegal,
  type ESignOutbound,
  type ESignPurpose,
  type ESignServiceDeps,
  type ESignServices,
  NDA_VAULT_FOLDER,
  type NdaStatus,
  type SaveConnectionInput,
  type StartNdaInput,
} from "./types.js";
export { createUnconfiguredESignServices } from "./unconfigured.js";
