import { ApiKeyRepo, apiKeyTokenHash, displayPrefix, mintApiKeyToken } from "@fundroom/api-keys";
import { type Database, systemContext } from "@fundroom/db";

/*
 * Test support for E3.4 API keys. Not imported by the server.
 *
 * `mintTestApiKey` writes a key row directly (system context), bypassing the route's step-up and
 * its scope checks (`scope_not_offered` / `scope_not_held`), so a test can hold a key with any
 * scopes — including ones the creator does not hold, to prove the guard caps a key by its
 * creator's CURRENT role. To exercise the real create path, `POST /api-keys` as a fresh level-2
 * owner instead.
 *
 * Use it as: `const { token } = await mintTestApiKey(running.container.db, { workspaceId,
 * creatorMembershipId, scopes: ["access.read"] })`, then send
 * `authorization: Bearer ${token}` with NO cookie (a cookie + key is 400 ambiguous_credentials).
 */
export interface MintTestApiKeyInput {
  readonly workspaceId: string;
  /** The staff membership the key acts as (must be active staff for the key to authenticate). */
  readonly creatorMembershipId: string;
  readonly scopes: readonly string[];
  readonly name?: string | undefined;
  readonly expiresAt?: Date | null | undefined;
  readonly note?: string | null | undefined;
}

export interface MintedTestApiKey {
  readonly id: string;
  readonly token: string;
  readonly prefix: string;
}

export async function mintTestApiKey(
  db: Database,
  input: MintTestApiKeyInput,
): Promise<MintedTestApiKey> {
  const token = mintApiKeyToken();
  const ctx = systemContext(input.workspaceId);
  const row = await db.withTenant(ctx, (tx) =>
    new ApiKeyRepo(ctx, tx).insert({
      name: input.name ?? "test key",
      tokenHash: apiKeyTokenHash(token),
      prefix: displayPrefix(token),
      scopes: input.scopes,
      createdByMembershipId: input.creatorMembershipId,
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
    }),
  );
  return { id: row.id, token, prefix: row.prefix };
}

/** `authorization` header for a key (no cookie may accompany it). */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
