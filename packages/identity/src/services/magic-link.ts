import { randomToken, safeEqual, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { describeUserAgent, magicLinkEmail } from "../mail/templates.js";
import {
  consumeChallenge,
  findChallengeBySecretHash,
  insertChallenge,
  invalidateChallenges,
} from "../repos/challenge-repo.js";
import { normalizeEmail } from "../repos/user-repo.js";
import { createOtpChallenge } from "./email-otp.js";
import { auditLoginFailure, checkEligibility, completeLogin } from "./login.js";
import { RATE_LIMITS } from "./rate-limiter.js";
import { recipientLocale } from "./recipient-locale.js";
import type { SessionService } from "./sessions.js";
import { sendSignInMailDetached } from "./sign-in-mail.js";
import {
  absoluteUrl,
  type IdentityDeps,
  type LoginContext,
  type LoginResult,
  maskEmail,
  nowOf,
  pathsOf,
  withMinimumDuration,
} from "./types.js";

/*
 * Magic link, optional per workspace (ADR-0012):
 *  - the email carries a link *and* a code; the link lands on a page with one button that
 *    POSTs the token (GET never consumes it, so mail scanners cannot burn it);
 *  - the browser that requested the link gets a `__Host-auth_req` cookie; a confirm from a
 *    browser without it is refused with `binding_mismatch`, and the UI falls back to the code;
 *  - 10 minutes (ASVS 6.5.5 caps out-of-band requests there; F-16), single use; consuming
 *    either the link or the code kills both.
 */
/** Default link (and fallback code) lifetime: ASVS 6.5.5's 10-minute ceiling. */
export const MAGIC_LINK_TTL_MS = 10 * 60_000;

export interface MagicLinkOptions {
  readonly ttlMs?: number;
  readonly minStartMs?: number;
}

export interface MagicLinkStartResult {
  readonly status: "sent";
  readonly emailHint: string;
  readonly ttlMinutes: number;
  /** Value for the `auth_req` cookie (caller serialises it with the session cookie mode). */
  readonly bindingToken: string;
  readonly bindingMaxAgeSeconds: number;
}

export interface MagicLinkFlow {
  start(
    input: { email: string; ip?: string | undefined; userAgent?: string | undefined } & Pick<
      LoginContext,
      "workspaceId" | "workspaceName"
    >,
  ): Promise<MagicLinkStartResult>;
  /** POST-to-confirm. `bindingToken` is the `auth_req` cookie value the browser sent, if any. */
  confirm(
    input: { token: string; bindingToken?: string | undefined } & LoginContext,
  ): Promise<LoginResult>;
  /** What the confirm page may show before the button is pressed; never consumes anything. */
  peek(token: string): Promise<{ valid: boolean; emailHint?: string; requestedFrom?: string }>;
}

export function createMagicLinkFlow(
  deps: IdentityDeps,
  sessions: SessionService,
  options: MagicLinkOptions = {},
): MagicLinkFlow {
  const ttlMs = options.ttlMs ?? MAGIC_LINK_TTL_MS;
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
      if (!byEmail.allowed || !byIp.allowed) {
        throw new AuthError("rate_limited", "too many links requested", {
          retryAfterMs: Math.max(byEmail.retryAfterMs, byIp.retryAfterMs),
        });
      }

      const bindingToken = randomToken(16);
      await withMinimumDuration(minStartMs, async () => {
        const eligibility = await checkEligibility(deps, { email, workspaceId: input.workspaceId });
        if (!eligibility.eligible) {
          sha256(randomToken());
          // The link's code fallback is verified by `/auth/otp/verify`: a decoy challenge keeps
          // that endpoint's answers identical for known and unknown addresses (P2-02).
          await deps.db.withHost((tx) =>
            createOtpChallenge(deps, tx, {
              email,
              workspaceId: input.workspaceId,
              ip: input.ip,
              ttlMs,
              digits: 6,
              maxAttempts: 5,
              decoy: true,
            }),
          );
          deps.log?.("auth.magic_link_start_ineligible", { workspaceId: input.workspaceId });
          return;
        }
        const now = nowOf(deps);
        const linkToken = randomToken();
        const { code, locale } = await deps.db.withHost(async (tx) => {
          await invalidateChallenges(tx, "magic_link", input.workspaceId ?? null, email);
          await insertChallenge(tx, {
            kind: "magic_link",
            workspaceId: input.workspaceId ?? null,
            email,
            secretHash: sha256(linkToken),
            bindingHash: sha256(bindingToken),
            data: { requestedFrom: describeUserAgent(input.userAgent) },
            maxAttempts: 1,
            ip: input.ip ?? null,
            createdAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
          });
          const code = await createOtpChallenge(deps, tx, {
            email,
            workspaceId: input.workspaceId,
            ip: input.ip,
            ttlMs,
            digits: 6,
            maxAttempts: 5,
          });
          const locale = await recipientLocale(tx, { email, workspaceId: input.workspaceId });
          return { code, locale };
        });
        // Started, not awaited (R1-03): delivery must not show in the answer or its timing.
        void sendSignInMailDetached(
          deps,
          magicLinkEmail(email, {
            productName: deps.productName,
            workspaceId: input.workspaceId,
            workspaceName: input.workspaceName,
            url: absoluteUrl(deps, pathsOf(deps).magicLinkConfirm, { token: linkToken }),
            code,
            ttlMinutes: Math.round(ttlMs / 60_000),
            device: describeUserAgent(input.userAgent),
            locale,
          }),
          { kind: "magic_link", workspaceId: input.workspaceId },
        );
      });

      return {
        status: "sent",
        emailHint: maskEmail(email),
        ttlMinutes: Math.round(ttlMs / 60_000),
        bindingToken,
        bindingMaxAgeSeconds: Math.ceil(ttlMs / 1000),
      };
    },

    async peek(token) {
      if (typeof token !== "string" || token.length < 32) return { valid: false };
      const now = nowOf(deps);
      return deps.db.withHost(async (tx) => {
        const ch = await findChallengeBySecretHash(tx, "magic_link", sha256(token));
        if (!ch || ch.consumedAt !== null || ch.expiresAt.getTime() <= now.getTime() || !ch.email)
          return { valid: false };
        const data = ch.data as { requestedFrom?: string };
        return {
          valid: true,
          emailHint: maskEmail(ch.email),
          requestedFrom: data.requestedFrom ?? "",
        };
      });
    },

    async confirm(input) {
      if (typeof input.token !== "string" || input.token.length < 32)
        throw new AuthError("invalid_code");
      const now = nowOf(deps);
      const email = await deps.db.withHost(async (tx) => {
        const ch = await findChallengeBySecretHash(tx, "magic_link", sha256(input.token));
        if (!ch || ch.consumedAt !== null || !ch.email) throw new AuthError("invalid_code");
        if (ch.expiresAt.getTime() <= now.getTime())
          throw new AuthError("expired", "the link has expired");
        if ((ch.workspaceId ?? undefined) !== input.workspaceId) {
          throw new AuthError("invalid_code");
        }
        const bound =
          input.bindingToken !== undefined &&
          ch.bindingHash !== null &&
          safeEqual(sha256(input.bindingToken), ch.bindingHash);
        if (!bound) {
          // Leave the link alive: the same browser can still enter the code from the email.
          await auditLoginFailure(deps, {
            ...input,
            method: "magic_link",
            reason: "binding_mismatch",
          });
          throw new AuthError(
            "binding_mismatch",
            "this link was requested from a different browser; enter the code instead",
            {
              emailHint: maskEmail(ch.email),
            },
          );
        }
        if (!(await consumeChallenge(tx, ch.id))) throw new AuthError("invalid_code");
        await invalidateChallenges(tx, "email_otp", ch.workspaceId, ch.email);
        return ch.email;
      });
      return completeLogin(deps, sessions, { ...input, email, authLevel: 1, method: "magic_link" });
    },
  };
}
