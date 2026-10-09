import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  paginationQuery,
  requestIdOf,
  sessionSecurity,
  TimestampSchema,
  trimmedText,
  UuidSchema,
  z,
} from "@fundroom/contracts";
import type { ScimActor, ScimGroupRow, ScimTokenView, ScimUserRow } from "@fundroom/scim";
import type {
  SaveSsoConnectionInput,
  SsoActor,
  SsoConnectionView,
  SsoDomainView,
  SsoSpInfo,
} from "@fundroom/sso";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { requireFeature } from "../middleware/entitlements.js";
import { type ApiDeps, principalOf } from "./deps.js";

/*
 * Staff SSO admin routes (E3.8, ADR-0056) under `/api/v1/sso/*`: the workspace's connection,
 * verified domains and the SCIM admin surface (tokens, users, group → role mapping). Every route
 * row is in `packages/authz/matrix/authz-matrix.yaml` (`sso.read` / `sso.manage`).
 *
 * - Owner/admin only. Every write that changes who gets in (connection, state, domains, SCIM
 *   tokens, group → role mapping) needs a fresh session; re-checking a domain's DNS record does not.
 * - No response carries a secret: the OIDC client secret is write-only (`hasSecret`), certificates
 *   come back as fingerprints, and a SCIM token's value is returned exactly once, by the create.
 * - Service errors (`@fundroom/sso` / `@fundroom/scim`) carry an API error code + status and are
 *   adopted by the error handler as they are (`sso_invalid_config`, `sso_not_configured`,
 *   `sso_enforce_precondition`, `sso_domain_*`, `scim_token_limit`, `scim_disabled`, …).
 * - Routes read `deps.*` lazily: the OpenAPI document is built against a throwing stub.
 * - Plan entitlements (A-3, ADR-0063; round-1 decisions 1, 2, 5, 11): a downgrade freezes the
 *   configuration. Adding something new needs the plan's feature — 402 `plan_limit`, always after
 *   the permission guard so it is never an oracle: a NEW connection (none yet, or another IdP),
 *   turning the connection or its enforcement on, a domain and its verification (`sso`); the
 *   FIRST SCIM token (`scim`). Maintenance stays open: re-keying the existing connection (secret,
 *   certificates, metadata), a second token while one is live (rotation), group → role mappings
 *   (an owner must be able to demote a group), and everything that switches off or removes. The
 *   transition checks run inside the services with the row locked (`assertMayCreate`,
 *   `assertMayTurnOn`, `assertMayStart`), never on a separately read copy.
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 502, 503);
/** Routes that turn the `sso` / `scim` plan feature on also answer 402 `plan_limit` (A-3). */
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 502, 503);
const TAGS = ["sso"];

/**
 * Connection save ATTEMPTS per workspace per hour (peek before, hit after — refused ones too):
 * every save makes a live discovery / metadata check against the IdP, so the budget bounds how
 * hard a workspace can make this install probe arbitrary hosts. Same shape as accreditation's.
 */
export const SSO_CONNECTION_SAVE_LIMIT = { max: 10, windowMs: 60 * 60_000 } as const;

// --- schemas --------------------------------------------------------------------------------

const SsoProtocolSchema = z.enum(["oidc", "saml"]).openapi("SsoProtocol");
const StaffJitRoleSchema = z
  .enum(["editor", "viewer", "finance", "legal"])
  .openapi("SsoJitRole", { description: "Role a just-in-time provisioned staff member gets" });
const MappableRoleSchema = z
  .enum(["admin", "editor", "viewer", "finance", "legal"])
  .openapi("ScimMappableRole", {
    description: "A staff role a SCIM group may map to (never owner)",
  });
const SsoEnforceSchema = z.enum(["off", "staff"]).openapi("SsoEnforce", {
  description:
    "`staff`: staff may use the workspace only with a session signed in through this connection (an owner at MFA level is always admitted — break-glass). Investors are never affected.",
});
const NullableTimestamp = z.union([TimestampSchema, z.null()]);

