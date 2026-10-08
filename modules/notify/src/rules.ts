import type { Cadence } from "./schema/notify.js";

/*
 * Pure notification rules (E1.5): which events staff can subscribe to, the defaults, the
 * dedupe key that keeps a chatty investor from producing a flood, and the digest grouping.
 * No I/O here so the unit tests stay trivial.
 */
export const NOTIFY_EVENT_TYPES = [
  "document.viewed",
  "document.downloaded",
  "update.replied",
  /*
   * Round activity (E2.5). Instant by default, unlike views and downloads, and the difference is
   * the point: a view is one of hundreds and belongs in a digest, while an indication of interest
   * is a person saying they want to put money in — a founder who learns about it tomorrow morning
   * has already been slow. A verification request is the same shape: an investor is blocked until
   * somebody reads their evidence.
   */
  "round.interest_submitted",
  "round.verification_requested",
  /*
   * E2.6. A commitment is money on the table (instant, addressed to `round.manage`); a hot lead
   * is the analytics module saying a member's engagement crossed the workspace threshold
   * (instant, addressed to `analytics.read` — the people who may already see the score).
   */
  "round.commitment_created",
  "analytics.hot_lead",
  /*
   * E3.1. A verified request for access from someone who is not a member yet, waiting in the
   * approval queue (instant, addressed to `access.manage` — the people who can decide it). An
   * auto-approved request never alerts: the handler re-reads the row and skips unless pending.
   */
  "access_request.submitted",
  /*
   * E3.2. The periodic access review is past due (the last review plus 90 days, or the workspace's
   * creation plus 90 days if it was never reviewed). A fact about the workspace, not about a
   * person: no actor, addressed to `access.manage`, at most one per ISO week (`bucketFor`).
   */
  "access_review.overdue",
  /*
   * E3.2. A delegate was added to act for an investor (design/05 §7 "Delegate abuse": principal
   * and admin both notified). Instant, addressed to `access.manage` AND to the principal — the one
   * external recipient in the vocabulary, so an investor learns at once if someone else (an admin,
   * or whoever holds their session) gave their access away. Never a channel post: it names a person.
   */
  "membership.delegate_added",
  /*
   * E3.3 data-room Q&A (ADR-0051). Ids only, and the copy never quotes a question or an answer:
   * the text is an investor's own words (it may identify them to other bidders) and lives in the
   * `dataroom` schema, which this module may not read. Every alert is a fixed sentence plus a link.
   *  - `qa.question_asked`: an investor asked; staff holding `data-room.qa_manage` (the
   *    coordinators who route it). The one Q&A channel event — its post names nobody.
   *  - `qa.question_assigned`: the assignee only (never the member who assigned it to themself).
   *  - `qa.answer_submitted`: an answer waits for four-eyes approval; `data-room.qa_approve`
   *    holders except whoever submitted it.
   *  - `qa.answer_released`: the asker only, by email — the second external recipient in the
   *    vocabulary; the link is the investor portal's question page.
   *  - `qa.question_declined`: staff declined the question and chose to tell the asker; the
   *    asker only, by email, linked to the portal's question page (like a release).
   *  - `qa.question_due`: the SLA job's due-soon / overdue reminder; the assignee and
   *    `data-room.qa_manage` holders, one alert per reminder the job publishes (per arming).
   */
  "qa.question_asked",
  "qa.question_assigned",
  "qa.answer_submitted",
  "qa.answer_released",
  "qa.question_declined",
  "qa.question_due",
  /*
   * E3.5 e-signature and round closing (ADR-0053). Instant by default.
   *  - `esign.envelope_attention`: an envelope was declined, voided, expired or failed; staff.
   *    A sentence — it is about the envelope, not about whoever moved it.
   *  - `round.signature_completed`: a commitment's subscription agreement was signed; staff.
   *  - `round.commitment_confirmed`: the company confirmed the investor's commitment; the investor
   *    only, by email (a sentence addressed to them).
   * None is a channel event: each names a person's signature or money.
   */
  "esign.envelope_attention",
  "round.signature_completed",
  "round.commitment_confirmed",
  /*
   * E3.6 integrations hub (ADR-0054). A third-party connection (a KPI source, the Slack app, a
   * booking vendor) needs re-authorising or keeps failing. A workspace event (no actor), instant,
   * addressed to `integrations.manage` (owners and admins — the people who can reconnect it), and
   * a channel event: the post names the vendor and the state, never anybody's data.
   */
  "integration.connection_unhealthy",
  /*
   * E3.7 accreditation vendors (ADR-0055). Both addressed to the investor the verification belongs
   * to (the membership in the payload), by email, instant; neither is a channel event — each is
   * about one person's accreditation. Neutral copy, no amounts, a link to the portal.
   *  - `round.verification_expiring`: their verified accreditation expires soon.
   *  - `round.verification_decided`: their verification was verified, rejected or expired.
   */
  "round.verification_expiring",
  "round.verification_decided",
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];

