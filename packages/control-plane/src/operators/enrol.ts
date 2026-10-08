import type { AuditRecorder } from "@fundroom/audit";
import type { Database } from "@fundroom/db";
import {
  hashCode,
  type IdentityDeps,
  normalizeEmail,
  otpCode,
  otpEmail,
  randomToken,
  safeEqual,
  sha256,
  verifyCode,
} from "@fundroom/identity";
import type { RateLimitRule } from "@fundroom/ports";
import { auditPlatformChain } from "../workspaces/chains.js";
import {
  consumeEnrolChallenge,
  countEnrolAttempt,
  type EnrolLinkData,
  type EnrolSessionData,
  insertEnrolChallenge,
  lockOpenEnrolChallenge,
  retireEnrolLinks,
  writeEnrolData,
} from "./repos/enrol-repo.js";
import {
  findUserIdByEmail,
  hasStrongFactor,
  insertEmailUser,
  markEmailVerified,
} from "./repos/operator-repo.js";

/*
 * Onboarding a brand-new operator (E3.10 fix round 2). `fundroom operator grant` needs an account
 * that already holds a passkey or a confirmed authenticator (R1-H1), and a person with no account
 * has nowhere to enrol one — so the CLI mints an ENROLMENT LINK instead:
 *
 *   1. `fundroom operator enrol-link <email>` prints a single-use token (30 min) ONCE to stdout.
 *      It is never emailed: the CLI operator hands it over out of band.
 *   2. `POST /platform/enrol/start { token, email }` emails a code to that address — only when
 *      the token is live and was minted for exactly that address (compared in constant time).
 *      The answer is the same `{ ok: true }` after the same floor either way (no oracle).
 *   3. `POST /platform/enrol/verify { token, email, code }` spends the token, creates the user if
 *      the address has none (verified email identity) and opens a 15-minute ENROLMENT-ONLY
 *      session: its cookie (`__Host-op_enrol`) is accepted by nothing but the enrol routes —
 *      begin/confirm an authenticator, begin/finish a passkey — and ends when a factor is added.
 *   4. The CLI operator then runs `fundroom operator grant <email>`; the factor predates the grant,
 *      so the operator session mint accepts it.
 *
 * Both halves are needed: the token alone reaches no mailbox, the mailbox alone has no token. An
 * account that already holds a second factor is not enrolled again this way (`already_enrolled`):
 * adding a factor to it takes a proof with the one it has.
 *
 * The enrolment "session" is deliberately not a `core.session` row: no route that reads the
 * ordinary session cookie can ever accept it, so it cannot sign anybody in anywhere.
 */

export const OPERATOR_ENROL_LINK_TTL_MS = 30 * 60_000;
export const OPERATOR_ENROL_SESSION_TTL_MS = 15 * 60_000;
export const OPERATOR_ENROL_CODE_TTL_MS = 10 * 60_000;
export const OPERATOR_ENROL_MAX_ATTEMPTS = 5;
/** Codes one link may send. */
export const OPERATOR_ENROL_MAX_SENDS = 3;
/** Minimum response time of `start` and `verify`, whatever the outcome. */
export const OPERATOR_ENROL_FLOOR_MS = 250;

export const OPERATOR_ENROL_RATES = {
  startPerIp: { max: 10, windowMs: 3_600_000 },
  verifyPerIp: { max: 20, windowMs: 3_600_000 },
} as const satisfies Record<string, RateLimitRule>;

export interface OperatorEnrolDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** Key ring, mailer, rate limiter, product name, clock. */
  readonly identity: IdentityDeps;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export class OperatorEnrolError extends Error {
  override readonly name = "OperatorEnrolError";
  constructor(
    readonly code: "invalid_code" | "rate_limited" | "already_enrolled" | "invalid_request",
    message: string,
    readonly retryAfterMs?: number | undefined,
  ) {
    super(message);
  }
}

export interface EnrolSession {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: Date;
}

const nowOf = (deps: OperatorEnrolDeps) => deps.identity.now?.() ?? new Date();

function codeScope(linkId: string): string {
  return `operator-enrol:${linkId}`;
}

function ipKey(ip: string | undefined): string {
  return sha256(ip ?? "unknown").toString("hex");
}

async function floor<T>(fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const remaining = OPERATOR_ENROL_FLOOR_MS - (performance.now() - started);
    if (remaining > 0) await new Promise((res) => setTimeout(res, remaining));
  }
}

/** Constant-time: the address the link was minted for equals the one given. */
function sameEmail(stored: string | null, given: string): boolean {
  return safeEqual(sha256(stored ?? "\u0000"), sha256(given));
}

