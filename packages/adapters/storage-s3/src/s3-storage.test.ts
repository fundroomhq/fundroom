import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { isStorageError } from "@fundroom/ports";
import { bytesOf, streamOf } from "@fundroom/storage/testing";
import { describe, expect, it, vi } from "vitest";
import { createS3Storage } from "./s3-storage.js";

/*
 * Behaviour that does not need a backend: key prefixing, guard rails before any request,
 * error mapping, presign clamping. The contract suite (integration) covers the real thing.
 */
function make() {
  const storage = createS3Storage({
    bucket: "bkt",
    endpoint: "http://127.0.0.1:9",
    accessKeyId: "a",
    secretAccessKey: "b",
    keyPrefix: "pre/",
  });
  const send = vi.fn();
  (storage.client as unknown as { send: unknown }).send = send;
  return { storage, send };
}

function notFound(name = "NotFound") {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

describe("s3 storage", () => {
  it("rejects a keyPrefix without a trailing slash", () => {
    expect(() =>
      createS3Storage({ bucket: "b", accessKeyId: "a", secretAccessKey: "b", keyPrefix: "x" }),
    ).toThrow(/slash/u);
  });

  it("prefixes keys on the wire and strips them on the way back", async () => {
    const { storage, send } = make();
    send.mockResolvedValueOnce({ ContentLength: 3, ETag: '"e"', Metadata: { sha256: "ab" } });
    const stat = await storage.head("a/b");
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: "bkt", Key: "pre/a/b" });
    expect(stat).toMatchObject({ key: "a/b", size: 3, etag: "e", sha256: "ab", metadata: {} });

    send.mockResolvedValueOnce({
      Contents: [
        { Key: "pre/a/z", Size: 1 },
        { Key: "pre/a/b", Size: 2 },
      ],
      IsTruncated: true,
      NextContinuationToken: "tok",
    });
    const page = await storage.list({ prefix: "a/", limit: 2 });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ Prefix: "pre/a/", MaxKeys: 2 });
    expect(page.objects.map((o) => o.key)).toEqual(["a/b", "a/z"]);
    expect(page.cursor).toBe("tok");
  });

  it("maps 404s to undefined and other failures to backend errors", async () => {
    const { storage, send } = make();
    send.mockRejectedValueOnce(notFound("NoSuchKey"));
    expect(await storage.get("x")).toBeUndefined();
    send.mockRejectedValueOnce(notFound());
    await expect(storage.delete("x")).resolves.toBeUndefined();
    send.mockRejectedValueOnce(new Error("boom"));
    await expect(storage.head("x")).rejects.toSatisfy(
      (e) => isStorageError(e, "backend") && /boom/u.test((e as Error).message),
    );
  });

  it("refuses invalid keys and streaming bodies without a length before sending", async () => {
    const { storage, send } = make();
    await expect(storage.head("../x")).rejects.toSatisfy((e) => isStorageError(e, "invalid_key"));
    await expect(storage.put("k", streamOf([bytesOf("x")]))).rejects.toSatisfy((e) =>
      isStorageError(e, "size_mismatch"),
    );
    await expect(storage.put("k", bytesOf("x"), { sha256: "zz" })).rejects.toSatisfy((e) =>
      isStorageError(e, "checksum_mismatch"),
    );
    await expect(storage.put("k", bytesOf("xy"), { sha256: "0".repeat(64) })).rejects.toSatisfy(
      (e) => isStorageError(e, "checksum_mismatch"),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends ChecksumSHA256 and records the digest as metadata", async () => {
    const { storage, send } = make();
    const body = bytesOf("payload");
    const hex = createHash("sha256").update(body).digest("hex");
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ ContentLength: 7, Metadata: { sha256: hex, k: "v" } });
    const stat = await storage.put("k", body, { sha256: hex, metadata: { k: "v" } });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Key: "pre/k",
      ContentLength: 7,
      ChecksumSHA256: Buffer.from(hex, "hex").toString("base64"),
      Metadata: { k: "v", sha256: hex },
    });
    expect(stat.sha256).toBe(hex);
    expect(stat.metadata).toEqual({ k: "v" });
  });

  it("recomputes the digest of a streamed body and undoes a mismatching write", async () => {
    const { storage, send } = make();
    send.mockImplementation(
      async (cmd: { input: { Body?: Readable }; constructor: { name: string } }) => {
        if (cmd.input.Body instanceof Readable) {
          for await (const _chunk of cmd.input.Body) {
            // drain, as the real client would
          }
        }
        return {};
      },
    );
    await expect(
      storage.put("k", streamOf([bytesOf("abc")]), { contentLength: 3, sha256: "0".repeat(64) }),
    ).rejects.toSatisfy((e) => isStorageError(e, "checksum_mismatch"));
    const names = send.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
  });

  it("parses the served range and rejects a backend that ignored it", async () => {
    const { storage, send } = make();
    send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("234")]),
      ContentRange: "bytes 2-4/10",
      ContentLength: 3,
    });
    const read = await storage.get("k", { range: { start: 2, end: 4 } });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Range: "bytes=2-4" });
    expect(read?.range).toEqual({ start: 2, end: 4 });
    expect(read?.stat.size).toBe(10);

    send.mockResolvedValueOnce({ Body: Readable.from([]), ContentLength: 10 });
    await expect(storage.get("k", { range: { start: 2 } })).rejects.toSatisfy((e) =>
      isStorageError(e, "backend"),
    );
    await expect(storage.get("k", { range: { start: -1 } })).rejects.toSatisfy((e) =>
      isStorageError(e, "backend"),
    );
  });

  it("caps presigned GET expiry at 60 s and batches deleteMany by 1000", async () => {
    const { storage, send } = make();
    const url = await storage.presignGet("k", { expiresInSeconds: 3600 });
    const expires = new URL(url).searchParams.get("X-Amz-Expires");
    expect(expires).toBe("60");
    expect(new URL(url).pathname).toBe("/bkt/pre/k");

    send.mockResolvedValue({});
    const keys = Array.from({ length: 1500 }, (_, i) => `many/${i}`);
    await storage.deleteMany(keys);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input.Delete.Objects).toHaveLength(1000);
    expect(send.mock.calls[1]?.[0].input.Delete.Objects).toHaveLength(500);
  });

  it("reports failed deletes other than NoSuchKey", async () => {
    const { storage, send } = make();
    send.mockResolvedValueOnce({ Errors: [{ Key: "pre/a", Code: "AccessDenied", Message: "no" }] });
    await expect(storage.deleteMany(["a"])).rejects.toSatisfy(
      (e) => isStorageError(e, "backend") && (e as { key?: string }).key === "a",
    );
  });
});

