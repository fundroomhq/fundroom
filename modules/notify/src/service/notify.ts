import { findWorkspaceById, type TenantContext, type Tx, workspaceIsActive } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type JsonObject, MailSuppressedError, type OutboundEmail } from "@fundroom/ports";
import { NOTIFY_MAX_ATTEMPTS, retryDelayMs } from "../names.js";
import { accessRequestSummaries, accessRequestSummary } from "../repos/access-request-repo.js";
import {
  DigestRepo,
  NotificationRepo,
  PreferenceRepo,
  SettingsRepo,
} from "../repos/notify-repo.js";
import {
  type DigestKind,
  dedupeKey,
  digestSubject,
  effectiveCadence,
  GROUP_TITLE,
  groupForDigest,
  instantSubject,
  integrationHealthSentence,
  integrationHealthSubject,
  isNotifyEventType,
  type NotifyEventType,
  VERB,
} from "../rules.js";
import {
  DEFAULT_DIGEST_HOUR,
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKLY_DAY,
  inQuietHours,
  isDigestDue,
  latestSlot,
  nextQuietEnd,
} from "../schedule.js";
import type { MemberSettings, Notification } from "../schema/notify.js";

/*
 * Fan-out and delivery (E1.5, design/03 C2 "basic"): an interesting investor action becomes
 * one `notification` row per subscribed staff member (deduped per hour), instant rows are
 * emailed right away by the `notification.created` subscriber (the deliver cron is the
 * safety net), daily rows are bundled by the digest job at each member's chosen hour.
 * Emails carry a generic noun plus the actor's display name; ids are resolved to names only
 * at render time, nothing personal is stored in `notify.*`.
 */
export const NOTIFY_READ = "notify.read";
/**
 * The permission the round alerts are addressed to (E2.5). Repeated here rather than imported
 * from `@fundroom/module-round`: modules never import each other (ADR-0033), and a string is
 * exactly what `hasPermission` takes. An install without the round module compiled in simply has
 * nobody holding it, and the fan-out finds no recipients.
 */
export const ROUND_MANAGE = "round.manage";
/** Hot-lead alerts go to whoever may already see the score (E2.6). */
export const ANALYTICS_READ = "analytics.read";
/** Access-request alerts go to whoever may approve or deny one (E3.1; a kernel permission). */
export const ACCESS_MANAGE = "access.manage";
/**
 * E-signature attention alerts (E3.5) go to whoever reads the envelope register (a kernel
 * permission: owner, admin, legal) — the people who can resend, void or chase a signer.
 */
export const ESIGN_READ = "esign.read";
/**
 * Data-room Q&A (E3.3): coordinators hear about new and late questions, approvers about answers
 * waiting for them. Strings, like `round.manage`, so this module never imports the data room.
 */
export const QA_MANAGE = "data-room.qa_manage";
export const QA_APPROVE = "data-room.qa_approve";
/**
 * Integration-health alerts (E3.6) go to whoever can reconnect a service: `integrations.manage`, a
 * kernel permission held by owners and admins.
 */
export const INTEGRATIONS_MANAGE = "integrations.manage";
const PAGE = 500;
const ELIGIBLE = ["active"] as const;

export interface Workspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The workspace's verified custom domain, else null; `workspaceUrl` prefers it (E2.1). */
  readonly primaryHost: string | null;
}

export interface FanOutInput {
  readonly eventType: NotifyEventType;
  /** The member the event is about; null for a commitment that names no member. */
  readonly actorMembershipId: string | null;
  readonly resourceKind:
    | "document"
    | "post"
    | "interest_submission"
    | "verification"
    | "commitment"
    | "member"
    | "access_request"
    | "workspace"
    | "qa_question"
    | "esign_envelope"
    | "integration_connection";
  readonly resourceId: string;
  readonly payload: JsonObject;
  readonly bucket: string;
  /**
   * The permission a staff member must hold to be told (default `notify.read`).
   *
   * It is per-event rather than fixed because the answer stopped being the same for every event
   * at E2.5: `notify.read` is "manage my own inbox" and every staff role has it, which is right
   * for a document view and wrong for an indication of interest — that is round material, and a
   * `viewer` who may not open the round must not learn who wants into it by email. The round
   * events ask for `round.manage`, so the alert follows the permission that governs the thing it
   * is about.
   *
   * `null` addresses no staff by role at all — only `alsoNotify` (E3.3: an assignment is news to
   * the assignee alone, a released answer to the asker alone). Explicit rather than a permission
   * nobody holds, which would break the day a role is granted it.
   */
  readonly permission?: string | null | undefined;
  /**
   * Members told whatever their role (E3.2): the principal of a new delegate. Still skipped when
   * being erased, deduped against the staff list, and subject to their own cadence.
   */
  readonly alsoNotify?: readonly string[] | undefined;
}

export interface FanOutResult {
  readonly created: number;
  readonly instant: number;
  readonly deduped: number;
}

async function loadWorkspace(services: ModuleServices, workspaceId: string): Promise<Workspace> {
  const w = await findWorkspaceById(services.db, workspaceId);
  if (w === undefined) throw new Error(`workspace ${workspaceId} is gone`);
  return { id: w.id, slug: w.slug, name: w.name, primaryHost: w.primaryHost };
}

/**
 * Active staff of the workspace holding `permission` (default `notify.read`), minus the actor.
 *
 * `hasPermission` is the RBAC matrix and answers `false` for a permission nobody holds — including
 * one whose module is not compiled into this install. That is what makes it safe to ask for
 * `round.manage` from here: the recipient list comes back empty and no alert is written, rather
 * than the fan-out throwing inside an event handler and putting the event into retry for ever.
 */
