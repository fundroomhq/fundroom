import type { TenantContext, Tx } from "@fundroom/db";
import type { EventTopic } from "@fundroom/domain";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import {
  ACTIVITY_FOR_BOOKING_STATUS,
  STAGE_FOR_COMMITMENT_STATUS,
  STAGE_ON_COMMITMENT,
  STAGE_ON_DECLINED,
  STAGE_ON_INTEREST,
  type TransitionCause,
} from "./model.js";
import {
  ActivityRepo,
  ContactRepo,
  type ContactRow,
  ErasureRepo,
  OrganizationRepo,
  type PipelineItemRow,
  PipelineRepo,
  type StageRow,
  TransitionRepo,
} from "./repos/crm-repo.js";
import { moveItem } from "./service/pipeline.js";
import { stagesByKey } from "./service/stages.js";

/*
 * Outbox subscribers (E2.5 §C). The round module announces what happened; this module keeps the
 * board in step. It is the whole of the coupling between the two, and it is deliberately
 * one-way and id-only: `crm` does not `dependsOn: ["round"]`, does not import it, and never
 * reads `round.*` — a workspace can run the CRM in `informational` mode, with no round module
 * enabled at all, and these handlers simply never fire.
 *
 * Every handler runs inside the dispatcher's per-workspace system transaction, and a throw
 * means pg-boss retries. Three properties therefore have to hold, and each is load-bearing:
 *
 *  - **Idempotent.** Redelivery is normal, not exceptional. The contact is upserted on
 *    `membership_id` (a partial unique index backs it), the card is upserted on
 *    `(round_id, contact_id)` (another one does), and `moveItem` writes nothing at all when the
 *    card is already in the target stage — so a replayed event produces no second history row.
 *  - **Tolerant of a disabled module.** A workspace that never switched the CRM on must not
 *    acquire CRM rows because somebody indicated interest. `services.enablement` is the
 *    authority and the answer is cached per workspace, so this costs nothing in the steady
 *    state.
 *  - **Tolerant of a missing stage.** A tenant may rename and reorder the ladder freely. If the
 *    key a mapping wants is gone, the handler does nothing rather than throwing: a retry loop
 *    on an event that can never succeed would be worse than a card that stays put. `wired` and
 *    `passed` are the two the stage editor refuses to delete for exactly this reason.
 */

/** Narrows the manifest's untyped handler to one topic (the dispatcher routes per topic). */
function typed<T extends EventTopic>(topic: T, handler: EventHandler<T>): EventHandler {
  return async (event, context) => {
    if (event.topic !== topic) throw new Error(`crm: ${topic} handler got ${event.topic}`);
    await handler(event as unknown as EventEnvelope<T>, context);
  };
}

/** Whether this workspace has the CRM switched on. */
async function crmEnabled(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Parameters<EventHandler>[1]["tx"],
): Promise<boolean> {
  const view = await services.enablement.get(services.db, ctx, tx);
  return view.enabled.has("crm");
}

/**
 * The contact for a member, created on first sight.
 *
 * The display name and email come from `MembershipRepo.person` — the sanctioned seam onto
 * `core.*` (principle 2) — and are the CRM's own copy from then on: staff may correct a name
 * here without touching identity, and a later event never overwrites what they typed.
 *
 * `undefined` when the membership has gone (revoked and purged between the event and its
 * delivery). That is a no-op, not an error: there is nobody left to make a card about.
 */
async function ensureContact(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  cause: "round_event" | "booking" = "round_event",
): Promise<ContactRow | undefined> {
  const contacts = new ContactRepo(ctx, tx);
  const existing = await contacts.findByMembership(membershipId);
  if (existing !== undefined) return existing;
  const person = await new MembershipRepo(ctx, tx).person(membershipId);
  if (person === undefined) return undefined;
  const displayName = person.displayName.trim();
  /*
   * A unique violation here is deliberately **not** caught, and that is the opposite of what it
   * looks like. Postgres aborts the whole transaction on a constraint failure, so a `catch` that
   * carried on would simply fail again on the next statement with `25P02`; the only thing that
   * can recover is a fresh transaction. Letting it throw is precisely that — the dispatcher
   * retries the job, and the second attempt finds the row the first one raced with. Two
   * deliveries landing in the same millisecond is the only way to reach this at all.
   */
  const created = await contacts.insert({
    membershipId,
    displayName: displayName === "" ? (person.email ?? "Investor") : displayName,
    email: person.email,
  });
  await services.audit.record(tx, ctx, {
    action: "crm.contact_created",
    resourceKind: "crm_contact",
    resourceId: created.id,
    subjectMembershipId: membershipId,
    // Never the name and never the email: the row holds both, the audit trail does not (§C).
    meta: { linked: true, cause },
  });
  return created;
}

