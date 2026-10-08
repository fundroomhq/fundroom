import type { TenantContext } from "@fundroom/db";
import type { EventPayload, EventTopic } from "@fundroom/domain";
import type { EventEnvelope, EventHandler, SubscriberContext } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { liveServices } from "./live.js";
import { isUnscoredLink, sessionKeyOf, syntheticSessionKey } from "./privacy.js";
import {
  EventRepo,
  type NewEvent,
  readAnalyticsSettings,
  ViewSessionRepo,
} from "./repos/analytics-repo.js";

/*
 * Outbox subscribers (`analytics.document_viewed`, `analytics.document_downloaded`,
 * `analytics.update_viewed`). They run inside the dispatcher's `system` tenant transaction
 * with only `tx`/`ctx` (no ModuleServices needed): read the workspace's analytics mode, and
 * unless it is `off`, upsert the view session (sha256 of the session id, or a synthetic
 * per-member-day key when the fact arrived without one) and insert the event. Idempotent
 * under job retries: the repo dedupes on (session, type, resource, version) within 60 s and
 * on the outbox row id. A fact about a member with an erasure request (`legal.isErased`) is
 * dropped: an event already in flight when the DSAR ran must not write the member back.
 */
type Payload<T extends EventTopic> = EventPayload<T>;

interface Fact {
  readonly membershipId: string;
  readonly sessionId: string | null;
  readonly event: Omit<NewEvent, "viewSessionId" | "membershipId" | "outboxId">;
}

async function record(fact: Fact, { tx, ctx, job }: SubscriberContext, at: Date): Promise<void> {
  if (ctx.actorKind === "host") return;
  const tenant = ctx as TenantContext;
  const settings = await readAnalyticsSettings(tx, tenant.workspaceId);
  if (settings.mode === "off") return;
  if (await liveServices().legal.isErased(tx, tenant, fact.membershipId)) return;
  const sessionKey =
    fact.sessionId === null
      ? syntheticSessionKey(fact.membershipId, at)
      : sessionKeyOf(fact.sessionId);
  const viewSessionId = await new ViewSessionRepo(tenant, tx).upsert({
    membershipId: fact.membershipId,
    sessionKey,
  });
  const outboxId = Number.parseInt(String((job.data as { outboxId?: unknown }).outboxId ?? ""), 10);
  await new EventRepo(tenant, tx).insertDeduped({
    ...fact.event,
    viewSessionId,
    membershipId: fact.membershipId,
    // The fact's own time, not the delivery's: a retried or delayed outbox row keeps its place.
    occurredAt: at,
    ...(Number.isFinite(outboxId) ? { outboxId } : {}),
  });
}

export const onDocumentViewed: EventHandler = async (event, sc) => {
  const p = event.payload as Payload<"document.viewed">;
  await record(
    {
      membershipId: p.membershipId,
      sessionId: p.sessionId,
      event: {
        type: "document_viewed",
        resourceKind: "document",
        resourceId: p.documentId,
        versionId: p.versionId,
      },
    },
    sc,
    event.createdAt,
  );
};

export const onDocumentDownloaded: EventHandler = async (event, sc) => {
  const p = event.payload as Payload<"document.downloaded">;
  await record(
    {
      membershipId: p.membershipId,
      sessionId: null,
      event: {
        type: "document_downloaded",
        resourceKind: "document",
        resourceId: p.documentId,
        versionId: p.versionId,
        props: { variant: p.variant },
      },
    },
    sc,
    event.createdAt,
  );
};

export const onUpdateViewed: EventHandler = async (event, sc) => {
  const p = event.payload as Payload<"update.viewed">;
  await record(
    {
      membershipId: p.membershipId,
      sessionId: p.sessionId,
      event: {
        type: "update_viewed",
        resourceKind: "post",
        resourceId: p.postId,
        versionId: p.versionId,
      },
    },
    sc,
    event.createdAt,
  );
};

/*
 * `analytics.mail_delivery_recorded` (E2.6): an email open or click on an update becomes an
 * `email_opened` / `email_clicked` event on that post. Everything else the kernel reports
 * (delivered, bounce, complaint, delay) belongs to the updates module and is ignored here, as
 * is anything not tied to a post and a member.
 *
 * The gate is checked again here, although the kernel's webhook ingress already checked it:
 * the outbox may deliver minutes later, and a workspace that left `engagement` or a member who
 * withdrew `email_tracking` consent in between must not be recorded. MPP/scanner opens are
 * stored with `automated: true` — the per-post route reports them separately and the hot list
 * never scores them — rather than dropped, so "why does the ESP say 40 opens and we say 12"
 * has an answer.
 *
 * Also dropped (E2.6): anything about an erased member (`legal.isErased` — a late ESP open must
 * not undo a DSAR), and clicks on the workspace's `/unsubscribe` page or any `/api/` path, which
 * are the mechanics of the email, not engagement with it (the kernel drops them too).
 */
export function createMailDeliveryHandler(services: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const tenant = ctx as TenantContext;
    const p = event.payload as Payload<"mail.delivery_recorded">;
    if (p.kind !== "open" && p.kind !== "click") return;
    if (p.refKind !== "post" || p.refId === null || p.membershipId === null) return;
    if (p.kind === "click" && isUnscoredLink(p.link)) return;
    const settings = await readAnalyticsSettings(tx, tenant.workspaceId);
    if (settings.mode !== "engagement") return;
    if (await services().legal.isErased(tx, tenant, p.membershipId)) return;
    const allowed = await services().legal.allowsPurpose(
      tx,
      tenant,
      p.membershipId,
      "email_tracking",
    );
    if (!allowed) return;
    const at = new Date(p.occurredAt);
    await new EventRepo(tenant, tx).insertEmail({
      membershipId: p.membershipId,
      type: p.kind === "open" ? "email_opened" : "email_clicked",
      resourceId: p.refId,
      messageRef: p.messageRef,
      automated: p.automated,
      link: p.kind === "click" ? p.link : null,
      occurredAt: Number.isNaN(at.getTime()) ? event.createdAt : at,
      receivedAt: event.createdAt,
    });
  };
}

export type { EventEnvelope };