export const DEFAULT_CADENCE: Readonly<Record<NotifyEventType, Cadence>> = {
  "document.viewed": "daily",
  "document.downloaded": "daily",
  "update.replied": "instant",
  "round.interest_submitted": "instant",
  "round.verification_requested": "instant",
  "round.commitment_created": "instant",
  "analytics.hot_lead": "instant",
  "access_request.submitted": "instant",
  "access_review.overdue": "instant",
  "membership.delegate_added": "instant",
  "qa.question_asked": "instant",
  "qa.question_assigned": "instant",
  "qa.answer_submitted": "instant",
  "qa.answer_released": "instant",
  "qa.question_declined": "instant",
  "qa.question_due": "instant",
  "esign.envelope_attention": "instant",
  "round.signature_completed": "instant",
  "round.commitment_confirmed": "instant",
  "integration.connection_unhealthy": "instant",
  "round.verification_expiring": "instant",
  "round.verification_decided": "instant",
};

/**
 * The events a workspace chat channel can announce (E2.6). Workspace-level facts only — the
 * things a founder's team would want in a shared channel. Views, downloads and replies stay
 * personal: a view is one of hundreds, and a reply is a conversation with one person.
 */
export const CHANNEL_EVENT_TYPES = [
  "analytics.hot_lead",
  "round.interest_submitted",
  "round.commitment_created",
  "round.verification_requested",
  // Announced generically ("a new access request is waiting"): the requester is not a member,
  // and their name, address, firm and reason never go to a third-party channel.
  "access_request.submitted",
  // A workspace-level compliance nudge; names nobody.
  "access_review.overdue",
  // "A new data-room question is waiting" — never the asker, the target or the question text.
  "qa.question_asked",
  // E3.6: "the QuickBooks connection needs reconnecting" — a vendor name and a state.
  "integration.connection_unhealthy",
] as const satisfies readonly NotifyEventType[];
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];

export function isChannelEventType(x: string): x is ChannelEventType {
  return (CHANNEL_EVENT_TYPES as readonly string[]).includes(x);
}

export function isNotifyEventType(x: string): x is NotifyEventType {
  return (NOTIFY_EVENT_TYPES as readonly string[]).includes(x);
}

