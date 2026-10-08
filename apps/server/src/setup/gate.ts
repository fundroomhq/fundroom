import type { Database } from "@fundroom/db";
import { countSetupBlockingWorkspaces } from "../workspace/repos/lifecycle-repo.js";

/*
 * "Is setup required?" for the whole install: true until the first workspace exists. The
 * wizard creates the workspace and its owner in one step, so "a workspace exists" and "an
 * owner exists" are the same fact (a workspace without an owner can only be a failed
 * setup, which is rolled back). Cached briefly because the web role asks on every page
 * render; the wizard invalidates it the moment it succeeds.
 *
 * "Exists" includes a workspace deleted from the danger zone that is still inside its restore
 * window (or awaiting the purge): until it is purged it can be restored, and reopening setup next
 * to it would let whoever holds the setup token mint a fresh owner on the instance. A row that
 * was soft-deleted without a purge clock (the wizard's own rollback of a failed setup) and a
 * purged one do not count (`countSetupBlockingWorkspaces`).
 */
export interface SetupGate {
  required(): Promise<boolean>;
  invalidate(): void;
}

export interface SetupGateOptions {
  readonly db: Database;
  readonly cacheMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * E-UP-11: the first-run wizard is off (CONTROL_PLANE=on): `required()` is always false and
   * the database is never asked. Workspaces come from signup and the operator API instead.
   */
  readonly disabled?: boolean | undefined;
  /** Test seam over `countSetupBlockingWorkspaces`. */
  readonly count?: (() => Promise<number>) | undefined;
}

export function createSetupGate(options: SetupGateOptions): SetupGate {
  const cacheMs = options.cacheMs ?? 15_000;
  const now = options.now ?? Date.now;
  let cached: { value: boolean; until: number } | undefined;
  return {
    async required() {
      if (options.disabled === true) return false;
      if (cached && cached.until > now()) return cached.value;
      const n = await (
        options.count ?? (() => options.db.withHost((tx) => countSetupBlockingWorkspaces(tx)))
      )();
      const value = n === 0;
      // Only the settled state is cached: "required" flips exactly once, and we would rather
      // ask again than show the wizard to someone after another replica finished it.
      cached = value ? undefined : { value, until: now() + cacheMs };
      return value;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
