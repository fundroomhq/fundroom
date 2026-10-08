import { platformContext, type Session, systemContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type {
  AuthenticatedSession,
  AuthLevel,
  AuthPopulation,
  AuthPort,
  SessionCookieContext,
  SessionViewAs,
  SsoBinding,
} from "@fundroom/ports";
import { randomToken, safeEqual, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { describeUserAgent, newDeviceEmail } from "../mail/templates.js";
import {
  BOUND_SESSION_MAX_CONCURRENT,
  resolveLifetimes,
  SESSION_TOUCH_INTERVAL_MS,
} from "../policy/lifetimes.js";
import {
  countDevicesForUser,
  findDeviceByTokenHash,
  insertDevice,
  listDevicesForUser,
  renameDevice,
  revokeDevice,
  touchDevice,
} from "../repos/device-repo.js";
import { listWorkspaceMembershipsForUser } from "../repos/membership-repo.js";
import {
  clearRevokeToken,
  deleteDeadSessions,
  findSessionById,
  findSessionByRevokeTokenHash,
  findSessionByTokenHash,
  insertSession,
  listSessionsForUser,
  lockLiveSession,
  reparentDerivedSessions,
  revokeDerivedSessions,
  revokeSession,
  revokeSessionsBeyond,
  revokeSessionsForDevice,
  revokeSessionsForSsoConnection,
  revokeSessionsForUser,
  revokeSessionsForWorkspace,
  type SessionWithUser,
  setSessionAuth,
  setSessionViewAs,
  setSessionWorkspace,
  ssoBindingOf,
  touchSession,
  viewAsOf,
} from "../repos/session-repo.js";
import { bumpSessionVersion, findUserById, primaryEmail } from "../repos/user-repo.js";
import { recipientLocale } from "./recipient-locale.js";
import { absoluteUrl, type IdentityDeps, nowOf, pathsOf } from "./types.js";

export interface StartSessionInput {
  readonly userId: string;
  readonly population: AuthPopulation;
  readonly context: SessionCookieContext;
  readonly authLevel: AuthLevel;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly topSite?: string | undefined;
  readonly deviceToken?: string | undefined;
  readonly rememberDevice?: boolean | undefined;
  readonly workspaceId?: string | undefined;
  readonly workspaceName?: string | undefined;
  /**
   * The live session the browser's cookie named when this login began (ASVS 7.2.4, F-12). A
   * fresh login overwrites that cookie, so the old row would otherwise stay valid for anyone
   * who copied the token; it is revoked (reason `replaced`) once the new session exists.
   */
  readonly replacesSessionId?: string | undefined;
  /**
   * Staff SSO (E3.8): the workspace connection that asserted this login. The session is then
   * bound to `sso.workspaceId` — ignored (not revoked) on any other workspace — and must be
   * started for that workspace (`workspaceId === sso.workspaceId`).
   */
  readonly sso?: SsoBinding | undefined;
  /**
   * Central auth (E3.10): the workspace a handoff minted this session for. Like `sso`, the
   * session then serves that workspace only and may not change the global account; it must be
   * started for that workspace, never with `sso`, and never for the operator population.
   */
  readonly boundWorkspaceId?: string | undefined;
  /**
   * The live session this one was minted from (E3.10 FR1, R2-L1): the canonical session behind a
   * central-auth handoff or an operator mint. Revoking that source (sign-out, a revoke by id, the
   * new-device link) revokes this one too.
   */
  readonly sourceSessionId?: string | undefined;
  /**
   * When the user actually authenticated, if the credential says so and it is earlier than now
   * (E3.8 FR5: an SSO login takes the IdP's `auth_time` / `AuthnInstant`, so a silent answer from
   * the IdP's own old session does not make the session fresh). Clamped to now. Default: now.
   */
  readonly authTime?: Date | undefined;
}

export interface StartedSession {
  readonly token: string;
  readonly deviceToken: string;
  readonly session: AuthenticatedSession;
  readonly isNewDevice: boolean;
}

export interface SessionSummary {
  readonly id: string;
  readonly deviceId: string | undefined;
  readonly deviceName: string;
  readonly device: string;
  readonly ip: string | undefined;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly authLevel: AuthLevel;
  readonly context: SessionCookieContext;
  readonly current: boolean;
}

export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly device: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly trusted: boolean;
}

/** Why a view as an investor ended (audit `meta.reason`). */
export type ViewAsEndReason =
  | "exited"
  | "expired"
  | "replaced"
  | "target_unavailable"
  | "staff_unauthorized";

export interface StartViewAsInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The staff membership starting the view (audit actor). */
  readonly staffMembershipId: string;
  /** The external membership to view as (the caller has checked it is live and external). */
  readonly targetMembershipId: string;
  /** Staff-authored free text, kept in the audit row. */
  readonly reason: string;
  readonly ttlMs: number;
  readonly requestId?: string | undefined;
}

