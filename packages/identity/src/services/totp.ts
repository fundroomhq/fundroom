import { randomBytes } from "node:crypto";
import { platformContext } from "@fundroom/db";
import type { SsoBinding } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { verifyCode } from "../crypto/keys.js";
import {
  hashRecoveryCode,
  isSlowRecoveryHash,
  verifyRecoveryCodeHash,
} from "../crypto/password.js";
import { needsReseal, open, seal } from "../crypto/secretbox.js";
import { base32Encode, normalizeCode, recoveryCode } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { isBoundSession, type SessionBindingFacts, stepUpBudgetKey } from "../policy/sso-bound.js";
import {
  findCredential,
  insertCredential,
  listCredentials,
  lockCredential,
  revokeCredentialsOfKind,
  updateCredential,
} from "../repos/credential-repo.js";
import { findUserById, primaryEmail, setMfaEnrolled } from "../repos/user-repo.js";
import { afterFactorChange, type FactorChangeContext } from "./factor-change.js";
import { auditStepUpFailure } from "./login.js";
import { RATE_LIMITS } from "./rate-limiter.js";
import type { SessionService, StepUpResult } from "./sessions.js";
import { type IdentityDeps, nowOf } from "./types.js";

/*
 * TOTP (RFC 6238) with otpauth. The seed is sealed with the key ring at rest. Enrolment
 * is pending until the first valid code, then ten recovery codes are issued (each stored as a
 * salted scrypt hash; older sets hold keyed HMACs and still verify until regenerated).
 * A code's time step is remembered so it cannot be replayed inside the grace window.
 *
 * Concurrency (E2.10, F-05/F-06): every attempt consumes a rate-limit slot *before* the code is
 * checked (the limiter's increment is atomic, so N parallel guesses spend N slots), and a
 * success resets the counter. The credential row is read `FOR UPDATE` for the compare-and-write,
 * so two requests carrying the same TOTP step or the same recovery code cannot both succeed.
 */
export interface TotpOptions {
  readonly issuer?: string;
  readonly periodSeconds?: number;
  readonly digits?: number;
  readonly graceSeconds?: number;
  readonly recoveryCodeCount?: number;
}

export interface TotpEnrolment {
  readonly credentialId: string;
  readonly secretBase32: string;
  readonly otpauthUri: string;
}

export interface TotpFlow {
  beginEnrolment(input: { userId: string }): Promise<TotpEnrolment>;
  /**
   * Confirms enrolment with the first code. Signs out the user's other sessions and sends the
   * security notice (`context.sessionId` is kept).
   */
  confirmEnrolment(input: {
    userId: string;
    code: string;
    context?: FactorChangeContext | undefined;
  }): Promise<{ recoveryCodes: readonly string[] }>;
  /**
   * Verifies a code; with `sessionId`, records the proof on the session (step-up to level 2) and
   * returns the session's new token (F-12).
   */
  verify(input: {
    userId: string;
    code: string;
    sessionId?: string | undefined;
    /** The cookie value the request authenticated with (R1-04, see `SessionService.stepUp`). */
    presentedToken?: string | undefined;
    /** E3.8: the session's SSO binding — its attempts spend budgets of their own. */
    sso?: SsoBinding | undefined;
    /** E3.10: the session's central-auth binding — the same, in a bucket of its own. */
    boundWorkspaceId?: string | undefined;
    /** The client address (E3.8: bound step-ups are also capped per IP). */
    ip?: string | undefined;
  }): Promise<StepUpResult | undefined>;
  verifyRecoveryCode(input: {
    userId: string;
    code: string;
    sessionId?: string | undefined;
    presentedToken?: string | undefined;
    /** E3.8: as for `verify`. */
    sso?: SsoBinding | undefined;
    boundWorkspaceId?: string | undefined;
    ip?: string | undefined;
  }): Promise<{ remaining: number; stepUp?: StepUpResult | undefined }>;
  regenerateRecoveryCodes(input: {
    userId: string;
    context?: FactorChangeContext | undefined;
  }): Promise<{ recoveryCodes: readonly string[] }>;
  disable(input: { userId: string; context?: FactorChangeContext | undefined }): Promise<void>;
  status(
    userId: string,
  ): Promise<{ enrolled: boolean; pending: boolean; recoveryCodesLeft: number }>;
}

