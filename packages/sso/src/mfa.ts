import { oidcAuthLevel } from "@fundroom/identity";

/*
 * Auth level of an SSO login (ADR-0056 decision 7). Level 2 only when the connection says the
 * IdP always enforces MFA (`trustMfa`) or the login's own evidence shows it:
 *
 *  - OIDC: exactly the instance OIDC rule (`oidcAuthLevel`): an `acr` the admin mapped to MFA,
 *    or an `amr` naming MFA outright / spanning two factor categories.
 *  - SAML: the signed assertion's `AuthnContextClassRef` is one the admin mapped to MFA.
 *
 * Otherwise level 1, and an owner or admin meets the existing step-up (TOTP / passkey).
 */

export interface SsoMfaOptions {
  readonly trust: boolean;
  readonly values: readonly string[];
}

export function oidcLoginLevel(
  mfa: SsoMfaOptions,
  claims: { readonly amr?: unknown; readonly acr?: unknown },
): 1 | 2 {
  return oidcAuthLevel({ trustMfa: mfa.trust, mfaAcrValues: mfa.values }, claims);
}

export function samlLoginLevel(
  mfa: SsoMfaOptions,
  authnContextClassRefs: readonly string[],
): 1 | 2 {
  if (mfa.trust) return 2;
  return authnContextClassRefs.some((ref) => mfa.values.includes(ref)) ? 2 : 1;
}

/** Admin-entered MFA values: trimmed, non-empty, unique, at most 20 of at most 256 chars. */
export function cleanMfaValues(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t === "" || t.length > 256 || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
