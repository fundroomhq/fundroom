import { membershipExpired } from "@fundroom/authz";
import { findWorkspaceById, type Membership, type ResolvedWorkspace, type Tx } from "@fundroom/db";
import type { AuthenticatedSession, AuthLevel } from "@fundroom/ports";
import { open, seal } from "../crypto/secretbox.js";
import { randomToken, safeEqual, sha256 } from "../crypto/tokens.js";
import { consumeCentralChallenge, recordHandoffSession } from "../repos/central-auth-repo.js";
import {
  findChallengeById,
  findChallengeBySecretHash,
  insertChallenge,
} from "../repos/challenge-repo.js";
import { listWorkspaceMembershipsForUser } from "../repos/membership-repo.js";
import { findSessionById, touchSession } from "../repos/session-repo.js";
import { isSessionLive, type SessionService, type StartedSession } from "./sessions.js";
import { type IdentityDeps, nowOf } from "./types.js";

/*
 * Central auth origin (E3.10, ADR-0058; contract §5.6 + §7b).
 *
 * With CENTRAL_AUTH=on the canonical host (`BASE_URL`) is where people sign in, and a workspace
 * host — a verified custom domain, or `<slug>.<canonical>` — gets its own first-party session by a
 * one-time code, the OAuth authorization-code + PKCE shape (RFC 7636, RFC 9700) with the canonical
 * host as the authorization server and each workspace host as a pre-registered client:
 *
 *  1. `start` (workspace host): a `central_request` challenge, 10 min. Its secret is the `req`
 *     token in the redirect; a random verifier goes into the host-only `__Host-auth_creq` cookie on
 *     the workspace host and only its SHA-256 is stored (`binding_hash`). The sealed payload names
 *     the workspace, the EXACT origin the browser is on (checked against the workspace's own
 *     origins), where to land, and — for a re-authentication — whose session asked.
 *  2. `authorize` (canonical host): opens the request WITHOUT consuming it, re-checks the origin
 *     against the workspace's origins as they are now, and with a canonical session checks that
 *     its user is a live member. Not a member: back to the origin with `error=no_access` and
 *     nothing written. Enforced SSO for staff: to the workspace's own SSO sign-in. Otherwise a
 *     `central_handoff` challenge, 60 s, single use, carrying the request's binding hash and the
 *     source session's facts, and a 303 to the origin's finish with the code.
 *  3. `finish` (workspace host): the verifier's hash must match the handoff (checked BEFORE
 *     anything is consumed, so a stolen code alone cannot even burn it), the handoff must name
 *     this origin; then the handoff and its request are consumed in ONE transaction, the source
 *     session must still be live, the membership is re-checked, and a session BOUND to the
 *     workspace is minted with the source's auth level and auth time — never upgraded, never
 *     fresher. After the mint both are checked once more (a revocation that raced the mint revokes
 *     the new session), as the SSO finish does.
 *
 * The code goes to a host whose DNS the tenant may control (a custom domain), so everything a
 * session minted here can do is bounded by the binding: it serves this workspace only and cannot
 * read or change the global account (`bound_session_restricted`). A replay of a redeemed handoff
 * WITH the verifier (so the browser's cookie leaked too) revokes the session it minted.
 *
 * Nothing here knows the install's host layout: `originsOf` (the composition root's) says which
 * origins are a workspace's own. Transactions are short and host-context; nothing is held open
 * across a network call (there is none).
 */

export const CENTRAL_REQUEST_TTL_MS = 10 * 60_000;
/** §7b: 60 s (the contract body's two minutes was shortened after vendor research). */
export const CENTRAL_HANDOFF_TTL_MS = 60_000;
/** A re-authentication (step-up through central auth) needs a canonical proof this recent. */
export const CENTRAL_REAUTH_MAX_AGE_MS = 5 * 60_000;
/** Anonymous `start` writes a row, so it is budgeted per client address. */
export const CENTRAL_START_RATE_LIMIT = { max: 30, windowMs: 60_000 } as const;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
const LIVE_STATUSES: ReadonlySet<Membership["status"]> = new Set(["active", "dormant"]);

/**
 * Why a sign-in went back to the workspace host without a session. These are the ONLY values that
 * reach `/login?error=` there (the route maps anything else to `expired`).
 */
