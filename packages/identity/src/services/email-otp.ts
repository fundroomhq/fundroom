import { randomBytes } from "node:crypto";
import type { Tx } from "@fundroom/db";
import { hashCode, verifyCode } from "../crypto/keys.js";
import { otpCode, safeEqual, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { otpEmail, shareLinkEmail } from "../mail/templates.js";
import {
  consumeChallenge,
  findLatestChallengeForEmail,
  insertChallenge,
  invalidateChallenges,
  recordAttempt,
} from "../repos/challenge-repo.js";
import { normalizeEmail } from "../repos/user-repo.js";
import { auditLoginFailure, checkEligibility, completeLogin } from "./login.js";
import { RATE_LIMITS, shareLinkRateKey } from "./rate-limiter.js";
import { recipientLocale } from "./recipient-locale.js";
import type { SessionService } from "./sessions.js";
import { sendSignInMailDetached } from "./sign-in-mail.js";
import {
  type IdentityDeps,
  type LoginContext,
  type LoginResult,
  maskEmail,
  nowOf,
  withMinimumDuration,
} from "./types.js";

/*
 * Email OTP, the default investor login (ADR-0012): 6 digits, 10 minutes, 5 attempts, then
 * the code is dead. Codes are stored as an HMAC under the key ring. Start responses are
 * identical for known and unknown emails and take the same time.
 */
export interface EmailOtpOptions {
  readonly ttlMs?: number;
  readonly digits?: number;
  readonly maxAttempts?: number;
  /** Floor for the start endpoint's duration (anti-enumeration timing). */
  readonly minStartMs?: number;
}

export interface OtpStartResult {
  readonly status: "sent";
  /** For the "we sent a code to a***@x.com" copy. */
  readonly emailHint: string;
  readonly ttlMinutes: number;
}

export interface EmailOtpFlow {
  /**
   * `linkId` is set **only** by `POST /links/{token}/start`, which resolved the link from its
   * token and checked its passcode first. It is not a field of the public `/auth/otp/start`
   * request schema and must never become one (contract C4).
   */
  start(
    input: { email: string; ip?: string | undefined } & Pick<
      LoginContext,
      "workspaceId" | "workspaceName" | "linkId"
    > & { readonly linkLabel?: string | undefined; readonly sharedBy?: string | undefined },
  ): Promise<OtpStartResult>;
  verify(input: { email: string; code: string } & LoginContext): Promise<LoginResult>;
}

export function otpScope(workspaceId: string | undefined, email: string): string {
  return `otp:${workspaceId ?? "-"}:${email}`;
}

/**
 * Binds a challenge to the share link it was issued for (E2.3, contract C4).
 *
 * `core.auth_challenge.binding_hash` already exists for the magic link's browser cookie; this
 * reuses it for the same reason. Without it a code issued by link A's `start` — which checked
 * A's passcode, A's domain allowlist and A's expiry — could be spent at link B's `verify`, and
 * the passcode's transitive enforcement would be worth nothing. With it, a bound code is spendable
 * only against the link that minted it, and an unbound code (ordinary `/auth/otp/start`) can never
 * be spent against a link at all.
 */
export function linkBindingHash(linkId: string): Buffer {
  return sha256(`share_link:${linkId}`);
}

function bindingMatches(stored: Buffer | null, linkId: string | undefined): boolean {
  if (stored === null) return linkId === undefined;
  return linkId !== undefined && safeEqual(linkBindingHash(linkId), stored);
}

/** Creates the challenge row (shared with the magic-link flow, which sends a code as fallback). */
export async function createOtpChallenge(
  deps: IdentityDeps,
  tx: Tx,
  input: {
    email: string;
    workspaceId: string | undefined;
    ip: string | undefined;
    ttlMs: number;
    digits: number;
    maxAttempts: number;
    /** `linkBindingHash(linkId)` for a share-link code; absent for an ordinary sign-in. */
    bindingHash?: Buffer | undefined;
    /**
     * A decoy for an address that may not sign in here (P2-02): the same row, attempt counter
     * and expiry as a real challenge, but its secret is random bytes rather than the HMAC of any
     * code, so no code ever verifies against it. `verify` then walks the identical path (and
     * says the identical things: `attemptsLeft`, `too_many_attempts`) for known and unknown
     * addresses. The returned code is never sent anywhere.
     */
    decoy?: boolean | undefined;
  },
): Promise<string> {
  const now = nowOf(deps);
  await invalidateChallenges(tx, "email_otp", input.workspaceId ?? null, input.email);
  const code = otpCode(input.digits);
  const real = hashCode(deps.keyRing, code, otpScope(input.workspaceId, input.email));
  await insertChallenge(tx, {
    kind: "email_otp",
    workspaceId: input.workspaceId ?? null,
    email: input.email,
    secretHash: input.decoy === true ? randomBytes(real.length) : real,
    ...(input.bindingHash === undefined ? {} : { bindingHash: input.bindingHash }),
    maxAttempts: input.maxAttempts,
    ip: input.ip ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  });
  return code;
}

export function createEmailOtpFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: EmailOtpOptions = {},
): EmailOtpFlow {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const digits = options.digits ?? 6;
  const maxAttempts = options.maxAttempts ?? 5;
  const minStartMs = options.minStartMs ?? 250;

  return {
    async start(input) {
      let email: string;
      try {
        email = normalizeEmail(input.email);
      } catch {
        throw new AuthError("invalid_request", "invalid email address");
      }
      const byEmail = await deps.rateLimiter.hit(
        `otp:start:email:${input.workspaceId ?? "-"}:${email}`,
        RATE_LIMITS.otpStartPerEmail,
      );
      const byIp = input.ip
        ? await deps.rateLimiter.hit(`otp:start:ip:${input.ip}`, RATE_LIMITS.otpStartPerIp)
        : { allowed: true, retryAfterMs: 0 };
      // Per link + address, on top of the two above: a share link is an unauthenticated surface,
      // and the link row — not the caller's claimed IP — is the thing being guessed at (D7).
      const byLink =
        input.linkId === undefined
          ? { allowed: true, retryAfterMs: 0 }
          : await deps.rateLimiter.hit(
              shareLinkRateKey("otp_start", input.linkId, email),
              RATE_LIMITS.shareLinkOtpStart,
            );
      if (!byEmail.allowed || !byIp.allowed || !byLink.allowed) {
        throw new AuthError("rate_limited", "too many codes requested", {
          retryAfterMs: Math.max(byEmail.retryAfterMs, byIp.retryAfterMs, byLink.retryAfterMs),
        });
      }

      await withMinimumDuration(minStartMs, async () => {
        const eligibility = await checkEligibility(deps, {
          email,
          workspaceId: input.workspaceId,
          linkId: input.linkId,
        });
        if (!eligibility.eligible) {
          // Same work, no mail: a decoy challenge, so `verify` cannot tell the two apart (P2-02).
          await deps.db.withHost((tx) =>
            createOtpChallenge(deps, tx, {
              email,
              workspaceId: input.workspaceId,
              ip: input.ip,
              ttlMs,
              digits,
              maxAttempts,
              decoy: true,
              ...(input.linkId === undefined ? {} : { bindingHash: linkBindingHash(input.linkId) }),
            }),
          );
          deps.log?.("auth.otp_start_ineligible", { workspaceId: input.workspaceId });
          return;
        }
        const { code, locale } = await deps.db.withHost(async (tx) => {
          const code = await createOtpChallenge(deps, tx, {
            email,
            workspaceId: input.workspaceId,
            ip: input.ip,
            ttlMs,
            digits,
            maxAttempts,
            ...(input.linkId === undefined ? {} : { bindingHash: linkBindingHash(input.linkId) }),
          });
          const locale = await recipientLocale(tx, { email, workspaceId: input.workspaceId });
          return { code, locale };
        });
        const brand = {
          productName: deps.productName,
          workspaceId: input.workspaceId,
          workspaceName: input.workspaceName,
          code,
          ttlMinutes: Math.round(ttlMs / 60_000),
          locale,
        };
        // Started, not awaited (R1-03): delivery must not show in the answer or its timing.
        void sendSignInMailDetached(
          deps,
          input.linkId === undefined
            ? otpEmail(email, brand)
            : shareLinkEmail(email, {
                ...brand,
                ...(input.linkLabel === undefined ? {} : { label: input.linkLabel }),
                ...(input.sharedBy === undefined ? {} : { sharedBy: input.sharedBy }),
              }),
          { kind: "otp", workspaceId: input.workspaceId },
        );
      });

      return {
        status: "sent",
        emailHint: maskEmail(email),
        ttlMinutes: Math.round(ttlMs / 60_000),
      };
    },

    async verify(input) {
      let email: string;
      try {
        email = normalizeEmail(input.email);
      } catch {
        throw new AuthError("invalid_code");
      }
      const code = input.code.replace(/\s+/gu, "");
      if (input.ip) {
        const byIp = await deps.rateLimiter.hit(
          `otp:verify:ip:${input.ip}`,
          RATE_LIMITS.otpVerifyPerIp,
        );
        if (!byIp.allowed)
          throw new AuthError("rate_limited", "too many attempts", {
            retryAfterMs: byIp.retryAfterMs,
          });
      }

      // Transaction 1 commits the attempt (and the invalidation once the cap is hit) before
      // anything can throw — a rollback must never give the attacker the attempt back.
      const attempt = await deps.db.withHost(async (tx) => {
        const challenge = await findLatestChallengeForEmail(
          tx,
          "email_otp",
          input.workspaceId ?? null,
          email,
          nowOf(deps),
        );
        if (!challenge) return undefined;
        const attempts = await recordAttempt(tx, challenge.id);
        const exhausted = attempts > challenge.maxAttempts;
        if (exhausted) await consumeChallenge(tx, challenge.id);
        return { challenge, attempts, exhausted };
      });
      if (!attempt) {
        verifyCode(deps.keyRing, code, otpScope(input.workspaceId, email), Buffer.alloc(32));
        throw new AuthError("invalid_code");
      }
      // A code minted for a share link is spendable only against that link, and a code minted by
      // the ordinary sign-in page is spendable only where no link is named. Checked after the
      // attempt is committed, so a wrong pairing burns an attempt like any other wrong code.
      if (!bindingMatches(attempt.challenge.bindingHash, input.linkId)) {
        await auditLoginFailure(deps, { ...input, method: "email_otp", reason: "wrong_binding" });
        throw new AuthError("invalid_code");
      }
      if (attempt.exhausted) {
        await auditLoginFailure(deps, {
          ...input,
          method: "email_otp",
          reason: "too_many_attempts",
        });
        throw new AuthError("too_many_attempts", "code invalidated; request a new one");
      }
      const scope = otpScope(input.workspaceId, email);
      if (!verifyCode(deps.keyRing, code, scope, attempt.challenge.secretHash)) {
        await auditLoginFailure(deps, { ...input, method: "email_otp", reason: "invalid_code" });
        throw new AuthError("invalid_code", undefined, {
          attemptsLeft: attempt.challenge.maxAttempts - attempt.attempts,
        });
      }
      // Transaction 2: single use, and a magic link sent alongside this code dies with it.
      await deps.db.withHost(async (tx) => {
        if (!(await consumeChallenge(tx, attempt.challenge.id)))
          throw new AuthError("invalid_code");
        await invalidateChallenges(tx, "magic_link", input.workspaceId ?? null, email);
      });

      return completeLogin(deps, sessions, { ...input, email, authLevel: 1, method: "email_otp" });
    },
  };
}
