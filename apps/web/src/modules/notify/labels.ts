import type {
  NotifyCadence,
  NotifyChannel,
  NotifyChannelEventType,
  NotifyChannelTestResult,
  NotifyEventType,
} from "../../lib/notify-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * Words for the notify module's enums. Labelled in the founder's terms, not the topic's: a
 * founder reading the preferences form has never heard of `round.interest_submitted`.
 */

export function eventLabel(type: NotifyEventType | NotifyChannelEventType): string {
  switch (type) {
    case "document.viewed":
      return m.notify_event_document_viewed();
    case "document.downloaded":
      return m.notify_event_document_downloaded();
    case "update.replied":
      return m.notify_event_update_replied();
    case "round.interest_submitted":
      return m.notify_event_round_interest_submitted();
    case "round.verification_requested":
      return m.notify_event_round_verification_requested();
    case "round.commitment_created":
      return m.notify_event_round_commitment_created();
    case "analytics.hot_lead":
      return m.notify_event_analytics_hot_lead();
    case "access_request.submitted":
      return m.notify_event_access_request_submitted();
    case "access_review.overdue":
      return m.notify_event_access_review_overdue();
    case "membership.delegate_added":
      return m.notify_event_membership_delegate_added();
    case "qa.question_asked":
      return m.notify_event_qa_question_asked();
    case "qa.question_assigned":
      return m.notify_event_qa_question_assigned();
    case "qa.answer_submitted":
      return m.notify_event_qa_answer_submitted();
    case "qa.answer_released":
      return m.notify_event_qa_answer_released();
    case "qa.question_declined":
      return m.notify_event_qa_question_declined();
    case "qa.question_due":
      return m.notify_event_qa_question_due();
    case "esign.envelope_attention":
      return m.notify_event_esign_envelope_attention();
    case "round.signature_completed":
      return m.notify_event_round_signature_completed();
    case "round.commitment_confirmed":
      return m.notify_event_round_commitment_confirmed();
    case "integration.connection_unhealthy":
      return m.notify_event_integration_connection_unhealthy();
    case "round.verification_expiring":
      return m.notify_event_round_verification_expiring();
    case "round.verification_decided":
      return m.notify_event_round_verification_decided();
  }
}

export function cadenceLabel(cadence: NotifyCadence): string {
  switch (cadence) {
    case "instant":
      return m.notify_cadence_instant();
    case "daily":
      return m.notify_cadence_daily();
    case "weekly":
      return m.notify_cadence_weekly();
    case "off":
      return m.notify_cadence_off();
  }
}

/** 0 = Sunday, as the API counts. */
export function weekdayLabel(day: number): string {
  switch (day) {
    case 0:
      return m.notify_weekday_0();
    case 1:
      return m.notify_weekday_1();
    case 2:
      return m.notify_weekday_2();
    case 3:
      return m.notify_weekday_3();
    case 4:
      return m.notify_weekday_4();
    case 5:
      return m.notify_weekday_5();
    default:
      return m.notify_weekday_6();
  }
}

/** Why a channel switched itself off, in the words of what the admin should do next. */
export function disabledReasonLabel(reason: NonNullable<NotifyChannel["disabledReason"]>): string {
  switch (reason) {
    case "not_found":
      return m.notify_channel_disabled_not_found();
    case "rejected":
      return m.notify_channel_disabled_rejected();
    case "invalid_url":
      return m.notify_channel_disabled_invalid_url();
    case "not_connected":
      return m.notify_slack_app_disabled_not_connected();
  }
}

/** What a test post's failure means. `null` reason on a failed test reads as "unavailable". */
export function testFailureLabel(reason: NotifyChannelTestResult["reason"]): string {
  switch (reason) {
    case "invalid_url":
      return m.notify_channel_test_invalid_url();
    case "not_found":
      return m.notify_channel_test_not_found();
    case "rejected":
      return m.notify_channel_test_rejected();
    case "rate_limited":
      return m.notify_channel_test_rate_limited();
    case "not_connected":
      return m.notify_slack_app_test_not_connected();
    default:
      return m.notify_channel_test_unavailable();
  }
}
