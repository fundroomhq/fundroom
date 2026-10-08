import type { ESignAdapterDefinition } from "@fundroom/ports";
import { CREDENTIAL, DocusignPort } from "./docusign-port.js";

export {
  AUTH_HOSTS,
  CREDENTIAL,
  DocusignPort,
  mapEnvelopeStatus,
  tabsFor,
  validateBaseUri,
} from "./docusign-port.js";
export { JWT_LIFETIME_SECONDS, JWT_SCOPE, jwtClaims, signJwt } from "./jwt.js";
export { detectPageSize, US_LETTER } from "./pdf-pages.js";

/**
 * DocuSign eSignature (REST v2.1, OAuth JWT grant). Cloud only: the account server is chosen by the
 * `environment` credential (demo → account-d.docusign.com, production → account.docusign.com) and
 * the REST base URI comes from `/oauth/userinfo`, so there is no base-URL field.
 *
 * Callbacks: DocuSign Connect with HMAC enabled. DocuSign generates the HMAC key (up to 100 active
 * keys); the admin pastes it here — `callbackSecret: "vendor"`. A second key field allows a
 * zero-downtime rotation.
 */
export const docusignAdapter: ESignAdapterDefinition = {
  meta: {
    driver: "docusign",
    displayName: "DocuSign",
    selfHostable: false,
    baseUrl: { required: false },
    supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
    callbackSecret: "vendor",
    subProcessor: {
      name: "Docusign, Inc.",
      purpose: "Electronic signature of documents (envelopes, signer identity and audit trail)",
      region: "United States, EU, Canada or Australia (the DocuSign account's data region)",
      dpaUrl: "https://www.docusign.com/legal/terms-and-conditions/data-protection-attachment",
      jurisdiction: "varies",
      certifications: ["ISO 27001", "SOC 1 Type II", "SOC 2 Type II"],
    },
  },
  credentialFields: [
    {
      key: CREDENTIAL.environment,
      label: "Environment",
      kind: "select",
      options: ["demo", "production"],
      required: true,
      help: "demo = developer sandbox (account-d.docusign.com); production = live account (account.docusign.com).",
    },
    {
      key: CREDENTIAL.integrationKey,
      label: "Integration key",
      kind: "text",
      required: true,
      help: "Apps and Keys → your app's Integration Key (client id).",
    },
    {
      key: CREDENTIAL.userId,
      label: "API user ID",
      kind: "text",
      required: true,
      help: "Apps and Keys → User ID (GUID) of the user the integration acts as. That user must grant consent once.",
    },
    {
      key: CREDENTIAL.privateKeyPem,
      label: "RSA private key",
      kind: "pem",
      required: true,
      help: "The RSA keypair generated for the integration key (PEM, BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY).",
    },
    {
      key: CREDENTIAL.accountId,
      label: "API account ID",
      kind: "text",
      required: false,
      help: "Optional. Defaults to the user's default account.",
    },
    {
      key: CREDENTIAL.hmacKey,
      label: "Connect HMAC key",
      kind: "secret",
      required: true,
      help: "Settings → Connect → Connect keys → Add secret key. Enable 'Include HMAC signature' on the Connect configuration.",
    },
    {
      key: CREDENTIAL.hmacKeySecondary,
      label: "Second Connect HMAC key (rotation)",
      kind: "secret",
      required: false,
      help: "Optional. During a key rotation, callbacks signed with either key are accepted.",
    },
  ],
  create(config, deps) {
    return new DocusignPort(config, deps);
  },
};
