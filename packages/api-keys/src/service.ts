import type { AuditRecorder } from "@fundroom/audit";
import { truncateIp } from "@fundroom/audit";
import {
  type Database,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  type Membership,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { ApiKeyRepo } from "./repos/api-key-repo.js";
import { apiKeyTokenHash, displayPrefix, isPlausibleApiKey, mintApiKeyToken } from "./token.js";
import {
  API_KEY_LAST_USED_THROTTLE_SECONDS,
  API_KEY_MAX_LIFETIME_MS,
  API_KEY_NAME_MAX,
  API_KEY_NOTE_MAX,
  API_KEY_ROTATE_GRACE_DEFAULT_HOURS,
  API_KEY_ROTATE_GRACE_MAX_HOURS,
  API_KEY_SWEEP_CRON,
  API_KEY_SWEEP_JOB,
  type ApiKeyRecord,
  type ApiKeyRevokedReason,
  type ApiKeyView,
  apiKeyStatus,
  MAX_LIVE_API_KEYS,
  toApiKeyView,
} from "./types.js";

/*
 * The API key service (E3.4-A, ADR-0052).
 *
 * A key acts as the member who created it, capped by its scopes. This service owns the row's
 * lifecycle (create, rename, rotate, revoke, sweep, erasure) and the bearer lookup; the HTTP
 * layer (`apps/server`) owns the guards that turn an authenticated key into an admitted request.
 *
 * Lock order on every write path (the E3.3 rule, with the private cap lock in front of the key
 * rows): [cap lock] → key rows (by id) → workspace row → audit chain → outbox (the global rule,
 * E3.5 LX: every audit takes the workspace row FOR NO KEY UPDATE and then the chain, in
 * `lockAuditChain`; nothing here holds the workspace row and then waits for a key row or the
 * cap lock). Create takes the cap lock
 * (`ApiKeyRepo.lockCap`, a private advisory lock — NOT the workspace row, see there); rotate takes
 * the cap lock and then its key row; revoke and rename lock the key row; the sweep locks its
 * candidate key rows before its first audit entry; identity erasure takes the cap lock and the
 * member's key rows before it takes the audit chain (`lockApiKeysOfMember`, via
 * `prelockIdentityErasure` in `@fundroom/compliance`). Nothing here opens a second transaction
 * while holding one.
 *
 * Errors are `ApiKeyError`s carrying an API error code, which the server's error handler adopts
 * as is (`toApiError`), so a refusal here reaches the client with its `reason`.
 */

export type ApiKeyErrorCode = "validation_failed" | "not_found" | "conflict";

export class ApiKeyError extends Error {
  override readonly name = "ApiKeyError";
  constructor(
    readonly code: ApiKeyErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** The membership facts a key's authority is capped by (the creator's CURRENT row). */
export type CreatorFacts = Pick<Membership, "kind" | "role" | "status" | "expiresAt">;

/**
 * A key's creator lends it authority only while they are an active, unexpired staff member.
 * Dormant, suspended, revoked, expired or external (a staff member turned investor) → dead key.
 */
export function creatorIsLive(
  m: Pick<Membership, "kind" | "status" | "expiresAt"> | undefined,
  now: Date,
): boolean {
  return (
    m !== undefined &&
    m.kind === "staff" &&
    m.status === "active" &&
    (m.expiresAt === null || m.expiresAt.getTime() > now.getTime())
  );
}

export interface ApiKeyScopeOption {
  readonly id: string;
  readonly description: string;
}

export interface ApiKeyServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** RBAC on the member's current row (the authz service's `hasPermission`). */
  readonly hasPermission: (membership: CreatorFacts, permission: string) => boolean;
  /**
   * `API_KEY_SCOPES` with their descriptions: every permission some `apiKey: true` route
   * requires (`apiKeyScopes(matrix)`), read per call.
   */
  readonly scopeCatalogue: () => readonly ApiKeyScopeOption[];
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** What the bearer resolver gets back for a usable key. Never the token or its hash. */
export interface AuthenticatedApiKey {
  readonly key: ApiKeyRecord;
  readonly creator: Membership;
}

/** Request facts written to the audit row (never the token). */
export interface ApiKeyRequestMeta {
  /** The session that made the change (every key lifecycle route is session-only). */
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date | null | undefined;
  readonly note?: string | null | undefined;
}

export interface ApiKeyService {
  /**
   * The bearer lookup. `undefined` for a malformed, unknown (including another workspace's),
   * revoked or expired key and for one whose creator is no longer live: the caller answers all of
   * them with the same 401. One indexed statement for every well-formed token.
   */
  authenticate(workspaceId: string, token: string): Promise<AuthenticatedApiKey | undefined>;
  /**
   * Records a use: at most once per 60 s per key (an in-process memo in front of the conditional
   * UPDATE, which is the cross-process throttle). Its own short system transaction, never the
   * handler's. Never throws: a failed write is logged and the request goes on.
   */
  touchLastUsed(workspaceId: string, keyId: string, ip: string | undefined): Promise<void>;
  list(
    ctx: TenantContext,
    query: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<{ items: ApiKeyView[]; nextCursor: string | null }>;
  scopes(actor: CreatorFacts): { id: string; description: string; held: boolean }[];
  create(
    ctx: TenantContext,
    actor: Membership,
    input: CreateApiKeyInput,
    meta?: ApiKeyRequestMeta,
  ): Promise<{ key: ApiKeyView; token: string }>;
  update(
    ctx: TenantContext,
    id: string,
    patch: { readonly name?: string | undefined; readonly note?: string | null | undefined },
    meta?: ApiKeyRequestMeta,
  ): Promise<ApiKeyView>;
  rotate(
    ctx: TenantContext,
    actor: Membership,
    id: string,
    graceHours?: number,
    meta?: ApiKeyRequestMeta,
  ): Promise<{ key: ApiKeyView; token: string; previous: ApiKeyView }>;
  revoke(ctx: TenantContext, id: string, meta?: ApiKeyRequestMeta): Promise<ApiKeyView>;
  /** `api-keys.sweep`: revokes (`creator_inactive`) every key whose creator is not live. */
  sweep(at?: Date): Promise<{ workspaces: number; revoked: number }>;
  readonly jobs: readonly JobDefinition<JsonObject>[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** In-process last-used memo ceiling (cleared when full, like the brand cache). */
const TOUCH_MEMO_MAX = 10_000;

export function encodeApiKeyCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/** Strict: anything that is not exactly what `encodeApiKeyCursor` wrote is refused. */
export function decodeApiKeyCursor(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(raw)) return undefined;
  const id = Buffer.from(raw, "base64url").toString("utf8");
  return UUID_RE.test(id) && encodeApiKeyCursor(id) === raw ? id : undefined;
}

/** Trimmed, empty → null. */
function optionalNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const v = note.trim();
  return v.length === 0 ? null : v;
}

function checkName(name: string): string {
  const v = name.trim();
  if (v.length < 1 || v.length > API_KEY_NAME_MAX)
    throw new ApiKeyError("validation_failed", `name must be 1..${API_KEY_NAME_MAX} characters`, {
      reason: "invalid_name",
    });
  return v;
}

function checkNote(note: string | null | undefined): string | null {
  const v = optionalNote(note);
  if (v !== null && v.length > API_KEY_NOTE_MAX)
    throw new ApiKeyError(
      "validation_failed",
      `note must be at most ${API_KEY_NOTE_MAX} characters`,
      {
        reason: "invalid_note",
      },
    );
  return v;
}

/**
 * Takes the workspace's cap lock and then row-locks one member's unrevoked keys (id order) in the
 * caller's transaction, without changing them. Identity erasure calls this BEFORE it takes the
 * audit chain (key rows are entity rows, and revoke/rotate/rename/sweep lock a key row and then
 * audit), then revokes the keys later under the chain with `revokeApiKeysOfMember`, whose re-lock
 * is then a no-op.
 *
 * Why the cap lock (fix round 2): without it a key minted for the member AFTER the pre-lock but
 * before the transaction reached the chain was not locked; a revoke of that new key (key row →
 * chain) against the identity step (chain → that key row) deadlocked. Every mint (create, rotate)
 * takes the cap lock first, so while the erasure holds it no key can appear for anybody in the
 * workspace. Cap FIRST, then the key rows: rotate also takes the cap before its key row, so the
 * two can never hold one each (a "keys → cap → keys" order would: a key minted between the passes
 * and rotated at once would hold its row and wait for the cap the erasure holds).
 * Key paths: create cap → chain; rotate cap → key row → chain; revoke/rename key row → chain;
 * sweep key rows (SKIP LOCKED) → chain; erasure cap → member's key rows → chain.
 */
export async function lockApiKeysOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<void> {
  const repo = new ApiKeyRepo(ctx, tx);
  await repo.lockCap();
  await repo.lockUnrevokedByCreator(membershipId);
}

/**
 * Revokes one member's unrevoked keys inside the caller's transaction (identity erasure), key
 * rows locked in id order. No audit here: the caller writes `api_key.auto_revoked` entries with
 * `auditAutoRevoked` at the point its own lock order allows (after every row lock it takes).
 */
export async function revokeApiKeysOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  reason: ApiKeyRevokedReason,
  at: Date,
): Promise<ApiKeyRecord[]> {
  const repo = new ApiKeyRepo(ctx, tx);
  const out: ApiKeyRecord[] = [];
  for (const key of await repo.lockUnrevokedByCreator(membershipId)) {
    const revoked = await repo.revoke(key.id, reason, at);
    if (revoked !== undefined) out.push(revoked);
  }
  return out;
}

/** One `api_key.auto_revoked` entry per key, as the system (the sweep, erasure). */
export async function auditAutoRevoked(
  audit: AuditRecorder,
  tx: Tx,
  ctx: TenantContext,
  keys: readonly ApiKeyRecord[],
  reason: ApiKeyRevokedReason,
): Promise<void> {
  for (const key of keys) {
    await audit.record(tx, ctx, {
      action: "api_key.auto_revoked",
      resourceKind: "api_key",
      resourceId: key.id,
      subjectMembershipId: key.createdByMembershipId,
      actorKind: "system",
      actorMembershipId: null,
      actorUserId: null,
      meta: { reason, prefix: key.prefix },
    });
  }
}

/**
 * Under the cap lock: the member minting a key is still live. The route's guard checked it at the
 * start of the request, but an identity erasure that held the cap lock may have revoked them
 * since; a key minted now would belong to an erased member (409 `creator_not_live`).
 */
async function assertCreatorLive(repo: ApiKeyRepo, membershipId: string, at: Date): Promise<void> {
  if (!creatorIsLive(await repo.creatorFacts(membershipId), at))
    throw new ApiKeyError("conflict", "your membership is no longer active", {
      reason: "creator_not_live",
    });
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const touched = new Map<string, number>();

  function offered(): Map<string, string> {
    return new Map(deps.scopeCatalogue().map((s) => [s.id, s.description]));
  }

  /** Every scope offered (`scope_not_offered`) and held by `actor` (`scope_not_held`). */
  function checkScopes(actor: CreatorFacts, scopes: readonly string[]): string[] {
    const unique = [...new Set(scopes)].sort();
    if (unique.length === 0)
      throw new ApiKeyError("validation_failed", "a key needs at least one scope", {
        reason: "scopes_empty",
      });
    const catalogue = offered();
    const notOffered = unique.filter((s) => !catalogue.has(s));
    if (notOffered.length > 0)
      throw new ApiKeyError(
        "validation_failed",
        `not a scope an API key can be given: ${notOffered.join(", ")}`,
        { reason: "scope_not_offered", scopes: notOffered },
      );
    const notHeld = unique.filter((s) => !deps.hasPermission(actor, s));
    if (notHeld.length > 0)
      throw new ApiKeyError(
        "validation_failed",
        `you do not hold every scope you asked for: ${notHeld.join(", ")}`,
        { reason: "scope_not_held", scopes: notHeld },
      );
    return unique;
  }

  function checkExpiry(expiresAt: Date | null | undefined, at: Date): Date | null {
    if (expiresAt === null || expiresAt === undefined) return null;
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= at.getTime())
      throw new ApiKeyError("validation_failed", "expiresAt must be in the future", {
        reason: "invalid_expiry",
      });
    if (expiresAt.getTime() > at.getTime() + API_KEY_MAX_LIFETIME_MS)
      throw new ApiKeyError("validation_failed", "expiresAt must be at most two years ahead", {
        reason: "invalid_expiry",
      });
    return expiresAt;
  }

  async function viewOf(repo: ApiKeyRepo, id: string, at: Date): Promise<ApiKeyView> {
    const hit = await repo.byIdWithCreator(id);
    if (hit === undefined) throw new ApiKeyError("not_found", "no such API key");
    return toApiKeyView(hit.key, hit.creatorDisplayName, at);
  }

  function auditFields(meta: ApiKeyRequestMeta | undefined) {
    return {
      sessionId: meta?.sessionId ?? null,
      requestId: meta?.requestId ?? null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    };
  }

  async function sweepWorkspace(workspaceId: string, at: Date): Promise<number> {
    const ctx = systemContext(workspaceId);
    return deps.db.withTenant(ctx, async (tx) => {
      const repo = new ApiKeyRepo(ctx, tx);
      const candidates = await repo.lockUnrevokedWithCreators();
      const revoked: ApiKeyRecord[] = [];
      for (const c of candidates) {
        if (creatorIsLive(c.creator, at)) continue;
        const r = await repo.revoke(c.key.id, "creator_inactive", at);
        if (r !== undefined) revoked.push(r);
      }
      await auditAutoRevoked(deps.audit, tx, ctx, revoked, "creator_inactive");
      return revoked.length;
    });
  }

  const service: ApiKeyService = {
    async authenticate(workspaceId, token) {
      if (!isPlausibleApiKey(token)) return undefined;
      const hash = apiKeyTokenHash(token);
      const ctx = systemContext(workspaceId);
      const hit = await deps.db.withTenant(ctx, (tx) =>
        new ApiKeyRepo(ctx, tx).findByTokenHashWithCreator(hash),
      );
      const at = now();
      if (hit === undefined || apiKeyStatus(hit.key, at) !== "live") return undefined;
      if (hit.creator === undefined || !creatorIsLive(hit.creator, at)) return undefined;
      return { key: hit.key, creator: hit.creator };
    },

    async touchLastUsed(workspaceId, keyId, ip) {
      const t = now().getTime();
      const last = touched.get(keyId);
      if (last !== undefined && t - last < API_KEY_LAST_USED_THROTTLE_SECONDS * 1000) return;
      if (touched.size >= TOUCH_MEMO_MAX) touched.clear();
      touched.set(keyId, t);
      const ctx = systemContext(workspaceId);
      try {
        await deps.db.withTenant(ctx, (tx) =>
          new ApiKeyRepo(ctx, tx).touchLastUsed(
            keyId,
            ip === undefined ? null : (truncateIp(ip) ?? null),
            API_KEY_LAST_USED_THROTTLE_SECONDS,
          ),
        );
      } catch (error) {
        touched.delete(keyId);
        log("api_keys.touch_failed", {
          level: "warn",
          keyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async list(ctx, query) {
      const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
      let before: string | undefined;
      if (query.cursor !== undefined && query.cursor !== "") {
        before = decodeApiKeyCursor(query.cursor);
        if (before === undefined)
          throw new ApiKeyError("validation_failed", "bad cursor", { reason: "invalid_cursor" });
      }
      const at = now();
      const rows = await deps.db.withTenant(ctx, (tx) =>
        new ApiKeyRepo(ctx, tx).pageWithCreators(before, limit + 1),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => toApiKeyView(r.key, r.creatorDisplayName, at)),
        nextCursor:
          rows.length > limit && last !== undefined ? encodeApiKeyCursor(last.key.id) : null,
      };
    },

    scopes(actor) {
      return deps
        .scopeCatalogue()
        .map((s) => ({
          id: s.id,
          description: s.description,
          held: deps.hasPermission(actor, s.id),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async create(ctx, actor, input, meta) {
      const at = now();
      const name = checkName(input.name);
      const note = checkNote(input.note);
      const scopes = checkScopes(actor, input.scopes);
      const expiresAt = checkExpiry(input.expiresAt, at);
      const token = mintApiKeyToken();
      const key = await deps.db.withTenant(ctx, async (tx) => {
        // The cap is read-then-insert: the cap lock serialises concurrent creates and rotations.
        const repo = new ApiKeyRepo(ctx, tx);
        await repo.lockCap();
        await assertCreatorLive(repo, actor.id, at);
        if ((await repo.countLive(at)) >= MAX_LIVE_API_KEYS)
          throw new ApiKeyError(
            "conflict",
            `a workspace can have at most ${MAX_LIVE_API_KEYS} live API keys; revoke one first`,
            { reason: "too_many_keys", max: MAX_LIVE_API_KEYS },
          );
        const row = await repo.insert({
          name,
          tokenHash: apiKeyTokenHash(token),
          prefix: displayPrefix(token),
          scopes,
          createdByMembershipId: actor.id,
          expiresAt,
          note,
        });
        await deps.audit.record(tx, ctx, {
          action: "api_key.created",
          resourceKind: "api_key",
          resourceId: row.id,
          ...auditFields(meta),
          meta: {
            prefix: row.prefix,
            scopes: [...scopes],
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
        return viewOf(repo, row.id, at);
      });
      return { key, token };
    },

    async update(ctx, id, patch, meta) {
      if (!UUID_RE.test(id)) throw new ApiKeyError("not_found", "no such API key");
      const at = now();
      const name = patch.name === undefined ? undefined : checkName(patch.name);
      const note = patch.note === undefined ? undefined : checkNote(patch.note);
      return deps.db.withTenant(ctx, async (tx) => {
        const repo = new ApiKeyRepo(ctx, tx);
        const before = await repo.byIdForUpdate(id);
        if (before === undefined) throw new ApiKeyError("not_found", "no such API key");
        const fields: string[] = [];
        if (name !== undefined && name !== before.name) fields.push("name");
        if (note !== undefined && note !== before.note) fields.push("note");
        if (fields.length > 0) {
          await repo.update(id, {
            ...(name !== undefined ? { name } : {}),
            ...(note !== undefined ? { note } : {}),
          });
          await deps.audit.record(tx, ctx, {
            action: "api_key.updated",
            resourceKind: "api_key",
            resourceId: id,
            ...auditFields(meta),
            meta: { prefix: before.prefix, fields },
          });
        }
        return viewOf(repo, id, at);
      });
    },

    async rotate(ctx, actor, id, graceHours = API_KEY_ROTATE_GRACE_DEFAULT_HOURS, meta) {
      if (!UUID_RE.test(id)) throw new ApiKeyError("not_found", "no such API key");
      if (
        !Number.isInteger(graceHours) ||
        graceHours < 0 ||
        graceHours > API_KEY_ROTATE_GRACE_MAX_HOURS
      )
        throw new ApiKeyError(
          "validation_failed",
          `graceHours must be 0..${API_KEY_ROTATE_GRACE_MAX_HOURS}`,
          { reason: "invalid_grace" },
        );
      const at = now();
      const token = mintApiKeyToken();
      return deps.db.withTenant(ctx, async (tx) => {
        const repo = new ApiKeyRepo(ctx, tx);
        // Every rotation mints a key, so it takes the cap lock (fix round 2), and before the key
        // row: identity erasure takes the cap and then the member's key rows (same order).
        await repo.lockCap();
        const old = await repo.byIdForUpdate(id);
        if (old === undefined) throw new ApiKeyError("not_found", "no such API key");
        if (apiKeyStatus(old, at) !== "live")
          throw new ApiKeyError("conflict", "only a live key can be rotated", {
            reason: "key_not_live",
          });
        if (old.replacedById !== null)
          throw new ApiKeyError(
            "conflict",
            "this key has already been rotated; rotate its replacement",
            { reason: "already_rotated", replacedById: old.replacedById },
          );
        // The rotating member becomes the creator, so their permissions must cover the scopes.
        const scopes = checkScopes(actor, old.scopes);
        // With a grace window the old key stays live beside the new one, so the cap applies: at
        // most one key over it, transiently, and only when the old key itself is within it —
        // refuse once the live count (the old key included) is already over the cap. Chained
        // rotations (rotate the replacement before the grace ends) would otherwise mint a live key
        // per rotation. Grace 0 revokes the old key in the same transaction: net zero.
        await assertCreatorLive(repo, actor.id, at);
        if (graceHours > 0) {
          if ((await repo.countLive(at)) > MAX_LIVE_API_KEYS)
            throw new ApiKeyError(
              "conflict",
              `a workspace can have at most ${MAX_LIVE_API_KEYS} live API keys; rotate with graceHours 0 or revoke one first`,
              { reason: "too_many_keys", max: MAX_LIVE_API_KEYS },
            );
        }
        const fresh = await repo.insert({
          name: old.name,
          tokenHash: apiKeyTokenHash(token),
          prefix: displayPrefix(token),
          scopes,
          createdByMembershipId: actor.id,
          expiresAt: old.expiresAt,
          note: old.note,
        });
        if (graceHours === 0) {
          await repo.markReplaced(old.id, fresh.id, old.expiresAt);
          await repo.revoke(old.id, "rotated", at);
        } else {
          const graceEnd = new Date(at.getTime() + graceHours * 3_600_000);
          const expiresAt =
            old.expiresAt !== null && old.expiresAt.getTime() < graceEnd.getTime()
              ? old.expiresAt
              : graceEnd;
          await repo.markReplaced(old.id, fresh.id, expiresAt);
        }
        await deps.audit.record(tx, ctx, {
          action: "api_key.rotated",
          resourceKind: "api_key",
          resourceId: fresh.id,
          ...auditFields(meta),
          meta: {
            previousId: old.id,
            previousPrefix: old.prefix,
            prefix: fresh.prefix,
            graceHours,
          },
        });
        return {
          key: await viewOf(repo, fresh.id, at),
          token,
          previous: await viewOf(repo, old.id, at),
        };
      });
    },

    async revoke(ctx, id, meta) {
      if (!UUID_RE.test(id)) throw new ApiKeyError("not_found", "no such API key");
      const at = now();
      return deps.db.withTenant(ctx, async (tx) => {
        const repo = new ApiKeyRepo(ctx, tx);
        const key = await repo.byIdForUpdate(id);
        if (key === undefined) throw new ApiKeyError("not_found", "no such API key");
        if (key.revokedAt === null) {
          await repo.revoke(id, "revoked", at);
          await deps.audit.record(tx, ctx, {
            action: "api_key.revoked",
            resourceKind: "api_key",
            resourceId: id,
            ...auditFields(meta),
            meta: { prefix: key.prefix },
          });
        }
        return viewOf(repo, id, at);
      });
    },

    async sweep(atArg) {
      const at = atArg ?? now();
      let workspaces = 0;
      let revoked = 0;
      for (const workspaceId of await listLiveWorkspaceIds(deps.db)) {
        if (isPlatformWorkspace(workspaceId)) continue;
        workspaces += 1;
        revoked += await sweepWorkspace(workspaceId, at);
      }
      log("api_keys.swept", { workspaces, revoked });
      return { workspaces, revoked };
    },

    jobs: [
      {
        name: API_KEY_SWEEP_JOB,
        cron: API_KEY_SWEEP_CRON,
        handler: async () => {
          await service.sweep();
        },
      },
    ],
  };
  return service;
}