export type CentralAuthErrorCode =
  | "no_access"
  | "expired"
  | "binding_mismatch"
  | "reauth_mismatch"
  | "session_ended";

export const CENTRAL_AUTH_ERROR_CODES: readonly CentralAuthErrorCode[] = [
  "no_access",
  "expired",
  "binding_mismatch",
  "reauth_mismatch",
  "session_ended",
];

/** What `start` seals into the request (AAD: `central-req:<token>`). */
interface RequestPayload {
  readonly v: 1;
  readonly workspaceId: string;
  readonly origin: string;
  readonly returnPath: string;
  readonly reauth: boolean;
  /** Re-authentication: the user whose workspace-host session asked; authorize must match it. */
  readonly reauthUserId?: string | undefined;
  /**
   * E-UP-18: the canonical session must be at least this level, or authorize sends it to step up
   * first. Absent (and in every request sealed before E-UP-18) means no minimum.
   */
  readonly minLevel?: 2 | undefined;
}

/** What `authorize` seals into the handoff (AAD: `central-handoff:<code>`). */
interface HandoffPayload {
  readonly v: 1;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly origin: string;
  readonly returnPath: string;
  readonly reauth: boolean;
  readonly userId: string;
  /** The canonical (source) session. */
  readonly sessionId: string;
  readonly authLevel: AuthLevel;
  /** The source session's `authTime`, epoch ms. */
  readonly authTime: number;
}

export interface CentralAuthOptions {
  /**
   * The origins (`scheme://host[:port]`, lower-case) that are this workspace's own workspace
   * hosts: its `<slug>.<canonical>` host and its ACTIVE primary custom domain. Anything else —
   * the canonical host, a `pending`/`dns_ok` custom domain, another workspace's host — is refused.
   */
  readonly originsOf: (workspace: ResolvedWorkspace) => readonly string[];
}

export interface CentralStartInput {
  readonly workspace: ResolvedWorkspace;
  /** The exact origin of the request (`scheme://host[:port]`). */
  readonly origin: string;
  /** Already validated (`safeReturnPath`); relative to the base path. */
  readonly returnPath: string;
  readonly reauth: boolean;
  /** Re-authentication: the user of the session the workspace host holds now, if any. */
  readonly reauthUserId?: string | undefined;
  /**
   * E-UP-18: the auth level the canonical session must reach (`centralMinLevel`). Only 2 is a
   * minimum; anything lower means none.
   */
  readonly minLevel?: AuthLevel | undefined;
  readonly ip?: string | undefined;
}

export type CentralStartResult =
  | {
      readonly ok: true;
      readonly requestToken: string;
      /** The cookie value; its hash is the request's binding. */
      readonly verifier: string;
      readonly maxAgeSeconds: number;
    }
  | {
      readonly ok: false;
      readonly code: "origin" | "rate_limited";
      readonly retryAfterMs?: number;
    };

export type CentralAuthorizeOutcome =
  /** Nothing trustworthy to answer with (unknown, forged, or no longer valid for its origin). */
  | { readonly kind: "invalid" }
  /** No canonical session: sign in on the canonical host first, then come back. */
  | { readonly kind: "sign_in" }
  /**
   * Step up on the canonical host first: `fresh` — a re-authentication whose canonical proof is
   * older than 5 min; `level` — the request names a minimum level the canonical session is below
   * (that step-up also refreshes the proof, so it wins when both apply).
   */
  | { readonly kind: "step_up"; readonly reason: "fresh" | "level" }
  /** Back to the workspace host's finish with an error (nothing written anywhere). */
  | { readonly kind: "back"; readonly origin: string; readonly error: CentralAuthErrorCode }
  /** Staff of an SSO-enforced workspace: its own SSO sign-in on the workspace host. */
  | { readonly kind: "sso"; readonly origin: string }
  /** The handoff: 303 to `origin/auth/central/finish?code=`. */
  | { readonly kind: "code"; readonly origin: string; readonly code: string };

export interface CentralFinishInput {
  readonly code: string;
  /** `__Host-auth_creq` as the browser sent it (undefined when absent). */
  readonly verifier: string | undefined;
  /** The workspace this host resolved to. */
  readonly workspaceId: string;
  readonly workspaceName?: string | undefined;
  /** The exact origin of this request. */
  readonly origin: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly deviceToken?: string | undefined;
  /** The workspace-host session this browser holds now, replaced by the new one (ASVS 7.2.4). */
  readonly replacesSessionId?: string | undefined;
}

