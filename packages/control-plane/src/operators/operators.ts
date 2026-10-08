import type { AuditRecorder } from "@fundroom/audit";
import type { Database } from "@fundroom/db";
import type { AuthenticatedSession } from "@fundroom/ports";
import { auditPlatformChain } from "../workspaces/chains.js";
import type { ControlPlaneActor } from "../workspaces/status.js";
import {
  findLiveOperator,
  findUserFacts,
  findUserIdByEmail,
  hasStrongFactor,
  listOperatorRows,
  lockOperatorRow,
  proofFactorsUsedSince,
  revokeOperatorSessions,
  writeOperatorGrant,
  writeOperatorRevoke,
} from "./repos/operator-repo.js";

/*
 * Platform operators (E3.10, ADR-0058; owner: agent A). An operator is a `core.platform_operator`
 * row with `revoked_at IS NULL`, granted and revoked only by the CLI (`fundroom operator
 * grant|revoke|list`), audited on the platform chain (`operator.grant` / `operator.revoke`).
 *
 * `isLiveOperator` is used by `requirePlatformOperator()` (apps/server/src/middleware/platform.ts)
 * on EVERY operator request — it is the live re-check, so it must stay one indexed read in its own
 * short host transaction.
 */

/** True when the user holds a live operator row right now. */
export async function isLiveOperator(db: Database, userId: string): Promise<boolean> {
  return db.withHost(async (tx) => (await findLiveOperator(tx, userId)) !== undefined);
}

export interface OperatorDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly now?: (() => Date) | undefined;
}

export interface OperatorGrantInput {
  readonly email: string;
  /** `cli:<os user>`. */
  readonly createdBy: string;
}

export interface OperatorSummary {
  readonly userId: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly revokedAt: Date | null;
}

export class OperatorInputError extends Error {
  override readonly name = "OperatorInputError";
}

/**
 * `fundroom operator grant` refused: no such account, or the account has no passkey and no
 * confirmed authenticator. Granting to a mailbox alone would let whoever reads that mailbox sign
 * in, enrol a factor of their own and open the operator console (R1-H1).
 */
