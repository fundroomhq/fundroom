/*
 * The state machine (EXECUTION_PLAN §9.2's mermaid). Pure, so the transition rules are
 * unit-testable without a database and identical whether they run in the 5-minute verify
 * job, the weekly re-verify sweep, or an admin's "Verify now".
 *
 *   [*]     → pending : admin adds the hostname
 *   pending → dns_ok  : CNAME + TXT both resolve
 *   pending → failed  : still not resolving at VERIFY_DEADLINE_MS
 *   dns_ok  → active  : a request was actually served on the hostname — NOT a transition this
 *                       function can make, see below
 *   active  → pending : re-verify failed REVERIFY_GRACE times running
 *   failed  → pending : admin retries
 *
 * **`dns_ok → active` is deliberately absent from `nextState`** (E2.1 S2). A DNS verdict, however
 * good, is not evidence that a certificate was issued or that anything was served: the zone may
 * carry a CAA record excluding our CA, or the ACME account may be rate-limited, in which case the
 * hostname answers with a TLS error. `active` is what `primaryHost` keys off, so promoting on a
 * second successful DNS poll starts minting email links at a hostname that does not answer. The
 * only place the fact "this hostname served a request" is observable is the request path, so that
 * is the only place that writes `active` (`service/lookup.ts`).
 *
 * E3.10 exception, applied by the service rather than here: with a provider that issues the
 * certificate itself (`cloudflare-saas`, which has `status()`), the request path proves nothing
 * — Cloudflare routes the hostname before its certificate is active — so there `active` is
 * written by `check()` when the provider says `active`, and the serving path never promotes.
 */

export const CUSTOM_DOMAIN_STATUSES = ["pending", "dns_ok", "active", "failed"] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];

/** design/07 §2.2 step 3: poll with backoff "up to 72 h", then give up. */
export const VERIFY_DEADLINE_MS = 72 * 3600 * 1000;

/** Consecutive weekly re-verify failures tolerated before an active domain is demoted. */
export const REVERIFY_GRACE = 3;

export interface StateInput {
  readonly status: CustomDomainStatus;
  readonly ok: boolean;
  readonly firstAttemptAt: Date;
  readonly now: Date;
  readonly consecutiveFailures: number;
}

export interface StateResult {
  readonly status: CustomDomainStatus;
  readonly consecutiveFailures: number;
}

/**
 * Takes the row's current state plus a verdict and returns the next state.
 *
 * Two things the caller owns, because they are writes and this function does none:
 *
 * 1. **Reset `first_attempt_at` whenever this returns `pending` from another state.** The
 *    72 h deadline is measured from that column, so a domain demoted out of `active` with a
 *    months-old `first_attempt_at` would flip straight to `failed` on the next sweep.
 * 2. **Drive `dns_ok → active` from a request actually served on the hostname.** This function
 *    never returns `active` from `dns_ok`, because a verdict about DNS is not evidence that a
 *    certificate exists (E2.1 S2). `ask` already answers 200 for `dns_ok` — it has to, since the
 *    certificate cannot exist before the first handshake (decision 3) — so the promotion belongs
 *    to the classifier's lookup, and `ask` is specifically *not* the trigger: it fires before
 *    the certificate exists, which is the whole reason it answers on `dns_ok`.
 */
export function nextState(input: StateInput): StateResult {
  const { ok, consecutiveFailures } = input;
  const elapsed = input.now.getTime() - input.firstAttemptAt.getTime();
  const pastDeadline = elapsed >= VERIFY_DEADLINE_MS;
  const failures = consecutiveFailures + 1;

  switch (input.status) {
    case "pending":
      if (ok) return { status: "dns_ok", consecutiveFailures: 0 };
      return pastDeadline
        ? { status: "failed", consecutiveFailures: failures }
        : { status: "pending", consecutiveFailures: failures };

    case "dns_ok":
      // Stays `dns_ok`: DNS still proves out, and nothing here can know whether the hostname has
      // ever answered a request. The promotion to `active` is the serving path's write.
      if (ok) return { status: "dns_ok", consecutiveFailures: 0 };
      // Not yet serving, so there is nothing to protect by being patient — but a single bad
      // DoH answer should not restart the clock either, hence the same grace as `active`.
      return failures >= REVERIFY_GRACE
        ? { status: "pending", consecutiveFailures: 0 }
        : { status: "dns_ok", consecutiveFailures: failures };

    case "active":
      if (ok) return { status: "active", consecutiveFailures: 0 };
      // Taking a working portal offline over one bad answer is worse than a late demotion,
      // so an active domain survives REVERIFY_GRACE - 1 failures.
      return failures >= REVERIFY_GRACE
        ? { status: "pending", consecutiveFailures: 0 }
        : { status: "active", consecutiveFailures: failures };

    // Unreachable today, and kept deliberately. `verifyNow` always `reopen()`s a `failed` row
    // before checking it, and neither sweep selects `failed` (`domains.verify` takes `pending`,
    // `domains.reverify` takes `active`/`dns_ok`) — so nothing currently calls this with a
    // `failed` status. It stays because it is the correct rule for a caller that checks a
    // `failed` row without reopening it first, and because deleting it would make the
    // exhaustiveness assertion below load-bearing instead of decorative.
    case "failed":
      if (ok) return { status: "dns_ok", consecutiveFailures: 0 };
      // An admin retry resets `first_attempt_at`, which is what "inside the window again"
      // means here: a fresh deadline reopens the row as `pending` rather than leaving it
      // dead. Without a retry the row stays `failed` and the jobs stop looking at it.
      return pastDeadline
        ? { status: "failed", consecutiveFailures: failures }
        : { status: "pending", consecutiveFailures: failures };

    default: {
      // Exhaustive over `CustomDomainStatus`, and asserted rather than absorbed: the previous
      // `return { status: input.status, … }` fallback meant a fifth status added to the enum
      // would compile silently and then be treated as a state that never transitions. This way
      // it is a type error at the point the enum grows.
      const unreachable: never = input.status;
      throw new Error(`unhandled custom domain status: ${String(unreachable)}`);
    }
  }
}
