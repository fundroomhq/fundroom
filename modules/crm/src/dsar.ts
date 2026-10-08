import { MembershipRepo } from "@fundroom/identity";
import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberCrm } from "./repos/dsar-repo.js";

/*
 * The CRM part of a subject-access export (E2.7 DSAR, `modules/crm.json`).
 *
 * The contact set is the erasure handler's: every contact linked to the membership, plus every
 * unlinked contact carrying the member's address (staff often create a contact by hand before
 * the investor joins — it is the same person). For those contacts:
 *
 *   contacts       the personal fields staff recorded (name, email, title, tags, the contact's
 *                  free-text notes field) and the *name* of the organisation they are filed under
 *   pipelineItems  where the relationship stands in each round's pipeline, and the forecast
 *                  (`commitmentId` is a bare pointer: the committed money itself — amount,
 *                  status, wire date, note — is `round.commitment`'s, and the round module
 *                  exports it as `contactCommitments`, taking these contacts' ids from this
 *                  export via `dsar.after: ["crm"]`; the CRM never reads `round.*`)
 *   stageHistory   how it moved (stage keys, cause, time)
 *   notes, tasks   what staff wrote about them and the follow-ups they set
 *   activities     meetings they booked, moved or cancelled through a booking link (E3.6):
 *                  kind, times, the vendor's event name and which vendor — never the booking's
 *                  vendor id (the kernel exports its own register as `integration-bookings.json`)
 *
 * **Decision on notes:** exported, bodies included. A note on a contact or on their pipeline
 * item is an opinion *about the subject*, which GDPR art. 15 covers (CJEU C-434/16, Nowak), and
 * erasure deletes it for the same reason. What is *not* exported is anything about other people
 * that the CRM holds next to it: authors and owners appear as membership ids only (never staff
 * names), organisations only by name (never their notes, domain or other contacts), and other
 * contacts not at all. Notes a staff member wrote about somebody else are that person's data and
 * the company's, not the author's — a staff DSAR does not list them.
 *
 * The address is read through identity's `MembershipRepo` on the kernel's transaction, as the
 * erasure handler does. After an erasure has run it is pseudonymised and matches nothing.
 */
export const crmDsar: ModuleDsar = {
  async export({ tx, ctx, membershipId }) {
    const person = await new MembershipRepo(ctx, tx).person(membershipId);
    return readMemberCrm(ctx, tx, membershipId, person?.email ?? null);
  },
};