export async function staffRecipients(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  exclude: string | null,
  permission: string = NOTIFY_READ,
): Promise<string[]> {
  const members = new MembershipRepo(ctx, tx);
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await members.listPeople({
      kind: "staff",
      statuses: [...ELIGIBLE],
      limit: PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const row of page.items) {
      const m = row.membership;
      if (m.id === exclude) continue;
      if (!services.authz.hasPermission(m, permission)) continue;
      out.push(m.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

/**
 * Writes one row per subscribed recipient (skipping `off`, collapsing duplicates through the
 * dedupe key) and publishes `notification.created` for every new instant row.
 */
export async function fanOut(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  input: FanOutInput,
): Promise<FanOutResult> {
  /*
   * An event about a member whose erasure has been requested is dropped (E2.6): it was emitted
   * before the request but dispatched after it, and writing it would quietly undo the erasure.
   * The same goes for a recipient being erased — a staff member can be a data subject too.
   */
  if (
    input.actorMembershipId !== null &&
    (await services.legal.isErased(tx, ctx, input.actorMembershipId))
  ) {
    services.log("notify.dropped_erased", {
      workspaceId: ctx.workspaceId,
      eventType: input.eventType,
    });
    return { created: 0, instant: 0, deduped: 0 };
  }
  const recipients: string[] = [];
  const staff =
    input.permission === null
      ? []
      : await staffRecipients(
          services,
          ctx,
          tx,
          input.actorMembershipId,
          input.permission ?? NOTIFY_READ,
        );
  for (const id of staff) {
    if (!(await services.legal.isErased(tx, ctx, id))) recipients.push(id);
  }
  for (const id of input.alsoNotify ?? []) {
    if (recipients.includes(id)) continue;
    const m = await new MembershipRepo(ctx, tx).byId(id);
    if (m === undefined || m.status !== "active") continue;
    if (!(await services.legal.isErased(tx, ctx, id))) recipients.push(id);
  }
  if (recipients.length === 0) return { created: 0, instant: 0, deduped: 0 };
  const prefs = await new PreferenceRepo(ctx, tx).forMembers(recipients);
  const notifications = new NotificationRepo(ctx, tx);
  let created = 0;
  let instant = 0;
  let deduped = 0;
  for (const recipient of recipients) {
    const cadence = effectiveCadence(input.eventType, prefs.get(recipient));
    if (cadence === "off") continue;
    const row = await notifications.createUnlessDuplicate({
      membershipId: recipient,
      eventType: input.eventType,
      dedupeKey: dedupeKey({
        eventType: input.eventType,
        recipientMembershipId: recipient,
        actorMembershipId: input.actorMembershipId,
        resourceId: input.resourceId,
        bucket: input.bucket,
      }),
      actorMembershipId: input.actorMembershipId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      payload: input.payload,
      cadence,
    });
    if (row === undefined) {
      deduped += 1;
      continue;
    }
    created += 1;
    if (cadence === "instant") {
      instant += 1;
      await publish(tx, ctx, "notification.created", {
        notificationId: row.id,
        membershipId: recipient,
        type: input.eventType,
      });
    }
  }
  services.log("notify.fanned_out", {
    workspaceId: ctx.workspaceId,
    eventType: input.eventType,
    created,
    instant,
    deduped,
  });
  return { created, instant, deduped };
}

/**
 * The name for a row with no member behind it. An access request's requester is not a member
 * yet (E3.1): their name is read from the request, in the caller's transaction, when the alert
 * is rendered — never stored in `notify.*`, and pseudonymised there by erasure. Anything else
 * (a commitment that names no member, a request since deleted) reads as "Someone".
 */
async function subjectName(
  ctx: TenantContext,
  tx: Tx,
  row: Pick<Notification, "eventType" | "resourceId">,
): Promise<string> {
  if (row.eventType !== "access_request.submitted" || row.resourceId === null) return "Someone";
  return (await accessRequestSummary(ctx, tx, row.resourceId))?.name ?? "Someone";
}

function payloadId(row: Notification, key: string): string | undefined {
  const v = row.payload[key];
  return typeof v === "string" ? v : undefined;
}

interface Rendered {
  readonly subject: string;
  readonly title: string;
  readonly paragraphs: string[];
  readonly cta: { label: string; url: string } | undefined;
}

const DELEGATE_SCOPE_TEXT: Readonly<Record<string, string>> = {
  all: "everything you can see",
  data_room: "the data room only",
  updates: "updates only",
};

/** The body of a new-delegate alert (E3.2): the principal is told in the second person. */
function delegateParagraph(workspace: Workspace, row: Notification, actorName: string): string {
  const scope = DELEGATE_SCOPE_TEXT[payloadId(row, "scope") ?? ""] ?? "part of what you can see";
  const principal = payloadId(row, "principalMembershipId");
  if (principal !== undefined && row.membershipId === principal)
    return `A delegate was added to act for you in ${workspace.name}, with access to ${scope}. If you did not expect this, remove the delegate and contact the company.`;
  const theirs = scope.replace("you can", "they can");
  return `${actorName} has a new delegate in ${workspace.name}, with access to ${theirs}.`;
}

/** The body of an overdue-review reminder (E3.2); the due date is the payload's, as a UTC day. */
function overdueParagraph(workspace: Workspace, row: Notification): string {
  const due = payloadId(row, "dueAt");
  const day = due !== undefined && !Number.isNaN(Date.parse(due)) ? due.slice(0, 10) : undefined;
  const when = day === undefined ? "is overdue" : `was due on ${day}`;
  const first =
    row.payload["lastReviewId"] === null ? " No access review has been recorded yet." : "";
  return `The periodic access review of ${workspace.name} ${when}.${first} Check who can see what and record the review.`;
}

/**
 * The Q&A alerts (E3.3): fixed sentences and a link, never the question or the answer — that text
 * lives in the `dataroom` schema, which this module may not read, and it is an investor's own
 * words. `undefined` for any other type.
 */
function qaCopy(
  services: ModuleServices,
  workspace: Workspace,
  row: Notification,
  actorName: string,
): Omit<Rendered, "title"> | undefined {
  const type = row.eventType as NotifyEventType;
  if (!type.startsWith("qa.")) return undefined;
  const questionId = payloadId(row, "questionId") ?? row.resourceId ?? "";
  const staffLink = {
    label: "Open the question",
    url: services.workspaceUrl(workspace, `/admin/data-room/questions/${questionId}`).href,
  };
  switch (type) {
    case "qa.question_asked":
      return {
        subject:
          row.actorMembershipId === null
            ? "A new data-room question"
            : instantSubject(actorName, type),
        paragraphs: [
          `${row.actorMembershipId === null ? "Someone" : actorName} asked a question in the ${workspace.name} data room. It is waiting in the Q&A inbox to be assigned and answered.`,
        ],
        cta: staffLink,
      };
    case "qa.question_assigned":
      return {
        subject: VERB[type],
        paragraphs: [
          `A data-room question in ${workspace.name} was assigned to you. Draft an answer from the Q&A inbox.`,
        ],
        cta: staffLink,
      };
    case "qa.answer_submitted":
      return {
        subject: VERB[type],
        paragraphs: [
          `An answer to a data-room question in ${workspace.name} was submitted for approval. It cannot be released until someone other than its author approves it.`,
        ],
        cta: { ...staffLink, label: "Review the answer" },
      };
    case "qa.answer_released": {
      // The asker's own copy: an investor, reading it in their mailbox, linked to the portal.
      const published = row.payload["visibility"] === "target";
      return {
        subject: `${workspace.name} answered your question`,
        paragraphs: [
          published
            ? `${workspace.name} answered the question you asked in its data room, and published the answer for everyone who can see that document or folder.`
            : `${workspace.name} answered the question you asked in its data room. Only you can see the answer.`,
        ],
        cta: {
          label: "Read the answer",
          url: services.workspaceUrl(workspace, `/data-room/questions/${questionId}`).href,
        },
      };
    }
    case "qa.question_declined":
      // The asker's own copy, like a release: fixed text and the portal link, nothing quoted.
      return {
        subject: `${workspace.name} declined your question`,
        paragraphs: [
          `${workspace.name} declined to answer a question you asked in its data room. You can see it, and ask another, in the data room.`,
        ],
        cta: {
          label: "View your question",
          url: services.workspaceUrl(workspace, `/data-room/questions/${questionId}`).href,
        },
      };
    case "qa.question_due": {
      const overdue = row.payload["phase"] === "overdue";
      const due = payloadId(row, "dueAt");
      const at =
        due !== undefined && !Number.isNaN(Date.parse(due))
          ? ` (${due.slice(0, 16).replace("T", " ")} UTC)`
          : "";
      return {
        subject: overdue ? "A data-room question is overdue" : "A data-room question is due soon",
        paragraphs: [
          overdue
            ? `A data-room question in ${workspace.name} passed its answer deadline${at} without a released answer.`
            : `A data-room question in ${workspace.name} reaches its answer deadline soon${at}.`,
        ],
        cta: staffLink,
      };
    }
    default:
      return undefined;
  }
}

const ATTENTION_SUBJECT: Readonly<Record<string, string>> = {
  declined: "An e-signature request was declined",
  voided: "An e-signature request was voided",
  expired: "An e-signature request expired",
  error: "An e-signature request failed",
};

const ATTENTION_WHAT: Readonly<Record<string, string>> = {
  declined: "was declined by the signer",
  voided: "was voided",
  expired: "expired before it was signed",
  error: "could not be sent or processed by the e-signature vendor",
};

const ATTENTION_NEXT_DEFAULT =
  "Open the envelope register to see it and, if needed, send a new one.";

/*
 * A kernel `error` is not the end (E3.5 fix C1): an envelope that reached the vendor may still be
 * live there, and the investor may sign it. "Send a new one" would invite a duplicate agreement.
 */
const ATTENTION_NEXT: Readonly<Record<string, string>> = {
  error:
    "It may still be open at the vendor: open the envelope register to resync it, or void it before sending a new one.",
};

/**
 * E3.5 e-signature and closing copy. Fixed sentences plus a link: the payload carries ids and a
 * status only, and the envelope's title and signer live in the kernel (never in `notify.*`).
 * `undefined` for any other type.
 */
function closingCopy(
  services: ModuleServices,
  workspace: Workspace,
  row: Notification,
  actorName: string,
): Omit<Rendered, "title"> | undefined {
  const type = row.eventType as NotifyEventType;
  switch (type) {
    case "esign.envelope_attention": {
      const status = payloadId(row, "status") ?? "error";
      const what =
        row.payload["purpose"] === "nda" ? "An NDA sent for signature" : "A subscription agreement";
      return {
        subject: ATTENTION_SUBJECT[status] ?? VERB[type],
        paragraphs: [
          `${what} in ${workspace.name} ${ATTENTION_WHAT[status] ?? "needs attention"}. ${ATTENTION_NEXT[status] ?? ATTENTION_NEXT_DEFAULT}`,
        ],
        cta: {
          label: "Open e-signature",
          url: services.workspaceUrl(workspace, "/admin/esign").href,
        },
      };
    }
    case "round.signature_completed": {
      const roundId = payloadId(row, "roundId") ?? "";
      const anonymous = row.actorMembershipId === null;
      return {
        subject: anonymous
          ? "A subscription agreement was signed"
          : instantSubject(actorName, type),
        paragraphs: [
          anonymous
            ? `A subscription agreement for a commitment in ${workspace.name} was signed. The signed copy is filed in the data room.`
            : `${actorName} signed their subscription agreement in ${workspace.name}. The signed copy is filed in the data room.`,
        ],
        cta: {
          label: "Open the round",
          url: services.workspaceUrl(workspace, `/admin/round/rounds/${roundId}`).href,
        },
      };
    }
    case "round.commitment_confirmed":
      // The investor's own copy, in their mailbox, linked to the portal's round page.
      return {
        subject: `${workspace.name} confirmed your commitment`,
        paragraphs: [
          `${workspace.name} has received and confirmed your investment in its round. Your closing checklist in the portal shows where everything stands.`,
        ],
        cta: {
          label: "View your round",
          url: services.workspaceUrl(workspace, "/round").href,
        },
      };
    default:
      return undefined;
  }
}

/** The investor's own copy of a settled verification (E3.7), by status; neutral on purpose. */
const DECIDED_COPY: Readonly<
  Record<string, { subject: string; what: string; next: string; renew: boolean }>
> = {
  verified: {
    subject: "Your accreditation verification is complete",
    what: "is complete",
    next: "The portal shows its status.",
    renew: false,
  },
  rejected: {
    subject: "Your accreditation verification could not be completed",
    what: "could not be completed",
    next: "The portal shows its status and how to start a new verification.",
    renew: false,
  },
  expired: {
    subject: "Your accreditation verification has expired",
    what: "has expired",
    next: "Renew it in the portal to keep taking part in the round.",
    renew: true,
  },
};

/**
 * E3.7 accreditation copy: addressed to the investor in the second person, linked to the portal's
 * round page (where the verification card lives). Fixed sentences: no amounts, no method, no
 * evidence, no vendor — the payload carries ids and the status only, and the round schema (with
 * the expiry date) is not this module's to read, so an expiry reminder says "soon" (the round job
 * sends it `reverification.reminderDays` ahead). `undefined` for any other type.
 */
function verificationCopy(
  services: ModuleServices,
  workspace: Workspace,
  row: Notification,
): Omit<Rendered, "title"> | undefined {
  const type = row.eventType as NotifyEventType;
  const portal = services.workspaceUrl(workspace, "/round").href;
  if (type === "round.verification_expiring")
    return {
      subject: VERB[type],
      paragraphs: [
        `Your accreditation verification with ${workspace.name} expires soon. Renew it in the portal to keep taking part in the round without interruption.`,
      ],
      cta: { label: "Renew your verification", url: portal },
    };
  if (type !== "round.verification_decided") return undefined;
  const copy = DECIDED_COPY[payloadId(row, "status") ?? ""];
  if (copy === undefined)
    return {
      subject: VERB[type],
      paragraphs: [
        `Your accreditation verification with ${workspace.name} was updated. The portal shows its status.`,
      ],
      cta: { label: "View your round", url: portal },
    };
  return {
    subject: copy.subject,
    paragraphs: [
      `Your accreditation verification with ${workspace.name} ${copy.what}. ${copy.next}`,
    ],
    cta: { label: copy.renew ? "Renew your verification" : "View your round", url: portal },
  };
}

/** Copy for one instant alert: generic noun, actor name, links to the admin pages. */
export function renderInstant(
  services: ModuleServices,
  workspace: Workspace,
  row: Notification,
  actorName: string,
): Rendered {
  const type = row.eventType as NotifyEventType;
  if (type === "integration.connection_unhealthy") {
    // E3.6: a vendor name and a state; the account label and any error text stay in the kernel.
    const provider = payloadId(row, "provider") ?? "";
    const status = payloadId(row, "status") ?? "degraded";
    const subject = integrationHealthSubject(provider, status);
    return {
      subject,
      title: subject,
      paragraphs: [
        `${integrationHealthSentence(provider, status, workspace.name)} ${
          status === "reauth_required"
            ? "Until it is reconnected, nothing is read from it or sent through it."
            : "Open the integrations page to see the last error and check the connection."
        }`,
      ],
      cta: {
        label: "Open integrations",
        url: services.workspaceUrl(workspace, "/admin/integrations").href,
      },
    };
  }
  const qa = qaCopy(services, workspace, row, actorName);
  if (qa !== undefined) return { ...qa, title: qa.subject };
  const closing = closingCopy(services, workspace, row, actorName);
  if (closing !== undefined) return { ...closing, title: closing.subject };
  const verification = verificationCopy(services, workspace, row);
  if (verification !== undefined) return { ...verification, title: verification.subject };
  const anonymousCommitment = type === "round.commitment_created" && row.actorMembershipId === null;
  const subject = anonymousCommitment
    ? "A new commitment was recorded"
    : instantSubject(actorName, type);
  const paragraphs = [
    type === "membership.delegate_added"
      ? delegateParagraph(workspace, row, actorName)
      : type === "access_review.overdue"
        ? overdueParagraph(workspace, row)
        : anonymousCommitment
          ? `A new commitment was recorded in ${workspace.name}.`
          : type === "access_request.submitted"
            ? `${actorName} ${VERB[type]} to ${workspace.name}. The request is waiting for a decision.`
            : `${actorName} ${VERB[type]} in ${workspace.name}.`,
  ];
  let cta: Rendered["cta"];
  if (type === "membership.delegate_added") {
    const principal = payloadId(row, "principalMembershipId") ?? row.resourceId ?? "";
    cta =
      row.membershipId === principal
        ? {
            label: "Review your delegates",
            url: services.workspaceUrl(workspace, "/settings/delegates").href,
          }
        : {
            label: "Open their profile",
            url: services.workspaceUrl(workspace, `/admin/people/${principal}`).href,
          };
  } else if (type === "access_review.overdue") {
    cta = {
      label: "Open the access review",
      url: services.workspaceUrl(workspace, "/admin/access-review").href,
    };
  } else if (type === "access_request.submitted") {
    cta = {
      label: "Review access requests",
      url: services.workspaceUrl(workspace, "/admin/access-requests").href,
    };
  } else if (type === "analytics.hot_lead") {
    const score = row.payload["score"];
    if (typeof score === "number") paragraphs.push(`Engagement score: ${score} of 100.`);
    cta = {
      label: "See their activity",
      url: services.workspaceUrl(
        workspace,
        `/admin/analytics/members/${payloadId(row, "membershipId") ?? row.resourceId ?? ""}`,
      ).href,
    };
  } else if (type === "round.commitment_created") {
    const roundId = payloadId(row, "roundId") ?? "";
    cta = {
      label: "Open the round",
      url: services.workspaceUrl(workspace, `/admin/round/rounds/${roundId}`).href,
    };
  } else if (type === "round.interest_submitted") {
    const roundId = payloadId(row, "roundId") ?? "";
    cta = {
      label: "Open the interest queue",
      url: services.workspaceUrl(workspace, `/admin/round/rounds/${roundId}`).href,
    };
  } else if (type === "round.verification_requested") {
    cta = {
      label: "Open the verification queue",
      url: services.workspaceUrl(workspace, "/admin/round/verifications").href,
    };
  } else if (type === "update.replied") {
    const postId = payloadId(row, "postId") ?? row.resourceId ?? "";
    cta = {
      label: "Open the update",
      url: services.workspaceUrl(workspace, `/admin/updates/${postId}`).href,
    };
  } else {
    const documentId = payloadId(row, "documentId") ?? row.resourceId ?? "";
    cta = {
      label: "See engagement",
      url: services.workspaceUrl(workspace, `/admin/analytics/documents/${documentId}`).href,
    };
    paragraphs.push(
      `Open the document: ${services.workspaceUrl(workspace, `/admin/data-room/documents/${documentId}`).href}`,
    );
  }
  return { subject, title: subject, paragraphs, cta };
}

export type DeliverOutcome =
  | "sent"
  | "email_off"
  | "no_address"
  | "suppressed"
  | "deferred"
  | "already_sent"
  | "not_instant"
  /** The mailer failed; the row waits for its next attempt. */
  | "retry"
  /** The mailer failed for the last allowed time; the row is closed as `failed`. */
  | "failed"
  /** A retry whose backoff has not ended (or a claim still in flight elsewhere). */
  | "not_due"
  /**
   * The workspace is held or suspended (E3.10 FR1): nothing sent, the row untouched — the
   * `notify.deliver` sweep sends it once the workspace is active again.
   */
  | "workspace_inactive"
  /** The row no longer exists (erased, or aged out). */
  | "gone";

/**
 * The composition root's suppression wrapper throws `MailSuppressedError`. Matched by class and,
 * as a fallback, by shape: a second copy of `@fundroom/ports` in a bundle must not turn a
 * suppressed address into a retry loop.
 */
export function isMailSuppressed(error: unknown): boolean {
  if (error instanceof MailSuppressedError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "MailSuppressedError" &&
    (error as { code?: unknown }).code === "suppressed"
  );
}

function quietOf(settings: MemberSettings | undefined) {
  return {
    timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
    start: settings?.quietStart ?? null,
    end: settings?.quietEnd ?? null,
  };
}

/** A mailer error as a short code for `last_error` — never its message (it may quote an address). */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,60}$/u.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,60}$/u.test(name)) return name;
  return "error";
}

