import { platformContext } from "@fundroom/db";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { safeEqual, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { consumeChallenge, findChallengeById, insertChallenge } from "../repos/challenge-repo.js";
import {
  findCredentialById,
  findPasskeyByExternalId,
  insertCredential,
  listCredentials,
  revokeCredential,
  updateCredential,
} from "../repos/credential-repo.js";
import { findUserById, primaryEmail, setMfaEnrolled } from "../repos/user-repo.js";
import { afterFactorChange, type FactorChangeContext } from "./factor-change.js";
import { auditStepUpFailure, checkEligibility, completeLogin } from "./login.js";
import { RATE_LIMITS } from "./rate-limiter.js";
import type { SessionService, StepUpResult } from "./sessions.js";
import { type IdentityDeps, type LoginContext, type LoginResult, nowOf } from "./types.js";

/*
 * Passkeys via @simplewebauthn/server (design/02 §2). Discoverable credentials so the login
 * page can be a single "Sign in with a passkey" button and never asks for an email first
 * (which would be an enumeration oracle). A passkey assertion with user verification is an
 * MFA-grade proof (possession + PIN/biometric) → auth level 2.
 */
export interface PasskeyOptions {
  /** Relying-party id: the portal's registrable domain, e.g. `investors.acme.com`. */
  readonly rpId: string;
  readonly rpName: string;
  /** Origins that may complete ceremonies (scheme + host [+ port]). */
  readonly origins: readonly string[];
  readonly challengeTtlMs?: number;
  /** Injection seam for tests; production uses the library. */
  readonly webauthn?: PasskeyWebauthn;
}

export interface PasskeyWebauthn {
  readonly generateRegistrationOptions: typeof generateRegistrationOptions;
  readonly verifyRegistrationResponse: typeof verifyRegistrationResponse;
  readonly generateAuthenticationOptions: typeof generateAuthenticationOptions;
  readonly verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export interface PasskeySummary {
  readonly id: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | undefined;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
}

/** `finishRegistration`'s result: the new passkey, and whether the authenticator verified the user. */
export interface RegisteredPasskey extends PasskeySummary {
  /**
   * The authenticator reported user verification (the UV flag) during this ceremony. Non-UV keys
   * still register (`requireUserVerification: false`); only a UV one is a second-factor proof on
   * its own, so only it may raise the session to level 2 (E-UP-18).
   */
  readonly userVerified: boolean;
}

export interface PasskeyFlow {
  beginRegistration(input: {
    userId: string;
  }): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>;
  finishRegistration(input: {
    userId: string;
    challengeId: string;
    response: RegistrationResponseJSON;
    label?: string | undefined;
    /** Signs out the user's other sessions and sends the security notice (P2-01). */
    context?: FactorChangeContext | undefined;
  }): Promise<RegisteredPasskey>;
  beginAuthentication(input: {
    ip?: string | undefined;
  }): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>;
  finishAuthentication(
    input: { challengeId: string; response: AuthenticationResponseJSON } & LoginContext,
  ): Promise<LoginResult>;
  /**
   * Re-proves possession for step-up on an existing session (no new session); returns the
   * session's new token (F-12).
   */
  finishStepUp(input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
    sessionId: string;
    userId: string;
    /** The cookie value the request authenticated with (R1-04, see `SessionService.stepUp`). */
    presentedToken?: string | undefined;
  }): Promise<StepUpResult>;
  list(userId: string): Promise<PasskeySummary[]>;
  rename(userId: string, credentialId: string, label: string): Promise<boolean>;
  remove(
    userId: string,
    credentialId: string,
    context?: FactorChangeContext | undefined,
  ): Promise<boolean>;
}

function summarize(row: {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  backedUp: boolean | null;
  transports: string[] | null;
}): PasskeySummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
    backedUp: row.backedUp ?? false,
    transports: row.transports ?? [],
  };
}

/**
 * Key in a passkey credential's `data` recording its last assertion *without* user verification
 * used for a step-up: `{ sessionId, at }` (E2.10 R1-05). Read by `AuthService.canManageFactors`.
 */
export const PASSKEY_PRESENCE_KEY = "presenceStepUp";