export interface EndViewAsInput {
  readonly sessionId: string;
  readonly reason: ViewAsEndReason;
  /**
   * Clear only if the session still holds exactly this view (lazy expiry from concurrent
   * requests must end it — and audit it — once).
   */
  readonly expected?: Pick<SessionViewAs, "workspaceId" | "membershipId" | "startedAt"> | undefined;
  readonly requestId?: string | undefined;
}

export interface SessionService extends AuthPort {
  startSession(input: StartSessionInput): Promise<StartedSession>;
  listSessions(userId: string, currentSessionId?: string): Promise<SessionSummary[]>;
  listDevices(userId: string): Promise<DeviceSummary[]>;
  renameDevice(userId: string, deviceId: string, name: string): Promise<boolean>;
  /** Revokes the device and every session minted on it. */
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;
  /** The one-click link from the new-device email: revokes that session and its device. */
  revokeByToken(revokeToken: string): Promise<boolean>;
  /**
   * Records a fresh proof at `level` (TOTP, passkey re-auth) for step-up, and audits it
   * (`auth.step_up`, F-10). `method` names the proof for the audit row.
   *
   * The session token is rotated (F-12, ASVS 7.2.4): the old cookie value stops working the
   * moment this returns, and the caller must re-issue the cookie with `token`.
   *
   * Concurrent step-ups on one session (E2.10 R1-04) are serialised on the session row. Pass
   * `presentedToken` (the cookie value the request authenticated with): when another step-up
   * already rotated the token away from it, this one only records its proof and hands back no
   * token, so the browser keeps the winner's cookie instead of ending up with whichever
   * `Set-Cookie` arrived last — possibly a token the other request had already replaced.
   */
  stepUp(
    sessionId: string,
    level: AuthLevel,
    method?: StepUpMethod,
    options?: { readonly presentedToken?: string | undefined },
  ): Promise<StepUpResult>;
  /**
   * Signs out every other live session of the user (a factor changed: whoever held one of them
   * may be the reason). Audited as `auth.sessions_revoked_all` with `meta.keptCurrent`.
   */
  revokeOtherSessions(
    userId: string,
    keepSessionId: string | undefined,
    reason: string,
  ): Promise<number>;
  /** Cleanup for the E0.4 maintenance job. */
  sweep(): Promise<number>;
  /**
   * View as investor (E2.7): stores the view on the session (replacing — and auditing the end
   * of — any view already held) and audits `access.view_as_started`. Returns the new state.
   */
  startViewAs(input: StartViewAsInput): Promise<SessionViewAs>;
  /** Clears the session's view and audits `access.view_as_ended`; undefined if nothing ended. */
  endViewAs(input: EndViewAsInput): Promise<SessionViewAs | undefined>;
  /**
   * Revokes every live session one SSO connection minted (E3.8: the connection was deleted) and
   * returns how many. Its own host transaction: call it after the deleting transaction commits.
   */
  revokeSessionsForSsoConnection(connectionId: string, reason: string): Promise<number>;
}

/** A step-up's new session token (F-12): the route re-issues the session cookie with it. */
export interface StepUpResult {
  /**
   * The new session token; undefined when a concurrent step-up rotated the session first
   * (R1-04). Then the cookie the browser gets from that other response is the live one, and
   * this response must not overwrite it.
   */
  readonly token: string | undefined;
  /**
   * When the re-issued cookie should expire: the session's absolute expiry on a remembered
   * (trusted) device, otherwise undefined (a browser-session cookie), as at login.
   */
  readonly persistUntil: Date | undefined;
}

