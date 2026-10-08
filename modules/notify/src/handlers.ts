import type { EventTopic } from "@fundroom/domain";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { JsonObject } from "@fundroom/ports";
import { JOB_SEND } from "./names.js";
import { accessRequestSummary } from "./repos/access-request-repo.js";
import { NotificationRepo } from "./repos/notify-repo.js";
import { bucketFor } from "./rules.js";
import { enqueueChannelPosts } from "./service/channels.js";
import { eraseMember } from "./service/lifecycle.js";
import {
  ACCESS_MANAGE,
  ANALYTICS_READ,
  ESIGN_READ,
  fanOut,
  INTEGRATIONS_MANAGE,
  QA_APPROVE,
  QA_MANAGE,
  ROUND_MANAGE,
} from "./service/notify.js";
import { notifyServices } from "./service/slot.js";

/** Narrows the manifest's untyped handler to one topic (the dispatcher routes per topic). */
function typed<T extends EventTopic>(topic: T, handler: EventHandler<T>): EventHandler {
  return async (event, context) => {
    if (event.topic !== topic) throw new Error(`notify: ${topic} handler got ${event.topic}`);
    await handler(event as unknown as EventEnvelope<T>, context);
  };
}

/*
 * Outbox subscribers (`notify.document_viewed`, …). Each runs inside the dispatcher's
 * per-workspace system transaction; a throw means pg-boss retries. Only investor activity
 * is interesting: an action by a staff member never produces an alert.
 */
async function actorIsExternal(
  tx: Parameters<EventHandler>[1]["tx"],
  ctx: Parameters<EventHandler>[1]["ctx"],
  membershipId: string,
): Promise<boolean> {
  if (ctx.actorKind === "host") return false;
  const m = await new MembershipRepo(ctx, tx).byId(membershipId);
  return m !== undefined && m.kind === "external";
}

function documentHandler<T extends "document.viewed" | "document.downloaded">(
  eventType: T,
): EventHandler {
  return typed(eventType, async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (!(await actorIsExternal(tx, ctx, p.membershipId))) return;
    const services = notifyServices();
    const payload: JsonObject =
      "variant" in p
        ? { documentId: p.documentId, versionId: p.versionId, variant: p.variant }
        : { documentId: p.documentId, versionId: p.versionId };
    await fanOut(services, ctx, tx, {
      eventType,
      actorMembershipId: p.membershipId,
      resourceKind: "document",
      resourceId: p.documentId,
      payload,
      bucket: bucketFor(eventType, services.now()),
    });
  });
}

export const onDocumentViewed = documentHandler("document.viewed");
export const onDocumentDownloaded = documentHandler("document.downloaded");

export const onUpdateReplied: EventHandler = typed("update.replied", async (event, { tx, ctx }) => {
  if (ctx.actorKind === "host") return;
  const p = event.payload;
  if (!(await actorIsExternal(tx, ctx, p.authorMembershipId))) return;
  const services = notifyServices();
  await fanOut(services, ctx, tx, {
    eventType: "update.replied",
    actorMembershipId: p.authorMembershipId,
    resourceKind: "post",
    resourceId: p.postId,
    payload: { postId: p.postId, replyId: p.replyId, threadMembershipId: p.threadMembershipId },
    bucket: bucketFor("update.replied", services.now(), p.replyId),
  });
});

/*
 * Round activity (E2.5). Two differences from the data-room handlers above, both deliberate.
 *
 * There is no `actorIsExternal` check. For a view or a download the filter exists because staff
 * open their own documents constantly and nobody wants an alert about it; an interest submission
 * and a verification request are member-only acts by construction (the routes are behind
 * `requireMember`), so the check would be a database round-trip that can only ever answer yes.
 *
 * And the recipients are staff holding **`round.manage`**, not `notify.read`. `notify.read` is
 * "manage my own inbox" and every staff role has it — right for a document view, wrong for this:
 * an indication of interest is round material, and a `viewer` who cannot open the round must not
 * learn by email who wants into it.
 */