export type CentralFinishOutcome =
  | {
      readonly kind: "session";
      readonly started: StartedSession;
      readonly returnPath: string;
    }
  | { readonly kind: "error"; readonly code: CentralAuthErrorCode };

export interface CentralAuthService {
  start(input: CentralStartInput): Promise<CentralStartResult>;
  authorize(input: {
    readonly requestToken: string;
    /** The canonical host's session (unbound: the middleware never admits a bound one there). */
    readonly session: AuthenticatedSession | undefined;
  }): Promise<CentralAuthorizeOutcome>;
  finish(input: CentralFinishInput): Promise<CentralFinishOutcome>;
}

/** A live membership (`membershipIsLive` in the server's auth middleware, stated again here). */
function isLive(m: Pick<Membership, "status" | "expiresAt">, at: Date): boolean {
  return LIVE_STATUSES.has(m.status) && !membershipExpired(m.expiresAt, at);
}

/**
 * Enforced SSO (E3.8 decision 8, `ssoBlocks` in the server middleware): staff of an enforced
 * workspace sign in through its IdP, except an owner at auth level 2 (break-glass). A canonical
 * session is never SSO-bound, so the binding clause of `ssoBlocks` cannot apply here.
 */
function ssoRequired(
  ws: Pick<ResolvedWorkspace, "ssoEnforced">,
  m: Pick<Membership, "kind" | "role">,
  authLevel: AuthLevel,
): boolean {
  if (!ws.ssoEnforced || m.kind !== "staff") return false;
  return !(m.role === "owner" && authLevel >= 2);
}

/**
 * E-UP-18 (D1): the minimum level a central sign-in asks of the canonical session. A
 * re-authentication never hands back less than the workspace-host session already has (re-auth
 * for freshness must not downgrade a level-2 session); `level=2` asks for 2 outright. The query
 * can only raise the minimum, never lower it, and nothing above 2 exists.
 */
export function centralMinLevel(input: {
  readonly reauth: boolean;
  /** The workspace-host session's level, when a re-authentication has one. */
  readonly currentLevel?: AuthLevel | undefined;
  /** The raw `level` query: only "2" means anything. */
  readonly levelQuery?: string | undefined;
}): AuthLevel | undefined {
  const asked = input.levelQuery === "2" ? 2 : 0;
  const held = input.reauth ? (input.currentLevel ?? 0) : 0;
  const min = Math.min(Math.max(asked, held), 2);
  return min > 0 ? (min as AuthLevel) : undefined;
}

class Rollback extends Error {}

