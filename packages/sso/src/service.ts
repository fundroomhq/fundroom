import { createHash } from "node:crypto";
import type { AuditInput } from "@fundroom/audit";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import {
  type core,
  pgErrorCode,
  pgErrorMessage,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import {
  type AuthError,
  auditLoginFailure,
  completeLogin,
  isAuthError,
  normalizeEmail,
  open,
  RATE_LIMITS,
  randomToken,
  STEP_UP_MAX_AGE_MS,
  safeEqual,
  seal,
  sha256,
  withMinimumDuration,
} from "@fundroom/identity";
import type { DnsAnswer } from "@fundroom/ports";
import {
  emailDomain,
  evaluateTxt,
  legacyTxtName,
  newDomainToken,
  normalizeSsoDomain,
  SSO_MAX_DOMAINS,
  txtName,
  txtValue,
} from "./domains.js";
import { SsoError, SsoFlowError, type SsoFlowErrorCode } from "./errors.js";
import { decideSsoLogin, type LinkMembershipFact } from "./linking.js";
import { cleanMfaValues, oidcLoginLevel, samlLoginLevel } from "./mfa.js";
import { checkIssuer, createOidcDiscovery, OidcConfigError, oidc } from "./oidc.js";
import {
  addSsoIdentity,
  consumeChallenge,
  findChallenge,
  findLiveMembership,
  findMembershipById,
  findUserByIdentity,
  hostFindConnection,
  insertChallenge,
  lockLiveStaffMembership,
  recordAssertion,
  SsoConnectionRepo,
  type SsoConnectionRow,
  SsoDomainRepo,
  type SsoDomainRow,
  setWorkspaceSsoMirror,
  sweepAssertions,
} from "./repos/sso-repo.js";
import {
  checkAssertion,
  checkResponse,
  SamlAssertionError,
  samlIdentityClaims,
} from "./saml/checks.js";
import {
  checkCertificates,
  checkEntityId,
  checkIdpUrl,
  describeCertificate,
  parseIdpMetadata,
  SamlConfigError,
} from "./saml/metadata.js";
import { createSp, oneShotCache, spMetadataXml } from "./saml/sp.js";
import {
  type SaveSsoConnectionInput,
  SSO_KEY_PURPOSE,
  type SsoActor,
  type SsoConnectionView,
  type SsoDomainView,
  type SsoFinishResult,
  type SsoProtocol,
  type SsoService,
  type SsoServiceDeps,
  type SsoSpInfo,
  type StaffJitRole,
} from "./types.js";

/*
 * The kernel staff SSO service (E3.8, ADR-0056).
 *
 * Transactions. Every outbound call (OIDC discovery / token endpoint / JWKS, DNS) happens
 * OUTSIDE any transaction (pool-deadlock rule): a short tx reads what is needed, it closes, the
 * call runs, and the result is written in another short tx that re-checks under the lock.
 *
 * Lock order on every write path: feature advisory lock `sso.connection:<ws>` → connection /
 * domain row (FOR UPDATE) → workspace row (the `sso_enforced` UPDATE, right before the audit) →
 * audit chain. Session revocation for a deleted or replaced connection runs after commit.
 *
 * Login flow (decision 4). Begin runs on the workspace origin: it seals the PKCE verifier / nonce
 * (OIDC) or the AuthnRequest id (SAML) in a single-use `core.auth_challenge` bound to the browser
 * by the `sso_req` cookie's hash. The IdP returns to the canonical host, where the callback / ACS
 * consumes that challenge, verifies everything cryptographic, and stores only the verified facts in
 * a two-minute `sso_handoff` challenge carrying the same binding hash, then 303s to the workspace
 * origin's finish. Finish checks the binding cookie, consumes the handoff and only then resolves
 * the user (linking / JIT) and mints the workspace-bound session. Nothing before finish writes a
 * user, identity or membership row.
 */

const BEGIN_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 2 * 60_000;
/** How recent the IdP's own authentication must be for an SSO re-authentication (step-up). */
const REAUTH_MAX_AGE_MS = 5 * 60_000;
const REAUTH_FUTURE_SKEW_MS = 60_000;
const DEFAULT_DISCOVER_FLOOR_MS = 150;
const SAML_RESPONSE_MAX_CHARS = 350_000; // ≈ 256 KiB of XML, base64
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const JIT_ROLES: readonly StaffJitRole[] = ["editor", "viewer", "finance", "legal"];

type Protocol = SsoProtocol;

/** What begin seals into its challenge (and the handoff copies what it needs). */
interface BeginPayload {
  readonly v: 1;
  readonly protocol: Protocol;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly appBase: string;
  readonly returnTo: string | undefined;
  readonly tester: { readonly membershipId: string; readonly userId: string } | undefined;
  /** SSO re-authentication (step-up, FR4): the bound session's user the IdP must name again. */
  readonly reauthUserId?: string | undefined;
  // OIDC
  readonly verifier?: string;
  readonly nonce?: string;
  // SAML
  readonly requestId?: string;
}

/** The verified facts the canonical host hands to the workspace origin. */
interface HandoffPayload {
  readonly v: 1;
  readonly protocol: Protocol;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly returnTo: string | undefined;
  readonly tester: { readonly membershipId: string; readonly userId: string } | undefined;
  /** SSO re-authentication (step-up, FR4): the bound session's user the IdP must name again. */
  readonly reauthUserId?: string | undefined;
  readonly subject: string;
  readonly email: string | undefined;
  readonly displayName: string | undefined;
  readonly authLevel: 1 | 2;
  /**
   * When the IdP says it authenticated the user (OIDC `auth_time`, SAML `AuthnInstant`), epoch
   * ms; absent when it gave none (FR5: the session is then minted NOT fresh).
   */
  readonly idpAuthTime?: number | undefined;
  /** The connection `version` the callback / ACS verified under (FR3 A1); finish requires it. */
  readonly connectionVersion: number;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The constraint name a failed write violated (pg puts it in `constraint`; drizzle wraps). */
function constraintNameOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string" && name !== "") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return /violates [a-z ]*constraint "([^"]+)"/u.exec(pgErrorMessage(error))?.[1];
}

function trimmedName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 100) {
    throw new SsoError("validation_failed", "the connection name must be 1–100 characters", {
      reason: "name",
    });
  }
  return n;
}

/**
 * A-3: whether a state write turns something on that the plan's `sso` feature governs — a
 * disabled connection becoming enabled, or an enabled one becoming enforced. A disabled
 * connection is never enforced (`setState` stores `enforce: off`), so `enabled: false` never
 * turns anything on.
 */
export function stateTurnsOn(
  current: { readonly enabled: boolean; readonly enforce: "off" | "staff" },
  next: { readonly enabled: boolean; readonly enforce: "off" | "staff" },
): boolean {
  if (!next.enabled) return false;
  if (!current.enabled) return true;
  return current.enforce === "off" && next.enforce === "staff";
}

export function createSsoService(deps: SsoServiceDeps): SsoService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const insecureHosts = (deps.insecureHosts ?? []).map((h) => h.toLowerCase());
  const offered = new Set<Protocol>(deps.protocols);
  const discovery = createOidcDiscovery({
    fetch: deps.fetch,
    insecureHosts,
    now: () => now().getTime(),
  });
  // E3.9 (ADR-0057): every IdP-facing URL hangs off BASE_URL itself (origin + path), never
  // `origin + BASE_PATH` — behind a proxy that strips or replaces the prefix the two differ, and
  // BASE_URL is the public one. Identical output whenever BASE_URL's path is BASE_PATH.
  const canonicalBase = `${deps.baseUrl.origin}${deps.baseUrl.pathname.replace(/\/+$/u, "")}`;

  // --- small helpers ---------------------------------------------------------------------------

  function sys(ws: TenantContext | string): TenantContext {
    return systemContext(typeof ws === "string" ? ws : ws.workspaceId);
  }

  function refuseViewAs(ctx: TenantContext): void {
    if (ctx.viewAs !== undefined) {
      throw new SsoError("conflict", "view-as is read only", { reason: "view_as_read_only" });
    }
  }

  function actorAudit(ctx: TenantContext, actor: SsoActor): Partial<AuditInput> {
    return {
      actorKind: ctx.actorKind,
      actorMembershipId: actor.membershipId,
      actorUserId: ctx.userId ?? null,
      requestId: actor.requestId ?? null,
      sessionId: actor.sessionId ?? null,
      ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    };
  }

  function identity() {
    if (deps.identity === undefined) throw new Error("the SSO login flow is not wired");
    return deps.identity;
  }

  function spInfo(connectionId: string): SsoSpInfo {
    const id = encodeURIComponent(connectionId);
    const metadata = `${canonicalBase}/sso/saml/${id}/metadata`;
    return {
      oidcRedirectUri: `${canonicalBase}/sso/oidc/${id}/callback`,
      samlAcsUrl: `${canonicalBase}/sso/saml/${id}/acs`,
      samlEntityId: metadata,
      samlMetadataUrl: metadata,
    };
  }

  function viewOf(row: SsoConnectionRow): SsoConnectionView {
    const options = row.options ?? {};
    return {
      id: row.id,
      protocol: row.protocol,
      name: row.name,
      enabled: row.enabled,
      enforce: row.enforce,
      status: row.status,
      lastError: row.lastError,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      jit: { enabled: row.jitEnabled, role: row.jitRole },
      mfa: { trust: options.trustMfa === true, values: [...(options.mfaValues ?? [])] },
      oidc:
        row.protocol === "oidc"
          ? {
              issuer: row.oidcIssuer ?? "",
              clientId: row.oidcClientId ?? "",
              hasSecret: row.credentialsEnc !== null,
            }
          : null,
      saml:
        row.protocol === "saml"
          ? {
              idpEntityId: row.samlIdpEntityId ?? "",
              idpSsoUrl: row.samlIdpSsoUrl ?? "",
              certificates: (row.samlIdpCerts ?? []).map(describeCertificate),
            }
          : null,
      sp: spInfo(row.id),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function domainView(row: SsoDomainRow): SsoDomainView {
    return {
      id: row.id,
      domain: row.domain,
      status: row.status,
      txtName: txtName(row.domain),
      txtValue: txtValue(row.token),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
    };
  }

  // --- sealing the client secret (SHE1 under the `sso-credentials` workspace key) --------------

  async function sealSecret(
    tx: Tx,
    sctx: TenantContext,
    secret: string,
  ): Promise<{ enc: Buffer; encryption: core.SsoConnectionEncryption }> {
    const dek = await deps.crypto.currentKey(tx, sctx, SSO_KEY_PURPOSE);
    const enc = Buffer.from(
      await encryptBytes(dek.key, Buffer.from(JSON.stringify({ clientSecret: secret }), "utf8")),
    );
    return {
      enc,
      encryption: { credentials: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef } },
    };
  }

  async function unsealSecret(
    tx: Tx,
    sctx: TenantContext,
    row: SsoConnectionRow,
  ): Promise<string | undefined> {
    const ref = row.encryption?.credentials;
    if (ref === undefined || row.credentialsEnc === null) return undefined;
    const key = await deps.crypto.keyById(tx, sctx, ref.keyId);
    if (key === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(await decryptBytes(key.key, row.credentialsEnc)).toString("utf8"),
      );
      const secret = (parsed as { clientSecret?: unknown }).clientSecret;
      return typeof secret === "string" ? secret : undefined;
    } catch {
      return undefined;
    }
  }

  // --- sealing flow state (the identity key ring, like every other login challenge) ------------

  function sealFlow(payload: object, aad: string): string {
    return seal(identity().deps.keyRing, Buffer.from(JSON.stringify(payload), "utf8"), aad);
  }

  function openFlow<T>(sealed: unknown, aad: string): T | undefined {
    if (typeof sealed !== "string") return undefined;
    try {
      return JSON.parse(
        Buffer.from(open(identity().deps.keyRing, sealed, aad)).toString("utf8"),
      ) as T;
    } catch {
      return undefined;
    }
  }

  // --- connection writes -----------------------------------------------------------------------

  interface ResolvedOidc {
    readonly protocol: "oidc";
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly secretChanged: boolean;
  }
  interface ResolvedSaml {
    readonly protocol: "saml";
    readonly entityId: string;
    readonly ssoUrl: string;
    readonly certificates: readonly string[];
  }

  function configError(reason: string, message: string): SsoError {
    return new SsoError("sso_invalid_config", message, { reason });
  }

  async function resolveOidc(
    input: Extract<SaveSsoConnectionInput, { protocol: "oidc" }>,
    previous: { row: SsoConnectionRow; secret: string | undefined } | undefined,
  ): Promise<ResolvedOidc> {
    let issuer: string;
    try {
      issuer = checkIssuer(input.issuer, insecureHosts);
    } catch (error) {
      if (error instanceof OidcConfigError) throw configError(error.reason, error.message);
      throw error;
    }
    const clientId = input.clientId.trim();
    if (clientId === "" || clientId.length > 512) {
      throw new SsoError("validation_failed", "the client ID is missing or too long", {
        reason: "client_id",
      });
    }
    const given = input.clientSecret?.trim();
    const samePrevious =
      previous !== undefined &&
      previous.row.protocol === "oidc" &&
      previous.row.oidcIssuer === issuer &&
      previous.secret !== undefined;
    let clientSecret: string;
    let secretChanged = true;
    if (given !== undefined && given !== "") {
      if (given.length > 2048) {
        throw new SsoError("validation_failed", "the client secret is too long", {
          reason: "client_secret",
        });
      }
      clientSecret = given;
      secretChanged = !(samePrevious && previous.secret === given);
    } else if (samePrevious) {
      clientSecret = previous.secret as string;
      secretChanged = false;
    } else {
      throw configError(
        "secret_required",
        "enter the client secret (required for a new connection, a protocol switch or a new issuer)",
      );
    }
    // Live verification with no transaction open: the issuer must publish a discovery document
    // whose `issuer` is exactly this URL (openid-client checks), reachable through the guard.
    try {
      await discovery.discover(undefined, { issuer, clientId, clientSecret });
    } catch (error) {
      log("sso.discovery_failed", {
        level: "warn",
        error:
          error instanceof Error
            ? ((error.cause as Error | undefined)?.name ?? error.name)
            : "unknown",
      });
      throw configError(
        "discovery_failed",
        "the issuer's OpenID discovery document could not be fetched or does not match the issuer",
      );
    }
    return { protocol: "oidc", issuer, clientId, clientSecret, secretChanged };
  }

  function resolveSaml(
    input: Extract<SaveSsoConnectionInput, { protocol: "saml" }>,
    previous: SsoConnectionRow | undefined,
  ): ResolvedSaml {
    const at = now();
    try {
      const xml = input.metadataXml?.trim();
      if (xml !== undefined && xml !== "") {
        if (
          input.idpEntityId !== undefined ||
          input.idpSsoUrl !== undefined ||
          input.certificates !== undefined
        ) {
          throw configError(
            "invalid_metadata",
            "give either the IdP metadata XML or the entity ID, sign-on URL and certificates",
          );
        }
        const md = parseIdpMetadata(xml, at, insecureHosts);
        return {
          protocol: "saml",
          entityId: md.entityId,
          ssoUrl: md.ssoUrl,
          certificates: md.certificates,
        };
      }
      if (input.idpEntityId === undefined || input.idpSsoUrl === undefined) {
        throw configError(
          "invalid_metadata",
          "give the IdP metadata XML, or its entity ID and sign-on URL",
        );
      }
      const entityId = checkEntityId(input.idpEntityId);
      const ssoUrl = checkIdpUrl(input.idpSsoUrl, insecureHosts);
      let certificates: readonly string[];
      if (input.certificates !== undefined && input.certificates.length > 0) {
        certificates = checkCertificates(input.certificates, at).map((c) => c.pem);
      } else if (
        previous !== undefined &&
        previous.protocol === "saml" &&
        previous.samlIdpEntityId === entityId &&
        (previous.samlIdpCerts ?? []).length > 0
      ) {
        certificates = previous.samlIdpCerts ?? [];
      } else {
        throw configError("invalid_certificate", "give at least one IdP signing certificate");
      }
      return { protocol: "saml", entityId, ssoUrl, certificates };
    } catch (error) {
      if (error instanceof SamlConfigError) throw configError(error.reason, error.message);
      throw error;
    }
  }

  /** Whether a save changes WHICH IdP the connection trusts (→ a new connection id). */
  function identityChanges(live: SsoConnectionRow, next: ResolvedOidc | ResolvedSaml): boolean {
    if (live.protocol !== next.protocol) return true;
    if (next.protocol === "oidc") return live.oidcIssuer !== next.issuer;
    return live.samlIdpEntityId !== next.entityId;
  }

  /** Whether an in-place save changes what the connection's existing sessions were minted under. */
  function securityRelevantChange(
    live: SsoConnectionRow,
    next: ResolvedOidc | ResolvedSaml,
    input: SaveSsoConnectionInput,
  ): boolean {
    const options = live.options ?? {};
    const sameList = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
    if ((options.trustMfa === true) !== input.mfa.trust) return true;
    if (!sameList(options.mfaValues ?? [], cleanMfaValues(input.mfa.values))) return true;
    if (live.jitEnabled !== input.jit.enabled || live.jitRole !== input.jit.role) return true;
    if (next.protocol === "oidc") {
      return next.secretChanged || live.oidcClientId !== next.clientId;
    }
    const pems = (list: readonly string[]) => list.map((p) => p.replace(/\s+/gu, ""));
    return !sameList(pems(live.samlIdpCerts ?? []), pems(next.certificates));
  }

  /**
   * Revokes a connection's bound sessions after the change that requires it committed — cleanup
   * only (FR3): the change already cleared or bumped the workspace's connection mirror in its own
   * transaction, and session resolution ignores every session minted under the old id / version
   * from the next request on. Retried once; a failure is logged at error level and not surfaced.
   */
  async function revokeAfterCommit(connectionId: string, reason: string): Promise<void> {
    discovery.forget(connectionId);
    if (deps.identity === undefined) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const n = await deps.identity.sessions.revokeSessionsForSsoConnection(connectionId, reason);
        log("sso.sessions_revoked", { connectionId, count: n, reason });
        return;
      } catch (error) {
        log("sso.session_revoke_failed", {
          level: "error",
          connectionId,
          reason,
          attempt,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  function invalidateResolver(): void {
    try {
      deps.resolver?.invalidate();
    } catch {
      // best effort; the resolver's TTL bounds staleness
    }
  }

  // --- login flow helpers ----------------------------------------------------------------------

  /**
   * SSO re-authentication (FR4): the IdP must have authenticated the user within the last five
   * minutes (OIDC `auth_time`, SAML `AuthnInstant`), else `reauth_required` — an IdP that ignored
   * `prompt=login` / `ForceAuthn` and answered from its own session does not count as fresh.
   */
  function requireFreshAuthentication(authenticatedAtMs: number | undefined): void {
    const t = now().getTime();
    if (
      authenticatedAtMs === undefined ||
      !Number.isFinite(authenticatedAtMs) ||
      authenticatedAtMs < t - REAUTH_MAX_AGE_MS ||
      authenticatedAtMs > t + REAUTH_FUTURE_SKEW_MS
    ) {
      throw new SsoFlowError("reauth_required", "the IdP did not authenticate the user afresh");
    }
  }

  /** An IdP authentication time we can use: finite and not beyond the future skew. */
  function plausibleAuthTime(ms: number | undefined): number | undefined {
    if (ms === undefined || !Number.isFinite(ms)) return undefined;
    return ms > now().getTime() + REAUTH_FUTURE_SKEW_MS ? undefined : ms;
  }

  function loginUrl(appBase: string, code: SsoFlowErrorCode): string {
    return `${appBase}/login?sso_error=${code}`;
  }

  function testUrl(appBase: string, outcome: string): string {
    return `${appBase}/admin/sso?sso_test=${outcome}`;
  }

  /**
   * A test's result on the connection (last_tested_at, last_error) + audit. With `recheck`
   * (finish, FR3 A4) the tester's membership is locked FOR SHARE inside the same transaction —
   * after the connection row (global order) — and must still hold `sso.manage`, else nothing is
   * written and `forbidden` is returned.
   */
  async function recordTest(
    workspaceId: string,
    connectionId: string,
    tester: { membershipId: string; userId: string },
    outcome: "ok" | SsoFlowErrorCode,
    reason: string | undefined,
    recheck = false,
  ): Promise<"recorded" | "forbidden"> {
    const sctx = sys(workspaceId);
    const canManage =
      deps.canManage ??
      ((x: { kind: string; role: string; status: string }) =>
        x.kind === "staff" && x.status === "active" && x.role === "owner");
    try {
      return await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (recheck) {
          const m = await findMembershipById(tx, sctx, tester.membershipId, { share: true });
          if (m === undefined || m.userId !== tester.userId || !canManage(m)) {
            return "forbidden" as const;
          }
        }
        if (live === undefined || live.id !== connectionId) return "recorded" as const;
        await conns.update(live.id, {
          lastTestedAt: now(),
          lastError:
            outcome === "ok"
              ? null
              : `test: ${outcome}${reason ? ` (${reason})` : ""}`.slice(0, 500),
          ...(outcome === "ok" ? { status: "active" as const } : {}),
        });
        await deps.audit.record(tx, sctx, {
          actorKind: "staff",
          actorMembershipId: tester.membershipId,
          actorUserId: tester.userId,
          action: "sso.test_completed",
          resourceKind: "sso_connection",
          resourceId: live.id,
          ...(outcome === "ok" ? {} : { outcome: "failure" as const }),
          meta: { protocol: live.protocol, ok: outcome === "ok", code: outcome },
        });
        return "recorded" as const;
      });
    } catch (error) {
      log("sso.test_record_failed", {
        level: "error",
        error: error instanceof Error ? error.name : "unknown",
      });
      return "recorded";
    }
  }

  /**
   * A begin challenge by its secret, NOT consumed yet (R1-L4): the callback / ACS verifies the
   * IdP's answer first and consumes the challenge only then, atomically with writing the handoff,
   * so whoever holds a RelayState or state cannot cancel somebody's sign-in by posting garbage.
   * An expired or used one still names where to send the browser back to.
   */
  async function peekBeginChallenge(
    kind: "oidc" | "saml",
    secretHash: Buffer,
    aad: string,
  ): Promise<
    | { ok: true; id: string; payload: BeginPayload; bindingHash: Buffer }
    | { ok: false; payload: BeginPayload | undefined }
  > {
    const at = now();
    return deps.db.withHost(async (tx) => {
      const ch = await findChallenge(tx, kind, secretHash);
      if (ch === undefined) return { ok: false as const, payload: undefined };
      const payload = openFlow<BeginPayload>((ch.data as { sealed?: unknown }).sealed, aad);
      if (
        payload === undefined ||
        payload.v !== 1 ||
        ch.bindingHash === null ||
        ch.workspaceId !== payload.workspaceId
      ) {
        return { ok: false as const, payload: undefined };
      }
      if (ch.consumedAt !== null || ch.expiresAt.getTime() <= at.getTime()) {
        return { ok: false as const, payload };
      }
      return { ok: true as const, id: ch.id, payload, bindingHash: ch.bindingHash };
    });
  }

  /** The live connection a flow step runs against, re-read (never trusted from the challenge). */
  async function flowConnection(
    payload: BeginPayload,
    connectionId: string,
  ): Promise<{ row: SsoConnectionRow; secret: string | undefined }> {
    if (payload.connectionId !== connectionId) {
      throw new SsoFlowError("invalid_response", "the response came back for another connection");
    }
    const sctx = sys(payload.workspaceId);
    const found = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new SsoConnectionRepo(sctx, tx).live();
      if (row === undefined || row.id !== connectionId) return undefined;
      return {
        row,
        secret: row.protocol === "oidc" ? await unsealSecret(tx, sctx, row) : undefined,
      };
    });
    if (found === undefined || found.row.protocol !== payload.protocol) {
      throw new SsoFlowError("disabled", "the connection was deleted or replaced");
    }
    if (payload.tester === undefined && (!found.row.enabled || !offered.has(found.row.protocol))) {
      throw new SsoFlowError("disabled", "the connection is disabled");
    }
    return found;
  }

  /**
   * Consumes the begin challenge (single use: `UPDATE … WHERE consumed_at IS NULL`), records the
   * SAML assertion id (replay), and stores the verified facts as the handoff — one host
   * transaction, so two concurrent callbacks for one begin produce exactly one handoff.
   */
  async function handOff(
    begin: BeginPayload,
    challenge: { readonly id: string; readonly bindingHash: Buffer },
    facts: Pick<
      HandoffPayload,
      "subject" | "email" | "displayName" | "authLevel" | "connectionVersion" | "idpAuthTime"
    >,
    assertion?: { readonly id: string; readonly expiresAt: Date } | undefined,
  ): Promise<string> {
    const token = randomToken(32);
    const at = now();
    const payload: HandoffPayload = {
      v: 1,
      protocol: begin.protocol,
      connectionId: begin.connectionId,
      workspaceId: begin.workspaceId,
      returnTo: begin.returnTo,
      tester: begin.tester,
      ...(begin.reauthUserId === undefined ? {} : { reauthUserId: begin.reauthUserId }),
      ...facts,
    };
    await deps.db.withHost(async (tx) => {
      if (!(await consumeChallenge(tx, challenge.id, at))) {
        throw new SsoFlowError("expired", "the sign-in was already completed");
      }
      if (assertion !== undefined) {
        await sweepAssertions(tx, at);
        const fresh = await recordAssertion(tx, {
          workspaceId: begin.workspaceId,
          connectionId: begin.connectionId,
          assertionId: assertion.id,
          expiresAt: assertion.expiresAt,
        });
        if (!fresh) throw new SsoFlowError("invalid_response", "assertion replayed");
      }
      await insertChallenge(tx, {
        kind: "sso_handoff",
        workspaceId: begin.workspaceId,
        secretHash: sha256(token),
        bindingHash: challenge.bindingHash,
        data: { sealed: sealFlow(payload, `sso-handoff:${token}`) },
        maxAttempts: 1,
        createdAt: at,
        expiresAt: new Date(at.getTime() + HANDOFF_TTL_MS),
      });
    });
    return `${begin.appBase}/api/v1/auth/sso/finish?h=${encodeURIComponent(token)}`;
  }

  /** Where a failed callback / ACS sends the browser (and a failed test's bookkeeping). */
  async function flowFailure(
    payload: BeginPayload | undefined,
    error: unknown,
    step: string,
  ): Promise<string> {
    const flow =
      error instanceof SsoFlowError
        ? error
        : new SsoFlowError("invalid_response", "unexpected failure", { cause: error });
    log("sso.flow_refused", {
      level: flow.code === "invalid_response" ? "warn" : "info",
      step,
      code: flow.code,
      reason: flow.reason,
      workspaceId: payload?.workspaceId,
      connectionId: payload?.connectionId,
      ...(error instanceof SsoFlowError
        ? {}
        : { error: error instanceof Error ? error.name : "unknown" }),
    });
    if (payload === undefined) return loginUrl(canonicalBase, flow.code);
    if (payload.tester !== undefined) {
      await recordTest(
        payload.workspaceId,
        payload.connectionId,
        payload.tester,
        flow.code,
        flow.reason,
      );
      return testUrl(payload.appBase, flow.code);
    }
    return loginUrl(payload.appBase, flow.code);
  }

  function cleanEmail(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    try {
      return normalizeEmail(raw);
    } catch {
      return undefined;
    }
  }

  function mapLoginError(error: AuthError): SsoFlowErrorCode {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    if (reason === "staff_only") return "staff_only";
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "not_eligible" || error.code === "membership_expired")
      return "not_provisioned";
    if (error.code === "conflict") return "staff_only";
    return "invalid_response";
  }

  // --- the service -----------------------------------------------------------------------------

  const service: SsoService = {
    spInfo,

    protocolsOffered() {
      return [...deps.protocols];
    },

    async getConnection(ctx) {
      const sctx = sys(ctx);
      const row = await deps.db.withTenant(sctx, (tx) => new SsoConnectionRepo(sctx, tx).live());
      return row === undefined ? null : viewOf(row);
    },

    async saveConnection(ctx, input, actor, options = {}) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const name = trimmedName(input.name);
      if (!JIT_ROLES.includes(input.jit.role)) {
        throw new SsoError("validation_failed", "that role cannot be given automatically", {
          reason: "jit_role",
        });
      }
      const mfaValues = cleanMfaValues(input.mfa.values);
      const previous = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new SsoConnectionRepo(sctx, tx).live();
        if (row === undefined) return undefined;
        return {
          row,
          secret: row.protocol === "oidc" ? await unsealSecret(tx, sctx, row) : undefined,
        };
      });
      // A protocol the operator stopped offering cannot be created or switched to; a live
      // connection on it may still be re-keyed (a leaked secret must be rotatable).
      if (!offered.has(input.protocol) && previous?.row.protocol !== input.protocol) {
        throw configError("protocol_unavailable", "that SSO protocol is not offered here");
      }
      // A-3 early answer, before any network probe: no connection, or another protocol, is a new
      // one. The locked check below is the authoritative one (it also sees another issuer).
      if (previous === undefined || previous.row.protocol !== input.protocol) {
        options.assertMayCreate?.();
      }
      // Live verification, no transaction open.
      const resolved: ResolvedOidc | ResolvedSaml =
        input.protocol === "oidc"
          ? await resolveOidc(input, previous)
          : resolveSaml(input, previous?.row);

      const at = now();
      const outcome = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (!offered.has(resolved.protocol) && live?.protocol !== resolved.protocol) {
          throw configError("protocol_unavailable", "that SSO protocol is not offered here");
        }
        // A-3: a new connection (none, or another IdP) needs the plan's `sso` feature; re-keying
        // the live one is maintenance and never does. Checked on the locked row.
        if (live === undefined || identityChanges(live, resolved)) {
          options.assertMayCreate?.();
        } else if (
          (!live.jitEnabled && input.jit.enabled) ||
          (live.options?.trustMfa !== true && input.mfa.trust)
        ) {
          // Decision 18: a re-key must not switch on JIT provisioning or trusted IdP MFA.
          options.assertMayTurnOn?.();
        }
        const sealed =
          resolved.protocol === "oidc"
            ? await sealSecret(tx, sctx, resolved.clientSecret)
            : undefined;
        const protocolValues =
          resolved.protocol === "oidc"
            ? {
                protocol: "oidc" as const,
                oidcIssuer: resolved.issuer,
                oidcClientId: resolved.clientId,
                credentialsEnc: sealed?.enc ?? null,
                encryption: sealed?.encryption ?? null,
                samlIdpEntityId: null,
                samlIdpSsoUrl: null,
                samlIdpCerts: null,
              }
            : {
                protocol: "saml" as const,
                oidcIssuer: null,
                oidcClientId: null,
                credentialsEnc: null,
                encryption: null,
                samlIdpEntityId: resolved.entityId,
                samlIdpSsoUrl: resolved.ssoUrl,
                samlIdpCerts: [...resolved.certificates],
              };
        const common = {
          name,
          options: { trustMfa: input.mfa.trust, mfaValues },
          jitEnabled: input.jit.enabled,
          jitRole: input.jit.role,
          status: "active" as const,
          lastError: null,
          lastVerifiedAt: at,
        };
        let row: SsoConnectionRow;
        let replaced: SsoConnectionRow | undefined;
        let securityChanged = false;
        if (live !== undefined && !identityChanges(live, resolved)) {
          securityChanged = securityRelevantChange(live, resolved, input);
          row =
            (await conns.update(live.id, {
              ...protocolValues,
              ...common,
              // Only a security-relevant change moves the version (FR3): the workspace mirror
              // follows it, so every session minted under the old settings stops serving at once,
              // while a cosmetic save (name, IdP URL) leaves them alone.
              version: live.version + (securityChanged ? 1 : 0),
            })) ?? live;
        } else {
          // A different IdP gets a different connection id: identities are keyed
          // `<connectionId>|<subject>`, and a subject from the new IdP must never match one the
          // old IdP assigned. The old row is soft-deleted (its sessions are revoked after commit)
          // and the new one starts disabled with enforcement off.
          if (live !== undefined) {
            await conns.update(live.id, { deletedAt: at, enabled: false, enforce: "off" });
            replaced = live;
          }
          row = await conns.insert({
            ...protocolValues,
            ...common,
            enabled: false,
            enforce: "off",
            createdByMembershipId: actor.membershipId,
          });
        }
        // Workspace row right before the audit: an in-place save moves the mirror to the new
        // version (every bound session minted under the old one stops serving at once); a
        // replacement starts disabled, so the mirror clears.
        await setWorkspaceSsoMirror(tx, sctx.workspaceId, row);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "sso.connection_saved",
          resourceKind: "sso_connection",
          resourceId: row.id,
          meta: {
            protocol: row.protocol,
            version: row.version,
            created: live === undefined,
            replaced: replaced !== undefined,
            ...(replaced === undefined ? {} : { previousConnectionId: replaced.id }),
            ...(resolved.protocol === "oidc" ? { secretChanged: resolved.secretChanged } : {}),
            ...(resolved.protocol === "saml" ? { certificates: resolved.certificates.length } : {}),
            jit: row.jitEnabled,
            jitRole: row.jitRole,
            trustMfa: input.mfa.trust,
            ...(securityChanged ? { sessionsRevoked: true } : {}),
          },
        });
        return { row, replaced, securityChanged };
      });
      discovery.forget(outcome.row.id);
      // A5: every save writes the workspace mirror; drop this process's resolver cache whatever
      // changed (the single-tenant resolver caches the resolved workspace).
      invalidateResolver();
      // R1-M2: a new secret, other certificates, another MFA mapping or JIT policy — the sessions
      // this connection minted under the old settings end (after commit).
      if (outcome.securityChanged) {
        await revokeAfterCommit(outcome.row.id, "sso_connection_changed");
      }
      if (outcome.replaced !== undefined) {
        await revokeAfterCommit(outcome.replaced.id, "sso_connection_replaced");
      }
      return viewOf(outcome.row);
    },

    async setState(ctx, input, actor, options = {}) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const enabled = input.enabled;
      // Disabling forces enforcement off (decision 8).
      const enforce = enabled ? input.enforce : "off";
      const result = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined) {
          throw new SsoError("sso_not_configured", "no SSO connection is configured");
        }
        // A-3: turning the connection on, or enforcement on, needs the plan's `sso` feature —
        // judged against the locked row, so a concurrent disable cannot make it look unchanged.
        if (stateTurnsOn(live, { enabled, enforce })) options.assertMayTurnOn?.();
        if (enabled && !offered.has(live.protocol)) {
          throw configError("protocol_unavailable", "that SSO protocol is not offered here");
        }
        if (enforce === "staff") {
          if (!enabled) {
            throw new SsoError("sso_enforce_precondition", "enable the connection first", {
              reason: "not_enabled",
            });
          }
          const testedOk = live.lastTestedAt !== null && live.lastError === null;
          if (live.lastLoginAt === null && !testedOk) {
            throw new SsoError(
              "sso_enforce_precondition",
              "sign in with SSO (or run a successful test) before requiring it",
              { reason: "never_signed_in" },
            );
          }
        }
        // FR3 (A3): turning the connection off or on bumps `version`, so nothing minted before a
        // disable — nor a handoff sealed before it — is admitted after a re-enable.
        const row =
          (await conns.update(live.id, {
            enabled,
            enforce,
            ...(enabled !== live.enabled ? { version: live.version + 1 } : {}),
          })) ?? live;
        // Workspace row right before the audit (global lock order).
        await setWorkspaceSsoMirror(tx, sctx.workspaceId, row);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "sso.state_changed",
          resourceKind: "sso_connection",
          resourceId: row.id,
          meta: {
            enabled: row.enabled,
            enforce: row.enforce,
            previousEnabled: live.enabled,
            previousEnforce: live.enforce,
          },
        });
        return row;
      });
      invalidateResolver();
      // R1-M2: disabling is the admin's emergency lever (a compromised IdP): the sessions this
      // connection minted end now, not at their absolute expiry.
      if (!result.enabled) await revokeAfterCommit(result.id, "sso_connection_disabled");
      return viewOf(result);
    },

    async deleteConnection(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const deleted = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined) {
          throw new SsoError("sso_not_configured", "no SSO connection is configured");
        }
        await conns.update(live.id, { deletedAt: now(), enabled: false, enforce: "off" });
        await setWorkspaceSsoMirror(tx, sctx.workspaceId, undefined);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "sso.connection_deleted",
          resourceKind: "sso_connection",
          resourceId: live.id,
          meta: { protocol: live.protocol, wasEnabled: live.enabled, wasEnforced: live.enforce },
        });
        return live;
      });
      invalidateResolver();
      await revokeAfterCommit(deleted.id, "sso_connection_deleted");
    },

    // --- domains -------------------------------------------------------------------------------

    async listDomains(ctx) {
      const sctx = sys(ctx);
      const rows = await deps.db.withTenant(sctx, (tx) => new SsoDomainRepo(sctx, tx).list());
      return rows.map(domainView);
    },

    async addDomain(ctx, rawDomain, actor) {
      refuseViewAs(ctx);
      const checked = normalizeSsoDomain(rawDomain);
      if (!checked.ok) {
        throw new SsoError("sso_domain_invalid", "that is not a domain this workspace can own", {
          reason: checked.reason,
        });
      }
      const sctx = sys(ctx);
      const row = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const domains = new SsoDomainRepo(sctx, tx);
        const existing = await domains.byDomain(checked.domain);
        if (existing !== undefined) return existing;
        if ((await domains.count()) >= SSO_MAX_DOMAINS) {
          throw new SsoError("sso_domain_invalid", `at most ${SSO_MAX_DOMAINS} domains`, {
            reason: "too_many",
          });
        }
        const created = await domains.insert({ domain: checked.domain, token: newDomainToken() });
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "sso.domain_added",
          resourceKind: "sso_domain",
          resourceId: created.id,
          meta: { domain: created.domain },
        });
        return created;
      });
      return domainView(row);
    },

    async verifyDomain(ctx, id, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      if (!UUID_RE.test(id)) throw new SsoError("not_found", "no such domain");
      const found = await deps.db.withTenant(sctx, (tx) => new SsoDomainRepo(sctx, tx).byId(id));
      if (found === undefined) throw new SsoError("not_found", "no such domain");
      // DNS with no transaction open.
      const lookup = (name: string): Promise<DnsAnswer> =>
        deps.dns.resolve(name, "TXT").catch(() => ({
          name,
          type: "TXT" as const,
          values: [] as string[],
          rcode: "other" as const,
          resolver: "none",
        }));
      /*
       * A-2: the current label first; the pre-rename `_seedhost-sso` only when it did not carry
       * the token. The domain is proven if either label holds this row's token (under either
       * value prefix — `evaluateTxt`). Each label is its own resolver call, so its own quorum,
       * and the verdict rests on exactly one answer: a match names the label that matched, a
       * miss on both is described against the label the admin is shown.
       */
      let verdict = evaluateTxt(await lookup(txtName(found.domain)), found.token);
      if (!verdict.ok) {
        const legacy = evaluateTxt(await lookup(legacyTxtName(found.domain)), found.token);
        if (legacy.ok) verdict = legacy;
      }
      const at = now();
      try {
        const row = await deps.db.withTenant(sctx, async (tx) => {
          const conns = new SsoConnectionRepo(sctx, tx);
          await conns.lockSingleton();
          const domains = new SsoDomainRepo(sctx, tx);
          const current = await domains.byIdForUpdate(id);
          if (current === undefined || current.token !== found.token) {
            throw new SsoError("not_found", "no such domain");
          }
          const becameVerified = verdict.ok && current.status !== "verified";
          const updated =
            (await domains.update(id, {
              lastCheckedAt: at,
              lastError: verdict.ok ? null : verdict.detail.slice(0, 500),
              ...(verdict.ok
                ? { status: "verified" as const, verifiedAt: current.verifiedAt ?? at }
                : {}),
            })) ?? current;
          if (becameVerified) {
            await deps.audit.record(tx, sctx, {
              ...actorAudit(ctx, actor),
              action: "sso.domain_verified",
              resourceKind: "sso_domain",
              resourceId: id,
              meta: { domain: current.domain },
            });
          }
          return updated;
        });
        return domainView(row);
      } catch (error) {
        if (
          pgErrorCode(error) === "23505" &&
          constraintNameOf(error) === "sso_domain_verified_idx"
        ) {
          // Never names the other workspace.
          throw new SsoError(
            "sso_domain_taken",
            "this domain is already verified for another workspace on this install",
          );
        }
        throw error;
      }
    },

    async removeDomain(ctx, id, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      if (!UUID_RE.test(id)) throw new SsoError("not_found", "no such domain");
      await deps.db.withTenant(sctx, async (tx) => {
        const conns = new SsoConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const domains = new SsoDomainRepo(sctx, tx);
        const current = await domains.byIdForUpdate(id);
        if (current === undefined) throw new SsoError("not_found", "no such domain");
        await domains.remove(id);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "sso.domain_removed",
          resourceKind: "sso_domain",
          resourceId: id,
          meta: { domain: current.domain, wasVerified: current.status === "verified" },
        });
      });
    },

    async verifiedDomains(tx, workspaceId) {
      return new SsoDomainRepo(sys(workspaceId), tx).verified();
    },

    async defaultStaffRole(tx, workspaceId) {
      return (await new SsoConnectionRepo(sys(workspaceId), tx).liveJitRole()) ?? "viewer";
    },

    // --- login flow ----------------------------------------------------------------------------

    async publicInfo(workspaceId) {
      const sctx = sys(workspaceId);
      const row = await deps.db.withTenant(sctx, (tx) => new SsoConnectionRepo(sctx, tx).live());
      if (row === undefined)
        return { available: false, name: null, protocol: null, enforced: false };
      const available = row.enabled && offered.has(row.protocol);
      return {
        available,
        name: available ? row.name : null,
        protocol: available ? row.protocol : null,
        enforced: row.enabled && row.enforce === "staff",
      };
    },

    async discover(input) {
      return withMinimumDuration(deps.discoverFloorMs ?? DEFAULT_DISCOVER_FLOOR_MS, async () => {
        if (input.ip !== undefined) {
          const r = await identity().deps.rateLimiter.hit(
            `sso:discover:${sha256Hex(input.ip)}`,
            RATE_LIMITS.oidcPerIp,
          );
          if (!r.allowed) {
            throw new SsoError("rate_limited", "too many attempts; try again later", {
              retryAfterMs: r.retryAfterMs,
            });
          }
        }
        const domain = emailDomain(cleanEmail(input.email));
        const sctx = sys(input.workspaceId);
        return deps.db.withTenant(sctx, async (tx) => {
          const row = await new SsoConnectionRepo(sctx, tx).live();
          if (row === undefined || !row.enabled || !offered.has(row.protocol)) return false;
          if (domain === undefined) return false;
          return new SsoDomainRepo(sctx, tx).isVerified(domain);
        });
      });
    },

    async begin(input) {
      const wiring = identity();
      if (input.ip !== undefined) {
        const r = await wiring.deps.rateLimiter.hit(
          `sso:begin:${sha256Hex(input.ip)}`,
          RATE_LIMITS.oidcPerIp,
        );
        if (!r.allowed) {
          throw new SsoError("rate_limited", "too many attempts; try again later", {
            retryAfterMs: r.retryAfterMs,
          });
        }
      }
      const sctx = sys(input.workspaceId);
      const found = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new SsoConnectionRepo(sctx, tx).live();
        if (row === undefined) return undefined;
        return {
          row,
          secret: row.protocol === "oidc" ? await unsealSecret(tx, sctx, row) : undefined,
        };
      });
      if (found === undefined) {
        throw new SsoError("sso_not_configured", "single sign-on is not set up for this workspace");
      }
      const { row } = found;
      const testing = input.tester !== undefined;
      if (!offered.has(row.protocol) || (!row.enabled && !testing)) {
        throw new SsoError("sso_disabled", "single sign-on is turned off for this workspace");
      }
      const sp = spInfo(row.id);
      const bindingToken = randomToken(16);
      const at = now();
      const base: Omit<BeginPayload, "verifier" | "nonce" | "requestId"> = {
        v: 1,
        protocol: row.protocol,
        connectionId: row.id,
        workspaceId: input.workspaceId,
        appBase: input.appBase,
        ...(input.reauthUserId === undefined ? {} : { reauthUserId: input.reauthUserId }),
        returnTo: input.returnTo,
        tester: input.tester,
      };
      const challenge = {
        workspaceId: input.workspaceId,
        bindingHash: sha256(bindingToken),
        maxAttempts: 1,
        ip: input.ip ?? null,
        createdAt: at,
        expiresAt: new Date(at.getTime() + BEGIN_TTL_MS),
      };
      let url: string;
      if (row.protocol === "oidc") {
        if (found.secret === undefined) {
          throw new SsoError(
            "sso_invalid_config",
            "the connection's client secret cannot be read; save it again",
            { reason: "secret_required" },
          );
        }
        let config: oidc.Configuration;
        try {
          config = await discovery.discover(`${row.id}:${row.version}`, {
            issuer: row.oidcIssuer ?? "",
            clientId: row.oidcClientId ?? "",
            clientSecret: found.secret,
          });
        } catch {
          throw new SsoError("sso_invalid_config", "the identity provider could not be reached", {
            reason: "discovery_failed",
          });
        }
        const verifier = oidc.randomPKCECodeVerifier();
        const codeChallenge = await oidc.calculatePKCECodeChallenge(verifier);
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const payload: BeginPayload = { ...base, verifier, nonce };
        await deps.db.withHost((tx) =>
          insertChallenge(tx, {
            ...challenge,
            kind: "oidc",
            // Namespaced so the instance-wide OIDC callback can never find this row.
            secretHash: sha256(`sso:${state}`),
            data: { sso: 1, sealed: sealFlow(payload, `sso-oidc:${state}`) },
          }),
        );
        const params: Record<string, string> = {
          redirect_uri: sp.oidcRedirectUri,
          scope: "openid email profile",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
        };
        const hint = input.loginHint?.trim();
        if (hint !== undefined && hint !== "" && hint.length <= 320) params["login_hint"] = hint;
        if (input.reauthUserId !== undefined) {
          // Re-authentication: the IdP must ask again, not reuse its own session (OIDC Core §3.1.2.1).
          params["prompt"] = "login";
          params["max_age"] = "0";
        }
        url = oidc.buildAuthorizationUrl(config, params).href;
      } else {
        const relayState = randomToken(24);
        const cache = oneShotCache();
        const saml = createSp(
          {
            entityId: sp.samlEntityId,
            acsUrl: sp.samlAcsUrl,
            idpSsoUrl: row.samlIdpSsoUrl ?? "",
            idpCerts: row.samlIdpCerts ?? [],
          },
          cache,
          { forceAuthn: input.reauthUserId !== undefined },
        );
        url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
        const requestId = cache.saved[0];
        if (requestId === undefined) throw new Error("node-saml recorded no request id");
        const payload: BeginPayload = { ...base, requestId };
        await deps.db.withHost((tx) =>
          insertChallenge(tx, {
            ...challenge,
            kind: "saml",
            secretHash: sha256(`sso:${relayState}`),
            data: { sso: 1, sealed: sealFlow(payload, `sso-saml:${relayState}`) },
          }),
        );
      }
      log("sso.begin", {
        workspaceId: input.workspaceId,
        connectionId: row.id,
        protocol: row.protocol,
        test: testing,
      });
      return { url, bindingToken, bindingMaxAgeSeconds: Math.ceil(BEGIN_TTL_MS / 1000) };
    },

    async oidcCallback(connectionId, currentUrl) {
      const state = currentUrl.searchParams.get("state");
      if (state === null || state === "" || state.length > 512) {
        return flowFailure(undefined, new SsoFlowError("expired", "no state"), "oidc_callback");
      }
      let taken: Awaited<ReturnType<typeof peekBeginChallenge>>;
      try {
        taken = await peekBeginChallenge("oidc", sha256(`sso:${state}`), `sso-oidc:${state}`);
      } catch (error) {
        return flowFailure(undefined, error, "oidc_callback");
      }
      if (!taken.ok) {
        return flowFailure(
          taken.payload,
          new SsoFlowError("expired", "unknown, used or expired state"),
          "oidc_callback",
        );
      }
      const begin = taken.payload;
      try {
        if (
          begin.protocol !== "oidc" ||
          begin.verifier === undefined ||
          begin.nonce === undefined
        ) {
          throw new SsoFlowError("invalid_response", "the state is not an OIDC sign-in");
        }
        const { row, secret } = await flowConnection(begin, connectionId);
        if (currentUrl.searchParams.has("error")) {
          throw new SsoFlowError("idp_error", "the identity provider returned an error");
        }
        let config: oidc.Configuration;
        try {
          config = await discovery.discover(`${row.id}:${row.version}`, {
            issuer: row.oidcIssuer ?? "",
            clientId: row.oidcClientId ?? "",
            clientSecret: secret,
          });
        } catch (error) {
          throw new SsoFlowError("idp_error", "discovery failed", { cause: error });
        }
        // The redirect URI we registered, whatever host header the proxy passed along.
        const callbackUrl = new URL(spInfo(row.id).oidcRedirectUri);
        callbackUrl.search = currentUrl.search;
        let claims: oidc.IDToken | undefined;
        try {
          const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
            pkceCodeVerifier: begin.verifier,
            expectedState: state,
            expectedNonce: begin.nonce,
            idTokenExpected: true,
          });
          claims = tokens.claims();
        } catch (error) {
          throw new SsoFlowError("invalid_response", "the code exchange or ID token was refused", {
            cause: error,
          });
        }
        if (claims === undefined || typeof claims.sub !== "string" || claims.sub === "") {
          throw new SsoFlowError("invalid_response", "no ID token subject");
        }
        if (claims.sub.length > 255) throw new SsoFlowError("invalid_response", "subject too long");
        const authTime = typeof claims.auth_time === "number" ? claims.auth_time * 1000 : undefined;
        if (begin.reauthUserId !== undefined) requireFreshAuthentication(authTime);
        const options = row.options ?? {};
        const displayName =
          typeof claims["name"] === "string" ? claims["name"].trim().slice(0, 200) : undefined;
        return await handOff(begin, taken, {
          connectionVersion: row.version,
          idpAuthTime: plausibleAuthTime(authTime),
          subject: claims.sub,
          email: cleanEmail(claims["email"]),
          displayName: displayName === "" ? undefined : displayName,
          authLevel: oidcLoginLevel(
            { trust: options.trustMfa === true, values: options.mfaValues ?? [] },
            { amr: claims["amr"], acr: claims["acr"] },
          ),
        });
      } catch (error) {
        return flowFailure(begin, error, "oidc_callback");
      }
    },

    async samlAcs(connectionId, form) {
      const relayState = form.RelayState;
      if (relayState === undefined || !TOKEN_RE.test(relayState)) {
        return flowFailure(undefined, new SsoFlowError("expired", "no RelayState"), "saml_acs");
      }
      let taken: Awaited<ReturnType<typeof peekBeginChallenge>>;
      try {
        taken = await peekBeginChallenge(
          "saml",
          sha256(`sso:${relayState}`),
          `sso-saml:${relayState}`,
        );
      } catch (error) {
        return flowFailure(undefined, error, "saml_acs");
      }
      if (!taken.ok) {
        return flowFailure(
          taken.payload,
          new SsoFlowError("expired", "unknown, used or expired RelayState"),
          "saml_acs",
        );
      }
      const begin = taken.payload;
      try {
        if (begin.protocol !== "saml" || begin.requestId === undefined) {
          throw new SsoFlowError("invalid_response", "the RelayState is not a SAML sign-in");
        }
        const response = form.SAMLResponse;
        if (
          response === undefined ||
          response === "" ||
          response.length > SAML_RESPONSE_MAX_CHARS
        ) {
          throw new SsoFlowError("invalid_response", "no usable SAMLResponse");
        }
        const { row } = await flowConnection(begin, connectionId);
        const sp = spInfo(row.id);
        const saml = createSp(
          {
            entityId: sp.samlEntityId,
            acsUrl: sp.samlAcsUrl,
            idpSsoUrl: row.samlIdpSsoUrl ?? "",
            idpCerts: row.samlIdpCerts ?? [],
          },
          oneShotCache(begin.requestId),
        );
        let profile: Awaited<ReturnType<typeof saml.validatePostResponseAsync>>["profile"];
        try {
          ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: response }));
        } catch (error) {
          const status = error instanceof Error && error.name === "SamlStatusError";
          throw new SsoFlowError(
            status ? "idp_error" : "invalid_response",
            status
              ? "the IdP answered with a non-success status"
              : "node-saml refused the response",
            { cause: error },
          );
        }
        const assertionXml = profile?.getAssertionXml?.();
        if (profile === null || assertionXml === undefined) {
          throw new SsoFlowError("invalid_response", "no signed assertion");
        }
        const at = now();
        let checked: ReturnType<typeof checkAssertion>;
        try {
          checked = checkAssertion(assertionXml, {
            requestId: begin.requestId,
            acsUrl: sp.samlAcsUrl,
            idpEntityId: row.samlIdpEntityId ?? "",
            audience: sp.samlEntityId,
            now: at,
          });
          checkResponse(Buffer.from(response, "base64").toString("utf8"), sp.samlAcsUrl);
        } catch (error) {
          if (error instanceof SamlAssertionError) {
            throw new SsoFlowError("invalid_response", error.message, { cause: error });
          }
          throw error;
        }
        if (begin.reauthUserId !== undefined) {
          requireFreshAuthentication(checked.authnInstant?.getTime());
        }
        const claims = samlIdentityClaims(checked);
        const options = row.options ?? {};
        return await handOff(
          begin,
          taken,
          {
            connectionVersion: row.version,
            idpAuthTime: plausibleAuthTime(checked.authnInstant?.getTime()),
            subject: checked.nameId,
            email: cleanEmail(claims.email),
            displayName: claims.displayName,
            authLevel: samlLoginLevel(
              { trust: options.trustMfa === true, values: options.mfaValues ?? [] },
              checked.authnContextClassRefs,
            ),
          },
          { id: checked.assertionId, expiresAt: checked.expiresAt },
        );
      } catch (error) {
        return flowFailure(begin, error, "saml_acs");
      }
    },

    async spMetadata(connectionId) {
      if (!UUID_RE.test(connectionId)) return undefined;
      const row = await deps.db.withHost((tx) => hostFindConnection(tx, connectionId));
      if (row === undefined || row.deletedAt !== null || row.protocol !== "saml") return undefined;
      const sp = spInfo(row.id);
      return spMetadataXml(sp.samlEntityId, sp.samlAcsUrl);
    },

    async finish(input): Promise<SsoFinishResult> {
      const wiring = identity();
      const token = input.handoff;
      if (!TOKEN_RE.test(token)) return { kind: "error", code: "expired" };
      const at = now();
      const taken = await deps.db.withHost(async (tx) => {
        const ch = await findChallenge(tx, "sso_handoff", sha256(token));
        if (ch === undefined || ch.consumedAt !== null) return { error: "expired" as const };
        if (ch.expiresAt.getTime() <= at.getTime()) return { error: "expired" as const };
        // Binding first: a foreign browser replaying the finish URL must not burn the handoff.
        const bound =
          input.bindingToken !== undefined &&
          ch.bindingHash !== null &&
          safeEqual(sha256(input.bindingToken), ch.bindingHash);
        if (!bound) return { error: "binding_mismatch" as const };
        if (ch.workspaceId === null || ch.workspaceId !== input.workspaceId) {
          return { error: "binding_mismatch" as const };
        }
        if (!(await consumeChallenge(tx, ch.id, at))) return { error: "expired" as const };
        const payload = openFlow<HandoffPayload>(
          (ch.data as { sealed?: unknown }).sealed,
          `sso-handoff:${token}`,
        );
        if (payload === undefined || payload.v !== 1 || payload.workspaceId !== ch.workspaceId) {
          return { error: "invalid_response" as const };
        }
        return { payload };
      });
      if ("error" in taken) {
        log("sso.finish_refused", { code: taken.error, workspaceId: input.workspaceId });
        return { kind: "error", code: taken.error };
      }
      const facts = taken.payload;
      const workspaceId = facts.workspaceId;

      // A test: everything was verified; nothing is written but the test's result.
      if (facts.tester !== undefined) {
        // R3-L2 / FR3-A4: the tester must STILL hold sso.manage — re-checked under a lock in the
        // same transaction that records the result (a demotion mid-flow writes nothing).
        const recorded = await recordTest(
          workspaceId,
          facts.connectionId,
          facts.tester,
          "ok",
          undefined,
          true,
        );
        if (recorded === "forbidden") {
          log("sso.test_refused", { workspaceId, connectionId: facts.connectionId });
          return { kind: "test", outcome: "forbidden" };
        }
        return { kind: "test", outcome: "ok" };
      }

      const refuse = async (code: SsoFlowErrorCode, userId?: string): Promise<SsoFinishResult> => {
        log("sso.login_refused", { code, workspaceId, connectionId: facts.connectionId });
        await auditLoginFailure(wiring.deps, {
          workspaceId,
          userId,
          method: "sso",
          reason: code,
          ip: input.login.ip,
          userAgent: input.login.userAgent,
        });
        return { kind: "error", code };
      };

      const sctx = sys(workspaceId);
      const state = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new SsoConnectionRepo(sctx, tx).live();
        if (row === undefined || row.id !== facts.connectionId || !row.enabled) return undefined;
        if (!offered.has(row.protocol)) return undefined;
        const domain = emailDomain(facts.email);
        const verified =
          domain === undefined ? false : await new SsoDomainRepo(sctx, tx).isVerified(domain);
        return { row, verified };
      });
      if (state === undefined) return refuse("disabled");

      const identifier = `${facts.connectionId}|${facts.subject}`;
      const users = await deps.db.withHost(async (tx) => ({
        identityUserId: await findUserByIdentity(tx, facts.protocol, identifier),
        emailUserId:
          facts.email === undefined
            ? undefined
            : await findUserByIdentity(tx, "email", facts.email),
      }));
      const memberships = await deps.db.withTenant(sctx, async (tx) => {
        const of = async (userId: string | undefined): Promise<LinkMembershipFact | undefined> => {
          if (userId === undefined) return undefined;
          const m = await findLiveMembership(tx, sctx, userId);
          return m === undefined ? undefined : { kind: m.kind, status: m.status };
        };
        return {
          identity: await of(users.identityUserId),
          email: await of(users.emailUserId),
        };
      });
      const decision = decideSsoLogin({
        identityUserId: users.identityUserId,
        email: facts.email,
        emailDomainVerified: state.verified,
        emailUserId: users.emailUserId,
        emailUserMembership: memberships.email,
        identityUserMembership: memberships.identity,
        jit: { enabled: state.row.jitEnabled, role: state.row.jitRole },
      });
      if (decision.kind === "refuse") {
        return refuse(decision.code, users.identityUserId ?? users.emailUserId);
      }
      // SSO re-authentication (FR4): the IdP must name the SAME user whose bound session asked;
      // anything else (another person, a JIT newcomer) is refused before any session or
      // membership is touched, so the current session is never swapped for someone else's.
      if (
        facts.reauthUserId !== undefined &&
        (decision.kind !== "login" || decision.userId !== facts.reauthUserId)
      ) {
        return refuse("reauth_mismatch", facts.reauthUserId);
      }

      let userId: string;
      let link = decision.link;
      if (decision.kind === "jit") {
        try {
          const provisioned = await wiring.memberships.provisionStaff(
            sctx,
            {
              email: decision.email,
              ...(facts.displayName === undefined ? {} : { displayName: facts.displayName }),
              role: decision.role,
              source: "sso",
            },
            { kind: "system", label: `sso:${facts.connectionId}` },
          );
          userId = provisioned.userId;
          if (decision.userId !== undefined && decision.userId !== userId) {
            return refuse("invalid_response", userId);
          }
          if (!provisioned.adopted) {
            await deps.db.withTenant(sctx, (tx) =>
              deps.audit.record(tx, sctx, {
                actorKind: "system",
                actorMembershipId: null,
                action: "sso.jit_provisioned",
                resourceKind: "sso_connection",
                resourceId: facts.connectionId,
                subjectMembershipId: provisioned.membershipId,
                meta: {
                  role: decision.role,
                  newUser: provisioned.created,
                  protocol: facts.protocol,
                },
              }),
            );
          }
        } catch (error) {
          if (isAuthError(error)) return refuse(mapLoginError(error));
          throw error;
        }
        if (users.identityUserId === undefined) link = true;
      } else {
        userId = decision.userId;
      }

      let result: Awaited<ReturnType<typeof completeLogin>>;
      try {
        result = await completeLogin(wiring.deps, wiring.sessions, {
          ...input.login,
          workspaceId,
          userId,
          authLevel: facts.authLevel,
          // FR5: the session is as fresh as the IdP's own authentication — never fresher. With no
          // time from the IdP it starts stale, so fresh-gated routes demand a step-up/reauth.
          authTime:
            facts.idpAuthTime !== undefined
              ? new Date(Math.min(at.getTime(), facts.idpAuthTime))
              : new Date(at.getTime() - STEP_UP_MAX_AGE_MS - 1000),
          method: "sso",
          sso: {
            workspaceId,
            connectionId: facts.connectionId,
            connectionVersion: facts.connectionVersion,
          },
          embed: false,
        });
      } catch (error) {
        if (isAuthError(error)) return refuse(mapLoginError(error), userId);
        throw error;
      }
      await deps.hooks?.afterCompleteLogin?.({ userId, sessionId: result.session.sessionId });
      // R1-L4: an erasure (or revocation) of this member may have landed since completeLogin read
      // the membership. The identity link is written in ONE transaction that first locks the
      // membership (erasure takes it FOR UPDATE, so the two serialise) and re-checks it is still a
      // live staff seat: an erased member never gets an SSO identity row back, and the session
      // just minted for them is revoked.
      const membershipId = result.membership?.id;
      const uctx: TenantContext = { ...sctx, userId };
      const verdict = await deps.db.withTenant(uctx, async (tx) => {
        // R3-M1: the connection row FOR SHARE first (global order: connection → membership →
        // workspace/audit). setState / save / delete hold it FOR UPDATE, so whichever of this
        // login and a disable (or delete, or a security-relevant save, which bumps `version`)
        // commits second sees the other: here, the same id + enabled + version this finish
        // started with; there, the session row this login inserted.
        const conn = await new SsoConnectionRepo(uctx, tx).byIdForShare(facts.connectionId);
        if (
          conn === undefined ||
          conn.deletedAt !== null ||
          !conn.enabled ||
          conn.version !== facts.connectionVersion
        ) {
          return "disabled" as const;
        }
        if (
          membershipId === undefined ||
          !(await lockLiveStaffMembership(tx, uctx, membershipId))
        ) {
          return "not_provisioned" as const;
        }
        if (link) await addSsoIdentity(tx, userId, facts.protocol, identifier, at);
        return "ok" as const;
      });
      if (verdict !== "ok") {
        await wiring.sessions.revokeSession(
          result.session.sessionId,
          verdict === "disabled" ? "sso_connection_deleted" : "membership_revoked",
        );
        return refuse(verdict, userId);
      }
      // Outside the link transaction: two concurrent finishes both hold the row FOR SHARE, and
      // upgrading to an UPDATE there would deadlock them. A plain row update in its own tx.
      await deps.db.withTenant(sctx, async (tx) => {
        await new SsoConnectionRepo(sctx, tx).update(facts.connectionId, { lastLoginAt: at });
      });
      return { kind: "session", result, returnTo: facts.returnTo };
    },
  };
  return service;
}