/** How a step-up was proved (audit `meta.method`). */
export type StepUpMethod =
  | "totp"
  | "totp_enrolment"
  /** E-UP-18: registering a passkey with user verification (a possession + inherence proof). */
  | "passkey_registration"
  | "recovery_code"
  | "passkey"
  | "password"
  | "unspecified";

function toAuthenticated(row: SessionWithUser): AuthenticatedSession {
  return {
    sessionId: row.id,
    userId: row.userId,
    deviceId: row.deviceId ?? undefined,
    population: row.population,
    context: row.context,
    authLevel: row.authLevel as AuthLevel,
    authTime: row.authTime,
    createdAt: row.createdAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    lastWorkspaceId: row.lastWorkspaceId ?? undefined,
    user: { displayName: row.displayName, mfaEnrolled: row.mfaEnrolled, locale: row.locale },
    viewAs: viewAsOf(row),
    sso: ssoBindingOf(row),
    ...(row.boundWorkspaceId === null ? {} : { boundWorkspaceId: row.boundWorkspaceId }),
  };
}

export function isSessionLive(row: SessionWithUser, now: Date): boolean {
  return (
    row.revokedAt === null &&
    row.userDeletedAt === null &&
    row.sessionVersion === row.userSessionVersion &&
    row.idleExpiresAt.getTime() > now.getTime() &&
    row.absoluteExpiresAt.getTime() > now.getTime()
  );
}