type Claimed =
  | { readonly kind: "done"; readonly outcome: DeliverOutcome }
  | {
      readonly kind: "send";
      readonly row: Notification;
      readonly attempt: number;
      readonly message: OutboundEmail;
    };

/**
 * Delivers one instant notification by id, **outside any caller transaction** — three steps:
 *
 *  1. a short transaction locks the row and decides: already processed; email off / no address
 *     (processed without mail, terminally); inside the recipient's quiet hours (held back with
 *     `deferred_until` — `notify.deliver` sends it when the window ends); a retry that is not due
 *     yet; or a send, which is *claimed* (`attempts` + 1, `next_attempt_at` pushed out by the
 *     backoff, which is also the claim's lease) and committed;
 *  2. the email goes out with no transaction open, so a slow ESP never holds a pooled
 *     connection (or the outbox dispatcher's transaction) while it answers;
 *  3. a second short transaction records what happened: `emailed`; `suppressed` (the kernel's
 *     list refused the address — terminal, never retried); or a failure, which leaves the row for
 *     its next attempt, or closes it as `failed` after `NOTIFY_MAX_ATTEMPTS`.
 *
 * The idempotency key is the row id, so a crash between (2) and (3) re-sends under the same key
 * and an ESP that honours keys drops the duplicate. A mailer failure never throws out of here:
 * the backoff, not the job queue's retry, decides when the row is tried again.
 */
