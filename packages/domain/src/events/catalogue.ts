import { z } from "zod";

/*
 * Domain event catalogue (EXECUTION_PLAN §5.3 `events`, design/06 §1, E0.4).
 *
 * Every event that crosses a bounded context goes through the outbox with one of these
 * topics and a payload validated by its schema. Modules communicate only through these
 * (dependency-cruiser forbids importing each other's tables), so the catalogue is the
 * contract: adding a topic here is an API change and gets a changeset.
 *
 * Payloads never carry PII (no emails, names, document titles): ids only. Audit and
 * analytics subscribe and enrich from their own tables. `schemaVersion` bumps when a
 * payload changes shape; `payload_schema_version` on the outbox row records which one a
 * stored event used, and `parseEventPayload` refuses versions it cannot read.
 */
const uuid = z.uuid();

export interface EventDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly schemaVersion: number;
  readonly payload: TSchema;
  /** Human summary for the catalogue docs and the admin jobs page. */
  readonly description: string;
}

function event<TSchema extends z.ZodType>(
  description: string,
  payload: TSchema,
  schemaVersion = 1,
): EventDefinition<TSchema> {
  return { description, payload, schemaVersion };
}

export const EVENT_CATALOGUE = {
  "workspace.created": event(
    "A workspace was created (setup wizard or host admin).",
    z.object({ workspaceId: uuid, slug: z.string().min(1) }).strict(),
  ),
  "workspace.offering_status_changed": event(
    "The versioned offering status changed.",
    z
      .object({
        workspaceId: uuid,
        from: z.string().min(1),
        to: z.string().min(1),
        byMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "legal.document_published": event(
    "A new version of a tenant legal document was published. Members holding an older " +
      "acceptance of a `requiresAcceptance` document must accept again.",
    z
      .object({
        documentId: uuid,
        slug: z.string().min(1),
        kind: z.string().min(1),
        versionNo: z.number().int().min(1),
        requiresAcceptance: z.boolean(),
        byMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "legal.accepted": event(
    "A member accepted a version of a legal document (click-wrap).",
    z
      .object({
        documentId: uuid,
        slug: z.string().min(1),
        versionNo: z.number().int().min(1),
        membershipId: uuid,
      })
      .strict(),
  ),
  "consent.changed": event(
    "A member granted or withdrew consent for an optional purpose (R13). Ids only: the answer " +
      "itself is the fact, never who was asked or from where.",
    z
      .object({
        membershipId: uuid,
        purpose: z.string().min(1),
        granted: z.boolean(),
        source: z.string().min(1),
      })
      .strict(),
  ),
  "user.created": event(
    "A global user was created on first verified login. Host-level (no workspace).",
    z.object({ userId: uuid, method: z.string().min(1) }).strict(),
  ),
  "membership.created": event(
    "A membership became active in a workspace (invite accepted, SSO auto-join, host).",
    z
      .object({
        membershipId: uuid,
        userId: uuid,
        kind: z.enum(["staff", "external"]),
        role: z.string().min(1),
        source: z.string().min(1),
        inviteId: uuid.nullable(),
      })
      .strict(),
  ),
  "membership.revoked": event(
    "Memberships were revoked; subscribers purge caches, renditions, access.",
    z
      .object({
        membershipIds: z.array(uuid).min(1),
        byMembershipId: uuid.nullable(),
        reason: z.string().nullable(),
      })
      .strict(),
  ),
  "invite.created": event(
    "An invitation was issued.",
    z
      .object({
        inviteId: uuid,
        kind: z.enum(["staff", "external"]),
        role: z.string().min(1),
        byMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "access_request.submitted": event(
    "A public access request was verified and entered the approval queue. Ids only: the " +
      "requester's name and address stay on `core.access_request`.",
    z.object({ accessRequestId: uuid }).strict(),
  ),
  "access_request.decided": event(
    "An access request was approved (an invite was issued) or denied. `auto` is true for " +
      "an approval the workspace's auto-approve domains made without a person.",
    z
      .object({
        accessRequestId: uuid,
        decision: z.enum(["approved", "denied"]),
        auto: z.boolean(),
      })
      .strict(),
  ),
  "access_review.overdue": event(
    "The periodic access review is overdue: `dueAt` is the last completed review plus 90 " +
      "days, or the workspace's creation plus 90 days when it was never reviewed " +
      "(`lastReviewId` null). Published at most once per ISO week per workspace.",
    z.object({ dueAt: z.iso.datetime(), lastReviewId: uuid.nullable() }).strict(),
  ),
  "membership.delegate_added": event(
    "A delegate was added for a principal investor: an invitation acting for " +
      "`principalMembershipId` with `scope` was issued, by the principal (`self`) or by staff. " +
      "The principal and staff holding access.manage are told.",
    z
      .object({
        principalMembershipId: uuid,
        inviteId: uuid,
        scope: z.enum(["all", "data_room", "updates"]),
        byMembershipId: uuid,
        by: z.enum(["self", "staff"]),
      })
      .strict(),
  ),
  "session.revoked": event(
    "Sessions were revoked (sign-out, revocation cascade, suspicious login). Host-level.",
    z
      .object({
        userId: uuid,
        count: z.number().int().nonnegative(),
        reason: z.string().min(1),
        workspaceId: uuid.nullable(),
      })
      .strict(),
  ),
  "acl.changed": event(
    "Grants, groups, policies, memberships or a folder tree changed; effective_access must be rebuilt.",
    z
      .object({
        aclVersion: z.number().int().nonnegative(),
        /** What moved: `grant`, `group`, `policy`, `membership`, `attestation`, `folder`, `settings`. */
        cause: z.string().min(1),
      })
      .strict(),
  ),
  "membership.role_changed": event(
    "A staff member's role changed (RBAC); sessions above the new role's rights are re-evaluated.",
    z
      .object({
        membershipId: uuid,
        from: z.string().min(1),
        to: z.string().min(1),
        byMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "page.published": event(
    "A content page revision was published; notifications and analytics subscribe.",
    z
      .object({
        pageId: uuid,
        revisionId: uuid,
        revisionNo: z.number().int().positive(),
        slug: z.string().min(1),
        byMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "invite_import.finished": event(
    "A CSV invite import job finished (done or failed); the admin UI polls or is notified.",
    z
      .object({
        importId: uuid,
        status: z.enum(["done", "failed"]),
        invited: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  "document.viewed": event(
    "An investor opened a document version (compact audit copy; analytics gets the rich one).",
    z
      .object({
        documentId: uuid,
        versionId: uuid,
        membershipId: uuid,
        sessionId: uuid.nullable(),
      })
      .strict(),
  ),
  "document.downloaded": event(
    "A document version was downloaded (original or watermarked).",
    z
      .object({
        documentId: uuid,
        versionId: uuid,
        membershipId: uuid,
        variant: z.enum(["original", "watermarked"]),
      })
      .strict(),
  ),
  "document.ingested": event(
    "The ingest job finished for a document version: scanned, sanitised and ready, or parked (infected / error).",
    z
      .object({
        documentId: uuid,
        versionId: uuid,
        scanStatus: z.enum(["clean", "infected", "error", "skipped"]),
        renderStatus: z.enum(["ready", "unsupported", "failed"]),
      })
      .strict(),
  ),
  /*
   * Data-room Q&A (E3.3, ADR-0051). Ids only: the question text is an investor's own words and
   * may identify them to other bidders, so it never leaves the `dataroom` schema. `notify`
   * writes generic copy with a link; search entries are written by the data room itself.
   */
  "qa.question_asked": event(
    "An investor asked a data-room question about a document or folder. Staff holding " +
      "`data-room.qa_manage` are alerted.",
    z
      .object({
        questionId: uuid,
        targetKind: z.enum(["document", "folder"]),
        targetId: uuid,
        askerMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "qa.question_assigned": event(
    "A data-room question was assigned to an answerer, or unassigned (`assigneeMembershipId` null). " +
      "`actorMembershipId` is the staff member who assigned it, so notify can skip a self-assignment.",
    z
      .object({
        questionId: uuid,
        assigneeMembershipId: uuid.nullable(),
        actorMembershipId: uuid.nullable().optional(),
      })
      .strict(),
  ),
  "qa.answer_submitted": event(
    "An answer was submitted for approval (only when the workspace requires four-eyes approval). " +
      "`actorMembershipId` is the submitter, whom notify leaves out of the approvers.",
    z.object({ questionId: uuid, actorMembershipId: uuid.nullable().optional() }).strict(),
  ),
  "qa.answer_released": event(
    "An answer was released: to the asker only (`asker`) or published to everyone who can view " +
      "the target (`target`).",
    z
      .object({
        questionId: uuid,
        visibility: z.enum(["asker", "target"]),
        askerMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "qa.question_declined": event(
    "Staff declined a data-room question and chose to tell the asker. Only the asker is told.",
    z.object({ questionId: uuid, askerMembershipId: uuid }).strict(),
  ),
  "qa.question_due": event(
    "An unanswered data-room question is due soon or overdue against the workspace's SLA. " +
      "Published at most once per phase per question by the `data-room.qa-sla` job.",
    z
      .object({
        questionId: uuid,
        phase: z.enum(["due_soon", "overdue"]),
        dueAt: z.iso.datetime(),
        assigneeMembershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "update.published": event(
    "An investor update was published / sent.",
    z.object({ postId: uuid, versionId: uuid, audienceGroupIds: z.array(uuid) }).strict(),
  ),
  "update.sent": event(
    "A send of an investor update finished fanning out (live or test).",
    z
      .object({
        postId: uuid,
        sendId: uuid,
        kind: z.enum(["live", "test"]),
        sent: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  "update.replied": event(
    "A member replied to an investor update in the portal thread (`authorMembershipId` tells staff alerts apart from investor ones).",
    z
      .object({ postId: uuid, replyId: uuid, threadMembershipId: uuid, authorMembershipId: uuid })
      .strict(),
  ),
  "update.viewed": event(
    "A member opened a sent investor update in the web archive.",
    z
      .object({
        postId: uuid,
        versionId: uuid,
        membershipId: uuid,
        sessionId: uuid.nullable(),
      })
      .strict(),
  ),
  "metric.points_changed": event(
    "Metric points were written, imported or restated. The module subscribes to its " +
      "own topic and recomputes every derived definition whose formula reads one of these, in " +
      "dependency order; `wouldCycle` is what makes that cascade terminate.",
    z.object({ definitionIds: z.array(uuid).min(1).max(500) }).strict(),
  ),
  "metric.restated": event(
    "A published metric point was superseded by a later revision: the number an " +
      "investor was shown has changed. The values themselves are deliberately absent — the " +
      "catalogue carries ids, and the old and new figures live on the audit row, which is " +
      "the record an auditor reads and is fenced to the workspace.",
    z
      .object({
        definitionId: uuid,
        /** Lower bound of the point's period, which is what identifies the cell. */
        periodStart: z.iso.datetime(),
        fromRevision: z.number().int().min(1),
        toRevision: z.number().int().min(2),
        sourceKind: z.enum(["manual", "csv", "sheets", "derived", "quickbooks", "xero", "stripe"]),
      })
      .strict(),
  ),
  /*
   * Round, interest and commitments (E2.5). Ids only, and here that rule does real work: an
   * interest submission carries an *amount*, and `crm` subscribes to these to move a pipeline
   * card. Putting the figure on the event would publish the size of a private commitment onto
   * the outbox, where it outlives the row and is read by every subscriber — including ones
   * written later. The amount lives on `round.commitment`, which is fenced to the workspace and
   * has an audit row beside it; a subscriber that needs it reads it there.
   */
  "round.opened": event(
    "A round was opened for interest. At most one round per workspace is open at a time.",
    z.object({ roundId: uuid }).strict(),
  ),
  "round.closed": event(
    "A round was closed. Terms and commitments stay readable as history; nothing is deleted.",
    z.object({ roundId: uuid }).strict(),
  ),
  "round.terms_changed": event(
    "A new terms revision superseded the previous one (E2.5 D3: terms are append-only, like " +
      "metric points). `revision` is what an investor was shown, so a disclosure question can be " +
      "answered against the exact text.",
    z.object({ roundId: uuid, termsId: uuid, revision: z.number().int().min(1) }).strict(),
  ),
  "round.interest_submitted": event(
    "A member indicated interest in the open round. Staff are alerted through `notify`; `crm` " +
      "ensures a contact and a pipeline card.",
    z.object({ submissionId: uuid, roundId: uuid, membershipId: uuid }).strict(),
  ),
  "round.interest_decided": event(
    "Staff accepted or declined an interest submission. An acceptance carries the commitment it " +
      "created, so a subscriber can link the two without reading the round module's tables.",
    z
      .object({
        submissionId: uuid,
        roundId: uuid,
        membershipId: uuid,
        decision: z.enum(["accepted", "declined"]),
        commitmentId: uuid.optional(),
      })
      .strict(),
  ),
  "round.commitment_created": event(
    "A commitment was recorded against a round. The subject is whichever of the four the " +
      "commitment names — a member, a CRM contact, an organisation, or none of them (a " +
      "display-name-only commitment, which carries no id at all).",
    z
      .object({
        commitmentId: uuid,
        roundId: uuid,
        membershipId: uuid.optional(),
        contactId: uuid.optional(),
        organizationId: uuid.optional(),
      })
      .strict(),
  ),
  "round.commitment_changed": event(
    "A commitment moved between soft, verbal, signed, wired and withdrawn. `crm` maps " +
      "the status onto a pipeline stage; the amount is deliberately not here.",
    z
      .object({
        commitmentId: uuid,
        roundId: uuid,
        status: z.enum(["soft", "verbal", "signed", "wired", "withdrawn"]),
      })
      .strict(),
  ),
  "round.verification_requested": event(
    "A 506(c) accreditation verification was opened for a member. Staff are alerted " +
      "through `notify`; the evidence itself never leaves the round module.",
    z.object({ verificationId: uuid, membershipId: uuid, submissionId: uuid.optional() }).strict(),
  ),
  "round.verification_decided": event(
    "An accreditation verification was settled. `verified` means the kernel now holds an " +
      "`accredited` attestation for the member, written through `ModuleServices.legal`.",
    z
      .object({
        verificationId: uuid,
        membershipId: uuid,
        status: z.enum(["pending", "verified", "rejected", "expired"]),
      })
      .strict(),
  ),
  "round.verification_expiring": event(
    "A verified accreditation of a member is nearing its expiry: published once per " +
      "verification, `reverification.reminderDays` before `expires_at`, by the round lifecycle " +
      "job. `notify` reminds the investor.",
    z.object({ verificationId: uuid, membershipId: uuid }).strict(),
  ),
  "round.signature_completed": event(
    "A commitment's subscription agreement was signed through the workspace's e-sign vendor. " +
      "Published by `round` after it mirrored the completed envelope and moved " +
      "the commitment to `signed`; `notify` alerts staff. `membershipId` is the commitment's " +
      "member, when it names one (as on `round.commitment_created`).",
    z
      .object({
        roundId: uuid,
        commitmentId: uuid,
        envelopeId: uuid,
        membershipId: uuid.optional(),
      })
      .strict(),
  ),
  "round.commitment_confirmed": event(
    "Staff confirmed a wired commitment: the money arrived and was reconciled. `notify` " +
      "sends the investor a confirmation when the commitment names a member (`membershipId`).",
    z.object({ roundId: uuid, commitmentId: uuid, membershipId: uuid.optional() }).strict(),
  ),
  "esign.envelope_changed": event(
    "An e-signature envelope changed status: sent, delivered, completed, " +
      "declined, voided, expired or error, as pulled from the vendor (a callback is only a " +
      "wake-up). `subject*` is the soft reference the requesting module gave; modules react to " +
      "their own subjects only. `membershipId` is the signer's membership, when they are a member.",
    z
      .object({
        envelopeId: uuid,
        status: z.enum([
          "draft",
          "sent",
          "delivered",
          "completed",
          "declined",
          "voided",
          "expired",
          "error",
        ]),
        purpose: z.enum(["nda", "round_closing"]),
        subjectModule: z.string().min(1).max(64),
        subjectKind: z.string().min(1).max(64),
        subjectId: uuid,
        membershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "esign.envelope_completed": event(
    "An e-signature envelope was completed AND its signed artifacts were collected, scanned and " +
      "stored by the kernel. `data-room` vaults the signed copy; `round` marks the " +
      "commitment signed. Published once per envelope.",
    z
      .object({
        envelopeId: uuid,
        purpose: z.enum(["nda", "round_closing"]),
        subjectModule: z.string().min(1).max(64),
        subjectKind: z.string().min(1).max(64),
        subjectId: uuid,
        membershipId: uuid.nullable(),
      })
      .strict(),
  ),
  "document.vaulted": event(
    "A signed e-signature artifact was filed into the data room as a legal-hold, staff-only " +
      "document. The kernel `esign` manifest records `vaultedDocumentId` on the envelope; " +
      "`round` links it to the commitment.",
    z.object({ documentId: uuid, versionId: uuid, envelopeId: uuid }).strict(),
  ),
  "accreditation.provider_updated": event(
    "An accreditation vendor sent an authentic callback. It is only a wake-up: " +
      "`refs` are the vendor's provider refs to re-check over the authenticated API (at most 20). " +
      "`round` enqueues a sync for the matching verifications. Not webhook-subscribable.",
    z
      .object({
        connectionId: uuid,
        driver: z.enum(["verifyinvestor", "parallel-markets"]),
        refs: z.array(z.string().min(1).max(200)).max(20),
      })
      .strict(),
  ),
  /*
   * Integrations hub (E3.6, ADR-0054). Ids only: no account labels, invitee emails or names.
   */
  "integration.connection_unhealthy": event(
    "A third-party connection became unhealthy: `reauth_required` after the vendor refused " +
      "its token (and a forced refresh did not help), or `degraded` after 3 consecutive failures. " +
      "Published once per transition. `notify` alerts owners/admins and opted-in channels.",
    z
      .object({
        connectionId: uuid,
        provider: z.enum(["quickbooks", "xero", "stripe", "slack", "calendly", "calcom"]),
        status: z.enum(["degraded", "reauth_required"]),
      })
      .strict(),
  ),
  "integration.connection_changed": event(
    "A third-party connection was connected (or replaced) or disconnected.",
    z
      .object({
        connectionId: uuid,
        provider: z.enum(["quickbooks", "xero", "stripe", "slack", "calendly", "calcom"]),
        change: z.enum(["connected", "disconnected"]),
      })
      .strict(),
  ),
  "integration.booking_recorded": event(
    "A verified booking webhook (Calendly / Cal.com) recorded or updated a meeting. `crm` " +
      "reads it through `ModuleServices.integrations.booking` and logs contact activity.",
    z
      .object({
        bookingId: uuid,
        provider: z.enum(["calendly", "calcom"]),
        status: z.enum(["booked", "cancelled", "rescheduled"]),
      })
      .strict(),
  ),
  "notification.created": event(
    "A notification row was written for a staff member; the deliver job sends instant ones.",
    z.object({ notificationId: uuid, membershipId: uuid, type: z.string().min(1) }).strict(),
  ),
  "mail.delivery_recorded": event(
    "An ESP webhook reported a delivery, bounce, complaint, delay, open or click for a message this workspace sent. `messageRef` is the `core.mail_message` id; `ref*` echo `OutboundEmail.ref`. `automated` is true for Apple MPP prefetches and link scanners; open/click events are published only when the member's `email_tracking` consent allowed them at ingest.",
    z
      .object({
        messageRef: uuid,
        /** The provider's message id (`SentEmail.messageId`), for modules that stored it at send time. */
        providerMessageId: z.string().min(1).max(300),
        kind: z.enum(["delivered", "bounce", "complaint", "delay", "open", "click"]),
        bounceType: z.enum(["hard", "soft"]).nullable(),
        automated: z.boolean(),
        refKind: z.string().min(1).max(64).nullable(),
        refId: uuid.nullable(),
        membershipId: uuid.nullable(),
        /** `click` only: origin + path of the followed link, query and fragment stripped. */
        link: z.string().max(500).nullable(),
        occurredAt: z.iso.datetime(),
      })
      .strict(),
  ),
  "member.erasure_requested": event(
    "A DSAR erasure was requested for a member. Every module holding personal data about them erases or pseudonymises its own rows and reports through `ModuleServices.legal.completeErasureStep`.",
    z.object({ requestId: uuid, membershipId: uuid }).strict(),
  ),
  "analytics.hot_lead": event(
    "A member's engagement score crossed the workspace's hot-lead threshold. Fired at most once per member per scoring window.",
    z.object({ membershipId: uuid, score: z.number().int().min(0) }).strict(),
  ),
  "audit.recorded": event(
    "An audit row was written; the sink fan-out subscriber delivers it to external sinks.",
    z.object({ eventId: uuid, seq: z.number().int().positive() }).strict(),
  ),
} as const satisfies Record<string, EventDefinition>;

export type EventCatalogue = typeof EVENT_CATALOGUE;
export type EventTopic = keyof EventCatalogue & string;
export type EventPayload<T extends EventTopic> = z.output<EventCatalogue[T]["payload"]>;

export const EVENT_TOPICS = Object.keys(EVENT_CATALOGUE) as readonly EventTopic[];
export const EVENT_TOPIC_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

export function isEventTopic(topic: string): topic is EventTopic {
  return Object.hasOwn(EVENT_CATALOGUE, topic);
}

/** A validated event ready for the outbox. */
export interface DomainEvent<T extends EventTopic = EventTopic> {
  readonly topic: T;
  readonly payload: EventPayload<T>;
  readonly schemaVersion: number;
}

export class EventCatalogueError extends Error {
  override readonly name = "EventCatalogueError";
  constructor(
    readonly topic: string,
    message: string,
    readonly issues?: readonly z.core.$ZodIssue[],
  ) {
    super(`${topic}: ${message}`);
  }
}

/** Validates a payload against the catalogue and stamps the current schema version. */
export function defineEvent<T extends EventTopic>(
  topic: T,
  payload: EventPayload<T>,
): DomainEvent<T> {
  if (!isEventTopic(topic)) throw new EventCatalogueError(topic, "unknown topic");
  const def = EVENT_CATALOGUE[topic];
  const r = def.payload.safeParse(payload);
  if (!r.success) throw new EventCatalogueError(topic, "invalid payload", r.error.issues);
  return { topic, payload: r.data as EventPayload<T>, schemaVersion: def.schemaVersion };
}

/**
 * Parses a stored payload. Only the current schema version is readable today; when a
 * payload changes shape, add an upcaster here rather than editing stored rows.
 */
export function parseEventPayload<T extends EventTopic>(
  topic: T,
  payload: unknown,
  schemaVersion: number,
): EventPayload<T> {
  if (!isEventTopic(topic)) throw new EventCatalogueError(topic, "unknown topic");
  const def = EVENT_CATALOGUE[topic];
  if (schemaVersion !== def.schemaVersion) {
    throw new EventCatalogueError(
      topic,
      `payload schema version ${schemaVersion} is not readable (current ${def.schemaVersion})`,
    );
  }
  const r = def.payload.safeParse(payload);
  if (!r.success) throw new EventCatalogueError(topic, "invalid stored payload", r.error.issues);
  return r.data as EventPayload<T>;
}
