import { type Database, listLiveWorkspaceIds, systemContext } from "@fundroom/db";
import type { JobDefinition } from "@fundroom/ports";
import { deleteExpiredChallenges } from "../repos/challenge-repo.js";
import { InviteRepo } from "../repos/membership-repo.js";
import type { SessionService } from "./sessions.js";

/*
 * Identity housekeeping (E0.3 exposed the sweeps, E0.4 schedules them): dead sessions,
 * expired invites, stale rate-limit windows, spent sign-in challenges. Hourly; each step is
 * idempotent.
 *
 * Challenges (E2.10 R1-02): every sign-in start writes an `auth_challenge` row holding the
 * address and the client IP — since P2-02 also for addresses that may not sign in (the decoy),
 * so anyone can make the instance store arbitrary addresses. Nothing may keep them: a row is
 * deleted `CHALLENGE_RETENTION_MS` after it expired, which leaves enough of the recent past for
 * the per-address attempt counters and for an operator looking into a burst of sign-in mail.
 */
export const CHALLENGE_RETENTION_MS = 6 * 3600_000;

export interface IdentityJobOptions {
  readonly db: Database;
  readonly sessions: Pick<SessionService, "sweep">;
  readonly rateLimiter?: { sweep(olderThanMs: number): Promise<number> } | undefined;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export async function runIdentitySweep(options: IdentityJobOptions): Promise<{
  sessions: number;
  invites: number;
  rateLimits: number;
  challenges: number;
}> {
  const now = options.now ? options.now() : new Date();
  const sessions = await options.sessions.sweep();
  let invites = 0;
  for (const workspaceId of await listLiveWorkspaceIds(options.db)) {
    const ctx = systemContext(workspaceId);
    invites += await options.db.withTenant(ctx, (tx) => new InviteRepo(ctx, tx).expire(now));
  }
  const rateLimits = options.rateLimiter ? await options.rateLimiter.sweep(24 * 3600_000) : 0;
  const challenges = await options.db.withHost((tx) =>
    deleteExpiredChallenges(tx, new Date(now.getTime() - CHALLENGE_RETENTION_MS)),
  );
  options.log?.("identity.swept", { sessions, invites, rateLimits, challenges });
  return { sessions, invites, rateLimits, challenges };
}

export function createIdentityJobs(options: IdentityJobOptions): JobDefinition[] {
  return [
    {
      name: "identity.sweep",
      cron: "17 * * * *",
      handler: async () => {
        await runIdentitySweep(options);
      },
    },
  ];
}
