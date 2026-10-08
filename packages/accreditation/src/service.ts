import { createHmac, randomBytes } from "node:crypto";
import type { AuditInput } from "@fundroom/audit";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import { type core, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { AccreditationEffectiveProvider } from "@fundroom/module-kit";
import {
  ACCREDITATION_VENDOR_DRIVERS,
  type AccreditationAdapterDefinition,
  type AccreditationAdapterDeps,
  type AccreditationDriver,
  AccreditationProviderError,
  type AccreditationVendorDriver,
  type AccreditationVendorPort,
} from "@fundroom/ports";
import { AccreditationError } from "./errors.js";
import {
  asProviderError,
  boundRefs,
  checkCredentials,
  credentialHints,
  environmentOf,
  isCredentialFailure,
  isUuid,
  providerDetail,
} from "./policy.js";
import {
  AccreditationConnectionRepo,
  type AccreditationConnectionRow,
  findConnectionForCallback,
} from "./repos/connection-repo.js";
import {
  ACCREDITATION_KEY_PURPOSE,
  type AccreditationActor,
  type AccreditationConnectionDetail,
  type AccreditationKernel,
  type AccreditationServiceDeps,
  MANUAL_LABEL,
} from "./types.js";

/*
 * The kernel accreditation-vendor service (E3.7, ADR-0055).
 *
 * Transactions. Every vendor HTTP call happens OUTSIDE any transaction (E2.6 pool-deadlock rule):
 * a short tx reads the live connection and unseals its credentials, the tx closes, then the vendor
 * is called; whatever the answer changes on the connection (`status = error` after `unauthorized`)
 * is written in another short tx that re-checks the row under the singleton lock. Saving verifies
 * the credentials live BEFORE any transaction opens.
 *
 * Lock order on every write path: connection advisory lock `accreditation.connection:<ws>` →
 * connection row (FOR UPDATE) → audit chain → outbox. Never the workspace row.
 *
 * A vendor callback is only a wake-up: the adapter authenticates it and names refs; the service
 * records `last_callback_at` and publishes `accreditation.provider_updated`, and the round module
 * re-reads each ref over the authenticated API. Nothing in the body is trusted.
 *
 * DB work runs in the workspace's `system` context (external members cannot read the table under
 * RLS, by design); audit rows name the real actor explicitly.
 *
 * Erasure: nothing here is personal data. The connection names its creator only by membership id
 * (`ON DELETE SET NULL`), like `core.esign_connection`, and holds the issuer's vendor account.
 */

type AccreditationConnectionEncryption = core.AccreditationConnectionEncryption;
type AccreditationSealedRef = core.AccreditationSealedRef;

interface OpenedConnection {
  readonly row: AccreditationConnectionRow;
  readonly adapter: AccreditationAdapterDefinition;
  readonly credentials: Readonly<Record<string, string>>;
}

const FALLBACK_LABELS: Readonly<Record<AccreditationVendorDriver, string>> = {
  verifyinvestor: "VerifyInvestor.com",
  "parallel-markets": "Parallel Markets",
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

export function createAccreditationService(deps: AccreditationServiceDeps): AccreditationKernel {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const offered = new Set<AccreditationVendorDriver>(
    deps.drivers ?? (Object.keys(deps.adapters) as AccreditationVendorDriver[]),
  );
  const manualRequires = deps.manualRequires ?? { evidenceUpload: true, adminDecision: true };

  // --- small helpers ---------------------------------------------------------------------------

  function sys(ctx: TenantContext | string): TenantContext {
    return systemContext(typeof ctx === "string" ? ctx : ctx.workspaceId);
  }

  function refuseViewAs(ctx: TenantContext): void {
    if (ctx.viewAs !== undefined) {
      throw new AccreditationError("conflict", "view-as is read only", {
        reason: "view_as_read_only",
      });
    }
  }

  function adapterOf(
    driver: AccreditationVendorDriver,
  ): AccreditationAdapterDefinition | undefined {
    return deps.adapters[driver];
  }

  function labelOf(driver: AccreditationDriver): string {
    if (driver === "manual") return MANUAL_LABEL;
    return adapterOf(driver)?.meta.label ?? FALLBACK_LABELS[driver];
  }

  /** Adapter deps for one call: the guarded client, honouring the caller's abort signal. */
  function adapterDeps(
    driver: AccreditationVendorDriver,
    signal?: AbortSignal,
  ): AccreditationAdapterDeps {
    const base = deps.fetch;
    const fetchFn: typeof fetch =
      signal === undefined
        ? base
        : (((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            base(input, {
              ...init,
              signal: init?.signal == null ? signal : AbortSignal.any([init.signal, signal]),
            })) as typeof fetch);
    const apiBaseUrl = deps.apiBaseUrls?.[driver];
    return {
      fetch: fetchFn,
      now,
      log: (event, fields) => log("accreditation.adapter", { driver, event, ...(fields ?? {}) }),
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    };
  }

  function actorAudit(ctx: TenantContext, actor: AccreditationActor): Partial<AuditInput> {
    return {
      actorKind: ctx.actorKind,
      actorMembershipId: actor.membershipId,
      actorUserId: ctx.userId ?? null,
      requestId: actor.requestId ?? null,
      sessionId: actor.sessionId ?? null,
      ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    };
  }

  // --- sealing ---------------------------------------------------------------------------------

  async function seal(
    tx: Tx,
    sctx: TenantContext,
    text: string,
  ): Promise<{ enc: Buffer; ref: AccreditationSealedRef }> {
    const dek = await deps.crypto.currentKey(tx, sctx, ACCREDITATION_KEY_PURPOSE);
    const enc = Buffer.from(await encryptBytes(dek.key, Buffer.from(text, "utf8")));
    return { enc, ref: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef } };
  }

  async function unseal(
    tx: Tx,
    sctx: TenantContext,
    ref: AccreditationSealedRef | undefined,
    enc: Uint8Array | null,
  ): Promise<string | undefined> {
    if (ref === undefined || enc === null) return undefined;
    const key = await deps.crypto.keyById(tx, sctx, ref.keyId);
    if (key === undefined) return undefined;
    try {
      return Buffer.from(await decryptBytes(key.key, enc)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Decrypts a connection's credentials inside the caller's tx. `undefined` when the adapter is
   * not registered or the sealed blob cannot be read (a lost key); the caller decides what that
   * means.
   */
  async function openConnection(
    tx: Tx,
    sctx: TenantContext,
    row: AccreditationConnectionRow,
  ): Promise<OpenedConnection | undefined> {
    const adapter = adapterOf(row.driver);
    if (adapter === undefined) return undefined;
    const enc = row.encryption as AccreditationConnectionEncryption;
    const text = await unseal(tx, sctx, enc.credentials, row.credentialsEnc);
    if (text === undefined) return undefined;
    let credentials: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        credentials = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    } catch {
      return undefined;
    }
    return { row, adapter, credentials };
  }

  function portOf(opened: OpenedConnection, signal?: AbortSignal): AccreditationVendorPort {
    return opened.adapter.create(
      { credentials: opened.credentials },
      adapterDeps(opened.row.driver, signal),
    );
  }

  function detailOf(row: AccreditationConnectionRow): AccreditationConnectionDetail {
    return {
      id: row.id,
      driver: row.driver,
      label: labelOf(row.driver),
      environment: row.environment,
      credentialHints: { ...row.credentialHints },
      status: row.status,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastError: row.lastError,
      lastCallbackAt: row.lastCallbackAt?.toISOString() ?? null,
      callbackUrl: deps.callbackUrl(row.id),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // --- vendor calls for modules ------------------------------------------------------------------

  /**
   * After a vendor refused the stored credentials: `status = error` + `last_error`, in a short tx
   * of its own, and only when the row is still the live one with the SAME sealed credentials (a
   * re-key that landed meanwhile is not marked broken by the old key's failure).
   */
  async function markUnauthorized(
    sctx: TenantContext,
    opened: Pick<OpenedConnection, "row">,
    error: AccreditationProviderError,
  ): Promise<void> {
    try {
      await deps.db.withTenant(sctx, async (tx) => {
        const conns = new AccreditationConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined || live.id !== opened.row.id) return;
        if (!sameBytes(live.credentialsEnc, opened.row.credentialsEnc)) return;
        await conns.update(live.id, { status: "error", lastError: providerDetail(error) });
      });
      log("accreditation.connection_unauthorized", {
        workspaceId: sctx.workspaceId,
        connectionId: opened.row.id,
        driver: opened.row.driver,
      });
    } catch (e) {
      // Best effort: the caller's own error is what matters.
      log("accreditation.mark_error_failed", {
        level: "warn",
        error: e instanceof Error ? e.name : "unknown",
      });
    }
  }

  /**
   * One vendor call for a module: unseal in a short tx (closed before the call), call, and on
   * `unauthorized` mark the connection. `not_connected` when the live connection is not `driver`.
   */
  async function withVendor<T>(
    ctx: TenantContext,
    driver: AccreditationVendorDriver,
    signal: AbortSignal | undefined,
    call: (port: AccreditationVendorPort) => Promise<T>,
    options: { readonly requireOffered?: boolean } = {},
  ): Promise<T> {
    const sctx = sys(ctx);
    // A vendor the operator stopped offering starts nothing new (fix round 1); verifications
    // already open with it are still checked and collected through the live connection.
    if (options.requireOffered === true && !offered.has(driver)) {
      throw new AccreditationProviderError(
        `${driver} is not offered by this install`,
        "not_connected",
        false,
      );
    }
    const found = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new AccreditationConnectionRepo(sctx, tx).live();
      if (row === undefined || row.driver !== driver) return { row: undefined, opened: undefined };
      return { row, opened: await openConnection(tx, sctx, row) };
    });
    if (found.row === undefined) {
      throw new AccreditationProviderError(
        `the workspace has no live ${driver} connection`,
        "not_connected",
        false,
      );
    }
    if (found.opened === undefined) {
      // No adapter for the driver, or the sealed credentials are unreadable: nothing a retry fixes,
      // and the admin must see it on the connection (fix round 1: it stayed `active`).
      const pe = new AccreditationProviderError(
        "the connection's credentials are unreadable; save them again",
        "unauthorized",
        false,
      );
      await markUnauthorized(sctx, { row: found.row }, pe);
      throw pe;
    }
    const opened = found.opened;
    signal?.throwIfAborted();
    try {
      return await call(portOf(opened, signal));
    } catch (error) {
      const pe = asProviderError(error);
      if (pe.code === "unauthorized") await markUnauthorized(sctx, opened, pe);
      throw pe;
    }
  }

  async function effectiveOf(tx: Tx, ctx: TenantContext): Promise<AccreditationEffectiveProvider> {
    const row = await new AccreditationConnectionRepo(ctx, tx).live();
    // No live connection, or one on a vendor the operator no longer offers (ACCREDITATION_DRIVERS,
    // e.g. a sub-processor dropped): new verifications are reviewed manually (fix round 1).
    if (row === undefined || !offered.has(row.driver)) {
      return { driver: "manual", label: MANUAL_LABEL, requires: { ...manualRequires } };
    }
    return {
      driver: row.driver,
      label: labelOf(row.driver),
      requires: { evidenceUpload: false, adminDecision: false },
      connectionId: row.id,
    };
  }

  // --- callback timing (fix round 1) ---------------------------------------------------------------

  /** An HMAC-SHA256 over the body under a throwaway key: the adapter's signature check, costed. */
  function hmacDecoy(body: Uint8Array): void {
    createHmac("sha256", randomBytes(32)).update(body).digest();
  }

  // --- the service ------------------------------------------------------------------------------

  return {
    label: labelOf,

    async effective(tx, ctx) {
      // With a caller's tx: read in it (the caller's context must be staff/system — an external
      // member's context sees no connection row under RLS). Without: a short system-context tx.
      if (tx !== undefined) return effectiveOf(tx, ctx);
      const sctx = sys(ctx);
      return deps.db.withTenant(sctx, (t) => effectiveOf(t, sctx));
    },

    async start(ctx, input) {
      const { driver, ...rest } = input;
      return withVendor(ctx, driver, undefined, (port) => port.start(rest), {
        requireOffered: true,
      });
    },

    async check(ctx, input) {
      return withVendor(ctx, input.driver, input.signal, (port) =>
        port.check({ providerRef: input.providerRef }),
      );
    },

    async fetchEvidence(ctx, input) {
      return withVendor(ctx, input.driver, input.signal, (port) =>
        port.fetchEvidence({ providerRef: input.providerRef }),
      );
    },

    providers() {
      return ACCREDITATION_VENDOR_DRIVERS.flatMap((driver) => {
        const a = adapterOf(driver);
        return a === undefined
          ? []
          : [{ meta: a.meta, credentialFields: a.credentialFields, offered: offered.has(driver) }];
      });
    },

    async connection(ctx) {
      const sctx = sys(ctx);
      const row = await deps.db.withTenant(sctx, (tx) =>
        new AccreditationConnectionRepo(sctx, tx).live(),
      );
      return row === undefined ? undefined : detailOf(row);
    },

    async saveConnection(ctx, input, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const adapter = adapterOf(input.driver);
      if (adapter === undefined) {
        throw new AccreditationError(
          "accreditation_driver_not_offered",
          "that accreditation vendor is not offered here",
          { driver: input.driver },
        );
      }
      // What is stored now (same driver: blank secrets keep their stored value).
      const previous = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new AccreditationConnectionRepo(sctx, tx).live();
        if (row === undefined || row.driver !== input.driver) return undefined;
        return (await openConnection(tx, sctx, row)) ?? null;
      });
      // A-3: a new connection or a vendor switch needs the plan's feature; refused before the
      // vendor is asked anything (re-checked under the lock below).
      if (previous === undefined) input.assertMayConnect?.();
      // A vendor the operator no longer offers cannot be connected or switched to, but the live
      // connection on it can still be re-keyed (a leaked key must be rotatable; E3.5 fix A14).
      if (!offered.has(input.driver) && previous === undefined) {
        throw new AccreditationError(
          "accreditation_driver_not_offered",
          "that accreditation vendor is not offered here",
          { driver: input.driver },
        );
      }
      const clear = [...new Set(input.clearCredentials ?? [])];
      const credentials = checkCredentials(
        adapter.credentialFields,
        input.credentials,
        previous?.credentials,
        clear,
      );

      // Live verification before anything is committed, with no transaction open.
      try {
        await adapter.create({ credentials }, adapterDeps(input.driver)).verifyCredentials();
      } catch (error) {
        const pe = asProviderError(error);
        if (isCredentialFailure(pe)) {
          throw new AccreditationError(
            "accreditation_credentials_invalid",
            `${adapter.meta.label} did not accept these credentials`,
            { reason: pe.code },
          );
        }
        throw new AccreditationError(
          "accreditation_provider_error",
          `${adapter.meta.label} could not be reached to check these credentials`,
          { providerCode: pe.code },
        );
      }

      const at = now();
      const saved = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new AccreditationConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        // A-3, authoritative: judged on the locked row.
        if (live === undefined || live.driver !== input.driver) input.assertMayConnect?.();
        const creds = await seal(tx, sctx, JSON.stringify(credentials));
        const values = {
          environment: environmentOf(credentials),
          credentialsEnc: creds.enc,
          encryption: { credentials: creds.ref } satisfies AccreditationConnectionEncryption,
          credentialHints: credentialHints(adapter.credentialFields, credentials),
          status: "active" as const,
          lastVerifiedAt: at,
          lastError: null,
        };
        let row: AccreditationConnectionRow;
        let replaced = false;
        if (live !== undefined && live.driver === input.driver) {
          row = (await conns.update(live.id, values)) ?? live;
        } else {
          // Re-checked under the lock: the live row may have changed since `previous` was read.
          if (!offered.has(input.driver)) {
            throw new AccreditationError(
              "accreditation_driver_not_offered",
              "that accreditation vendor is not offered here",
              { driver: input.driver },
            );
          }
          if (live !== undefined) {
            await conns.update(live.id, { deletedAt: at });
            replaced = true;
          }
          row = await conns.insert({
            driver: input.driver,
            ...values,
            createdByMembershipId: actor.membershipId,
          });
        }
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "accreditation.connection_saved",
          resourceKind: "accreditation_connection",
          resourceId: row.id,
          meta: {
            driver: row.driver,
            environment: row.environment,
            replaced,
            previousDriver: live?.driver ?? null,
            ...(replaced && live !== undefined ? { previousConnectionId: live.id } : {}),
            fields: Object.keys(credentials).sort(),
            ...(clear.length === 0 ? {} : { cleared: clear.sort() }),
          },
        });
        return row;
      });
      return detailOf(saved);
    },

    async verifyConnection(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const found = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new AccreditationConnectionRepo(sctx, tx).live();
        if (row === undefined) return undefined;
        return { row, opened: await openConnection(tx, sctx, row) };
      });
      if (found === undefined) {
        throw new AccreditationError("not_found", "no accreditation vendor is connected", {
          reason: "no_connection",
        });
      }
      let failure: AccreditationProviderError | undefined;
      if (found.opened === undefined) {
        failure = new AccreditationProviderError(
          "the connection's credentials are unreadable; save them again",
          "unauthorized",
          false,
        );
      } else {
        try {
          await portOf(found.opened).verifyCredentials();
        } catch (error) {
          failure = asProviderError(error);
        }
      }
      if (failure !== undefined && !isCredentialFailure(failure)) {
        // The vendor could not be asked: say so, and leave the connection as it stands.
        throw new AccreditationError(
          "accreditation_provider_error",
          `${labelOf(found.row.driver)} could not be reached`,
          { providerCode: failure.code },
        );
      }
      const at = now();
      const row = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new AccreditationConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (
          live === undefined ||
          live.id !== found.row.id ||
          !sameBytes(live.credentialsEnc, found.row.credentialsEnc)
        ) {
          throw new AccreditationError("conflict", "the connection changed; try again", {
            reason: "connection_changed",
          });
        }
        const updated =
          (await conns.update(live.id, {
            status: failure === undefined ? "active" : "error",
            lastVerifiedAt: at,
            lastError: failure === undefined ? null : providerDetail(failure),
          })) ?? live;
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "accreditation.connection_verified",
          resourceKind: "accreditation_connection",
          resourceId: live.id,
          ...(failure === undefined ? {} : { outcome: "failure" as const }),
          meta: {
            driver: live.driver,
            environment: live.environment,
            ok: failure === undefined,
            reason: failure?.code ?? null,
          },
        });
        return updated;
      });
      return detailOf(row);
    },

    async deleteConnection(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      await deps.db.withTenant(sctx, async (tx) => {
        const conns = new AccreditationConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined) {
          throw new AccreditationError("not_found", "no accreditation vendor is connected", {
            reason: "no_connection",
          });
        }
        await conns.update(live.id, { deletedAt: now() });
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "accreditation.connection_deleted",
          resourceKind: "accreditation_connection",
          resourceId: live.id,
          meta: { driver: live.driver, environment: live.environment },
        });
      });
    },

    async ingestCallback(connectionId, request, options) {
      if (!isUuid(connectionId)) return { status: 401 };
      const hit = await deps.db.withHost((tx) => findConnectionForCallback(tx, connectionId));
      if (hit === undefined) {
        // No-DB stand-in for the signature check a live id gets (fix round 2: a decoy transaction
        // doubled pre-auth DB cost under the 30 000/min pre-auth ceiling). Timing is only roughly
        // equal — the host lookup is the unavoidable DB cost of any uuid.
        hmacDecoy(request.rawBody);
        return { status: 401 };
      }
      const sctx = sys(hit.workspaceId);
      const opened = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new AccreditationConnectionRepo(sctx, tx).byId(connectionId);
        if (row === undefined || row.deletedAt !== null) return undefined;
        return openConnection(tx, sctx, row);
      });
      if (opened === undefined) {
        hmacDecoy(request.rawBody);
        return { status: 401 };
      }
      let parsed: { readonly refs: readonly string[] } | undefined;
      try {
        parsed = await portOf(opened).parseCallback({
          headers: request.headers,
          rawBody: request.rawBody,
          now: now(),
        });
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) return { status: 401, driver: hit.driver };
      // The route's budget, spent only by authenticated callbacks and before any write they cause
      // (E2.6: rate-limit provider webhooks after authentication).
      if (options?.admit !== undefined && !options.admit()) {
        return { status: 429, driver: hit.driver };
      }
      const refs = boundRefs(parsed.refs);
      const at = now();
      const published = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new AccreditationConnectionRepo(sctx, tx);
        // Touch only the row that authenticated, and only while it is still live.
        const row = await conns.byId(connectionId);
        if (row === undefined || row.deletedAt !== null) return false;
        await conns.update(row.id, { lastCallbackAt: at });
        if (refs.length === 0) return false;
        await publish(tx, sctx, "accreditation.provider_updated", {
          connectionId: row.id,
          driver: row.driver,
          refs,
        });
        return true;
      });
      log("accreditation.callback", {
        workspaceId: hit.workspaceId,
        driver: hit.driver,
        refs: refs.length,
        published,
      });
      return { status: 200, driver: hit.driver };
    },
  };
}