export async function deliverNotification(
  services: ModuleServices,
  ctx: TenantContext,
  notificationId: string,
  workspace?: Workspace,
): Promise<DeliverOutcome> {
  const now = services.now();
  // Loaded *before* the transaction opens: `findWorkspaceById` takes its own pool connection,
  // and taking a second connection while holding one is how a burst of deliveries deadlocks
  // the pool (every connection idle in a transaction, each waiting for one more).
  const ws = workspace ?? (await loadWorkspace(services, ctx.workspaceId));
  const claimed = await services.db.withTenant(ctx, async (tx): Promise<Claimed> => {
    const notifications = new NotificationRepo(ctx, tx);
    const row = await notifications.lockById(notificationId);
    if (row === undefined) return { kind: "done", outcome: "gone" };
    if (row.sentAt !== null) return { kind: "done", outcome: "already_sent" };
    if (row.cadence !== "instant") return { kind: "done", outcome: "not_instant" };
    if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > now.getTime())
      return { kind: "done", outcome: "not_due" };
    if (row.deferredUntil !== null && row.deferredUntil.getTime() > now.getTime())
      return { kind: "done", outcome: "deferred" };
    // Checked at send time (E3.10 FR1): the instant path runs from an event subscriber too.
    if (!(await workspaceIsActive(tx, ctx.workspaceId)))
      return { kind: "done", outcome: "workspace_inactive" };
    const members = new MembershipRepo(ctx, tx);
    const settings = await new SettingsRepo(ctx, tx).forMember(row.membershipId);
    const names = await members.namesFor(
      row.actorMembershipId ? [row.membershipId, row.actorMembershipId] : [row.membershipId],
    );
    const recipient = names.get(row.membershipId);
    if (settings?.emailEnabled === false) {
      await notifications.markSent(row.id, now, "email_off");
      return { kind: "done", outcome: "email_off" };
    }
    if (!recipient?.email) {
      await notifications.markSent(row.id, now, "no_address");
      return { kind: "done", outcome: "no_address" };
    }
    const quiet = quietOf(settings);
    if (inQuietHours(now, quiet)) {
      const until = nextQuietEnd(now, quiet);
      if (until !== undefined) {
        await notifications.defer(row.id, until);
        return { kind: "done", outcome: "deferred" };
      }
    }
    if (row.attempts >= NOTIFY_MAX_ATTEMPTS) {
      // A row that exhausted its attempts but was never closed (a crash after the last claim).
      await notifications.recordFailure(row.id, row.lastError ?? "error", now, true);
      return { kind: "done", outcome: "failed" };
    }
    const actorName = row.actorMembershipId
      ? (names.get(row.actorMembershipId)?.displayName ?? "Someone")
      : await subjectName(ctx, tx, row);
    const r = renderInstant(services, ws, row, actorName);
    const attempt = row.attempts + 1;
    await notifications.claimAttempt(
      row.id,
      attempt,
      new Date(now.getTime() + retryDelayMs(attempt)),
    );
    const message: OutboundEmail = {
      to: recipient.email,
      // Every notification belongs to exactly one workspace, so the mailer's brand resolver
      // always has a key here (E1.7).
      workspaceId: ctx.workspaceId,
      subject: r.subject,
      text: [
        r.title,
        "",
        ...r.paragraphs,
        "",
        ...(r.cta ? [`${r.cta.label}: ${r.cta.url}`] : []),
      ].join("\n"),
      template: {
        name: "notification",
        props: { title: r.title, paragraphs: r.paragraphs, ...(r.cta ? { cta: r.cta } : {}) },
      },
      tags: ["notify", row.eventType],
      idempotencyKey: `notify:${row.id}`,
      headers: { "Auto-Submitted": "auto-generated" },
      // E2.6: staff alerts are their own stream — checked against the suppression list, never
      // tracked — and carry ids only, so a bounce can be routed back without an address.
      stream: "notification",
      ref: { kind: "notification", id: row.id, membershipId: row.membershipId },
    };
    return { kind: "send", row, attempt, message };
  });
  if (claimed.kind === "done") return claimed.outcome;

  const { row, attempt, message } = claimed;
  let failure: unknown;
  let suppressedBy: unknown;
  try {
    await services.mailer.send(message);
  } catch (error) {
    if (isMailSuppressed(error)) suppressedBy = error;
    else failure = error;
  }
  const done = services.now();
  return services.db.withTenant(ctx, async (tx) => {
    const notifications = new NotificationRepo(ctx, tx);
    if (suppressedBy !== undefined) {
      await notifications.markSent(row.id, done, "suppressed");
      services.log("notify.suppressed", {
        workspaceId: ctx.workspaceId,
        notificationId: row.id,
        // Logged, never switched on: any reason (bounce, complaint, provider) means "do not send".
        reason: (suppressedBy as { reason?: unknown }).reason ?? null,
      });
      return "suppressed";
    }
    if (failure !== undefined) {
      const terminal = attempt >= NOTIFY_MAX_ATTEMPTS;
      const code = errorCode(failure);
      await notifications.recordFailure(row.id, code, done, terminal);
      services.log(terminal ? "notify.deliver_gave_up" : "notify.deliver_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        notificationId: row.id,
        attempt,
        error: code,
      });
      return terminal ? "failed" : "retry";
    }
    if (await notifications.markSent(row.id, done, "emailed")) {
      await services.audit.record(tx, ctx, {
        action: "notification.sent",
        resourceKind: "notification",
        resourceId: row.id,
        subjectMembershipId: row.membershipId,
        meta: { eventType: row.eventType },
      });
    }
    return "sent";
  });
}