/** Creates a card and its opening history row. */
async function createCard(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  input: {
    readonly roundId: string;
    readonly contactId: string | null;
    readonly organizationId: string | null;
    readonly stage: StageRow;
    readonly commitmentId?: string | undefined;
    readonly cause: TransitionCause;
  },
): Promise<PipelineItemRow> {
  const items = new PipelineRepo(ctx, tx);
  // Same reasoning as `ensureContact`: the `(round_id, contact_id)` index is what makes this
  // idempotent, and a violation is recovered by retrying the job rather than by swallowing it.
  const created = await items.insert({
    roundId: input.roundId,
    contactId: input.contactId,
    organizationId: input.organizationId,
    stageId: input.stage.id,
    ...(input.commitmentId === undefined ? {} : { commitmentId: input.commitmentId }),
    position: await items.nextPosition(input.stage.id),
  });
  await new TransitionRepo(ctx, tx).insert({
    pipelineItemId: created.id,
    toStageId: input.stage.id,
    toStageKey: input.stage.key,
    cause: input.cause,
  });
  await services.audit.record(tx, ctx, {
    action: "crm.pipeline_item_created",
    resourceKind: "crm_pipeline_item",
    resourceId: created.id,
    meta: {
      to: input.stage.key,
      roundId: input.roundId,
      cause: input.cause,
      ...(input.contactId === null ? {} : { contactId: input.contactId }),
      ...(input.organizationId === null ? {} : { organizationId: input.organizationId }),
    },
  });
  return created;
}

