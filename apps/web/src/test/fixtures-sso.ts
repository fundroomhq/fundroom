import type {
  ScimAdminView,
  ScimGroup,
  ScimToken,
  ScimUser,
  SsoConnection,
  SsoConnectionResponse,
  SsoDomain,
  SsoSpInfo,
} from "../lib/sso-queries.js";

/*
 * SSO / SCIM admin fixtures (E3.8), shaped like the admin HTTP API in the E3.8 contract
 * (`GET /sso/connection`, `/sso/domains`, `/sso/scim`, `/sso/scim/users`, `/sso/scim/groups`).
 * The IdP-facing addresses live on the canonical host, never the workspace's custom domain.
 */
export const SSO_CONNECTION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9b01";
export const SSO_NOW = "2026-09-27T10:00:00.000Z";
const BASE = "https://investors.example.com";

export function spInfo(id: string = SSO_CONNECTION_ID): SsoSpInfo {
  return {
    oidcRedirectUri: `${BASE}/sso/oidc/${id}/callback`,
    samlAcsUrl: `${BASE}/sso/saml/${id}/acs`,
    samlEntityId: `${BASE}/sso/saml/${id}/metadata`,
    samlMetadataUrl: `${BASE}/sso/saml/${id}/metadata`,
  };
}

export function oidcConnection(over: Partial<SsoConnection> = {}): SsoConnection {
  return {
    id: SSO_CONNECTION_ID,
    protocol: "oidc",
    name: "Acme Okta",
    enabled: false,
    enforce: "off",
    status: "active",
    lastError: null,
    lastVerifiedAt: SSO_NOW,
    lastTestedAt: null,
    lastLoginAt: null,
    jit: { enabled: false, role: "viewer" },
    mfa: { trust: false, values: [] },
    oidc: { issuer: "https://acme.okta.com", clientId: "0oa1client", hasSecret: true },
    saml: null,
    sp: spInfo(),
    createdAt: SSO_NOW,
    updatedAt: SSO_NOW,
    ...over,
  };
}

export function samlConnection(over: Partial<SsoConnection> = {}): SsoConnection {
  return oidcConnection({
    protocol: "saml",
    name: "Acme Entra",
    oidc: null,
    saml: {
      idpEntityId: "https://sts.windows.net/tenant-id/",
      idpSsoUrl: "https://login.microsoftonline.com/tenant-id/saml2",
      certificates: [
        {
          fingerprintSha256: "AB:CD:EF:01",
          notAfter: "2029-01-01T00:00:00.000Z",
          subject: "CN=Microsoft Azure Federated SSO Certificate",
        },
      ],
    },
    ...over,
  });
}

export function connectionResponse(
  connection: SsoConnection | null,
  over: Partial<SsoConnectionResponse> = {},
): SsoConnectionResponse {
  return {
    connection,
    protocolsOffered: ["oidc", "saml"],
    spPreview: connection === null ? null : connection.sp,
    ...over,
  };
}

export function ssoDomain(over: Partial<SsoDomain> = {}): SsoDomain {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9d01",
    domain: "acme.com",
    status: "pending",
    txtName: "_fundroom-sso.acme.com",
    txtValue: "fundroom-sso=tok_0123456789abcdef",
    verifiedAt: null,
    lastCheckedAt: null,
    lastError: null,
    ...over,
  };
}

export function scimToken(over: Partial<ScimToken> = {}): ScimToken {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9e01",
    name: "Entra ID",
    displayPrefix: "frs_AbCd",
    createdAt: SSO_NOW,
    lastUsedAt: null,
    ...over,
  };
}

export function scimAdmin(over: Partial<ScimAdminView> = {}): ScimAdminView {
  return {
    enabled: true,
    baseUrl: `${BASE}/scim/v2`,
    tokens: [],
    counts: { users: 0, activeUsers: 0, groups: 0 },
    ...over,
  };
}

export function scimUser(over: Partial<ScimUser> = {}): ScimUser {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9f01",
    userName: "ada@acme.com",
    displayName: "Ada Lovelace",
    active: true,
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9f11",
    role: "editor",
    groups: ["Engineering"],
    updatedAt: SSO_NOW,
    ...over,
  };
}

export function scimGroup(over: Partial<ScimGroup> = {}): ScimGroup {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9a21",
    displayName: "Engineering",
    role: null,
    memberCount: 3,
    updatedAt: SSO_NOW,
    ...over,
  };
}
