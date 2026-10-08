import { core, type Device, type Tx } from "@fundroom/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

const { device } = core;

export async function findDeviceByTokenHash(
  tx: Tx,
  userId: string,
  tokenHash: Buffer,
): Promise<Device | undefined> {
  const rows = await tx
    .select()
    .from(device)
    .where(
      and(eq(device.userId, userId), eq(device.tokenHash, tokenHash), isNull(device.revokedAt)),
    )
    .limit(1);
  return rows[0];
}

export async function insertDevice(
  tx: Tx,
  values: {
    userId: string;
    tokenHash: Buffer;
    userAgent: string;
    name?: string;
    trustedUntil?: Date | null;
  },
): Promise<Device> {
  const rows = await tx
    .insert(device)
    .values({
      userId: values.userId,
      tokenHash: values.tokenHash,
      userAgent: values.userAgent,
      name: values.name ?? "",
      trustedUntil: values.trustedUntil ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function touchDevice(
  tx: Tx,
  id: string,
  patch: { lastSeenAt: Date; userAgent?: string; trustedUntil?: Date | null },
): Promise<void> {
  await tx.update(device).set(patch).where(eq(device.id, id));
}

export async function renameDevice(
  tx: Tx,
  id: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await tx
    .update(device)
    .set({ name: name.trim().slice(0, 80) })
    .where(and(eq(device.id, id), eq(device.userId, userId)))
    .returning({ id: device.id });
  return rows.length > 0;
}

export async function revokeDevice(tx: Tx, id: string, userId: string): Promise<boolean> {
  const rows = await tx
    .update(device)
    .set({ revokedAt: new Date(), trustedUntil: null })
    .where(and(eq(device.id, id), eq(device.userId, userId), isNull(device.revokedAt)))
    .returning({ id: device.id });
  return rows.length > 0;
}

export async function listDevicesForUser(tx: Tx, userId: string): Promise<Device[]> {
  return tx
    .select()
    .from(device)
    .where(and(eq(device.userId, userId), isNull(device.revokedAt)))
    .orderBy(desc(device.lastSeenAt));
}

export async function countDevicesForUser(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(device)
    .where(and(eq(device.userId, userId), isNull(device.revokedAt)));
  return rows[0]?.n ?? 0;
}
