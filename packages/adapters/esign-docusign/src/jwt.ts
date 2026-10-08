import { createPrivateKey, type KeyObject, sign } from "node:crypto";

/**
 * DocuSign OAuth JWT grant assertion (RS256), signed with node:crypto — no JOSE dependency.
 * Claims per DocuSign's "JWT Grant" docs: `iss` = integration key, `sub` = the impersonated user's
 * GUID, `aud` = the account server host WITHOUT scheme (`account-d.docusign.com` for demo,
 * `account.docusign.com` for production), `iat`/`exp` in seconds (DocuSign caps the lifetime at one
 * hour), `scope` = "signature impersonation".
 */

export const JWT_LIFETIME_SECONDS = 3600;
export const JWT_SCOPE = "signature impersonation";

export interface JwtClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly scope: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Parse the admin's PEM. Throws a message-free error (never echo key material). */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem.replace(/\\n/g, "\n").trim(), format: "pem" });
  } catch {
    throw new Error("private key is not a valid PEM");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("private key must be an RSA key");
  return key;
}

export function jwtClaims(input: {
  integrationKey: string;
  userId: string;
  audience: string;
  now: Date;
}): JwtClaims {
  const iat = Math.floor(input.now.getTime() / 1000);
  return {
    iss: input.integrationKey,
    sub: input.userId,
    aud: input.audience,
    iat,
    exp: iat + JWT_LIFETIME_SECONDS,
    scope: JWT_SCOPE,
  };
}

export function signJwt(claims: JwtClaims, key: KeyObject): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}