export const onRoundInterestSubmitted: EventHandler = typed(
  "round.interest_submitted",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.interest_submitted",
      actorMembershipId: p.membershipId,
      resourceKind: "interest_submission",
      resourceId: p.submissionId,
      payload: { submissionId: p.submissionId, roundId: p.roundId },
      // One bucket per submission, never per hour: two investors indicating interest in the same
      // hour are two facts, and collapsing them would mean a founder never hears about the second.
      bucket: bucketFor("round.interest_submitted", services.now(), p.submissionId),
      permission: ROUND_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "round.interest_submitted",
      sourceKey: `round.interest_submitted:${p.submissionId}`,
      actorMembershipId: p.membershipId,
      payload: { submissionId: p.submissionId, roundId: p.roundId },
    });
  },
);

export const onRoundVerificationRequested: EventHandler = typed(
  "round.verification_requested",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.verification_requested",
      actorMembershipId: p.membershipId,
      resourceKind: "verification",
      resourceId: p.verificationId,
      // Ids only, and nothing about the evidence: the payload is stored on the notification row
      // and rendered into an email, neither of which is a place for what was uploaded.
      payload: {
        verificationId: p.verificationId,
        ...(p.submissionId === undefined ? {} : { submissionId: p.submissionId }),
      },
      bucket: bucketFor("round.verification_requested", services.now(), p.verificationId),
      permission: ROUND_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "round.verification_requested",
      sourceKey: `round.verification_requested:${p.verificationId}`,
      actorMembershipId: p.membershipId,
      payload: { verificationId: p.verificationId },
    });
  },
);

/*
 * E2.6. A commitment may name no member at all (a CRM contact, an organisation, or a display
 * name only), so the actor is nullable; the alert then says "a new commitment was recorded".
 * Addressed to `round.manage` like the other round events. The commitment is usually recorded
 * by a staff member, who therefore also receives it — the payload does not say who recorded it.
 */
export const onRoundCommitmentCreated: EventHandler = typed(
  "round.commitment_created",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    const actor = p.membershipId ?? null;
    await fanOut(services, ctx, tx, {
      eventType: "round.commitment_created",
      actorMembershipId: actor,
      resourceKind: "commitment",
      resourceId: p.commitmentId,
      payload: { commitmentId: p.commitmentId, roundId: p.roundId },
      bucket: bucketFor("round.commitment_created", services.now(), p.commitmentId),
      permission: ROUND_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "round.commitment_created",
      sourceKey: `round.commitment_created:${p.commitmentId}`,
      actorMembershipId: actor,
      payload: { commitmentId: p.commitmentId, roundId: p.roundId },
    });
  },
);

/*
 * A hot lead (E2.6): analytics' rollup saw a member's engagement score cross the workspace
 * threshold. Addressed to `analytics.read` — the score is analytics data, and the alert must not
 * reach anyone who could not open the hot list. Only an external member can be a lead.
 */
export const onHotLead: EventHandler = typed("analytics.hot_lead", async (event, { tx, ctx }) => {
  if (ctx.actorKind === "host") return;
  const p = event.payload;
  if (!(await actorIsExternal(tx, ctx, p.membershipId))) return;
  const services = notifyServices();
  const payload = { membershipId: p.membershipId, score: p.score };
  await fanOut(services, ctx, tx, {
    eventType: "analytics.hot_lead",
    actorMembershipId: p.membershipId,
    resourceKind: "member",
    resourceId: p.membershipId,
    payload,
    bucket: bucketFor("analytics.hot_lead", services.now()),
    permission: ANALYTICS_READ,
  });
  await enqueueChannelPosts(services, ctx, tx, {
    eventType: "analytics.hot_lead",
    sourceKey: `analytics.hot_lead:${p.membershipId}:${bucketFor("analytics.hot_lead", services.now())}`,
    actorMembershipId: p.membershipId,
    payload,
  });
});

/*
 * A verified access request waiting for a decision (E3.1). The requester is not a member, so
 * there is no actor: the alert names them only at render time, from the request row, and only
 * to staff holding `access.manage` — the people who decide it.
 *
 * The event says only "this request was verified". Whether it still needs anyone is the row's
 * business, so the row is re-read here, in the handler's own transaction (never a second pool
 * connection): an auto-approved request is already `approved` by the time this runs and must
 * not alert; one decided, expired or deleted (erasure, the sweeper) before dispatch is skipped
 * silently for the same reason.
 *
 * The channel post is generic by construction — no name, address, firm or reason goes to a
 * third-party chat service; `payload` carries the id only.
 */