/**
 * Sends every unsent instant row created before `before` whose quiet-hours hold and retry
 * backoff (if any) have ended by `now` — the cron safety net, the path a deferred email leaves
 * by, and the retry loop. Fewest attempts first, so failing rows never crowd out fresh ones.
 */
export async function deliverPending(
  services: ModuleServices,
  ctx: TenantContext,
  before: Date,
  limit = 200,
): Promise<number> {
  const now = services.now();
  const rows = await services.db.withTenant(ctx, (tx) =>
    new NotificationRepo(ctx, tx).pending("instant", { before, readyAt: now, limit }),
  );
  if (rows.length === 0) return 0;
  const ws = await loadWorkspace(services, ctx.workspaceId);
  let sent = 0;
  for (const row of rows) {
    try {
      const outcome = await deliverNotification(services, ctx, row.id, ws);
      if (outcome === "sent") sent += 1;
    } catch (error) {
      services.log("notify.deliver_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        notificationId: row.id,
        error: errorCode(error),
      });
    }
  }
  return sent;
}

export interface DigestOutcome {
  readonly membershipId: string;
  readonly kind: DigestKind;
  readonly count: number;
  readonly emailed: boolean;
  readonly suppressed: boolean;
}

type DigestClaim =
  | { readonly kind: "done"; readonly outcome: DigestOutcome | undefined }
  | {
      readonly kind: "send";
      readonly digestId: string;
      readonly attempt: number;
      readonly ids: readonly string[];
      readonly message: OutboundEmail;
      readonly eventTypes: readonly string[];
    };

