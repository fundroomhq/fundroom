import type { ESignAdapterDefinition } from "@fundroom/ports";
import { API_BASE, CREDENTIAL, DropboxSignPort } from "./dropbox-sign-port.js";

export {
  API_BASE,
  CALLBACK_MAX_AGE_S,
  CALLBACK_MAX_FUTURE_SKEW_S,
  CREDENTIAL,
  DropboxSignPort,
  formFieldsFor,
  mapSignatureRequest,
} from "./dropbox-sign-port.js";
export { MAX_MULTIPART_BYTES, multipartField } from "./multipart.js";
export { detectPageSize, US_LETTER } from "./pdf-pages.js";

/**
 * Dropbox Sign (API v3). Cloud only, fixed API origin (`https://api.hellosign.com/v3`; a configured
 * base URL is ignored so the API key can only ever go to Dropbox Sign). Callbacks are authenticated
 * with the API key itself (event_hash), so `callbackSecret: "vendor"` needs no extra field.
 */
export const dropboxSignAdapter: ESignAdapterDefinition = {
  meta: {
    driver: "dropbox-sign",
    displayName: "Dropbox Sign",
    selfHostable: false,
    baseUrl: { required: false, default: API_BASE },
    supports: { templates: true, pdf: true, embeddedSigning: false, void: true },
    callbackSecret: "vendor",
    subProcessor: {
      name: "Dropbox, Inc. (Dropbox Sign)",
      purpose:
        "Electronic signature of documents (signature requests, signer identity and audit trail)",
      region: "United States",
      dpaUrl: "https://assets.dropbox.com/documents/en/legal/hs-data-processing-agreement.pdf",
      jurisdiction: "us",
      certifications: ["ISO 27001", "SOC 2 Type II"],
    },
  },
  credentialFields: [
    {
      key: CREDENTIAL.apiKey,
      label: "API key",
      kind: "secret",
      required: true,
      help: "Settings → API → API key. It also verifies callbacks (event_hash).",
    },
    {
      key: CREDENTIAL.testMode,
      label: "Mode",
      kind: "select",
      options: ["test", "live"],
      required: true,
      help: "test = non-binding requests (test_mode=1, free); live = legally binding (needs a paid API plan).",
    },
  ],
  create(config, deps) {
    return new DropboxSignPort(config, deps);
  },
};
