import { randomBytes, randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bytesToStream,
  CHUNK_BYTES,
  CHUNK_CIPHERTEXT_BYTES,
  ciphertextLength,
  ciphertextRangeFor,
  decryptBytes,
  decryptRange,
  decryptStream,
  encryptBytes,
  encryptStream,
  HEADER_BYTES,
  parseHeader,
  plaintextLength,
  StreamAeadError,
  streamToBytes,
  TAG_BYTES,
} from "./stream-aead.js";

const DEK = new Uint8Array(randomBytes(32));

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/** Streams `bytes` in pieces of random, odd sizes so chunk boundaries never line up. */
function oddStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const n = Math.min(bytes.byteLength - offset, 1 + randomInt(70_000));
      controller.enqueue(bytes.subarray(offset, offset + n));
      offset += n;
    },
  });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e) => e instanceof StreamAeadError && e.code === code);
}

describe("stream AEAD", () => {
  const sizes = [0, 1, 15, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * 1024 * 1024];
  for (const size of sizes) {
    it(`round-trips ${size} bytes (buffered and odd-sized streaming)`, async () => {
      const pt = new Uint8Array(randomBytes(size));
      const ct = await encryptBytes(DEK, pt);
      expect(ct.byteLength).toBe(ciphertextLength(size));
      expect(plaintextLength(ct.byteLength)).toBe(size);
      expect(eq(await decryptBytes(DEK, ct), pt)).toBe(true);

      const ct2 = await streamToBytes(encryptStream(DEK, oddStream(pt)));
      expect(ct2.byteLength).toBe(ct.byteLength);
      expect(eq(await streamToBytes(decryptStream(DEK, oddStream(ct2))), pt)).toBe(true);
    });
  }

  it("round-trips random lengths", async () => {
    for (let i = 0; i < 12; i++) {
      const pt = new Uint8Array(randomBytes(randomInt(4 * CHUNK_BYTES)));
      const ct = await streamToBytes(encryptStream(DEK, oddStream(pt)));
      expect(eq(await streamToBytes(decryptStream(DEK, oddStream(ct))), pt)).toBe(true);
    }
  });

  it("uses a fresh salt per object and a parseable header", async () => {
    const a = await encryptBytes(DEK, new Uint8Array(10));
    const b = await encryptBytes(DEK, new Uint8Array(10));
    expect(eq(a.subarray(0, HEADER_BYTES), b.subarray(0, HEADER_BYTES))).toBe(false);
    expect(eq(a, b)).toBe(false);
    expect(parseHeader(a.subarray(0, HEADER_BYTES)).salt).toHaveLength(16);
    expect(() => parseHeader(new Uint8Array(HEADER_BYTES))).toThrow(StreamAeadError);
    expect(a[4]).toBe(1);
  });

  it("pins the format with a fixed test vector", async () => {
    const dek = new Uint8Array(32).map((_, i) => i);
    const salt = new Uint8Array(16).fill(0x42);
    const ct = await encryptBytes(dek, new TextEncoder().encode("hello"), { salt });
    expect(Buffer.from(ct).toString("hex")).toBe(
      "534845310142424242424242424242424242424242fd0989f5a4902b89bd1fc84f2dd766a6a2f2583abb",
    );
    expect(eq(await decryptBytes(dek, ct), new TextEncoder().encode("hello"))).toBe(true);
  });

  it("fails on a flipped bit anywhere", async () => {
    const pt = new Uint8Array(randomBytes(CHUNK_BYTES + 100));
    const ct = await encryptBytes(DEK, pt);
    const positions = [
      0,
      4,
      10,
      HEADER_BYTES,
      HEADER_BYTES + 5000,
      HEADER_BYTES + CHUNK_BYTES + 3,
      ct.byteLength - 1,
    ];
    for (const i of positions) {
      const bad = Uint8Array.from(ct);
      bad[i] = (bad[i] ?? 0) ^ 0x80;
      await expect(decryptBytes(DEK, bad)).rejects.toBeInstanceOf(StreamAeadError);
    }
  });

  it("detects truncation, reorder, duplication and a wrong key", async () => {
    const pt = new Uint8Array(randomBytes(3 * CHUNK_BYTES + 7));
    const ct = await encryptBytes(DEK, pt);
    const body = (i: number) =>
      ct.subarray(
        HEADER_BYTES + i * CHUNK_CIPHERTEXT_BYTES,
        HEADER_BYTES + (i + 1) * CHUNK_CIPHERTEXT_BYTES,
      );
    const header = ct.subarray(0, HEADER_BYTES);
    const last = ct.subarray(HEADER_BYTES + 3 * CHUNK_CIPHERTEXT_BYTES);

    // Drop the final chunk: the remaining last chunk was sealed as "not last".
    await expectCode(
      decryptBytes(DEK, ct.subarray(0, HEADER_BYTES + 3 * CHUNK_CIPHERTEXT_BYTES)),
      "truncated",
    );
    // Cut inside a chunk.
    await expectCode(decryptBytes(DEK, ct.subarray(0, ct.byteLength - 3)), "authentication_failed");
    // Header only / nothing.
    await expectCode(decryptBytes(DEK, header), "truncated");
    await expectCode(decryptBytes(DEK, new Uint8Array(5)), "truncated");
    // Swap chunks 0 and 1.
    const swapped = Buffer.concat([header, body(1), body(0), body(2), last]);
    await expectCode(decryptBytes(DEK, swapped), "authentication_failed");
    // Duplicate chunk 1.
    const dup = Buffer.concat([header, body(0), body(1), body(1), body(2), last]);
    await expectCode(decryptBytes(DEK, dup), "authentication_failed");
    // Wrong key.
    await expectCode(decryptBytes(new Uint8Array(randomBytes(32)), ct), "authentication_failed");
    // Wrong key length.
    await expect(decryptBytes(new Uint8Array(16), ct)).rejects.toBeInstanceOf(StreamAeadError);
  });

  it("serves byte ranges that match slice()", async () => {
    const pt = new Uint8Array(randomBytes(4 * CHUNK_BYTES + 123));
    const ct = await encryptBytes(DEK, pt);
    const header = ct.subarray(0, HEADER_BYTES);
    const cases: [number, number][] = [
      [0, 0],
      [0, pt.byteLength - 1],
      [CHUNK_BYTES - 1, CHUNK_BYTES],
      [CHUNK_BYTES, CHUNK_BYTES],
      [CHUNK_BYTES, 2 * CHUNK_BYTES - 1],
      [3 * CHUNK_BYTES + 5, pt.byteLength - 1],
      [pt.byteLength - 1, pt.byteLength - 1],
      [4 * CHUNK_BYTES, 4 * CHUNK_BYTES + 122],
    ];
    for (let i = 0; i < 20; i++) {
      const s = randomInt(pt.byteLength);
      cases.push([s, s + randomInt(pt.byteLength - s)]);
    }
    for (const [start, end] of cases) {
      const r = ciphertextRangeFor({ start, end });
      expect(r.start).toBeGreaterThanOrEqual(HEADER_BYTES);
      const fetched = ct.subarray(r.start, Math.min(r.end + 1, ct.byteLength));
      const out = await streamToBytes(
        decryptRange(DEK, header, oddStream(fetched), { start, end }),
      );
      expect(out.byteLength).toBe(end - start + 1);
      expect(eq(out, pt.subarray(start, end + 1))).toBe(true);
    }
    // A partial read that starts at chunk 1 with the wrong index fails.
    const r = ciphertextRangeFor({ start: CHUNK_BYTES, end: CHUNK_BYTES + 10 });
    await expectCode(
      streamToBytes(
        decryptStream(DEK, bytesToStream(ct.subarray(r.start, r.end + 1)), {
          header,
          firstChunkIndex: 0,
          expectLast: false,
        }),
      ),
      "authentication_failed",
    );
    expect(() => ciphertextRangeFor({ start: 5, end: 4 })).toThrow(StreamAeadError);
  });

  it("computes lengths", () => {
    expect(ciphertextLength(0)).toBe(HEADER_BYTES + TAG_BYTES);
    expect(ciphertextLength(CHUNK_BYTES)).toBe(HEADER_BYTES + CHUNK_BYTES + TAG_BYTES);
    expect(ciphertextLength(CHUNK_BYTES + 1)).toBe(HEADER_BYTES + CHUNK_BYTES + 1 + 2 * TAG_BYTES);
    expect(plaintextLength(ciphertextLength(123_456))).toBe(123_456);
    expect(() => plaintextLength(HEADER_BYTES)).toThrow(StreamAeadError);
  });
});
