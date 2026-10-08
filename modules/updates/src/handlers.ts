import type { TenantContext } from "@fundroom/db";
import type { EventTopic } from "@fundroom/domain";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { RecipientRepo, ReplyRepo, SendRepo, UnsubscribeRepo } from "./repos/updates-repo.js";
import {
  bounceError,
  isDeliveryFact,
  nextRecipientStatus,
  notesSoftBounce,
} from "./service/feedback.js";

/*
 * Outbox subscribers (E2.6). Two topics, both published by the kernel:
 *
 *  - `mail.delivery_recorded` — an ESP webhook said something about a message; when the
 *    message was an update (`refKind: "post"`) the recipient row it names moves up the
 *    feedback ladder (`service/feedback.ts`) and the send's counters follow.
 *  - `member.erasure_requested` — a DSAR erasure: this module pseudonymises the member's
 *    recipient addresses and erases their reply threads, then reports to the kernel.
 *
 * Both run inside the dispatcher's per-workspace system transaction, and a throw means the job
 * is retried, so both are idempotent: the ladder never moves a row twice to the same rung, and
 * the erasure only touches rows it has not already erased. Both ignore host-level events;
 * delivery feedback is also a no-op where the module is switched off, erasure never is.
 */

/** Narrows the manifest's untyped handler to one topic (the dispatcher routes per topic). */
function typed<T extends EventTopic>(topic: T, handler: EventHandler<T>): EventHandler {
  return async (event, context) => {
    if (event.topic !== topic) throw new Error(`updates: ${topic} handler got ${event.topic}`);
    await handler(event as unknown as EventEnvelope<T>, context);
  };
}

export function createUpdatesHandlers(
  live: () => ModuleServices,
): Partial<Record<EventTopic, EventHandler>> {
  const enter = async (
    ctx: Parameters<EventHandler>[1]["ctx"],
    tx: Parameters<EventHandler>[1]["tx"],
  ): Promise<{ services: ModuleServices; tenant: TenantContext } | undefined> => {
    if (ctx.actorKind === "host") return undefined;
    const services = live();
    const tenant = ctx as TenantContext;
    const view = await services.enablement.get(services.db, tenant, tx);
    if (!view.enabled.has("updates")) return undefined;
    return { services, tenant };
  };

  const onDeliveryRecorded: EventHandler = typed(
    "mail.delivery_recorded",
    async (event, { tx, ctx }) => {
      const p = event.payload;
      // Cheap refusals first: not an update, or not a delivery fact (opens/clicks are analytics').
      if (p.refKind !== "post" || !isDeliveryFact(p.kind)) return;
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      /*
       * A fact about a member whose erasure has been requested is dropped: a late webhook must
       * not write news about them back onto rows the erasure pseudonymised.
       */
      if (p.membershipId !== null && (await services.legal.isErased(tx, tenant, p.membershipId)))
        return;
      const recipients = new RecipientRepo(tenant, tx);
      const sends = new SendRepo(tenant, tx);
      const at = new Date(p.occurredAt);
      for (const row of await recipients.lockByMessageId(p.providerMessageId)) {
        if (
          row.membershipId !== null &&
          row.membershipId !== p.membershipId &&
          (await services.legal.isErased(tx, tenant, row.membershipId))
        )
          continue;
        const from = row.status;
        const next = nextRecipientStatus(from, p.kind, p.bounceType);
        if (next === undefined) {
          // Nothing to move. A delay (or a stale repeat) still says when we last heard; a soft
          // bounce also says why, without making the row look undeliverable.
          if (p.kind === "delay") await recipients.applyFeedback(row.id, {}, at);
          else if (notesSoftBounce(from, p.kind, p.bounceType))
            await recipients.applyFeedback(row.id, { error: bounceError(p.bounceType) }, at);
          continue;
        }
        await recipients.applyFeedback(
          row.id,
          {
            status: next,
            ...(next === "bounced" ? { error: bounceError(p.bounceType) } : {}),
            ...(next === "complained" ? { error: "complaint" } : {}),
          },
          at,
        );
        await sends.shiftFeedback(row.sendId, from, next);
      }
    },
  );

  const onErasureRequested: EventHandler = typed(
    "member.erasure_requested",
    async (event, { tx, ctx }) => {
      /*
       * **Not gated on enablement** (contract decision 5, amended). A DSAR has to reach rows this
       * module wrote while it was enabled even if the workspace has switched it off since, and
       * the kernel waits for a step from every compiled-in module that handles this topic — so
       * a disabled workspace still erases whatever exists and still reports (zeros are fine).
       * A host context cannot carry this workspace-scoped topic; the guard is defensive.
       */
      if (ctx.actorKind === "host") return;
      const services = live();
      const tenant = ctx as TenantContext;
      const { requestId, membershipId } = event.payload;
      /*
       * The `updates.unsubscribe` row itself stays: an opt-out has to survive the erasure of the
       * person who gave it, or the next send would mail them again. What it keeps is the
       * refusal, not the person — the send path looks opt-outs up by membership id only
       * (`UnsubscribeRepo.membershipIds`), so the stored address is replaced by a pseudonym and
       * the opt-out stays exactly as effective. Sends and their counts stay too — they are the
       * workspace's record of what it sent, and after this they say "to somebody".
       */
      const recipients = await new RecipientRepo(tenant, tx).pseudonymiseMember(membershipId);
      const replies = await new ReplyRepo(tenant, tx).eraseMember(membershipId);
      const unsubscribes = await new UnsubscribeRepo(tenant, tx).pseudonymiseMember(membershipId);
      await services.legal.completeErasureStep(tx, tenant, requestId, "updates", {
        recipients,
        replies,
        unsubscribes,
      });
    },
  );

  return {
    "mail.delivery_recorded": onDeliveryRecorded,
    "member.erasure_requested": onErasureRequested,
  };
}
