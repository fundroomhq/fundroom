import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Staff single sign-on and SCIM provisioning (E3.8, ADR-0056). Kernel routes behind `sso.read`
 * / `sso.manage`; every write except a domain re-check also needs a fresh session, which
 * `useGuardedMutation` turns into a step-up and back.
 *
 * Secrets are write-only: the connection says `hasSecret`, never the client secret; SAML
 * certificates come back as fingerprints; a SCIM token is shown once, when it is created.
 */
export type SsoProtocol = FundRoomSchemas["SsoProtocol"];
export type StaffJitRole = FundRoomSchemas["SsoJitRole"];
export type ScimMappableRole = FundRoomSchemas["ScimMappableRole"];
export type SsoEnforce = FundRoomSchemas["SsoEnforce"];
export type SsoSpInfo = FundRoomSchemas["SsoSpInfo"];
export type SsoConnection = FundRoomSchemas["SsoConnection"];
export type SsoConnectionResponse = FundRoomSchemas["SsoConnectionResponse"];
export type SaveSsoConnectionBody = FundRoomSchemas["SsoConnectionPut"];
export type SsoDomain = FundRoomSchemas["SsoDomain"];
export type ScimToken = FundRoomSchemas["ScimToken"];
export type ScimAdminView = FundRoomSchemas["ScimAdmin"];
export type ScimUser = FundRoomSchemas["ScimUser"];
export type ScimGroup = FundRoomSchemas["ScimGroup"];

export const JIT_ROLES: readonly StaffJitRole[] = ["editor", "viewer", "finance", "legal"];
/** In precedence order: a member in several mapped groups gets the first of these. */
export const SCIM_ROLES: readonly ScimMappableRole[] = [
  "admin",
  "legal",
  "finance",
  "editor",
  "viewer",
];
/** Most IdPs never send more than two live tokens' worth of rotation; the server caps it. */
export const SCIM_TOKEN_LIMIT = 2;
export const SCIM_USERS_PAGE = 50;

export const SSO_KEY = ["sso"] as const;

export const ssoConnectionQuery = queryOptions({
  queryKey: [...SSO_KEY, "connection"],
  queryFn: () => call(api().GET("/sso/connection")),
});

export const ssoDomainsQuery = queryOptions({
  queryKey: [...SSO_KEY, "domains"],
  queryFn: () => call(api().GET("/sso/domains")),
});

export const scimAdminQuery = queryOptions({
  queryKey: [...SSO_KEY, "scim"],
  queryFn: () => call(api().GET("/sso/scim")),
});

export const scimGroupsQuery = queryOptions({
  queryKey: [...SSO_KEY, "scim", "groups"],
  queryFn: () => call(api().GET("/sso/scim/groups")),
});

export const scimUsersQuery = infiniteQueryOptions({
  queryKey: [...SSO_KEY, "scim", "users"],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    call(
      api().GET("/sso/scim/users", {
        params: {
          query: {
            limit: SCIM_USERS_PAGE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      }),
    ),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

// --- the test sign-in round trip -------------------------------------------------------------

/** Test seam: the top-level navigation to the identity provider for a test sign-in. */
export const ssoTestNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * `?sso_test=` is where a test sign-in lands. The value only chooses which sentence to show:
 * anything outside the known codes reads as the generic failure, and it is never echoed.
 */
export function describeTestResult(code: string): { ok: boolean; body: string } {
  switch (code) {
    case "ok":
      return { ok: true, body: m.sso_admin_test_ok_body() };
    case "expired":
      return { ok: false, body: m.sso_admin_test_expired() };
    case "binding_mismatch":
      return { ok: false, body: m.sso_admin_test_binding_mismatch() };
    case "invalid_response":
      return { ok: false, body: m.sso_admin_test_invalid_response() };
    case "idp_error":
      return { ok: false, body: m.sso_admin_test_idp_error() };
    case "rate_limited":
      return { ok: false, body: m.sso_admin_test_rate_limited() };
    default:
      return { ok: false, body: m.sso_admin_test_failed_generic() };
  }
}

// --- labels -----------------------------------------------------------------------------------

export function protocolLabel(protocol: SsoProtocol): string {
  return protocol === "oidc" ? m.sso_admin_protocol_oidc() : m.sso_admin_protocol_saml();
}

// --- errors -----------------------------------------------------------------------------------

/** A detail from the error body; the server flattens `details` into `error`, tolerate both. */
function detail(error: unknown, key: string): unknown {
  if (!isApiError(error)) return undefined;
  const flat = error.body.error[key];
  if (flat !== undefined) return flat;
  return (error.body.error["details"] as Record<string, unknown> | undefined)?.[key];
}

export function ssoErrorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.code : undefined;
}

export function ssoErrorReason(error: unknown): string | undefined {
  const reason = detail(error, "reason");
  return typeof reason === "string" ? reason : undefined;
}

/** One sentence per refusal the SSO admin routes give; anything else is the generic copy. */
export function describeSsoError(error: unknown): string {
  const reason = ssoErrorReason(error);
  switch (ssoErrorCode(error)) {
    case "sso_invalid_config":
      switch (reason) {
        case "discovery_failed":
          return m.sso_admin_error_discovery_failed();
        case "issuer_mismatch":
          return m.sso_admin_error_issuer_mismatch();
        case "invalid_metadata":
          return m.sso_admin_error_invalid_metadata();
        case "invalid_certificate":
          return m.sso_admin_error_invalid_certificate();
        case "secret_required":
          return m.sso_admin_error_secret_required();
        case "protocol_unavailable":
          return m.sso_admin_error_protocol_unavailable();
        default:
          return m.sso_admin_error_invalid_config();
      }
    case "sso_enforce_precondition":
      return reason === "never_signed_in"
        ? m.sso_admin_error_enforce_never_signed_in()
        : m.sso_admin_error_enforce_not_enabled();
    case "sso_session_restricted":
      return m.sso_admin_error_session_restricted();
    case "sso_not_configured":
      return m.sso_admin_error_not_configured();
    case "sso_disabled":
      return m.sso_admin_error_disabled();
    case "sso_domain_taken":
      return m.sso_admin_error_domain_taken();
    case "sso_domain_invalid":
      return m.sso_admin_error_domain_invalid();
    case "sso_domain_unverified":
      return m.sso_admin_error_domain_unverified();
    case "scim_token_limit":
      return m.sso_admin_error_scim_token_limit();
    case "scim_disabled":
      return m.sso_admin_scim_disabled_body();
    default:
      return describeError(error).body;
  }
}

/** True for the refusals `describeSsoError` has its own sentence for. */
export function isSsoRefusal(error: unknown): boolean {
  const code = ssoErrorCode(error);
  return code !== undefined && (code.startsWith("sso_") || code.startsWith("scim_"));
}

/** PEM blocks out of a pasted text box (one or several certificates, any spacing between). */
export function splitPems(text: string): string[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
  if (blocks !== null) return blocks.map((b) => b.trim());
  const trimmed = text.trim();
  return trimmed === "" ? [] : [trimmed];
}

/** One MFA value (an `acr`/AuthnContextClassRef) per line, blanks and duplicates dropped. */
export function splitLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/u)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
}
