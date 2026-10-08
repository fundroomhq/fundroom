import type { SsoBinding } from "@fundroom/ports";
import { AuthError } from "../errors.js";

/*
 * E3.8 (ADR-0056, fix round 1 H1): a session minted by one workspace's SSO connection carries only
 * what that tenant's IdP asserted, and a tenant can run any IdP it likes. So such a session may
 * act inside that workspace and nothing more: it may not change the global account — sign-in
 * factors, password, recovery codes, the user's other sessions and devices, their own settings —
 * because each of those reaches every other workspace the person belongs to. Step-up with a
 * factor the user already holds stays possible: it only raises this (bound) session.
 *
 * E3.10 (ADR-0058): a session minted by a central-auth handoff (`boundWorkspaceId`) is bound the
 * same way, for a different reason: its cookie lives on a workspace host whose DNS the tenant
 * controls (a custom domain), so the tenant can capture it. Same rules, its own error code
 * (`bound_session_restricted`) so the SPA can point at the canonical host rather than the IdP.
 */

/** The binding facts a session carries (`AuthenticatedSession` is one). */
export interface SessionBindingFacts {
  readonly sso?: SsoBinding | undefined;
  readonly boundWorkspaceId?: string | undefined;
}

export function isSsoBound(session: SessionBindingFacts): boolean {
  return session.sso !== undefined;
}

/** Minted by a central-auth handoff (E3.10). */
export function isCentralBound(session: SessionBindingFacts): boolean {
  return session.boundWorkspaceId !== undefined;
}

/** Bound to one workspace by either mechanism: it serves that workspace only. */
export function isBoundSession(session: SessionBindingFacts): boolean {
  return isSsoBound(session) || isCentralBound(session);
}

/** The workspace a bound session serves, or undefined for an unbound one. */
export function boundWorkspaceOf(session: SessionBindingFacts): string | undefined {
  return session.sso?.workspaceId ?? session.boundWorkspaceId;
}

/**
 * Throws 403 for a bound session: `sso_session_restricted` for an SSO-bound one (unchanged since
 * E3.8), `bound_session_restricted` for a central-auth one.
 */
export function assertMayChangeAccount(session: SessionBindingFacts): void {
  if (isSsoBound(session)) {
    throw new AuthError(
      "sso_session_restricted",
      "a single sign-on session cannot change your account; sign in another way to do this",
    );
  }
  if (isCentralBound(session)) {
    throw new AuthError(
      "bound_session_restricted",
      "this session belongs to one workspace and cannot change your account; sign in on the main site to do this",
    );
  }
}

/**
 * The rate-limit key a TOTP / recovery-code step-up proof spends (E3.8 fix rounds 2–4). An
 * ordinary session spends the user's own budget (`<base>`). A bound session never touches it — a
 * tenant's IdP could otherwise mint sessions that burn the budget the person's own sign-in on
 * every other workspace needs — and spends one of its own per workspace
 * (`<base>:sso:<workspaceId>`). There is deliberately no bucket shared across workspaces (FR4):
 * a guess from a bound session can only raise that session, in a workspace whose IdP can already
 * assert MFA, so a shared cap bought nothing and let one hostile tenant lock the person's step-up
 * in all the others. A central-bound session (E3.10) gets `<base>:bound:<workspaceId>` for the
 * same reason: a tenant that captured it must not be able to lock the person out elsewhere.
 *
 * Accepted deviation (E3.10 FR1, R2-L2): unlike the SSO case, a central-bound session's TOTP is
 * the person's GLOBAL factor, so a tenant holding a captured bound session (custom domain: the
 * tenant controls DNS) gets its own per-workspace budget of guesses against that global secret.
 * Kept: the proof only raises that one bound session in that one workspace, the per-IP step-up
 * cap still applies, and a shared bucket would hand every hostile tenant a lockout lever (FR4).
 * The ADR records it.
 */
export function stepUpBudgetKey(base: string, session: SessionBindingFacts): string {
  if (session.sso !== undefined) return `${base}:sso:${session.sso.workspaceId}`;
  if (session.boundWorkspaceId !== undefined) return `${base}:bound:${session.boundWorkspaceId}`;
  return base;
}
