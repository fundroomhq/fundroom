import { createHash, randomBytes } from "node:crypto";
import type { AuditInput } from "@fundroom/audit";
import { decryptBytes, decryptStream, encryptBytes, streamToBytes } from "@fundroom/crypto";
import {
  type core,
  isPlatformWorkspace,
  listActiveWorkspaceIds,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AttestationRepo, MembershipRepo } from "@fundroom/identity";
import type { ESignEnvelopeView, ESignRequestInput } from "@fundroom/module-kit";
import {
  type ESignAdapterDefinition,
  type ESignConnectionConfig,
  type ESignDocumentSource,
  type ESignDriver,
  type ESignEnvelopeState,
  type ESignPort,
  ESignProviderError,
  type ESignProviderErrorCode,
  type JobDefinition,
  type JsonObject,
} from "@fundroom/ports";
import { esignArtifactKey } from "@fundroom/storage";
import {
  consentData,
  ESIGN_CONSENT_KIND,
  ESIGN_DISCLOSURE_SHA256,
  ESIGN_DISCLOSURE_VERSION,
} from "./consent.js";
import { emailOf } from "./erasure.js";
import { ESignError } from "./errors.js";
import { assertESignConnected } from "./guards.js";
import { assertNdaTextRenderable, renderNdaPdf } from "./nda-pdf.js";
import {
  baseUrlHost,
  COLLECT_RETRY_MS,
  checkBaseUrl,
  checkCredentials,
  credentialHints,
  decodeEnvelopeCursor,
  encodeEnvelopeCursor,
  esignCallbackUrl,
  isLiveAtVendor,
  isOpen,
  isTerminal,
  isUuid,
  looksLikePdf,
  nextEnvelopeStatus,
  nextSignerStatus,
  nextSyncAt,
  providerDetail,
  STALE_DRAFT_MS,
  SYNC_GRACE_MAX_DELAY_MS,
  secretsToReenter,
  syncGraceOver,
  syncWindowOver,
} from "./policy.js";
import {
  ESignConnectionRepo,
  type ESignConnectionRow,
  findConnectionForCallback,
} from "./repos/connection-repo.js";
import {
  type ESignEnvelopePatch,
  ESignEnvelopeRepo,
  type ESignEnvelopeRow,
} from "./repos/envelope-repo.js";
import { readLegalDocument, readWorkspaceName } from "./repos/legal-repo.js";
import {
  ESIGN_JOBS,
  ESIGN_KEY_PURPOSES,
  ESIGN_SWEEP_BATCH,
  ESIGN_SYNC_DUE_CRON,
  type ESignActor,
  type ESignConnectionDetail,
  type ESignConnectionSummary,
  type ESignKernel,
  type ESignServiceDeps,
  NDA_VAULT_FOLDER,
  type NdaStatus,
} from "./types.js";

/*
 * The kernel e-signature service (E3.5, ADR-0053).
 *
 * Transactions. Every vendor HTTP call happens OUTSIDE any transaction (E2.6 pool-deadlock rule):
 * short tx (read/claim/insert) → vendor call → short tx that locks the envelope row again and
 * re-checks it before applying the answer. Nothing here opens a second pool connection while it
 * holds one: the DEK for artifacts is fetched in its own short tx, erasure/consent reads take the
 * caller's tx.
 *
 * Lock order on every write path: [connection advisory lock `esign.connection:<ws>`] → envelope
 * row (FOR UPDATE, by id; a set in id order) → audit chain → outbox/queue. The connection
 * singleton never locks the workspace row. Identity erasure pre-locks the advisory lock and then
 * the member's envelope rows before it takes the audit chain (`./erasure.ts`).
 *
 * Status is monotonic (`policy.nextEnvelopeStatus`); the `core.esign_envelope_guard` trigger is
 * the backstop that keeps a terminal row terminal. A vendor callback is only a wake-up: the sync
 * job pulls `status()` and acts on that.
 *
 * DB work runs in the workspace's `system` context (an external member starting an NDA cannot
 * write the row under RLS, by design); the audit rows name the real actor explicitly.
 */

type ESignConnectionEncryption = core.ESignConnectionEncryption;
type ESignEnvelopeArtifacts = core.ESignEnvelopeArtifacts;
type ESignSealedRef = core.ESignSealedRef;
type ESignStoredArtifact = core.ESignStoredArtifact;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

const SIGNER_KEY = "s1";
const DEFAULT_TEMPLATE_ROLE = "Signer";
/** A claimed row is not re-claimed by the sweep for this long (the job re-schedules it). */
const CLAIM_LEASE_MS = 10 * 60_000;
const NOT_FOUND_MARK = "vendor_not_found";
const TITLE_MAX = 300;
/** A member may start at most this many NEW NDA envelopes per window (E3.5 fix A7). */
export const NDA_START_BUDGET = 5;
export const NDA_START_WINDOW_MS = 24 * 60 * 60_000;
/** How long a concurrent NDA start waits for the other request's in-flight draft (A8). */
const DRAFT_WAIT_MS = 4_000;
const DRAFT_POLL_MS = 150;

const VIEW_FIELDS = (row: ESignEnvelopeRow): ESignEnvelopeView => ({
  id: row.id,
  purpose: row.purpose,
  subject: { module: row.subjectModule, kind: row.subjectKind, id: row.subjectId },
  status: row.status,
  signerStatus: row.signerStatus ?? null,
  signerName: row.signerName,
  signerEmail: row.signerEmail,
  membershipId: row.membershipId,
  title: row.title,
  driver: row.driver,
  sentAt: row.sentAt?.toISOString() ?? null,
  completedAt: row.completedAt?.toISOString() ?? null,
  hasSigned: row.artifacts !== null && row.artifacts.signed !== undefined,
  hasCertificate: row.artifacts !== null && row.artifacts.certificate !== undefined,
  vaultFolder: row.vaultFolder,
  vaultedDocumentId: row.vaultedDocumentId,
  errorCode: row.errorCode,
  createdAt: row.createdAt.toISOString(),
});

export function toEnvelopeView(row: ESignEnvelopeRow): ESignEnvelopeView {
  return VIEW_FIELDS(row);
}

/** Anything a vendor call threw, as an `ESignProviderError` (guard/network errors are transient). */
export function asProviderError(error: unknown): ESignProviderError {
  if (error instanceof ESignProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ESignProviderError(
    `vendor call failed: ${message}`.slice(0, 300),
    "unavailable",
    true,
  );
}

function mintCallbackSecret(): string {
  return randomBytes(32).toString("base64url");
}

function slugForFile(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/gu, "")
    .trim()
    .replace(/[\s_]+/gu, "-")
    .toLowerCase()
    .slice(0, 60);
  return s.length > 0 ? s : "document";
}

interface EnvelopeSpec {
  readonly purpose: "nda" | "round_closing";
  readonly subject: { readonly module: string; readonly kind: string; readonly id: string };
  readonly signer: {
    readonly name: string;
    readonly email: string;
    readonly membershipId?: string | undefined;
    readonly role?: string | undefined;
  };
  readonly title: string;
  readonly message?: string | undefined;
  readonly document: ESignDocumentSource;
  readonly vaultFolder?: string | undefined;
  readonly embedded: boolean;
  readonly redirectUrl?: string | undefined;
  readonly requestedByMembershipId: string | null;
  readonly legal?: { readonly documentId: string; readonly versionNo: number } | undefined;
  /** Under the connection lock, before insert: an existing envelope to return instead. */
  readonly dedupe?:
    | ((repo: ESignEnvelopeRepo) => Promise<ESignEnvelopeRow | undefined>)
    | undefined;
  /** Under the connection lock, after `dedupe` found nothing, before insert: may throw. */
  readonly guard?: ((repo: ESignEnvelopeRepo) => Promise<void>) | undefined;
}

