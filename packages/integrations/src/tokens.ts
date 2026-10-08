import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type {
  IntegrationAdapter,
  IntegrationAuth,
  IntegrationFailure,
  IntegrationProvider,
  IntegrationResult,
  OAuthTokenSet,
} from "@fundroom/ports";
import { type HealthOutcome, healthOf, nextHealth, parseAccounts } from "./policy.js";
import { ConnectionRepo, type ConnectionRow } from "./repos/connection-repo.js";
import type { IntegrationsServiceDeps } from "./types.js";
import type { StoredCredentials, Vault } from "./vault.js";

/*
 * Token use (contract §3 "Token use" / "Refresh lease").
 *
 * `withAuth(ctx, provider, fn)`:
 *   1. a short tx loads the live connection and unseals its credentials;
 *   2. an OAuth token expiring within 60 s is refreshed first (below);
 *   3. `fn` — the vendor call — runs with NO transaction open (pool-deadlock rule);
 *   4. `unauthorized` → one forced refresh + retry (OAuth only);
 *   5. a short tx records the outcome on the connection (health), re-locking the row by id and
 *      doing nothing if it was disconnected meanwhile — a late answer never resurrects a
 *      connection.
 *
 * Refresh. QuickBooks and Xero ROTATE the refresh token on every refresh and invalidate the old
 * one, so two processes refreshing at once would leave one of them holding a dead token. A lease
 * serialises it: a conditional `UPDATE … SET refresh_lease_until = now() + 30 s WHERE lease is
 * free RETURNING` elects one refresher; the vendor call runs outside any tx; a short tx stores the
 * new token set (never dropping the rotated refresh token) and clears the lease. Losers poll the
 * row (250 ms, up to 5 s) and use the winner's token. A refresh the vendor refuses
 * (`invalid_grant`, reported by the adapter as `unauthorized`) marks the connection
 * `reauth_required` in the same tx that releases the lease.
 */

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface Opened {
  readonly row: ConnectionRow;
  readonly creds: StoredCredentials;
  readonly adapter: IntegrationAdapter;
}

export const NOT_CONNECTED = { ok: false, reason: "not_connected" } as const;
export type NotConnected = typeof NOT_CONNECTED;

type RefreshOutcome =
  | { readonly ok: true; readonly opened: Opened }
  | { readonly ok: false; readonly gone: true }
  | {
      readonly ok: false;
      readonly gone: false;
      readonly outcome: HealthOutcome;
      /** Already written to the connection (in the tx that released the lease). */
      readonly recorded: boolean;
    };

const REFRESH_AHEAD_MS = 60_000;

export function authOf(row: ConnectionRow, creds: StoredCredentials): IntegrationAuth {
  return {
    accessToken: creds.accessToken,
    externalAccountId: row.externalAccountId,
    environment: row.environment,
  };
}

/** Any throw from an adapter (it should not) is a transport failure; never its message. */
export async function safely<T>(
  call: () => Promise<IntegrationResult<T>>,
): Promise<IntegrationResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, reason: "transport" };
  }
}

function failureOf(outcome: HealthOutcome): IntegrationFailure {
  if (outcome.kind === "reauth") return "unauthorized";
  if (outcome.kind === "failure")
    return outcome.reason === "refresh_failed" ? "unavailable" : outcome.reason;
  if (outcome.kind === "degrade") return "unavailable";
  return "unavailable";
}

export interface TokenBroker {
  withAuth<T>(
    ctx: TenantContext,
    provider: IntegrationProvider,
    fn: (auth: IntegrationAuth, opened: Opened) => Promise<IntegrationResult<T>>,
  ): Promise<IntegrationResult<T> | NotConnected>;
  open(
    sctx: TenantContext,
    provider: IntegrationProvider,
  ): Promise<
    | { row: ConnectionRow; adapter: IntegrationAdapter; creds: StoredCredentials | undefined }
    | undefined
  >;
  record(sctx: TenantContext, connectionId: string, outcome: HealthOutcome): Promise<void>;
  recordInTx(
    tx: Tx,
    sctx: TenantContext,
    row: ConnectionRow,
    outcome: HealthOutcome,
    extra?: Parameters<ConnectionRepo["update"]>[1],
  ): Promise<ConnectionRow>;
  sys(ctx: TenantContext | string): TenantContext;
}

