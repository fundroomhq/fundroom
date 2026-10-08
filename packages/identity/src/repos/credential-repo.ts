import {
  type Credential,
  type CredentialKind,
  core,
  type NewCredential,
  type Tx,
} from "@fundroom/db";
import { and, asc, eq, isNull } from "drizzle-orm";

const { credential } = core;

const live = () => isNull(credential.revokedAt);

export async function listCredentials(
  tx: Tx,
  userId: string,
  kind?: CredentialKind,
): Promise<Credential[]> {
  const where = kind
    ? and(eq(credential.userId, userId), eq(credential.kind, kind), live())
    : and(eq(credential.userId, userId), live());
  return tx.select().from(credential).where(where).orderBy(asc(credential.createdAt));
}

export async function findCredential(
  tx: Tx,
  userId: string,
  kind: CredentialKind,
): Promise<Credential | undefined> {
  const rows = await listCredentials(tx, userId, kind);
  return rows[0];
}

/**
 * `findCredential` with a row lock (`SELECT … FOR UPDATE`), for a read-modify-write that must not
 * interleave with a concurrent one: a TOTP step or a recovery code is spent at most once
 * (ASVS 6.5.1). The lock lives until the caller's transaction ends; take no other pool
 * connection while holding it.
 */
export async function lockCredential(
  tx: Tx,
  userId: string,
  kind: CredentialKind,
): Promise<Credential | undefined> {
  const rows = await tx
    .select()
    .from(credential)
    .where(and(eq(credential.userId, userId), eq(credential.kind, kind), live()))
    .orderBy(asc(credential.createdAt))
    .for("update")
    .limit(1);
  return rows[0];
}

export async function findCredentialById(
  tx: Tx,
  id: string,
  userId: string,
): Promise<Credential | undefined> {
  const rows = await tx
    .select()
    .from(credential)
    .where(and(eq(credential.id, id), eq(credential.userId, userId), live()))
    .limit(1);
  return rows[0];
}

export async function findPasskeyByExternalId(
  tx: Tx,
  externalId: string,
): Promise<Credential | undefined> {
  const rows = await tx
    .select()
    .from(credential)
    .where(and(eq(credential.kind, "passkey"), eq(credential.externalId, externalId), live()))
    .limit(1);
  return rows[0];
}

export async function insertCredential(tx: Tx, values: NewCredential): Promise<Credential> {
  const rows = await tx.insert(credential).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function updateCredential(
  tx: Tx,
  id: string,
  patch: Partial<
    Pick<
      Credential,
      | "label"
      | "secret"
      | "signCount"
      | "backedUp"
      | "confirmedAt"
      | "lastUsedAt"
      | "data"
      | "dataSchemaVersion"
    >
  >,
): Promise<void> {
  await tx.update(credential).set(patch).where(eq(credential.id, id));
}

export async function revokeCredential(tx: Tx, id: string, userId: string): Promise<boolean> {
  const rows = await tx
    .update(credential)
    .set({ revokedAt: new Date() })
    .where(and(eq(credential.id, id), eq(credential.userId, userId), live()))
    .returning({ id: credential.id });
  return rows.length > 0;
}

export async function revokeCredentialsOfKind(
  tx: Tx,
  userId: string,
  kind: CredentialKind,
): Promise<number> {
  const rows = await tx
    .update(credential)
    .set({ revokedAt: new Date() })
    .where(and(eq(credential.userId, userId), eq(credential.kind, kind), live()))
    .returning({ id: credential.id });
  return rows.length;
}
