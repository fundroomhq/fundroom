import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decryptStream, StreamAeadError } from "@fundroom/crypto";
import type { OutboundFetch } from "@fundroom/ports";

/*
 * Moving a bundle between cells (E3.11). The source encrypts the signed export zip with a fresh
 * per-move key (SHE1, the same authenticated stream format as every stored object) before it
 * lands in its object store, so neither the presigned URL nor the bucket alone reveals anything;
 * the key travels in the move's `carried.transferKey` in the directory. The target downloads
 * through the SSRF-guarded outbound agent, counting bytes against MOVE_MAX_BUNDLE_BYTES as they
 * arrive (a lying or absent Content-Length changes nothing), decrypts (every byte authenticated)
 * and hashes the plaintext, which must equal the bundle's `sha256` before anything reads the zip.
 *
 * The URL never leaves this module in an error: failures carry a code, never the URL.
 */

export type TransferErrorCode =
  | "download_failed"
  | "bundle_too_large"
  | "sha256_mismatch"
  | "bundle_expired";

export class TransferError extends Error {
  override readonly name = "TransferError";
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A fresh 32-byte transfer key, base64. */
export function newTransferKey(): string {
  return randomBytes(32).toString("base64");
}

export function transferKeyBytes(key: unknown): Uint8Array {
  if (typeof key !== "string") throw new TransferError("sha256_mismatch", "no transfer key");
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new TransferError("sha256_mismatch", "malformed transfer key");
  return new Uint8Array(bytes);
}

/** Counts bytes through a stream, failing once more than `max` have passed. */
export function capStream(
  max: number,
  onBytes?: (n: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        controller.error(new TransferError("bundle_too_large", `the bundle exceeds ${max} bytes`));
        return;
      }
      onBytes?.(seen);
      controller.enqueue(chunk);
    },
  });
}

export interface DownloadBundleInput {
  readonly url: string;
  /** The expected plaintext sha256 (hex). */
  readonly sha256: string;
  /** The declared ciphertext size: more than this is refused like more than `maxBytes`. */
  readonly bytes: number;
  readonly maxBytes: number;
  readonly transferKey: Uint8Array;
  readonly outPath: string;
  readonly signal?: AbortSignal | undefined;
  /** Called as bytes arrive (heartbeats). */
  readonly onProgress?: (() => void) | undefined;
}

/**
 * Downloads, decrypts and verifies a bundle into `outPath` (deleted on any failure). Throws
 * `TransferError`.
 */
export async function downloadBundle(
  fetch: OutboundFetch,
  input: DownloadBundleInput,
): Promise<{ readonly bytes: number }> {
  const cap = Math.min(input.maxBytes, input.bytes);
  if (input.bytes > input.maxBytes)
    throw new TransferError(
      "bundle_too_large",
      `the bundle is ${input.bytes} bytes, over MOVE_MAX_BUNDLE_BYTES (${input.maxBytes})`,
    );
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "GET",
      redirect: "manual",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new TransferError(
      code === "response_too_large" ? "bundle_too_large" : "download_failed",
      `the bundle could not be fetched (${typeof code === "string" ? code : "network error"})`,
    );
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new TransferError(
      response.status === 403 ? "bundle_expired" : "download_failed",
      `the bundle download answered HTTP ${response.status}`,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await response.body.cancel().catch(() => undefined);
    throw new TransferError("bundle_too_large", `the bundle declares ${declared} bytes`);
  }
  let received = 0;
  const hash = createHash("sha256");
  const capped = response.body.pipeThrough(
    capStream(cap, (n) => {
      received = n;
      input.onProgress?.();
    }),
  );
  const plain = decryptStream(input.transferKey, capped);
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(
      plain.pipeThrough(hashing) as unknown as NodeJS.ReadableStream,
      createWriteStream(input.outPath) as Writable,
    );
  } catch (error) {
    await rm(input.outPath, { force: true });
    if (error instanceof TransferError) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === "response_too_large")
      throw new TransferError("bundle_too_large", "the bundle exceeds the byte cap");
    // An authentication failure (tampered or truncated ciphertext, wrong key) or a broken stream.
    throw new TransferError(
      error instanceof StreamAeadError ? "sha256_mismatch" : "download_failed",
      `the bundle could not be read (${error instanceof Error ? error.name : "error"})`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== input.sha256.toLowerCase()) {
    await rm(input.outPath, { force: true });
    throw new TransferError("sha256_mismatch", "the bundle's sha256 does not match the move");
  }
  return { bytes: received };
}
