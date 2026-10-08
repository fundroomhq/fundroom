export {
  type CustomDomainRejection,
  checkHostname,
  type HostnameCheck,
  normalizeHostname,
} from "./hostname.js";
export { CHALLENGE_LABEL, expectedRecords, LEGACY_CHALLENGE_LABEL } from "./records.js";
export {
  type AttemptFacts,
  CustomDomainRepo,
  type DomainAnswerRecord,
  findIssuableByHostname,
  type IssuableDomain,
  isHostnameHeld,
  LAST_ANSWER_SCHEMA_VERSION,
  listDomainsForSweep,
  lockHostname,
  type ProviderFacts,
  type SweepRow,
} from "./repos/domains-repo.js";
export {
  type Actor,
  type CheckOptions,
  CUSTOM_DOMAIN_CONSTRAINTS,
  CUSTOM_DOMAIN_ERROR_CODES,
  type CustomDomainConstraint,
  type CustomDomainDb,
  type CustomDomainDeps,
  CustomDomainError,
  type CustomDomainErrorCode,
  type CustomDomainService,
  type CustomDomainStore,
  type CustomDomainView,
  createCustomDomainService,
  type DomainCaches,
  isCustomDomainError,
  JOB_PROVIDER_RELEASE,
  PROVIDER_RECHECK_MS,
  type ProviderReleaseJob,
  uniqueViolationOf,
} from "./service/domains.js";
export {
  createDomainJobs,
  type DomainJobsOptions,
  isDueForProviderPoll,
  isDueForVerify,
  JOB_REVERIFY,
  JOB_VERIFY,
  providerPollIntervalMs,
  runProviderRelease,
  runReverifySweep,
  runVerifySweep,
  VERIFY_BACKOFF_BASE_MS,
  VERIFY_BACKOFF_MAX_MS,
  verifyBackoffMs,
} from "./service/jobs.js";
export {
  type CustomDomainLookup,
  type CustomDomainLookupOptions,
  createCustomDomainLookup,
  LOOKUP_CACHE_MAX,
  LOOKUP_TTL_MS,
} from "./service/lookup.js";
export {
  CUSTOM_DOMAIN_STATUSES,
  type CustomDomainStatus,
  nextState,
  REVERIFY_GRACE,
  type StateInput,
  type StateResult,
  VERIFY_DEADLINE_MS,
} from "./state.js";
export { challengeToken } from "./token.js";
export { type DnsVerdict, evaluate, txtCarriesToken } from "./verify.js";
