import type { EventTopic } from "@fundroom/domain";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import { applyEnvelopeStatus, linkVaultedDocument } from "../service/closing.js";
import { roundServices } from "../service/slot.js";
import { createVendorVerificationService } from "../service/vendor.js";

/*
 * Outbox subscribers for the closing workflow (E3.5 §6). Each runs inside the dispatcher's
 * per-workspace system transaction, so everything here is a DB read or write in that one `tx` —
 * no vendor call, no second pool connection (`services.esign.get` takes the tx). A throw means
 * pg-boss retries, and every handler is idempotent under that redelivery: the mirror only moves
 * forward (`nextMirrorStatus`), the signed move and `round.signature_completed` happen on the
 * transition into `completed` only, and the vaulted link is a set-if-different.
 *
 * `legal.isErased`: none of these writes personal data. The mirror holds ids and statuses; the
 * commitment's `signed_at` / `signed_document_id` are facts about a financial record the round
 * keeps under the same retention as the commitment itself (the envelope's signer name/email live
 * in the kernel, which pseudonymises them on erasure).
 */

function typed<T extends EventTopic>(topic: T, handler: EventHandler<T>): EventHandler {
  return async (event, context) => {
    if (event.topic !== topic) throw new Error(`round: ${topic} handler got ${event.topic}`);
    await handler(event as unknown as EventEnvelope<T>, context);
  };
}

const isRoundCommitment = (p: { subjectModule: string; subjectKind: string }) =>
  p.subjectModule === "round" && p.subjectKind === "commitment";

export const onEnvelopeChanged: EventHandler = typed(
  "esign.envelope_changed",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (p.purpose !== "round_closing" || !isRoundCommitment(p)) return;
    await applyEnvelopeStatus(roundServices(), ctx, tx, {
      envelopeId: p.envelopeId,
      status: p.status,
      commitmentId: p.subjectId,
    });
  },
);

/** Published once the signed artifacts are collected; `completed` again (a no-op if mirrored). */
export const onEnvelopeCompleted: EventHandler = typed(
  "esign.envelope_completed",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    if (p.purpose !== "round_closing" || !isRoundCommitment(p)) return;
    await applyEnvelopeStatus(roundServices(), ctx, tx, {
      envelopeId: p.envelopeId,
      status: "completed",
      commitmentId: p.subjectId,
    });
  },
);

/** The data room filed the signed copy: link it to the request and the commitment. */
export const onDocumentVaulted: EventHandler = typed(
  "document.vaulted",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    await linkVaultedDocument(ctx, tx, { envelopeId: p.envelopeId, documentId: p.documentId });
  },
);

/**
 * E3.7: an accreditation vendor's authentic callback woke these refs up. Only a wake-up — the
 * sync job re-reads the vendor over its authenticated API — so all this does is enqueue a sync per
 * matching pending verification, in the dispatcher's transaction (no vendor call, no second
 * connection).
 */
export const onAccreditationProviderUpdated: EventHandler = typed(
  "accreditation.provider_updated",
  async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const p = event.payload;
    await createVendorVerificationService(roundServices()).onProviderUpdated(tx, ctx, {
      driver: p.driver,
      refs: p.refs,
    });
  },
);