const SsoSpInfoSchema = z
  .object({
    oidcRedirectUri: z.string().openapi({
      description: "Register as the redirect URI of the OIDC client",
      example: "https://fundroom.example/sso/oidc/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a/callback",
    }),
    samlAcsUrl: z.string().openapi({ description: "Assertion Consumer Service URL (HTTP-POST)" }),
    samlEntityId: z.string().openapi({ description: "SP entity ID (Identifier / Audience)" }),
    samlMetadataUrl: z.string().openapi({ description: "SP metadata (XML)" }),
  })
  .openapi("SsoSpInfo");

const SsoConnectionSchema = z
  .object({
    id: UuidSchema,
    protocol: SsoProtocolSchema,
    name: z.string().openapi({ example: "Okta" }),
    enabled: z.boolean(),
    enforce: SsoEnforceSchema,
    status: z.enum(["active", "error"]),
    lastError: z.string().nullable(),
    lastVerifiedAt: NullableTimestamp,
    lastTestedAt: NullableTimestamp,
    lastLoginAt: NullableTimestamp,
    jit: z.object({ enabled: z.boolean(), role: StaffJitRoleSchema }),
    mfa: z.object({
      trust: z.boolean().openapi({
        description:
          "Trust the IdP's sign-in as multi-factor (skips our step-up for owners/admins)",
      }),
      values: z.array(z.string()).openapi({
        description: "OIDC `acr`/`amr` or SAML AuthnContextClassRef values that count as MFA",
      }),
    }),
    oidc: z.object({ issuer: z.string(), clientId: z.string(), hasSecret: z.boolean() }).nullable(),
    saml: z
      .object({
        idpEntityId: z.string(),
        idpSsoUrl: z.string(),
        certificates: z.array(
          z.object({
            fingerprintSha256: z.string(),
            notAfter: TimestampSchema,
            subject: z.string(),
          }),
        ),
      })
      .nullable(),
    sp: SsoSpInfoSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("SsoConnection");

const SsoConnectionResponseSchema = z
  .object({
    connection: z.union([SsoConnectionSchema, z.null()]),
    protocolsOffered: z.array(SsoProtocolSchema).openapi({
      description: "Protocols the operator offers (`SSO_PROTOCOLS`); empty when SSO is off",
    }),
    spPreview: z.union([SsoSpInfoSchema, z.null()]).openapi({
      description: "The URLs to register with the IdP; `null` until a connection exists",
    }),
  })
  .openapi("SsoConnectionResponse");

const SsoConnectionSavedSchema = z
  .object({ connection: SsoConnectionSchema })
  .openapi("SsoConnectionSaved");

const common = {
  name: trimmedText({ min: 1, max: 100 }).openapi({ example: "Okta" }),
  jit: z.object({ enabled: z.boolean(), role: StaffJitRoleSchema }),
  mfa: z.object({
    trust: z.boolean(),
    values: z.array(z.string().min(1).max(256)).max(20),
  }),
};

const SsoOidcSaveSchema = z
  .strictObject({
    protocol: z.literal("oidc"),
    ...common,
    issuer: z.url().max(2048).openapi({ example: "https://acme.okta.com" }),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional().openapi({
      description:
        "Write-only. Required on create, on a protocol switch and when the issuer changes; omit to keep the stored one.",
    }),
  })
  .openapi("SsoOidcConnectionPut");

const SsoSamlSaveSchema = z
  .strictObject({
    protocol: z.literal("saml"),
    ...common,
    metadataXml: z
      .string()
      .min(1)
      .max(512 * 1024)
      .optional()
      .openapi({
        description:
          "The IdP's metadata XML — or `idpEntityId` + `idpSsoUrl` (+ `certificates`), not both",
      }),
    idpEntityId: z.string().min(1).max(1024).optional(),
    idpSsoUrl: z.url().max(2048).optional(),
    certificates: z
      .array(
        z
          .string()
          .min(1)
          .max(16 * 1024),
      )
      .min(1)
      .max(5)
      .optional()
      .openapi({
        description:
          "IdP signing certificates (PEM). Omit on an update to keep the saved ones; required on create and on a protocol switch.",
      }),
  })
  .refine(
    (v) => {
      const manual =
        v.idpEntityId !== undefined || v.idpSsoUrl !== undefined || v.certificates !== undefined;
      if (v.metadataXml !== undefined) return !manual;
      // Certificates may be left out on an update (keep the saved ones); the service requires
      // them on create and on a protocol switch (400 `sso_invalid_config`).
      return v.idpEntityId !== undefined && v.idpSsoUrl !== undefined;
    },
    {
      message: "give either metadataXml or idpEntityId + idpSsoUrl (+ certificates)",
      path: ["metadataXml"],
    },
  )
  .openapi("SsoSamlConnectionPut");

const SsoConnectionPutSchema = z
  .discriminatedUnion("protocol", [SsoOidcSaveSchema, SsoSamlSaveSchema])
  .openapi("SsoConnectionPut");

const SsoConnectionStatePutSchema = z
  .object({ enabled: z.boolean(), enforce: SsoEnforceSchema })
  .openapi("SsoConnectionStatePut");

const SsoDomainSchema = z
  .object({
    id: UuidSchema,
    domain: z.string().openapi({ example: "acme.com" }),
    status: z.enum(["pending", "verified"]),
    txtName: z.string().openapi({ example: "_fundroom-sso.acme.com" }),
    txtValue: z.string().openapi({ example: "fundroom-sso=3q2-7wEAAAA" }),
    verifiedAt: NullableTimestamp,
    lastCheckedAt: NullableTimestamp,
    lastError: z.string().nullable(),
  })
  .openapi("SsoDomain");

const SsoDomainListSchema = z
  .object({ domains: z.array(SsoDomainSchema) })
  .openapi("SsoDomainList");
const SsoDomainResponseSchema = z.object({ domain: SsoDomainSchema }).openapi("SsoDomainResponse");
const SsoDomainPostSchema = z
  .object({ domain: trimmedText({ min: 1, max: 253 }).openapi({ example: "acme.com" }) })
  .openapi("SsoDomainPost");

const ScimTokenSchema = z
  .object({
    id: UuidSchema,
    name: z.string().openapi({ example: "Entra ID" }),
    displayPrefix: z.string().openapi({ example: "frs_3q2-7wEA" }),
    createdAt: TimestampSchema,
    lastUsedAt: NullableTimestamp,
  })
  .openapi("ScimToken");

const ScimAdminSchema = z
  .object({
    enabled: z
      .boolean()
      .openapi({ description: "Whether the operator offers SCIM (`SCIM_ENABLED`)" }),
    baseUrl: z.string().openapi({
      description: "The SCIM base URL to give the IdP",
      example: "https://fundroom.example/scim/v2",
    }),
    tokens: z.array(ScimTokenSchema),
    counts: z.object({
      users: z.number().int(),
      activeUsers: z.number().int(),
      groups: z.number().int(),
    }),
  })
  .openapi("ScimAdmin");

const ScimTokenPostSchema = z
  .object({ name: trimmedText({ min: 1, max: 80 }).openapi({ example: "Entra ID" }) })
  .openapi("ScimTokenPost");

const ScimTokenCreatedSchema = z
  .object({
    token: z.string().openapi({
      description: "The bearer token — shown once, never again",
      example: "frs_3q2-7wEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    view: ScimTokenSchema,
  })
  .openapi("ScimTokenCreated");

const ScimUserSchema = z
  .object({
    id: UuidSchema.openapi({ description: "The SCIM id" }),
    userName: z.string().openapi({ example: "ada@acme.com" }),
    displayName: z.string().nullable(),
    active: z.boolean(),
    membershipId: z.union([UuidSchema, z.null()]),
    role: z.string().nullable().openapi({ description: "The membership's current role" }),
    groups: z.array(z.string()).openapi({ description: "Display names of its SCIM groups" }),
    updatedAt: TimestampSchema,
  })
  .openapi("ScimUser");

const ScimUserPageSchema = z
  .object({
    items: z.array(ScimUserSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("ScimUserPage");

const ScimGroupSchema = z
  .object({
    id: UuidSchema,
    displayName: z.string().openapi({ example: "Finance team" }),
    role: z.union([MappableRoleSchema, z.null()]),
    memberCount: z.number().int(),
    updatedAt: TimestampSchema,
  })
  .openapi("ScimGroup");

const ScimGroupListSchema = z.object({ groups: z.array(ScimGroupSchema) }).openapi("ScimGroupList");
const ScimGroupResponseSchema = z.object({ group: ScimGroupSchema }).openapi("ScimGroupResponse");
const ScimGroupRolePutSchema = z
  .object({
    role: z.union([MappableRoleSchema, z.null()]).openapi({
      description: "`null` removes the mapping (members fall back to the default role)",
    }),
  })
  .openapi("ScimGroupRolePut");

const IdParam = z.object({ id: UuidSchema });

// --- bodies ---------------------------------------------------------------------------------

/** Explicit field picks so nothing the service adds later leaks by accident. */
function spBody(sp: SsoSpInfo) {
  return {
    oidcRedirectUri: sp.oidcRedirectUri,
    samlAcsUrl: sp.samlAcsUrl,
    samlEntityId: sp.samlEntityId,
    samlMetadataUrl: sp.samlMetadataUrl,
  };
}

function connectionBody(v: SsoConnectionView) {
  return {
    id: v.id,
    protocol: v.protocol,
    name: v.name,
    enabled: v.enabled,
    enforce: v.enforce,
    status: v.status,
    lastError: v.lastError,
    lastVerifiedAt: v.lastVerifiedAt,
    lastTestedAt: v.lastTestedAt,
    lastLoginAt: v.lastLoginAt,
    jit: { enabled: v.jit.enabled, role: v.jit.role },
    mfa: { trust: v.mfa.trust, values: [...v.mfa.values] },
    oidc:
      v.oidc === null
        ? null
        : { issuer: v.oidc.issuer, clientId: v.oidc.clientId, hasSecret: v.oidc.hasSecret },
    saml:
      v.saml === null
        ? null
        : {
            idpEntityId: v.saml.idpEntityId,
            idpSsoUrl: v.saml.idpSsoUrl,
            certificates: v.saml.certificates.map((cert) => ({
              fingerprintSha256: cert.fingerprintSha256,
              notAfter: cert.notAfter,
              subject: cert.subject,
            })),
          },
    sp: spBody(v.sp),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function domainBody(d: SsoDomainView) {
  return {
    id: d.id,
    domain: d.domain,
    status: d.status,
    txtName: d.txtName,
    txtValue: d.txtValue,
    verifiedAt: d.verifiedAt,
    lastCheckedAt: d.lastCheckedAt,
    lastError: d.lastError,
  };
}

function tokenBody(t: ScimTokenView) {
  return {
    id: t.id,
    name: t.name,
    displayPrefix: t.displayPrefix,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
  };
}

function userBody(u: ScimUserRow) {
  return {
    id: u.id,
    userName: u.userName,
    displayName: u.displayName,
    active: u.active,
    membershipId: u.membershipId,
    role: u.role,
    groups: [...u.groups],
    updatedAt: u.updatedAt,
  };
}

function groupBody(g: ScimGroupRow) {
  return {
    id: g.id,
    displayName: g.displayName,
    role: g.role,
    memberCount: g.memberCount,
    updatedAt: g.updatedAt,
  };
}

function saveInput(body: z.infer<typeof SsoConnectionPutSchema>): SaveSsoConnectionInput {
  const common = {
    name: body.name,
    jit: { enabled: body.jit.enabled, role: body.jit.role },
    mfa: { trust: body.mfa.trust, values: [...body.mfa.values] },
  };
  if (body.protocol === "oidc") {
    return {
      ...common,
      protocol: "oidc",
      issuer: body.issuer,
      clientId: body.clientId,
      ...(body.clientSecret === undefined ? {} : { clientSecret: body.clientSecret }),
    };
  }
  return {
    ...common,
    protocol: "saml",
    ...(body.metadataXml === undefined ? {} : { metadataXml: body.metadataXml }),
    ...(body.idpEntityId === undefined ? {} : { idpEntityId: body.idpEntityId }),
    ...(body.idpSsoUrl === undefined ? {} : { idpSsoUrl: body.idpSsoUrl }),
    ...(body.certificates === undefined ? {} : { certificates: [...body.certificates] }),
  };
}

function actorOf(c: Context<AppEnv>): SsoActor & ScimActor {
  const p = principalOf(c);
  return {
    membershipId: p.membership.id,
    requestId: requestIdOf(c),
    ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
    ...(p.apiKeyId === undefined ? {} : { apiKeyId: p.apiKeyId }),
  };
}

function rateLimited(retryAfterMs: number, message: string): never {
  throw new ApiError(
    "rate_limited",
    message,
    { retryAfterMs },
    { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  );
}

// --- routes ---------------------------------------------------------------------------------

export function registerSsoRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const sso = () => deps.sso;
  const scim = () => deps.scim;

  api.openapi(
    createRoute({
      method: "get",
      path: "/sso/connection",
      tags: TAGS,
      summary: "The workspace's staff SSO connection",
      description:
        "Never a secret: the OIDC client secret is reported as `hasSecret`, SAML certificates as fingerprints. `connection: null` when none is configured. `sp` / `spPreview` are the URLs to register with the IdP (they live on the install's canonical host, so a custom-domain change never breaks them).",
      security: sessionSecurity,
      "x-requires": "sso.read",
      middleware: [perm("sso.read")] as const,
      responses: { 200: jsonResponse(SsoConnectionResponseSchema, "Connection"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const view = await sso().getConnection(tenant);
      return c.json(
        {
          connection: view === null ? null : connectionBody(view),
          protocolsOffered: [...sso().protocolsOffered()],
          spPreview: view === null ? null : spBody(view.sp),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/sso/connection",
      tags: TAGS,
      summary: "Create or replace the SSO connection",
      description:
        "OIDC: the issuer's discovery document is fetched and checked live before anything is stored; the client secret is required on create, on a protocol switch and when the issuer changes. SAML: the IdP's metadata XML, or its entity ID, SSO URL and signing certificates. 400 `sso_invalid_config` (`details.reason`) when the IdP configuration does not check out. A new connection starts disabled. 402 `plan_limit` (`feature: sso`) when the save would create a connection — none yet, another protocol, or another issuer / entity ID — and the workspace's plan does not include SSO; re-keying the existing connection (secret, certificates, metadata) is allowed, but not turning just-in-time provisioning or trusting the IdP's MFA from off to on (also 402). At most 10 saves an hour per workspace (429 `rate_limited` with `Retry-After`). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      // Not `jsonBody` (objects only): each variant is already strict.
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SsoConnectionPutSchema } },
        },
      },
      responses: { 200: jsonResponse(SsoConnectionSavedSchema, "Saved"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const body = c.req.valid("json");
      const key = `sso.connection-save:${workspace.id}`;
      const peek = await deps.rateLimiter.peek(key, SSO_CONNECTION_SAVE_LIMIT);
      if (!peek.allowed) {
        rateLimited(peek.retryAfterMs, "too many SSO connection saves in this workspace");
      }
      // A-3: only a new connection (none yet, or another IdP) needs the plan's `sso` feature;
      // re-keying the existing one is maintenance (decision 1). Judged on the locked row.
      const entitlements = deps.entitlements.of(workspace);
      try {
        const saved = await sso().saveConnection(tenant, saveInput(body), actorOf(c), {
          assertMayCreate: () => deps.entitlements.assertFeature(entitlements, "sso"),
          // Decision 18: nor may it switch on JIT provisioning or trusting the IdP's MFA.
          assertMayTurnOn: () => deps.entitlements.assertFeature(entitlements, "sso"),
        });
        return c.json({ connection: connectionBody(saved) }, 200);
      } finally {
        await deps.rateLimiter.hit(key, SSO_CONNECTION_SAVE_LIMIT);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/sso/connection/state",
      tags: TAGS,
      summary: "Enable, disable or enforce the SSO connection",
      description:
        "404 `sso_not_configured` with no connection. Enforcing (`enforce: staff`) needs a successful SSO sign-in or test first (409 `sso_enforce_precondition`, `details.reason` `never_signed_in`). A disabled connection is never enforced: `enabled: false` stores `enforce: off` whatever was asked. 402 `plan_limit` (`feature: sso`) when the write turns the connection or its enforcement on and the workspace's plan does not include SSO; keeping the state, turning enforcement off and disabling are always allowed. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      request: { body: jsonBody(SsoConnectionStatePutSchema) },
      responses: { 200: jsonResponse(SsoConnectionSavedSchema, "Connection"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const body = c.req.valid("json");
      // Gated on the transition only (A-3): turning the connection on, or enforcement on, needs
      // the plan's `sso` feature; keeping it as it is and switching it off never do, so a
      // downgraded workspace's connection stays usable and can always be disabled. The service
      // judges the transition on the locked row (decision 11); no connection is its own 404.
      const entitlements = deps.entitlements.of(workspace);
      const view = await sso().setState(
        tenant,
        { enabled: body.enabled, enforce: body.enforce },
        actorOf(c),
        { assertMayTurnOn: () => deps.entitlements.assertFeature(entitlements, "sso") },
      );
      return c.json({ connection: connectionBody(view) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/sso/connection",
      tags: TAGS,
      summary: "Delete the SSO connection",
      description:
        "Turns enforcement off and signs out every session that signed in through the connection. Staff sign in with email codes and passkeys again. 404 `sso_not_configured` with no connection. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      responses: { 204: { description: "Deleted" }, ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      await sso().deleteConnection(tenant, actorOf(c));
      return c.body(null, 204) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sso/domains",
      tags: TAGS,
      summary: "The workspace's SSO email domains",
      description:
        "A domain proves the workspace controls its email addresses: an SSO sign-in with a verified domain's address may be linked to (or, with just-in-time provisioning, create) a staff account, and SCIM may provision only those addresses. Publish TXT `txtName` = `txtValue`, then verify.",
      security: sessionSecurity,
      "x-requires": "sso.read",
      middleware: [perm("sso.read")] as const,
      responses: { 200: jsonResponse(SsoDomainListSchema, "Domains"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const domains = await sso().listDomains(tenant);
      return c.json({ domains: domains.map(domainBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/sso/domains",
      tags: TAGS,
      summary: "Add an SSO email domain",
      description:
        "The domain starts `pending`. 400 `sso_domain_invalid` for a name that is not a registrable hostname; 409 `sso_domain_taken` when it is already added to this workspace or verified by another. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true }), requireFeature(deps, "sso")] as const,
      request: { body: jsonBody(SsoDomainPostSchema) },
      responses: { 201: jsonResponse(SsoDomainResponseSchema, "Added"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { domain } = c.req.valid("json");
      const view = await sso().addDomain(tenant, domain, actorOf(c));
      return c.json({ domain: domainBody(view) }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/sso/domains/{id}/verify",
      tags: TAGS,
      summary: "Check an SSO domain's DNS record",
      description:
        "Looks up TXT `txtName` now. Answers 200 either way: `status` says whether the domain is verified and `lastError` why not. 409 `sso_domain_taken` when another workspace verified it first.",
      security: sessionSecurity,
      "x-requires": "sso.manage",
      middleware: [perm("sso.manage"), requireFeature(deps, "sso")] as const,
      request: { params: IdParam },
      responses: { 200: jsonResponse(SsoDomainResponseSchema, "Checked"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const view = await sso().verifyDomain(tenant, id, actorOf(c));
      return c.json({ domain: domainBody(view) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/sso/domains/{id}",
      tags: TAGS,
      summary: "Remove an SSO email domain",
      description:
        "Existing accounts and memberships stay; new SSO sign-ins and SCIM provisioning with the domain's addresses stop being accepted. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      request: { params: IdParam },
      responses: { 204: { description: "Removed" }, ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      await sso().removeDomain(tenant, id, actorOf(c));
      return c.body(null, 204) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sso/scim",
      tags: TAGS,
      summary: "SCIM provisioning overview",
      description:
        "The SCIM base URL to give the IdP, the live tokens (never their values) and counts. `enabled` is false when the operator turned SCIM off (`SCIM_ENABLED`).",
      security: sessionSecurity,
      "x-requires": "sso.read",
      middleware: [perm("sso.read")] as const,
      responses: { 200: jsonResponse(ScimAdminSchema, "SCIM"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const v = await scim().adminView(tenant);
      return c.json(
        {
          enabled: v.enabled,
          baseUrl: v.baseUrl,
          tokens: v.tokens.map(tokenBody),
          counts: {
            users: v.counts.users,
            activeUsers: v.counts.activeUsers,
            groups: v.counts.groups,
          },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/sso/scim/tokens",
      tags: TAGS,
      summary: "Create a SCIM bearer token",
      description:
        "The token is returned once and never again. At most two live tokens per workspace (409 `scim_token_limit`) — enough to rotate. 402 `plan_limit` (`feature: scim`) for the first live token when the workspace's plan does not include SCIM; a token minted while one is live (rotation) is always allowed. 404 `scim_disabled` when the operator turned SCIM off. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      request: { body: jsonBody(ScimTokenPostSchema) },
      responses: { 201: jsonResponse(ScimTokenCreatedSchema, "Created"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const { name } = c.req.valid("json");
      // A-3 (decision 2): only the first live token needs the plan's `scim` feature; a token
      // minted while one is live is rotation. Judged with the workspace locked.
      const entitlements = deps.entitlements.of(workspace);
      const created = await scim().createToken(tenant, { name }, actorOf(c), {
        assertMayStart: () => deps.entitlements.assertFeature(entitlements, "scim"),
      });
      return c.json({ token: created.token, view: tokenBody(created.view) }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/sso/scim/tokens/{id}",
      tags: TAGS,
      summary: "Revoke a SCIM bearer token",
      description:
        "The IdP's next request with it is refused (401). Provisioned users are kept. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      request: { params: IdParam },
      responses: { 204: { description: "Revoked" }, ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      await scim().revokeToken(tenant, id, actorOf(c));
      return c.body(null, 204) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sso/scim/users",
      tags: TAGS,
      summary: "Users the IdP provisioned over SCIM",
      description:
        "Including deactivated ones (`active: false`, the membership is suspended). `role` is the membership's current role.",
      security: sessionSecurity,
      "x-requires": "sso.read",
      middleware: [perm("sso.read")] as const,
      request: { query: paginationQuery(100) },
      responses: { 200: jsonResponse(ScimUserPageSchema, "Users"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { cursor, limit } = c.req.valid("query");
      const result = await scim().listUsers(tenant, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      return c.json({ items: result.items.map(userBody), nextCursor: result.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sso/scim/groups",
      tags: TAGS,
      summary: "Groups the IdP pushed over SCIM",
      description:
        "With the staff role each maps to. A SCIM-managed member's role is the highest mapped role among its groups (admin > legal > finance > editor > viewer), else the connection's default role. Owners are never re-roled.",
      security: sessionSecurity,
      "x-requires": "sso.read",
      middleware: [perm("sso.read")] as const,
      responses: { 200: jsonResponse(ScimGroupListSchema, "Groups"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const groups = await scim().listGroups(tenant);
      return c.json({ groups: groups.map(groupBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/sso/scim/groups/{id}/role",
      tags: TAGS,
      summary: "Map a SCIM group to a staff role",
      description:
        "`role: null` removes the mapping. The group's members' roles are recomputed at once (owners excepted). Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "sso.manage+fresh",
      middleware: [perm("sso.manage", { fresh: true })] as const,
      request: { params: IdParam, body: jsonBody(ScimGroupRolePutSchema) },
      responses: { 200: jsonResponse(ScimGroupResponseSchema, "Mapped"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const { role } = c.req.valid("json");
      const group = await scim().setGroupRole(tenant, id, role, actorOf(c));
      return c.json({ group: groupBody(group) }, 200);
    },
  );
}