export function createCentralAuthService(
  deps: IdentityDeps,
  sessions: SessionService,
  options: CentralAuthOptions,
): CentralAuthService {
  const { db } = deps;
  const log = deps.log ?? (() => {});

  function sealJson(payload: object, aad: string): string {
    return seal(deps.keyRing, Buffer.from(JSON.stringify(payload), "utf8"), aad);
  }

  function openJson<T>(sealed: unknown, aad: string): T | undefined {
    if (typeof sealed !== "string") return undefined;
    try {
      return JSON.parse(Buffer.from(open(deps.keyRing, sealed, aad)).toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }

  function ownOrigin(ws: ResolvedWorkspace, origin: string): boolean {
    return options.originsOf(ws).includes(origin);
  }

  /** The user's live membership in `workspaceId` (the same fenced host read the middleware does). */
  async function liveMembership(userId: string, workspaceId: string, at: Date) {
    const rows = await db.withHost((tx) => listWorkspaceMembershipsForUser(tx, userId), {
      actorKind: "host",
      userId,
    });
    return rows.find((m) => m.workspaceId === workspaceId && isLive(m, at));
  }

  /** The source session, if it is still live, still the user's and still unbound. */
  async function liveSource(tx: Tx, sessionId: string, userId: string, at: Date) {
    const row = await findSessionById(tx, sessionId);
    return row !== undefined &&
      row.userId === userId &&
      isSessionLive(row, at) &&
      row.ssoWorkspaceId === null &&
      row.boundWorkspaceId === null &&
      row.population !== "operator"
      ? row
      : undefined;
  }

  return {
    async start(input) {
      const ws = input.workspace;
      if (!ownOrigin(ws, input.origin)) return { ok: false, code: "origin" };
      if (input.ip !== undefined) {
        const budget = await deps.rateLimiter.hit(
          `central:start:ip:${input.ip}`,
          CENTRAL_START_RATE_LIMIT,
        );
        if (!budget.allowed) {
          return { ok: false, code: "rate_limited", retryAfterMs: budget.retryAfterMs };
        }
      }
      const at = nowOf(deps);
      const requestToken = randomToken(32);
      const verifier = randomToken(32);
      const payload: RequestPayload = {
        v: 1,
        workspaceId: ws.id,
        origin: input.origin,
        returnPath: input.returnPath,
        reauth: input.reauth,
        ...(input.reauth && input.reauthUserId !== undefined
          ? { reauthUserId: input.reauthUserId }
          : {}),
        // Level 1 is what every canonical session already has, so only 2 is sealed.
        ...(input.minLevel === 2 ? { minLevel: 2 } : {}),
      };
      await db.withHost((tx) =>
        insertChallenge(tx, {
          kind: "central_request",
          workspaceId: ws.id,
          secretHash: sha256(requestToken),
          bindingHash: sha256(verifier),
          data: { sealed: sealJson(payload, `central-req:${requestToken}`) },
          maxAttempts: 1,
          ip: input.ip ?? null,
          createdAt: at,
          expiresAt: new Date(at.getTime() + CENTRAL_REQUEST_TTL_MS),
        }),
      );
      return {
        ok: true,
        requestToken,
        verifier,
        maxAgeSeconds: Math.ceil(CENTRAL_REQUEST_TTL_MS / 1000),
      };
    },

    async authorize({ requestToken, session }) {
      if (typeof requestToken !== "string" || !TOKEN_RE.test(requestToken)) {
        return { kind: "invalid" };
      }
      const at = nowOf(deps);
      const request = await db.withHost((tx) =>
        findChallengeBySecretHash(tx, "central_request", sha256(requestToken)),
      );
      if (request === undefined || request.bindingHash === null) return { kind: "invalid" };
      const payload = openJson<RequestPayload>(
        (request.data as { sealed?: unknown }).sealed,
        `central-req:${requestToken}`,
      );
      if (payload === undefined || payload.v !== 1 || payload.workspaceId !== request.workspaceId) {
        return { kind: "invalid" };
      }
      // The origin is ours (sealed), but whether it is STILL the workspace's is a fact of now: a
      // custom domain removed or demoted since start gets nothing, not even an error redirect.
      const ws = await findWorkspaceById(db, payload.workspaceId);
      if (ws === undefined || !ownOrigin(ws, payload.origin)) return { kind: "invalid" };
      const back = (error: CentralAuthErrorCode): CentralAuthorizeOutcome => ({
        kind: "back",
        origin: payload.origin,
        error,
      });
      if (request.consumedAt !== null || request.expiresAt.getTime() <= at.getTime()) {
        return back("expired");
      }
      if (session === undefined) return { kind: "sign_in" };
      if (payload.reauth) {
        if (payload.reauthUserId !== undefined && payload.reauthUserId !== session.userId) {
          return back("reauth_mismatch");
        }
      }
      // Who may come in at all is decided before any step-up (E-UP-18 fix round 1): a non-member,
      // or staff the workspace sends through its IdP, would otherwise prove a level or enrol a
      // factor here only to be turned away or signed in by SSO at that IdP's level anyway.
      // No row is written on this path: the workspace learns only what the redirect says, and a
      // browser without an account there is told the same thing as one with a revoked seat.
      const membership = await liveMembership(session.userId, ws.id, at);
      if (membership === undefined) return back("no_access");
      // Enforced SSO for staff other than an owner: no level here exempts them (`ssoRequired`).
      // An owner's break-glass needs level 2, so an owner still steps up below.
      if (ws.ssoEnforced && membership.kind === "staff" && membership.role !== "owner") {
        return { kind: "sso", origin: payload.origin };
      }
      // The level before the age: a step-up to it also refreshes the proof, so it answers both.
      if (payload.minLevel === 2 && session.authLevel < 2) {
        return { kind: "step_up", reason: "level" };
      }
      if (payload.reauth && at.getTime() - session.authTime.getTime() > CENTRAL_REAUTH_MAX_AGE_MS) {
        return { kind: "step_up", reason: "fresh" };
      }
      if (ssoRequired(ws, membership, session.authLevel)) {
        return { kind: "sso", origin: payload.origin };
      }

      const code = randomToken(32);
      const handoff: HandoffPayload = {
        v: 1,
        requestId: request.id,
        workspaceId: ws.id,
        origin: payload.origin,
        returnPath: payload.returnPath,
        reauth: payload.reauth,
        userId: session.userId,
        sessionId: session.sessionId,
        authLevel: session.authLevel,
        authTime: session.authTime.getTime(),
      };
      await db.withHost((tx) =>
        insertChallenge(tx, {
          kind: "central_handoff",
          workspaceId: ws.id,
          userId: session.userId,
          secretHash: sha256(code),
          bindingHash: request.bindingHash,
          data: { sealed: sealJson(handoff, `central-handoff:${code}`) },
          maxAttempts: 1,
          createdAt: at,
          expiresAt: new Date(at.getTime() + CENTRAL_HANDOFF_TTL_MS),
        }),
      );
      log("auth.central_authorized", {
        workspaceId: ws.id,
        reauth: payload.reauth,
        ...(payload.minLevel === undefined ? {} : { minLevel: payload.minLevel }),
      });
      return { kind: "code", origin: payload.origin, code };
    },

    async finish(input) {
      const refuse = (code: CentralAuthErrorCode): CentralFinishOutcome => {
        log("auth.central_finish_refused", { code, workspaceId: input.workspaceId });
        return { kind: "error", code };
      };
      if (typeof input.code !== "string" || !TOKEN_RE.test(input.code)) return refuse("expired");
      const at = nowOf(deps);

      type Taken =
        | { readonly ok: true; readonly id: string; readonly payload: HandoffPayload }
        | { readonly ok: false; readonly error: CentralAuthErrorCode; readonly replayOf?: string };
      let taken: Taken;
      try {
        taken = await db.withHost(async (tx): Promise<Taken> => {
          const ch = await findChallengeBySecretHash(tx, "central_handoff", sha256(input.code));
          if (ch === undefined || ch.bindingHash === null) return { ok: false, error: "expired" };
          // The verifier first, before consumption or expiry is even looked at: a code without
          // the browser that began the sign-in must not be able to burn it or learn its state.
          const bound =
            input.verifier !== undefined &&
            safeEqual(sha256(input.verifier), ch.bindingHash) &&
            ch.workspaceId === input.workspaceId;
          if (!bound) return { ok: false, error: "binding_mismatch" };
          if (ch.consumedAt !== null) {
            // Presented again WITH its verifier: the code and the cookie both leaked. Whatever
            // session the first redemption minted is revoked (RFC 9700 §4.1.1).
            const minted = (ch.data as { minted?: unknown }).minted;
            return {
              ok: false,
              error: "expired",
              ...(typeof minted === "string" ? { replayOf: minted } : {}),
            };
          }
          if (ch.expiresAt.getTime() <= at.getTime()) return { ok: false, error: "expired" };
          const payload = openJson<HandoffPayload>(
            (ch.data as { sealed?: unknown }).sealed,
            `central-handoff:${input.code}`,
          );
          if (
            payload === undefined ||
            payload.v !== 1 ||
            payload.workspaceId !== ch.workspaceId ||
            payload.userId !== ch.userId
          ) {
            return { ok: false, error: "expired" };
          }
          // The code was minted for one origin; a finish on any other host of the same workspace
          // (its slug host vs its custom domain) is not the browser that asked.
          if (payload.origin !== input.origin) return { ok: false, error: "binding_mismatch" };
          const request = await findChallengeById(tx, payload.requestId);
          if (
            request === undefined ||
            request.kind !== "central_request" ||
            request.workspaceId !== ch.workspaceId ||
            request.bindingHash === null ||
            !safeEqual(request.bindingHash, ch.bindingHash)
          ) {
            return { ok: false, error: "binding_mismatch" };
          }
          // One transaction, both or neither: two finishes racing on one handoff (or two
          // handoffs of one request) produce exactly one session.
          if (!(await consumeCentralChallenge(tx, ch.id, "central_handoff", at))) {
            throw new Rollback("handoff consumed");
          }
          if (!(await consumeCentralChallenge(tx, request.id, "central_request", at))) {
            throw new Rollback("request consumed");
          }
          // The source must still be live now — a sign-out between authorize and here ends it.
          // The code is burned either way (the consumption above commits with this answer).
          const source = await liveSource(tx, payload.sessionId, payload.userId, at);
          if (source === undefined) return { ok: false, error: "session_ended" };
          // The handoff is a use of the source session: mark it seen. (The mint below no longer
          // counts the source against any cap — bound sessions have their own, FR1 — but a
          // canonical login's cap goes least recently seen first, and this was a use.)
          await touchSession(tx, source.id, {
            lastSeenAt: at,
            idleExpiresAt: source.idleExpiresAt,
          });
          return { ok: true, id: ch.id, payload };
        });
      } catch (error) {
        if (!(error instanceof Rollback)) throw error;
        taken = { ok: false, error: "expired" };
      }
      if (!taken.ok) {
        if (taken.replayOf !== undefined) {
          log("auth.central_handoff_replayed", { level: "warn", workspaceId: input.workspaceId });
          await sessions.revokeSession(taken.replayOf, "suspicious");
        }
        return refuse(taken.error);
      }
      const facts = taken.payload;
      const handoffId = taken.id;

      const membership = await liveMembership(facts.userId, facts.workspaceId, at);
      if (membership === undefined) return refuse("no_access");

      const started = await sessions.startSession({
        userId: facts.userId,
        population: membership.kind === "staff" ? "staff" : "external",
        context: "first_party",
        // Never upgraded: the handoff proves exactly what the source session proved.
        authLevel: Math.min(facts.authLevel, 2) as AuthLevel,
        // Never fresher: `startSession` clamps to now, and a proof made on the canonical host at
        // T is still a proof made at T here.
        authTime: new Date(facts.authTime),
        ip: input.ip,
        userAgent: input.userAgent,
        deviceToken: input.deviceToken,
        rememberDevice: false,
        workspaceId: facts.workspaceId,
        workspaceName: input.workspaceName,
        replacesSessionId: input.replacesSessionId,
        boundWorkspaceId: facts.workspaceId,
        // FR1 R2-L1: signing the canonical session out ends this one too.
        sourceSessionId: facts.sessionId,
      });
      const sessionId = started.session.sessionId;

      // A revocation (source signed out, seat revoked) may have landed between the checks above
      // and the mint: look again now the new row exists, and take it back if so. Anything that
      // lands after this sees the new row itself (membership revocation revokes the user's
      // sessions in that workspace).
      const sourceStill = await db.withHost(
        async (tx) =>
          (await liveSource(tx, facts.sessionId, facts.userId, nowOf(deps))) !== undefined,
      );
      const still =
        sourceStill &&
        (await liveMembership(facts.userId, facts.workspaceId, nowOf(deps))) !== undefined;
      if (!still) {
        await sessions.revokeSession(sessionId, "membership_revoked");
        return refuse("session_ended");
      }
      await db.withHost((tx) => recordHandoffSession(tx, handoffId, sessionId));

      try {
        await deps.audit.recordDetached(
          {
            workspaceId: facts.workspaceId,
            actorKind: membership.kind,
            membershipId: membership.id,
            userId: facts.userId,
          },
          {
            action: "session.central_handoff",
            resourceKind: "session",
            resourceId: sessionId,
            sessionId,
            actorUserId: facts.userId,
            subjectMembershipId: membership.id,
            ip: input.ip,
            userAgent: input.userAgent,
            meta: {
              authLevel: started.session.authLevel,
              population: started.session.population,
              reauth: facts.reauth,
              newDevice: started.isNewDevice,
            },
          },
        );
      } catch (error) {
        // The sign-in happened; a failed audit write is for ops, not a 500 for the user.
        log("auth.audit_failed", { action: "session.central_handoff", error: String(error) });
      }
      log("auth.central_handoff", { workspaceId: facts.workspaceId, reauth: facts.reauth });
      return { kind: "session", started, returnPath: facts.returnPath };
    },
  };
}
