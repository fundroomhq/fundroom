/*
 * `@fundroom/sso/testing`: a SAML IdP and certificate generator for tests (unit tests here, the
 * server's integration fixtures in `apps/server/src/test/sso-idp.ts`). Never imported by
 * production code.
 */
export { selfSignedCertificate, type TestCertificate } from "./cert.js";
export {
  createTestSamlIdp,
  EMAIL_NAMEID_FORMAT,
  encodeResponse,
  PERSISTENT_NAMEID_FORMAT,
  parseAuthnRequest,
  type SamlResponseOptions,
  type TestSamlIdp,
} from "./saml-idp.js";
