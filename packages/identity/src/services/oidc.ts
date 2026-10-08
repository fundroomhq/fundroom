import type { OutboundFetch } from "@fundroom/ports";
import * as oidc from "openid-client";
import { open, seal } from "../crypto/secretbox.js";
import { randomToken, safeEqual, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import {
  consumeChallenge,
  findChallengeBySecretHash,
  insertChallenge,
} from "../repos/challenge-repo.js";
import { addIdentity, findIdentity, findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import { checkEligibility, completeLogin } from "./login.js";
import { RATE_LIMITS } from "./rate-limiter.js";
import type { SessionService } from "./sessions.js";
import { type IdentityDeps, type LoginContext, type LoginResult, nowOf } from "./types.js";

/*
 * Generic OIDC (authorization code + PKCE + state + nonce) via openid-client v6, the staff
 * default (§6.2). Identity key is `<iss>|<sub>`. A provider-verified email links to an
 * existing account only when the provider is marked `trustEmail` (Google Workspace / Entra
 * for the company's own domain); otherwise an existing account must link from settings and
 * a new account still needs an invitation.
 */
export interface OidcProviderConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  /** Link on verified email match. Default false. */
  readonly trustEmail?: boolean | undefined;
  /**
   * Treat every login from this provider as multi-factor (auth level 2) regardless of what the
   * ID token claims: for an IdP known to enforce MFA on every sign-in that does not emit
   * `amr`/`acr` (Google Workspace, for one). Default false (F-04, ASVS 6.8.4).
   */
  readonly trustMfa?: boolean | undefined;
  /**
   * `acr` values that mean "authenticated with MFA" at this IdP (e.g. Keycloak's configured LoA,
   * `http://schemas.openid.net/pape/policies/2007/06/multi-factor`). A match grants level 2.
   */
  readonly mfaAcrValues?: readonly string[] | undefined;
  /**
   * Explicit fixed level, overriding the claim evaluation. Kept for callers that pinned one;
   * prefer `trustMfa`. Default: derived from `amr`/`acr` (level 1 unless they show MFA).
   */
  readonly authLevel?: 1 | 2 | undefined;
  /** Restrict to these email domains (lower-case), e.g. the company's Workspace domain. */
  readonly allowedDomains?: readonly string[] | undefined;
}

export interface OidcOptions {
  readonly providers: Readonly<Record<string, OidcProviderConfig>>;
  /** SSRF-guarded fetch (E0.5). Default: global fetch. */
  readonly fetch?: OutboundFetch | undefined;
  /** Permit `http://` issuers. Tests and local IdPs only. */
  readonly allowInsecureHttp?: boolean | undefined;
  readonly challengeTtlMs?: number | undefined;
}

export interface OidcFlow {
  readonly providerIds: readonly string[];
  /**
   * Starts a login. `bindingToken` goes into the browser-binding cookie (the caller sets it
   * with `bindingMaxAgeSeconds`); only a callback that presents it back completes (F-03,
   * ASVS 10.1.2), so a callback URL minted in one browser cannot sign in another.
   */
  begin(
    input: {
      provider: string;
      redirectUri: string;
      returnTo?: string | undefined;
      ip?: string | undefined;
    } & Pick<LoginContext, "workspaceId">,
  ): Promise<{ url: string; state: string; bindingToken: string; bindingMaxAgeSeconds: number }>;
  /**
   * `currentUrl` is the full callback URL the browser was redirected to; `bindingToken` is the
   * binding cookie that browser sent (absent → refused).
   */
  complete(
    input: { currentUrl: URL; bindingToken?: string | undefined } & LoginContext,
  ): Promise<LoginResult & { returnTo: string | undefined }>;
}

/*
 * RFC 8176 `amr` values grouped by factor category. A login is multi-factor when the IdP says so
 * outright (`mfa`, `mca`) or when the methods it lists span two categories (e.g. `pwd` + `otp`,
 * `hwk` + `pin`). A single strong method (`hwk` alone) is one factor; `fido`/`webauthn`/`u2f` are
 * common non-registered spellings of a hardware/platform key.
 */
const AMR_MFA = new Set(["mfa", "mca"]);
const AMR_CATEGORY: Readonly<Record<string, "know" | "have" | "are">> = {
  pwd: "know",
  pin: "know",
  kba: "know",
  otp: "have",
  sms: "have",
  tel: "have",
  hwk: "have",
  swk: "have",
  sc: "have",
  fido: "have",
  webauthn: "have",
  u2f: "have",
  fpt: "are",
  face: "are",
  iris: "are",
  retina: "are",
  vbm: "are",
};

/**
 * Auth level for an OIDC login (F-04, ASVS 6.8.4): 1 unless the provider is explicitly trusted,
 * or the ID token's `amr` shows more than one factor, or its `acr` is one the operator mapped to
 * MFA. An IdP password-only login must not satisfy the staff MFA policy.
 */
export function oidcAuthLevel(
  provider: Pick<OidcProviderConfig, "trustMfa" | "mfaAcrValues" | "authLevel">,
  claims: { amr?: unknown; acr?: unknown },
): 1 | 2 {
  if (provider.authLevel !== undefined) return provider.authLevel;
  if (provider.trustMfa === true) return 2;
  const acr = typeof claims.acr === "string" ? claims.acr : undefined;
  if (acr !== undefined && (provider.mfaAcrValues ?? []).includes(acr)) return 2;
  const amr = Array.isArray(claims.amr)
    ? claims.amr.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())
    : [];
  if (amr.some((v) => AMR_MFA.has(v))) return 2;
  const categories = new Set(amr.map((v) => AMR_CATEGORY[v]).filter((c) => c !== undefined));
  return categories.size >= 2 ? 2 : 1;
}