export function createESignService(deps: ESignServiceDeps): ESignKernel {
  const now = deps.now ?? (() => new Date());
  const log: Log = deps.log ?? (() => {});
  const offered = new Set<ESignDriver>(
    deps.drivers ?? (Object.keys(deps.adapters) as ESignDriver[]),
  );
  const adapterDeps = {
    fetch: deps.outbound.fetch as typeof fetch,
    now,
    log: {
      warn: (obj: object, msg?: string) =>
        log("esign.adapter_warning", { level: "warn", msg: msg ?? "", ...obj }),
    },
  };

  // --- small helpers ---------------------------------------------------------------------------

  function sys(ctx: TenantContext | string): TenantContext {
    return systemContext(typeof ctx === "string" ? ctx : ctx.workspaceId);
  }

  function refuseViewAs(ctx: TenantContext): void {
    if (ctx.viewAs !== undefined) {
      throw new ESignError("conflict", "view-as is read only", { reason: "view_as_read_only" });
    }
  }

  function adapterOf(driver: ESignDriver): ESignAdapterDefinition {
    const a = deps.adapters[driver];
    if (a === undefined) {
      throw new ESignError("esign_not_configured", `no adapter for ${driver}`, { driver });
    }
    return a;
  }

  function actorAudit(ctx: TenantContext, actor: ESignActor | "system"): Partial<AuditInput> {
    if (actor === "system") {
      return { actorKind: "system", actorMembershipId: null, actorUserId: null };
    }
    return {
      actorKind: ctx.actorKind,
      actorMembershipId: actor.membershipId,
      actorUserId: ctx.userId ?? null,
      requestId: actor.requestId ?? null,
      sessionId: actor.sessionId ?? null,
      ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    };
  }

  async function auditEnvelope(
    tx: Tx,
    sctx: TenantContext,
    who: Partial<AuditInput>,
    action: AuditInput["action"],
    row: ESignEnvelopeRow,
    meta: JsonObject,
  ): Promise<void> {
    await deps.audit.record(tx, sctx, {
      ...who,
      action,
      resourceKind: "esign_envelope",
      resourceId: row.id,
      subjectMembershipId: row.membershipId,
      meta: { purpose: row.purpose, driver: row.driver, ...meta },
    });
  }

  async function publishChanged(
    tx: Tx,
    sctx: TenantContext,
    row: ESignEnvelopeRow,
    status: ESignEnvelopeRow["status"] = row.status,
  ): Promise<void> {
    await publish(tx, sctx, "esign.envelope_changed", {
      envelopeId: row.id,
      status,
      purpose: row.purpose,
      subjectModule: row.subjectModule,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      membershipId: row.membershipId,
    });
  }

  // --- sealing ---------------------------------------------------------------------------------

  async function seal(
    tx: Tx,
    sctx: TenantContext,
    text: string,
  ): Promise<{ enc: Buffer; ref: ESignSealedRef }> {
    const dek = await deps.crypto.currentKey(tx, sctx, ESIGN_KEY_PURPOSES.credentials);
    const enc = Buffer.from(await encryptBytes(dek.key, Buffer.from(text, "utf8")));
    return { enc, ref: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef } };
  }

  async function unseal(
    tx: Tx,
    sctx: TenantContext,
    ref: ESignSealedRef | undefined,
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

  interface OpenedConnection {
    readonly row: ESignConnectionRow;
    readonly adapter: ESignAdapterDefinition;
    readonly config: ESignConnectionConfig;
  }

  /** Decrypts a connection's sealed columns (inside the caller's tx). */
  async function openConnection(
    tx: Tx,
    sctx: TenantContext,
    row: ESignConnectionRow,
  ): Promise<OpenedConnection> {
    const adapter = adapterOf(row.driver);
    const enc = row.encryption as ESignConnectionEncryption;
    const credsText = await unseal(tx, sctx, enc.credentials, row.credentialsEnc);
    if (credsText === undefined) {
      throw new ESignError("esign_not_configured", "the connection's credentials are unreadable", {
        reason: "credentials_unreadable",
      });
    }
    let credentials: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(credsText);
      if (parsed !== null && typeof parsed === "object") {
        credentials = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    } catch {
      // treated as empty below; verify will say misconfigured
    }
    const baseUrl = await unseal(tx, sctx, enc.baseUrl, row.baseUrlEnc);
    const callbackSecret = await unseal(tx, sctx, enc.callbackSecret, row.callbackSecretEnc);
    return {
      row,
      adapter,
      config: {
        credentials,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(callbackSecret === undefined ? {} : { callbackSecret }),
      },
    };
  }

  /** A port for an opened connection; the base URL is re-checked against the guard every time. */
  function portOf(opened: OpenedConnection): ESignPort {
    if (opened.config.baseUrl !== undefined) {
      try {
        checkBaseUrl(opened.config.baseUrl, deps.outbound.assess);
      } catch {
        throw new ESignProviderError(
          "the connection's base URL is no longer allowed by this install",
          "unauthorized",
          false,
        );
      }
    }
    return opened.adapter.create(opened.config, adapterDeps);
  }

  function summaryOf(row: ESignConnectionRow): ESignConnectionSummary {
    const meta = adapterOf(row.driver).meta;
    return {
      driver: row.driver,
      displayName: meta.displayName,
      status: row.status,
      supports: meta.supports,
      baseUrlHost: row.baseUrlHost,
    };
  }

  function detailOf(row: ESignConnectionRow): ESignConnectionDetail {
    const meta = adapterOf(row.driver).meta;
    return {
      ...summaryOf(row),
      id: row.id,
      callbackUrl: deps.callbackUrl?.(row.id) ?? esignCallbackUrl(deps.baseUrl, row.id),
      callbackSecretKind: meta.callbackSecret,
      credentialHints: { ...row.credentialHints },
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // --- the envelope pipeline -------------------------------------------------------------------

  async function markError(
    sctx: TenantContext,
    envelopeId: string,
    who: Partial<AuditInput>,
    error: ESignProviderError,
  ): Promise<ESignEnvelopeRow | undefined> {
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || isTerminal(row.status)) return row;
      const updated =
        (await repo.update(envelopeId, {
          status: "error",
          errorCode: error.code,
          errorDetail: providerDetail(error),
          nextSyncAt: row.providerRef === null ? null : nextSyncAt(now(), row.syncAttempts),
        })) ?? row;
      if (row.status !== "error") {
        await auditEnvelope(tx, sctx, who, "esign.envelope_status_changed", updated, {
          from: row.status,
          to: "error",
          providerCode: error.code,
        });
        await publishChanged(tx, sctx, updated);
      }
      return updated;
    });
  }

  async function createEnvelope(
    ctx: TenantContext,
    spec: EnvelopeSpec,
    actor: ESignActor,
  ): Promise<ESignEnvelopeRow> {
    refuseViewAs(ctx);
    const sctx = sys(ctx);
    const who = actorAudit(ctx, actor);
    const first = await deps.db.withTenant(sctx, async (tx) => {
      const conns = new ESignConnectionRepo(sctx, tx);
      await conns.lockSingleton();
      const conn = await conns.live();
      if (conn === undefined) {
        throw new ESignError("esign_not_configured", "no e-signature provider is connected");
      }
      const opened = await openConnection(tx, sctx, conn);
      const supports = opened.adapter.meta.supports;
      if (spec.document.kind === "template" && !supports.templates) {
        throw new ESignError(
          "esign_template_unsupported",
          `${opened.adapter.meta.displayName} cannot create envelopes from a template`,
          { driver: conn.driver },
        );
      }
      if (spec.document.kind === "pdf" && !supports.pdf) {
        throw new ESignError(
          "esign_template_unsupported",
          `${opened.adapter.meta.displayName} cannot create envelopes from a PDF`,
          { driver: conn.driver, reason: "pdf_unsupported" },
        );
      }
      const envelopes = new ESignEnvelopeRepo(sctx, tx);
      const existing = spec.dedupe === undefined ? undefined : await spec.dedupe(envelopes);
      if (existing !== undefined) return { existing, opened, row: existing };
      if (spec.guard !== undefined) await spec.guard(envelopes);
      if (
        spec.signer.membershipId !== undefined &&
        (await deps.legal.isErased(tx, sctx, spec.signer.membershipId))
      ) {
        throw new ESignError("conflict", "that member's data has been erased", {
          reason: "signer_erased",
        });
      }
      const row = await envelopes.insert({
        connectionId: conn.id,
        driver: conn.driver,
        purpose: spec.purpose,
        subjectModule: spec.subject.module,
        subjectKind: spec.subject.kind,
        subjectId: spec.subject.id,
        legalDocumentId: spec.legal?.documentId ?? null,
        legalVersionNo: spec.legal?.versionNo ?? null,
        membershipId: spec.signer.membershipId ?? null,
        signerName: spec.signer.name,
        signerEmail: spec.signer.email,
        title: spec.title,
        status: "draft",
        embedded: spec.embedded,
        vaultFolder: spec.vaultFolder ?? null,
        requestedByMembershipId: spec.requestedByMembershipId,
      });
      await auditEnvelope(tx, sctx, who, "esign.envelope_requested", row, {
        subjectModule: row.subjectModule,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        documentKind: spec.document.kind,
        embedded: spec.embedded,
      });
      return { existing: undefined, opened, row };
    });
    if (first.existing !== undefined) return first.existing;
    const row = first.row;

    // The vendor call, with no transaction open.
    let providerRef: string;
    try {
      const port = portOf(first.opened);
      const created = await port.createEnvelope({
        externalId: row.id,
        title: row.title,
        ...(spec.message === undefined ? {} : { message: spec.message }),
        document: spec.document,
        signers: [
          {
            signerKey: SIGNER_KEY,
            name: spec.signer.name,
            email: spec.signer.email,
            order: 1,
            ...(spec.document.kind === "template"
              ? { role: spec.signer.role ?? DEFAULT_TEMPLATE_ROLE }
              : {}),
          },
        ],
        ...(spec.redirectUrl === undefined ? {} : { redirectUrl: spec.redirectUrl }),
        embedded: spec.embedded,
      });
      providerRef = created.providerRef;
    } catch (error) {
      const pe = asProviderError(error);
      log("esign.create_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        envelopeId: row.id,
        code: pe.code,
      });
      await markError(sctx, row.id, who, pe);
      throw new ESignError("esign_provider_error", pe.message.slice(0, 300), {
        providerCode: pe.code,
        envelopeId: row.id,
      });
    }

    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const locked = await repo.lockById(row.id);
      if (locked === undefined) throw new ESignError("not_found", "the envelope disappeared");
      if (locked.status !== "draft") {
        // The stale-draft sweep got here first (15 min is far beyond any vendor timeout, so
        // this is essentially unreachable); keep the vendor id so the envelope can be traced.
        return (
          (await repo.update(row.id, { providerRef: locked.providerRef ?? providerRef })) ?? locked
        );
      }
      const at = now();
      const updated =
        (await repo.update(row.id, {
          providerRef,
          status: "sent",
          signerStatus: "pending",
          sentAt: at,
          syncAttempts: 0,
          // An erasure that pseudonymised the signer meanwhile: the sweep voids it at once.
          nextSyncAt: locked.signerPseudonymisedAt === null ? nextSyncAt(at, 0) : at,
        })) ?? locked;
      await auditEnvelope(tx, sctx, who, "esign.envelope_status_changed", updated, {
        from: "draft",
        to: "sent",
      });
      await publishChanged(tx, sctx, updated);
      return updated;
    });
  }

  function checkSigner(signer: { readonly name: string; readonly email: string }): {
    name: string;
    email: string;
  } {
    const name = signer.name.trim().replace(/\s+/gu, " ");
    const email = signer.email.trim();
    if (name.length < 1 || name.length > 300) {
      throw new ESignError("validation_failed", "the signer needs a name", {
        reason: "invalid_signer_name",
      });
    }
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new ESignError("validation_failed", "the signer needs a valid email address", {
        reason: "invalid_signer_email",
      });
    }
    return { name, email };
  }

  function checkTitle(title: string): string {
    const t = title.trim().replace(/\s+/gu, " ");
    if (t.length < 1 || t.length > TITLE_MAX) {
      throw new ESignError("validation_failed", `title must be 1..${TITLE_MAX} characters`, {
        reason: "invalid_title",
      });
    }
    return t;
  }

  // --- vendor-side void ------------------------------------------------------------------------

  type VoidOutcome = "voided" | "terminal_at_vendor" | "not_open";

  /** Voids at the vendor and records it. Throws the provider error when it is retryable. */
  async function voidEnvelope(
    workspaceId: string,
    envelopeId: string,
    reason: string,
    who: Partial<AuditInput>,
  ): Promise<{ outcome: VoidOutcome; row: ESignEnvelopeRow | undefined }> {
    const sctx = sys(workspaceId);
    const pre = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
      if (row === undefined || !isLiveAtVendor(row)) {
        return { row, opened: undefined };
      }
      if (row.providerRef === null) return { row, opened: undefined };
      const conn = await new ESignConnectionRepo(sctx, tx).byId(row.connectionId);
      if (conn === undefined) return { row, opened: undefined };
      return { row, opened: await openConnection(tx, sctx, conn) };
    });
    if (pre.row === undefined || pre.opened === undefined || pre.row.providerRef === null) {
      return { outcome: "not_open", row: pre.row };
    }
    let outcome: VoidOutcome = "voided";
    try {
      if (pre.opened.adapter.meta.supports.void) {
        await portOf(pre.opened).void(pre.row.providerRef, reason.slice(0, 200));
      }
    } catch (error) {
      const pe = asProviderError(error);
      if (pe.code === "not_found") outcome = "voided";
      else if (pe.code === "rejected") outcome = "terminal_at_vendor";
      else throw pe;
    }
    if (outcome === "terminal_at_vendor") {
      // The vendor refused because the envelope is already finished there (signed, declined,
      // expired). Pull and apply that answer here — never enqueue a sync blindly: for an erased
      // signer the sync would void again and the two jobs would loop for ever (E3.5 fix A1). A
      // signed envelope becomes `completed` and its signed copy is collected (legal hold).
      const after = await pullAndApply(workspaceId, envelopeId, pre.opened, pre.row.providerRef);
      return { outcome, row: after ?? pre.row };
    }
    const row = await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const locked = await repo.lockById(envelopeId);
      if (locked === undefined || isTerminal(locked.status)) return locked;
      const at = now();
      const updated =
        (await repo.update(envelopeId, {
          status: "voided",
          terminalAt: at,
          nextSyncAt: null,
        })) ?? locked;
      await auditEnvelope(tx, sctx, who, "esign.envelope_voided", updated, {
        from: locked.status,
        reason: reason.slice(0, 200),
      });
      await publishChanged(tx, sctx, updated);
      return updated;
    });
    return { outcome, row };
  }

  // --- jobs --------------------------------------------------------------------------------------

  async function applyState(
    workspaceId: string,
    envelopeId: string,
    state: ESignEnvelopeState,
  ): Promise<ESignEnvelopeRow | undefined> {
    const sctx = sys(workspaceId);
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined) return undefined;
      const at = now();
      if (isTerminal(row.status)) {
        if (row.status === "completed" && row.artifacts === null && row.errorCode === null) {
          await deps.queue.sendInTransaction(
            tx,
            ESIGN_JOBS.collect,
            { workspaceId, envelopeId },
            { idempotencyKey: `esign.collect:${envelopeId}` },
          );
        }
        return row;
      }
      const next = nextEnvelopeStatus(row.status, state.status);
      const signer = state.signers.find((s) => s.signerKey === SIGNER_KEY) ?? state.signers[0];
      const signerStatus = nextSignerStatus(row.signerStatus, signer?.status);
      const changed = next !== row.status;
      const patch: ESignEnvelopePatch = {
        status: next,
        signerStatus,
        errorCode: null,
        errorDetail: null,
      };
      if (isTerminal(next)) {
        patch.terminalAt = at;
        if (next === "completed") {
          patch.completedAt = state.completedAt ?? at;
          patch.nextSyncAt = new Date(at.getTime() + COLLECT_RETRY_MS);
        } else {
          patch.nextSyncAt = null;
        }
        patch.syncAttempts = 0;
      } else if (changed) {
        patch.syncAttempts = 0;
        patch.nextSyncAt = nextSyncAt(at, 0);
      } else {
        patch.syncAttempts = row.syncAttempts + 1;
        patch.nextSyncAt = nextSyncAt(at, row.syncAttempts + 1);
      }
      const updated = (await repo.update(envelopeId, patch)) ?? row;
      if (changed) {
        await auditEnvelope(
          tx,
          sctx,
          { actorKind: "system" },
          "esign.envelope_status_changed",
          updated,
          {
            from: row.status,
            to: next,
            signerStatus: signerStatus ?? null,
          },
        );
        await publishChanged(tx, sctx, updated);
      }
      if (next === "completed") {
        await deps.queue.sendInTransaction(
          tx,
          ESIGN_JOBS.collect,
          { workspaceId, envelopeId },
          { idempotencyKey: `esign.collect:${envelopeId}` },
        );
      }
      return updated;
    });
  }

  /** `status()` outside any tx, then the answer (or the failure) applied under the row lock. */
  async function pullAndApply(
    workspaceId: string,
    envelopeId: string,
    opened: OpenedConnection,
    providerRef: string,
  ): Promise<ESignEnvelopeRow | undefined> {
    let state: ESignEnvelopeState;
    try {
      state = await portOf(opened).status(providerRef);
    } catch (error) {
      const pe = asProviderError(error);
      log("esign.sync_failed", { level: "warn", workspaceId, envelopeId, code: pe.code });
      await applyPullFailure(workspaceId, envelopeId, pe);
      return undefined;
    }
    return applyState(workspaceId, envelopeId, state);
  }

  /** A failed pull: not_found twice → voided; permanent → `error`; transient → back off. */
  async function applyPullFailure(
    workspaceId: string,
    envelopeId: string,
    error: ESignProviderError,
  ): Promise<void> {
    const sctx = sys(workspaceId);
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || isTerminal(row.status)) return;
      const at = now();
      if (error.code === "not_found") {
        // Documenso deletes an envelope on cancel (contract Corrections): an envelope we saw open
        // that the vendor no longer knows is voided — after one confirming pull.
        if (row.errorCode === NOT_FOUND_MARK) {
          const updated =
            (await repo.update(envelopeId, {
              status: "voided",
              terminalAt: at,
              nextSyncAt: null,
              errorCode: null,
              errorDetail: null,
            })) ?? row;
          await auditEnvelope(
            tx,
            sctx,
            { actorKind: "system" },
            "esign.envelope_status_changed",
            updated,
            {
              from: row.status,
              to: "voided",
              providerCode: "not_found",
            },
          );
          await publishChanged(tx, sctx, updated);
        } else {
          await repo.update(envelopeId, {
            errorCode: NOT_FOUND_MARK,
            errorDetail: providerDetail(error),
            nextSyncAt: nextSyncAt(at, 0),
          });
        }
        return;
      }
      if (error.retryable) {
        await repo.update(envelopeId, {
          syncAttempts: row.syncAttempts + 1,
          nextSyncAt: nextSyncAt(at, row.syncAttempts + 1),
        });
        return;
      }
      const updated =
        (await repo.update(envelopeId, {
          status: "error",
          errorCode: error.code,
          errorDetail: providerDetail(error),
          syncAttempts: row.syncAttempts + 1,
          nextSyncAt: nextSyncAt(at, row.syncAttempts + 1),
        })) ?? row;
      if (row.status !== "error") {
        await auditEnvelope(
          tx,
          sctx,
          { actorKind: "system" },
          "esign.envelope_status_changed",
          updated,
          {
            from: row.status,
            to: "error",
            providerCode: error.code,
          },
        );
        await publishChanged(tx, sctx, updated);
      }
    });
  }

  async function expire(
    workspaceId: string,
    envelopeId: string,
    extra: JsonObject = { reason: "sync_window_over" },
  ): Promise<void> {
    const sctx = sys(workspaceId);
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || isTerminal(row.status)) return;
      const updated =
        (await repo.update(envelopeId, {
          status: "expired",
          terminalAt: now(),
          nextSyncAt: null,
        })) ?? row;
      await auditEnvelope(
        tx,
        sctx,
        { actorKind: "system" },
        "esign.envelope_status_changed",
        updated,
        {
          from: row.status,
          to: "expired",
          ...extra,
        },
      );
      await publishChanged(tx, sctx, updated);
    });
  }

  async function runSync(workspaceId: string, envelopeId: string): Promise<void> {
    const sctx = sys(workspaceId);
    const pre = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
      if (row === undefined || row.providerRef === null) return undefined;
      if (isTerminal(row.status)) return { row, opened: undefined };
      const conn = await new ESignConnectionRepo(sctx, tx).byId(row.connectionId);
      if (conn === undefined) return undefined;
      return { row, opened: await openConnection(tx, sctx, conn) };
    });
    if (pre === undefined) return;
    const { row } = pre;
    if (pre.opened === undefined) {
      if (row.status === "completed" && row.artifacts === null && row.errorCode === null) {
        await deps.queue.send(
          ESIGN_JOBS.collect,
          { workspaceId, envelopeId },
          { idempotencyKey: `esign.collect:${envelopeId}` },
        );
      }
      return;
    }
    if (row.providerRef === null) return;
    // An erased signer's envelope that may still be live at the vendor is withdrawn (contract §4
    // erasure) — but only after a pull: a signer who signed before the erasure left a signed
    // record we must keep (legal hold), and voiding without looking loops against a vendor that
    // refuses to void a finished envelope (E3.5 fix A1). `error` rows with a vendor ref count as
    // live (A13).
    const erased = row.signerPseudonymisedAt !== null && isLiveAtVendor(row);
    // Always pull once first (FX2A): the window closing, like an erasure, only decides what to do
    // with an envelope the vendor STILL reports open. One the signer finished at the vendor in the
    // meantime is applied here — a signature completes and is collected, never expired over.
    const after = await pullAndApply(workspaceId, envelopeId, pre.opened, row.providerRef);
    if (erased) {
      if (after !== undefined && isLiveAtVendor(after)) {
        await voidEnvelope(workspaceId, envelopeId, "erasure", { actorKind: "system" });
      }
      return;
    }
    if (!syncWindowOver(row.sentAt, row.createdAt, now())) return;
    if (after === undefined) {
      // The pull failed: nothing learned — the envelope may still be signable at the vendor (R3C).
      // Keep pulling through a grace period (backoff capped so it is retried several times), and
      // only past it expire, after a best-effort void; the audit entry records how that went.
      if (!syncGraceOver(row.sentAt, row.createdAt, now())) {
        await capNextSync(workspaceId, envelopeId);
        return;
      }
      await expireUnseen(workspaceId, envelopeId, pre.opened, row.providerRef);
      return;
    }
    if (!isLiveAtVendor(after)) return;
    await expireOpen(workspaceId, envelopeId, pre.opened, row.providerRef);
  }

  /** Within the post-window grace: the next pull no later than `SYNC_GRACE_MAX_DELAY_MS` away. */
  async function capNextSync(workspaceId: string, envelopeId: string): Promise<void> {
    const sctx = sys(workspaceId);
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || isTerminal(row.status)) return;
      const cap = new Date(now().getTime() + SYNC_GRACE_MAX_DELAY_MS);
      if (row.nextSyncAt === null || row.nextSyncAt.getTime() > cap.getTime()) {
        await repo.update(envelopeId, { nextSyncAt: cap });
      }
    });
    log("esign.sync_window_grace", { level: "warn", workspaceId, envelopeId });
  }

  /**
   * The grace after the sync window ran out and the vendor still cannot be read: withdraw the
   * envelope there if we can (best effort — it may be signable otherwise) and expire it. The audit
   * entry carries the void's outcome (`voided` / `unsupported` / `not_found` / `rejected` / `failed`)
   * so staff can see which envelopes may still be open at the vendor.
   */
  async function expireUnseen(
    workspaceId: string,
    envelopeId: string,
    opened: OpenedConnection,
    providerRef: string,
  ): Promise<void> {
    // The failed pull may itself have settled the row (a confirmed not_found is `voided`).
    const sctx = sys(workspaceId);
    const current = await deps.db.withTenant(sctx, (tx) =>
      new ESignEnvelopeRepo(sctx, tx).byId(envelopeId),
    );
    if (current === undefined || isTerminal(current.status)) return;
    let outcome: string;
    let providerCode: string | undefined;
    if (!opened.adapter.meta.supports.void) {
      outcome = "unsupported";
    } else {
      try {
        await portOf(opened).void(providerRef, "signature request expired");
        outcome = "voided";
      } catch (error) {
        const pe = asProviderError(error);
        providerCode = pe.code;
        outcome = pe.code === "not_found" || pe.code === "rejected" ? pe.code : "failed";
      }
    }
    if (outcome === "rejected") {
      // Terminal at the vendor (finished since): one more look, and apply it if we can read it.
      const after = await pullAndApply(workspaceId, envelopeId, opened, providerRef);
      if (after !== undefined && isTerminal(after.status)) return;
    }
    if (outcome === "failed") {
      log("esign.expire_void_failed", {
        level: "warn",
        workspaceId,
        envelopeId,
        code: providerCode ?? "unknown",
      });
    }
    await expire(workspaceId, envelopeId, {
      reason: "sync_window_over_unreachable",
      void: outcome,
      ...(providerCode === undefined ? {} : { providerCode }),
    });
  }

  /**
   * The sync window closed on an envelope the vendor still reports open: withdraw it at the vendor
   * (so nobody signs a record we no longer follow) and mark it `expired`. A vendor that refuses the
   * void because the envelope finished between the pull and now has its answer pulled and applied.
   */
  async function expireOpen(
    workspaceId: string,
    envelopeId: string,
    opened: OpenedConnection,
    providerRef: string,
  ): Promise<void> {
    try {
      if (opened.adapter.meta.supports.void) {
        await portOf(opened).void(providerRef, "signature request expired");
      }
    } catch (error) {
      const pe = asProviderError(error);
      if (pe.code === "rejected") {
        await pullAndApply(workspaceId, envelopeId, opened, providerRef);
        return;
      }
      if (pe.code !== "not_found") {
        log("esign.expire_void_failed", { level: "warn", workspaceId, envelopeId, code: pe.code });
      }
    }
    await expire(workspaceId, envelopeId);
  }

  async function runVoid(workspaceId: string, envelopeId: string, reason: string): Promise<void> {
    await voidEnvelope(workspaceId, envelopeId, reason, { actorKind: "system" });
  }

  async function collectFailed(
    workspaceId: string,
    envelopeId: string,
    code: string,
    detail: string,
    extra: JsonObject = {},
  ): Promise<void> {
    const sctx = sys(workspaceId);
    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || row.artifacts !== null || row.errorCode !== null) return;
      const updated =
        (await repo.update(envelopeId, {
          errorCode: code,
          errorDetail: detail.slice(0, 500),
          nextSyncAt: null,
        })) ?? row;
      await auditEnvelope(
        tx,
        sctx,
        { actorKind: "system" },
        "esign.envelope_status_changed",
        updated,
        {
          from: row.status,
          to: row.status,
          errorCode: code,
          ...extra,
        },
      );
      // The row stays `completed` (terminal); modules learn the signed copy cannot be collected.
      await publishChanged(tx, sctx, updated, "error");
    });
  }

  async function runCollect(workspaceId: string, envelopeId: string): Promise<void> {
    const sctx = sys(workspaceId);
    const pre = await deps.db.withTenant(sctx, async (tx) => {
      const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
      if (
        row === undefined ||
        row.status !== "completed" ||
        row.artifacts !== null ||
        row.errorCode !== null ||
        row.providerRef === null
      ) {
        return undefined;
      }
      const conn = await new ESignConnectionRepo(sctx, tx).byId(row.connectionId);
      if (conn === undefined) return undefined;
      return { row, opened: await openConnection(tx, sctx, conn) };
    });
    if (pre === undefined || pre.row.providerRef === null) return;

    let arts: { document: Uint8Array; certificate?: Uint8Array | undefined };
    try {
      arts = await portOf(pre.opened).downloadSigned(pre.row.providerRef, {
        maxBytes: deps.maxArtifactBytes,
      });
    } catch (error) {
      const pe = asProviderError(error);
      if (pe.retryable) throw pe;
      await collectFailed(workspaceId, envelopeId, `artifact_${pe.code}`, providerDetail(pe), {
        providerCode: pe.code,
      });
      return;
    }
    const pieces: { which: "signed" | "certificate"; bytes: Uint8Array }[] = [
      { which: "signed", bytes: arts.document },
    ];
    if (arts.certificate !== undefined)
      pieces.push({ which: "certificate", bytes: arts.certificate });
    const total = pieces.reduce((n, p) => n + p.bytes.byteLength, 0);
    if (total > deps.maxArtifactBytes) {
      await collectFailed(
        workspaceId,
        envelopeId,
        "artifact_too_large",
        `artifacts are ${total} bytes, over the ${deps.maxArtifactBytes} limit`,
      );
      return;
    }
    for (const p of pieces) {
      if (!looksLikePdf(p.bytes)) {
        await collectFailed(
          workspaceId,
          envelopeId,
          "artifact_not_pdf",
          `the vendor's ${p.which} artifact is not a PDF`,
          { which: p.which },
        );
        return;
      }
    }
    for (const p of pieces) {
      const verdict = await deps.scanner.scan({ body: p.bytes, size: p.bytes.byteLength });
      if (verdict.verdict === "infected") {
        deps.securityEvent?.("esign_artifact_infected", {
          workspaceId,
          envelopeId,
          which: p.which,
        });
        log("esign.artifact_infected", {
          level: "warn",
          workspaceId,
          envelopeId,
          which: p.which,
          engine: verdict.engine,
        });
        await collectFailed(
          workspaceId,
          envelopeId,
          "artifact_infected",
          `the ${p.which} artifact was flagged by the virus scanner`,
          { which: p.which, engine: verdict.engine },
        );
        return;
      }
      if (verdict.verdict === "error") {
        throw new Error(`virus scan failed for envelope ${envelopeId}; retrying`);
      }
    }

    // DEK in its own short tx; encryption with no transaction open.
    const dek = await deps.db.withTenant(sctx, (tx) =>
      deps.crypto.currentKey(tx, sctx, ESIGN_KEY_PURPOSES.artifact),
    );
    const sealed: {
      which: "signed" | "certificate";
      key: string;
      cipher: Uint8Array;
      stored: ESignStoredArtifact;
    }[] = [];
    for (const p of pieces) {
      const key = esignArtifactKey(workspaceId, envelopeId, p.which);
      const sha256 = createHash("sha256").update(p.bytes).digest("hex");
      const cipher = await encryptBytes(dek.key, p.bytes);
      sealed.push({
        which: p.which,
        key,
        cipher,
        stored: { key, sha256, size: p.bytes.byteLength, keyRef: `she1:${dek.keyId}` },
      });
    }
    const signed = sealed.find((x) => x.which === "signed")?.stored;
    if (signed === undefined) return;
    const certificate = sealed.find((x) => x.which === "certificate")?.stored;
    const artifacts: ESignEnvelopeArtifacts = {
      signed,
      ...(certificate === undefined ? {} : { certificate }),
    };

    await deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const row = await repo.lockById(envelopeId);
      if (row === undefined || row.status !== "completed" || row.artifacts !== null) return;
      // The objects are written only here, under the envelope row lock and only while no
      // artifacts are recorded (E3.5 fix A9): two overlapping collects both download, but only
      // the first to lock the row writes the (fixed) storage keys, and the loser — seeing the
      // artifacts — writes nothing. So the stored bytes always match the recorded sha256. Object
      // storage I/O is not a second pool connection; a failure rolls the row back and the job
      // retries (a later attempt overwrites whatever a failed one left).
      for (const x of sealed) {
        await deps.storage.put(x.key, x.cipher, {
          contentType: "application/octet-stream",
          contentLength: x.cipher.byteLength,
          metadata: {
            "sh-format": "she1",
            "sh-content-type": "application/pdf",
            "sh-sha256": x.stored.sha256,
          },
        });
      }
      const updated =
        (await repo.update(envelopeId, { artifacts, nextSyncAt: null, errorCode: null })) ?? row;
      // The NDA acceptance comes BEFORE this transaction's first audit entry: `accept()` bumps
      // the ACL version (workspace row) and lock order is envelope row → workspace row → audit
      // chain → outbox; auditing first would invert it against every settings writer (A2).
      if (row.purpose === "nda") await settleNda(tx, sctx, updated);
      await auditEnvelope(tx, sctx, { actorKind: "system" }, "esign.envelope_completed", updated, {
        signedSha256: signed.sha256,
        signedSize: signed.size,
        hasCertificate: artifacts.certificate !== undefined,
      });
      await publish(tx, sctx, "esign.envelope_completed", {
        envelopeId: row.id,
        purpose: row.purpose,
        subjectModule: row.subjectModule,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        membershipId: row.membershipId,
      });
    });
  }

  /**
   * A completed NDA envelope closes the member's NDA gate — only when the version it was for is
   * still the document's current one, and the member is live and not erased (a late writer must
   * not recreate an erased member's acceptance, E2.6). Otherwise the gate stays closed and the
   * reason is audited.
   */
  async function settleNda(tx: Tx, sctx: TenantContext, row: ESignEnvelopeRow): Promise<void> {
    if (row.legalDocumentId === null || row.legalVersionNo === null || row.membershipId === null) {
      return;
    }
    const doc = await readLegalDocument(tx, sctx, row.legalDocumentId);
    const member = await new MembershipRepo(sctx, tx).byId(row.membershipId);
    const erased = await deps.legal.isErased(tx, sctx, row.membershipId);
    const current = doc?.current?.versionNo === row.legalVersionNo;
    const live = member !== undefined && member.status !== "revoked";
    // Only an `nda` is ever accepted through a vendor envelope (E3.5 fix A6): a document whose
    // kind changed since the envelope was started (or that never was an NDA) gets no acceptance.
    const nda = doc?.kind === "nda";
    if (!current || !live || erased || !nda) {
      await auditEnvelope(tx, sctx, { actorKind: "system" }, "esign.nda_version_superseded", row, {
        documentId: row.legalDocumentId,
        versionNo: row.legalVersionNo,
        currentVersionNo: doc?.current?.versionNo ?? null,
        reason: !current
          ? "version_superseded"
          : !nda
            ? "not_nda_document"
            : erased
              ? "member_erased"
              : "member_not_live",
      });
      return;
    }
    await deps.acceptances.accept(sctx, tx, {
      membershipId: row.membershipId,
      documentId: row.legalDocumentId,
      versionNo: row.legalVersionNo,
      evidence: { evidenceRef: `esign:v1:${row.id}`, method: "esign" },
    });
  }

  async function sweepWorkspace(workspaceId: string, at: Date): Promise<number> {
    const sctx = sys(workspaceId);
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ESignEnvelopeRepo(sctx, tx);
      const rows = await repo.claimDue(
        at,
        new Date(at.getTime() - STALE_DRAFT_MS),
        ESIGN_SWEEP_BATCH,
      );
      const orphaned: ESignEnvelopeRow[] = [];
      const jobs: { name: string; data: JsonObject; key: string }[] = [];
      const lease = new Date(at.getTime() + CLAIM_LEASE_MS);
      for (const row of rows) {
        const data = { workspaceId, envelopeId: row.id };
        if (row.status === "draft") {
          // The port cannot look an envelope up by our externalId, so an orphaned draft (the
          // process died between the vendor call and tx2) cannot be voided at the vendor; it is
          // marked `error` so staff see it (contract §4 fallback).
          const updated = await repo.update(row.id, {
            status: "error",
            errorCode: "orphaned_draft",
            errorDetail: "the request was interrupted before the vendor's answer was recorded",
            nextSyncAt: null,
          });
          if (updated !== undefined) orphaned.push(updated);
          continue;
        }
        if (row.status === "completed") {
          await repo.update(row.id, { nextSyncAt: new Date(at.getTime() + COLLECT_RETRY_MS) });
          jobs.push({ name: ESIGN_JOBS.collect, data, key: `esign.collect:${row.id}` });
          continue;
        }
        await repo.update(row.id, { nextSyncAt: lease });
        // An erased signer's live envelope goes through `esign.sync` too: the sync pulls first and
        // voids only what is still open at the vendor (E3.5 fix A1).
        jobs.push({ name: ESIGN_JOBS.sync, data, key: `esign.sync:${row.id}` });
      }
      for (const row of orphaned) {
        await auditEnvelope(
          tx,
          sctx,
          { actorKind: "system" },
          "esign.envelope_status_changed",
          row,
          {
            from: "draft",
            to: "error",
            errorCode: "orphaned_draft",
          },
        );
        await publishChanged(tx, sctx, row);
      }
      for (const j of jobs) {
        await deps.queue.sendInTransaction(tx, j.name, j.data, { idempotencyKey: j.key });
      }
      return rows.length;
    });
  }

  async function sweep(): Promise<void> {
    const at = now();
    let claimed = 0;
    for (const workspaceId of await listActiveWorkspaceIds(deps.db)) {
      if (isPlatformWorkspace(workspaceId)) continue;
      try {
        claimed += await sweepWorkspace(workspaceId, at);
      } catch (error) {
        log("esign.sweep_failed", {
          level: "error",
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (claimed > 0) log("esign.swept", { claimed });
  }

  function jobIds(data: JsonObject): { workspaceId: string; envelopeId: string } | undefined {
    const w = data["workspaceId"];
    const e = data["envelopeId"];
    if (typeof w !== "string" || typeof e !== "string" || !isUuid(w) || !isUuid(e))
      return undefined;
    return { workspaceId: w, envelopeId: e };
  }

  const jobs: JobDefinition<JsonObject>[] = [
    {
      name: ESIGN_JOBS.sync,
      queue: { policy: "short", retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true },
      work: { concurrency: 4 },
      handler: async (job) => {
        const ids = jobIds(job.data);
        if (ids !== undefined) await runSync(ids.workspaceId, ids.envelopeId);
      },
    },
    {
      name: ESIGN_JOBS.collect,
      queue: { policy: "short", retryLimit: 6, retryDelaySeconds: 60, retryBackoff: true },
      work: { concurrency: 2 },
      handler: async (job) => {
        const ids = jobIds(job.data);
        if (ids !== undefined) await runCollect(ids.workspaceId, ids.envelopeId);
      },
    },
    {
      name: ESIGN_JOBS.void,
      queue: { policy: "short", retryLimit: 8, retryDelaySeconds: 60, retryBackoff: true },
      work: { concurrency: 2 },
      handler: async (job) => {
        const ids = jobIds(job.data);
        if (ids === undefined) return;
        const reason = typeof job.data["reason"] === "string" ? job.data["reason"] : "voided";
        await runVoid(ids.workspaceId, ids.envelopeId, reason);
      },
    },
    {
      name: ESIGN_JOBS.syncDue,
      cron: ESIGN_SYNC_DUE_CRON,
      queue: { policy: "singleton", retryLimit: 0 },
      handler: async () => {
        await sweep();
      },
    },
  ];

  // --- the service ------------------------------------------------------------------------------

  async function readRow(sctx: TenantContext, envelopeId: string): Promise<ESignEnvelopeRow> {
    if (!isUuid(envelopeId)) throw new ESignError("not_found", "no such envelope");
    const row = await deps.db.withTenant(sctx, (tx) =>
      new ESignEnvelopeRepo(sctx, tx).byId(envelopeId),
    );
    if (row === undefined) throw new ESignError("not_found", "no such envelope");
    return row;
  }

  async function readArtifactBytes(
    workspaceId: string,
    row: ESignEnvelopeRow,
    which: "signed" | "certificate",
    tx: Tx,
    sctx: TenantContext,
  ): Promise<(() => Promise<Uint8Array | undefined>) | undefined> {
    if (row.status !== "completed" || row.artifacts === null) return undefined;
    const art = which === "signed" ? row.artifacts.signed : row.artifacts.certificate;
    if (art === undefined) return undefined;
    const keyId = art.keyRef.startsWith("she1:") ? art.keyRef.slice(5) : art.keyRef;
    const dek = await deps.crypto.keyById(tx, sctx, keyId);
    if (dek === undefined) return undefined;
    // The stored key is rebuilt from the workspace and envelope ids, never taken from the row
    // verbatim (an imported/copied row must not point at another tenant's object).
    const key = esignArtifactKey(workspaceId, row.id, which);
    return async () => {
      const read = await deps.storage.get(key);
      if (read === undefined) return undefined;
      return streamToBytes(decryptStream(dek.key, read.body));
    };
  }

  /**
   * Re-reads a `draft` envelope until its creating request has recorded the vendor's answer
   * (bounded), then returns it; still a draft → 409 `conflict` reason `envelope_creating` (the
   * portal retries). Each read is its own short tx; nothing is held while waiting.
   */
  async function awaitDraft(sctx: TenantContext, row: ESignEnvelopeRow): Promise<ESignEnvelopeRow> {
    const deadline = Date.now() + DRAFT_WAIT_MS;
    let current = row;
    while (current.status === "draft" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAFT_POLL_MS));
      current =
        (await deps.db.withTenant(sctx, (tx) => new ESignEnvelopeRepo(sctx, tx).byId(row.id))) ??
        current;
    }
    if (current.status === "draft") {
      throw new ESignError("conflict", "this envelope is still being created; try again shortly", {
        reason: "envelope_creating",
        envelopeId: current.id,
      });
    }
    return current;
  }

  const service: ESignKernel = {
    async connection(tx, ctx) {
      const row = await new ESignConnectionRepo(ctx, tx).live();
      return row === undefined ? undefined : summaryOf(row);
    },

    async request(ctx, input: ESignRequestInput) {
      if (input.purpose !== "round_closing") {
        throw new ESignError(
          "validation_failed",
          "only round_closing envelopes are requested here",
          {
            reason: "invalid_purpose",
          },
        );
      }
      if (
        !/^[a-z][a-z0-9-]{0,63}$/u.test(input.subject.module) ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(input.subject.kind) ||
        !isUuid(input.subject.id)
      ) {
        throw new ESignError("validation_failed", "invalid subject", { reason: "invalid_subject" });
      }
      const signer = checkSigner(input.signer);
      const vaultFolder = input.vaultFolder?.trim();
      const role = input.signer.role;
      const row = await createEnvelope(
        ctx,
        {
          purpose: "round_closing",
          subject: input.subject,
          signer: {
            ...signer,
            ...(input.signer.membershipId === undefined
              ? {}
              : { membershipId: input.signer.membershipId }),
            ...(role !== undefined && role.trim() !== ""
              ? { role: role.trim().slice(0, 100) }
              : {}),
          },
          title: checkTitle(input.title),
          ...(input.message === undefined ? {} : { message: input.message.slice(0, 2000) }),
          document: input.document,
          ...(vaultFolder === undefined || vaultFolder === ""
            ? {}
            : { vaultFolder: vaultFolder.slice(0, 500) }),
          embedded: input.embedded,
          requestedByMembershipId: input.requestedByMembershipId,
        },
        { membershipId: input.requestedByMembershipId },
      );
      return toEnvelopeView(row);
    },

    async get(tx, ctx, envelopeId) {
      if (!isUuid(envelopeId)) return undefined;
      const row = await new ESignEnvelopeRepo(ctx, tx).byId(envelopeId);
      return row === undefined ? undefined : toEnvelopeView(row);
    },

    async signingUrl(ctx, envelopeId, membershipId, returnUrl) {
      const sctx = sys(ctx);
      const pre = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
        if (row === undefined || row.membershipId === null || row.membershipId !== membershipId) {
          throw new ESignError("not_found", "no such envelope");
        }
        if (!isOpen(row.status)) {
          throw new ESignError("envelope_not_open", "this envelope is no longer open", {
            status: row.status,
          });
        }
        if (!row.embedded || row.providerRef === null) return { row, opened: undefined };
        const conn = await new ESignConnectionRepo(sctx, tx).byId(row.connectionId);
        return {
          row,
          opened: conn === undefined ? undefined : await openConnection(tx, sctx, conn),
        };
      });
      if (pre.opened === undefined || pre.row.providerRef === null) return undefined;
      try {
        return await portOf(pre.opened).signingUrl(pre.row.providerRef, SIGNER_KEY, returnUrl);
      } catch (error) {
        const pe = asProviderError(error);
        throw new ESignError("esign_provider_error", pe.message.slice(0, 300), {
          providerCode: pe.code,
        });
      }
    },

    async void(ctx, envelopeId, reason, actorMembershipId) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const row = await readRow(sctx, envelopeId);
      if (isTerminal(row.status)) {
        throw new ESignError("envelope_not_open", "this envelope is no longer open", {
          status: row.status,
        });
      }
      const who = actorAudit(ctx, { membershipId: actorMembershipId });
      if (
        row.providerRef === null &&
        row.status === "draft" &&
        now().getTime() - row.createdAt.getTime() < STALE_DRAFT_MS
      ) {
        // The vendor call may still be in flight; voiding now would orphan what it creates.
        throw new ESignError(
          "conflict",
          "this envelope is still being created; try again shortly",
          {
            reason: "envelope_creating",
          },
        );
      }
      if (row.providerRef === null) {
        // A stale draft or a failed create: nothing exists at the vendor that we know of.
        return deps.db.withTenant(sctx, async (tx) => {
          const repo = new ESignEnvelopeRepo(sctx, tx);
          const locked = await repo.lockById(envelopeId);
          if (locked === undefined) throw new ESignError("not_found", "no such envelope");
          if (isTerminal(locked.status) || locked.providerRef !== null) {
            throw new ESignError("envelope_not_open", "this envelope changed; try again", {
              status: locked.status,
            });
          }
          const updated =
            (await repo.update(envelopeId, {
              status: "voided",
              terminalAt: now(),
              nextSyncAt: null,
            })) ?? locked;
          await auditEnvelope(tx, sctx, who, "esign.envelope_voided", updated, {
            from: locked.status,
            reason: reason.slice(0, 200),
          });
          await publishChanged(tx, sctx, updated);
          return toEnvelopeView(updated);
        });
      }
      let result: Awaited<ReturnType<typeof voidEnvelope>>;
      try {
        result = await voidEnvelope(ctx.workspaceId, envelopeId, reason, who);
      } catch (error) {
        const pe = asProviderError(error);
        // Transient: the void job keeps trying; the caller learns it has not happened yet.
        await deps.queue.send(
          ESIGN_JOBS.void,
          { workspaceId: ctx.workspaceId, envelopeId, reason: reason.slice(0, 200) },
          { idempotencyKey: `esign.void:${envelopeId}` },
        );
        throw new ESignError("esign_provider_error", pe.message.slice(0, 300), {
          providerCode: pe.code,
          retrying: true,
        });
      }
      if (result.outcome === "terminal_at_vendor") {
        throw new ESignError(
          "envelope_not_open",
          "the vendor says this envelope is already finished; its status is being refreshed",
          { status: result.row?.status ?? row.status },
        );
      }
      const after = result.row ?? (await readRow(sctx, envelopeId));
      return toEnvelopeView(after);
    },

    async readArtifact(ctx, envelopeId, which) {
      if (!isUuid(envelopeId)) return undefined;
      const sctx = sys(ctx);
      const read = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
        if (row === undefined) return undefined;
        return readArtifactBytes(ctx.workspaceId, row, which, tx, sctx);
      });
      return read === undefined ? undefined : read();
    },

    drivers() {
      return (Object.keys(deps.adapters) as ESignDriver[])
        .filter((d) => offered.has(d))
        .map((d) => {
          const a = adapterOf(d);
          return { meta: a.meta, credentialFields: a.credentialFields };
        });
    },

    async connectionDetail(ctx) {
      const sctx = sys(ctx);
      const row = await deps.db.withTenant(sctx, (tx) => new ESignConnectionRepo(sctx, tx).live());
      return row === undefined ? undefined : detailOf(row);
    },

    async saveConnection(ctx, input, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      if (deps.adapters[input.driver] === undefined) {
        throw new ESignError("validation_failed", "that e-signature provider is not offered here", {
          reason: "driver_not_offered",
          field: "driver",
        });
      }
      const adapter = adapterOf(input.driver);
      const rawBase = input.baseUrl?.trim() ?? "";
      if (rawBase !== "" && !adapter.meta.selfHostable) {
        throw new ESignError(
          "validation_failed",
          `${adapter.meta.displayName} has a fixed address`,
          {
            reason: "base_url_not_supported",
            field: "baseUrl",
          },
        );
      }
      const typedBase = rawBase === "" ? undefined : checkBaseUrl(rawBase, deps.outbound.assess);

      // What is stored now (same driver: blank secrets keep their stored value).
      const previous = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignConnectionRepo(sctx, tx).live();
        if (row === undefined || row.driver !== input.driver) return undefined;
        return openConnection(tx, sctx, row);
      });
      // A-3: a new connection or a driver switch needs the plan's feature; refused before the
      // vendor is asked anything (re-checked under the lock below).
      if (previous === undefined) input.assertMayConnect?.();
      // FX2A: on a same-driver save a blank or omitted base URL KEEPS the stored one (the screen
      // only ever shows its host, so it cannot be pre-filled) — re-keying or changing a plain field
      // needs no retyping. A typed URL that differs is a change (A4 re-enter secrets, A10 open
      // envelopes). Moving a self-hosted connection to the vendor's cloud means typing that URL.
      const baseUrl = typedBase ?? previous?.config.baseUrl;
      if (baseUrl === undefined && adapter.meta.baseUrl.required) {
        throw new ESignError("validation_failed", "the base URL is required", {
          reason: "base_url_required",
          field: "baseUrl",
        });
      }
      // A driver the operator no longer offers (`ESIGN_DRIVERS`) cannot be connected or switched
      // to, but the live connection on it can still be re-keyed (E3.5 fix A14): refusing a
      // credential rotation would leave a leaked key in use until every envelope is finished.
      if (!offered.has(input.driver) && previous === undefined) {
        throw new ESignError("validation_failed", "that e-signature provider is not offered here", {
          reason: "driver_not_offered",
          field: "driver",
        });
      }
      const clear = [...new Set(input.clearCredentials ?? [])];
      // E3.5 fix A4: a stored secret is only ever sent to the base URL it was typed for. When the
      // (normalised) base URL changes, every stored secret/pem must be typed again — or cleared.
      const baseChanged = previous !== undefined && previous.config.baseUrl !== baseUrl;
      if (baseChanged) {
        const fields = secretsToReenter(
          adapter.credentialFields,
          input.credentials,
          previous.config.credentials,
          clear,
        );
        if (fields.length > 0) {
          throw new ESignError(
            "esign_credentials_required",
            "the base URL changed: enter the secrets again for the new address (leave the base URL blank to keep the current one)",
            { reason: "base_url_changed", fields },
          );
        }
      }
      const credentials = checkCredentials(
        adapter.credentialFields,
        input.credentials,
        baseChanged ? undefined : previous?.config.credentials,
        clear,
      );
      const minted =
        adapter.meta.callbackSecret === "ours" && previous?.config.callbackSecret === undefined
          ? mintCallbackSecret()
          : undefined;
      const callbackSecret =
        adapter.meta.callbackSecret === "ours"
          ? (previous?.config.callbackSecret ?? minted)
          : undefined;

      // Live verification before anything is committed, with no transaction open.
      const config: ESignConnectionConfig = {
        credentials,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(callbackSecret === undefined ? {} : { callbackSecret }),
      };
      let verdict: Awaited<ReturnType<ESignPort["verifyCredentials"]>>;
      try {
        verdict = await adapter.create(config, adapterDeps).verifyCredentials();
      } catch (error) {
        const pe = asProviderError(error);
        verdict = {
          ok: false,
          reason: pe.code === "unauthorized" ? "unauthorized" : "unreachable",
          detail: pe.message.slice(0, 200),
        };
      }
      if (!verdict.ok) {
        throw new ESignError(
          "esign_credentials_rejected",
          `${adapter.meta.displayName} did not accept these settings`,
          {
            reason: verdict.reason,
            ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
          },
        );
      }

      const at = now();
      const saved = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new ESignConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        // A-3, authoritative: judged on the locked row (a concurrent delete or switch since the
        // pre-check turns this save into a new connection).
        if (live === undefined || live.driver !== input.driver) input.assertMayConnect?.();
        const creds = await seal(tx, sctx, JSON.stringify(credentials));
        const base = baseUrl === undefined ? undefined : await seal(tx, sctx, baseUrl);
        // Re-read under the lock: another save may have landed since `previous` was read.
        let secret = callbackSecret;
        let shown = minted;
        if (
          live !== undefined &&
          live.driver === input.driver &&
          adapter.meta.callbackSecret === "ours"
        ) {
          const stored = await unseal(
            tx,
            sctx,
            (live.encryption as ESignConnectionEncryption).callbackSecret,
            live.callbackSecretEnc,
          );
          if (stored !== undefined) {
            secret = stored;
            shown = stored === minted ? minted : undefined;
          }
        }
        const sealedSecret = secret === undefined ? undefined : await seal(tx, sctx, secret);
        const encryption: ESignConnectionEncryption = {
          credentials: creds.ref,
          ...(base === undefined ? {} : { baseUrl: base.ref }),
          ...(sealedSecret === undefined ? {} : { callbackSecret: sealedSecret.ref }),
        };
        const values = {
          baseUrlEnc: base?.enc ?? null,
          baseUrlHost: baseUrl === undefined ? null : baseUrlHost(baseUrl),
          credentialsEnc: creds.enc,
          callbackSecretEnc: sealedSecret?.enc ?? null,
          encryption,
          credentialHints: credentialHints(adapter.credentialFields, credentials),
          status: "active" as const,
          lastVerifiedAt: at,
          lastError: null,
        };
        let row: ESignConnectionRow;
        let replaced = false;
        if (live !== undefined && live.driver === input.driver) {
          // E3.5 fix A10: an open envelope keeps talking to its connection row; pointing that row
          // at another address mid-flight would pull, void and collect against the wrong host.
          const storedBase = await unseal(
            tx,
            sctx,
            (live.encryption as ESignConnectionEncryption).baseUrl,
            live.baseUrlEnc,
          );
          if (storedBase !== baseUrl && (await conns.countOpenEnvelopes(live.id)) > 0) {
            throw new ESignError(
              "envelopes_open",
              "finish or void the open envelopes before changing the provider's address",
              { reason: "base_url_changed" },
            );
          }
          row = (await conns.update(live.id, values)) ?? live;
        } else {
          if (!offered.has(input.driver)) {
            throw new ESignError(
              "validation_failed",
              "that e-signature provider is not offered here",
              { reason: "driver_not_offered", field: "driver" },
            );
          }
          if (live !== undefined) {
            if ((await conns.countOpenEnvelopes(live.id)) > 0) {
              throw new ESignError(
                "envelopes_open",
                "finish or void the open envelopes before switching provider",
              );
            }
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
          action: "esign.connection_saved",
          resourceKind: "esign_connection",
          resourceId: row.id,
          meta: {
            driver: row.driver,
            replaced,
            previousDriver: live?.driver ?? null,
            baseUrlHost: row.baseUrlHost,
            fields: Object.keys(credentials).sort(),
            ...(clear.length === 0 ? {} : { cleared: clear.sort() }),
            callbackSecretIssued: shown !== undefined,
          },
        });
        return { row, shown };
      });
      return {
        connection: detailOf(saved.row),
        ...(saved.shown === undefined ? {} : { callbackSecret: saved.shown }),
      };
    },

    async verifyConnection(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const opened = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignConnectionRepo(sctx, tx).live();
        return row === undefined ? undefined : openConnection(tx, sctx, row);
      });
      if (opened === undefined) {
        throw new ESignError("esign_not_configured", "no e-signature provider is connected");
      }
      let verdict: Awaited<ReturnType<ESignPort["verifyCredentials"]>>;
      try {
        verdict = await portOf(opened).verifyCredentials();
      } catch (error) {
        const pe = asProviderError(error);
        verdict = {
          ok: false,
          reason: pe.code === "unauthorized" ? "unauthorized" : "unreachable",
          detail: pe.message.slice(0, 200),
        };
      }
      const at = now();
      const row = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new ESignConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined || live.id !== opened.row.id) {
          throw new ESignError("conflict", "the connection changed; try again", {
            reason: "connection_changed",
          });
        }
        const lastError = verdict.ok
          ? null
          : `${verdict.reason}${verdict.detail === undefined ? "" : `: ${verdict.detail}`}`.slice(
              0,
              500,
            );
        const updated =
          (await conns.update(live.id, {
            status: verdict.ok ? "active" : "error",
            lastVerifiedAt: at,
            lastError,
          })) ?? live;
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "esign.connection_verified",
          resourceKind: "esign_connection",
          resourceId: live.id,
          ...(verdict.ok ? {} : { outcome: "failure" as const }),
          meta: { driver: live.driver, ok: verdict.ok, reason: verdict.ok ? null : verdict.reason },
        });
        return updated;
      });
      return detailOf(row);
    },

    async rotateCallbackSecret(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const secret = mintCallbackSecret();
      const row = await deps.db.withTenant(sctx, async (tx) => {
        const conns = new ESignConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined) {
          throw new ESignError("esign_not_configured", "no e-signature provider is connected");
        }
        if (adapterOf(live.driver).meta.callbackSecret !== "ours") {
          throw new ESignError(
            "conflict",
            "this provider generates its own callback secret; change it in the connection form",
            { reason: "vendor_secret" },
          );
        }
        const sealed = await seal(tx, sctx, secret);
        const encryption: ESignConnectionEncryption = {
          ...(live.encryption as ESignConnectionEncryption),
          callbackSecret: sealed.ref,
        };
        const updated =
          (await conns.update(live.id, { callbackSecretEnc: sealed.enc, encryption })) ?? live;
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "esign.callback_secret_rotated",
          resourceKind: "esign_connection",
          resourceId: live.id,
          meta: { driver: live.driver },
        });
        return updated;
      });
      return { connection: detailOf(row), callbackSecret: secret };
    },

    async deleteConnection(ctx, actor) {
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      await deps.db.withTenant(sctx, async (tx) => {
        const conns = new ESignConnectionRepo(sctx, tx);
        await conns.lockSingleton();
        const live = await conns.liveForUpdate();
        if (live === undefined) {
          throw new ESignError("esign_not_configured", "no e-signature provider is connected");
        }
        if ((await conns.countEsignCeremonyDocuments()) > 0) {
          throw new ESignError(
            "esign_ceremony_in_use",
            "a legal document is signed through e-signature; switch it to click-wrap first",
          );
        }
        if ((await conns.countOpenEnvelopes(live.id)) > 0) {
          throw new ESignError("envelopes_open", "finish or void the open envelopes first");
        }
        await conns.update(live.id, { deletedAt: now() });
        await deps.audit.record(tx, sctx, {
          ...actorAudit(ctx, actor),
          action: "esign.connection_deleted",
          resourceKind: "esign_connection",
          resourceId: live.id,
          meta: { driver: live.driver },
        });
      });
    },

    async listEnvelopes(ctx, query) {
      const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
      let before: { createdAt: Date; id: string } | undefined;
      if (query.cursor !== undefined && query.cursor !== "") {
        before = decodeEnvelopeCursor(query.cursor);
        if (before === undefined) {
          throw new ESignError("validation_failed", "bad cursor", { reason: "invalid_cursor" });
        }
      }
      const rows = await deps.db.withTenant(ctx, (tx) =>
        new ESignEnvelopeRepo(ctx, tx).page({
          status: query.status,
          purpose: query.purpose,
          membershipId: query.membershipId,
          before,
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toEnvelopeView),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeEnvelopeCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },

    async downloadArtifact(ctx, envelopeId, which, actor, options) {
      if (!isUuid(envelopeId)) return undefined;
      refuseViewAs(ctx);
      const sctx = sys(ctx);
      const pre = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignEnvelopeRepo(sctx, tx).byId(envelopeId);
        if (row === undefined) return undefined;
        if (
          options?.ownMembershipId !== undefined &&
          row.membershipId !== options.ownMembershipId
        ) {
          return undefined;
        }
        const read = await readArtifactBytes(ctx.workspaceId, row, which, tx, sctx);
        return read === undefined ? undefined : { row, read };
      });
      if (pre === undefined) return undefined;
      const bytes = await pre.read();
      if (bytes === undefined) return undefined;
      await deps.db.withTenant(sctx, (tx) =>
        auditEnvelope(tx, sctx, actorAudit(ctx, actor), "esign.artifact_downloaded", pre.row, {
          which,
          own: options?.ownMembershipId !== undefined,
        }),
      );
      return { bytes, filename: `${slugForFile(pre.row.title)}-${which}.pdf` };
    },

    async requestSync(ctx, envelopeId, actor) {
      const sctx = sys(ctx);
      const row = await readRow(sctx, envelopeId);
      void actor;
      if (row.status === "completed" && row.artifacts === null) {
        // A manual resync retries a failed collection (except an infected artifact).
        if (row.errorCode !== null && row.errorCode !== "artifact_infected") {
          await deps.db.withTenant(sctx, async (tx) => {
            const repo = new ESignEnvelopeRepo(sctx, tx);
            const locked = await repo.lockById(envelopeId);
            if (locked?.artifacts === null && locked.errorCode !== "artifact_infected") {
              await repo.update(envelopeId, { errorCode: null, errorDetail: null });
            }
          });
        }
        await deps.queue.send(
          ESIGN_JOBS.collect,
          { workspaceId: ctx.workspaceId, envelopeId },
          { idempotencyKey: `esign.collect:${envelopeId}` },
        );
      } else if (row.providerRef !== null && !isTerminal(row.status)) {
        await deps.queue.send(
          ESIGN_JOBS.sync,
          { workspaceId: ctx.workspaceId, envelopeId },
          { idempotencyKey: `esign.sync:${envelopeId}` },
        );
      }
      return toEnvelopeView(await readRow(sctx, envelopeId));
    },

    async startNda(ctx, input, actor) {
      refuseViewAs(ctx);
      if (
        !input.consentToElectronicRecords ||
        input.disclosureVersion !== ESIGN_DISCLOSURE_VERSION
      ) {
        throw new ESignError(
          "esign_consent_required",
          "consent to electronic records and signatures is required",
          { disclosureVersion: ESIGN_DISCLOSURE_VERSION },
        );
      }
      if (!isUuid(input.documentId) || !isUuid(input.membershipId)) {
        throw new ESignError("not_found", "no such legal document");
      }
      const sctx = sys(ctx);
      const who = actorAudit(ctx, actor);
      const prep = await deps.db.withTenant(sctx, async (tx) => {
        const doc = await readLegalDocument(tx, sctx, input.documentId);
        if (doc?.current === undefined) {
          throw new ESignError("not_found", "no such legal document");
        }
        if (doc.ceremony !== "esign") {
          throw new ESignError("conflict", "this document is accepted by click-wrap", {
            reason: "not_esign_ceremony",
          });
        }
        // The e-sign ceremony is for NDAs only (E3.5 fix A6).
        if (doc.kind !== "nda") {
          throw new ESignError("conflict", "only an NDA can be signed electronically", {
            reason: "not_nda_document",
          });
        }
        // Never sign a PDF whose text differs from the legal text (A15).
        assertNdaTextRenderable({ title: doc.title, body: doc.current.body });
        const conn = await new ESignConnectionRepo(sctx, tx).live();
        if (conn === undefined) {
          throw new ESignError("esign_not_configured", "no e-signature provider is connected");
        }
        const members = new MembershipRepo(sctx, tx);
        const member = await members.byId(input.membershipId);
        if (member === undefined || member.status === "revoked") {
          throw new ESignError("not_found", "no such member");
        }
        if (await deps.legal.isErased(tx, sctx, input.membershipId)) {
          throw new ESignError("conflict", "that member's data has been erased", {
            reason: "signer_erased",
          });
        }
        // Only a document the member must still accept (E3.5 fix A7): the one predicate the
        // gates endpoint uses too — in their pending set, or named by a live `nda` gate that
        // applies to them and that they have not satisfied.
        if (
          !(await deps.acceptances.isPendingFor(
            sctx,
            tx,
            { id: member.id, kind: member.kind },
            doc.id,
          ))
        ) {
          throw new ESignError("conflict", "this document is not waiting for your signature", {
            reason: "not_pending",
          });
        }
        const names = (await members.namesFor([input.membershipId])).get(input.membershipId);
        const email = names?.email ?? null;
        if (email === null) {
          throw new ESignError("validation_failed", "your account has no email address", {
            reason: "signer_email_missing",
          });
        }
        const at = now();
        const attestations = new AttestationRepo(sctx, tx);
        if (
          (await attestations.current(input.membershipId, ESIGN_CONSENT_KIND, at)) === undefined
        ) {
          const att = await attestations.record({
            membershipId: input.membershipId,
            kind: ESIGN_CONSENT_KIND,
            signedAt: at,
            data: { ...consentData() },
            evidenceRef: null,
          });
          await deps.audit.record(tx, sctx, {
            ...who,
            action: "esign.consent_recorded",
            resourceKind: "esign_envelope",
            resourceId: null,
            subjectMembershipId: input.membershipId,
            meta: {
              attestationId: att.id,
              disclosureVersion: ESIGN_DISCLOSURE_VERSION,
              disclosureSha256: ESIGN_DISCLOSURE_SHA256,
            },
          });
        }
        const open = await new ESignEnvelopeRepo(sctx, tx).openNda(
          input.membershipId,
          doc.id,
          doc.current.versionNo,
        );
        return {
          doc,
          current: doc.current,
          open,
          signerName:
            names?.displayName !== undefined && names.displayName.trim() !== ""
              ? names.displayName.trim()
              : email,
          email,
          workspaceName: await readWorkspaceName(tx, sctx),
          embedded: adapterOf(conn.driver).meta.supports.embeddedSigning,
        };
      });

      let row = prep.open;
      if (row === undefined) {
        const pdf = await renderNdaPdf({
          title: prep.doc.title,
          versionNo: prep.current.versionNo,
          body: prep.current.body,
          bodySha256: prep.current.bodySha256,
          workspaceName: prep.workspaceName,
          signerName: prep.signerName,
          renderedAt: now(),
        });
        const versionNo = prep.current.versionNo;
        row = await createEnvelope(
          ctx,
          {
            purpose: "nda",
            subject: { module: "compliance", kind: "legal_document", id: prep.doc.id },
            signer: {
              name: prep.signerName.slice(0, 300),
              email: prep.email,
              membershipId: input.membershipId,
            },
            title: `${prep.doc.title} (v${versionNo})`.slice(0, TITLE_MAX),
            document: {
              kind: "pdf",
              filename: `${slugForFile(prep.doc.title)}-v${versionNo}.pdf`,
              bytes: pdf.bytes,
              fields: pdf.fields,
            },
            vaultFolder: NDA_VAULT_FOLDER,
            embedded: prep.embedded,
            ...(prep.embedded ? { redirectUrl: input.returnUrl } : {}),
            requestedByMembershipId: input.membershipId,
            legal: { documentId: prep.doc.id, versionNo },
            dedupe: (repo) => repo.openNda(input.membershipId, prep.doc.id, versionNo),
            // The per-member budget (A7), counted only for a NEW envelope, after the pending
            // check: a vendor envelope and a rendered PDF per click is a cost to cap.
            guard: async (repo) => {
              const at = now();
              const since = new Date(at.getTime() - NDA_START_WINDOW_MS);
              const used = await repo.ndaStartsSince(input.membershipId, since);
              if (used.n >= NDA_START_BUDGET) {
                const frees = (used.oldest?.getTime() ?? at.getTime()) + NDA_START_WINDOW_MS;
                throw new ESignError("rate_limited", "too many signing requests; try again later", {
                  reason: "nda_start_budget",
                  retryAfterSeconds: Math.max(1, Math.ceil((frees - at.getTime()) / 1000)),
                });
              }
            },
          },
          actor,
        );
      }
      // A concurrent start of the same NDA returns the other request's row, which may still be
      // a `draft` while its vendor call is in flight (A8): wait for it briefly, then say so.
      if (row.status === "draft") row = await awaitDraft(sctx, row);
      let signingUrl: string | null = null;
      if (row.embedded && isOpen(row.status)) {
        try {
          signingUrl =
            (await service.signingUrl(ctx, row.id, input.membershipId, input.returnUrl)) ?? null;
        } catch (error) {
          log("esign.signing_url_failed", {
            level: "warn",
            workspaceId: ctx.workspaceId,
            envelopeId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { envelope: toEnvelopeView(row), signingUrl };
    },

    async ndaStatus(ctx, membershipId, documentId) {
      if (!isUuid(membershipId) || !isUuid(documentId)) return { status: "none", envelopeId: null };
      const sctx = sys(ctx);
      return deps.db.withTenant(sctx, async (tx) => {
        const doc = await readLegalDocument(tx, sctx, documentId);
        const rows = await new ESignEnvelopeRepo(sctx, tx).ndasFor(membershipId, documentId);
        const current = doc?.current;
        // "completed" means the acceptance is on record (the gate is open), not merely that the
        // vendor finished: until collect has written it the portal keeps showing "open".
        const accepted =
          doc !== undefined && current !== undefined
            ? (await new AttestationRepo(sctx, tx).current(
                membershipId,
                `${doc.slug}:v${current.versionNo}`,
                now(),
              )) !== undefined
            : false;
        return ndaStatusOf(rows, current?.versionNo, accepted);
      });
    },

    async assertCeremonyAllowed(tx, ctx) {
      await assertESignConnected(tx, ctx);
    },

    async ingestCallback(connectionId, request, options) {
      if (!isUuid(connectionId)) return { status: 404 };
      const hit = await deps.db.withHost((tx) => findConnectionForCallback(tx, connectionId));
      if (hit === undefined) return { status: 404 };
      const sctx = sys(hit.workspaceId);
      const opened = await deps.db.withTenant(sctx, async (tx) => {
        const row = await new ESignConnectionRepo(sctx, tx).byId(connectionId);
        if (row === undefined || row.deletedAt !== null) return undefined;
        return openConnection(tx, sctx, row);
      });
      if (opened === undefined) return { status: 404 };
      let parsed: Awaited<ReturnType<ESignPort["parseCallback"]>>;
      try {
        parsed = await opened.adapter.create(opened.config, adapterDeps).parseCallback(request);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) return { status: 401, driver: hit.driver };
      // The route's global budget, spent only by authenticated callbacks and before any DB work
      // they cause (E2.6: rate-limit provider webhooks after authentication).
      if (options?.admit !== undefined && !options.admit())
        return { status: 429, driver: hit.driver };
      const envelope = await deps.db.withTenant(sctx, (tx) =>
        new ESignEnvelopeRepo(sctx, tx).forCallback(connectionId, {
          providerRef: parsed.providerRef,
          externalId: parsed.externalId,
        }),
      );
      if (envelope !== undefined) {
        const collect = envelope.status === "completed" && envelope.artifacts === null;
        if (collect || !isTerminal(envelope.status)) {
          const name = collect ? ESIGN_JOBS.collect : ESIGN_JOBS.sync;
          await deps.queue.send(
            name,
            { workspaceId: hit.workspaceId, envelopeId: envelope.id },
            { idempotencyKey: `${name}:${envelope.id}` },
          );
        }
      }
      log("esign.callback", {
        workspaceId: hit.workspaceId,
        driver: hit.driver,
        event: parsed.event.slice(0, 64),
        matched: envelope !== undefined,
      });
      return { status: 200, driver: hit.driver };
    },

    async onDocumentVaulted(tx, ctx, payload) {
      if (!isUuid(payload.envelopeId) || !isUuid(payload.documentId)) return;
      const repo = new ESignEnvelopeRepo(ctx, tx);
      const row = await repo.lockById(payload.envelopeId);
      if (row === undefined || row.vaultedDocumentId !== null) return;
      await repo.update(row.id, { vaultedDocumentId: payload.documentId });
    },

    async subjectArtifacts(workspaceId, membershipId) {
      const sctx = sys(workspaceId);
      const readers = await deps.db.withTenant(sctx, async (tx) => {
        const rows = await new ESignEnvelopeRepo(sctx, tx).ofMember(
          membershipId,
          await emailOf(tx, sctx, membershipId),
        );
        const out: { name: string; read: () => Promise<Uint8Array | undefined> }[] = [];
        for (const row of rows) {
          const read = await readArtifactBytes(workspaceId, row, "signed", tx, sctx);
          if (read !== undefined) out.push({ name: `esign/${row.id}-signed.pdf`, read });
        }
        return out;
      });
      const files: Record<string, Uint8Array> = {};
      for (const r of readers) {
        const bytes = await r.read();
        if (bytes !== undefined) files[r.name] = bytes;
      }
      return files;
    },

    jobs,
  };
  return service;
}

/**
 * The NDA gate's view of a member's envelopes for one document (pure; see `ndaStatus`). `rows`
 * newest first. `completed` = the acceptance is on record; `open` = something is in flight (an
 * envelope out for signature, or a signed one whose copy is being collected); `failed` (E3.5 fix
 * A11) = the current version's envelope completed at the vendor but its signed copy could not be
 * collected, and nothing newer is in flight — the member may start again; `superseded` = only an
 * older version's envelope exists.
 */
export function ndaStatusOf(
  rows: readonly Pick<
    ESignEnvelopeRow,
    "id" | "status" | "legalVersionNo" | "artifacts" | "errorCode"
  >[],
  currentVersionNo: number | undefined,
  accepted: boolean,
): { status: NdaStatus; envelopeId: string | null } {
  const forCurrent = rows.filter((r) => r.legalVersionNo === currentVersionNo);
  const completed = forCurrent.filter((r) => r.status === "completed");
  const collected = completed.find((r) => r.artifacts !== null);
  if (accepted && completed.length > 0) {
    return { status: "completed", envelopeId: (collected ?? completed[0])?.id ?? null };
  }
  const open = forCurrent.find((r) => r.status === "draft" || isOpen(r.status));
  if (open !== undefined) return { status: "open", envelopeId: open.id };
  const pending = completed.find((r) => r.artifacts !== null || r.errorCode === null);
  if (pending !== undefined) return { status: "open", envelopeId: pending.id };
  const failed = completed[0];
  if (failed !== undefined) return { status: "failed", envelopeId: failed.id };
  const older = rows.find(
    (r) => r.legalVersionNo !== currentVersionNo && (r.status === "completed" || isOpen(r.status)),
  );
  if (older !== undefined) return { status: "superseded", envelopeId: older.id };
  return { status: "none", envelopeId: null };
}

/** `createESignService(deps).jobs` — the kernel registers these like other kernel jobs. */
export function createESignJobs(deps: ESignServiceDeps): readonly JobDefinition<JsonObject>[] {
  return createESignService(deps).jobs;
}

export type { ESignProviderErrorCode };