/** The ESP idempotency key of one digest: the same for every attempt at the same slot. */
export function digestIdempotencyKey(membershipId: string, kind: DigestKind, slot: string): string {
  return `notify:digest:${membershipId}:${kind}:${slot}`;
}

/**
 * Bundles one member's unsent rows of `kind` (daily or weekly) into one email. Three steps, like
 * `deliverNotification`, and for the same two reasons — no mail is sent while a transaction is
 * open, and a retry must never produce a second, differently keyed email:
 *
 *  1. **claim** (committed): a digest row for (member, kind, schedule slot) is written unsent and
 *     the rows are attached to it. An earlier claim that never finished is taken up again first,
 *     with its own rows and its own slot, so the retry is the *same* digest;
 *  2. **send**, outside any transaction, with an idempotency key derived from (member, kind,
 *     slot) — a retry after a lost acknowledgement or a failed commit re-sends under the same
 *     key and the provider drops the duplicate;
 *  3. **mark**: the digest gets `sent_at`, the rows `digested`, the member's `last_<kind>` stamp.
 *
 * Nothing pending → nothing happens. Email off, no address or a suppressed address → the rows
 * are processed without a digest row (and the stamp still moves, so the member is not
 * re-selected every hour). A mailer failure throws (the job logs it; the next hourly run retries
 * the same claim); after `NOTIFY_MAX_ATTEMPTS` the rows are closed as `failed`.
 */