export class OperatorGrantRefused extends Error {
  override readonly name = "OperatorGrantRefused";
  constructor(
    readonly reason: "no_user" | "no_factor",
    message: string,
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Lower-cased and shape-checked, like identity's `normalizeEmail` (throws `OperatorInputError`). */
export function normalizeOperatorEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new OperatorInputError("invalid email address");
  return e;
}

const CLI_ACTOR: ControlPlaneActor = { kind: "system", source: "cli" };

/**
 * Grants the operator role to an EXISTING account that already holds a passkey or a confirmed
 * authenticator (`OperatorGrantRefused` otherwise — the person signs in on the canonical host and
 * enrols one first). A live grant is left as it is (`changed: false`, no audit); a revoked one is
 * granted again.
 */
export async function grantOperator(
  deps: OperatorDeps,
  input: OperatorGrantInput,
): Promise<OperatorSummary & { readonly changed: boolean }> {
  const email = normalizeOperatorEmail(input.email);
  return deps.db.withHost(async (tx) => {
    const userId = await findUserIdByEmail(tx, email);
    if (userId === undefined) {
      throw new OperatorGrantRefused(
        "no_user",
        `no account for ${email}: sign in on the canonical host and enrol a passkey or authenticator first`,
      );
    }
    if (!(await hasStrongFactor(tx, userId))) {
      throw new OperatorGrantRefused(
        "no_factor",
        `${email} has no passkey or authenticator: enrol one on the canonical host first`,
      );
    }
    // The operator row first, then the platform chain (own rows before the first audit).
    const existing = await lockOperatorRow(tx, userId);
    if (existing !== undefined && existing.revokedAt === null) {
      return { ...existing, email, changed: false };
    }
    const row = await writeOperatorGrant(tx, userId, input.createdBy, existing !== undefined);
    await auditPlatformChain(tx, deps.audit, CLI_ACTOR, {
      action: "operator.grant",
      resourceKind: "platform_operator",
      resourceId: userId,
      meta: { userId, createdBy: input.createdBy, regrant: existing !== undefined },
    });
    return { ...row, email, changed: true };
  });
}

/**
 * Revokes the operator role and ends the user's operator sessions (their tenant sessions stay).
 * `undefined` when the address has no user or no live grant.
 */
export async function revokeOperator(
  deps: OperatorDeps,
  input: { readonly email: string; readonly revokedBy: string },
): Promise<(OperatorSummary & { readonly sessionsEnded: number }) | undefined> {
  const email = normalizeOperatorEmail(input.email);
  const now = deps.now?.() ?? new Date();
  return deps.db.withHost(async (tx) => {
    const userId = await findUserIdByEmail(tx, email);
    if (userId === undefined) return undefined;
    const locked = await lockOperatorRow(tx, userId);
    if (locked === undefined || locked.revokedAt !== null) return undefined;
    const row = await writeOperatorRevoke(tx, userId, now);
    if (row === undefined) return undefined;
    const sessionsEnded = await revokeOperatorSessions(tx, userId, now);
    await auditPlatformChain(tx, deps.audit, CLI_ACTOR, {
      action: "operator.revoke",
      resourceKind: "platform_operator",
      resourceId: userId,
      meta: { userId, revokedBy: input.revokedBy, sessionsEnded },
    });
    return { ...row, email, sessionsEnded };
  });
}

/** Every operator row, revoked ones included, oldest grant first. */
export async function listOperators(db: Database): Promise<readonly OperatorSummary[]> {
  return db.withHost((tx) => listOperatorRows(tx));
}

/** The operator's display name and primary email (`GET /platform/me`). */
export async function operatorProfile(
  db: Database,
  userId: string,
): Promise<{ readonly displayName: string; readonly email: string | null } | undefined> {
  return db.withHost((tx) => findUserFacts(tx, userId));
}

// --- operator sessions --------------------------------------------------------------------------

/** How fresh the user session must be to mint an operator session (§5.2): 10 minutes. */
export const OPERATOR_MINT_MAX_AGE_MS = 10 * 60_000;

/**
 * Why a user session may not mint an operator session, or `undefined` when it may. Pure; the
 * route adds the checks that need I/O (control plane on, canonical host, CIDR, live operator).
 *
 *  - `bound`: an SSO- or central-auth-bound session vouches for one tenant only (its IdP or the
 *    tenant-controlled host that received the handoff), never for the platform.
 *  - `population`: only an ordinary staff/external user session (not an operator session).
 *  - `level`: auth level 2 (passkey or TOTP) is required.
 *  - `stale`: the level must have been proven within the last 10 minutes.
 */
export function operatorMintRefusal(
  session: Pick<AuthenticatedSession, "population" | "authLevel" | "authTime" | "sso"> & {
    readonly boundWorkspaceId?: string | null | undefined;
    readonly bound?: unknown;
  },
  now: Date,
): "bound" | "population" | "level" | "stale" | undefined {
  if (
    session.sso !== undefined ||
    (session.boundWorkspaceId !== undefined && session.boundWorkspaceId !== null) ||
    (session.bound !== undefined && session.bound !== null && session.bound !== false)
  ) {
    return "bound";
  }
  if (session.population === "operator") return "population";
  if (session.authLevel < 2) return "level";
  const age = now.getTime() - session.authTime.getTime();
  if (!(age >= -60_000 && age <= OPERATOR_MINT_MAX_AGE_MS)) return "stale";
  return undefined;
}

/** How far before `auth_time` the proving factor's `last_used_at` may lie (same request). */
export const OPERATOR_PROOF_WINDOW_MS = 60_000;

/**
 * The second half of the mint check (R1-H1, fix round 2): the level-2 proof must come from factors
 * that were usable BEFORE the operator grant (the live `platform_operator.created_at`) and before
 * the session was created. A factor enrolled after the grant — by whoever holds the mailbox and a
 * session, or by the operator after losing a device — never vouches for an operator session: a
 * re-enrolled operator is revoked and granted again (`fundroom operator revoke` + `grant`), which
 * is the CLI operator vouching for the new factor. `undefined` = admitted; `unproven` = no factor
 * was used for the current proof (a host-asserted level); `new_factor` = a factor used was
 * enrolled after the grant or inside the session; `not_operator` = no live grant row.
 */
export function operatorProofRefusal(
  factors: readonly { readonly usableSince: Date }[],
  sessionCreatedAt: Date,
  grantedAt: Date | undefined,
): "unproven" | "new_factor" | "not_operator" | undefined {
  if (grantedAt === undefined) return "not_operator";
  if (factors.length === 0) return "unproven";
  const bound = Math.min(sessionCreatedAt.getTime(), grantedAt.getTime());
  return factors.every((f) => f.usableSince.getTime() < bound) ? undefined : "new_factor";
}

/** Loads the factors behind the session's current level-2 proof and applies the rule above. */
export async function checkOperatorProof(
  db: Database,
  session: Pick<AuthenticatedSession, "userId" | "authTime" | "createdAt">,
): Promise<"unproven" | "new_factor" | "not_operator" | undefined> {
  const since = new Date(session.authTime.getTime() - OPERATOR_PROOF_WINDOW_MS);
  const { factors, grant } = await db.withHost(async (tx) => ({
    factors: await proofFactorsUsedSince(tx, session.userId, since),
    grant: await findLiveOperator(tx, session.userId),
  }));
  return operatorProofRefusal(factors, session.createdAt, grant?.createdAt);
}