/** The cadence in force: the stored preference or the module default. */
export function effectiveCadence(
  eventType: NotifyEventType,
  stored: ReadonlyMap<string, Cadence> | undefined,
): Cadence {
  return stored?.get(eventType) ?? DEFAULT_CADENCE[eventType];
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Events about the workspace itself rather than about a person (E3.2): they have no actor, and
 * their line in an email or a digest is a sentence of its own instead of "<name> <verb>".
 */
export const WORKSPACE_EVENT_TYPES = [
  "access_review.overdue",
  "integration.connection_unhealthy",
] as const satisfies readonly NotifyEventType[];

export function isWorkspaceEventType(x: string): boolean {
  return (WORKSPACE_EVENT_TYPES as readonly string[]).includes(x);
}

/**
 * Events whose line in an email subject or a digest is a whole sentence (`VERB`), never
 * "<name> <verb>": the workspace events, and the Q&A alerts that are about a question rather than
 * about the person who moved it (E3.3). The actor, when there is one, still shows in the inbox.
 */
export const SENTENCE_EVENT_TYPES = [
  ...WORKSPACE_EVENT_TYPES,
  "qa.question_assigned",
  "qa.answer_submitted",
  "qa.answer_released",
  "qa.question_declined",
  "qa.question_due",
  "esign.envelope_attention",
  "round.commitment_confirmed",
  "round.verification_expiring",
  "round.verification_decided",
] as const satisfies readonly NotifyEventType[];

export function isSentenceEventType(x: string): boolean {
  return (SENTENCE_EVENT_TYPES as readonly string[]).includes(x);
}

/** `2026-W39`: the ISO-8601 week (UTC) containing `at`. Mirrors identity's `isoWeekKey`. */
export function isoWeekKey(at: Date): string {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Views and downloads collapse per hour; everything a person did deliberately is its own bucket.
 *
 * A reply, an interest submission and a verification request are each a distinct act, and the
 * hourly collapse would silently drop the second of two in the same hour — which for an interest
 * submission means a founder never hears about an investor at all. `id` is the reply, submission
 * or verification id; an absent one falls back to a per-type constant rather than to the clock,
 * so a caller that forgets it dedupes loudly instead of leaking a flood.
 */
export function bucketFor(eventType: NotifyEventType, at: Date, id?: string): string {
  if (eventType === "update.replied") return id ?? "reply";
  if (eventType === "round.interest_submitted") return id ?? "interest";
  if (eventType === "round.verification_requested") return id ?? "verification";
  if (eventType === "round.commitment_created") return id ?? "commitment";
  if (eventType === "access_request.submitted") return id ?? "access_request";
  // One reminder per ISO week, however often the daily job or a redelivery publishes it.
  if (eventType === "access_review.overdue") return isoWeekKey(at);
  // One alert per delegate invitation.
  if (eventType === "membership.delegate_added") return id ?? "delegate";
  /*
   * Q&A (E3.3): `id` is the question id, suffixed by what makes a second alert a new fact — the
   * outbox id for an assignment, a submission, a release, a decline and a due reminder (a question
   * handed back to the same person, resubmitted after a rejection, re-released after a reopen,
   * declined again, or re-armed by a moved deadline — even A→B→A — is news again; a redelivered
   * event keeps its outbox id and collapses). See the handlers.
   */
  if (eventType.startsWith("qa.")) return id ?? "qa";
  // E3.5: `id` is the envelope (attention: suffixed by its status) or the commitment.
  if (eventType === "esign.envelope_attention") return id ?? "esign";
  if (eventType === "round.signature_completed") return id ?? "signature";
  if (eventType === "round.commitment_confirmed") return id ?? "confirmed";
  // E3.6: `id` is the connection, its status and the outbox id — the kernel publishes once per
  // transition, so a connection that recovers and fails again is news again; a redelivery is not.
  if (eventType === "integration.connection_unhealthy") return id ?? "integration";
  // E3.7: `id` is the verification (decided: suffixed by its status — a verification that is
  // verified and later expires is news twice; a redelivery is not).
  if (eventType === "round.verification_expiring") return id ?? "verification_expiring";
  if (eventType === "round.verification_decided") return id ?? "verification_decided";
  // Analytics already fires once per member per scoring window; the day bucket only guards
  // against a redelivered event, and still lets a lead that cools and re-heats alert again.
  if (eventType === "analytics.hot_lead") return `d${Math.floor(at.getTime() / DAY_MS)}`;
  return String(Math.floor(at.getTime() / HOUR_MS));
}

export function dedupeKey(input: {
  eventType: NotifyEventType;
  recipientMembershipId: string;
  actorMembershipId: string | null;
  resourceId: string;
  bucket: string;
}): string {
  const { eventType, recipientMembershipId, actorMembershipId, resourceId, bucket } = input;
  return `${eventType}:${recipientMembershipId}:${actorMembershipId ?? "-"}:${resourceId}:${bucket}`;
}

/** What the event did, as a verb phrase with a generic noun (labels are never stored). */
export const VERB: Readonly<Record<NotifyEventType, string>> = {
  "document.viewed": "viewed a document",
  "document.downloaded": "downloaded a document",
  "update.replied": "replied to an update",
  "round.interest_submitted": "indicated interest in the round",
  "round.verification_requested": "requested accreditation verification",
  "round.commitment_created": "committed to the round",
  "analytics.hot_lead": "became a hot lead",
  "access_request.submitted": "requested access",
  // A workspace event: a whole sentence (`isWorkspaceEventType`), never after a name.
  "access_review.overdue": "The access review is overdue",
  "membership.delegate_added": "has a new delegate",
  "qa.question_asked": "asked a data-room question",
  // Sentences (`isSentenceEventType`), never after a name.
  "qa.question_assigned": "A data-room question was assigned to you",
  "qa.answer_submitted": "A data-room answer is waiting for approval",
  "qa.answer_released": "Your data-room question was answered",
  "qa.question_declined": "Your data-room question was declined",
  "qa.question_due": "A data-room question is due soon or overdue",
  // Sentences (`isSentenceEventType`), never after a name.
  "esign.envelope_attention": "An e-signature request needs attention",
  "round.signature_completed": "signed the subscription agreement",
  "round.commitment_confirmed": "Your commitment was confirmed",
  // A workspace event: a sentence (`isWorkspaceEventType`), never after a name.
  "integration.connection_unhealthy": "A connected service needs attention",
  // Sentences (`isSentenceEventType`), addressed to the investor.
  "round.verification_expiring": "Your accreditation verification expires soon",
  "round.verification_decided": "Your accreditation verification was updated",
};

export const GROUP_TITLE: Readonly<Record<NotifyEventType, string>> = {
  "document.viewed": "Document views",
  "document.downloaded": "Document downloads",
  "update.replied": "Update replies",
  "round.interest_submitted": "Interest submissions",
  "round.verification_requested": "Verification requests",
  "round.commitment_created": "Commitments",
  "analytics.hot_lead": "Hot leads",
  "access_request.submitted": "Access requests",
  "access_review.overdue": "Access reviews",
  "membership.delegate_added": "Delegates",
  "qa.question_asked": "Data-room questions",
  "qa.question_assigned": "Questions assigned to you",
  "qa.answer_submitted": "Answers awaiting approval",
  "qa.answer_released": "Answered questions",
  "qa.question_declined": "Declined questions",
  "qa.question_due": "Question deadlines",
  "esign.envelope_attention": "E-signature requests needing attention",
  "round.signature_completed": "Signed subscription agreements",
  "round.commitment_confirmed": "Confirmed commitments",
  "integration.connection_unhealthy": "Connected services needing attention",
  "round.verification_expiring": "Accreditation verifications expiring",
  "round.verification_decided": "Accreditation verification updates",
};

export interface DigestInput {
  readonly eventType: NotifyEventType;
  readonly actorMembershipId: string | null;
  readonly resourceId: string | null;
}

export interface DigestGroup {
  readonly eventType: NotifyEventType;
  readonly count: number;
  /** "Name viewed a document · 3×" lines, most frequent first. */
  readonly lines: readonly string[];
}

export const DIGEST_MAX_LINES = 20;

/**
 * Groups pending rows by event type, then by (actor, resource) with counts. Lines across all
 * groups are capped at `maxLines`; the group counts stay exact.
 */
export function groupForDigest(
  rows: readonly DigestInput[],
  /** The actor's name; `resourceId` names a member-less subject (an access request's requester). */
  nameOf: (membershipId: string | null, resourceId: string | null) => string,
  maxLines = DIGEST_MAX_LINES,
): DigestGroup[] {
  const byType = new Map<
    NotifyEventType,
    Map<string, { actor: string | null; resource: string | null; n: number }>
  >();
  for (const t of NOTIFY_EVENT_TYPES) byType.set(t, new Map());
  for (const r of rows) {
    const bucket = byType.get(r.eventType);
    if (bucket === undefined) continue;
    const key = `${r.actorMembershipId ?? "-"}:${r.resourceId ?? "-"}`;
    const cur = bucket.get(key);
    if (cur) cur.n += 1;
    else bucket.set(key, { actor: r.actorMembershipId, resource: r.resourceId, n: 1 });
  }
  const out: DigestGroup[] = [];
  let budget = maxLines;
  for (const t of NOTIFY_EVENT_TYPES) {
    const bucket = byType.get(t);
    if (bucket === undefined || bucket.size === 0) continue;
    const entries = [...bucket.values()].sort((a, b) => b.n - a.n);
    const count = entries.reduce((sum, e) => sum + e.n, 0);
    const lines: string[] = [];
    for (const e of entries) {
      if (budget <= 0) break;
      const what = isSentenceEventType(t) ? VERB[t] : `${nameOf(e.actor, e.resource)} ${VERB[t]}`;
      lines.push(`${what}${e.n > 1 ? ` · ${e.n}×` : ""}`);
      budget -= 1;
    }
    out.push({ eventType: t, count, lines });
  }
  return out;
}

export type DigestKind = "daily" | "weekly";

export function digestSubject(
  workspaceName: string,
  total: number,
  kind: DigestKind = "daily",
): string {
  const n = `${total} new ${total === 1 ? "activity" : "activities"}`;
  return kind === "weekly"
    ? `${workspaceName}: your week — ${n}`
    : `${workspaceName}: ${n} in your data room`;
}

export function instantSubject(actorName: string, eventType: NotifyEventType): string {
  if (isSentenceEventType(eventType)) return VERB[eventType];
  return `${actorName} ${VERB[eventType]}`;
}

/** Vendor display names for the integration-health alert (E3.6); unknown keys read as-is. */
export const INTEGRATION_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  quickbooks: "QuickBooks",
  xero: "Xero",
  stripe: "Stripe",
  slack: "Slack",
  calendly: "Calendly",
  calcom: "Cal.com",
};

/**
 * The integration-health sentence (E3.6), shared by the email, the inbox copy and the channel
 * post: a vendor name and a state — never an account label, a token or a vendor error text.
 */
export function integrationHealthSentence(
  provider: string,
  status: string,
  workspaceName: string,
): string {
  const name = INTEGRATION_PROVIDER_NAMES[provider] ?? "A connected service";
  return status === "reauth_required"
    ? `The ${name} connection of ${workspaceName} needs to be reconnected: the service no longer accepts its authorisation.`
    : `The ${name} connection of ${workspaceName} keeps failing.`;
}

/** The subject line of the same alert. */
export function integrationHealthSubject(provider: string, status: string): string {
  const name = INTEGRATION_PROVIDER_NAMES[provider] ?? "A connected service";
  return status === "reauth_required"
    ? `${name} needs to be reconnected`
    : `The ${name} connection keeps failing`;
}