export async function sendDigestFor(
  services: ModuleServices,
  ctx: TenantContext,
  membershipId: string,
  kind: DigestKind = "daily",
  workspace?: Workspace,
  at?: Date,
): Promise<DigestOutcome | undefined> {
  const ws = workspace ?? (await loadWorkspace(services, ctx.workspaceId));
  const now = at ?? services.now();
  const claim = await services.db.withTenant(ctx, async (tx): Promise<DigestClaim> => {
    // A held or suspended workspace sends no digest (E3.10 FR1); the rows wait, unclaimed, and
    // the member stays due, so the first hourly run after it is active again sends them.
    if (!(await workspaceIsActive(tx, ctx.workspaceId)))
      return { kind: "done", outcome: undefined };
    const notifications = new NotificationRepo(ctx, tx);
    const digests = new DigestRepo(ctx, tx);
    const settingsRepo = new SettingsRepo(ctx, tx);
    const settings = await settingsRepo.forMember(membershipId);
    let d = await digests.unsent(membershipId, kind);
    let rows = d === undefined ? [] : await notifications.forDigest(d.id);
    if (d !== undefined && rows.length === 0) {
      // Its rows were erased or aged out: nothing left to send under that claim.
      await digests.remove(d.id);
      d = undefined;
    }
    if (d === undefined) {
      rows = await notifications.pending(kind, { membershipId, unattached: true, limit: 1000 });
    }
    if (rows.length === 0) return { kind: "done", outcome: undefined };
    const ids = rows.map((r) => r.id);
    const closeWithout = async (outcome: "email_off" | "no_address" | "suppressed" | "failed") => {
      await notifications.markManySent(ids, now, outcome, null);
      if (d !== undefined) await digests.remove(d.id);
      await settingsRepo.markDigested(membershipId, kind, now);
      return {
        kind: "done" as const,
        outcome: {
          membershipId,
          kind,
          count: rows.length,
          emailed: false,
          suppressed: outcome === "suppressed",
        },
      };
    };
    const actorIds = [
      ...new Set(rows.map((r) => r.actorMembershipId).filter((x): x is string => x !== null)),
    ];
    const names = await new MembershipRepo(ctx, tx).namesFor([membershipId, ...actorIds]);
    const requesters = await accessRequestSummaries(
      ctx,
      tx,
      rows
        .filter((r) => r.eventType === "access_request.submitted" && r.resourceId !== null)
        .map((r) => r.resourceId as string),
    );
    const recipient = names.get(membershipId);
    if (settings?.emailEnabled === false) return closeWithout("email_off");
    if (!recipient?.email) return closeWithout("no_address");
    if (d === undefined) {
      const slot = latestSlot(
        now,
        settings?.timezone ?? DEFAULT_TIMEZONE,
        settings?.digestHour ?? DEFAULT_DIGEST_HOUR,
        kind === "weekly" ? (settings?.weeklyDay ?? DEFAULT_WEEKLY_DAY) : null,
      ).toISOString();
      d = await digests.claim({
        membershipId,
        kind,
        slot,
        periodStart: rows[0]?.createdAt ?? now,
        periodEnd: now,
        count: rows.length,
      });
      if (d === undefined) {
        // This slot was already served (a racing run, or a direct call inside one slot): the
        // rows wait for the next slot rather than going out under a second key.
        return { kind: "done", outcome: undefined };
      }
      await notifications.attachToDigest(ids, d.id);
    }
    if (d.attempts >= NOTIFY_MAX_ATTEMPTS) return closeWithout("failed");
    const attempt = d.attempts + 1;
    await digests.setAttempts(d.id, attempt, rows.length);
    const groups = groupForDigest(
      rows.filter((r) => isNotifyEventType(r.eventType)) as {
        eventType: NotifyEventType;
        actorMembershipId: string | null;
        resourceId: string | null;
      }[],
      (id, resourceId) =>
        id
          ? (names.get(id)?.displayName ?? "Someone")
          : ((resourceId !== null ? requesters.get(resourceId)?.name : undefined) ?? "Someone"),
    );
    const paragraphs: string[] = [
      kind === "weekly"
        ? `Here is what happened in ${ws.name} this week.`
        : `Here is what happened in ${ws.name} since your last digest.`,
      ...groups.flatMap((g) => [`${GROUP_TITLE[g.eventType]} (${g.count})`, ...g.lines]),
    ];
    const subject = digestSubject(ws.name, rows.length, kind);
    const cta = {
      label: "Open notifications",
      url: services.workspaceUrl(ws, "/admin/notify").href,
    };
    return {
      kind: "send",
      digestId: d.id,
      attempt,
      ids,
      eventTypes: groups.map((g) => g.eventType),
      message: {
        to: recipient.email,
        workspaceId: ctx.workspaceId,
        subject,
        text: [subject, "", ...paragraphs, "", `${cta.label}: ${cta.url}`].join("\n"),
        template: { name: "notification", props: { title: subject, paragraphs, cta } },
        tags: ["notify", "digest"],
        idempotencyKey: digestIdempotencyKey(membershipId, kind, d.slot ?? d.id),
        headers: { "Auto-Submitted": "auto-generated" },
        stream: "notification",
        ref: { kind: "notify_digest", id: d.id, membershipId },
      },
    };
  });
  if (claim.kind === "done") return claim.outcome;

  let sent: Awaited<ReturnType<ModuleServices["mailer"]["send"]>> | undefined;
  let suppressedBy: unknown;
  try {
    sent = await services.mailer.send(claim.message);
  } catch (error) {
    if (!isMailSuppressed(error)) {
      if (claim.attempt >= NOTIFY_MAX_ATTEMPTS) {
        await services.db.withTenant(ctx, async (tx) => {
          await new NotificationRepo(ctx, tx).markManySent(claim.ids, now, "failed", null);
          await new DigestRepo(ctx, tx).remove(claim.digestId);
          await new SettingsRepo(ctx, tx).markDigested(membershipId, kind, now);
        });
      }
      throw error;
    }
    suppressedBy = error;
  }
  return services.db.withTenant(ctx, async (tx) => {
    const notifications = new NotificationRepo(ctx, tx);
    const digests = new DigestRepo(ctx, tx);
    const settingsRepo = new SettingsRepo(ctx, tx);
    if (suppressedBy !== undefined || sent === undefined) {
      services.log("notify.suppressed", { workspaceId: ctx.workspaceId, digest: kind });
      await notifications.markManySent(claim.ids, now, "suppressed", null);
      await digests.remove(claim.digestId);
      await settingsRepo.markDigested(membershipId, kind, now);
      return { membershipId, kind, count: claim.ids.length, emailed: false, suppressed: true };
    }
    await digests.markSent(claim.digestId, sent.acceptedAt, sent.messageId);
    await notifications.markManySent(claim.ids, now, "digested", claim.digestId);
    await settingsRepo.markDigested(membershipId, kind, now);
    await services.audit.record(tx, ctx, {
      action: "notification.digest_sent",
      resourceKind: "notification",
      resourceId: claim.digestId,
      subjectMembershipId: membershipId,
      meta: { kind, count: claim.ids.length, eventTypes: [...claim.eventTypes] },
    });
    return { membershipId, kind, count: claim.ids.length, emailed: true, suppressed: false };
  });
}