describe("s3 storage timeouts (E2.10)", () => {
  /** Accepts connections and never answers: a black-holed endpoint. Counts attempts. */
  async function blackHole(): Promise<{ url: string; connections: () => number; close(): void }> {
    const { createServer } = await import("node:net");
    let n = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      n += 1;
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${address.port}`,
      connections: () => n,
      close: () => {
        for (const s of sockets) s.destroy();
        server.close();
      },
    };
  }

  it("fails a call to a silent endpoint inside maxAttempts × socketTimeout, not never", async () => {
    const hole = await blackHole();
    try {
      const storage = createS3Storage({
        bucket: "bkt",
        endpoint: hole.url,
        accessKeyId: "a",
        secretAccessKey: "b",
        socketTimeoutMs: 300,
        maxAttempts: 1,
      });
      const started = performance.now();
      await expect(storage.head("k")).rejects.toSatisfy((e) => isStorageError(e, "backend"));
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(hole.connections()).toBe(1);
    } finally {
      hole.close();
    }
  });

  it("retries once by default (a dead keep-alive socket), then gives up", async () => {
    const hole = await blackHole();
    try {
      const storage = createS3Storage({
        bucket: "bkt",
        endpoint: hole.url,
        accessKeyId: "a",
        secretAccessKey: "b",
        socketTimeoutMs: 200,
      });
      await expect(storage.healthCheck()).rejects.toSatisfy((e) => isStorageError(e, "backend"));
      expect(hole.connections()).toBe(2);
    } finally {
      hole.close();
    }
  });

  it("defaults to a 5 s connect and 30 s socket-idle bound (the SDK's own are none)", async () => {
    const storage = createS3Storage({ bucket: "b", accessKeyId: "a", secretAccessKey: "b" });
    const handler = storage.client.config.requestHandler as unknown as {
      configProvider: Promise<{ connectionTimeout?: number; socketTimeout?: number }>;
    };
    const resolved = await handler.configProvider;
    expect(resolved.connectionTimeout).toBe(5_000);
    expect(resolved.socketTimeout).toBe(30_000);
    expect(await storage.client.config.maxAttempts()).toBe(2);
  });
});