export const onAccessRequestSubmitted: EventHandler = typed(
  "access_request.submitted",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const id = event.payload.accessRequestId;
    const row = await accessRequestSummary(ctx, tx, id);
    if (row === undefined || row.status !== "pending") return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "access_request.submitted",
      actorMembershipId: null,
      resourceKind: "access_request",
      resourceId: id,
      payload: { accessRequestId: id },
      bucket: bucketFor("access_request.submitted", services.now(), id),
      permission: ACCESS_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "access_request.submitted",
      sourceKey: `access_request.submitted:${id}`,
      actorMembershipId: null,
      payload: { accessRequestId: id },
    });
  },
);

/*
 * The periodic access review is overdue (E3.2). Published by identity's daily
 * `access-review.overdue` job at most once per ISO week per workspace; the bucket is that same
 * week (of the event, not of the dispatch), so a redelivered or duplicated event collapses into
 * the row already written. No actor: it is a fact about the workspace. Addressed to
 * `access.manage` — the people who can run the review.
 */
export const onAccessReviewOverdue: EventHandler = typed(
  "access_review.overdue",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    const bucket = bucketFor("access_review.overdue", event.createdAt);
    const payload = { dueAt: p.dueAt, lastReviewId: p.lastReviewId };
    await fanOut(services, ctx, tx, {
      eventType: "access_review.overdue",
      actorMembershipId: null,
      resourceKind: "workspace",
      resourceId: ctx.workspaceId,
      payload,
      bucket,
      permission: ACCESS_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "access_review.overdue",
      sourceKey: `access_review.overdue:${bucket}`,
      actorMembershipId: null,
      payload: { dueAt: p.dueAt },
    });
  },
);

/*
 * A delegate was added for an investor (E3.2; design/05 §7: "principal and admin both notified on
 * delegate creation"). Staff holding `access.manage`, and the principal themself — an investor must
 * learn at once if someone else gave their access away. The actor is the principal (the alert is
 * about them); the payload carries ids and the scope only, never the delegate's address.
 */
export const onDelegateAdded: EventHandler = typed(
  "membership.delegate_added",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "membership.delegate_added",
      actorMembershipId: p.principalMembershipId,
      resourceKind: "member",
      resourceId: p.principalMembershipId,
      payload: {
        principalMembershipId: p.principalMembershipId,
        inviteId: p.inviteId,
        scope: p.scope,
      },
      bucket: bucketFor("membership.delegate_added", services.now(), p.inviteId),
      permission: ACCESS_MANAGE,
      alsoNotify: [p.principalMembershipId],
    });
  },
);

/*
 * Data-room Q&A (E3.3, ADR-0051). Every payload is ids only and this module may not read the
 * `dataroom` schema, so nothing here re-reads the question: the copy is fixed text plus a link
 * (`renderInstant`), and a question closed between publish and dispatch still alerts — the page
 * the link opens says where it stands. `resourceKind` is `qa_question`, `resourceId` the question.
 */

/**
 * The staff member who assigned or submitted, when the payload says so. The catalogue's first
 * payloads carry no actor (the outbox envelope never does); read defensively so that the optional
 * field, once published, excludes the assigner and the author without another notify change.
 */
function qaActor(payload: object): string | null {
  const v = (payload as { actorMembershipId?: unknown }).actorMembershipId;
  return typeof v === "string" ? v : null;
}

/** A new question (instant; `data-room.qa_manage`). Also a channel event — a post naming nobody. */
export const onQaQuestionAsked: EventHandler = typed(
  "qa.question_asked",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    const payload = { questionId: p.questionId, targetKind: p.targetKind, targetId: p.targetId };
    // The asker is the actor: an erased asker drops the alert (`fanOut`), and staff who route the
    // question may see who asked it anyway.
    await fanOut(services, ctx, tx, {
      eventType: "qa.question_asked",
      actorMembershipId: p.askerMembershipId,
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload,
      bucket: bucketFor("qa.question_asked", services.now(), p.questionId),
      permission: QA_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "qa.question_asked",
      sourceKey: `qa.question_asked:${p.questionId}`,
      // Never the asker: a chat service is a third party, and the post is generic by design.
      actorMembershipId: null,
      payload: { questionId: p.questionId },
    });
  },
);

