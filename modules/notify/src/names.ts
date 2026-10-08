/*
 * Job names and tunables shared by the jobs, the services that enqueue them and the tests. A
 * file of its own so `service/*` can name a job without importing `jobs.ts` (which imports the
 * services).
 */
export const JOB_DELIVER = "notify.deliver";
export const JOB_DIGEST = "notify.digest";
/** Posts queued channel deliveries; enqueued by the fan-out, swept by `notify.deliver` too. */
export const JOB_CHANNELS = "notify.channels";
export const JOB_RETENTION = "notify.retention";
/**
 * Emails one instant notification, outside any transaction (enqueued by the
 * `notification.created` subscriber inside the outbox transaction).
 */
export const JOB_SEND = "notify.send";

/** Instant rows older than this and still unsent are picked up by the cron (missed subscriber). */
export const DELIVER_GRACE_MS = 30_000;

/**
 * Send attempts (first included) before an instant email or a digest is given up with
 * `email_outcome = 'failed'`. Suppressions are never retried at all.
 */
export const NOTIFY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 6 * 3_600_000;

/**
 * How long after claim number `attempt` (1-based) the next attempt may start: 2, 4, 8, 16 min …
 * capped at 6 h. It doubles as the claim's lease — nobody else picks the row up while a send is
 * in flight — so it must stay well above a mailer's timeout (the first step is two minutes).
 */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RETRY_BASE_MS * 2 ** n, RETRY_CAP_MS);
}

/** Envelope purpose for channel webhook URLs (ADR-0016 per-purpose data keys). */
export const CHAT_KEY_PURPOSE = "notify-chat";
/** Consecutive `not_found` / `rejected` / `invalid_url` posts before a channel disables itself. */
export const CHANNEL_DISABLE_AFTER = 3;
/** Attempts (first post included) before a transiently failing delivery is given up. */
export const CHANNEL_MAX_ATTEMPTS = 6;
/** A `sending` claim older than this is assumed dead and re-claimed. */
export const CHANNEL_CLAIM_STALE_MS = 5 * 60_000;
/** Channels per workspace: a shared channel is configuration, not a per-person list. */
export const MAX_CHANNELS = 20;