export function createTokenBroker(input: {
  readonly deps: IntegrationsServiceDeps;
  readonly vault: Vault;
  readonly now: () => Date;
  readonly log: Log;
}): TokenBroker {
  const { deps, vault, now, log } = input;
  const leaseMs = deps.refreshLeaseMs ?? 30_000;
  const waitMs = deps.refreshWaitMs ?? 5_000;
  const pollMs = deps.refreshPollMs ?? 250;

  const sys = (ctx: TenantContext | string) =>
    systemContext(typeof ctx === "string" ? ctx : ctx.workspaceId);

  async function openRow(tx: Tx, sctx: TenantContext, row: ConnectionRow) {
    const adapter = deps.adapters[row.provider];
    if (adapter === undefined) return undefined;
    const creds = await vault.unsealCredentials(tx, sctx, row);
    return { row, adapter, creds };
  }

  /** Short tx: the live connection of `provider`, unsealed (`creds` undefined when unreadable). */
  async function open(sctx: TenantContext, provider: IntegrationProvider) {
    return deps.db.withTenant(sctx, async (tx) => {
      const row = await new ConnectionRepo(sctx, tx).live(provider);
      return row === undefined ? undefined : openRow(tx, sctx, row);
    });
  }

  async function openById(sctx: TenantContext, id: string) {
    return deps.db.withTenant(sctx, async (tx) => {
      const row = await new ConnectionRepo(sctx, tx).liveById(id);
      return row === undefined ? undefined : openRow(tx, sctx, row);
    });
  }

  /**
   * Writes a health outcome on the connection inside `tx` (row already locked by the caller, or
   * locked here). Status transitions are audited (`integration.health_changed`) and a move to
   * `degraded` / `reauth_required` publishes `integration.connection_unhealthy` — once per
   * transition. Lock order: connection row → audit chain (workspace row) → outbox.
   */
  async function recordInTx(
    tx: Tx,
    sctx: TenantContext,
    row: ConnectionRow,
    outcome: HealthOutcome,
    extra: Parameters<ConnectionRepo["update"]>[1] = {},
  ): Promise<ConnectionRow> {
    const next = nextHealth(row, outcome);
    if (!next.success && !next.failure && Object.keys(extra).length === 0) return row;
    const at = now();
    const repo = new ConnectionRepo(sctx, tx);
    const updated =
      (await repo.update(row.id, {
        ...extra,
        ...(next.success || next.failure
          ? {
              status: next.status,
              consecutiveFailures: next.consecutiveFailures,
              ...(next.lastError === undefined ? {} : { lastError: next.lastError }),
              ...(next.success ? { lastSuccessAt: at } : { lastFailureAt: at }),
            }
          : {}),
      })) ?? row;
    if (updated.status !== row.status) {
      await deps.audit.record(tx, sctx, {
        actorKind: "system",
        actorMembershipId: null,
        actorUserId: null,
        action: "integration.health_changed",
        resourceKind: "integration_connection",
        resourceId: row.id,
        ...(updated.status === "active" ? {} : { outcome: "failure" as const }),
        meta: {
          provider: row.provider,
          from: row.status,
          to: updated.status,
          consecutiveFailures: updated.consecutiveFailures,
        },
      });
      if (updated.status === "degraded" || updated.status === "reauth_required") {
        await publish(tx, sctx, "integration.connection_unhealthy", {
          connectionId: row.id,
          provider: row.provider,
          status: updated.status,
        });
      }
      log("integrations.health_changed", {
        workspaceId: sctx.workspaceId,
        provider: row.provider,
        from: row.status,
        to: updated.status,
      });
    }
    return updated;
  }

  /** Short tx: records `outcome` on the connection if it is still live (never resurrects). */
  async function record(sctx: TenantContext, connectionId: string, outcome: HealthOutcome) {
    if (outcome.kind === "neutral") return;
    await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ConnectionRepo(sctx, tx).lockLiveById(connectionId);
      if (row === undefined) return;
      await recordInTx(tx, sctx, row, outcome);
    });
  }

  function expiringSoon(row: ConnectionRow): boolean {
    return (
      row.accessExpiresAt !== null &&
      row.accessExpiresAt.getTime() < now().getTime() + REFRESH_AHEAD_MS
    );
  }

  /** Releases the lease (and, on a refused refresh, records the outcome) in one short tx. */
  async function release(
    sctx: TenantContext,
    id: string,
    outcome: HealthOutcome | undefined,
  ): Promise<boolean> {
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      const row = await repo.lockLiveById(id);
      if (row === undefined) return false;
      if (outcome === undefined) {
        await repo.update(id, { refreshLeaseUntil: null });
      } else {
        await recordInTx(tx, sctx, row, outcome, { refreshLeaseUntil: null });
      }
      return true;
    });
  }

  async function store(
    sctx: TenantContext,
    claimed: Opened,
    tokens: OAuthTokenSet,
  ): Promise<Opened | undefined> {
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ConnectionRepo(sctx, tx);
      const row = await repo.lockLiveById(claimed.row.id);
      // Disconnected (or replaced) while the vendor answered: drop the tokens, write nothing.
      if (row === undefined) return undefined;
      const accounts =
        tokens.extra?.["accounts"] === undefined
          ? claimed.creds.accounts
          : parseAccounts(tokens.extra["accounts"]);
      const creds: StoredCredentials = {
        ...claimed.creds,
        accessToken: tokens.accessToken,
        // Rotating vendors hand back a new refresh token and invalidate the old: never drop it.
        refreshToken: tokens.refreshToken ?? claimed.creds.refreshToken ?? null,
        ...(accounts === undefined ? {} : { accounts }),
      };
      const sealed = await vault.sealCredentials(tx, sctx, creds);
      const updated =
        (await repo.update(row.id, {
          credentialsEnc: sealed.enc,
          encryption: {
            ...(row.encryption as { credentials: typeof sealed.ref }),
            credentials: sealed.ref,
          },
          accessExpiresAt: tokens.expiresAt,
          ...(tokens.scope === null ? {} : { scope: tokens.scope.slice(0, 1000) }),
          refreshLeaseUntil: null,
        })) ?? row;
      return { row: updated, creds, adapter: claimed.adapter };
    });
  }

  async function refresh(
    sctx: TenantContext,
    opened: Opened,
    force: boolean,
  ): Promise<RefreshOutcome> {
    const { adapter } = opened;
    const client = deps.oauthClients[opened.row.provider];
    const deadline = Date.now() + waitMs;
    const observed = opened.creds.accessToken;
    for (;;) {
      const claimed = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ConnectionRepo(sctx, tx).claimRefreshLease(opened.row.id, leaseMs);
        return row === undefined ? undefined : openRow(tx, sctx, row);
      });
      if (claimed !== undefined) {
        if (claimed.creds === undefined) {
          await release(sctx, claimed.row.id, { kind: "reauth" });
          return { ok: false, gone: false, outcome: { kind: "reauth" }, recorded: true };
        }
        const current: Opened = { row: claimed.row, creds: claimed.creds, adapter };
        // Somebody refreshed between our read and this claim: use theirs.
        if (current.creds.accessToken !== observed && (force || !expiringSoon(current.row))) {
          await release(sctx, current.row.id, undefined);
          return { ok: true, opened: current };
        }
        const refreshToken = current.creds.refreshToken ?? null;
        if (adapter.refresh === undefined || refreshToken === null || refreshToken === "") {
          // Nothing to refresh with: the vendor's refusal of the access token stands.
          const outcome: HealthOutcome = force
            ? { kind: "reauth" }
            : { kind: "failure", reason: "refresh_failed" };
          await release(sctx, current.row.id, outcome);
          return { ok: false, gone: false, outcome, recorded: true };
        }
        if (client === undefined) {
          const outcome: HealthOutcome = { kind: "failure", reason: "refresh_failed" };
          await release(sctx, current.row.id, outcome);
          return { ok: false, gone: false, outcome, recorded: true };
        }
        const refreshFn = adapter.refresh.bind(adapter);
        const result = await safely(() => refreshFn({ refreshToken, client }));
        if (!result.ok) {
          const outcome: HealthOutcome =
            result.reason === "unauthorized"
              ? { kind: "reauth" }
              : { kind: "failure", reason: "refresh_failed" };
          log("integrations.refresh_failed", {
            workspaceId: sctx.workspaceId,
            provider: current.row.provider,
            reason: result.reason,
          });
          const live = await release(sctx, current.row.id, outcome);
          return live
            ? { ok: false, gone: false, outcome, recorded: true }
            : { ok: false, gone: true };
        }
        const stored = await store(sctx, current, result.value);
        return stored === undefined ? { ok: false, gone: true } : { ok: true, opened: stored };
      }
      // Lost the lease: wait for the winner's token.
      if (Date.now() > deadline) {
        return {
          ok: false,
          gone: false,
          outcome: { kind: "failure", reason: "refresh_failed" },
          recorded: false,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
      const reread = await openById(sctx, opened.row.id);
      if (reread === undefined) return { ok: false, gone: true };
      if (reread.creds !== undefined && reread.creds.accessToken !== observed) {
        return { ok: true, opened: { row: reread.row, creds: reread.creds, adapter } };
      }
      const leaseFree =
        reread.row.refreshLeaseUntil === null ||
        reread.row.refreshLeaseUntil.getTime() <= Date.now();
      // The winner's refresh was refused and it recorded that: do not spend another refresh.
      if (leaseFree && reread.row.status === "reauth_required") {
        return { ok: false, gone: false, outcome: { kind: "reauth" }, recorded: true };
      }
    }
  }

  /**
   * Runs `fn` with the provider's credentials (see the file comment). Returns the vendor's answer,
   * `not_connected`, or `unauthorized` when the token is dead.
   */
  async function withAuth<T>(
    ctx: TenantContext,
    provider: IntegrationProvider,
    fn: (auth: IntegrationAuth, opened: Opened) => Promise<IntegrationResult<T>>,
  ): Promise<IntegrationResult<T> | NotConnected> {
    const sctx = sys(ctx);
    const loaded = await open(sctx, provider);
    if (loaded === undefined) return NOT_CONNECTED;
    if (loaded.creds === undefined) {
      await record(sctx, loaded.row.id, { kind: "reauth" });
      return { ok: false, reason: "unauthorized" };
    }
    let opened: Opened = { row: loaded.row, creds: loaded.creds, adapter: loaded.adapter };
    const oauth = opened.row.authKind === "oauth2";
    const settle = async (r: RefreshOutcome & { ok: false }) => {
      if (r.gone) return NOT_CONNECTED;
      if (!r.recorded) await record(sctx, opened.row.id, r.outcome);
      return { ok: false as const, reason: failureOf(r.outcome) };
    };
    if (oauth && expiringSoon(opened.row)) {
      const r = await refresh(sctx, opened, false);
      if (!r.ok) return settle(r);
      opened = r.opened;
    }
    const call = (o: Opened) => safely(() => fn(authOf(o.row, o.creds), o));
    let result = await call(opened);
    if (!result.ok && result.reason === "unauthorized" && oauth) {
      const r = await refresh(sctx, opened, true);
      if (!r.ok) return settle(r);
      opened = r.opened;
      result = await call(opened);
    }
    await record(sctx, opened.row.id, healthOf(result));
    return result;
  }

  return { withAuth, open, record, recordInTx, sys };
}