/** Assigned (instant): the assignee alone — nobody else by role, and not a self-assignment. */
export const onQaQuestionAssigned: EventHandler = typed(
  "qa.question_assigned",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const assignee = p.assigneeMembershipId;
    const actor = qaActor(p);
    if (assignee === null || assignee === actor) return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "qa.question_assigned",
      actorMembershipId: actor,
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload: { questionId: p.questionId },
      // Per assignment: the same question handed back to the same person later is news again.
      bucket: bucketFor(
        "qa.question_assigned",
        services.now(),
        `${p.questionId}:${event.outboxId}`,
      ),
      permission: null,
      alsoNotify: [assignee],
    });
  },
);

/** Submitted for four-eyes approval (instant; `data-room.qa_approve`, never the submitter). */
export const onQaAnswerSubmitted: EventHandler = typed(
  "qa.answer_submitted",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "qa.answer_submitted",
      // `fanOut` leaves the actor out of the staff list: an author never approves their own.
      actorMembershipId: qaActor(p),
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload: { questionId: p.questionId },
      // Per submission: a resubmission after a rejection needs an approver again.
      bucket: bucketFor("qa.answer_submitted", services.now(), `${p.questionId}:${event.outboxId}`),
      permission: QA_APPROVE,
    });
  },
);

/*
 * Released (instant): the asker alone, by email — investors have no inbox, and no staff member
 * needs telling that their own release happened. No actor, so the asker's erasure is what drops
 * it (`fanOut` skips an erased `alsoNotify`). One alert per outbox event: answered to the asker,
 * then published to everyone, or reopened, re-answered and released again, are each a fact the
 * asker should hear; a redelivery of the same event keeps its outbox id and collapses. (A bucket
 * per question per visibility would swallow the release after a reopen. The price is that an
 * unpublish/republish round trip, which publishes a new event, alerts the asker again.)
 */
export const onQaAnswerReleased: EventHandler = typed(
  "qa.answer_released",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (p.askerMembershipId === null) return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "qa.answer_released",
      actorMembershipId: null,
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload: { questionId: p.questionId, visibility: p.visibility },
      bucket: bucketFor(
        "qa.answer_released",
        services.now(),
        `${p.questionId}:${p.visibility}:${event.outboxId}`,
      ),
      permission: null,
      alsoNotify: [p.askerMembershipId],
    });
  },
);

/*
 * Declined, and staff chose to tell the asker (instant): the asker alone, by email, like a
 * release — no staff member needs telling. The asker's erasure drops it (`fanOut` skips an erased
 * `alsoNotify`). Per outbox event: a question reopened and declined again is news again; a
 * redelivery collapses.
 */
export const onQaQuestionDeclined: EventHandler = typed(
  "qa.question_declined",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "qa.question_declined",
      actorMembershipId: null,
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload: { questionId: p.questionId },
      bucket: bucketFor(
        "qa.question_declined",
        services.now(),
        `${p.questionId}:${event.outboxId}`,
      ),
      permission: null,
      alsoNotify: [p.askerMembershipId],
    });
  },
);

/*
 * SLA reminder (instant): the assignee and `data-room.qa_manage`, once per outbox event. The job
 * publishes a phase at most once per arming (it stamps the question in the same transaction), and
 * every re-arm — a moved deadline, even one moved back to an earlier value (A→B→A), a reopen or a
 * four-eyes take-offline resetting the stamps — makes the next reminder a new fact. Keying on the
 * deadline instead would swallow the A→B→A reminder. A redelivered event keeps its outbox id and
 * collapses.
 */
export const onQaQuestionDue: EventHandler = typed(
  "qa.question_due",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "qa.question_due",
      actorMembershipId: null,
      resourceKind: "qa_question",
      resourceId: p.questionId,
      payload: { questionId: p.questionId, phase: p.phase, dueAt: p.dueAt },
      bucket: bucketFor(
        "qa.question_due",
        services.now(),
        `${p.questionId}:${p.phase}:${event.outboxId}`,
      ),
      permission: QA_MANAGE,
      ...(p.assigneeMembershipId === null ? {} : { alsoNotify: [p.assigneeMembershipId] }),
    });
  },
);

