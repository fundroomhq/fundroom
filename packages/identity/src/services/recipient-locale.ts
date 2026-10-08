import type { Tx } from "@fundroom/db";
import { type Locale, negotiateLocale } from "@fundroom/i18n";
import { findLocalePreferences } from "../repos/user-repo.js";

/**
 * The language an email goes out in (E2.8): `user.locale ?? workspace.default_locale ?? "en"`.
 * Runs on the caller's host-context transaction (never opens its own: the pool-deadlock rule).
 * Unknown or unsupported stored values negotiate to `en` rather than throwing.
 */
export async function recipientLocale(
  tx: Tx,
  input: {
    readonly userId?: string | undefined;
    readonly email?: string | undefined;
    readonly workspaceId?: string | undefined;
  },
): Promise<Locale> {
  const prefs = await findLocalePreferences(tx, input);
  return negotiateLocale(undefined, prefs.user, prefs.workspace);
}