function normalized(email: string): string | undefined {
  try {
    return normalizeEmail(email);
  } catch {
    return undefined;
  }
}

async function spend(
  deps: OperatorEnrolDeps,
  bucket: "start" | "verify",
  ip: string | undefined,
): Promise<void> {
  const d = await deps.identity.rateLimiter.hit(
    `operator-enrol:${bucket}:ip:${ipKey(ip)}`,
    bucket === "start" ? OPERATOR_ENROL_RATES.startPerIp : OPERATOR_ENROL_RATES.verifyPerIp,
  );
  if (!d.allowed) {
    throw new OperatorEnrolError(
      "rate_limited",
      "too many attempts; try again later",
      d.retryAfterMs,
    );
  }
}

/**
 * `fundroom operator enrol-link <email>`: a fresh single-use token for the address (older open
 * links for it are retired). The token is returned once and stored only as a hash.
 */
export async function createEnrolLink(
  deps: Pick<OperatorEnrolDeps, "db" | "audit"> & { readonly now?: (() => Date) | undefined },
  input: { readonly email: string; readonly createdBy: string },
): Promise<{ readonly token: string; readonly email: string; readonly expiresAt: Date }> {
  const email = normalized(input.email);
  if (email === undefined) throw new OperatorEnrolError("invalid_request", "invalid email address");
  const now = deps.now?.() ?? new Date();
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + OPERATOR_ENROL_LINK_TTL_MS);
  await deps.db.withHost(async (tx) => {
    const retired = await retireEnrolLinks(tx, email, now);
    const row = await insertEnrolChallenge(tx, {
      email,
      userId: null,
      secretHash: sha256(token),
      data: { phase: "link", createdBy: input.createdBy, sends: 0 },
      maxAttempts: OPERATOR_ENROL_MAX_ATTEMPTS,
      ip: null,
      createdAt: now,
      expiresAt,
    });
    await auditPlatformChain(
      tx,
      deps.audit,
      { kind: "system", source: "cli" },
      {
        action: "operator.enrol_link",
        resourceKind: "platform_operator",
        resourceId: null,
        meta: { linkId: row.id, email, createdBy: input.createdBy, retired },
      },
    );
  });
  return { token, email, expiresAt };
}

/**
 * Emails a code when the token is live and minted for this address. Always answers the same
 * (after the floor); the only error is the per-IP budget.
 */
