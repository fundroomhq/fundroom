import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberRound } from "./repos/dsar-repo.js";

/*
 * The round part of a subject-access export (E2.7 DSAR, `modules/round.json`).
 *
 * Exported:
 *   rounds               id, name and currency of each round the member took part in
 *   interestSubmissions  every indication of interest: amount, subject/entity, their note, the
 *                        accreditation path and stamps, and the staff decision (decider as a
 *                        membership id, the decision note — written about them)
 *   verifications        accreditation verifications: method, status, the evidence file's
 *                        sha256, type, size and upload/purge times, and the decision
 *   commitments          their commitments: amount, status, wire date, notes
 *   contactCommitments   commitments staff recorded against a CRM contact that is this member
 *                        (linked to the membership, or an unlinked contact carrying their
 *                        address): the same fields, including the display name typed on them
 *
 * These rows survive an erasure as legal evidence, and are about the member all the same.
 *
 * Which contacts are the member's is the CRM's knowledge, not this module's: round never reads
 * `crm.*` (ADR-0033). The exporter declares `after: ["crm"]` and takes the contact ids from the
 * CRM export it is handed (`related.crm.contacts[].id`) — as it would take them from an event.
 *
 * Left out: the evidence file itself (metadata only — the bytes are encrypted, purged on a
 * schedule, and not the kind of thing an export should re-distribute), its storage key, and the
 * verification's vendor handoff (E3.7); round terms and closing tasks are company records.
 */
export const roundDsar: ModuleDsar = {
  after: ["crm"],
  export: ({ tx, ctx, membershipId, related }) =>
    readMemberRound(ctx, tx, membershipId, contactIdsFrom(related["crm"])),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `contacts[].id` from the CRM's export, uuids only (it is another module's JSON). */
export function contactIdsFrom(crm: unknown): string[] {
  if (crm === null || typeof crm !== "object") return [];
  const contacts = (crm as { contacts?: unknown }).contacts;
  if (!Array.isArray(contacts)) return [];
  const ids = contacts
    .map((c) => (c !== null && typeof c === "object" ? (c as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
  return [...new Set(ids)];
}