/**
 * Members with rows of `kind` waiting whose digest is due at `now` in their own timezone
 * (`isDigestDue`: a slot has passed since the last digest, so a missed hour is caught up).
 */
export async function digestDueMembers(
  services: ModuleServices,
  ctx: TenantContext,
  now: Date,
  kind: DigestKind = "daily",
): Promise<string[]> {
  return services.db.withTenant(ctx, async (tx) => {
    const withPending = await new NotificationRepo(ctx, tx).membersWithPending(kind);
    if (withPending.length === 0) return [];
    const settings = await new SettingsRepo(ctx, tx).forMembers(
      withPending.map((p) => p.membershipId),
    );
    return withPending
      .filter((p) => {
        const s = settings.get(p.membershipId);
        const schedule = {
          timezone: s?.timezone ?? DEFAULT_TIMEZONE,
          hour: s?.digestHour ?? DEFAULT_DIGEST_HOUR,
          weekday: kind === "weekly" ? (s?.weeklyDay ?? DEFAULT_WEEKLY_DAY) : null,
        };
        const last = (kind === "weekly" ? s?.lastWeeklyDigestAt : s?.lastDailyDigestAt) ?? null;
        return isDigestDue(now, schedule, last, p.oldest);
      })
      .map((p) => p.membershipId);
  });
}

export { loadWorkspace };