export async function startEnrolment(
  deps: OperatorEnrolDeps,
  input: { readonly token: string; readonly email: string; readonly ip?: string | undefined },
): Promise<void> {
  await floor(async () => {
    await spend(deps, "start", input.ip);
    const email = normalized(input.email) ?? "";
    const now = nowOf(deps);
    const code = otpCode(6);
    const send = await deps.db.withHost(async (tx) => {
      const link = await lockOpenEnrolChallenge(tx, sha256(input.token), "link", now);
      // Compare even without a row, so a missing token costs what a wrong address does.
      const matches = sameEmail(link?.email ?? null, email);
      if (link === undefined || !matches) return false;
      const data = link.data as EnrolLinkData;
      if ((data.sends ?? 0) >= OPERATOR_ENROL_MAX_SENDS) return false;
      await writeEnrolData(tx, link.id, {
        ...data,
        codeHash: hashCode(deps.identity.keyRing, code, codeScope(link.id)).toString("hex"),
        codeExpiresAt: new Date(now.getTime() + OPERATOR_ENROL_CODE_TTL_MS).toISOString(),
        sends: (data.sends ?? 0) + 1,
      });
      return true;
    });
    if (!send) return;
    try {
      await deps.identity.mailer.send(
        otpEmail(email, {
          productName: deps.identity.productName,
          code,
          ttlMinutes: OPERATOR_ENROL_CODE_TTL_MS / 60_000,
        }),
      );
    } catch (error) {
      deps.log?.("control_plane.operator_enrol_mail_failed", {
        level: "warn",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  });
}

type Verdict = { readonly ok: true; readonly linkId: string } | { readonly ok: false };

/**
 * Token + address + emailed code → the enrolment session (its token goes in the cookie). Every
 * wrong answer is the same `invalid_code`; a wrong code counts against the link (5, then dead).
 */
export async function verifyEnrolment(
  deps: OperatorEnrolDeps,
  input: {
    readonly token: string;
    readonly email: string;
    readonly code: string;
    readonly ip?: string | undefined;
  },
): Promise<{
  readonly sessionToken: string;
  readonly session: EnrolSession;
  readonly newUser: boolean;
}> {
  return floor(async () => {
    await spend(deps, "verify", input.ip);
    const email = normalized(input.email) ?? "";
    const now = nowOf(deps);
    const invalid = () => new OperatorEnrolError("invalid_code", "the code is wrong or expired");
    // The attempt is counted in its own committed transaction.
    const verdict = await deps.db.withHost(async (tx): Promise<Verdict> => {
      const link = await lockOpenEnrolChallenge(tx, sha256(input.token), "link", now);
      const matches = sameEmail(link?.email ?? null, email);
      if (link === undefined || !matches) return { ok: false };
      const data = link.data as EnrolLinkData;
      if (data.codeHash === undefined || data.codeExpiresAt === undefined) return { ok: false };
      const attempts = await countEnrolAttempt(tx, link.id);
      if (attempts > link.maxAttempts) {
        await consumeEnrolChallenge(tx, link.id, now);
        return { ok: false };
      }
      if (new Date(data.codeExpiresAt).getTime() <= now.getTime()) return { ok: false };
      const ok = verifyCode(
        deps.identity.keyRing,
        input.code.trim(),
        codeScope(link.id),
        Buffer.from(data.codeHash, "hex"),
      );
      return ok ? { ok: true, linkId: link.id } : { ok: false };
    });
    if (!verdict.ok) throw invalid();
    const sessionToken = randomToken(32);
    const expiresAt = new Date(now.getTime() + OPERATOR_ENROL_SESSION_TTL_MS);
    const result = await deps.db.withHost(async (tx) => {
      const link = await lockOpenEnrolChallenge(tx, sha256(input.token), "link", now);
      if (link === undefined || link.id !== verdict.linkId) throw invalid();
      let userId = await findUserIdByEmail(tx, email);
      const newUser = userId === undefined;
      if (userId === undefined) userId = await insertEmailUser(tx, email, now);
      else {
        await markEmailVerified(tx, email, now);
        if (await hasStrongFactor(tx, userId)) {
          throw new OperatorEnrolError(
            "already_enrolled",
            "this account already has a passkey or authenticator: ask for `fundroom operator grant`",
          );
        }
      }
      if (!(await consumeEnrolChallenge(tx, link.id, now))) throw invalid();
      const row = await insertEnrolChallenge(tx, {
        email,
        userId,
        secretHash: sha256(sessionToken),
        data: { phase: "session", linkId: link.id } satisfies EnrolSessionData,
        maxAttempts: 1,
        ip: input.ip ?? null,
        createdAt: now,
        expiresAt,
      });
      await auditPlatformChain(
        tx,
        deps.audit,
        { kind: "system", source: "enrol" },
        {
          action: "operator.enrol",
          resourceKind: "platform_operator",
          resourceId: userId,
          meta: { userId, linkId: link.id, newUser, phase: "session_started" },
        },
      );
      return { session: { id: row.id, userId, email, expiresAt }, newUser };
    });
    return { sessionToken, ...result };
  });
}

/** The live enrolment session behind a cookie value, or `undefined`. */
export async function resolveEnrolSession(
  deps: OperatorEnrolDeps,
  sessionToken: string,
): Promise<EnrolSession | undefined> {
  const now = nowOf(deps);
  return deps.db.withHost(async (tx) => {
    const row = await lockOpenEnrolChallenge(tx, sha256(sessionToken), "session", now);
    if (row === undefined || row.userId === null || row.email === null) return undefined;
    return { id: row.id, userId: row.userId, email: row.email, expiresAt: row.expiresAt };
  });
}

/** Whether the enrolment session's user still has no factor (the only thing it may change). */
export async function enrolSessionMayAddFactor(
  deps: OperatorEnrolDeps,
  session: EnrolSession,
): Promise<boolean> {
  return deps.db.withHost(async (tx) => !(await hasStrongFactor(tx, session.userId)));
}

/** Ends the enrolment session (after a factor was added, or on request). */
export async function endEnrolSession(
  deps: OperatorEnrolDeps,
  session: EnrolSession,
  reason: "factor_added" | "signed_out",
  factor?: "totp" | "passkey" | undefined,
): Promise<void> {
  const now = nowOf(deps);
  await deps.db.withHost(async (tx) => {
    if (!(await consumeEnrolChallenge(tx, session.id, now))) return;
    await auditPlatformChain(
      tx,
      deps.audit,
      { kind: "system", source: "enrol" },
      {
        action: "operator.enrol",
        resourceKind: "platform_operator",
        resourceId: session.userId,
        meta: {
          userId: session.userId,
          phase: reason === "factor_added" ? "factor_added" : "session_ended",
          ...(factor === undefined ? {} : { factor }),
        },
      },
    );
  });
}