interface OidcState {
  provider: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo: string | undefined;
  workspaceId: string | undefined;
}

export function createOidcFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: OidcOptions,
): OidcFlow {
  const ttlMs = options.challengeTtlMs ?? 10 * 60_000;
  const configs = new Map<string, Promise<oidc.Configuration>>();

  function discover(id: string): Promise<oidc.Configuration> {
    const provider = options.providers[id];
    if (!provider)
      throw new AuthError("invalid_request", `unknown OIDC provider ${JSON.stringify(id)}`);
    let p = configs.get(id);
    if (!p) {
      // Verify the ID token's JWS signature against the IdP's JWKS every time (ASVS 6.8.2,
      // F-19), not only rely on TLS to the token endpoint as OIDC Core would permit.
      const execute: Array<(c: oidc.Configuration) => void> = [oidc.enableNonRepudiationChecks];
      if (options.allowInsecureHttp) execute.push(oidc.allowInsecureRequests);
      const discoveryOptions: oidc.DiscoveryRequestOptions = { execute };
      if (options.fetch) discoveryOptions[oidc.customFetch] = options.fetch as oidc.CustomFetch;
      p = oidc
        .discovery(
          new URL(provider.issuer),
          provider.clientId,
          provider.clientSecret ? { client_secret: provider.clientSecret } : undefined,
          provider.clientSecret ? oidc.ClientSecretPost(provider.clientSecret) : oidc.None(),
          discoveryOptions,
        )
        .catch((error: unknown) => {
          configs.delete(id);
          throw new AuthError("oidc_failed", "OIDC discovery failed", {}, { cause: error });
        });
      configs.set(id, p);
    }
    return p;
  }

  return {
    providerIds: Object.keys(options.providers),

    async begin(input) {
      if (input.ip) {
        const r = await deps.rateLimiter.hit(`oidc:ip:${input.ip}`, RATE_LIMITS.oidcPerIp);
        if (!r.allowed)
          throw new AuthError("rate_limited", undefined, { retryAfterMs: r.retryAfterMs });
      }
      const provider = options.providers[input.provider];
      if (!provider) throw new AuthError("invalid_request", "unknown OIDC provider");
      const config = await discover(input.provider);
      const verifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const bindingToken = randomToken(16);
      const now = nowOf(deps);
      const payload: OidcState = {
        provider: input.provider,
        verifier,
        nonce,
        redirectUri: input.redirectUri,
        returnTo: input.returnTo,
        workspaceId: input.workspaceId,
      };
      await deps.db.withHost((tx) =>
        insertChallenge(tx, {
          kind: "oidc",
          workspaceId: input.workspaceId ?? null,
          secretHash: sha256(state),
          bindingHash: sha256(bindingToken),
          data: {
            sealed: seal(
              deps.keyRing,
              Buffer.from(JSON.stringify(payload), "utf8"),
              `oidc:${state}`,
            ),
          },
          maxAttempts: 1,
          ip: input.ip ?? null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        }),
      );
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        scope: (provider.scopes ?? ["openid", "email", "profile"]).join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { url: url.href, state, bindingToken, bindingMaxAgeSeconds: Math.ceil(ttlMs / 1000) };
    },

    async complete(input) {
      const state = input.currentUrl.searchParams.get("state");
      if (!state) throw new AuthError("oidc_failed", "missing state");
      const now = nowOf(deps);
      const payload = await deps.db.withHost(async (tx) => {
        const ch = await findChallengeBySecretHash(tx, "oidc", sha256(state));
        if (!ch || ch.consumedAt !== null)
          throw new AuthError("oidc_failed", "unknown or used state");
        if (ch.expiresAt.getTime() <= now.getTime())
          throw new AuthError("expired", "login attempt expired");
        // Browser binding, checked before the state is consumed so a foreign browser replaying
        // the callback URL cannot burn the legitimate login either.
        const bound =
          input.bindingToken !== undefined &&
          ch.bindingHash !== null &&
          safeEqual(sha256(input.bindingToken), ch.bindingHash);
        if (!bound)
          throw new AuthError(
            "oidc_failed",
            "this sign-in was started in a different browser; start it again here",
            { reason: "binding_mismatch" },
          );
        if (!(await consumeChallenge(tx, ch.id)))
          throw new AuthError("oidc_failed", "state already used");
        const sealed = (ch.data as { sealed?: string }).sealed;
        if (!sealed) throw new AuthError("oidc_failed", "corrupt state");
        return JSON.parse(
          Buffer.from(open(deps.keyRing, sealed, `oidc:${state}`)).toString("utf8"),
        ) as OidcState;
      });
      if ((payload.workspaceId ?? undefined) !== input.workspaceId)
        throw new AuthError("oidc_failed", "workspace mismatch");
      const provider = options.providers[payload.provider];
      if (!provider) throw new AuthError("oidc_failed", "provider no longer configured");
      const config = await discover(payload.provider);

      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(config, input.currentUrl, {
          pkceCodeVerifier: payload.verifier,
          expectedState: state,
          expectedNonce: payload.nonce,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch (error) {
        throw new AuthError("oidc_failed", "token exchange failed", {}, { cause: error });
      }
      if (!claims) throw new AuthError("oidc_failed", "no id_token");
      const identifier = `${claims.iss}|${claims.sub}`;
      const rawEmail = typeof claims["email"] === "string" ? claims["email"] : undefined;
      const emailVerified = claims["email_verified"] === true;
      let email: string | undefined;
      try {
        email = rawEmail ? normalizeEmail(rawEmail) : undefined;
      } catch {
        email = undefined;
      }
      if (provider.allowedDomains && provider.allowedDomains.length > 0) {
        const domain = email?.split("@")[1];
        if (!domain || !provider.allowedDomains.includes(domain))
          throw new AuthError("not_eligible", "email domain not allowed");
      }
      const displayName = typeof claims["name"] === "string" ? claims["name"] : undefined;

      const linked = await deps.db.withHost(async (tx) => {
        const byIdentity = await findIdentity(tx, "oidc", identifier);
        if (byIdentity) return { userId: byIdentity.id };
        if (!email || !emailVerified) return { userId: undefined };
        const byEmail = await findUserByEmail(tx, email);
        if (byEmail) {
          if (!provider.trustEmail)
            throw new AuthError(
              "oidc_failed",
              "an account with this email exists; sign in and link the provider from settings",
              { reason: "link_required" },
            );
          await addIdentity(tx, byEmail.id, { type: "oidc", identifier, verified: true });
          return { userId: byEmail.id };
        }
        return { userId: undefined };
      });

      let userId = linked.userId;
      if (!userId) {
        if (!email || !emailVerified)
          throw new AuthError("not_eligible", "provider did not assert a verified email");
        const e = await checkEligibility(deps, { email, workspaceId: input.workspaceId });
        if (!e.eligible) throw new AuthError("not_eligible");
      }
      const result = await completeLogin(deps, sessions, {
        ...input,
        userId,
        email,
        displayName,
        authLevel: oidcAuthLevel(provider, { amr: claims["amr"], acr: claims["acr"] }),
        method: "oidc",
      });
      if (!userId) {
        // New user created from the invitation: attach the provider identity for next time.
        userId = result.session.userId;
        await deps.db.withHost((tx) =>
          addIdentity(tx, userId as string, { type: "oidc", identifier, verified: true }),
        );
      }
      return { ...result, returnTo: payload.returnTo };
    },
  };
}