export function createPasskeyFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: PasskeyOptions,
): PasskeyFlow {
  const ttlMs = options.challengeTtlMs ?? 5 * 60_000;
  const lib: PasskeyWebauthn = options.webauthn ?? {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
  };
  const origins = [...options.origins];

  async function loadChallenge(
    challengeId: string,
    kind: "webauthn_register" | "webauthn_login",
    userId?: string,
  ) {
    const now = nowOf(deps);
    return deps.db.withHost(async (tx) => {
      const ch = await findChallengeById(tx, challengeId);
      if (
        !ch ||
        ch.kind !== kind ||
        ch.consumedAt !== null ||
        ch.expiresAt.getTime() <= now.getTime()
      ) {
        throw new AuthError("invalid_code", "unknown or expired challenge");
      }
      if (userId !== undefined && ch.userId !== userId)
        throw new AuthError("invalid_code", "challenge belongs to another user");
      return ch;
    });
  }

  async function verifyAssertion(
    challengeId: string,
    response: AuthenticationResponseJSON,
    expectUserId?: string,
  ) {
    const ch = await loadChallenge(challengeId, "webauthn_login");
    const cred = await deps.db.withHost((tx) => findPasskeyByExternalId(tx, response.id));
    if (!cred || (expectUserId !== undefined && cred.userId !== expectUserId)) {
      throw new AuthError("invalid_credential", "unknown passkey");
    }
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await lib.verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => safeEqual(sha256(c), ch.secretHash),
        expectedOrigin: origins,
        expectedRPID: options.rpId,
        credential: {
          id: cred.externalId as string,
          publicKey: new Uint8Array(cred.publicKey as Buffer),
          counter: cred.signCount ?? 0,
          transports: (cred.transports ?? []) as never,
        },
        requireUserVerification: false,
      });
    } catch (error) {
      throw new AuthError("invalid_credential", "passkey assertion failed", {}, { cause: error });
    }
    if (!verification.verified)
      throw new AuthError("invalid_credential", "passkey assertion failed");
    await deps.db.withHost(async (tx) => {
      if (!(await consumeChallenge(tx, ch.id))) throw new AuthError("invalid_code");
      await updateCredential(tx, cred.id, {
        signCount: verification.authenticationInfo.newCounter,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: nowOf(deps),
      });
    });
    return { cred, userVerified: verification.authenticationInfo.userVerified };
  }

  return {
    async beginRegistration({ userId }) {
      const now = nowOf(deps);
      const { user, email, existing } = await deps.db.withHost(async (tx) => ({
        user: await findUserById(tx, userId),
        email: await primaryEmail(tx, userId),
        existing: await listCredentials(tx, userId, "passkey"),
      }));
      if (!user) throw new AuthError("unauthenticated");
      const opts = await lib.generateRegistrationOptions({
        rpName: options.rpName,
        rpID: options.rpId,
        userName: email ?? user.id,
        userID: new Uint8Array(Buffer.from(user.id.replace(/-/gu, ""), "hex")),
        userDisplayName: user.displayName || email || "",
        attestationType: "none",
        excludeCredentials: existing.map((c) => ({
          id: c.externalId as string,
          transports: (c.transports ?? []) as never,
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        timeout: ttlMs,
      });
      const ch = await deps.db.withHost((tx) =>
        insertChallenge(tx, {
          kind: "webauthn_register",
          userId,
          secretHash: sha256(opts.challenge),
          maxAttempts: 1,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        }),
      );
      return { challengeId: ch.id, options: opts };
    },

    async finishRegistration({ userId, challengeId, response, label, context }) {
      const ch = await loadChallenge(challengeId, "webauthn_register", userId);
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await lib.verifyRegistrationResponse({
          response,
          expectedChallenge: (c) => safeEqual(sha256(c), ch.secretHash),
          expectedOrigin: origins,
          expectedRPID: options.rpId,
          requireUserVerification: false,
        });
      } catch (error) {
        throw new AuthError(
          "invalid_credential",
          "passkey registration failed",
          {},
          { cause: error },
        );
      }
      if (!verification.verified)
        throw new AuthError("invalid_credential", "passkey registration failed");
      const info = verification.registrationInfo;
      const row = await deps.db.withHost(async (tx) => {
        if (!(await consumeChallenge(tx, ch.id))) throw new AuthError("invalid_code");
        const created = await insertCredential(tx, {
          userId,
          kind: "passkey",
          label: (label ?? "").trim().slice(0, 80) || "Passkey",
          externalId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          signCount: info.credential.counter,
          transports: info.credential.transports ?? [],
          backupEligible: info.credentialDeviceType === "multiDevice",
          backedUp: info.credentialBackedUp,
          aaguid: info.aaguid,
          createdAt: nowOf(deps),
        });
        await setMfaEnrolled(tx, userId, true);
        return created;
      });
      await deps.audit.recordDetached(
        { ...platformContext(), userId },
        {
          action: "auth.passkey_added",
          resourceKind: "credential",
          resourceId: row.id,
          actorUserId: userId,
          meta: { aaguid: row.aaguid ?? null, backedUp: row.backedUp ?? null },
        },
      );
      deps.log?.("auth.passkey_registered", { userId });
      await afterFactorChange(deps, sessions, userId, "passkey_added", context);
      return { ...summarize(row), userVerified: info.userVerified === true };
    },

    async beginAuthentication({ ip }) {
      if (ip) {
        const r = await deps.rateLimiter.hit(`passkey:ip:${ip}`, RATE_LIMITS.passkeyPerIp);
        if (!r.allowed)
          throw new AuthError("rate_limited", undefined, { retryAfterMs: r.retryAfterMs });
      }
      const now = nowOf(deps);
      const opts = await lib.generateAuthenticationOptions({
        rpID: options.rpId,
        userVerification: "preferred",
        timeout: ttlMs,
      });
      const ch = await deps.db.withHost((tx) =>
        insertChallenge(tx, {
          kind: "webauthn_login",
          secretHash: sha256(opts.challenge),
          maxAttempts: 1,
          ip: ip ?? null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        }),
      );
      return { challengeId: ch.id, options: opts };
    },

    async finishAuthentication(input) {
      const { cred, userVerified } = await verifyAssertion(input.challengeId, input.response);
      const email = await deps.db.withHost((tx) => primaryEmail(tx, cred.userId));
      if (email && input.workspaceId) {
        const e = await checkEligibility(deps, {
          email,
          userId: cred.userId,
          workspaceId: input.workspaceId,
        });
        if (!e.eligible) throw new AuthError("not_eligible");
      }
      return completeLogin(deps, sessions, {
        ...input,
        userId: cred.userId,
        authLevel: userVerified ? 2 : 1,
        method: "passkey",
      });
    },

    async finishStepUp({ challengeId, response, sessionId, userId, presentedToken }) {
      let userVerified: boolean;
      let cred: Awaited<ReturnType<typeof verifyAssertion>>["cred"];
      try {
        ({ cred, userVerified } = await verifyAssertion(challengeId, response, userId));
      } catch (error) {
        await auditStepUpFailure(deps, {
          userId,
          sessionId,
          method: "passkey",
          reason: error instanceof AuthError ? error.code : "error",
        });
        throw error;
      }
      if (!userVerified) {
        // A security key without a PIN (R1-05): possession of an enrolled factor, but not MFA
        // on its own, so the session stays level 1. What it does prove is noted on the key, for
        // this session: managing factors asks for exactly that proof (`canManageFactors`).
        const data = (cred.data ?? {}) as Record<string, unknown>;
        await deps.db.withHost((tx) =>
          updateCredential(tx, cred.id, {
            data: {
              ...data,
              [PASSKEY_PRESENCE_KEY]: { sessionId, at: nowOf(deps).toISOString() },
            },
          }),
        );
      }
      return sessions.stepUp(sessionId, userVerified ? 2 : 1, "passkey", { presentedToken });
    },

    async list(userId) {
      const rows = await deps.db.withHost((tx) => listCredentials(tx, userId, "passkey"));
      return rows.map(summarize);
    },

    async rename(userId, credentialId, label) {
      return deps.db.withHost(async (tx) => {
        const row = await findCredentialById(tx, credentialId, userId);
        if (row?.kind !== "passkey") return false;
        await updateCredential(tx, credentialId, { label: label.trim().slice(0, 80) });
        return true;
      });
    },

    async remove(userId, credentialId, context) {
      const ok = await deps.db.withHost(async (tx) => {
        const row = await findCredentialById(tx, credentialId, userId);
        if (row?.kind !== "passkey") return false;
        const revoked = await revokeCredential(tx, credentialId, userId);
        const remaining = await listCredentials(tx, userId);
        const stillMfa = remaining.some(
          (c) => c.kind === "passkey" || (c.kind === "totp" && c.confirmedAt !== null),
        );
        await setMfaEnrolled(tx, userId, stillMfa);
        return revoked;
      });
      if (ok) {
        await deps.audit.recordDetached(
          { ...platformContext(), userId },
          {
            action: "auth.passkey_removed",
            resourceKind: "credential",
            resourceId: credentialId,
            actorUserId: userId,
          },
        );
        await afterFactorChange(deps, sessions, userId, "passkey_removed", context);
      }
      return ok;
    },
  };
}