export function createSessionService(deps: IdentityDeps): SessionService {
  const { db } = deps;
  const log = deps.log ?? (() => {});

  async function resolveDevice(
    tx: Tx,
    input: StartSessionInput,
    now: Date,
    rememberedAbsoluteMs: number,
  ): Promise<{ id: string; token: string; isNew: boolean; trustedUntil: Date | null }> {
    const userAgent = (input.userAgent ?? "").slice(0, 512);
    const trustedUntil = input.rememberDevice
      ? new Date(now.getTime() + rememberedAbsoluteMs)
      : undefined;
    if (input.deviceToken) {
      const existing = await findDeviceByTokenHash(tx, input.userId, sha256(input.deviceToken));
      if (existing) {
        await touchDevice(tx, existing.id, {
          lastSeenAt: now,
          // Keep the last known description when this request carries no User-Agent.
          ...(userAgent ? { userAgent } : {}),
          ...(trustedUntil ? { trustedUntil } : {}),
        });
        return {
          id: existing.id,
          token: input.deviceToken,
          isNew: false,
          trustedUntil: trustedUntil ?? existing.trustedUntil,
        };
      }
    }
    const priorDevices = await countDevicesForUser(tx, input.userId);
    const token = randomToken();
    const created = await insertDevice(tx, {
      userId: input.userId,
      tokenHash: sha256(token),
      userAgent,
      trustedUntil: trustedUntil ?? null,
    });
    // The very first device of an account is not "new" in the alerting sense.
    return { id: created.id, token, isNew: priorDevices > 0, trustedUntil: created.trustedUntil };
  }

  /** The user's own membership in a workspace (host read fenced to the user), for audit. */
  async function staffMembershipIn(userId: string, workspaceId: string): Promise<string | null> {
    const rows = await db.withHost((tx) => listWorkspaceMembershipsForUser(tx, userId), {
      actorKind: "host",
      userId,
    });
    return rows.find((m) => m.workspaceId === workspaceId)?.id ?? null;
  }

  async function auditViewAs(
    action: "access.view_as_started" | "access.view_as_ended",
    view: SessionViewAs,
    who: { userId: string; sessionId: string; staffMembershipId: string | null },
    meta: Record<string, string | number>,
    requestId: string | undefined,
  ): Promise<void> {
    // The staff member's own act, recorded in the viewed workspace: actor = staff, subject =
    // the investor. A system context because the staff membership may no longer be live.
    await deps.audit.recordDetached(systemContext(view.workspaceId), {
      action,
      resourceKind: "membership",
      resourceId: view.membershipId,
      subjectMembershipId: view.membershipId,
      actorKind: "staff",
      actorMembershipId: who.staffMembershipId,
      actorUserId: who.userId,
      sessionId: who.sessionId,
      ...(requestId === undefined ? {} : { requestId }),
      meta,
    });
  }

  /**
   * Revokes one session, audits it, and closes any view-as trail it left open. Sessions minted
   * from it (central handoffs, operator sessions — `source_session_id`) go with it, in the same
   * transaction (FR1 R2-L1). A same-user replacement re-parents them first (`startSession`), so
   * none are left pointing here then.
   */
  async function revokeOne(sessionId: string, reason: string): Promise<void> {
    const { row, derived } = await db.withHost(async (tx) => {
      const found = await findSessionById(tx, sessionId);
      if (!found) return { row: undefined, derived: [] };
      const ok = await revokeSession(tx, sessionId, reason);
      const children =
        found.revokedAt === null
          ? await revokeDerivedSessions(tx, sessionId, "source_revoked")
          : [];
      return { row: ok ? found : undefined, derived: children };
    });
    log("auth.session_revoked", { sessionId, reason });
    for (const d of derived) {
      log("auth.session_revoked", { sessionId: d.id, reason: "source_revoked" });
      await deps.audit.recordDetached(
        { ...platformContext(), userId: d.userId },
        {
          action: "auth.session_revoked",
          resourceKind: "session",
          resourceId: d.id,
          sessionId: d.id,
          actorUserId: d.userId,
          meta: { reason: "source_revoked", sourceSessionId: sessionId },
        },
      );
    }
    if (row) {
      await deps.audit.recordDetached(
        { ...platformContext(), userId: row.userId },
        {
          action: "auth.session_revoked",
          resourceKind: "session",
          resourceId: sessionId,
          sessionId,
          actorUserId: row.userId,
          meta: { reason },
        },
      );
      // A revoked session cannot view as anybody any more; close the trail it left open.
      const view = viewAsOf(row);
      if (view !== undefined && view.until.getTime() > nowOf(deps).getTime()) {
        await auditViewAs(
          "access.view_as_ended",
          view,
          {
            userId: row.userId,
            sessionId,
            staffMembershipId: await staffMembershipIn(row.userId, view.workspaceId),
          },
          { reason: reason === "logout" ? "logout" : "session_revoked" },
          undefined,
        );
      }
    }
  }

  return {
    async startViewAs(input) {
      const now = nowOf(deps);
      const next: SessionViewAs = {
        workspaceId: input.workspaceId,
        membershipId: input.targetMembershipId,
        startedAt: now,
        until: new Date(now.getTime() + input.ttlMs),
      };
      const { previous, userId } = await db.withHost(async (tx) => {
        const row = await lockLiveSession(tx, input.sessionId);
        if (!row) throw new AuthError("unauthenticated");
        await setSessionViewAs(tx, input.sessionId, next);
        return { previous: viewAsOf(row), userId: row.userId };
      });
      if (previous !== undefined) {
        await auditViewAs(
          "access.view_as_ended",
          previous,
          {
            userId,
            sessionId: input.sessionId,
            staffMembershipId:
              previous.workspaceId === input.workspaceId
                ? input.staffMembershipId
                : await staffMembershipIn(userId, previous.workspaceId),
          },
          { reason: previous.until.getTime() <= now.getTime() ? "expired" : "replaced" },
          input.requestId,
        );
      }
      await auditViewAs(
        "access.view_as_started",
        next,
        { userId, sessionId: input.sessionId, staffMembershipId: input.staffMembershipId },
        {
          until: next.until.toISOString(),
          reasonLength: input.reason.length,
          reason: input.reason,
        },
        input.requestId,
      );
      log("auth.view_as_started", { workspaceId: input.workspaceId });
      return next;
    },

    async endViewAs(input) {
      const ended = await db.withHost(async (tx) => {
        const row = await lockLiveSession(tx, input.sessionId);
        const current = row ? viewAsOf(row) : undefined;
        if (!row || current === undefined) return undefined;
        const e = input.expected;
        if (
          e !== undefined &&
          (e.workspaceId !== current.workspaceId ||
            e.membershipId !== current.membershipId ||
            e.startedAt.getTime() !== current.startedAt.getTime())
        ) {
          return undefined;
        }
        await setSessionViewAs(tx, input.sessionId, null);
        return { view: current, userId: row.userId };
      });
      if (ended === undefined) return undefined;
      await auditViewAs(
        "access.view_as_ended",
        ended.view,
        {
          userId: ended.userId,
          sessionId: input.sessionId,
          staffMembershipId: await staffMembershipIn(ended.userId, ended.view.workspaceId),
        },
        { reason: input.reason },
        input.requestId,
      );
      log("auth.view_as_ended", { workspaceId: ended.view.workspaceId, reason: input.reason });
      return ended.view;
    },

    async startSession(input) {
      if (input.sso !== undefined && input.sso.workspaceId !== input.workspaceId) {
        throw new AuthError("invalid_request", "an SSO session must start in its own workspace");
      }
      if (
        input.boundWorkspaceId !== undefined &&
        (input.boundWorkspaceId !== input.workspaceId ||
          input.sso !== undefined ||
          input.population === "operator")
      ) {
        throw new AuthError("invalid_request", "a bound session must start in its own workspace");
      }
      const now = nowOf(deps);
      const lifetimes = resolveLifetimes(input.population, deps.lifetimes?.[input.population]);
      const token = randomToken();
      const revokeToken = randomToken();

      const result = await db.withHost(async (tx) => {
        const user = await findUserById(tx, input.userId);
        if (!user) throw new AuthError("invalid_credential", "unknown user");
        const device = await resolveDevice(tx, input, now, lifetimes.rememberedAbsoluteMs);
        // One cap per population, bound sessions apart (FR1): see `SessionCapScope`.
        if (input.boundWorkspaceId !== undefined) {
          await revokeSessionsBeyond(
            tx,
            input.userId,
            BOUND_SESSION_MAX_CONCURRENT - 1,
            { boundWorkspaceId: input.boundWorkspaceId },
            now,
          );
        } else {
          await revokeSessionsBeyond(
            tx,
            input.userId,
            lifetimes.maxConcurrent - 1,
            { population: input.population },
            now,
          );
        }
        const remembered =
          device.trustedUntil !== null && device.trustedUntil.getTime() > now.getTime();
        const absoluteMs = remembered ? lifetimes.rememberedAbsoluteMs : lifetimes.absoluteMs;
        const row = await insertSession(tx, {
          tokenHash: sha256(token),
          userId: input.userId,
          deviceId: device.id,
          population: input.population,
          context: input.context,
          authLevel: input.authLevel,
          authTime:
            input.authTime !== undefined && input.authTime.getTime() < now.getTime()
              ? input.authTime
              : now,
          sessionVersion: user.sessionVersion,
          topSite: input.topSite ?? null,
          ip: input.ip ?? null,
          userAgent: (input.userAgent ?? "").slice(0, 512),
          createdAt: now,
          lastSeenAt: now,
          idleExpiresAt: new Date(now.getTime() + lifetimes.idleMs),
          absoluteExpiresAt: new Date(now.getTime() + absoluteMs),
          lastWorkspaceId: input.workspaceId ?? null,
          ssoWorkspaceId: input.sso?.workspaceId ?? null,
          ssoConnectionId: input.sso?.connectionId ?? null,
          ssoConnectionVersion: input.sso?.connectionVersion ?? null,
          boundWorkspaceId: input.boundWorkspaceId ?? null,
          sourceSessionId: input.sourceSessionId ?? null,
          revokeTokenHash: device.isNew ? sha256(revokeToken) : null,
        });
        const email = device.isNew ? await primaryEmail(tx, input.userId) : undefined;
        const locale = device.isNew
          ? await recipientLocale(tx, { userId: input.userId, workspaceId: input.workspaceId })
          : undefined;
        return { row, device, email, user, locale };
      });

      if (result.device.isNew && result.email) {
        const paths = pathsOf(deps);
        try {
          await deps.mailer.send(
            newDeviceEmail(result.email, {
              productName: deps.productName,
              workspaceId: input.workspaceId,
              workspaceName: input.workspaceName,
              device: describeUserAgent(input.userAgent),
              when: now,
              revokeUrl: absoluteUrl(deps, paths.revokeSession, { token: revokeToken }),
              sessionsUrl: absoluteUrl(deps, paths.sessions),
              locale: result.locale,
            }),
          );
        } catch (error) {
          // The login must not fail because the notice could not be sent; surface it to ops.
          log("auth.new_device_mail_failed", { userId: input.userId, error: String(error) });
        }
      }
      // Re-authentication ends the session the browser held before (ASVS 7.2.4). After the new
      // row exists, so a failed login never signs anybody out.
      if (input.replacesSessionId !== undefined && input.replacesSessionId !== result.row.id) {
        // FR3 RR1-M2: the same person signing in again keeps what the old session handed out,
        // now derived from the new one (a sign-out of the new one still ends it). Another user's
        // session in this browser takes its derived sessions down with it (`revokeOne`).
        // FR4: an operator session moves only onto a login that could have minted one.
        const replaced = input.replacesSessionId;
        const dropped = await db.withHost(async (tx) => {
          const old = await findSessionById(tx, replaced);
          if (old === undefined || old.userId !== input.userId) return [];
          return (await reparentDerivedSessions(tx, replaced, result.row)).revoked;
        });
        for (const d of dropped) {
          log("auth.session_revoked", { sessionId: d.id, reason: "source_revoked" });
          await deps.audit.recordDetached(
            { ...platformContext(), userId: d.userId },
            {
              action: "auth.session_revoked",
              resourceKind: "session",
              resourceId: d.id,
              sessionId: d.id,
              actorUserId: d.userId,
              meta: { reason: "source_revoked", sourceSessionId: replaced },
            },
          );
        }
        await revokeOne(replaced, "replaced");
      }
      log("auth.session_started", {
        userId: input.userId,
        population: input.population,
        context: input.context,
        authLevel: input.authLevel,
        newDevice: result.device.isNew,
      });

      return {
        token,
        deviceToken: result.device.token,
        isNewDevice: result.device.isNew,
        session: toAuthenticated({
          ...result.row,
          userSessionVersion: result.user.sessionVersion,
          userDeletedAt: result.user.deletedAt,
          displayName: result.user.displayName,
          mfaEnrolled: result.user.mfaEnrolled,
          locale: result.user.locale,
        }),
      };
    },

    async resolveSession(token) {
      if (typeof token !== "string" || token.length < 32 || token.length > 128) return undefined;
      const now = nowOf(deps);
      return db.withHost(async (tx) => {
        const row = await findSessionByTokenHash(tx, sha256(token));
        if (!row || !isSessionLive(row, now)) return undefined;
        if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
          const lifetimes = resolveLifetimes(row.population, deps.lifetimes?.[row.population]);
          const idleExpiresAt = new Date(
            Math.min(now.getTime() + lifetimes.idleMs, row.absoluteExpiresAt.getTime()),
          );
          await touchSession(tx, row.id, { lastSeenAt: now, idleExpiresAt });
          return toAuthenticated({ ...row, lastSeenAt: now, idleExpiresAt });
        }
        return toAuthenticated(row);
      });
    },

    revokeSession(sessionId, reason) {
      return revokeOne(sessionId, reason);
    },

    async revokeAllSessions(userId, reason) {
      const n = await db.withHost(async (tx, ctx) => {
        await bumpSessionVersion(tx, userId);
        const count = await revokeSessionsForUser(tx, userId, reason);
        await publish(tx, ctx, "session.revoked", { userId, count, reason, workspaceId: null });
        return count;
      });
      log("auth.sessions_revoked_all", { userId, reason, count: n });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.sessions_revoked_all",
          resourceKind: "session",
          actorUserId: userId,
          meta: { reason, count: n },
        },
      );
      return n;
    },

    async revokeSessionsForWorkspace(userId, workspaceId, reason) {
      const n = await db.withHost(async (tx, ctx) => {
        const count = await revokeSessionsForWorkspace(tx, userId, workspaceId, reason);
        await publish(tx, ctx, "session.revoked", { userId, count, reason, workspaceId });
        return count;
      });
      log("auth.sessions_revoked_workspace", { userId, workspaceId, reason, count: n });
      await deps.audit.recordDetached(systemContext(workspaceId), {
        action: "auth.sessions_revoked_workspace",
        resourceKind: "session",
        actorKind: "system",
        actorUserId: userId,
        meta: { reason, count: n },
      });
      return n;
    },

    async revokeSessionsForSsoConnection(connectionId, reason) {
      const rows = await db.withHost(async (tx, ctx) => {
        const revoked = await revokeSessionsForSsoConnection(tx, connectionId, reason);
        const perUser = new Map<string, { count: number; workspaceId: string | null }>();
        for (const r of revoked) {
          const hit = perUser.get(r.userId);
          perUser.set(r.userId, { count: (hit?.count ?? 0) + 1, workspaceId: r.workspaceId });
        }
        for (const [userId, { count, workspaceId }] of perUser) {
          await publish(tx, ctx, "session.revoked", { userId, count, reason, workspaceId });
        }
        return revoked;
      });
      log("auth.sessions_revoked_sso_connection", { connectionId, reason, count: rows.length });
      const workspaceId = rows.find((r) => r.workspaceId !== null)?.workspaceId;
      if (workspaceId != null) {
        await deps.audit.recordDetached(systemContext(workspaceId), {
          action: "auth.sessions_revoked_workspace",
          resourceKind: "session",
          actorKind: "system",
          meta: { reason, count: rows.length, connectionId },
        });
      }
      return rows.length;
    },

    async touchWorkspace(sessionId, workspaceId) {
      await db.withHost((tx) => setSessionWorkspace(tx, sessionId, workspaceId));
    },

    async listSessions(userId, currentSessionId) {
      const now = nowOf(deps);
      return db.withHost(async (tx) => {
        const rows = await listSessionsForUser(tx, userId, now);
        const devices = new Map((await listDevicesForUser(tx, userId)).map((d) => [d.id, d]));
        return rows.map(
          (s: Session): SessionSummary => ({
            id: s.id,
            deviceId: s.deviceId ?? undefined,
            deviceName: (s.deviceId && devices.get(s.deviceId)?.name) || "",
            device: describeUserAgent(s.userAgent),
            ip: s.ip ?? undefined,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            authLevel: s.authLevel as AuthLevel,
            context: s.context,
            current: s.id === currentSessionId,
          }),
        );
      });
    },

    async listDevices(userId) {
      const now = nowOf(deps);
      return db.withHost(async (tx) => {
        const rows = await listDevicesForUser(tx, userId);
        return rows.map(
          (d): DeviceSummary => ({
            id: d.id,
            name: d.name,
            device: describeUserAgent(d.userAgent),
            firstSeenAt: d.firstSeenAt,
            lastSeenAt: d.lastSeenAt,
            trusted: d.trustedUntil !== null && d.trustedUntil.getTime() > now.getTime(),
          }),
        );
      });
    },

    async renameDevice(userId, deviceId, name) {
      return db.withHost((tx) => renameDevice(tx, deviceId, userId, name));
    },

    async revokeDevice(userId, deviceId) {
      const ok = await db.withHost(async (tx) => {
        const revoked = await revokeDevice(tx, deviceId, userId);
        if (revoked) await revokeSessionsForDevice(tx, deviceId, "device_revoked");
        return revoked;
      });
      if (ok) {
        log("auth.device_revoked", { userId, deviceId });
        await deps.audit.recordDetached(
          { ...platformContext(), userId },
          {
            action: "auth.device_revoked",
            resourceKind: "device",
            resourceId: deviceId,
            actorUserId: userId,
          },
        );
      }
      return ok;
    },

    async revokeByToken(revokeToken) {
      if (typeof revokeToken !== "string" || revokeToken.length < 32) return false;
      const revoked = await db.withHost(async (tx) => {
        const row = await findSessionByRevokeTokenHash(tx, sha256(revokeToken));
        if (!row || row.revokedAt !== null) return undefined;
        await clearRevokeToken(tx, row.id);
        await revokeSession(tx, row.id, "suspicious");
        await revokeDerivedSessions(tx, row.id, "suspicious");
        if (row.deviceId) {
          await revokeDevice(tx, row.deviceId, row.userId);
          await revokeSessionsForDevice(tx, row.deviceId, "suspicious");
        }
        return { sessionId: row.id, userId: row.userId, deviceId: row.deviceId };
      });
      if (revoked) {
        log("auth.session_revoked_by_token", {});
        await deps.audit.recordDetached(
          { ...platformContext(), userId: revoked.userId },
          {
            action: "auth.session_revoked",
            resourceKind: "session",
            resourceId: revoked.sessionId,
            sessionId: revoked.sessionId,
            actorUserId: revoked.userId,
            meta: { reason: "suspicious", viaEmailLink: true, deviceId: revoked.deviceId },
          },
        );
      }
      return revoked !== undefined;
    },

    async stepUp(sessionId, level, method = "unspecified", options = {}) {
      const now = nowOf(deps);
      const fresh = randomToken();
      const stepped = await db.withHost(async (tx) => {
        // Row lock first (R1-04): a second step-up on this session waits here and then sees the
        // first one's token hash, not the one both of them started from.
        if (!(await lockLiveSession(tx, sessionId))) throw new AuthError("unauthenticated");
        const row = await findSessionById(tx, sessionId);
        if (!row || !isSessionLive(row, now)) throw new AuthError("unauthenticated");
        const authLevel = Math.max(row.authLevel, level);
        // Lost the race: the token this request came in with is no longer the session's, so a
        // concurrent step-up (holding the same browser's cookie) has rotated it. Its response
        // carries the live cookie; this one records the proof and leaves the token alone.
        const rotatedAway =
          options.presentedToken !== undefined &&
          !safeEqual(sha256(options.presentedToken), row.tokenHash);
        const token = rotatedAway ? undefined : fresh;
        // New token, same row (F-12): the session's id, device and history stay; a copy of the
        // pre-step-up cookie is worth nothing from here on.
        await setSessionAuth(tx, sessionId, {
          authLevel,
          authTime: now,
          ...(token === undefined ? {} : { tokenHash: sha256(token) }),
        });
        const device = row.deviceId
          ? (await listDevicesForUser(tx, row.userId)).find((d) => d.id === row.deviceId)
          : undefined;
        const trusted =
          device?.trustedUntil != null && device.trustedUntil.getTime() > now.getTime();
        return {
          token,
          userId: row.userId,
          from: row.authLevel,
          to: authLevel,
          persistUntil: trusted ? row.absoluteExpiresAt : undefined,
        };
      });
      log("auth.step_up", {
        sessionId,
        method,
        level: stepped.to,
        ...(stepped.token === undefined ? { rotated: false } : {}),
      });
      // A global-user fact: the platform chain, like MFA enrolment (see `actorContextFor`).
      await deps.audit.recordDetached(
        { ...platformContext(), userId: stepped.userId },
        {
          action: "auth.step_up",
          resourceKind: "session",
          resourceId: sessionId,
          sessionId,
          actorUserId: stepped.userId,
          meta: { method, proofLevel: level, fromLevel: stepped.from, toLevel: stepped.to },
        },
      );
      return { token: stepped.token, persistUntil: stepped.persistUntil };
    },

    async revokeOtherSessions(userId, keepSessionId, reason) {
      const n = await db.withHost(async (tx, ctx) => {
        const count = await revokeSessionsForUser(
          tx,
          userId,
          reason,
          keepSessionId === undefined ? {} : { exceptSessionId: keepSessionId },
        );
        if (count > 0)
          await publish(tx, ctx, "session.revoked", { userId, count, reason, workspaceId: null });
        return count;
      });
      log("auth.sessions_revoked_others", { userId, reason, count: n });
      if (n > 0) {
        await deps.audit.recordDetached(
          { ...platformContext(), userId },
          {
            action: "auth.sessions_revoked_all",
            resourceKind: "session",
            actorUserId: userId,
            ...(keepSessionId === undefined ? {} : { sessionId: keepSessionId }),
            meta: { reason, count: n, keptCurrent: keepSessionId !== undefined },
          },
        );
      }
      return n;
    },

    async sweep() {
      const before = new Date(nowOf(deps).getTime() - 30 * 24 * 3600_000);
      return db.withHost((tx) => deleteDeadSessions(tx, before));
    },
  };
}
