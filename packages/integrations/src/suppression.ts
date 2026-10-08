import { createHmac } from "node:crypto";
import type { EnvelopeService } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import { SuppressionRepo } from "./repos/suppression-repo.js";

/*
 * Booking suppressions (E3.6 fix round 2, R2-A4). Identity erasure pseudonymises the person's
 * recorded bookings, but a NEW vendor event (a new booking uid) would carry their real address
 * again. So erasure also records HMAC-SHA256(workspace key, lower(email)) for each of their
 * addresses, and ingest drops any event whose invitee address hashes to one of them. The key is a
 * workspace data key of its own purpose (KMS-wrapped), so a database copy alone cannot test
 * candidate addresses; lookups hash under every key the workspace holds for the purpose, so a key
 * rotation keeps old suppressions working.
 */
export const SUPPRESSION_KEY_PURPOSE = "integration-booking-suppression";

/** What the suppression needs of the envelope service (`container.envelope`). */
export type BookingSuppressionKeys = Pick<EnvelopeService, "currentKey" | "keysFor">;

function hashWith(key: Uint8Array, email: string): Buffer {
  return createHmac("sha256", key).update(email.trim().toLowerCase(), "utf8").digest();
}

/** Records the addresses (erasure, inside its transaction). Returns how many were given. */
export async function suppressBookingEmails(
  tx: Tx,
  ctx: TenantContext,
  keys: BookingSuppressionKeys,
  emails: readonly string[],
): Promise<number> {
  if (emails.length === 0) return 0;
  const dek = await keys.currentKey(tx, ctx, SUPPRESSION_KEY_PURPOSE);
  await new SuppressionRepo(ctx, tx).add(emails.map((e) => hashWith(dek.key, e)));
  return emails.length;
}

/** A checker for one ingest transaction: loads the keys once (none → nothing is suppressed). */
export async function bookingSuppressionChecker(
  tx: Tx,
  ctx: TenantContext,
  keys: BookingSuppressionKeys,
): Promise<(email: string) => Promise<boolean>> {
  const all = await keys.keysFor(tx, ctx, SUPPRESSION_KEY_PURPOSE);
  if (all.length === 0) return async () => false;
  const repo = new SuppressionRepo(ctx, tx);
  return (email) => repo.anyOf(all.map((k) => hashWith(k.key, email)));
}
