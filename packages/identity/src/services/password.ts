import { platformContext } from "@fundroom/db";
import type { OutboundFetch, SsoBinding } from "@fundroom/ports";
import { checkPasswordBreached } from "../crypto/hibp.js";
import {
  checkPasswordPolicy,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "../crypto/password.js";
import { AuthError } from "../errors.js";
import { assertMayChangeAccount } from "../policy/sso-bound.js";
import {
  findCredential,
  insertCredential,
  revokeCredentialsOfKind,
  updateCredential,
} from "../repos/credential-repo.js";
import { findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import { afterFactorChange, type FactorChangeContext } from "./factor-change.js";
import { auditLoginFailure, auditStepUpFailure, completeLogin } from "./login.js";
import { RATE_LIMITS } from "./rate-limiter.js";
import type { SessionService, StepUpResult } from "./sessions.js";
import { type IdentityDeps, type LoginContext, type LoginResult, nowOf } from "./types.js";

/*
 * Password login (design/05 §2.1: off by default, allowed via config; staff fallback).
 * NIST 800-63B rules: length only, breached-password check via HIBP k-anonymity. Unknown
 * emails burn the same scrypt time as wrong passwords. Password alone is auth level 1.
 */
export interface PasswordOptions {
  /** `AUTH_PASSWORD_ENABLED`. When false every method throws `unsupported`. */
  readonly enabled: boolean;
  readonly breachCheck?: {
    readonly enabled: boolean;
    readonly fetch: OutboundFetch;
    /**
     * `AUTH_HIBP_FAIL_MODE` (F-21, ASVS 6.2.12): what to do when HIBP cannot be reached. `open`
     * (the default) accepts the password unchecked; `closed` refuses it with
     * `breach_check_unavailable` (503). Either way the skip is audited
     * (`auth.password_breach_check_skipped`) and `onUnavailable` is called.
     */
    readonly failMode?: "open" | "closed";
    /**
     * Called once per skipped check, in both modes. The server bumps its security-events counter
     * here (`fundroom.security.events{event="breach_check_unavailable"}`); identity does not
     * know about the server's telemetry, so the seam is a callback.
     */
    readonly onUnavailable?: (info: { readonly failMode: "open" | "closed" }) => void;
    readonly baseUrl?: string;
  };
}

export interface PasswordFlow {
  readonly enabled: boolean;
  /**
   * Sets or replaces the password; other sessions are signed out (credential_changed) and the
   * security notice is sent. Replacing an existing password needs `currentPassword` (F-20, ASVS
   * 6.2.3): a fresh proof from another factor (an email code) is not enough.
   */
  set(input: {
    userId: string;
    password: string;
    currentPassword?: string | undefined;
    keepSessionId?: string | undefined;
    context?: FactorChangeContext | undefined;
  }): Promise<void>;
  login(input: { email: string; password: string } & LoginContext): Promise<LoginResult>;
  /**
   * Re-proves the password for step-up on an existing session (level stays 1; `auth_time`
   * refreshes); returns the session's new token (F-12).
   */
  reverify(input: {
    userId: string;
    password: string;
    sessionId: string;
    /** The session token the request presented (R1-04: a concurrent step-up's loser keeps it). */
    presentedToken?: string | undefined;
    /**
     * E3.8: the session's SSO binding. A bound session is refused (`sso_session_restricted`): the
     * proof would only raise it to level 1, which it has, and it would make the tenant's IdP a
     * guessing oracle for the person's global password. Fresh auth there is an SSO re-login.
     */
    sso?: SsoBinding | undefined;
    /** E3.10: a central-auth binding is refused the same way (`bound_session_restricted`). */
    boundWorkspaceId?: string | undefined;
  }): Promise<StepUpResult>;
  /**
   * Removes the password (E2.10 R1-01). Needs `currentPassword`, exactly like replacing it,
   * unless the session is level 2 (`sessionAuthLevel`): otherwise an email code alone — all a
   * mailbox thief has — could remove the password and then *set* one with nothing to check,
   * which is F-20 walked around in two requests. A level-2 session proved a second factor the
   * user already holds (the route's factor-proof gate asks for it whenever they have one), and
   * is the way back for somebody who has forgotten the password. No password, nothing to do:
   * no proof is asked and nothing is audited.
   */
  remove(input: {
    userId: string;
    currentPassword?: string | undefined;
    sessionAuthLevel?: number | undefined;
    context?: FactorChangeContext | undefined;
  }): Promise<void>;
  has(userId: string): Promise<boolean>;
}

export function createPasswordFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: PasswordOptions,
): PasswordFlow {
  function assertEnabled(): void {
    if (!options.enabled)
      throw new AuthError("unsupported", "password login is disabled (AUTH_PASSWORD_ENABLED)");
  }

  async function assertAcceptable(userId: string, password: string): Promise<void> {
    const issue = checkPasswordPolicy(password);
    if (issue)
      throw new AuthError(
        "password_policy",
        issue === "too_short" ? "use at least 12 characters" : "password is too long",
        { issue },
      );
    const bc = options.breachCheck;
    if (!bc?.enabled) return;
    const result = await checkPasswordBreached(password, {
      fetch: bc.fetch,
      ...(bc.baseUrl ? { baseUrl: bc.baseUrl } : {}),
    });
    if (result.status === "breached") {
      throw new AuthError(
        "password_breached",
        "this password appears in known data breaches; choose another",
        { count: result.count },
      );
    }
    if (result.status === "unavailable") {
      const failMode = bc.failMode ?? "open";
      deps.log?.("auth.hibp_unavailable", { reason: result.reason, failMode });
      try {
        bc.onUnavailable?.({ failMode });
      } catch {
        // A telemetry hook must never decide whether a password is accepted.
      }
      try {
        await deps.audit.recordDetached(
          { ...platformContext(), userId },
          {
            action: "auth.password_breach_check_skipped",
            resourceKind: "credential",
            outcome: failMode === "closed" ? "denied" : "success",
            actorUserId: userId,
            // Bounded: never the raw error text (it can carry hostnames or addresses).
            meta: {
              failMode,
              cause: result.reason.startsWith("HTTP ") ? "http_status" : "unreachable",
            },
          },
        );
      } catch (error) {
        deps.log?.("auth.audit_failed", {
          action: "auth.password_breach_check_skipped",
          error: String(error),
        });
      }
      if (failMode === "closed") {
        throw new AuthError(
          "breach_check_unavailable",
          "the breached-password check is unavailable; try again later",
        );
      }
    }
  }

  async function verifyFor(
    userId: string | undefined,
    password: string,
  ): Promise<{ ok: boolean; credentialId?: string; needsRehash: boolean }> {
    const cred = userId
      ? await deps.db.withHost((tx) => findCredential(tx, userId, "password"))
      : undefined;
    const stored = cred?.secret ?? (await dummyPasswordHash());
    const verdict = await verifyPassword(password, stored);
    if (!cred) return { ok: false, needsRehash: false };
    return { ok: verdict.ok, credentialId: cred.id, needsRehash: verdict.needsRehash };
  }

  /**
   * F-20: the current password, rate limited per user (it is a guessing surface for whoever
   * holds a session) and audited as a failed step-up when wrong.
   */
  async function assertCurrentPassword(
    userId: string,
    currentPassword: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    if (currentPassword === undefined || currentPassword === "")
      throw new AuthError("invalid_request", "enter your current password", {
        field: "currentPassword",
      });
    const r = await deps.rateLimiter.hit(`password:user:${userId}`, RATE_LIMITS.passwordPerEmail);
    if (!r.allowed)
      throw new AuthError("rate_limited", "too many attempts", { retryAfterMs: r.retryAfterMs });
    if (!(await verifyFor(userId, currentPassword)).ok) {
      await auditStepUpFailure(deps, {
        userId,
        sessionId,
        method: "password",
        reason: "invalid_credential",
      });
      throw new AuthError("invalid_credential", "the current password is wrong", {
        field: "currentPassword",
      });
    }
    await deps.rateLimiter.reset(`password:user:${userId}`);
  }

  return {
    enabled: options.enabled,

    async set({ userId, password, currentPassword, keepSessionId, context }) {
      assertEnabled();
      const existing = await deps.db.withHost((tx) => findCredential(tx, userId, "password"));
      if (existing)
        await assertCurrentPassword(userId, currentPassword, keepSessionId ?? context?.sessionId);
      await assertAcceptable(userId, password);
      const secret = await hashPassword(password);
      await deps.db.withHost(async (tx) => {
        await revokeCredentialsOfKind(tx, userId, "password");
        await insertCredential(tx, {
          userId,
          kind: "password",
          label: "Password",
          secret,
          confirmedAt: nowOf(deps),
          createdAt: nowOf(deps),
        });
      });
      deps.log?.("auth.password_set", { userId });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.password_changed",
          resourceKind: "credential",
          actorUserId: userId,
          meta: {
            change: existing ? "changed" : "set",
            keptSession: (keepSessionId ?? context?.sessionId) !== undefined,
          },
        },
      );
      await afterFactorChange(
        deps,
        sessions,
        userId,
        existing ? "password_changed" : "password_set",
        { ...context, sessionId: keepSessionId ?? context?.sessionId },
      );
    },

    async login(input) {
      assertEnabled();
      let email: string;
      try {
        email = normalizeEmail(input.email);
      } catch {
        throw new AuthError("invalid_credential");
      }
      const byEmail = await deps.rateLimiter.hit(
        `password:email:${email}`,
        RATE_LIMITS.passwordPerEmail,
      );
      const byIp = input.ip
        ? await deps.rateLimiter.hit(`password:ip:${input.ip}`, RATE_LIMITS.passwordPerIp)
        : { allowed: true, retryAfterMs: 0 };
      if (!byEmail.allowed || !byIp.allowed) {
        throw new AuthError("rate_limited", "too many attempts", {
          retryAfterMs: Math.max(byEmail.retryAfterMs, byIp.retryAfterMs),
        });
      }
      const user = await deps.db.withHost((tx) => findUserByEmail(tx, email));
      const verdict = await verifyFor(user?.id, input.password);
      if (!user || !verdict.ok) {
        if (user) {
          await auditLoginFailure(deps, {
            ...input,
            userId: user.id,
            method: "password",
            reason: "invalid_credential",
          });
        }
        throw new AuthError("invalid_credential", "wrong email or password");
      }
      if (verdict.needsRehash && verdict.credentialId) {
        const secret = await hashPassword(input.password);
        await deps.db.withHost((tx) =>
          updateCredential(tx, verdict.credentialId as string, { secret }),
        );
      }
      await deps.rateLimiter.reset(`password:email:${email}`);
      return completeLogin(deps, sessions, {
        ...input,
        userId: user.id,
        email,
        authLevel: 1,
        method: "password",
      });
    },

    async reverify({ userId, password, sessionId, presentedToken, sso, boundWorkspaceId }) {
      assertMayChangeAccount({ sso, boundWorkspaceId });
      assertEnabled();
      const budget = `password:user:${userId}`;
      const r = await deps.rateLimiter.hit(budget, RATE_LIMITS.passwordPerEmail);
      if (!r.allowed)
        throw new AuthError("rate_limited", "too many attempts", { retryAfterMs: r.retryAfterMs });
      const verdict = await verifyFor(userId, password);
      if (!verdict.ok) {
        await auditStepUpFailure(deps, {
          userId,
          sessionId,
          method: "password",
          reason: "invalid_credential",
        });
        throw new AuthError("invalid_credential");
      }
      await deps.rateLimiter.reset(budget);
      return sessions.stepUp(sessionId, 1, "password", { presentedToken });
    },

    async remove({ userId, currentPassword, sessionAuthLevel, context }) {
      const existing = await deps.db.withHost((tx) => findCredential(tx, userId, "password"));
      if (!existing) return;
      if ((sessionAuthLevel ?? 0) < 2)
        await assertCurrentPassword(userId, currentPassword, context?.sessionId);
      const removed = await deps.db.withHost((tx) =>
        revokeCredentialsOfKind(tx, userId, "password"),
      );
      if (removed === 0) return;
      deps.log?.("auth.password_removed", { userId });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.password_changed",
          resourceKind: "credential",
          actorUserId: userId,
          meta: { change: "removed" },
        },
      );
      await afterFactorChange(deps, sessions, userId, "password_removed", context);
    },

    async has(userId) {
      return (await deps.db.withHost((tx) => findCredential(tx, userId, "password"))) !== undefined;
    },
  };
}
