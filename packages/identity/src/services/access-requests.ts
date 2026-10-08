import { randomInt, randomUUID } from "node:crypto";
import {
  findWorkspaceById,
  type Invite,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  lockWorkspaceFacts,
  type OfferingStatus,
  pgErrorCode,
  systemContext,
  type TenantContext,
  type Tx,
  type Workspace,
} from "@fundroom/db";
import { type InviteGrant, parseWorkspaceSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { t } from "@fundroom/i18n";
import type { JobDefinition, JsonObject, RateLimitRule } from "@fundroom/ports";
import { hashCode, verifyCode } from "../crypto/keys.js";
import { AuthError } from "../errors.js";
import {
  accessRequestCodeEmail,
  accessRequestDeniedEmail,
  accessRequestExistingEmail,
} from "../mail/templates.js";
import {
  type AccessRequest,
  AccessRequestChallengeRepo,
  type AccessRequestCursor,
  AccessRequestRepo,
} from "../repos/access-request-repo.js";
import { GroupRepo, InviteRepo, MembershipRepo } from "../repos/membership-repo.js";
import { findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import { sendInviteEmail, writeInvite } from "./invites.js";
import { accessRequestRateKey, RATE_LIMITS } from "./rate-limiter.js";
import { recipientLocale } from "./recipient-locale.js";
import { sendSignInMailDetached } from "./sign-in-mail.js";
import { absoluteUrl, type IdentityDeps, nowOf, pathsOf, withMinimumDuration } from "./types.js";

/*
 * Public access requests and the admin approval queue (E3.1, design/05 §5).
 *
 * A stranger fills in the "request access" form (name, email, firm, reason) and is mailed a
 * 6-digit code; proving it puts the request in the queue, where an admin approves it — which
 * issues an ordinary invitation through the invite code path (`writeInvite`) — or denies it. Not
 * the GDPR "access request" (`core.dsar_request`).
 *
 * Each submission is its own `core.access_request_challenge` row: the text THAT submission carried
 * and its code's keyed hash. Nothing about the address's queue entry changes until a code is
 * proven, and then it takes the proven submission's text. So a stranger's submission for somebody
 * else's address can neither overwrite what the owner wrote nor invalidate the code the owner was
 * mailed (every unexpired code for the address is accepted); the worst it does is mail the owner a
 * code that restates the stranger's name, which the owner ignores.
 *
 * Anti-enumeration is the whole design of the two public calls:
 *
 *  - `start` answers `{ expiresAt }` for every input — a real request, a member's address, a
 *    honeypot hit, a rate limit, a full queue, a disabled form, a database error — and never
 *    throws. `expiresAt` is computed once, from the instant the call arrived, before anything
 *    else happens, identically on every path (no later clock read can leak how long the real path
 *    took). Mail is started detached, so delivery never shows in the timing, and the whole call
 *    sits inside a `START_FLOOR_MS` floor.
 *  - `verify` takes `{ email, code }` and answers `{ ok }`; every "no" is the same `false` (no
 *    challenge, wrong code, expired, too many attempts). Every "yes" is the same `true` —
 *    including the deny cooldown and an address that joined meanwhile, which queue nothing, and
 *    an auto-approval.
 *
 * Codes are 6 digits from `crypto.randomInt`, stored only as an HMAC under the key ring
 * (`hashCode`, scoped to the workspace and the challenge row) and compared in constant time. The
 * attempt budget is the `accessRequestVerifyPerEmail` rate rule (5 per 15 minutes per address),
 * hit — atomically, in the limiter — BEFORE any comparison, so parallel guesses cannot outrun it:
 * at most 5 guesses per window reach the comparison, against every live code of the address.
 *
 * Connections: no function here holds a transaction while it asks for another connection. Host
 * reads (the address's user, the recipient's language) and rate-limit hits run first, each on
 * their own short transaction; the tenant transaction comes after; mail goes after commit.
 */

export const ACCESS_REQUEST_CODE_TTL_MS = 10 * 60_000;
/** Verification attempts per address per window (the `accessRequestVerifyPerEmail` rule). */
export const ACCESS_REQUEST_CODE_MAX_ATTEMPTS = RATE_LIMITS.accessRequestVerifyPerEmail.max;
/** Denied/expired rows are deleted this long after they were decided (or lapsed). */
export const ACCESS_REQUEST_RETENTION_DAYS = 90;
/** Per workspace; above it `start` is a silent decoy. */
export const ACCESS_REQUEST_PENDING_CAP = 500;
/** A verification for an address denied within this window: neutral "received", no queue row. */
export const ACCESS_REQUEST_DENY_COOLDOWN_DAYS = 30;
export const ACCESS_REQUEST_START_FLOOR_MS = 250;
export const ACCESS_REQUEST_VERIFY_FLOOR_MS = 250;
/** Contract aliases. */
export const START_FLOOR_MS = ACCESS_REQUEST_START_FLOOR_MS;
export const VERIFY_FLOOR_MS = ACCESS_REQUEST_VERIFY_FLOOR_MS;

const DAY_MS = 24 * 3600_000;
const SWEEP_BATCH = 500;
const CODE_DIGITS = 6;
/**
 * Live challenges compared per verification. The per-address start budget (3/h, 10-minute codes)
 * keeps the real number at a handful; this is only a ceiling.
 */
const LIVE_CHALLENGE_LIMIT = 10;
/** A relationship "established" later than this after now is a typo, not an attestation (C8). */
const RELATIONSHIP_FUTURE_SLACK_MS = DAY_MS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODE_RE = /^[0-9]{6}$/u;
/** Exactly what `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` prints. */
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const LOGINABLE: ReadonlySet<string> = new Set(["invited", "active", "dormant"]);
/** An HMAC-sized nothing, so a verification without a candidate does the same work. */
const NO_HASH = Buffer.alloc(32);

/** What the service reads off the resolved workspace. */
export type AccessRequestWorkspace = Pick<Workspace, "id" | "name" | "settings" | "offeringStatus">;

export type AccessRequestQueueStatus = "pending" | "approved" | "denied" | "expired";

/** The admin's view of one request (the `AccessRequest` contract, dates as `Date`). */
export interface AccessRequestView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly firm: string | null;
  readonly reason: string | null;
  readonly status: AccessRequestQueueStatus;
  readonly createdAt: Date;
  readonly verifiedAt: Date | null;
  readonly expiresAt: Date;
  readonly suggestedGroupIds: readonly string[];
  readonly autoApproved: boolean;
  readonly decidedAt: Date | null;
  readonly decidedBy: { readonly membershipId: string; readonly displayName: string } | null;
  readonly decisionNote: string | null;
  readonly relationship: {
    readonly source: string;
    readonly establishedAt: Date;
    readonly note: string | null;
  } | null;
  readonly inviteId: string | null;
  readonly membershipId: string | null;
}

export interface StartAccessRequestInput {
  readonly workspace: AccessRequestWorkspace;
  readonly email: string;
  readonly name: string;
  readonly firm?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** The honeypot field (`website`): anything but empty makes the call a decoy. */
  readonly honeypot?: string | null | undefined;
  /**
   * The client address as `clientIp()` reports it (the socket peer, or the trusted proxy's
   * entry — E2.10). Keys the per-IP start budget and is stored as a keyed hash for abuse review.
   */
  readonly clientIp?: string | null | undefined;
}

export interface StartAccessRequestResult {
  /** The answer: the instant the call arrived + the code lifetime, on every path. */
  readonly expiresAt: Date;
  /**
   * For the caller's security-event log only — NEVER for the response: set when the workspace-wide
   * or the per-IP start budget refused this call (somebody is pushing the form hard).
   */
  readonly throttled: "workspace" | "ip" | null;
}

export interface VerifyAccessRequestInput {
  readonly workspace: AccessRequestWorkspace;
  readonly email: string;
  readonly code: string;
}

export interface ListAccessRequestsQuery {
  readonly status: AccessRequestQueueStatus;
  readonly cursor?: string | undefined;
  /** 1..100, default 50. */
  readonly limit?: number | undefined;
}

export interface ApproveAccessRequestInput {
  readonly id: string;
  readonly actorMembershipId: string;
  /** The approver's display name, for the invitation email ("Dana has invited you…"). */
  readonly actorName?: string | undefined;
  readonly workspace: AccessRequestWorkspace;
  readonly groupIds: readonly string[];
  /** Already canonicalised by the caller (`canonicalInviteGrants`), exactly as for POST /access/invites. */
  readonly grants?: readonly InviteGrant[] | undefined;
  /** Default: the workspace's `access.inviteExpiryDays`. */
  readonly expiresInDays?: number | undefined;
  /** Mailed in the invitation. Default: "Your request to access {workspace} was approved." */
  readonly message?: string | undefined;
  /** Staff-only; never mailed. */
  readonly note?: string | undefined;
  /** Required when the workspace's offering status is `506b` (read fresh, not from `workspace`). */
  readonly relationship?:
    | {
        readonly source: string;
        readonly establishedAt: Date;
        readonly note?: string | null | undefined;
      }
    | undefined;
  readonly requestId?: string | undefined;
  /**
   * Called once every check that can refuse the approval has passed, before anything is written
   * (no transaction is held): the route spends the workspace's daily invitation cap here, so a
   * refused approval never costs a slot (C7). Throwing aborts the approval with that error.
   */
  readonly beforeWrite?: (() => Promise<void>) | undefined;
}

export interface DenyAccessRequestInput {
  readonly id: string;
  readonly actorMembershipId: string;
  readonly workspace: AccessRequestWorkspace;
  readonly note?: string | undefined;
  readonly notifyRequester: boolean;
  readonly requestId?: string | undefined;
}

export interface AccessRequestSweepResult {
  readonly deleted: number;
  readonly expired: number;
}

export interface AccessRequestService {
  /** Never throws for a "no": every outcome is `{ expiresAt }` (+ the internal `throttled`). */
  start(input: StartAccessRequestInput): Promise<StartAccessRequestResult>;
  /** `ok: false` is the one answer for every failure (the route maps it to 400 `invalid_code`). */
  verify(input: VerifyAccessRequestInput): Promise<{ ok: boolean }>;
  /** Read-only, on the caller's tenant transaction. */
  list(
    ctx: TenantContext,
    tx: Tx,
    q: ListAccessRequestsQuery,
  ): Promise<{ items: AccessRequestView[]; nextCursor: string | null }>;
  /** Read-only, on the caller's tenant transaction. `null` for unknown ids. */
  get(ctx: TenantContext, tx: Tx, id: string): Promise<AccessRequestView | null>;
  /**
   * Opens its own transactions — do NOT call it inside one (a host read comes first, the mail
   * after commit). Throws `AuthError` `not_found` | `conflict` (not pending; already a member;
   * `{ reason: "invite_pending" }`) | `relationship_attestation_required` | `validation_failed`.
   * A failed invitation mail does not throw: the approval and invite are committed by then, and
   * `mailSent: false` says the invite should be resent (C3).
   */
  approve(
    ctx: TenantContext,
    input: ApproveAccessRequestInput,
  ): Promise<{ request: AccessRequestView; invite: Invite; mailSent: boolean }>;
  /** Opens its own transaction (mail after commit). Throws `not_found` | `conflict`. */
  deny(ctx: TenantContext, input: DenyAccessRequestInput): Promise<{ request: AccessRequestView }>;
  /** The hourly sweep over every active workspace. */
  sweep(now?: Date): Promise<AccessRequestSweepResult>;
}

export interface AccessRequestServiceOptions {
  /**
   * `permits(status).requestAutoApprove` from `@fundroom/compliance` (which depends on this
   * package, hence injected). Domain auto-approval happens only when it answers true.
   */
  readonly requestAutoApprove: (status: OfferingStatus) => boolean;
  /**
   * The workspace's daily invitation cap (`INVITE_DAILY_CAP`, key `invite:ws:<id>`), so an
   * auto-approval counts toward it like any invitation. When the cap is reached the request stays
   * `pending` for a person. Omit to not count auto-approvals.
   */
  readonly inviteDailyCap?: RateLimitRule | undefined;
}

/** A 6-digit code from the CSPRNG, zero-padded. */
export function accessRequestCode(): string {
  return randomInt(0, 10 ** CODE_DIGITS)
    .toString()
    .padStart(CODE_DIGITS, "0");
}

/** The HMAC scope of a challenge's code: bound to the workspace and to the challenge row. */
export function accessRequestCodeScope(workspaceId: string, challengeId: string): string {
  return `access_request:${workspaceId}:${challengeId}`;
}

/** Whether `email`'s domain is exactly one of `domains` (lower-cased; no suffix matching). */
export function emailDomainMatches(email: string, domains: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 && domains.some((d) => d.trim().toLowerCase() === domain);
}

export function encodeAccessRequestCursor(cursor: AccessRequestCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Strict: anything that is not exactly what `encodeAccessRequestCursor` wrote is refused. */
export function decodeAccessRequestCursor(raw: string): AccessRequestCursor | undefined {
  if (raw.length === 0 || raw.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(raw)) return undefined;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [createdAt, id, extra] = text.split("|");
  if (extra !== undefined || createdAt === undefined || id === undefined) return undefined;
  if (!CURSOR_TS_RE.test(createdAt) || !UUID_RE.test(id)) return undefined;
  if (Number.isNaN(Date.parse(createdAt))) return undefined;
  return { createdAt, id: id.toLowerCase() };
}

/** Trimmed, empty → null, clipped to the column's CHECK bound. */
function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  return v.length === 0 ? null : v.slice(0, max);
}

/**
 * The workspace's settings and offering mode as the transaction sees them — never the cache.
 * Row-locked FOR NO KEY UPDATE (not SHARE, E3.5 LX): the deciding transactions go on to audit,
 * which takes this row in that mode — two share holders would deadlock on the upgrade. Global
 * order: the access-request row(s) BEFORE this, the audit chain after.
 */
async function freshWorkspace(tx: Tx, workspaceId: string) {
  const facts = await lockWorkspaceFacts(tx, workspaceId);
  if (facts === undefined) throw new AuthError("not_found", "no such workspace");
  return {
    offeringStatus: facts.offeringStatus,
    settings: parseWorkspaceSettings(facts.settings).access,
  };
}

export function createAccessRequestService(
  deps: IdentityDeps,
  options: AccessRequestServiceOptions,
): AccessRequestService {
  const log = (event: string, fields?: Readonly<Record<string, unknown>>) =>
    deps.log?.(event, fields);

  function toView(
    row: AccessRequest,
    names: ReadonlyMap<string, { displayName: string; email: string | null }>,
  ): AccessRequestView {
    const decider = row.decidedBy === null ? undefined : names.get(row.decidedBy);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      firm: row.firm,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt,
      verifiedAt: row.verifiedAt,
      expiresAt: row.expiresAt,
      suggestedGroupIds: row.suggestedGroupIds,
      autoApproved: row.autoApproved,
      decidedAt: row.decidedAt,
      decidedBy:
        row.decidedBy === null
          ? null
          : {
              membershipId: row.decidedBy,
              displayName: decider?.displayName || decider?.email || "",
            },
      decisionNote: row.decisionNote,
      relationship:
        row.relationshipSource !== null && row.relationshipEstablishedAt !== null
          ? {
              source: row.relationshipSource,
              establishedAt: row.relationshipEstablishedAt,
              note: row.relationshipNote,
            }
          : null,
      inviteId: row.inviteId,
      membershipId: row.membershipId,
    };
  }

  async function views(ctx: TenantContext, tx: Tx, rows: readonly AccessRequest[]) {
    const deciders = [...new Set(rows.flatMap((r) => (r.decidedBy === null ? [] : [r.decidedBy])))];
    const names = await new MembershipRepo(ctx, tx).namesFor(deciders);
    return rows.map((r) => toView(r, names));
  }

  /** The invitation an approval issues, the row's decision, its audit row and its event. */
  async function approveInTx(
    ctx: TenantContext,
    tx: Tx,
    row: AccessRequest,
    input: {
      readonly workspace: AccessRequestWorkspace;
      readonly actorMembershipId: string | null;
      readonly groupIds: readonly string[];
      readonly grants: readonly InviteGrant[];
      readonly expiresInDays: number;
      readonly message: string;
      readonly note: string | null;
      readonly relationship: ApproveAccessRequestInput["relationship"];
      readonly auto: boolean;
      readonly existingUserId: string | undefined;
      readonly requestId?: string | undefined;
    },
  ) {
    const now = nowOf(deps);
    const actorKind = input.actorMembershipId === null ? "system" : "staff";
    const created = await writeInvite(
      deps,
      ctx,
      tx,
      {
        workspaceId: ctx.workspaceId,
        workspaceName: input.workspace.name,
        email: row.email,
        kind: "external",
        role: "investor",
        groupIds: input.groupIds,
        grants: input.grants,
        message: input.message,
        expiresInDays: input.expiresInDays,
        invitedBy: input.actorMembershipId ?? undefined,
        profile: { displayName: row.name, ...(row.firm === null ? {} : { firm: row.firm }) },
        accessRequestId: row.id,
        actorKind,
        requestId: input.requestId,
      },
      input.existingUserId,
    );
    const rel = input.relationship;
    const updated = await new AccessRequestRepo(ctx, tx).update(row.id, {
      status: "approved",
      decidedAt: now,
      decidedBy: input.actorMembershipId,
      decisionNote: input.note,
      relationshipSource: rel?.source ?? null,
      relationshipEstablishedAt: rel?.establishedAt ?? null,
      relationshipNote: optionalText(rel?.note, 2000),
      inviteId: created.invite.id,
      autoApproved: input.auto,
    });
    if (updated === undefined) throw new AuthError("not_found", "no such access request");
    await deps.audit.record(tx, ctx, {
      action: "access_request.approved",
      resourceKind: "access_request",
      resourceId: row.id,
      actorKind,
      actorMembershipId: input.actorMembershipId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      meta: {
        inviteId: created.invite.id,
        groupIds: [...new Set(input.groupIds)],
        grants: input.grants.length,
        auto: input.auto,
        relationship: rel !== undefined,
        expiresAt: created.invite.expiresAt.toISOString(),
      },
    });
    await publish(tx, ctx, "access_request.decided", {
      accessRequestId: row.id,
      decision: "approved",
      auto: input.auto,
    });
    return { row: updated, created };
  }

  /** Whether the address is already served here: a loginable membership, or a pending invite. */
  async function standing(
    ctx: TenantContext,
    tx: Tx,
    email: string,
    userId: string | undefined,
  ): Promise<"existing" | "blocked" | "none"> {
    if (userId !== undefined) {
      const m = await new MembershipRepo(ctx, tx).findForUser(userId);
      if (m !== undefined) return LOGINABLE.has(m.status) ? "existing" : "blocked";
    }
    const invite = await new InviteRepo(ctx, tx).findPendingByEmail(email, nowOf(deps));
    return invite === undefined ? "none" : "existing";
  }

  async function hostFacts(email: string, workspaceId: string) {
    return deps.db.withHost(async (tx) => {
      const user = await findUserByEmail(tx, email);
      const locale = await recipientLocale(tx, {
        ...(user === undefined ? { email } : { userId: user.id }),
        workspaceId,
      });
      return { userId: user?.id, locale };
    });
  }

  /** The default groups that are still live groups of the workspace (C1). */
  async function liveGroups(ctx: TenantContext, tx: Tx, ids: readonly string[]) {
    if (ids.length === 0) return [];
    const live = new Set((await new GroupRepo(ctx, tx).byIds(ids)).map((g) => g.id));
    return ids.filter((g) => live.has(g));
  }

  /** Returns why the budget refused (for the security-event log), or `null`. */
  async function startInner(
    input: StartAccessRequestInput,
    startedAt: Date,
    expiresAt: Date,
  ): Promise<"workspace" | "ip" | null> {
    const ws = input.workspace;
    if (typeof input.honeypot === "string" && input.honeypot.length > 0) {
      log("auth.access_request_decoy", { workspaceId: ws.id, reason: "honeypot" });
      return null;
    }
    const settings = parseWorkspaceSettings(ws.settings).access.requests;
    if (!settings.enabled) return null;
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      return null;
    }
    const name = optionalText(input.name, 120);
    if (name === null) return null;
    const ip =
      typeof input.clientIp === "string" && input.clientIp.length > 0 ? input.clientIp : "";

    // Every bucket is hit on every call, so no bucket's count depends on another's verdict.
    const byEmail = await deps.rateLimiter.hit(
      accessRequestRateKey("start_email", ws.id, email),
      RATE_LIMITS.accessRequestStartPerEmail,
    );
    const byWorkspace = await deps.rateLimiter.hit(
      accessRequestRateKey("start_ws", ws.id),
      RATE_LIMITS.accessRequestStartPerWorkspace,
    );
    const byIp =
      ip === ""
        ? { allowed: true }
        : await deps.rateLimiter.hit(
            accessRequestRateKey("start_ip", ws.id, ip),
            RATE_LIMITS.accessRequestStartPerIp,
          );
    if (!byWorkspace.allowed || !byIp.allowed || !byEmail.allowed) {
      log("auth.access_request_decoy", { workspaceId: ws.id, reason: "rate_limited" });
      return !byWorkspace.allowed ? "workspace" : !byIp.allowed ? "ip" : null;
    }

    const facts = await hostFacts(email, ws.id);
    const ctx = systemContext(ws.id);
    const code = accessRequestCode();
    const challengeId = randomUUID();
    const firm = optionalText(input.firm, 160);
    const outcome = await deps.db.withTenant(ctx, async (tx) => {
      const state = await standing(ctx, tx, email, facts.userId);
      if (state === "existing") return { kind: "existing" as const };
      if (state === "blocked") return { kind: "decoy" as const, reason: "suspended" };
      const requests = new AccessRequestRepo(ctx, tx);
      if (
        !(await requests.hasPending(email)) &&
        (await requests.countPending(ACCESS_REQUEST_PENDING_CAP)) >= ACCESS_REQUEST_PENDING_CAP
      )
        return { kind: "decoy" as const, reason: "queue_full" };
      await new AccessRequestChallengeRepo(ctx, tx).insert({
        id: challengeId,
        email,
        name,
        firm,
        reason: optionalText(input.reason, 2000),
        codeHash: hashCode(deps.keyRing, code, accessRequestCodeScope(ws.id, challengeId)),
        clientIpHash: ip === "" ? null : hashCode(deps.keyRing, ip, "access_request.client_ip"),
        expiresAt,
        createdAt: startedAt,
      });
      return { kind: "code" as const };
    });

    const brand = {
      productName: deps.productName,
      workspaceId: ws.id,
      workspaceName: ws.name,
      locale: facts.locale,
    };
    if (outcome.kind === "decoy") {
      log("auth.access_request_decoy", { workspaceId: ws.id, reason: outcome.reason });
      return null;
    }
    if (outcome.kind === "existing") {
      // Started, not awaited: delivery must not show in the answer or its timing.
      void sendSignInMailDetached(
        deps,
        accessRequestExistingEmail(email, {
          ...brand,
          signInUrl: absoluteUrl(deps, pathsOf(deps).signIn),
        }),
        { kind: "access_request", workspaceId: ws.id },
      );
      return null;
    }
    void sendSignInMailDetached(
      deps,
      accessRequestCodeEmail(email, {
        ...brand,
        code,
        ttlMinutes: Math.round(ACCESS_REQUEST_CODE_TTL_MS / 60_000),
        expiresAt,
        name,
        firm,
      }),
      { kind: "access_request", workspaceId: ws.id },
    );
    log("auth.access_request_started", { workspaceId: ws.id });
    return null;
  }

  async function verifyInner(input: VerifyAccessRequestInput): Promise<boolean> {
    const ws = input.workspace;
    const code = typeof input.code === "string" ? input.code.replace(/\s+/gu, "") : "";
    let email: string | undefined;
    try {
      email = normalizeEmail(input.email);
    } catch {
      email = undefined;
    }
    // Same HMAC work as a real comparison, against nothing.
    const nothing = () =>
      verifyCode(deps.keyRing, code, accessRequestCodeScope(ws.id, ""), NO_HASH);
    if (email === undefined || !CODE_RE.test(code)) {
      nothing();
      return false;
    }
    // The attempt is spent before any code is compared (and never given back).
    const budget = await deps.rateLimiter.hit(
      accessRequestRateKey("verify_email", ws.id, email),
      RATE_LIMITS.accessRequestVerifyPerEmail,
    );
    if (!budget.allowed) {
      nothing();
      log("auth.access_request_verify_limited", { workspaceId: ws.id });
      return false;
    }
    const address = email;
    const ctx = systemContext(ws.id);
    const now = nowOf(deps);

    // 1. Which live challenge (if any) the code proves. Every one is compared, constant time.
    const matched = await deps.db.withTenant(ctx, async (tx) => {
      const live = await new AccessRequestChallengeRepo(ctx, tx).live(
        address,
        now,
        LIVE_CHALLENGE_LIMIT,
      );
      if (live.length === 0) nothing();
      let hit: (typeof live)[number] | undefined;
      for (const c of live) {
        if (verifyCode(deps.keyRing, code, accessRequestCodeScope(ws.id, c.id), c.codeHash))
          hit ??= c;
      }
      return hit;
    });
    if (matched === undefined) return false;

    // 2. Host facts (the address's user, their language), then a read-only plan: will this
    //    verification attempt an auto-approval? Only then is an invitation slot spent (C7).
    const facts = await hostFacts(address, ws.id);
    const cooldownSince = new Date(now.getTime() - ACCESS_REQUEST_DENY_COOLDOWN_DAYS * DAY_MS);
    const plan = await deps.db.withTenant(ctx, async (tx) => {
      const fresh = await freshWorkspace(tx, ws.id);
      const requests = new AccessRequestRepo(ctx, tx);
      return (
        options.requestAutoApprove(fresh.offeringStatus) &&
        emailDomainMatches(address, fresh.settings.requests.autoApproveDomains) &&
        !(await requests.deniedSince(address, cooldownSince)) &&
        !(await requests.hasPending(address)) &&
        (await standing(ctx, tx, address, facts.userId)) === "none"
      );
    });
    let auto = plan;
    if (plan && options.inviteDailyCap !== undefined) {
      const cap = await deps.rateLimiter.hit(`invite:ws:${ws.id}`, options.inviteDailyCap);
      auto = cap.allowed;
      if (!cap.allowed) log("auth.access_request_auto_capped", { workspaceId: ws.id });
    }

    // 3. The write: consume the address's challenges, then queue (or refresh) the request.
    const result = await deps.db.withTenant(ctx, async (tx) => {
      const requests = new AccessRequestRepo(ctx, tx);
      // One order for every access-request path (E3.5 LX, R3B): the request row(s), then the
      // challenges, then the workspace row. A staff approve or deny holds the pending row and
      // then takes the workspace row (its audit, `freshWorkspace`); identity erasure locks the
      // address's requests and then consumes its challenges (`prelockForErasure`), all before
      // the workspace row. Consuming the challenges first here closed a cycle with erasure.
      const open = await requests.lockPendingByEmail(address);
      const consumed = await new AccessRequestChallengeRepo(ctx, tx).deleteForEmail(address);
      // A second correct verification racing this one waited on these rows and finds them gone.
      if (!consumed.includes(matched.id)) return { ok: false as const };
      const fresh = await freshWorkspace(tx, ws.id);
      if (await requests.deniedSince(address, cooldownSince))
        return { ok: true as const, outcome: "cooldown" };
      // Became a member or was invited since `start`: the request is moot.
      if ((await standing(ctx, tx, address, facts.userId)) !== "none")
        return { ok: true as const, outcome: "moot" };

      const text = { name: matched.name, firm: matched.firm, reason: matched.reason };
      if (open !== undefined) {
        // Already queued: the proven submission's text replaces the old (the owner proved it).
        await requests.update(open.id, {
          ...text,
          clientIpHash: matched.clientIpHash,
          verifiedAt: now,
        });
        return { ok: true as const, outcome: "refreshed" };
      }

      const suggested = await liveGroups(ctx, tx, fresh.settings.requests.defaultGroupIds);
      const pending = await requests.insert({
        email: address,
        ...text,
        status: "pending",
        verifiedAt: now,
        expiresAt: new Date(now.getTime() + fresh.settings.requests.pendingExpiryDays * DAY_MS),
        suggestedGroupIds: suggested,
        clientIpHash: matched.clientIpHash,
        createdAt: now,
      });
      await deps.audit.record(tx, ctx, {
        action: "access_request.submitted",
        resourceKind: "access_request",
        resourceId: pending.id,
        actorKind: "system",
      });
      await publish(tx, ctx, "access_request.submitted", { accessRequestId: pending.id });

      // Re-decided on what this transaction sees (S8b): the offering mode or the domains may have
      // changed since the plan.
      if (
        !auto ||
        !options.requestAutoApprove(fresh.offeringStatus) ||
        !emailDomainMatches(address, fresh.settings.requests.autoApproveDomains)
      )
        return { ok: true as const, outcome: "pending", id: pending.id };
      try {
        // Under a savepoint: an approval that cannot be made leaves the request pending for a
        // person rather than undoing the verification. Default groups that still exist; never
        // grants (a domain is not a person's approval).
        const approved = await tx.transaction((sp) =>
          approveInTx(ctx, sp, pending, {
            workspace: ws,
            actorMembershipId: null,
            groupIds: suggested,
            grants: [],
            expiresInDays: fresh.settings.inviteExpiryDays,
            message: t(facts.locale, "auth.access_request.approved_message", {
              workspace: ws.name,
            }),
            note: null,
            relationship: undefined,
            auto: true,
            existingUserId: facts.userId,
          }),
        );
        return { ok: true as const, outcome: "auto", id: pending.id, created: approved.created };
      } catch (error) {
        log("auth.access_request_auto_failed", {
          level: "warn",
          workspaceId: ws.id,
          accessRequestId: pending.id,
          error: error instanceof AuthError ? error.code : "unknown",
        });
        return { ok: true as const, outcome: "pending", id: pending.id };
      }
    });

    if (result.ok && "created" in result && result.created !== undefined) {
      const created = result.created;
      // Detached like the code mail: the verify answer is "received" either way.
      void sendInviteEmail(
        deps,
        address,
        {
          workspaceId: ws.id,
          workspaceName: ws.name,
          message: created.invite.message,
          locale: facts.locale,
        },
        created.url,
        created.invite.expiresAt,
      ).catch((error: unknown) =>
        log("auth.access_request_mail_failed", {
          level: "warn",
          kind: "invite",
          workspaceId: ws.id,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
    if (result.ok)
      log("auth.access_request_verified", {
        workspaceId: ws.id,
        ...("id" in result ? { accessRequestId: result.id } : {}),
        outcome: result.outcome,
      });
    return result.ok;
  }

  /**
   * Every check an approval can fail, on the caller's transaction, against what the transaction
   * sees (the offering mode is read fresh — S8b). Order: 409 (not pending) → 422 (506(b) without
   * an attestation) → 400 (attested date in the future, C8) → 409 (already a member; a pending
   * invitation, C4) → 404 (an unknown group).
   */
  async function checkApproval(
    ctx: TenantContext,
    tx: Tx,
    row: AccessRequest,
    input: ApproveAccessRequestInput,
    userId: string | undefined,
  ) {
    if (row.status !== "pending")
      throw new AuthError("conflict", `the request is already ${row.status}`, {
        status: row.status,
      });
    const fresh = await freshWorkspace(tx, ctx.workspaceId);
    const rel = input.relationship;
    if (fresh.offeringStatus === "506b" && (rel === undefined || rel.source.trim() === ""))
      throw new AuthError(
        "relationship_attestation_required",
        "under Rule 506(b) an approval must record the pre-existing relationship",
      );
    if (rel !== undefined) {
      const at = rel.establishedAt.getTime();
      if (Number.isNaN(at))
        throw new AuthError("validation_failed", "relationship.establishedAt is not a date");
      if (at > nowOf(deps).getTime() + RELATIONSHIP_FUTURE_SLACK_MS)
        throw new AuthError(
          "validation_failed",
          "relationship.establishedAt is in the future: a pre-existing relationship has a past date",
          { reason: "relationship_in_future" },
        );
    }
    if (userId !== undefined) {
      const m = await new MembershipRepo(ctx, tx).findForUser(userId);
      if (m !== undefined)
        throw new AuthError("conflict", "already a member of this workspace", {
          membershipId: m.id,
          status: m.status,
        });
    }
    if ((await new InviteRepo(ctx, tx).findPendingByEmail(row.email, nowOf(deps))) !== undefined)
      throw new AuthError(
        "conflict",
        "an invitation is already waiting for this address; revoke it or let it be accepted",
        { reason: "invite_pending" },
      );
    const groupIds = [...new Set(input.groupIds)];
    const known = new Set((await new GroupRepo(ctx, tx).byIds(groupIds)).map((g) => g.id));
    for (const id of groupIds) {
      if (!known.has(id)) throw new AuthError("not_found", "no such group", { groupId: id });
    }
    return fresh;
  }

  async function sweepWorkspace(
    workspaceId: string,
    now: Date,
    legalHold: boolean,
  ): Promise<AccessRequestSweepResult> {
    const ctx = systemContext(workspaceId);
    let deleted = 0;
    let expired = 0;
    // Challenges are transient (10 minutes) and never evidence: gone once expired, hold or not.
    for (;;) {
      const n = await deps.db.withTenant(ctx, (tx) =>
        new AccessRequestChallengeRepo(ctx, tx).deleteExpired(now, SWEEP_BATCH),
      );
      deleted += n;
      if (n < SWEEP_BATCH) break;
    }
    for (;;) {
      const ids = await deps.db.withTenant(ctx, async (tx) => {
        const lapsed = await new AccessRequestRepo(ctx, tx).expireOverdue(now, SWEEP_BATCH);
        for (const id of lapsed) {
          await deps.audit.record(tx, ctx, {
            action: "access_request.expired",
            resourceKind: "access_request",
            resourceId: id,
            actorKind: "system",
          });
        }
        return lapsed;
      });
      expired += ids.length;
      if (ids.length < SWEEP_BATCH) break;
    }
    // Retention, like every other trim, waits while the workspace is on legal hold.
    if (!legalHold) {
      const before = new Date(now.getTime() - ACCESS_REQUEST_RETENTION_DAYS * DAY_MS);
      for (;;) {
        const n = await deps.db.withTenant(ctx, (tx) =>
          new AccessRequestRepo(ctx, tx).deleteRetired(before, now, SWEEP_BATCH),
        );
        deleted += n;
        if (n < SWEEP_BATCH) break;
      }
    }
    return { deleted, expired };
  }

  return {
    async start(input) {
      // Computed first, from the instant the call arrived, and the only value the answer carries
      // (S2): no path reads the clock again for it.
      const startedAt = nowOf(deps);
      const expiresAt = new Date(startedAt.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
      const throttled = await withMinimumDuration(ACCESS_REQUEST_START_FLOOR_MS, async () => {
        try {
          return await startInner(input, startedAt, expiresAt);
        } catch (error) {
          // A "no" a stranger can provoke must look like every other answer, errors included.
          log("auth.access_request_start_failed", {
            level: "warn",
            workspaceId: input.workspace.id,
            error: error instanceof Error ? error.name : "unknown",
            code: pgErrorCode(error),
          });
          return null;
        }
      });
      return { expiresAt, throttled };
    },

    async verify(input) {
      return withMinimumDuration(ACCESS_REQUEST_VERIFY_FLOOR_MS, async () => {
        try {
          return { ok: await verifyInner(input) };
        } catch (error) {
          log("auth.access_request_verify_failed", {
            level: "warn",
            workspaceId: input.workspace.id,
            error: error instanceof Error ? error.name : "unknown",
            code: pgErrorCode(error),
          });
          return { ok: false };
        }
      });
    },

    async list(ctx, tx, q) {
      const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 50)));
      let cursor: AccessRequestCursor | undefined;
      if (q.cursor !== undefined && q.cursor !== "") {
        cursor = decodeAccessRequestCursor(q.cursor);
        if (cursor === undefined) throw new AuthError("validation_failed", "bad cursor");
      }
      const rows = await new AccessRequestRepo(ctx, tx).page(q.status, cursor, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await views(
          ctx,
          tx,
          page.map((r) => r.row),
        ),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeAccessRequestCursor({ createdAt: last.cursorCreatedAt, id: last.row.id })
            : null,
      };
    },

    async get(ctx, tx, id) {
      if (!UUID_RE.test(id)) return null;
      const row = await new AccessRequestRepo(ctx, tx).byId(id);
      if (row === undefined) return null;
      const [view] = await views(ctx, tx, [row]);
      return view ?? null;
    },

    async approve(ctx, input) {
      const ws = input.workspace;
      if (ctx.workspaceId !== ws.id || !UUID_RE.test(input.id))
        throw new AuthError("not_found", "no such access request");
      const sys = systemContext(ws.id);
      const peek = await deps.db.withTenant(sys, (tx) =>
        new AccessRequestRepo(sys, tx).byId(input.id),
      );
      if (peek === undefined) throw new AuthError("not_found", "no such access request");
      if (peek.status !== "pending")
        throw new AuthError("conflict", `the request is already ${peek.status}`, {
          status: peek.status,
        });
      const facts = await hostFacts(peek.email, ws.id);
      // Everything that can refuse is checked before anything is spent or written (C7).
      await deps.db.withTenant(sys, (tx) => checkApproval(sys, tx, peek, input, facts.userId));
      await input.beforeWrite?.();
      const message =
        optionalText(input.message, 2000) ??
        t(facts.locale, "auth.access_request.approved_message", { workspace: ws.name });

      const out = await deps.db.withTenant(sys, async (tx) => {
        const row = await new AccessRequestRepo(sys, tx).lockById(input.id);
        if (row === undefined) throw new AuthError("not_found", "no such access request");
        if (row.email !== peek.email)
          throw new AuthError("conflict", `the request is already ${row.status}`, {
            status: row.status,
          });
        // Again under the row lock and then the workspace row lock: the offering mode, the
        // address's standing and the groups are what this transaction sees.
        const fresh = await checkApproval(sys, tx, row, input, facts.userId);
        const approved = await approveInTx(sys, tx, row, {
          workspace: ws,
          actorMembershipId: input.actorMembershipId,
          groupIds: input.groupIds,
          grants: input.grants ?? [],
          expiresInDays: input.expiresInDays ?? fresh.settings.inviteExpiryDays,
          message,
          note: optionalText(input.note, 2000),
          relationship: input.relationship,
          auto: false,
          existingUserId: facts.userId,
          requestId: input.requestId,
        });
        const [view] = await views(sys, tx, [approved.row]);
        return { view, created: approved.created };
      });
      if (out.view === undefined) throw new AuthError("not_found", "no such access request");
      // After commit: a failed mail never turns a committed approval into an error (C3).
      let mailSent = true;
      try {
        await sendInviteEmail(
          deps,
          peek.email,
          {
            workspaceId: ws.id,
            workspaceName: ws.name,
            inviterName: input.actorName,
            message,
            locale: facts.locale,
          },
          out.created.url,
          out.created.invite.expiresAt,
        );
      } catch (error) {
        mailSent = false;
        log("auth.access_request_mail_failed", {
          level: "warn",
          kind: "invite",
          workspaceId: ws.id,
          accessRequestId: input.id,
          error:
            error instanceof AuthError
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown",
        });
      }
      log("auth.access_request_approved", {
        workspaceId: ws.id,
        accessRequestId: input.id,
        inviteId: out.created.invite.id,
        mailSent,
      });
      return { request: out.view, invite: out.created.invite, mailSent };
    },

    async deny(ctx, input) {
      const ws = input.workspace;
      if (ctx.workspaceId !== ws.id || !UUID_RE.test(input.id))
        throw new AuthError("not_found", "no such access request");
      const sys = systemContext(ws.id);
      const now = nowOf(deps);
      const view = await deps.db.withTenant(sys, async (tx) => {
        const repo = new AccessRequestRepo(sys, tx);
        const row = await repo.lockById(input.id);
        if (row === undefined) throw new AuthError("not_found", "no such access request");
        if (row.status !== "pending")
          throw new AuthError("conflict", `the request is already ${row.status}`, {
            status: row.status,
          });
        const denied = await repo.update(row.id, {
          status: "denied",
          decidedAt: now,
          decidedBy: input.actorMembershipId,
          decisionNote: optionalText(input.note, 2000),
        });
        if (denied === undefined) throw new AuthError("not_found", "no such access request");
        await deps.audit.record(tx, sys, {
          action: "access_request.denied",
          resourceKind: "access_request",
          resourceId: row.id,
          actorKind: "staff",
          actorMembershipId: input.actorMembershipId,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          meta: { notified: input.notifyRequester },
        });
        await publish(tx, sys, "access_request.decided", {
          accessRequestId: row.id,
          decision: "denied",
          auto: false,
        });
        const [v] = await views(sys, tx, [denied]);
        return v;
      });
      if (view === undefined) throw new AuthError("not_found", "no such access request");
      if (input.notifyRequester) {
        // After commit, and a failure never undoes the decision: it is logged for ops.
        try {
          const locale = await deps.db.withHost((tx) =>
            recipientLocale(tx, { email: view.email, workspaceId: ws.id }),
          );
          await deps.mailer.send(
            accessRequestDeniedEmail(view.email, {
              productName: deps.productName,
              workspaceId: ws.id,
              workspaceName: ws.name,
              locale,
            }),
          );
        } catch (error) {
          log("auth.access_request_mail_failed", {
            level: "warn",
            kind: "denied",
            workspaceId: ws.id,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      return { request: view };
    },

    async sweep(at) {
      const now = at ?? nowOf(deps);
      let deleted = 0;
      let expired = 0;
      let workspaces = 0;
      for (const workspaceId of await listLiveWorkspaceIds(deps.db)) {
        if (isPlatformWorkspace(workspaceId)) continue;
        const ws = await findWorkspaceById(deps.db, workspaceId);
        if (ws === undefined) continue;
        workspaces += 1;
        const r = await sweepWorkspace(
          workspaceId,
          now,
          parseWorkspaceSettings(ws.settings).legal.legalHold,
        );
        deleted += r.deleted;
        expired += r.expired;
      }
      log("auth.access_requests_swept", { workspaces, deleted, expired });
      return { deleted, expired };
    },
  };
}

export interface AccessRequestJobOptions {
  readonly service: Pick<AccessRequestService, "sweep">;
  readonly now?: (() => Date) | undefined;
}

/** `access-requests.sweep`, hourly (kernel job; the composition root adds it to its list). */
export function createAccessRequestJobs(options: AccessRequestJobOptions): JobDefinition[] {
  return [
    {
      name: "access-requests.sweep",
      cron: "23 * * * *",
      handler: async () => {
        await options.service.sweep(options.now?.());
      },
    },
  ] satisfies JobDefinition<JsonObject>[];
}