/*
 * E-signature and round closing (E3.5, ADR-0053). None is a channel event: each is about a
 * person's signature or money.
 */

/** The envelope statuses that need a human: the signer said no, or the envelope died. */
const ATTENTION_STATUSES = new Set(["declined", "voided", "expired", "error"]);

/*
 * Any envelope — an NDA or a subscription agreement — that was declined, voided, expired or
 * failed: staff holding `esign.read` (the envelope register). No actor: the alert is about the
 * envelope, and the signer's name lives in the kernel, not here. One alert per envelope per
 * status: declined/voided/expired can only be reached once (the kernel's terminal trigger), and
 * `error` — recoverable, so it may recur after a recovery, and it is also what a permanent
 * collect failure publishes for a completed envelope — alerts once per envelope, a later error
 * of the same envelope collapsing into the row already written (so does a redelivery).
 */
export const onEsignEnvelopeChanged: EventHandler = typed(
  "esign.envelope_changed",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (!ATTENTION_STATUSES.has(p.status)) return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "esign.envelope_attention",
      actorMembershipId: null,
      resourceKind: "esign_envelope",
      resourceId: p.envelopeId,
      payload: { envelopeId: p.envelopeId, status: p.status, purpose: p.purpose },
      bucket: bucketFor("esign.envelope_attention", services.now(), `${p.envelopeId}:${p.status}`),
      permission: ESIGN_READ,
    });
  },
);

/*
 * A commitment's subscription agreement was signed: staff holding `round.manage`, like the other
 * round alerts. The actor is the commitment's member when it names one (an erased member drops
 * the alert in `fanOut`); otherwise the copy says "a subscription agreement was signed".
 */
export const onRoundSignatureCompleted: EventHandler = typed(
  "round.signature_completed",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.signature_completed",
      actorMembershipId: p.membershipId ?? null,
      resourceKind: "commitment",
      resourceId: p.commitmentId,
      payload: { commitmentId: p.commitmentId, roundId: p.roundId, envelopeId: p.envelopeId },
      // Per envelope: a commitment re-sent and signed again is a new fact; a redelivery is not.
      bucket: bucketFor("round.signature_completed", services.now(), p.envelopeId),
      permission: ROUND_MANAGE,
    });
  },
);

/*
 * Staff confirmed a wired commitment: the investor only, by email (investors have no inbox), like
 * a released Q&A answer. A commitment that names no member has nobody to tell. The investor's
 * erasure drops it (`fanOut` skips an erased `alsoNotify`), and one per commitment: the route is
 * idempotent and publishes once, and a redelivery collapses on the bucket.
 */
export const onRoundCommitmentConfirmed: EventHandler = typed(
  "round.commitment_confirmed",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (p.membershipId === undefined) return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.commitment_confirmed",
      actorMembershipId: null,
      resourceKind: "commitment",
      resourceId: p.commitmentId,
      payload: { commitmentId: p.commitmentId, roundId: p.roundId },
      bucket: bucketFor("round.commitment_confirmed", services.now(), p.commitmentId),
      permission: null,
      alsoNotify: [p.membershipId],
    });
  },
);

/*
 * A third-party connection became unhealthy (E3.6, ADR-0054): `reauth_required` (the vendor
 * refused its token) or `degraded` (3 failures in a row). Published by the kernel once per
 * transition. Staff holding `integrations.manage` (owners, admins) — in-app and by email at their
 * cadence (instant by default) — and every channel that opted in. No actor: it is a fact about the
 * workspace. One alert per outbox event: a connection that recovers and fails again is news again,
 * a redelivery is not.
 *
 * A Slack-app outage is not announced through the Slack app itself: those posts could only fail
 * (and would count toward switching the channel off for a reason that is not the channel's). The
 * incoming-webhook channels still get it.
 */
