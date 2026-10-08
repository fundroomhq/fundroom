export const JOB_SEND = "updates.send";
export const JOB_DISPATCH = "updates.dispatch";
/** Recipients rendered and handed to the mailer per batch; the job re-reads between batches. */
export const SEND_BATCH = 50;
/** A send still `queued`/`running` after this long is re-enqueued by the dispatcher. */
export const SEND_STALE_MINUTES = 30;
/**
 * How long a send keeps retrying a recipient whose delivery failed **transiently** (the mail
 * server unreachable or timing out, a 4xx SMTP reply, an ESP rate limit). Inside the window the
 * row stays `queued` and the job is retried (pg-boss backoff, then the dispatcher's stale
 * re-enqueue); past it a transient failure is final and the row is `failed`.
 */
export const SEND_RETRY_WINDOW_HOURS = 24;
/** Transient failures in a row after which a run stops early: the transport is down, not one mailbox. */
export const SEND_TRANSIENT_STREAK = 5;
