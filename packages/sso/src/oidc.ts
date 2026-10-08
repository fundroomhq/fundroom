import * as oidc from "openid-client";

/*
 * Per-connection OIDC relying party (openid-client v6), the same recipe as the instance-wide
 * flow in `@fundroom/identity` (`services/oidc.ts`): discovery and JWKS through the SSO guarded
 * fetch only, the ID token's JWS verified every time (`enableNonRepudiationChecks`), PKCE S256 +
 * state + nonce, and openid-client's own checks (discovered issuer == configured issuer, `iss`,
 * `aud`/`azp`, nonce, and RFC 9207 `iss` on the authorization response when advertised).
 *
 * Tenant-chosen issuers make two more rules necessary:
 *  - https only (http just for a host the operator allow-listed in SSO_ALLOW_PRIVATE_HOSTS);
 *  - Entra's multi-tenant endpoints (`common`, `organizations`, `consumers`) are refused: their
 *    discovery issuer is a `{tenantid}` template, so any Entra tenant's users would satisfy it.
 *
 * Discovery is cached per (connection id, version) for an hour; a save bumps the version.
 */

export const OIDC_DISCOVERY_TTL_MS = 60 * 60_000;
const ENTRA_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.microsoftonline.de",
  "login.chinacloudapi.cn",
  "login.partner.microsoftonline.cn",
  "login.windows.net",
  "sts.windows.net",
]);
const ENTRA_MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

export type OidcIssuerProblem = "issuer_mismatch" | "discovery_failed";

export class OidcConfigError extends Error {
  override readonly name = "OidcConfigError";
  constructor(
    readonly reason: OidcIssuerProblem,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Validates an admin-typed issuer; returns it trimmed (openid-client compares it exactly). */
export function checkIssuer(raw: string, insecureHosts: readonly string[]): string {
  const issuer = raw.trim();
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new OidcConfigError("discovery_failed", "the issuer is not a URL");
  }
  const insecureOk = url.protocol === "http:" && insecureHosts.includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !insecureOk) {
    throw new OidcConfigError("discovery_failed", "the issuer must be an https URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new OidcConfigError("discovery_failed", "the issuer must be a plain URL");
  }
  if (issuer.length > 1024) throw new OidcConfigError("discovery_failed", "the issuer is too long");
  if (ENTRA_HOSTS.has(url.hostname.toLowerCase())) {
    const tenant =
      url.pathname
        .split("/")
        .filter((s) => s !== "")[0]
        ?.toLowerCase() ?? "";
    if (tenant === "" || ENTRA_MULTI_TENANT.has(tenant)) {
      throw new OidcConfigError(
        "issuer_mismatch",
        "use your Entra tenant's own issuer (https://login.microsoftonline.com/<tenant id>/v2.0), not a multi-tenant endpoint",
      );
    }
  }
  return issuer;
}

export interface OidcClientSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
}

export interface OidcDiscovery {
  discover(key: string | undefined, settings: OidcClientSettings): Promise<oidc.Configuration>;
  /** Drops every cached configuration of a connection (on save / delete). */
  forget(connectionId: string): void;
}

export function createOidcDiscovery(options: {
  readonly fetch: typeof fetch;
  readonly insecureHosts: readonly string[];
  readonly now?: () => number;
}): OidcDiscovery {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; config: Promise<oidc.Configuration> }>();

  function load(settings: OidcClientSettings): Promise<oidc.Configuration> {
    const url = new URL(settings.issuer);
    const execute: Array<(c: oidc.Configuration) => void> = [oidc.enableNonRepudiationChecks];
    if (url.protocol === "http:" && options.insecureHosts.includes(url.hostname.toLowerCase())) {
      execute.push(oidc.allowInsecureRequests);
    }
    const discoveryOptions: oidc.DiscoveryRequestOptions = {
      execute,
      [oidc.customFetch]: options.fetch as unknown as oidc.CustomFetch,
    };
    const secret = settings.clientSecret;
    return oidc
      .discovery(
        url,
        settings.clientId,
        secret === undefined ? undefined : { client_secret: secret },
        secret === undefined ? oidc.None() : oidc.ClientSecretPost(secret),
        discoveryOptions,
      )
      .catch((error: unknown) => {
        throw new OidcConfigError("discovery_failed", "OIDC discovery failed", { cause: error });
      });
  }

  return {
    discover(key, settings) {
      if (key === undefined) return load(settings);
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at < OIDC_DISCOVERY_TTL_MS) return hit.config;
      const config = load(settings);
      cache.set(key, { at: now(), config });
      config.catch(() => {
        if (cache.get(key)?.config === config) cache.delete(key);
      });
      // Bounded: one entry per live connection version; stale versions are dropped on save.
      if (cache.size > 5_000) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return config;
    },
    forget(connectionId) {
      for (const k of [...cache.keys()]) if (k.startsWith(`${connectionId}:`)) cache.delete(k);
    },
  };
}

export { oidc };
