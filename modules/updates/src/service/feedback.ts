import type { RecipientStatus } from "../schema/updates.js";

/*
 * Delivery feedback (E2.6): what an ESP webhook may do to a recipient row. Pure, so the ladder
 * is tested without a database.
 *
 * The ladder is monotonic — sent → delivered → bounced (hard only) → complained — and that is the whole
 * design. Providers deliver webhooks out of order and more than once: a `delivered` retried
 * after the `bounce` that followed it must not resurrect the address, and a complaint is the
 * strongest thing a recipient can say about mail and outranks everything. Opens and clicks are
 * not delivery facts at all (they are analytics', consent-gated at ingest) and a `delay` says
 * the message is still in flight, which changes nothing but the last-event clock.
 */

/** A `mail.delivery_recorded` kind. */
export type FeedbackKind = "delivered" | "bounce" | "complaint" | "delay" | "open" | "click";

const RANK: Readonly<Partial<Record<RecipientStatus, number>>> = {
  sent: 1,
  delivered: 2,
  bounced: 3,
  complained: 4,
};

const TARGET: Readonly<Partial<Record<FeedbackKind, RecipientStatus>>> = {
  delivered: "delivered",
  bounce: "bounced",
  complaint: "complained",
};

/** Whether this kind of event concerns the updates module at all (opens/clicks do not). */
export function isDeliveryFact(kind: FeedbackKind): boolean {
  return kind === "delivered" || kind === "bounce" || kind === "complaint" || kind === "delay";
}

/**
 * The status a row moves to, or `undefined` for "leave the status alone".
 *
 * Only a row that was actually handed to the provider (`sent` or a rung above it) can move: a
 * `queued`, `failed` or `skipped` row has no provider message, and one that somehow matched
 * would be a provider id collision, not news about this recipient.
 *
 * Only a **hard** bounce reaches `bounced`. A soft bounce (mailbox full, greylisting, a
 * transient 4xx) says the address is fine and the provider may still deliver — or already did —
 * so it must not climb a ladder that never comes down; the subscriber records it as the row's
 * error (`bounce:soft`) and last-event time instead. A bounce with no type is treated the same
 * way, matching the kernel, which suppresses an address on a hard bounce only.
 */
export function nextRecipientStatus(
  current: RecipientStatus,
  kind: FeedbackKind,
  bounceType: "hard" | "soft" | null = null,
): RecipientStatus | undefined {
  if (kind === "bounce" && bounceType !== "hard") return undefined;
  const target = TARGET[kind];
  if (target === undefined) return undefined;
  const from = RANK[current];
  const to = RANK[target];
  if (from === undefined || to === undefined) return undefined;
  return to > from ? target : undefined;
}

/**
 * Whether a non-terminal bounce should be noted on the row (error + clock): only while it is
 * still `sent` or `delivered` — a bounced or complained row keeps the stronger fact's error.
 */
export function notesSoftBounce(
  current: RecipientStatus,
  kind: FeedbackKind,
  bounceType: "hard" | "soft" | null,
): boolean {
  return (
    kind === "bounce" && bounceType !== "hard" && (current === "sent" || current === "delivered")
  );
}

/** The error string stored with a bounce: which kind, never the provider's diagnostic text. */
export function bounceError(bounceType: "hard" | "soft" | null): string {
  return bounceType === null ? "bounce" : `bounce:${bounceType}`;
}
