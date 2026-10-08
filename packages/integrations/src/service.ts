import { randomUUID } from "node:crypto";
import type { AuditInput } from "@fundroom/audit";
import {
  findWorkspaceById,
  isPlatformWorkspace,
  listActiveWorkspaceIds,
  listLiveWorkspaceIds,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { GroupRepo, MembershipRepo } from "@fundroom/identity";
import type {
  IntegrationBookingView,
  IntegrationConnectionSummary,
  IntegrationServices,
} from "@fundroom/module-kit";
import type {
  BookingEvent,
  IntegrationAdapter,
  IntegrationAuth,
  IntegrationProvider,
  JobDefinition,
  JsonObject,
  OAuthTokenSet,
} from "@fundroom/ports";
import { IntegrationError } from "./errors.js";
import {
  audienceAdmits,
  BOOKING_LINK_MAX,
  bookingUpdate,
  checkBookingLinkUrl,
  checkReturnPath,
  checkSecretCredentials,
  clip,
  decodeBookingCursor,
  encodeBookingCursor,
  isUuid,
  looksLikeToken,
  mintSecret,
  normalizeInviteeEmail,
  parseAccounts,
  parseAudience,
  pkceChallenge,
  resultQuery,
  sameDigest,
  sha256,
  stripeKeyEnvironment,
} from "./policy.js";
import { BookingLinkRepo, type BookingLinkRow } from "./repos/booking-link-repo.js";
import { BookingRepo, type BookingRow } from "./repos/booking-repo.js";
import {
  ConnectionRepo,
  type ConnectionRow,
  findConnectionForWebhook,
  type NewConnectionValues,
} from "./repos/connection-repo.js";
import { liveMembershipByEmail } from "./repos/member-repo.js";
import { claimState, claimTicket, OAuthStateRepo } from "./repos/oauth-state-repo.js";
import { bookingSuppressionChecker } from "./suppression.js";
import { authOf, createTokenBroker, NOT_CONNECTED, safely } from "./tokens.js";
import {
  BOOKING_WEBHOOK_PATH_PREFIX,
  type BookingLinkAudience,
  type BookingLinkPublic,
  type BookingLinkView,
  type BookingProvider,
  DEFAULT_RETURN_PATH,
  INTEGRATION_CRONS,
  INTEGRATION_JOBS,
  type IntegrationActor,
  type IntegrationBookingRecord,
  type IntegrationConnectGate,
  type IntegrationConnectionView,
  type IntegrationProviderInfo,
  type IntegrationsKernel,
  type IntegrationsServiceDeps,
  OAUTH_CALLBACK_PATH,
  OAUTH_START_PATH,
} from "./types.js";
import { createVault, type SealedRef, type StoredCredentials } from "./vault.js";

/*
 * The kernel integrations hub (E3.6, ADR-0054).
 *
 * Transactions. Every vendor call happens OUTSIDE any transaction (pool-deadlock rule): short tx
 * (read / claim) → vendor call → short tx that re-locks the connection row by id and re-checks it
 * is still live before writing. A disconnect that lands while a vendor answers therefore wins: the
 * late answer writes nothing.
 *
 * Lock order on every connection write: per-(workspace, provider) singleton advisory lock
 * `integration.connection:<ws>:<provider>` → connection row (FOR UPDATE) → audit chain (the
 * workspace row, via lockAuditChain) → outbox. Booking ingest: the workspace's booking advisory
 * lock → booking rows → outbox. Booking links: the workspace's link advisory lock → link rows →
 * audit → outbox.
 *
 * DB work runs in the workspace's `system` context; audit rows name the real actor explicitly.
 * Nothing that leaves this service — a view, an error, a log line, a redirect — carries a token,
 * a code, a pasted secret or a vendor's error text.
 */

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** A verified OAuth grant waiting for the initiator's confirmation (sealed on the state row). */
interface PendingGrant {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly scope: string | null;
  readonly externalAccountId: string | null;
  readonly accountLabel: string | null;
  readonly accounts?: readonly { readonly id: string; readonly name: string }[] | undefined;
}

const BOOKING_PROVIDERS: ReadonlySet<string> = new Set(["calendly", "calcom"]);
/** A member may have at most this many OAuth handshakes open at once. */
export const OAUTH_OPEN_PER_MEMBER = 10;
const TICKET_TTL_MS = 2 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
/** Recorded bookings are kept 400 days after the meeting (contract §2). */
export const BOOKING_RETENTION_DAYS = 400;
/** At most this many events are taken from one webhook delivery. */
const MAX_EVENTS_PER_WEBHOOK = 50;
/** A webhook-secret rotation holds its lease at most this long (a crashed one frees itself). */
const ROTATION_LEASE_MS = 60_000;

export function createIntegrationsService(deps: IntegrationsServiceDeps): IntegrationsKernel {
  const now = deps.now ?? (() => new Date());
  const log: Log = deps.log ?? (() => {});
  const vault = createVault(deps);
  const broker = createTokenBroker({ deps, vault, now, log });
  const { withAuth, sys } = broker;
  const publicBase = deps.publicBaseUrl.replace(/\/+$/u, "");

  // --- helpers ---------------------------------------------------------------------------------

  function refuseViewAs(ctx: TenantContext): void {
    if (ctx.viewAs !== undefined) {
      throw new IntegrationError("conflict", "view-as is read only", {
        reason: "view_as_read_only",
      });
    }
  }

  function adapterOf(provider: IntegrationProvider): IntegrationAdapter {
    const a = deps.adapters[provider];
    if (a === undefined) {
      throw new IntegrationError("unknown_provider", `no integration named ${provider}`, {
        provider,
      });
    }
    return a;
  }

  function isBooking(adapter: IntegrationAdapter): boolean {
    return (
      BOOKING_PROVIDERS.has(adapter.meta.provider) &&
      adapter.meta.capabilities.includes("booking") &&
      adapter.booking !== undefined
    );
  }

  function actorAudit(ctx: TenantContext, actor: IntegrationActor): Partial<AuditInput> {
    return {
      actorKind: ctx.actorKind,
      actorMembershipId: actor.membershipId,
      actorUserId: ctx.userId ?? null,
      requestId: actor.requestId ?? null,
      sessionId: actor.sessionId ?? null,
      ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    };
  }

  function webhookUrl(connectionId: string): string {
    return `${publicBase}${BOOKING_WEBHOOK_PATH_PREFIX}${connectionId}`;
  }

  function redirectUri(): string {
    return `${publicBase}${OAUTH_CALLBACK_PATH}`;
  }

  function viewOf(row: ConnectionRow, creds?: StoredCredentials): IntegrationConnectionView {
    const adapter = deps.adapters[row.provider];
    const accounts = row.provider === "xero" ? (creds?.accounts ?? []) : undefined;
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      environment: row.environment,
      accountLabel: row.accountLabel,
      externalAccountId: row.externalAccountId,
      ...(accounts === undefined
        ? {}
        : { availableAccounts: accounts.map((a) => ({ id: a.id, name: a.name })) }),
      scope: row.scope,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
      connectedAt: row.createdAt,
      webhookUrl: adapter !== undefined && isBooking(adapter) ? webhookUrl(row.id) : null,
    };
  }

  function summaryOf(row: ConnectionRow): IntegrationConnectionSummary {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      accountLabel: row.accountLabel,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastError: row.lastError,
    };
  }

  async function liveView(
    sctx: TenantContext,
    provider: IntegrationProvider,
  ): Promise<IntegrationConnectionView> {
    const view = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ConnectionRepo(sctx, tx).live(provider);
      if (row === undefined) return undefined;
      const creds =
        row.provider === "xero" ? await vault.unsealCredentials(tx, sctx, row) : undefined;
      return viewOf(row, creds);
    });
    if (view === undefined) {
      throw new IntegrationError("integration_not_connected", `${provider} is not connected`);
    }
    return view;
  }

  /**
   * Best effort, after commit: revoke a replaced/disconnected OAuth grant and remove a booking
   * webhook subscription. Never throws; never logs a token.
   */
  async function cleanup(
    provider: IntegrationProvider,
    previous: { row: ConnectionRow; creds: StoredCredentials | undefined },
    options: { readonly revoke: boolean },
  ): Promise<void> {
    const adapter = deps.adapters[provider];
    if (adapter === undefined || previous.creds === undefined) return;
    const creds = previous.creds;
    const subscription = previous.row.webhookSubscriptionId;
    if (subscription !== null && adapter.booking?.unsubscribe !== undefined) {
      try {
        await adapter.booking.unsubscribe(authOf(previous.row, creds), subscription);
      } catch {
        log("integrations.unsubscribe_failed", { provider });
      }
    }
    if (options.revoke && previous.row.authKind === "oauth2" && adapter.revoke !== undefined) {
      const token = creds.refreshToken ?? creds.accessToken;
      if (token !== "") {
        try {
          await adapter.revoke({ token, client: deps.oauthClients[provider] ?? null });
        } catch {
          log("integrations.revoke_failed", { provider });
        }
      }
    }
  }

  /**
   * The one write that makes a connection live: under the singleton lock, soft-deletes the live
   * one of that provider (if any), inserts the new row, audits `integration.connected` and
   * publishes `integration.connection_changed`. Returns what the caller must clean up after
   * commit. `guard` runs first inside the tx (e.g. the OAuth initiator is still a live member).
   */
  async function replaceConnection(
    sctx: TenantContext,
    provider: IntegrationProvider,
    values: (tx: Tx) => Promise<NewConnectionValues>,
    who: Partial<AuditInput>,
    guard?: (tx: Tx) => Promise<void>,
    gate?: IntegrationConnectGate,
  ): Promise<{
    row: ConnectionRow;
    previous: { row: ConnectionRow; creds: StoredCredentials | undefined } | undefined;
  }> {
    return deps.db.withTenant(sctx, async (tx) => {
      const conns = new ConnectionRepo(sctx, tx);
      await conns.lockSingleton(provider);
      if (guard !== undefined) await guard(tx);
      const live = await conns.liveForUpdate(provider);
      // A-3, authoritative: no live connection of this provider under the lock = a new one.
      if (live === undefined) gate?.assertMayConnect?.();
      let previous: { row: ConnectionRow; creds: StoredCredentials | undefined } | undefined;
      if (live !== undefined) {
        previous = { row: live, creds: await vault.unsealCredentials(tx, sctx, live) };
        await conns.update(live.id, { deletedAt: now(), refreshLeaseUntil: null });
      }
      const row = await conns.insert(await values(tx));
      await deps.audit.record(tx, sctx, {
        ...who,
        action: "integration.connected",
        resourceKind: "integration_connection",
        resourceId: row.id,
        meta: {
          provider,
          authKind: row.authKind,
          environment: row.environment,
          replaced: live !== undefined,
          previousConnectionId: live?.id ?? null,
        },
      });
      await publish(tx, sctx, "integration.connection_changed", {
        connectionId: row.id,
        provider,
        change: "connected",
      });
      return { row, previous };
    });
  }

  // --- providers -------------------------------------------------------------------------------

  function providers(): IntegrationProviderInfo[] {
    const out: IntegrationProviderInfo[] = [];
    for (const adapter of Object.values(deps.adapters)) {
      if (adapter === undefined) continue;
      const m = adapter.meta;
      out.push({
        provider: m.provider,
        displayName: m.displayName,
        capabilities: [...m.capabilities],
        auth: m.auth,
        available: m.auth === "secret" || deps.oauthClients[m.provider] !== undefined,
        credentialFields: m.auth === "secret" ? [...(m.credentialFields ?? [])] : [],
        scopeExplanation: [...m.scopeExplanation],
        kpiMetrics: [...(adapter.kpi?.metrics ?? [])],
        bookingLinkHosts: [...(adapter.booking?.linkHosts ?? [])],
        subProcessor: { ...m.subProcessor },
      });
    }
    return out;
  }

  /** A-3: the plan's connect gate, unlocked pre-check (no live connection of `provider`). */
  async function precheckConnect(
    sctx: TenantContext,
    provider: IntegrationProvider,
    gate: IntegrationConnectGate,
  ): Promise<void> {
    const assertMayConnect = gate.assertMayConnect;
    if (assertMayConnect === undefined) return;
    const live = await deps.db.withTenant(sctx, (tx) =>
      new ConnectionRepo(sctx, tx).live(provider),
    );
    if (live === undefined) assertMayConnect();
  }

  // --- secret connect --------------------------------------------------------------------------

  async function connectWithSecret(
    ctx: TenantContext,
    provider: IntegrationProvider,
    input: IntegrationConnectGate & {
      readonly credentials: Readonly<Record<string, string>>;
      readonly environment?: "production" | "sandbox" | undefined;
    },
    actor: IntegrationActor,
  ): Promise<{ connection: IntegrationConnectionView; webhookSecret?: string }> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    const adapter = adapterOf(provider);
    if (adapter.meta.auth === "oauth2") {
      throw new IntegrationError(
        "integration_oauth_required",
        `${adapter.meta.displayName} connects through its own sign-in; use oauth/begin`,
      );
    }
    // A-3: refused before the vendor is asked anything (re-checked under the lock on write).
    await precheckConnect(sctx, provider, input);
    const { credentials, accessToken } = checkSecretCredentials(
      adapter.meta.credentialFields ?? [],
      input.credentials,
    );
    const environment =
      provider === "stripe"
        ? stripeKeyEnvironment(accessToken)
        : (input.environment ?? "production");
    const auth: IntegrationAuth = { accessToken, externalAccountId: null, environment };

    // Live verification before anything is stored, with no transaction open.
    const verdict = await safely(() => adapter.verify(auth));
    if (!verdict.ok) {
      throw new IntegrationError(
        "integration_credentials_rejected",
        `${adapter.meta.displayName} did not accept these credentials`,
        { reason: verdict.reason },
      );
    }
    const accountLabel = clip(verdict.value.accountLabel, 200);
    const externalAccountId = clip(verdict.value.externalAccountId, 300);

    // Booking providers: our signing key, and (Calendly) the vendor-side subscription — created
    // before the row exists, on the id the row will get, outside any transaction.
    const booking = isBooking(adapter);
    const id = randomUUID();
    const webhookSecret = booking ? mintSecret() : undefined;
    let subscriptionId: string | null = null;
    const subscribe = adapter.booking?.subscribe;
    if (booking && webhookSecret !== undefined && subscribe !== undefined) {
      const subAuth = { ...auth, externalAccountId };
      const sub = await safely(() =>
        subscribe.call(adapter.booking, subAuth, {
          callbackUrl: webhookUrl(id),
          signingKey: webhookSecret,
        }),
      );
      if (!sub.ok) {
        throw new IntegrationError(
          "integration_credentials_rejected",
          `${adapter.meta.displayName} did not accept the webhook subscription`,
          { reason: "subscribe_failed", providerReason: sub.reason },
        );
      }
      subscriptionId = clip(sub.value.subscriptionId, 300);
    }

    const stored: StoredCredentials = { accessToken, fields: credentials };
    let saved: Awaited<ReturnType<typeof replaceConnection>>;
    try {
      saved = await replaceConnection(
        sctx,
        provider,
        async (tx) => {
          const creds = await vault.sealCredentials(tx, sctx, stored);
          const secret =
            webhookSecret === undefined ? undefined : await vault.seal(tx, sctx, webhookSecret);
          const encryption: { credentials: SealedRef; webhookSecret?: SealedRef } = {
            credentials: creds.ref,
            ...(secret === undefined ? {} : { webhookSecret: secret.ref }),
          };
          return {
            id,
            provider,
            authKind: "secret",
            environment,
            credentialsEnc: creds.enc,
            encryption,
            accountLabel,
            externalAccountId,
            webhookSecretEnc: secret?.enc ?? null,
            webhookSubscriptionId: subscriptionId,
            lastSuccessAt: now(),
            createdByMembershipId: actor.membershipId,
          };
        },
        actorAudit(ctx, actor),
        undefined,
        input,
      );
    } catch (error) {
      if (subscriptionId !== null && adapter.booking?.unsubscribe !== undefined) {
        await adapter.booking.unsubscribe(auth, subscriptionId).catch(() => {});
      }
      throw error;
    }
    if (saved.previous !== undefined) await cleanup(provider, saved.previous, { revoke: false });
    return {
      connection: viewOf(saved.row),
      ...(webhookSecret === undefined ? {} : { webhookSecret }),
    };
  }

  // --- OAuth -----------------------------------------------------------------------------------

  function oauthErrorUrl(reason: string): string {
    return `${publicBase}${DEFAULT_RETURN_PATH}?${resultQuery(null, "error", reason)}`;
  }

  async function beginOAuth(
    ctx: TenantContext,
    provider: IntegrationProvider,
    input: IntegrationConnectGate & {
      readonly environment?: "production" | "sandbox" | undefined;
      readonly returnPath?: string | undefined;
    },
    actor: IntegrationActor,
  ): Promise<{ startUrl: string; expiresAt: Date }> {
    refuseViewAs(ctx);
    const adapter = adapterOf(provider);
    if (adapter.meta.auth !== "oauth2" || adapter.meta.oauth === undefined) {
      throw new IntegrationError(
        "conflict",
        `${adapter.meta.displayName} connects with a pasted credential`,
        {
          reason: "secret_provider",
        },
      );
    }
    const client = deps.oauthClients[provider];
    if (client === undefined) {
      throw new IntegrationError(
        "integration_not_available",
        `the operator has not configured ${adapter.meta.displayName} on this install`,
      );
    }
    if (actor.membershipId === null) {
      throw new IntegrationError(
        "validation_failed",
        "a signed-in member must start the connection",
        {
          reason: "member_required",
        },
      );
    }
    const membershipId = actor.membershipId;
    const sctx = sys(ctx);
    const ticket = mintSecret();
    const at = now();
    const expiresAt = new Date(at.getTime() + TICKET_TTL_MS);
    await deps.db.withTenant(sctx, async (tx) => {
      // A-3: a handshake for a provider the workspace has not connected needs the plan's feature
      // (the confirm step checks again under the lock).
      if (
        input.assertMayConnect !== undefined &&
        (await new ConnectionRepo(sctx, tx).live(provider)) === undefined
      ) {
        input.assertMayConnect();
      }
      const repo = new OAuthStateRepo(sctx, tx);
      if ((await repo.openFor(membershipId, at)) >= OAUTH_OPEN_PER_MEMBER) {
        throw new IntegrationError(
          "rate_limited",
          "too many connections started; try again shortly",
          {
            retryAfterMs: STATE_TTL_MS,
          },
        );
      }
      await repo.insert({
        provider,
        membershipId,
        ticketHash: sha256(ticket),
        ticketExpiresAt: expiresAt,
        environment: input.environment ?? client.environment,
        returnPath: checkReturnPath(input.returnPath),
        expiresAt: new Date(at.getTime() + STATE_TTL_MS),
      });
    });
    return {
      startUrl: `${publicBase}${OAUTH_START_PATH}?ticket=${encodeURIComponent(ticket)}`,
      expiresAt,
    };
  }

  async function startOAuth(
    ticket: string,
  ): Promise<
    { redirectTo: string; browserNonce: string } | { error: "expired" | "not_available" }
  > {
    if (!looksLikeToken(ticket)) return { error: "expired" };
    const claimed = await deps.db.withHost((tx) => claimTicket(tx, sha256(ticket)));
    if (claimed === undefined) return { error: "expired" };
    const provider = claimed.provider as IntegrationProvider;
    const adapter = deps.adapters[provider];
    const client = deps.oauthClients[provider];
    const oauth = adapter?.meta.oauth;
    if (adapter === undefined || client === undefined || oauth === undefined) {
      return { error: "not_available" };
    }
    const state = mintSecret();
    const browserNonce = mintSecret();
    const verifier = oauth.pkce ? mintSecret(48) : undefined;
    const sctx = systemContext(claimed.workspaceId);
    const stored = await deps.db.withTenant(sctx, async (tx) => {
      const sealed = verifier === undefined ? undefined : await vault.seal(tx, sctx, verifier);
      return new OAuthStateRepo(sctx, tx).setStarted(claimed.id, {
        stateHash: sha256(state),
        browserHash: sha256(browserNonce),
        verifierEnc: sealed?.enc ?? null,
        encryption: sealed === undefined ? {} : { verifier: sealed.ref },
      });
    });
    if (!stored) return { error: "expired" };
    const url = new URL(oauth.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri());
    if (oauth.scopes.length > 0)
      url.searchParams.set("scope", oauth.scopes.join(oauth.scopeSeparator));
    url.searchParams.set("state", state);
    if (verifier !== undefined) {
      url.searchParams.set("code_challenge", pkceChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return { redirectTo: url.href, browserNonce };
  }

  async function completeOAuth(
    query: Readonly<Record<string, string>>,
    browserNonce: string | undefined,
  ): Promise<{ redirectTo: string }> {
    const state = query["state"];
    if (!looksLikeToken(state)) return { redirectTo: oauthErrorUrl("expired") };
    const claimed = await deps.db.withHost((tx) => claimState(tx, sha256(state)));
    if (claimed === undefined) return { redirectTo: oauthErrorUrl("expired") };
    const provider = claimed.provider as IntegrationProvider;
    const workspace = await findWorkspaceById(deps.db, claimed.workspaceId);
    if (workspace === undefined) return { redirectTo: oauthErrorUrl("expired") };
    const sctx = systemContext(claimed.workspaceId);
    const land = (result: "pending" | "error", reason?: string) => ({
      // Never a tenant-controlled origin (fix round 2, R2-A1): a workspace's custom domain may be
      // pointed at a server its owner runs, which would read the `#pending=` fragment. The
      // operator's own address for the workspace (tenant subdomain / base URL) only.
      redirectTo: deps.workspaceUrl(
        { slug: workspace.slug, primaryHost: null },
        `${checkReturnPath(claimed.returnPath)}?${resultQuery(provider, result, reason)}`,
      ),
    });
    const who: Partial<AuditInput> = {
      actorKind: "staff",
      actorMembershipId: claimed.membershipId,
      actorUserId: null,
    };
    const fail = async (reason: string) => {
      await deps.db.withTenant(sctx, (tx) =>
        deps.audit.record(tx, sctx, {
          ...who,
          action: "integration.oauth_failed",
          resourceKind: "integration_connection",
          resourceId: null,
          outcome: "failure",
          meta: { provider, reason },
        }),
      );
      log("integrations.oauth_failed", { workspaceId: claimed.workspaceId, provider, reason });
      return land("error", reason);
    };

    // The browser that finishes must be the browser that started (defeats a consent link sent to
    // a victim: their browser has no binding cookie for the attacker's state).
    if (!looksLikeToken(browserNonce) || !sameDigest(claimed.browserHash, sha256(browserNonce))) {
      return fail("browser_mismatch");
    }
    const vendorError = query["error"];
    if (vendorError !== undefined) {
      return fail(vendorError === "access_denied" ? "denied" : "vendor_error");
    }
    const code = query["code"];
    if (code === undefined || code === "" || code.length > 4000) return fail("invalid_response");
    const adapter = deps.adapters[provider];
    const client = deps.oauthClients[provider];
    const exchange = adapter?.exchangeCode;
    if (adapter === undefined || client === undefined || exchange === undefined) {
      return fail("not_available");
    }
    let codeVerifier: string | null = null;
    if (claimed.verifierEnc !== null) {
      const ref = (claimed.encryption as { verifier?: SealedRef } | null)?.verifier;
      const verifierEnc = claimed.verifierEnc;
      const v = await deps.db.withTenant(sctx, (tx) => vault.unseal(tx, sctx, ref, verifierEnc));
      if (v === undefined) return fail("expired");
      codeVerifier = v;
    }
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (k !== "code" && k !== "state" && !k.startsWith("error") && v.length <= 300) rest[k] = v;
    }
    const tokens = await safely(() =>
      exchange.call(adapter, {
        code,
        redirectUri: redirectUri(),
        codeVerifier,
        query: rest,
        client,
      }),
    );
    if (!tokens.ok) return fail("exchange_failed");
    const set: OAuthTokenSet = tokens.value;
    const revokeNew = async () => {
      if (adapter.revoke === undefined) return;
      await adapter.revoke({ token: set.refreshToken ?? set.accessToken, client }).catch(() => {});
    };
    const auth: IntegrationAuth = {
      accessToken: set.accessToken,
      externalAccountId: set.externalAccountId,
      environment: claimed.environment,
    };
    const verdict = await safely(() => adapter.verify(auth));
    if (!verdict.ok) {
      await revokeNew();
      return fail("verify_failed");
    }
    // Not connected yet (fix round 1, R1-H1): the callback runs in whatever browser the vendor sent
    // back, with no session — the browser that STARTED may be a victim who opened an attacker's
    // start link. The verified token set waits, sealed, on the handshake row; only the initiator,
    // signed in to this workspace and still holding integrations.manage, turns it into a
    // connection (`confirmOAuth`), presenting the one-time token this redirect carries in its URL
    // fragment (never the query: no Referer, no access log).
    const pending: PendingGrant = {
      accessToken: set.accessToken,
      refreshToken: set.refreshToken,
      expiresAt: set.expiresAt === null ? null : set.expiresAt.toISOString(),
      scope: set.scope === null ? null : set.scope.slice(0, 1000),
      externalAccountId: clip(verdict.value.externalAccountId ?? set.externalAccountId, 300),
      accountLabel: clip(verdict.value.accountLabel, 200),
      accounts: provider === "xero" ? parseAccounts(set.extra?.["accounts"]) : undefined,
    };
    const pendingToken = mintSecret();
    const stored = await deps.db.withTenant(sctx, async (tx) => {
      const sealed = await vault.seal(tx, sctx, JSON.stringify(pending));
      return new OAuthStateRepo(sctx, tx).setPending(claimed.id, {
        pendingHash: sha256(pendingToken),
        pendingEnc: sealed.enc,
        pendingExpiresAt: new Date(now().getTime() + STATE_TTL_MS),
        encryption: {
          ...((claimed.encryption as Record<string, SealedRef> | null) ?? {}),
          pending: sealed.ref,
        },
      });
    });
    if (!stored) {
      await revokeNew();
      return fail("expired");
    }
    log("integrations.oauth_pending", { workspaceId: claimed.workspaceId, provider });
    const landed = land("pending");
    return { redirectTo: `${landed.redirectTo}#pending=${pendingToken}` };
  }

  async function confirmOAuth(
    ctx: TenantContext,
    provider: IntegrationProvider,
    pendingToken: string,
    actor: IntegrationActor,
    gate?: IntegrationConnectGate,
  ): Promise<IntegrationConnectionView> {
    refuseViewAs(ctx);
    const invalid = () =>
      new IntegrationError(
        "integration_oauth_pending_invalid",
        "this connection request is unknown, expired, already used or not yours; connect again",
      );
    if (!looksLikeToken(pendingToken) || actor.membershipId === null) throw invalid();
    const membershipId = actor.membershipId;
    const adapter = adapterOf(provider);
    const sctx = sys(ctx);
    const at = now();
    // Burn the pending grant first (single use), in its own short tx; everything after is the
    // ordinary connect path.
    const grant = await deps.db.withTenant(sctx, async (tx) => {
      const repo = new OAuthStateRepo(sctx, tx);
      const row = await repo.pendingForUpdate(sha256(pendingToken));
      if (
        row === undefined ||
        row.provider !== provider ||
        row.membershipId !== membershipId ||
        row.completedAt !== null ||
        row.pendingEnc === null ||
        row.pendingExpiresAt === null ||
        row.pendingExpiresAt.getTime() <= at.getTime()
      )
        return undefined;
      // The initiator must still be a live staff member who may manage integrations NOW.
      const m = await new MembershipRepo(sctx, tx).byId(membershipId);
      if (
        m === undefined ||
        m.status !== "active" ||
        m.kind !== "staff" ||
        (deps.hasPermission !== undefined && !deps.hasPermission(m, "integrations.manage"))
      )
        return undefined;
      const text = await vault.unseal(
        tx,
        sctx,
        (row.encryption as { pending?: SealedRef } | null)?.pending,
        row.pendingEnc,
      );
      let pending: PendingGrant;
      try {
        if (text === undefined) return undefined;
        pending = JSON.parse(text) as PendingGrant;
      } catch {
        return undefined;
      }
      // A-3: refused before the grant is burned, so the initiator can confirm it after an upgrade
      // (the write below checks again under the lock).
      if (
        gate?.assertMayConnect !== undefined &&
        (await new ConnectionRepo(sctx, tx).live(provider)) === undefined
      ) {
        gate.assertMayConnect();
      }
      // Burned only once it is known to be usable (fix round 2): an unreadable grant stays for
      // the sweep, which revokes what it can.
      await repo.markCompleted(row.id, at);
      return { row, pending };
    });
    if (grant === undefined) throw invalid();
    const { row: state, pending } = grant;
    const client = deps.oauthClients[provider];
    const revokeNew = async () => {
      if (adapter.revoke === undefined) return;
      await adapter
        .revoke({ token: pending.refreshToken ?? pending.accessToken, client: client ?? null })
        .catch(() => {});
    };
    const stored: StoredCredentials = {
      accessToken: pending.accessToken,
      refreshToken: pending.refreshToken,
      ...(pending.accounts === undefined ? {} : { accounts: pending.accounts }),
    };
    let saved: Awaited<ReturnType<typeof replaceConnection>>;
    try {
      saved = await replaceConnection(
        sctx,
        provider,
        async (tx) => {
          const creds = await vault.sealCredentials(tx, sctx, stored);
          return {
            provider,
            authKind: "oauth2",
            environment: state.environment,
            credentialsEnc: creds.enc,
            encryption: { credentials: creds.ref },
            accessExpiresAt: pending.expiresAt === null ? null : new Date(pending.expiresAt),
            scope: pending.scope,
            externalAccountId: pending.externalAccountId,
            accountLabel: pending.accountLabel,
            lastSuccessAt: now(),
            createdByMembershipId: membershipId,
          };
        },
        actorAudit(ctx, actor),
        undefined,
        gate,
      );
    } catch (error) {
      await revokeNew();
      throw error;
    }
    if (saved.previous !== undefined) {
      // Reconnecting the SAME vendor account usually hands back the same grant: revoking the old
      // token would revoke the new one with it. Only another account's grant is revoked.
      const sameAccount =
        saved.previous.row.externalAccountId !== null &&
        saved.previous.row.externalAccountId === saved.row.externalAccountId;
      await cleanup(provider, saved.previous, { revoke: !sameAccount });
    }
    log("integrations.connected", { workspaceId: ctx.workspaceId, provider });
    return liveView(sctx, provider);
  }

  // --- verify / account / disconnect / rotate --------------------------------------------------

  async function verify(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<IntegrationConnectionView> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    const adapter = adapterOf(provider);
    const result = await withAuth(ctx, provider, (auth) => adapter.verify(auth));
    if (!result.ok && result.reason === "not_connected") {
      throw new IntegrationError("integration_not_connected", `${provider} is not connected`);
    }
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      const row = await repo.live(provider);
      if (row === undefined) return;
      if (result.ok && result.value.accountLabel !== "") {
        const label = clip(result.value.accountLabel, 200);
        if (label !== row.accountLabel) {
          const locked = await repo.lockLiveById(row.id);
          if (locked !== undefined) await repo.update(row.id, { accountLabel: label });
        }
      }
      await deps.audit.record(tx, sctx, {
        ...actorAudit(ctx, actor),
        action: "integration.verified",
        resourceKind: "integration_connection",
        resourceId: row.id,
        ...(result.ok ? {} : { outcome: "failure" as const }),
        meta: { provider, ok: result.ok, reason: result.ok ? null : result.reason },
      });
    });
    return liveView(sctx, provider);
  }

  async function selectAccount(
    ctx: TenantContext,
    provider: IntegrationProvider,
    externalAccountId: string,
    actor: IntegrationActor,
  ): Promise<IntegrationConnectionView> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    const adapter = adapterOf(provider);
    let connectionId: string | undefined;
    const result = await withAuth<
      { accountLabel: string; externalAccountId: string | null } | undefined
    >(ctx, provider, async (auth, opened) => {
      connectionId = opened.row.id;
      const known = (opened.creds.accounts ?? []).some((a) => a.id === externalAccountId);
      if (!known) return { ok: true as const, value: undefined };
      return adapter.verify({ ...auth, externalAccountId });
    });
    if (!result.ok && result.reason === "not_connected") {
      throw new IntegrationError("integration_not_connected", `${provider} is not connected`);
    }
    if (result.ok && result.value === undefined) {
      throw new IntegrationError(
        "integration_account_unknown",
        "that account is not one this connection can reach",
        { reason: "unknown_account" },
      );
    }
    if (!result.ok) {
      throw new IntegrationError(
        "integration_credentials_rejected",
        `${adapter.meta.displayName} refused that account`,
        { reason: result.reason },
      );
    }
    const label = clip(result.value?.accountLabel, 200);
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      await repo.lockSingleton(provider);
      const row = await repo.liveForUpdate(provider);
      if (row === undefined || row.id !== connectionId) {
        throw new IntegrationError("conflict", "the connection changed; try again", {
          reason: "connection_changed",
        });
      }
      await repo.update(row.id, { externalAccountId, accountLabel: label });
      await deps.audit.record(tx, sctx, {
        ...actorAudit(ctx, actor),
        action: "integration.account_selected",
        resourceKind: "integration_connection",
        resourceId: row.id,
        meta: { provider, changed: row.externalAccountId !== externalAccountId },
      });
    });
    return liveView(sctx, provider);
  }

  async function disconnect(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<void> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    adapterOf(provider);
    const previous = await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      await repo.lockSingleton(provider);
      const live = await repo.liveForUpdate(provider);
      if (live === undefined) {
        throw new IntegrationError("integration_not_connected", `${provider} is not connected`);
      }
      const creds = await vault.unsealCredentials(tx, sctx, live);
      await repo.update(live.id, { deletedAt: now(), refreshLeaseUntil: null });
      await deps.audit.record(tx, sctx, {
        ...actorAudit(ctx, actor),
        action: "integration.disconnected",
        resourceKind: "integration_connection",
        resourceId: live.id,
        meta: { provider },
      });
      await publish(tx, sctx, "integration.connection_changed", {
        connectionId: live.id,
        provider,
        change: "disconnected",
      });
      return { row: live, creds };
    });
    await cleanup(provider, previous, { revoke: true });
  }

  async function rotateWebhookSecret(
    ctx: TenantContext,
    provider: IntegrationProvider,
    actor: IntegrationActor,
  ): Promise<{ connection: IntegrationConnectionView; webhookSecret: string }> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    const adapter = adapterOf(provider);
    if (!isBooking(adapter)) {
      throw new IntegrationError("conflict", `${adapter.meta.displayName} has no webhook secret`, {
        reason: "not_booking",
      });
    }
    // One rotation at a time per connection (fix round 2, R2-A3): a lease column, like the
    // refresh lease — never a DB lock held across the vendor calls. Two concurrent rotations would
    // each subscribe/unsubscribe against Calendly's one-subscription-per-URL rule and leave the
    // stored secret and the vendor's subscription disagreeing.
    // The lease has an OWNER (fix round 3): this rotation's token. A rotation that outlives its
    // lease (worst case ~15 vendor calls × 15 s) and is taken over can no longer extend, clear or
    // write under it: every lease write is conditional on the token, and the lease is extended
    // (heartbeat) before each vendor call — if that fails, the rotation aborts without writing.
    const leaseToken = randomUUID();
    const claimed = await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      const live = await repo.live(provider);
      if (live === undefined) return { kind: "none" as const };
      const row = await repo.claimRotationLease(live.id, leaseToken, ROTATION_LEASE_MS);
      if (row === undefined) return { kind: "busy" as const };
      return { kind: "ok" as const, row, creds: await vault.unsealCredentials(tx, sctx, row) };
    });
    if (claimed.kind === "none") {
      throw new IntegrationError("integration_not_connected", `${provider} is not connected`);
    }
    if (claimed.kind === "busy") {
      throw new IntegrationError("conflict", "the webhook secret is being rotated; try again", {
        reason: "rotation_in_progress",
      });
    }
    const loaded = claimed;
    const leaseLost = () =>
      new IntegrationError("conflict", "the webhook secret rotation was taken over; try again", {
        reason: "rotation_in_progress",
      });
    /** Heartbeat before every vendor call; throws when another rotation holds the lease now. */
    const beat = async () => {
      const held = await deps.db.withTenant(sctx, (tx) =>
        new ConnectionRepo(sctx, tx).extendRotationLease(
          loaded.row.id,
          leaseToken,
          ROTATION_LEASE_MS,
        ),
      );
      if (!held) throw leaseLost();
    };
    try {
      const secret = mintSecret();
      /** The subscription id stored when this rotation began. */
      const began = loaded.row.webhookSubscriptionId;
      let subscriptionId: string | null = began;
      let oldRemoved = false;
      const subscribe = adapter.booking?.subscribe;
      const auth = loaded.creds === undefined ? undefined : authOf(loaded.row, loaded.creds);
      if (subscribe !== undefined) {
        if (auth === undefined) {
          throw new IntegrationError(
            "integration_credentials_rejected",
            "the stored credentials are unreadable; reconnect",
            { reason: "unauthorized" },
          );
        }
        const callbackUrl = webhookUrl(loaded.row.id);
        const subscribeNew = async () => {
          await beat();
          return safely(() =>
            subscribe.call(adapter.booking, auth, { callbackUrl, signingKey: secret }),
          );
        };
        let sub = await subscribeNew();
        // Calendly refuses a second subscription for the same callback URL (409, reported by the
        // adapter as "already exists"): remove ours — the stored one, or, when none is stored
        // (lost), every one of ours on this URL — and subscribe again.
        if (!sub.ok && /already exists|HTTP 409/iu.test(sub.detail ?? "")) {
          if (began !== null) {
            await beat();
            await adapter.booking?.unsubscribe?.(auth, began).catch(() => {});
            oldRemoved = true;
          } else if (adapter.booking?.listSubscriptions !== undefined) {
            const list = adapter.booking.listSubscriptions.bind(adapter.booking);
            await beat();
            const listed = await safely(() => list(auth, callbackUrl));
            if (listed.ok) {
              for (const id of listed.value) {
                await beat();
                await adapter.booking?.unsubscribe?.(auth, id).catch(() => {});
              }
            }
          }
          sub = await subscribeNew();
          if (!sub.ok) {
            // No subscription at the vendor now. Say so loudly — but only if nobody changed the
            // stored subscription meanwhile (then it is theirs, and still good).
            await deps.db.withTenant(sctx, async (tx) => {
              const repo = new ConnectionRepo(sctx, tx);
              await repo.lockSingleton(provider);
              const live = await repo.lockLiveById(loaded.row.id);
              if (
                live === undefined ||
                live.webhookRotationLeaseToken !== leaseToken ||
                live.webhookSubscriptionId !== began
              )
                return;
              await broker.recordInTx(
                tx,
                sctx,
                live,
                { kind: "degrade", reason: "webhook_subscription_lost" },
                { webhookSubscriptionId: null },
              );
              await deps.audit.record(tx, sctx, {
                ...actorAudit(ctx, actor),
                action: "integration.webhook_secret_rotated",
                resourceKind: "integration_connection",
                resourceId: live.id,
                outcome: "failure",
                meta: { provider, reason: "subscription_lost" },
              });
            });
          }
        }
        if (!sub.ok) {
          throw new IntegrationError(
            "integration_credentials_rejected",
            `${adapter.meta.displayName} did not accept the webhook subscription`,
            {
              reason: "subscribe_failed",
              providerReason: sub.reason,
              ...(oldRemoved || began === null ? { subscriptionLost: true } : {}),
            },
          );
        }
        subscriptionId = clip(sub.value.subscriptionId, 300);
      }
      let row: ConnectionRow;
      try {
        row = await deps.db.withTenant(sctx, async (tx) => {
          const repo = new ConnectionRepo(sctx, tx);
          await repo.lockSingleton(provider);
          const live = await repo.liveForUpdate(provider);
          if (live === undefined || live.id !== loaded.row.id) {
            throw new IntegrationError("conflict", "the connection changed; try again", {
              reason: "connection_changed",
            });
          }
          // Lost the lease (it expired and another rotation took it): write nothing.
          if (live.webhookRotationLeaseToken !== leaseToken) throw leaseLost();
          const sealed = await vault.seal(tx, sctx, secret);
          const updated =
            (await repo.update(live.id, {
              webhookSecretEnc: sealed.enc,
              webhookSubscriptionId: subscriptionId,
              webhookRotationLeaseUntil: null,
              webhookRotationLeaseToken: null,
              encryption: {
                ...(live.encryption as { credentials: SealedRef }),
                webhookSecret: sealed.ref,
              },
            })) ?? live;
          // A subscription that had been lost (degraded) is back: the connection heals.
          const healed =
            live.webhookSubscriptionId === null && subscriptionId !== null
              ? await broker.recordInTx(tx, sctx, updated, { kind: "success" })
              : updated;
          await deps.audit.record(tx, sctx, {
            ...actorAudit(ctx, actor),
            action: "integration.webhook_secret_rotated",
            resourceKind: "integration_connection",
            resourceId: live.id,
            meta: { provider },
          });
          return healed;
        });
      } catch (error) {
        if (
          subscribe !== undefined &&
          subscriptionId !== null &&
          subscriptionId !== began &&
          auth !== undefined
        ) {
          await adapter.booking?.unsubscribe?.(auth, subscriptionId).catch(() => {});
        }
        throw error;
      }
      if (
        subscribe !== undefined &&
        !oldRemoved &&
        began !== null &&
        began !== subscriptionId &&
        auth !== undefined
      ) {
        await adapter.booking?.unsubscribe?.(auth, began).catch(() => {});
      }
      return { connection: viewOf(row), webhookSecret: secret };
    } finally {
      await deps.db
        .withTenant(sctx, (tx) =>
          new ConnectionRepo(sctx, tx).releaseRotationLease(loaded.row.id, leaseToken),
        )
        .catch(() => {});
    }
  }

  // --- booking webhook -------------------------------------------------------------------------

  async function recordBookings(
    sctx: TenantContext,
    connectionId: string,
    provider: BookingProvider,
    events: readonly BookingEvent[],
  ): Promise<"accepted" | "ignored"> {
    const at = now();
    return deps.db.withTenant(sctx, async (tx) => {
      const conn = await new ConnectionRepo(sctx, tx).liveById(connectionId);
      if (conn === undefined) return "ignored";
      const repo = new BookingRepo(sctx, tx);
      await repo.lockWorkspace();
      // Erased people's addresses (fix round 2): their events are dropped, never stored.
      const suppressed = await bookingSuppressionChecker(tx, sctx, deps.crypto);
      const ordered = [...events]
        .map((e) => ({ e, externalId: clip(e.externalId, 300) }))
        .filter((x): x is { e: BookingEvent; externalId: string } => x.externalId !== null)
        .sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
      for (const { e, externalId } of ordered) {
        const email = normalizeInviteeEmail(e.inviteeEmail);
        const startsAt = e.startsAt instanceof Date ? e.startsAt : new Date(e.startsAt);
        if (email === undefined || Number.isNaN(startsAt.getTime())) continue;
        const endsAt =
          e.endsAt === null || Number.isNaN(new Date(e.endsAt).getTime())
            ? null
            : new Date(e.endsAt);
        const next = {
          status: e.status,
          startsAt,
          endsAt,
          inviteeName: clip(e.inviteeName, 200),
          eventName: clip(e.eventName, 200),
        };
        if (await suppressed(email)) continue;
        const membershipId = (await liveMembershipByEmail(tx, sctx, email, at)) ?? null;
        const existing = await repo.byExternalIdForUpdate(provider, externalId);
        let row: BookingRow | undefined;
        if (existing === undefined) {
          row = await repo.insert({
            connectionId,
            provider,
            externalId,
            inviteeEmail: email,
            membershipId,
            ...next,
          });
        } else if (existing.erasedAt !== null) {
          // An erased person's meeting: a vendor retry (or a later cancel) may move its status
          // and times forward, but never writes their address, name or title back.
          const moved = {
            status: next.status,
            startsAt: next.startsAt,
            endsAt: next.endsAt,
            inviteeName: existing.inviteeName,
            eventName: existing.eventName,
          };
          if (bookingUpdate(existing, moved)) {
            row = await repo.update(existing.id, {
              status: moved.status,
              startsAt: moved.startsAt,
              endsAt: moved.endsAt,
            });
          }
        } else if (bookingUpdate(existing, next)) {
          row = await repo.update(existing.id, {
            ...next,
            connectionId,
            membershipId: membershipId ?? existing.membershipId,
          });
        }
        if (row !== undefined) {
          await publish(tx, sctx, "integration.booking_recorded", {
            bookingId: row.id,
            provider,
            status: row.status,
          });
        }
      }
      return "accepted";
    });
  }

  async function ingestBookingWebhook(
    connectionId: string,
    req: { readonly headers: Headers; readonly rawBody: Uint8Array },
    options?: { readonly admit?: (() => boolean) | undefined },
  ): Promise<"accepted" | "unauthorized" | "ignored" | "throttled"> {
    if (!isUuid(connectionId)) return "unauthorized";
    const hit = await deps.db.withHost((tx) => findConnectionForWebhook(tx, connectionId));
    if (hit === undefined) return "unauthorized";
    const adapter = deps.adapters[hit.provider];
    const booking = adapter?.booking;
    if (adapter === undefined || booking === undefined || !isBooking(adapter))
      return "unauthorized";
    const sctx = sys(hit.workspaceId);
    const secret = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ConnectionRepo(sctx, tx).liveById(connectionId);
      return row === undefined ? undefined : vault.unsealWebhookSecret(tx, sctx, row);
    });
    if (secret === undefined) return "unauthorized";
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let parsed: ReturnType<NonNullable<IntegrationAdapter["booking"]>["parseWebhook"]>;
    try {
      parsed = booking.parseWebhook({ headers, rawBody: req.rawBody, secret, now: now() });
    } catch {
      return "unauthorized";
    }
    if (!parsed.ok) {
      // Only an authentic request gets past the adapter's signature check; anything it refuses
      // before that is `unauthorized`. An authentic payload it cannot use is acknowledged.
      return parsed.reason === "unauthorized" ? "unauthorized" : "ignored";
    }
    if (options?.admit !== undefined && !options.admit()) return "throttled";
    const events = parsed.value.slice(0, MAX_EVENTS_PER_WEBHOOK);
    if (events.length === 0) return "accepted";
    const outcome = await recordBookings(
      sctx,
      connectionId,
      hit.provider as BookingProvider,
      events,
    );
    log("integrations.booking_webhook", {
      workspaceId: hit.workspaceId,
      provider: hit.provider,
      events: events.length,
      outcome,
    });
    return outcome;
  }

  // --- booking links ---------------------------------------------------------------------------

  function linkView(row: BookingLinkRow): BookingLinkView {
    return {
      id: row.id,
      provider: row.provider,
      url: row.url,
      label: row.label,
      description: row.description,
      audience: parseAudience(row.audience),
      position: row.position,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function linkHosts(provider: BookingProvider): readonly string[] {
    return deps.adapters[provider]?.booking?.linkHosts ?? [];
  }

  async function checkAudience(
    repo: BookingLinkRepo,
    audience: BookingLinkAudience | undefined,
  ): Promise<BookingLinkAudience | undefined> {
    if (audience === undefined) return undefined;
    if (audience.kind === "all") return { kind: "all" };
    const ids = [...new Set(audience.groupIds)];
    if (ids.length === 0 || ids.length > 50 || !ids.every(isUuid)) {
      throw new IntegrationError("validation_failed", "choose between 1 and 50 groups", {
        reason: "invalid_audience",
        field: "audience",
      });
    }
    const live = await repo.liveGroupIds(ids);
    const unknown = ids.filter((g) => !live.has(g));
    if (unknown.length > 0) {
      throw new IntegrationError("validation_failed", "an audience group does not exist", {
        reason: "unknown_group",
        field: "audience",
      });
    }
    return { kind: "groups", groupIds: ids };
  }

  const bookingLinks: IntegrationsKernel["bookingLinks"] = {
    async list(ctx) {
      const sctx = sys(ctx);
      return deps.db.withTenant(sctx, async (tx) =>
        (await new BookingLinkRepo(sctx, tx).list()).map(linkView),
      );
    },

    async put(ctx, id, input, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const label = input.label === undefined ? undefined : clip(input.label, 80);
      if (input.label !== undefined && label === null) {
        throw new IntegrationError("validation_failed", "the label is required", {
          reason: "label_required",
          field: "label",
        });
      }
      const description =
        input.description === undefined ? undefined : clip(input.description, 300);
      return deps.db.withTenant(sctx, async (tx) => {
        const repo = new BookingLinkRepo(sctx, tx);
        await repo.lockWorkspace();
        const audience = await checkAudience(repo, input.audience);
        if (id === null) {
          if (
            input.provider === undefined ||
            input.url === undefined ||
            label === undefined ||
            label === null
          ) {
            throw new IntegrationError(
              "validation_failed",
              "provider, url and label are required",
              {
                reason: "fields_required",
              },
            );
          }
          const url = checkBookingLinkUrl(input.url, linkHosts(input.provider));
          const n = await repo.count();
          if (n >= BOOKING_LINK_MAX) {
            throw new IntegrationError(
              "booking_link_limit",
              `a workspace can have at most ${BOOKING_LINK_MAX} booking links`,
              { limit: BOOKING_LINK_MAX },
            );
          }
          const row = await repo.insert({
            provider: input.provider,
            url,
            label,
            description: description ?? null,
            audience: audience ?? { kind: "all" },
            position: input.position ?? n,
            enabled: input.enabled ?? true,
            createdByMembershipId: actor.membershipId,
          });
          await deps.audit.record(tx, sctx, {
            ...actorAudit(ctx, actor),
            action: "integration.booking_link_created",
            resourceKind: "booking_link",
            resourceId: row.id,
            meta: {
              provider: row.provider,
              host: new URL(row.url).hostname,
              audience: parseAudience(row.audience).kind,
              enabled: row.enabled,
            },
          });
          return linkView(row);
        }
        if (!isUuid(id)) throw new IntegrationError("not_found", "no such booking link");
        const current = await repo.byIdForUpdate(id);
        if (current === undefined) throw new IntegrationError("not_found", "no such booking link");
        const url =
          input.url === undefined
            ? undefined
            : checkBookingLinkUrl(input.url, linkHosts(current.provider));
        const patch = {
          ...(url === undefined ? {} : { url }),
          ...(label === undefined || label === null ? {} : { label }),
          ...(description === undefined ? {} : { description }),
          ...(audience === undefined ? {} : { audience }),
          ...(input.position === undefined ? {} : { position: input.position }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        };
        const row =
          Object.keys(patch).length === 0 ? current : ((await repo.update(id, patch)) ?? current);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "integration.booking_link_updated",
          resourceKind: "booking_link",
          resourceId: row.id,
          meta: { provider: row.provider, fields: Object.keys(patch).sort() },
        });
        return linkView(row);
      });
    },

    async remove(ctx, id, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      if (!isUuid(id)) throw new IntegrationError("not_found", "no such booking link");
      await deps.db.withTenant(sctx, async (tx) => {
        const repo = new BookingLinkRepo(sctx, tx);
        const row = await repo.byIdForUpdate(id);
        if (row === undefined) throw new IntegrationError("not_found", "no such booking link");
        await repo.remove(id);
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "integration.booking_link_deleted",
          resourceKind: "booking_link",
          resourceId: id,
          meta: { provider: row.provider },
        });
      });
    },

    async forMember(ctx, membershipId) {
      const sctx = sys(ctx);
      const at = now();
      return deps.db.withTenant(sctx, async (tx) => {
        const memberships = new MembershipRepo(sctx, tx);
        const m = await memberships.byId(membershipId);
        if (m === undefined || m.status !== "active") return [];
        if (m.expiresAt !== null && m.expiresAt.getTime() <= at.getTime()) return [];
        const links = await new BookingLinkRepo(sctx, tx).listEnabled();
        if (links.length === 0) return [];
        let visible = links;
        if (m.kind !== "staff") {
          // Links are workspace-level (no module scope): a delegate sees what its principal sees,
          // plus what its own groups admit.
          const groups = new GroupRepo(sctx, tx);
          const ids = new Set(await groups.groupIdsFor(m.id));
          const principal = await memberships.liveDelegationPrincipal(m.id, at);
          if (principal !== undefined) {
            for (const g of await groups.groupIdsFor(principal.id)) ids.add(g);
          }
          visible = links.filter((l) => audienceAdmits(parseAudience(l.audience), ids));
        }
        return visible.map(
          (l): BookingLinkPublic => ({
            id: l.id,
            provider: l.provider,
            url: l.url,
            label: l.label,
            description: l.description,
          }),
        );
      });
    },
  };

  // --- register ---------------------------------------------------------------------------------

  function bookingRecord(row: BookingRow): IntegrationBookingRecord {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      inviteeEmail: row.inviteeEmail,
      inviteeName: row.inviteeName,
      eventName: row.eventName,
      membershipId: row.membershipId,
      receivedAt: row.receivedAt,
      updatedAt: row.updatedAt,
    };
  }

  async function bookings(
    ctx: TenantContext,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<{ items: IntegrationBookingRecord[]; nextCursor: string | null }> {
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)));
    let before: { startsAt: Date; id: string } | undefined;
    if (query.cursor !== undefined && query.cursor !== "") {
      before = decodeBookingCursor(query.cursor);
      if (before === undefined) {
        throw new IntegrationError("validation_failed", "bad cursor", { reason: "invalid_cursor" });
      }
    }
    const sctx = sys(ctx);
    const rows = await deps.db.withTenant(sctx, (tx) =>
      new BookingRepo(sctx, tx).page(limit + 1, before),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(bookingRecord),
      nextCursor: rows.length > limit && last !== undefined ? encodeBookingCursor(last) : null,
    };
  }

  // --- module services --------------------------------------------------------------------------

  const services: IntegrationServices = {
    async connection(tx, ctx, provider) {
      const row = await new ConnectionRepo(ctx, tx).live(provider);
      return row === undefined ? undefined : summaryOf(row);
    },
    kpiMetrics(provider) {
      return deps.adapters[provider]?.kpi?.metrics ?? [];
    },
    async readKpi(ctx, provider, req) {
      const kpi = deps.adapters[provider]?.kpi;
      if (kpi === undefined) return NOT_CONNECTED;
      // `req.signal` (fix round 3) travels with the request to the adapter, which passes it to
      // every fetch; an aborted read is not the connection's fault (health: neutral).
      if (req.signal?.aborted === true)
        return { ok: false, reason: "unavailable", detail: "aborted" };
      return withAuth(ctx, provider, (auth) => kpi.read(auth, req));
    },
    async slackChannels(ctx) {
      const chat = deps.adapters.slack?.chat;
      if (chat === undefined) return NOT_CONNECTED;
      return withAuth(ctx, "slack", (auth) => chat.listChannels(auth));
    },
    async slackPost(ctx, channelId, message) {
      const chat = deps.adapters.slack?.chat;
      if (chat === undefined) return NOT_CONNECTED;
      return withAuth(ctx, "slack", (auth) => chat.post(auth, channelId, { text: message.text }));
    },
    async booking(tx, ctx, bookingId): Promise<IntegrationBookingView | undefined> {
      if (!isUuid(bookingId)) return undefined;
      const row = await new BookingRepo(ctx, tx).byId(bookingId);
      if (row === undefined) return undefined;
      const { receivedAt: _r, updatedAt: _u, ...view } = bookingRecord(row);
      return view;
    },
  };

  // --- jobs ---------------------------------------------------------------------------------------

  /**
   * `sends`: the job calls vendors on the workspace's behalf (health checks), so it skips a held or
   * suspended workspace (E3.10 FR1); housekeeping (retention, dead OAuth handshakes) runs for every
   * live workspace.
   */
  async function forEachWorkspace(
    job: string,
    fn: (workspaceId: string) => Promise<number>,
    options: { readonly sends?: boolean } = {},
  ): Promise<void> {
    let total = 0;
    const ids = options.sends
      ? await listActiveWorkspaceIds(deps.db)
      : await listLiveWorkspaceIds(deps.db);
    for (const workspaceId of ids) {
      if (isPlatformWorkspace(workspaceId)) continue;
      try {
        total += await fn(workspaceId);
      } catch (error) {
        log(`${job}_failed`, {
          level: "error",
          workspaceId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (total > 0) log(job, { count: total });
  }

  async function healthCheck(workspaceId: string): Promise<number> {
    const sctx = systemContext(workspaceId);
    const rows = await deps.db.withTenant(sctx, (tx) => new ConnectionRepo(sctx, tx).allLive());
    let n = 0;
    for (const row of rows) {
      const adapter = deps.adapters[row.provider];
      if (adapter === undefined) continue;
      await withAuth(sctx, row.provider, (auth) => adapter.verify(auth));
      n += 1;
    }
    return n;
  }

  const jobs: JobDefinition<JsonObject>[] = [
    {
      name: INTEGRATION_JOBS.health,
      cron: INTEGRATION_CRONS.health,
      queue: { policy: "singleton", retryLimit: 0 },
      handler: async () => {
        await forEachWorkspace("integrations.health", healthCheck, { sends: true });
      },
    },
    {
      name: INTEGRATION_JOBS.retention,
      cron: INTEGRATION_CRONS.retention,
      queue: { policy: "singleton", retryLimit: 0 },
      handler: async () => {
        const before = new Date(now().getTime() - BOOKING_RETENTION_DAYS * 24 * 60 * 60_000);
        await forEachWorkspace("integrations.retention", (workspaceId) => {
          const sctx = systemContext(workspaceId);
          return deps.db.withTenant(sctx, async (tx) => {
            const repo = new BookingRepo(sctx, tx);
            await repo.lockWorkspace();
            return repo.deleteStartedBefore(before);
          });
        });
      },
    },
    {
      name: INTEGRATION_JOBS.oauthStateSweep,
      cron: INTEGRATION_CRONS.oauthStateSweep,
      queue: { policy: "singleton", retryLimit: 0 },
      handler: async () => {
        const before = now();
        await forEachWorkspace("integrations.oauth_state_sweep", async (workspaceId) => {
          const sctx = systemContext(workspaceId);
          // Only unambiguously dead handshakes (fix round 2, R2-A2): a pending grant lives until
          // `pending_expires_at` (callback + 10 min), not `expires_at` (begin + 10 min). Rows are
          // claimed FOR UPDATE SKIP LOCKED in the tx that deletes them — a confirm in flight holds
          // its row FOR UPDATE and is skipped — and grants are revoked only after that commit.
          const { n, unconfirmed } = await deps.db.withTenant(sctx, async (tx) => {
            const repo = new OAuthStateRepo(sctx, tx);
            const left: { provider: IntegrationProvider; token: string }[] = [];
            const dead = await repo.claimDead(before);
            for (const row of dead) {
              if (row.completedAt !== null || row.pendingEnc === null) continue;
              const text = await vault.unseal(
                tx,
                sctx,
                (row.encryption as { pending?: SealedRef } | null)?.pending,
                row.pendingEnc,
              );
              if (text === undefined) continue;
              try {
                const g = JSON.parse(text) as PendingGrant;
                left.push({ provider: row.provider, token: g.refreshToken ?? g.accessToken });
              } catch {
                // unreadable: nothing to revoke
              }
            }
            return { n: await repo.deleteIds(dead.map((r) => r.id)), unconfirmed: left };
          });
          for (const u of unconfirmed) {
            await deps.adapters[u.provider]
              ?.revoke?.({ token: u.token, client: deps.oauthClients[u.provider] ?? null })
              .catch(() => {});
          }
          return n;
        });
      },
    },
  ];

  // --- the kernel ---------------------------------------------------------------------------------

  return {
    providers,
    async list(ctx) {
      const sctx = sys(ctx);
      return deps.db.withTenant(sctx, async (tx) => {
        const out: IntegrationConnectionView[] = [];
        for (const row of await new ConnectionRepo(sctx, tx).allLive()) {
          if (deps.adapters[row.provider] === undefined) continue;
          const creds =
            row.provider === "xero" ? await vault.unsealCredentials(tx, sctx, row) : undefined;
          out.push(viewOf(row, creds));
        }
        return out;
      });
    },
    connectWithSecret,
    beginOAuth,
    startOAuth,
    completeOAuth,
    confirmOAuth,
    oauthErrorUrl,
    verify,
    selectAccount,
    disconnect,
    rotateWebhookSecret,
    ingestBookingWebhook,
    bookingLinks,
    bookings,
    services,
    jobs,
  };
}
