import { defineModule, type ModuleManifest } from "@fundroom/module-kit";
import { notifyDsar } from "./dsar.js";
import {
  onAccessRequestSubmitted,
  onAccessReviewOverdue,
  onConnectionUnhealthy,
  onDelegateAdded,
  onDocumentDownloaded,
  onDocumentViewed,
  onErasureRequested,
  onEsignEnvelopeChanged,
  onHotLead,
  onNotificationCreated,
  onQaAnswerReleased,
  onQaAnswerSubmitted,
  onQaQuestionAsked,
  onQaQuestionAssigned,
  onQaQuestionDeclined,
  onQaQuestionDue,
  onRoundCommitmentConfirmed,
  onRoundCommitmentCreated,
  onRoundInterestSubmitted,
  onRoundSignatureCompleted,
  onRoundVerificationDecided,
  onRoundVerificationExpiring,
  onRoundVerificationRequested,
  onUpdateReplied,
} from "./handlers.js";
import { createNotifyJobs } from "./jobs.js";
import { notifyPortability } from "./portability.js";
import { registerNotifyRoutes } from "./routes.js";

/*
 * Staff notifications (E1.5, design/03 C2 "basic"): per-member preferences (instant, daily
 * digest or off) for investor document views, downloads, update replies and — since E2.5 —
 * interest submissions and accreditation verification requests; an in-app inbox, instant email
 * alerts and one daily digest per member, never a flood (one alert per viewer per document per
 * hour). Investors have no inbox; they are emailed only about themselves (a new delegate, E3.2;
 * the answer to their data-room question, E3.3; their confirmed commitment, E3.5; their
 * accreditation verification's outcome and upcoming expiry, E3.7). E3.5 also alerts staff
 * about e-signature envelopes needing attention and signed subscription agreements.
 *
 * The round events are addressed to staff holding `round.manage` rather than `notify.read`: an
 * indication of interest is round material, and this module must not become the way a `viewer`
 * learns who wants into a round they cannot open.
 *
 * E2.6 ("full"): weekly digests; digests and quiet hours in each member's own timezone (with
 * catch-up after a missed hour); commitments and hot leads as event types; an inbox with keyset
 * paging, read-all and archive; workspace Slack channels (`notify.manage`) posting through
 * `services.chat`; the kernel suppression list honoured on every send; a retention job; and a
 * `member.erasure_requested` subscriber.
 *
 * E3.6 (ADR-0054): a second channel kind, `slack_app` — a channel of the workspace's Slack app
 * connection, posted through `services.integrations.slackPost` (`GET /notify/slack/channels` lists
 * what the bot can post to) — and an `integration.connection_unhealthy` alert to owners/admins
 * and opted-in channels.
 */
export const notifyModule: ModuleManifest = defineModule({
  id: "notify",
  version: "0.2.0",
  dsar: notifyDsar,
  dependsOn: ["access"],
  schema: "notify",
  migrations: new URL("../migrations/", import.meta.url),
  permissions: ["notify.read", "notify.manage"],
  portability: notifyPortability,
  routes: registerNotifyRoutes,
  jobs: createNotifyJobs,
  events: {
    emits: ["notification.created"],
    handles: {
      "document.viewed": onDocumentViewed,
      "document.downloaded": onDocumentDownloaded,
      "update.replied": onUpdateReplied,
      "round.interest_submitted": onRoundInterestSubmitted,
      "round.verification_requested": onRoundVerificationRequested,
      "round.commitment_created": onRoundCommitmentCreated,
      // E3.5 e-signature and round closing.
      "esign.envelope_changed": onEsignEnvelopeChanged,
      "round.signature_completed": onRoundSignatureCompleted,
      "round.commitment_confirmed": onRoundCommitmentConfirmed,
      // E3.7 accreditation vendors: the investor hears about their own verification.
      "round.verification_expiring": onRoundVerificationExpiring,
      "round.verification_decided": onRoundVerificationDecided,
      "analytics.hot_lead": onHotLead,
      "access_request.submitted": onAccessRequestSubmitted,
      "access_review.overdue": onAccessReviewOverdue,
      "membership.delegate_added": onDelegateAdded,
      "qa.question_asked": onQaQuestionAsked,
      "qa.question_assigned": onQaQuestionAssigned,
      "qa.answer_submitted": onQaAnswerSubmitted,
      "qa.answer_released": onQaAnswerReleased,
      "qa.question_declined": onQaQuestionDeclined,
      "qa.question_due": onQaQuestionDue,
      // E3.6 integrations hub: a connection needs re-authorising or keeps failing.
      "integration.connection_unhealthy": onConnectionUnhealthy,
      "member.erasure_requested": onErasureRequested,
      "notification.created": onNotificationCreated,
    },
  },
  slots: {
    "admin.nav": [
      {
        id: "notify-admin",
        label: "Notifications",
        to: "/admin/notify",
        order: 45,
        icon: "notifications",
      },
    ],
    // E2.7: the settings hub lists this. Preferences are per-operator, not workspace settings;
    // the workspace's chat channels (`notify.manage`) are.
    "admin.settings": [
      {
        id: "notify-channels",
        label: "Chat channels",
        to: "/admin/notify/channels",
        order: 45,
        icon: "notifications",
      },
    ],
  },
});

export default notifyModule;

export * from "./contracts.js";
export { notifyDsar } from "./dsar.js";
export {
  createNotifyJobs,
  DELIVER_GRACE_MS,
  JOB_CHANNELS,
  JOB_DELIVER,
  JOB_DIGEST,
  JOB_RETENTION,
  JOB_SEND,
} from "./jobs.js";
export {
  CHANNEL_DISABLE_AFTER,
  CHANNEL_MAX_ATTEMPTS,
  CHAT_KEY_PURPOSE,
  MAX_CHANNELS,
  NOTIFY_MAX_ATTEMPTS,
  retryDelayMs,
} from "./names.js";
export {
  IMPORT_DROPPED_REASON,
  IMPORT_RECONNECT_ERROR,
  IMPORT_SLACK_APP_ERROR,
  notifyPortability,
} from "./portability.js";
export { decodeInboxCursor, encodeInboxCursor } from "./routes.js";
export * from "./rules.js";
export * from "./schedule.js";
export {
  type ChannelFailure,
  type ChannelPostOutcome,
  channelInputOf,
  enqueueChannelPosts,
  fromSlackApp,
  postDueDeliveries,
  renderChannelMessage,
  slackAppText,
  urlHint,
} from "./service/channels.js";
export { applyRetention, eraseMember } from "./service/lifecycle.js";
export {
  ACCESS_MANAGE,
  ANALYTICS_READ,
  type DeliverOutcome,
  type DigestOutcome,
  deliverNotification,
  deliverPending,
  digestDueMembers,
  digestIdempotencyKey,
  ESIGN_READ,
  errorCode,
  type FanOutInput,
  type FanOutResult,
  fanOut,
  INTEGRATIONS_MANAGE,
  isMailSuppressed,
  NOTIFY_READ,
  QA_APPROVE,
  QA_MANAGE,
  ROUND_MANAGE,
  renderInstant,
  sendDigestFor,
  staffRecipients,
} from "./service/notify.js";
