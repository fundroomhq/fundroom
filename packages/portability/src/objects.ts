import { createHash, createHmac } from "node:crypto";
import type { EnvelopeService } from "@fundroom/crypto";
import { decryptStream } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ObjectStoragePort } from "@fundroom/ports";

/*
 * Object reads for the export and the suppression-list HMAC (kept in step with
 * `apps/server/src/mail/feedback.ts`, which the kernel owns and a package cannot import).
 */

export interface SheDescriptor {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

export function parseShe(value: unknown): SheDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v["format"] !== "she1" || typeof v["keyId"] !== "string") return undefined;
  return { format: "she1", keyId: v["keyId"], keyRef: String(v["keyRef"] ?? "") };
}

/** The plaintext of an object (decrypted when `keyId` is given); `undefined` when it is missing. */
export async function readPlaintext(
  deps: { readonly storage: ObjectStoragePort; readonly envelope: EnvelopeService },
  tx: Tx,
  ctx: TenantContext,
  key: string,
  keyId: string | undefined,
): Promise<AsyncIterable<Uint8Array> | undefined> {
  let dek: Uint8Array | undefined;
  if (keyId !== undefined) {
    const k = await deps.envelope.keyById(tx, ctx, keyId);
    if (k === undefined) throw new Error(`workspace key ${keyId} (for ${key}) is unknown`);
    dek = k.key;
  }
  const read = await deps.storage.get(key);
  if (read === undefined) return undefined;
  const body = dek === undefined ? read.body : decryptStream(dek, read.body);
  return body as unknown as AsyncIterable<Uint8Array>;
}

export async function hashStream(
  source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of source) {
    h.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: h.digest("hex"), size };
}

/** Envelope purpose of the suppression-list HMAC keys (`mail/feedback.ts`). */
export const SUPPRESSION_KEY_PURPOSE = "mail-suppression";

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function suppressionHash(key: Uint8Array, address: string): Buffer {
  return createHmac("sha256", key).update(normalizeAddress(address), "utf8").digest();
}

export function maskAddress(address: string): string {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${normalized[0] ?? ""}•••@${normalized.slice(at + 1).slice(0, 253)}`;
}
