/*
 * `@fundroom/sso` (E3.8, ADR-0056) — the kernel staff SSO service: the per-workspace OIDC or SAML
 * connection (sealed client secret, IdP metadata), DNS-verified email domains, the SP-initiated
 * login flow with its canonical-host handoff, identity linking / JIT, and enforcement.
 */
export {
  emailDomain,
  evaluateTxt,
  LEGACY_SSO_TXT_LABEL,
  LEGACY_SSO_TXT_PREFIX,
  legacyTxtName,
  normalizeSsoDomain,
  SSO_MAX_DOMAINS,
  SSO_TXT_LABEL,
  SSO_TXT_PREFIX,
  txtName,
  txtValue,
} from "./domains.js";
export {
  isSsoError,
  SSO_ERROR_STATUS,
  SSO_FLOW_ERROR_CODES,
  SsoError,
  type SsoErrorCode,
  SsoFlowError,
  type SsoFlowErrorCode,
} from "./errors.js";
export {
  decideSsoLogin,
  type LinkDecision,
  type LinkFacts,
  type LinkMembershipFact,
  type SsoRefusal,
} from "./linking.js";
export { cleanMfaValues, oidcLoginLevel, type SsoMfaOptions, samlLoginLevel } from "./mfa.js";
export { checkIssuer, OIDC_DISCOVERY_TTL_MS, OidcConfigError } from "./oidc.js";
export {
  type AssertionExpectations,
  type CheckedAssertion,
  checkAssertion,
  checkResponse,
  SAML_CLOCK_SKEW_MS,
  SamlAssertionError,
  samlIdentityClaims,
} from "./saml/checks.js";
export {
  type CertificateInfo,
  checkCertificates,
  type IdpMetadata,
  inspectCertificate,
  METADATA_MAX_BYTES,
  parseIdpMetadata,
  SamlConfigError,
  toPem,
} from "./saml/metadata.js";
export { spMetadataXml } from "./saml/sp.js";
export { createSsoService, stateTurnsOn } from "./service.js";
export {
  type SaveSsoConnectionInput,
  SSO_KEY_PURPOSE,
  type SsoActor,
  type SsoBeginInput,
  type SsoBeginResult,
  type SsoConnectionView,
  type SsoCtx,
  type SsoDomainView,
  type SsoFinishInput,
  type SsoFinishResult,
  type SsoIdentityWiring,
  type SsoProtocol,
  type SsoPublicInfo,
  type SsoSaveOptions,
  type SsoService,
  type SsoServiceDeps,
  type SsoSpInfo,
  type SsoStateOptions,
  type StaffJitRole,
} from "./types.js";
