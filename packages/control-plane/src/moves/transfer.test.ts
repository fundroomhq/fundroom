import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToStream, encryptStream, streamToBytes } from "@fundroom/crypto";
import type { OutboundFetch } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { downloadBundle, TransferError } from "./transfer.js";

const URL_SECRET = "https://s3.example.test/bucket/ws/x/moves/y.bin?X-Amz-Signature=supersecret";

async function sealed(plain: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  return streamToBytes(encryptStream(key, bytesToStream(plain)));
}

function fetchOf(
  body: Uint8Array | null,
  init: { status?: number; length?: boolean; chunk?: number } = {},
): OutboundFetch {
  return async () => {
    if (body === null) return new Response(null, { status: init.status ?? 500 });
    const piece = init.chunk ?? 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += piece) controller.enqueue(body.slice(i, i + piece));
        controller.close();
      },
    });
    const headers = new Headers();
    if (init.length !== false) headers.set("content-length", String(body.length));
    return new Response(stream, { status: init.status ?? 200, headers });
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-moves-"));
  const key = new Uint8Array(randomBytes(32));
  const plain = new Uint8Array(randomBytes(200_000));
  const sha = createHash("sha256").update(plain).digest("hex");
  return { dir, key, plain, sha, out: join(dir, "bundle.zip") };
}

async function failure(p: Promise<unknown>): Promise<TransferError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TransferError);
  // The presigned URL is a bearer credential: never in an error.
  expect(String((error as Error).message)).not.toContain("supersecret");
  expect(String((error as Error).message)).not.toContain("s3.example.test");
  return error as TransferError;
}

describe("downloadBundle", () => {
  it("downloads, decrypts and verifies the plaintext sha256", async () => {
    const s = setup();
    const body = await sealed(s.plain, s.key);
    const r = await downloadBundle(fetchOf(body), {
      url: URL_SECRET,
      sha256: s.sha,
      bytes: body.length,
      maxBytes: 10_000_000,
      transferKey: s.key,
      outPath: s.out,
    });
    expect(r.bytes).toBe(body.length);
    expect(new Uint8Array(readFileSync(s.out))).toEqual(s.plain);
  });

  it("refuses a sha256 that does not match (and leaves no file)", async () => {
    const s = setup();
    const body = await sealed(s.plain, s.key);
    const e = await failure(
      downloadBundle(fetchOf(body), {
        url: URL_SECRET,
        sha256: "0".repeat(64),
        bytes: body.length,
        maxBytes: 10_000_000,
        transferKey: s.key,
        outPath: s.out,
      }),
    );
    expect(e.code).toBe("sha256_mismatch");
    expect(() => readFileSync(s.out)).toThrow();
  });

  it("refuses tampered ciphertext and the wrong key as sha256_mismatch", async () => {
    const s = setup();
    const body = await sealed(s.plain, s.key);
    const tampered = Uint8Array.from(body);
    tampered[5000] = (tampered[5000] ?? 0) ^ 0xff;
    const input = {
      url: URL_SECRET,
      sha256: s.sha,
      bytes: body.length,
      maxBytes: 10_000_000,
      transferKey: s.key,
      outPath: s.out,
    };
    expect((await failure(downloadBundle(fetchOf(tampered), input))).code).toBe("sha256_mismatch");
    const other = new Uint8Array(randomBytes(32));
    expect(
      (await failure(downloadBundle(fetchOf(body), { ...input, transferKey: other }))).code,
    ).toBe("sha256_mismatch");
  });

  it("caps the bytes: declared size, Content-Length and the counted stream", async () => {
    const s = setup();
    const body = await sealed(s.plain, s.key);
    const base = {
      url: URL_SECRET,
      sha256: s.sha,
      transferKey: s.key,
      outPath: s.out,
    };
    // The move declares more than MOVE_MAX_BUNDLE_BYTES.
    expect(
      (
        await failure(
          downloadBundle(fetchOf(body), { ...base, bytes: body.length, maxBytes: 1000 }),
        )
      ).code,
    ).toBe("bundle_too_large");
    // The response declares more than the move said.
    expect(
      (
        await failure(
          downloadBundle(fetchOf(body), { ...base, bytes: body.length - 10, maxBytes: 1e9 }),
        )
      ).code,
    ).toBe("bundle_too_large");
    // No Content-Length: counted as it streams.
    expect(
      (
        await failure(
          downloadBundle(fetchOf(body, { length: false }), {
            ...base,
            bytes: body.length - 10,
            maxBytes: 1e9,
          }),
        )
      ).code,
    ).toBe("bundle_too_large");
  });

  it("maps HTTP failures without the URL", async () => {
    const s = setup();
    const input = {
      url: URL_SECRET,
      sha256: s.sha,
      bytes: 10,
      maxBytes: 1e9,
      transferKey: s.key,
      outPath: s.out,
    };
    expect((await failure(downloadBundle(fetchOf(null, { status: 403 }), input))).code).toBe(
      "bundle_expired",
    );
    expect((await failure(downloadBundle(fetchOf(null, { status: 500 }), input))).code).toBe(
      "download_failed",
    );
    const throwing: OutboundFetch = async () => {
      throw Object.assign(new Error(`blocked ${URL_SECRET}`), { code: "blocked_address" });
    };
    expect((await failure(downloadBundle(throwing, input))).code).toBe("download_failed");
  });
});