interface TotpData {
  lastStep?: number;
}
interface RecoveryData {
  codes?: string[];
}

export function createTotpFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: TotpOptions = {},
): TotpFlow {
  const issuer = options.issuer ?? deps.productName;
  const period = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const grace = options.graceSeconds ?? 30;
  const recoveryCount = options.recoveryCodeCount ?? 10;

  function recoveryScope(userId: string): string {
    return `recovery:${userId}`;
  }

  function totpFor(secret: Uint8Array, label: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer,
      label,
      algorithm: "SHA1",
      digits,
      period,
      secret: new OTPAuth.Secret({
        buffer: secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength),
      }),
    });
  }

  /** Accepts codes from ±`grace` seconds around the current step; returns the matched step. */
  function matchStep(secret: Uint8Array, code: string, now: Date): number | undefined {
    const window = Math.ceil(grace / period);
    const delta = totpFor(secret, "").validate({ token: code, timestamp: now.getTime(), window });
    if (delta === null) return undefined;
    return Math.floor(now.getTime() / 1000 / period) + delta;
  }

  async function issueRecoveryCodes(userId: string): Promise<readonly string[]> {
    const codes = Array.from({ length: recoveryCount }, () => recoveryCode());
    // Hashed before the transaction opens: scrypt is CPU time, not something to hold a
    // pooled connection for.
    const hashes = await Promise.all(
      codes.map((c) => hashRecoveryCode(normalizeCode(c), recoveryScope(userId))),
    );
    await deps.db.withHost(async (tx) => {
      await revokeCredentialsOfKind(tx, userId, "recovery_codes");
      await insertCredential(tx, {
        userId,
        kind: "recovery_codes",
        label: "Recovery codes",
        data: { codes: hashes } satisfies RecoveryData,
        confirmedAt: nowOf(deps),
        createdAt: nowOf(deps),
      });
    });
    return codes;
  }

  /**
   * Spends one attempt from the per-user budget before anything is verified (F-05). A peek
   * followed by a count on failure let N concurrent guesses all pass the peek.
   */
  async function consumeAttempt(
    userId: string,
    binding: SessionBindingFacts = {},
    ip?: string,
  ): Promise<void> {
    // A bound session's step-ups are also capped per client address (E3.8 FR3/FR4): FAILURES
    // only, checked here and counted in `failedAttempt`, so users sharing an address (an office
    // NAT) who type correct codes never lock each other out. Skipped when the address is unknown
    // (no socket peer, no trusted proxy header); the per-workspace bucket below still applies.
    const bound = isBoundSession(binding);
    if (bound && ip !== undefined) {
      const byIp = await deps.rateLimiter.peek(ssoIpKey(ip), RATE_LIMITS.totpSsoPerIp);
      if (!byIp.allowed) {
        deps.log?.("auth.totp_rate_limited", { userId, bound: true, by: "ip" });
        throw new AuthError("rate_limited", "too many attempts", {
          retryAfterMs: byIp.retryAfterMs,
        });
      }
    }
    const r = await deps.rateLimiter.hit(
      stepUpBudgetKey(`totp:user:${userId}`, binding),
      RATE_LIMITS.totpPerUser,
    );
    if (!r.allowed) {
      deps.log?.("auth.totp_rate_limited", { userId, bound });
      throw new AuthError("rate_limited", "too many attempts", { retryAfterMs: r.retryAfterMs });
    }
  }

  function ssoIpKey(ip: string): string {
    return `totp:sso:ip:${ip}`;
  }

  /** A wrong code from a bound session counts against its client address (FR4: failures only). */
  async function failedAttempt(
    binding: SessionBindingFacts,
    ip: string | undefined,
  ): Promise<void> {
    if (isBoundSession(binding) && ip !== undefined)
      await deps.rateLimiter.hit(ssoIpKey(ip), RATE_LIMITS.totpSsoPerIp);
  }

  async function resetAttempts(userId: string, binding: SessionBindingFacts = {}): Promise<void> {
    await deps.rateLimiter.reset(stepUpBudgetKey(`totp:user:${userId}`, binding));
  }

  /** Index of the stored entry `code` matches, or -1. Both storage formats are accepted. */
  async function matchRecoveryCode(
    userId: string,
    code: string,
    entries: readonly string[],
  ): Promise<number> {
    const scope = recoveryScope(userId);
    const verdicts = await Promise.all(
      entries.map((h) =>
        isSlowRecoveryHash(h)
          ? verifyRecoveryCodeHash(code, scope, h)
          : Promise.resolve(verifyCode(deps.keyRing, code, scope, Buffer.from(h, "base64url"))),
      ),
    );
    return verdicts.indexOf(true);
  }

  return {
    async beginEnrolment({ userId }) {
      const { user, email } = await deps.db.withHost(async (tx) => ({
        user: await findUserById(tx, userId),
        email: await primaryEmail(tx, userId),
      }));
      if (!user) throw new AuthError("unauthenticated");
      const secret = randomBytes(20);
      const row = await deps.db.withHost(async (tx) => {
        const existing = await findCredential(tx, userId, "totp");
        if (existing?.confirmedAt)
          throw new AuthError(
            "mfa_already_enrolled",
            "an authenticator is already set up; disable it first",
          );
        await revokeCredentialsOfKind(tx, userId, "totp");
        return insertCredential(tx, {
          userId,
          kind: "totp",
          label: "Authenticator app",
          secret: seal(deps.keyRing, secret, `totp:${userId}`),
          data: {} satisfies TotpData,
          createdAt: nowOf(deps),
        });
      });
      return {
        credentialId: row.id,
        secretBase32: base32Encode(secret),
        otpauthUri: totpFor(secret, email ?? userId).toString(),
      };
    },

    async confirmEnrolment({ userId, code, context }) {
      await consumeAttempt(userId);
      const ok = await deps.db.withHost(async (tx) => {
        const cred = await lockCredential(tx, userId, "totp");
        if (!cred || cred.confirmedAt || !cred.secret)
          throw new AuthError("mfa_not_enrolled", "start enrolment first");
        const secret = open(deps.keyRing, cred.secret, `totp:${userId}`);
        const step = matchStep(secret, normalizeCode(code), nowOf(deps));
        if (step === undefined) return false;
        await updateCredential(tx, cred.id, {
          confirmedAt: nowOf(deps),
          lastUsedAt: nowOf(deps),
          data: { lastStep: step } satisfies TotpData,
        });
        await setMfaEnrolled(tx, userId, true);
        return true;
      });
      if (!ok) throw new AuthError("invalid_code");
      await resetAttempts(userId);
      deps.log?.("auth.totp_enrolled", { userId });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.mfa_enrolled",
          resourceKind: "credential",
          actorUserId: userId,
          meta: { kind: "totp" },
        },
      );
      const recoveryCodes = await issueRecoveryCodes(userId);
      await afterFactorChange(deps, sessions, userId, "totp_enabled", context);
      return { recoveryCodes };
    },

    async verify({ userId, code, sessionId, presentedToken, sso, boundWorkspaceId, ip }) {
      const binding: SessionBindingFacts = { sso, boundWorkspaceId };
      await consumeAttempt(userId, binding, ip);
      const ok = await deps.db.withHost(async (tx) => {
        // Locked: two requests carrying the same step serialise here, and the second sees the
        // first one's `lastStep` (F-06).
        const cred = await lockCredential(tx, userId, "totp");
        if (!cred?.confirmedAt || !cred.secret) throw new AuthError("mfa_not_enrolled");
        const secret = open(deps.keyRing, cred.secret, `totp:${userId}`);
        const data = cred.data as TotpData;
        const step = matchStep(secret, normalizeCode(code), nowOf(deps));
        if (step === undefined) return false;
        // Replay guard: a step at or before the last accepted one is rejected even if it verifies.
        if (data.lastStep !== undefined && step <= data.lastStep) return false;
        await updateCredential(tx, cred.id, {
          lastUsedAt: nowOf(deps),
          data: { lastStep: step } satisfies TotpData,
          ...(needsReseal(deps.keyRing, cred.secret)
            ? { secret: seal(deps.keyRing, secret, `totp:${userId}`) }
            : {}),
        });
        return true;
      });
      if (!ok) {
        await failedAttempt(binding, ip);
        await auditStepUpFailure(deps, {
          userId,
          sessionId,
          method: "totp",
          reason: "invalid_code",
        });
        throw new AuthError("invalid_code");
      }
      await resetAttempts(userId, binding);
      return sessionId ? sessions.stepUp(sessionId, 2, "totp", { presentedToken }) : undefined;
    },

    async verifyRecoveryCode({
      userId,
      code,
      sessionId,
      presentedToken,
      sso,
      boundWorkspaceId,
      ip,
    }) {
      const binding: SessionBindingFacts = { sso, boundWorkspaceId };
      await consumeAttempt(userId, binding, ip);
      const normalized = normalizeCode(code);
      // Match outside any transaction (scrypt is CPU time), then remove the matched entry under
      // a row lock only if it is still there: a concurrent request that spent the same code
      // first leaves nothing to remove, and this one fails (F-06).
      const snapshot = await deps.db.withHost((tx) => findCredential(tx, userId, "recovery_codes"));
      const entries = (snapshot?.data as RecoveryData | undefined)?.codes ?? [];
      const idx = snapshot ? await matchRecoveryCode(userId, normalized, entries) : -1;
      const matched = idx >= 0 ? entries[idx] : undefined;
      const remaining =
        snapshot && matched !== undefined
          ? await deps.db.withHost(async (tx) => {
              const cred = await lockCredential(tx, userId, "recovery_codes");
              if (cred?.id !== snapshot.id) return -1;
              const codes = ((cred.data as RecoveryData | undefined)?.codes ?? []).slice();
              const at = codes.indexOf(matched);
              if (at < 0) return -1;
              codes.splice(at, 1);
              await updateCredential(tx, cred.id, {
                data: { codes } satisfies RecoveryData,
                lastUsedAt: nowOf(deps),
              });
              return codes.length;
            })
          : -1;
      if (remaining < 0) {
        await failedAttempt(binding, ip);
        await auditStepUpFailure(deps, {
          userId,
          sessionId,
          method: "recovery_code",
          reason: "invalid_code",
        });
        throw new AuthError("invalid_code");
      }
      await resetAttempts(userId, binding);
      deps.log?.("auth.recovery_code_used", { userId, remaining });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.recovery_code_used",
          resourceKind: "credential",
          resourceId: snapshot?.id ?? null,
          actorUserId: userId,
          ...(sessionId === undefined ? {} : { sessionId }),
          meta: { remaining },
        },
      );
      const stepUp = sessionId
        ? await sessions.stepUp(sessionId, 2, "recovery_code", { presentedToken })
        : undefined;
      return stepUp === undefined ? { remaining } : { remaining, stepUp };
    },

    async regenerateRecoveryCodes({ userId, context }) {
      const status = await this.status(userId);
      if (!status.enrolled) throw new AuthError("mfa_not_enrolled");
      const recoveryCodes = await issueRecoveryCodes(userId);
      deps.log?.("auth.recovery_codes_regenerated", { userId });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.recovery_codes_regenerated",
          resourceKind: "credential",
          actorUserId: userId,
          meta: { count: recoveryCodes.length },
        },
      );
      await afterFactorChange(deps, sessions, userId, "recovery_codes_regenerated", context);
      return { recoveryCodes };
    },

    async disable({ userId, context }) {
      const hadTotp = await deps.db.withHost(async (tx) => {
        const confirmed = (await findCredential(tx, userId, "totp"))?.confirmedAt != null;
        await revokeCredentialsOfKind(tx, userId, "totp");
        await revokeCredentialsOfKind(tx, userId, "recovery_codes");
        const remaining = await listCredentials(tx, userId, "passkey");
        await setMfaEnrolled(tx, userId, remaining.length > 0);
        return confirmed;
      });
      // Abandoning a pending (never confirmed) enrolment changes nothing anybody signs in with.
      if (!hadTotp) return;
      deps.log?.("auth.totp_disabled", { userId });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.mfa_disabled",
          resourceKind: "credential",
          actorUserId: userId,
          meta: { kind: "totp" },
        },
      );
      await afterFactorChange(deps, sessions, userId, "totp_disabled", context);
    },

    async status(userId) {
      return deps.db.withHost(async (tx) => {
        const totp = await findCredential(tx, userId, "totp");
        const recovery = await findCredential(tx, userId, "recovery_codes");
        return {
          enrolled: totp?.confirmedAt != null,
          pending: totp !== undefined && totp.confirmedAt === null,
          recoveryCodesLeft: ((recovery?.data as RecoveryData | undefined)?.codes ?? []).length,
        };
      });
    },
  };
}