export function createCrmHandlers(
  live: () => ModuleServices,
): Partial<Record<EventTopic, EventHandler>> {
  /** Shared preamble: host events and workspaces without the CRM are not ours. */
  const enter = async (
    ctx: Parameters<EventHandler>[1]["ctx"],
    tx: Parameters<EventHandler>[1]["tx"],
  ): Promise<{ services: ModuleServices; tenant: TenantContext } | undefined> => {
    if (ctx.actorKind === "host") return undefined;
    const services = live();
    const tenant = ctx as TenantContext;
    if (!(await crmEnabled(services, tenant, tx))) return undefined;
    return { services, tenant };
  };

  /**
   * Whether an event is about a member whose erasure has been requested (E2.6). Such an event
   * was emitted before the request and dispatched after it; acting on it would re-create the
   * contact the erasure just pseudonymised, so it is dropped.
   */
  const aboutErased = (
    services: ModuleServices,
    tenant: TenantContext,
    tx: Tx,
    membershipId: string | undefined,
  ): Promise<boolean> =>
    membershipId === undefined
      ? Promise.resolve(false)
      : services.legal.isErased(tx, tenant, membershipId);

  /**
   * A member indicated interest: make sure they have a contact and a card on that round.
   *
   * The card lands in `contacted` and is **not** moved if it already exists. A workspace that
   * had already dragged this investor to `diligence` would not thank us for pulling them back
   * to `contacted` because they filled the form in a second time.
   */
  const onInterestSubmitted: EventHandler = typed(
    "round.interest_submitted",
    async (event, { tx, ctx }) => {
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      const { roundId, membershipId } = event.payload;
      if (await aboutErased(services, tenant, tx, membershipId)) return;
      const contact = await ensureContact(services, tenant, tx, membershipId);
      if (contact === undefined) return;
      const existing = await new PipelineRepo(tenant, tx).findForRoundContact(roundId, contact.id);
      if (existing !== undefined) return;
      const stage = (await stagesByKey(tenant, tx)).get(STAGE_ON_INTEREST);
      if (stage === undefined) return;
      await createCard(services, tenant, tx, {
        roundId,
        contactId: contact.id,
        organizationId: null,
        stage,
        cause: "interest_submitted",
      });
    },
  );

  /**
   * A commitment was recorded: link it to a card and move that card to `soft_committed`.
   *
   * The subject is whichever of the four the commitment names. A `contactId` or an
   * `organizationId` on the event is a *crm* id — the round module keeps them as soft
   * references — so both are checked against this workspace before they are believed; a
   * commitment that names none of the three (a display-name-only row) has nothing to hang a
   * card on and is skipped.
   */
  const onCommitmentCreated: EventHandler = typed(
    "round.commitment_created",
    async (event, { tx, ctx }) => {
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      const p = event.payload;
      const items = new PipelineRepo(tenant, tx);

      let contactId: string | null = null;
      // An erased member gets no contact (and no card of their own); an organisation named by
      // the same commitment still gets its card — that is the workspace's, not the person's.
      if (p.membershipId !== undefined) {
        if (!(await aboutErased(services, tenant, tx, p.membershipId)))
          contactId = (await ensureContact(services, tenant, tx, p.membershipId))?.id ?? null;
      } else if (p.contactId !== undefined) {
        contactId = (await new ContactRepo(tenant, tx).find(p.contactId))?.id ?? null;
      }
      let organizationId: string | null = null;
      if (p.organizationId !== undefined) {
        organizationId =
          (await new OrganizationRepo(tenant, tx).find(p.organizationId))?.id ?? null;
      }
      if (contactId === null && organizationId === null) return;

      const stages = await stagesByKey(tenant, tx);
      const stage = stages.get(STAGE_ON_COMMITMENT);
      if (stage === undefined) return;

      const existing =
        (await items.findByCommitment(p.commitmentId)) ??
        (contactId === null ? undefined : await items.findForRoundContact(p.roundId, contactId));
      if (existing === undefined) {
        await createCard(services, tenant, tx, {
          roundId: p.roundId,
          contactId,
          organizationId,
          stage,
          commitmentId: p.commitmentId,
          cause: "commitment_created",
        });
        return;
      }
      const linked =
        existing.commitmentId === p.commitmentId
          ? existing
          : ((await items.update(existing.id, { commitmentId: p.commitmentId })) ?? existing);
      const from = [...stages.values()].find((s) => s.id === linked.stageId) ?? null;
      await moveItem(services, tenant, tx, {
        item: linked,
        from,
        to: stage,
        cause: "commitment_created",
      });
    },
  );

  /** The commitment moved between soft, verbal, signed, wired and withdrawn: so does the card. */
  const onCommitmentChanged: EventHandler = typed(
    "round.commitment_changed",
    async (event, { tx, ctx }) => {
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      const p = event.payload;
      const item = await new PipelineRepo(tenant, tx).findByCommitment(p.commitmentId);
      if (item === undefined) return;
      const key = STAGE_FOR_COMMITMENT_STATUS[p.status];
      if (key === undefined) return;
      const stages = await stagesByKey(tenant, tx);
      const to = stages.get(key);
      if (to === undefined) return;
      const from = [...stages.values()].find((s) => s.id === item.stageId) ?? null;
      await moveItem(services, tenant, tx, { item, from, to, cause: "commitment_changed" });
    },
  );

  /**
   * Staff declined an interest submission: the card goes to `passed`.
   *
   * An *acceptance* is deliberately not handled here. It produces a commitment, and
   * `round.commitment_created` is what moves the card — handling both would move it twice and
   * write two history rows for one decision.
   */
  const onInterestDecided: EventHandler = typed(
    "round.interest_decided",
    async (event, { tx, ctx }) => {
      const p = event.payload;
      if (p.decision !== "declined") return;
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      if (await aboutErased(services, tenant, tx, p.membershipId)) return;
      const contact = await new ContactRepo(tenant, tx).findByMembership(p.membershipId);
      if (contact === undefined) return;
      const item = await new PipelineRepo(tenant, tx).findForRoundContact(p.roundId, contact.id);
      if (item === undefined) return;
      const stages = await stagesByKey(tenant, tx);
      const to = stages.get(STAGE_ON_DECLINED);
      if (to === undefined) return;
      const from = [...stages.values()].find((s) => s.id === item.stageId) ?? null;
      await moveItem(services, tenant, tx, { item, from, to, cause: "interest_decided" });
    },
  );

  /**
   * A DSAR erasure (E2.6 decision 5, amended): the member's contacts — linked by membership, or
   * unlinked but carrying the member's email — are pseudonymised and detached, and
   * everything staff wrote about them is deleted (`ErasureRepo`). The cards and their stage
   * history stay — they are the workspace's record of its raise — and now name "Erased
   * contact". Then the step is reported to the kernel, which closes the request once every
   * expected module has.
   *
   * One audit row per contact, carrying the membership id and the request id but, as
   * everywhere in this module, never a name or an address (§C).
   */
  const onErasureRequested: EventHandler = typed(
    "member.erasure_requested",
    async (event, { tx, ctx }) => {
      /*
       * **Not gated on enablement** — the one handler here that is not (contract decision 5,
       * amended). The CRM is off by default and switched off freely, and a DSAR must still
       * reach the contacts it holds from when it was on; the kernel also waits for a `crm` step
       * from every workspace, so a disabled one erases whatever exists and reports (zeros are
       * fine). A host context cannot carry this workspace-scoped topic; the guard is defensive.
       */
      if (ctx.actorKind === "host") return;
      const services = live();
      const tenant = ctx as TenantContext;
      const { requestId, membershipId } = event.payload;
      const repo = new ErasureRepo(tenant, tx);
      /*
       * The address is still readable here: the kernel erases the identity (E2.7, the
       * `core.identity` step) only after *every* expected module — this one included — has
       * reported, in the transaction of the last report. So whichever order the modules run in,
       * this read happens before the identity step scrubs the profile and pseudonymises the email.
       */
      const person = await new MembershipRepo(tenant, tx).person(membershipId);
      const contactIds = await repo.contactIdsFor(membershipId, person?.email ?? null);
      const counts = await repo.eraseContacts(contactIds);
      for (const contactId of contactIds) {
        await services.audit.record(tx, tenant, {
          action: "crm.contact_erased",
          resourceKind: "crm_contact",
          resourceId: contactId,
          subjectMembershipId: membershipId,
          meta: { requestId, notes: counts.notes, tasks: counts.tasks },
        });
      }
      await services.legal.completeErasureStep(tx, tenant, requestId, "crm", { ...counts });
    },
  );

  /**
   * A verified booking webhook recorded or updated a meeting (E3.6, ADR-0054): log it on the
   * contact it is about.
   *
   * The event carries ids and the status only; the meeting itself is read through
   * `services.integrations.booking` on this transaction (the kernel's register, never a second
   * pool connection). The **event's** status names the activity, not the booking's current one:
   * a `booked` event dispatched after the meeting was already cancelled still records that it
   * was booked, and the `cancelled` event then records the cancellation — one row per
   * (booking, kind), however often either is delivered.
   *
   * Who it is about:
   *  - a live member (the kernel matched the invitee's address at ingest): their contact,
   *    created on first sight exactly as a round event would;
   *  - anybody else: the contact staff already hold for that address, if any. **Never a new
   *    contact for a stranger** — a booking link is public, and a CRM that filled itself with
   *    whoever clicked it would be a scraping target, not a record of relationships.
   *
   * Erasure (the race that matters): the member's membership row — and, for an address match,
   * the contact row — is locked before `isErased` is asked. A DSAR erasure request locks the
   * membership first (`prelockErasureSubject`) and the CRM erasure step locks the contacts
   * `FOR UPDATE`, so either this transaction commits first and the erasure then removes what it
   * wrote (`ErasureRepo.eraseContacts` deletes activities), or it waits and sees the request
   * (`isErased` → drop) or the pseudonymised contact (no address → no match). Without the locks
   * an in-flight booking could re-create the contact an erasure just pseudonymised.
   */
  const onBookingRecorded: EventHandler = typed(
    "integration.booking_recorded",
    async (event, { tx, ctx }) => {
      const entered = await enter(ctx, tx);
      if (entered === undefined) return;
      const { services, tenant } = entered;
      const p = event.payload;
      const booking = await services.integrations.booking(tx, tenant, p.bookingId);
      if (booking === undefined) return;
      const members = new MembershipRepo(tenant, tx);
      const contacts = new ContactRepo(tenant, tx);

      let contact: ContactRow | undefined;
      if (booking.membershipId !== null) {
        if ((await members.lockNoKeyUpdate(booking.membershipId)) === undefined) return;
        if (await aboutErased(services, tenant, tx, booking.membershipId)) return;
        const existing = await contacts.findByMembership(booking.membershipId);
        // A contact created here is new in this transaction: nobody else can hold it.
        contact =
          existing === undefined
            ? await ensureContact(services, tenant, tx, booking.membershipId, "booking")
            : await contacts.lockLive(existing.id);
        if (contact === undefined || contact.membershipId !== booking.membershipId) return;
      } else {
        const match = await contacts.findByEmail(booking.inviteeEmail);
        if (match === undefined) return;
        if (match.membershipId !== null) {
          await members.lockNoKeyUpdate(match.membershipId);
          if (await aboutErased(services, tenant, tx, match.membershipId)) return;
        }
        contact = await contacts.lockLive(match.id);
        // Re-read under the lock: an erasure that got there first has cleared the address.
        if (
          contact === undefined ||
          contact.email === null ||
          contact.email.toLowerCase() !== booking.inviteeEmail.toLowerCase()
        )
          return;
      }

      const endsAt =
        booking.endsAt !== null && booking.endsAt.getTime() >= booking.startsAt.getTime()
          ? booking.endsAt
          : null;
      const title = booking.eventName?.trim().slice(0, 200) || null;
      await new ActivityRepo(tenant, tx).upsertForBooking({
        contactId: contact.id,
        kind: ACTIVITY_FOR_BOOKING_STATUS[p.status],
        occurredAt: event.createdAt,
        startsAt: booking.startsAt,
        endsAt,
        title,
        bookingId: booking.id,
        provider: booking.provider,
      });
    },
  );

  return {
    "integration.booking_recorded": onBookingRecorded,
    "member.erasure_requested": onErasureRequested,
    "round.interest_submitted": onInterestSubmitted,
    "round.interest_decided": onInterestDecided,
    "round.commitment_created": onCommitmentCreated,
    "round.commitment_changed": onCommitmentChanged,
  };
}
