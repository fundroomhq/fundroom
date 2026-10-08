import { queryOptions, useQuery } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, type SessionRestriction, SSO_SESSION_RESTRICTED_KEY } from "./api.js";
import { meQuery } from "./queries.js";

/*
 * Workspace single sign-on on the sign-in screen (E3.8, ADR-0056). Distinct from the
 * instance-wide OIDC providers (`/auth/oidc/providers`): this is the workspace's own IdP, looked
 * up from the host the SPA was served on, so it exists only where a workspace resolved.
 */
export interface SsoLoginInfo {
  readonly available: boolean;
  readonly name: string | null;
  readonly protocol: "oidc" | "saml" | null;
  readonly enforced: boolean;
}

export const NO_SSO: SsoLoginInfo = {
  available: false,
  name: null,
  protocol: null,
  enforced: false,
};

/**
 * `GET /auth/sso`. A failure reads as "no SSO here": the lookup is an extra way in, and the
 * sign-in screen must keep working (email, passkey) when it cannot be answered.
 */
export const ssoLoginQuery = queryOptions({
  queryKey: ["auth", "sso"],
  queryFn: async (): Promise<SsoLoginInfo> => {
    try {
      return await call(api().GET("/auth/sso"));
    } catch {
      return NO_SSO;
    }
  },
  staleTime: 60_000,
});

/** Test seam: the top-level navigation to the workspace's identity provider. */
export const ssoLoginNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** `POST /auth/sso/begin` → the IdP URL the browser goes to next (sets the binding cookie). */
export function beginSso(input: {
  returnTo: string;
  loginHint?: string | undefined;
  /** Step-up for an SSO-bound session: the IdP must re-authenticate (ForceAuthn / prompt=login). */
  reauth?: boolean | undefined;
}) {
  const body = {
    returnTo: input.returnTo,
    ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
    ...(input.reauth === true ? { reauth: true } : {}),
  };
  return call(api().POST("/auth/sso/begin", { body }));
}

/**
 * `POST /auth/sso/discover`. `false` on any failure: the caller then sends a code as it always
 * did, and nothing on screen says whether the address belongs to an SSO domain.
 */
export async function discoverSso(email: string): Promise<boolean> {
  try {
    const out = await call(api().POST("/auth/sso/discover", { body: { email } }));
    return out.sso;
  } catch {
    return false;
  }
}

/**
 * The human sentence for `/login?sso_error=<code>`. Only these codes are ever turned into text;
 * anything else in the URL gets the generic sentence, so a crafted link cannot put its own
 * words on the sign-in screen.
 */
export function ssoErrorText(code: string): { title: string; body: string } {
  const title = m.sso_login_error_title();
  switch (code) {
    case "expired":
      return { title, body: m.sso_login_error_expired() };
    case "binding_mismatch":
      return { title, body: m.sso_login_error_binding_mismatch() };
    case "invalid_response":
      return { title, body: m.sso_login_error_invalid_response() };
    case "idp_error":
      return { title, body: m.sso_login_error_idp_error() };
    case "unknown_user":
      return { title, body: m.sso_login_error_unknown_user() };
    case "not_provisioned":
      return { title, body: m.sso_login_error_not_provisioned() };
    case "suspended":
      return { title, body: m.sso_login_error_suspended() };
    case "staff_only":
      return { title, body: m.sso_login_error_staff_only() };
    case "disabled":
      return { title, body: m.sso_login_error_disabled() };
    case "rate_limited":
      return { title, body: m.sso_login_error_rate_limited() };
    case "reauth_mismatch":
      return { title, body: m.sso_login_error_reauth_mismatch() };
    case "reauth_required":
      return { title, body: m.sso_login_error_reauth_required() };
    default:
      return { title, body: m.sso_login_error_generic() };
  }
}

/** True when the session carries a workspace SSO binding (`session.sso`, ADR-0056 decision 5). */
export function sessionIsSsoBound(session: unknown): boolean {
  if (typeof session !== "object" || session === null) return false;
  const sso = (session as { sso?: unknown }).sso;
  return typeof sso === "object" && sso !== null;
}

/**
 * True when the session was handed to this workspace host by the canonical host (E3.10 central
 * auth, `session.boundWorkspaceId`). Like an SSO-bound session it serves this workspace only and
 * may not read or change the account's global security.
 */
export function sessionIsCentralBound(session: unknown): boolean {
  if (typeof session !== "object" || session === null) return false;
  const bound = (session as { boundWorkspaceId?: unknown }).boundWorkspaceId;
  return typeof bound === "string" && bound !== "";
}

/** Which binding (if any) keeps this session away from account security, from `/me` alone. */
export function sessionRestriction(session: unknown): SessionRestriction | null {
  if (sessionIsSsoBound(session)) return "sso";
  if (sessionIsCentralBound(session)) return "central";
  return null;
}

/**
 * Why this session may not change account security, or `null` when it may: `/me` says the
 * session is SSO-bound (FR1) or central-bound (E3.10), or the server has already refused with
 * `sso_session_restricted` / `bound_session_restricted`.
 */
export function useSessionRestriction(): SessionRestriction | null {
  const me = useQuery(meQuery);
  const refused = useQuery({
    queryKey: SSO_SESSION_RESTRICTED_KEY,
    queryFn: (): SessionRestriction | boolean => false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const fromSession = sessionRestriction(me.data?.session);
  if (fromSession !== null) return fromSession;
  if (refused.data === "central") return "central";
  return refused.data === "sso" || refused.data === true ? "sso" : null;
}
