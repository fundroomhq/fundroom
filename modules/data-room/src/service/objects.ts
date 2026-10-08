import { decryptStream, encryptStream, HEADER_BYTES, streamToBytes } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { ObjectStat } from "@fundroom/ports";
import { z } from "zod";

/*
 * Encrypted objects (ADR-0028): every blob and rendition the data room stores is SHE1
 * ciphertext under the workspace DEK. `blob.encryption` / a rendition's sidecar remembers
 * which key wrapped it (`keyId`, `keyRef`) so rotation keeps old objects readable through
 * `crypto.keyById`.
 */
export const ENCRYPTION_SCHEMA_VERSION = 1;

export const EncryptionSchema = z
  .object({
    format: z.literal("she1"),
    keyId: z.uuid(),
    keyRef: z.string().min(1),
  })
  .strict();
export type Encryption = z.output<typeof EncryptionSchema>;

export function parseEncryption(raw: unknown): Encryption | undefined {
  const r = EncryptionSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}

export interface StoredObject {
  readonly key: string;
  readonly encryption: Encryption;
  readonly stat: ObjectStat;
  /** Plaintext length. */
  readonly size: number;
}

export interface ObjectStore {
  /** Encrypts and stores a plaintext stream; `size` is the plaintext length (S3 needs the ciphertext length up front). */
  putStream(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    plaintext: ReadableStream<Uint8Array>,
    size: number,
    contentType: string,
  ): Promise<StoredObject>;
  putBytes(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<StoredObject>;
  /** Whole-object plaintext. */
  readBytes(tx: Tx, ctx: TenantContext, key: string, encryption: Encryption): Promise<Uint8Array>;
  /** Plaintext stream (downloads). `undefined` when the object is missing. */
  readStream(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    encryption: Encryption,
  ): Promise<ReadableStream<Uint8Array> | undefined>;
}

export function ciphertextLengthOf(plaintextLength: number): number {
  // Imported lazily to keep this file's surface small for tests.
  const chunk = 65_536;
  const tag = 16;
  const chunks = Math.max(1, Math.ceil(plaintextLength / chunk));
  return HEADER_BYTES + plaintextLength + chunks * tag;
}

export function createObjectStore(services: ModuleServices): ObjectStore {
  const { storage, crypto } = services;

  async function keyFor(tx: Tx, ctx: TenantContext, encryption: Encryption): Promise<Uint8Array> {
    const key = await crypto.keyById(tx, ctx, encryption.keyId);
    if (key === undefined) throw new Error(`workspace key ${encryption.keyId} is unknown`);
    return key.key;
  }

  return {
    async putStream(tx, ctx, key, plaintext, size, contentType) {
      const dek = await crypto.currentKey(tx, ctx);
      const stat = await storage.put(key, encryptStream(dek.key, plaintext), {
        contentType: "application/octet-stream",
        contentLength: ciphertextLengthOf(size),
        metadata: { "sh-format": "she1", "sh-content-type": contentType.slice(0, 120) },
      });
      return {
        key,
        stat,
        size,
        encryption: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef },
      };
    },
    async putBytes(tx, ctx, key, bytes, contentType) {
      const dek = await crypto.currentKey(tx, ctx);
      const { encryptBytes } = await import("@fundroom/crypto");
      const ciphertext = await encryptBytes(dek.key, bytes);
      const stat = await storage.put(key, ciphertext, {
        contentType: "application/octet-stream",
        contentLength: ciphertext.byteLength,
        metadata: { "sh-format": "she1", "sh-content-type": contentType.slice(0, 120) },
      });
      return {
        key,
        stat,
        size: bytes.byteLength,
        encryption: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef },
      };
    },
    async readBytes(tx, ctx, key, encryption) {
      const stream = await this.readStream(tx, ctx, key, encryption);
      if (stream === undefined) throw new Error(`object ${key} is missing`);
      return streamToBytes(stream);
    },
    async readStream(tx, ctx, key, encryption) {
      const dek = await keyFor(tx, ctx, encryption);
      const read = await storage.get(key);
      if (read === undefined) return undefined;
      return decryptStream(dek, read.body);
    },
  };
}
