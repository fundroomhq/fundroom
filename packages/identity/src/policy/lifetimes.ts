import type { AuthLevel, AuthPopulation } from "@fundroom/ports";

/*
 * Session lifetimes by population (EXECUTION_PLAN §6.3, design/05 §3.3). Workspace admins
 * may tune these later (E2.7) but only within PLATFORM_BOUNDS; the kernel clamps.
 */
export interface SessionLifetimes {
  readonly idleMs: number;
  readonly absoluteMs: number;
  /** Absolute lifetime when the user ticked "remember this device". */
  readonly rememberedAbsoluteMs: number;
  /** Oldest sessions are revoked when a new login would exceed this. */
  readonly maxConcurrent: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_LIFETIMES: Readonly<Record<AuthPopulation, SessionLifetimes>> = {
  external: {
    idleMs: 24 * HOUR,
    absoluteMs: 14 * DAY,
    rememberedAbsoluteMs: 30 * DAY,
    maxConcurrent: 5,
  },
  staff: {
    idleMs: 12 * HOUR,
    absoluteMs: 7 * DAY,
    rememberedAbsoluteMs: 30 * DAY,
    maxConcurrent: 10,
  },
  operator: {
    idleMs: 1 * HOUR,
    absoluteMs: 12 * HOUR,
    rememberedAbsoluteMs: 12 * HOUR,
    maxConcurrent: 3,
  },
};

/**
 * Concurrent sessions one user may hold bound to one workspace by central auth (E3.10 FR1). A
 * separate cap from the population's: a bound session serves that workspace only, so it neither
 * counts against nor evicts the user's canonical (or operator) sessions; a new handoff for the
 * same workspace replaces the least recently seen.
 */
export const BOUND_SESSION_MAX_CONCURRENT = 3;

/** Ceilings no workspace setting can exceed. */
export const PLATFORM_BOUNDS = {
  maxIdleMs: 30 * DAY,
  maxAbsoluteMs: 90 * DAY,
  maxConcurrent: 50,
  minIdleMs: 5 * MINUTE,
  minAbsoluteMs: 15 * MINUTE,
} as const;

/** Step-up: re-authenticate when the last proof is older than this (§6.2). */
export const STEP_UP_MAX_AGE_MS = 10 * MINUTE;

/** How often a request refreshes `last_seen_at`/`idle_expires_at` (write amplification cap). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE;

export const AUTH_LEVEL: Readonly<Record<"host" | "verified" | "mfa", AuthLevel>> = {
  host: 0,
  verified: 1,
  mfa: 2,
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveLifetimes(
  population: AuthPopulation,
  overrides: Partial<SessionLifetimes> = {},
): SessionLifetimes {
  const base = DEFAULT_LIFETIMES[population];
  const idleMs = clamp(
    overrides.idleMs ?? base.idleMs,
    PLATFORM_BOUNDS.minIdleMs,
    PLATFORM_BOUNDS.maxIdleMs,
  );
  const absoluteMs = clamp(
    overrides.absoluteMs ?? base.absoluteMs,
    PLATFORM_BOUNDS.minAbsoluteMs,
    PLATFORM_BOUNDS.maxAbsoluteMs,
  );
  const rememberedAbsoluteMs = clamp(
    overrides.rememberedAbsoluteMs ?? base.rememberedAbsoluteMs,
    absoluteMs,
    PLATFORM_BOUNDS.maxAbsoluteMs,
  );
  const maxConcurrent = clamp(
    overrides.maxConcurrent ?? base.maxConcurrent,
    1,
    PLATFORM_BOUNDS.maxConcurrent,
  );
  return { idleMs, absoluteMs, rememberedAbsoluteMs, maxConcurrent };
}

/** Staff owners/admins must hold an MFA-grade session (§6.2); everyone else needs level 1. */
export function requiredAuthLevelFor(
  role: string | undefined,
  workspaceRequiresMfa = false,
): AuthLevel {
  if (role === "owner" || role === "admin") return AUTH_LEVEL.mfa;
  return workspaceRequiresMfa ? AUTH_LEVEL.mfa : AUTH_LEVEL.verified;
}
