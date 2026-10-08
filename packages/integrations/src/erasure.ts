import type { TenantContext, Tx } from "@fundroom/db";
import { BookingRepo } from "./repos/booking-repo.js";
import { emailIdentitiesOfMember } from "./repos/member-repo.js";
import { type BookingSuppressionKeys, suppressBookingEmails } from "./suppression.js";

/*
 * Identity erasure and DSAR for recorded bookings (E3.6 contract §3 "Erasure", fix round 1),
 * called by `@fundroom/compliance`'s kernel identity step exactly like the e-sign hooks (E3.5).
 *
 * A booking row names the person twice: `membership_id` (matched at ingest) and `invitee_email`
 * (the address they booked with, matched or not). Erasure PSEUDONYMISES every row carrying either
 * — by membership or by ANY of the user's email identities, as ingest matches — rather than
 * deleting it: the row keeps its vendor `external_id`, so a vendor retry (or a Cal.com replay,
 * whose signature carries no timestamp) of the same event dedupes against it instead of inserting
 * the person's address again. Ingest never rewrites an erased row's personal fields, and an
 * event for a suppressed address (below) is not stored at all.
 *
 * Lock order. The identity step runs under the audit chain, while booking ingest locks the
 * workspace's booking advisory lock and then booking rows (no chain). So the erasure takes the
 * advisory lock and the member's rows BEFORE the chain — `lockIntegrationBookingsOfMember` from
 * `prelockErasureSubject` — and holds them to commit: no booking for the member can be inserted
 * between the pre-lock and the pseudonymisation. Order: booking advisory lock → booking rows (id
 * order) → audit chain.
 */

async function addresses(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  extra: string | null = null,
): Promise<string[]> {
  const all = await emailIdentitiesOfMember(tx, ctx, membershipId);
  if (extra !== null && !all.includes(extra.toLowerCase())) all.push(extra.toLowerCase());
  return all;
}

/** Pre-lock (before the audit chain). Idempotent within a transaction. */
export async function lockIntegrationBookingsOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<void> {
  const repo = new BookingRepo(ctx, tx);
  await repo.lockWorkspace();
  await repo.lockOfSubject(membershipId, await addresses(tx, ctx, membershipId));
}

/**
 * Pseudonymises every booking naming the member (by membership, by any of their email identities,
 * or by `email` — read by the caller BEFORE the identity is scrubbed), and records a suppression for each of those addresses so a NEW vendor event for the person is never
 * stored (fix round 2). Returns how many rows changed (`integrationBookings`) and how many
 * addresses were suppressed.
 */
export async function pseudonymiseIntegrationBookingsOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  email: string | null,
  at: Date,
  keys: BookingSuppressionKeys,
): Promise<{ rows: number; suppressed: number }> {
  const emails = await addresses(tx, ctx, membershipId, email);
  const rows = await new BookingRepo(ctx, tx).pseudonymiseOfSubject(membershipId, emails, at);
  const suppressed = await suppressBookingEmails(tx, ctx, keys, emails);
  return { rows, suppressed };
}

/** DSAR: the member's recorded bookings (by membership or any address), as plain metadata. */
export async function integrationSubjectBookings(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<Record<string, unknown>[]> {
  const iso = (d: Date | null) => (d === null ? null : d.toISOString());
  const emails = await addresses(tx, ctx, membershipId);
  return (await new BookingRepo(ctx, tx).ofSubject(membershipId, emails)).map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    startsAt: iso(r.startsAt),
    endsAt: iso(r.endsAt),
    inviteeEmail: r.inviteeEmail,
    inviteeName: r.inviteeName,
    eventName: r.eventName,
    receivedAt: iso(r.receivedAt),
    updatedAt: iso(r.updatedAt),
  }));
}
