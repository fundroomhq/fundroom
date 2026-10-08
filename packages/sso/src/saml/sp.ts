import {
  type CacheProvider,
  generateServiceProviderMetadata,
  SAML,
  ValidateInResponseTo,
} from "@node-saml/node-saml";
import { SAML_CLOCK_SKEW_MS } from "./checks.js";

/*
 * The node-saml SP for one connection (`@node-saml/node-saml` 5.1.0 pinned; xml-crypto and
 * xmldom floored by override). Its settings are the safe ones from research §1.3: signed
 * assertions required (the Response may be unsigned — Entra's default), SHA-256, no
 * RequestedAuthnContext, NameID format left to the IdP, and `validateInResponseTo: always`.
 *
 * node-saml's request-id cache is NOT where single use lives: it gets a throwaway cache holding
 * only the one request id this browser's begin sealed (consumed atomically in Postgres first),
 * so node-saml can compare the Response's `InResponseTo` and nothing else is admitted. Our own
 * checks (`checks.ts`) then bind the SIGNED `SubjectConfirmationData/@InResponseTo` to it.
 */

export interface SpSettings {
  /** SP entity ID = our metadata URL for this connection. */
  readonly entityId: string;
  readonly acsUrl: string;
  readonly idpSsoUrl: string;
  readonly idpCerts: readonly string[];
}

/** A cache that holds at most the given ids (node-saml's `saveAsync` records a new one). */
export function oneShotCache(seed?: string): CacheProvider & { readonly saved: string[] } {
  const ids = new Map<string, { value: string; createdAt: number }>();
  const saved: string[] = [];
  if (seed !== undefined) ids.set(seed, { value: new Date().toISOString(), createdAt: Date.now() });
  return {
    saved,
    async saveAsync(key, value) {
      const item = { value, createdAt: Date.now() };
      ids.set(key, item);
      saved.push(key);
      return item;
    },
    async getAsync(key) {
      return ids.get(key)?.value ?? null;
    },
    async removeAsync(key) {
      if (key === null) return null;
      const v = ids.get(key)?.value ?? null;
      ids.delete(key);
      return v;
    },
  };
}

export function createSp(
  settings: SpSettings,
  cacheProvider: CacheProvider,
  options: { readonly forceAuthn?: boolean } = {},
): SAML {
  return new SAML({
    entryPoint: settings.idpSsoUrl,
    issuer: settings.entityId,
    callbackUrl: settings.acsUrl,
    audience: settings.entityId,
    idpCert: [...settings.idpCerts],
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider,
    requestIdExpirationPeriodMs: 10 * 60_000,
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    forceAuthn: options.forceAuthn === true,
    allowCreate: true,
  });
}

/** SP metadata for the IdP admin (unsigned; the SP signs nothing and decrypts nothing). */
export function spMetadataXml(entityId: string, acsUrl: string): string {
  return generateServiceProviderMetadata({
    issuer: entityId,
    callbackUrl: acsUrl,
    identifierFormat: null,
    wantAssertionsSigned: true,
    decryptionCert: null,
    publicCerts: null,
  });
}