export const onConnectionUnhealthy: EventHandler = typed(
  "integration.connection_unhealthy",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    const fact = `${p.connectionId}:${p.status}:${event.outboxId}`;
    const payload = { connectionId: p.connectionId, provider: p.provider, status: p.status };
    await fanOut(services, ctx, tx, {
      eventType: "integration.connection_unhealthy",
      actorMembershipId: null,
      resourceKind: "integration_connection",
      resourceId: p.connectionId,
      payload,
      bucket: bucketFor("integration.connection_unhealthy", services.now(), fact),
      permission: INTEGRATIONS_MANAGE,
    });
    await enqueueChannelPosts(services, ctx, tx, {
      eventType: "integration.connection_unhealthy",
      sourceKey: `integration.connection_unhealthy:${fact}`,
      actorMembershipId: null,
      payload,
      ...(p.provider === "slack" ? { kinds: ["slack"] as const } : {}),
    });
  },
);

/*
 * Accreditation verification (E3.7, ADR-0055): the investor the verification belongs to (the
 * membership in the payload), by email, like a confirmed commitment — investors have no inbox, and
 * no staff member is told (`permission: null`; staff hear about verification *requests*, above).
 * No actor: the alert is addressed to its subject, so the investor's erasure is what drops it
 * (`fanOut` skips an erased `alsoNotify`), and so does a revoked or expired membership (`fanOut`
 * tells active members only). Ids and the status only; the copy is fixed text, no amounts, and a
 * link to the portal's round page. Nothing is re-read: the round schema is not this module's.
 */

/** The investor's verified accreditation expires soon: one reminder per verification. */
export const onRoundVerificationExpiring: EventHandler = typed(
  "round.verification_expiring",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.verification_expiring",
      actorMembershipId: null,
      resourceKind: "verification",
      resourceId: p.verificationId,
      payload: { verificationId: p.verificationId },
      // The round job publishes once per verification (it stamps `reminder_sent_at` in the same
      // transaction); a redelivery collapses on the verification id.
      bucket: bucketFor("round.verification_expiring", services.now(), p.verificationId),
      permission: null,
      alsoNotify: [p.membershipId],
    });
  },
);

/** The statuses an investor is told about; `pending` is not a decision. */
const DECIDED_STATUSES = new Set(["verified", "rejected", "expired"]);

/*
 * The investor's verification was settled — verified (by an admin or a vendor), rejected, or
 * expired by the lifecycle job. Always sent whoever decided it: it is the investor's own fact. One
 * alert per verification per status: a verification that is verified and later expires is news
 * twice; a redelivery collapses.
 */
export const onRoundVerificationDecided: EventHandler = typed(
  "round.verification_decided",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (!DECIDED_STATUSES.has(p.status)) return;
    const services = notifyServices();
    await fanOut(services, ctx, tx, {
      eventType: "round.verification_decided",
      actorMembershipId: null,
      resourceKind: "verification",
      resourceId: p.verificationId,
      payload: { verificationId: p.verificationId, status: p.status },
      bucket: bucketFor(
        "round.verification_decided",
        services.now(),
        `${p.verificationId}:${p.status}`,
      ),
      permission: null,
      alsoNotify: [p.membershipId],
    });
  },
);

/** DSAR erasure (E2.6): see `eraseMember`. */
export const onErasureRequested: EventHandler = typed(
  "member.erasure_requested",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    await eraseMember(notifyServices(), ctx, tx, p.requestId, p.membershipId);
  },
);

/*
 * Instant delivery for one freshly written row. The subscriber runs inside the outbox
 * dispatcher's transaction, so it does **not** send: it enqueues `notify.send` in that same
 * transaction (committed or rolled back with it), and the job emails the row with no
 * transaction open (`deliverNotification`). Holding a pooled connection and the dispatcher's
 * transaction across an ESP round trip is what this avoids; the extra hop costs one queue poll
 * (seconds), and `notify.deliver` remains the safety net a minute later.
 */
export const onNotificationCreated: EventHandler = typed(
  "notification.created",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const services = notifyServices();
    const row = await new NotificationRepo(ctx, tx).byId(event.payload.notificationId);
    if (row === undefined || row.sentAt !== null || row.cadence !== "instant") return;
    await services.queue.sendInTransaction(
      tx,
      JOB_SEND,
      { workspaceId: ctx.workspaceId, notificationId: row.id },
      { idempotencyKey: `notify.send:${row.id}` },
    );
  },
);
