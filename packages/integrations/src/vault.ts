import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import type { core, TenantContext, Tx } from "@fundroom/db";
import { INTEGRATION_KEY_PURPOSE, type IntegrationsServiceDeps } from "./types.js";

/*
 * The token vault: every sealed integrations column is SHE1 under the workspace key of purpose
 * `integration-credentials` (ADR-0016), with its `SealedRef` in the row's `encryption` jsonb. The
 * plaintext lives only in the caller's stack for the duration of one vendor call; nothing here
 * logs, and nothing that leaves the service carries it.
 */

export type SealedRef = core.IntegrationSealedRef;

/** What `credentials_enc` holds (JSON). */
export interface StoredCredentials {
  /** OAuth access token, or the pasted secret ("" for a provider that needs none). */
  readonly accessToken: string;
  readonly refreshToken?: string | null | undefined;
  /** Xero: the organisations the grant covers. */
  readonly accounts?: readonly { readonly id: string; readonly name: string }[] | undefined;
  /** Secret providers: every pasted field (the connect form's values). */
  readonly fields?: Readonly<Record<string, string>> | undefined;
}

export function createVault(deps: Pick<IntegrationsServiceDeps, "crypto">) {
  async function seal(
    tx: Tx,
    sctx: TenantContext,
    text: string,
  ): Promise<{ enc: Buffer; ref: SealedRef }> {
    const dek = await deps.crypto.currentKey(tx, sctx, INTEGRATION_KEY_PURPOSE);
    const enc = Buffer.from(await encryptBytes(dek.key, Buffer.from(text, "utf8")));
    return { enc, ref: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef } };
  }

  async function unseal(
    tx: Tx,
    sctx: TenantContext,
    ref: SealedRef | undefined,
    enc: Uint8Array | null,
  ): Promise<string | undefined> {
    if (ref === undefined || enc === null) return undefined;
    const key = await deps.crypto.keyById(tx, sctx, ref.keyId);
    if (key === undefined) return undefined;
    try {
      return Buffer.from(await decryptBytes(key.key, enc)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  async function sealCredentials(tx: Tx, sctx: TenantContext, creds: StoredCredentials) {
    return seal(tx, sctx, JSON.stringify(creds));
  }

  async function unsealCredentials(
    tx: Tx,
    sctx: TenantContext,
    row: { readonly encryption: unknown; readonly credentialsEnc: Uint8Array },
  ): Promise<StoredCredentials | undefined> {
    const ref = (row.encryption as core.IntegrationConnectionEncryption | null)?.credentials;
    const text = await unseal(tx, sctx, ref, row.credentialsEnc);
    if (text === undefined) return undefined;
    try {
      const parsed = JSON.parse(text) as Partial<StoredCredentials> | null;
      if (parsed === null || typeof parsed !== "object" || typeof parsed.accessToken !== "string")
        return undefined;
      return parsed as StoredCredentials;
    } catch {
      return undefined;
    }
  }

  async function unsealWebhookSecret(
    tx: Tx,
    sctx: TenantContext,
    row: { readonly encryption: unknown; readonly webhookSecretEnc: Uint8Array | null },
  ): Promise<string | undefined> {
    const ref = (row.encryption as core.IntegrationConnectionEncryption | null)?.webhookSecret;
    return unseal(tx, sctx, ref, row.webhookSecretEnc);
  }

  return { seal, unseal, sealCredentials, unsealCredentials, unsealWebhookSecret };
}

export type Vault = ReturnType<typeof createVault>;
