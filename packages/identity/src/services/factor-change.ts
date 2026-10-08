import { describeUserAgent, type FactorChange, factorChangeEmail } from "../mail/templates.js";
import { primaryEmail } from "../repos/user-repo.js";
import { recipientLocale } from "./recipient-locale.js";
import type { SessionService } from "./sessions.js";
import { absoluteUrl, type IdentityDeps, nowOf, pathsOf } from "./types.js";

/*
 * What follows every change to how an account signs in (P2-01, ASVS 6.3.7 / 7.4.3): the password,
 * an authenticator app, a passkey, the recovery codes.
 *
 *  1. Every *other* session of the user is signed out. Whoever changed the factor keeps the
 *     session they did it from; anybody else who held one (the reason a factor gets replaced in a
 *     hurry, or the attacker who just replaced it) has to sign in again with what is now set up.
 *  2. The account's primary address gets a security notice. A mailbox thief sees it too, but the
 *     rightful owner learns that it happened instead of finding out at their next login.
 *
 * Both run after the change is committed. Neither failure undoes it: a notice that cannot be sent
 * is logged for ops, like the new-device mail.
 */
export interface FactorChangeContext {
  /** The session the change was made from; it stays signed in. */
  readonly sessionId?: string | undefined;
  /** Branding of the notice (the workspace the request was made in), if any. */
  readonly workspaceId?: string | undefined;
  readonly workspaceName?: string | undefined;
  readonly userAgent?: string | undefined;
}

export async function afterFactorChange(
  deps: IdentityDeps,
  sessions: Pick<SessionService, "revokeOtherSessions">,
  userId: string,
  change: FactorChange,
  context: FactorChangeContext = {},
): Promise<void> {
  const signedOutOthers = await sessions.revokeOtherSessions(
    userId,
    context.sessionId,
    "credential_changed",
  );
  const { email, locale } = await deps.db.withHost(async (tx) => ({
    email: await primaryEmail(tx, userId),
    locale: await recipientLocale(tx, { userId, workspaceId: context.workspaceId }),
  }));
  if (!email) return;
  try {
    await deps.mailer.send(
      factorChangeEmail(email, {
        productName: deps.productName,
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        locale,
        change,
        device: describeUserAgent(context.userAgent),
        when: nowOf(deps),
        sessionsUrl: absoluteUrl(deps, pathsOf(deps).sessions),
        signedOutOthers,
      }),
    );
  } catch (error) {
    deps.log?.("auth.factor_change_mail_failed", { userId, change, error: String(error) });
  }
}
