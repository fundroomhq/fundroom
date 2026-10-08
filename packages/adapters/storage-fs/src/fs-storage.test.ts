import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorageError } from "@fundroom/ports";
import {
  bytesOf,
  collect,
  describeObjectStorageContract,
  streamOf,
} from "@fundroom/storage/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStorage } from "./fs-storage.js";

describeObjectStorageContract("fs", {
  create: async () => {
    const root = await mkdtemp(join(tmpdir(), "fundroom-fs-"));
    return {
      storage: createFsStorage({ root }),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  },
});

describe("fs storage specifics", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fundroom-fs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lays objects and sidecars out under root and prunes empty dirs on delete", async () => {
    const storage = createFsStorage({ root });
    await storage.put("a/b/c.txt", bytesOf("x"), { contentType: "text/plain" });
    expect((await stat(join(root, "objects", "a", "b", "c.txt"))).isFile()).toBe(true);
    expect((await stat(join(root, "meta", "a", "b", "c.txt.json"))).isFile()).toBe(true);
    await storage.delete("a/b/c.txt");
    expect(await readdir(join(root, "objects"))).toEqual([]);
    expect(await readdir(join(root, "meta"))).toEqual([]);
  });

  it("blocks traversal even when key validation is bypassed", async () => {
    const storage = createFsStorage({ root });
    // A key that passes the regex cannot escape; one that doesn't must be rejected before any I/O.
    for (const bad of ["../../etc/passwd", "a/../../x", "..", "/etc/hosts"]) {
      await expect(storage.get(bad)).rejects.toSatisfy((e) => isStorageError(e, "invalid_key"));
    }
    // Sibling directory that merely *starts* with the root name must not be reachable either.
    const sibling = `${root}-sibling`;
    await expect(storage.head(sibling.slice(1))).resolves.toBeUndefined();
  });

  it("leaves no partial object behind on checksum or size mismatch", async () => {
    const storage = createFsStorage({ root });
    await expect(
      storage.put("bad/sum", streamOf([bytesOf("abc")]), { sha256: "f".repeat(64) }),
    ).rejects.toSatisfy((e) => isStorageError(e, "checksum_mismatch"));
    await expect(
      storage.put("bad/size", streamOf([bytesOf("abc")]), { contentLength: 4 }),
    ).rejects.toSatisfy((e) => isStorageError(e, "size_mismatch"));
    expect(await storage.head("bad/sum")).toBeUndefined();
    expect(await storage.head("bad/size")).toBeUndefined();
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    await expect(readdir(join(root, "objects", "bad"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a failing body stream and cleans up", async () => {
    const storage = createFsStorage({ root });
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("upstream broke"));
      },
    });
    await expect(storage.put("broken", failing)).rejects.toSatisfy(
      (e) => isStorageError(e, "backend") && /upstream broke/u.test((e as Error).message),
    );
    expect(await storage.head("broken")).toBeUndefined();
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("treats an object without a sidecar as absent and a corrupt sidecar as a backend error", async () => {
    const storage = createFsStorage({ root });
    await storage.put("seed", bytesOf("seed"));
    await writeFile(join(root, "objects", "orphan"), "bytes");
    expect(await storage.head("orphan")).toBeUndefined();
    await writeFile(join(root, "meta", "corrupt.json"), "{not json");
    await writeFile(join(root, "objects", "corrupt"), "bytes");
    await expect(storage.head("corrupt")).rejects.toSatisfy((e) => isStorageError(e, "backend"));
  });

  it("overwrites an existing key atomically", async () => {
    const storage = createFsStorage({ root });
    await storage.put("k", bytesOf("one"), { contentType: "text/one" });
    await storage.put("k", bytesOf("three"), { contentType: "text/three" });
    const read = await storage.get("k");
    expect(Buffer.from(await collect((read as NonNullable<typeof read>).body)).toString()).toBe(
      "three",
    );
    expect(read?.stat.contentType).toBe("text/three");
  });

  it("healthCheck fails when the root is not writable", async () => {
    const storage = createFsStorage({ root: "/proc/fundroom-cannot-exist/x" });
    await expect(storage.healthCheck()).rejects.toSatisfy((e) => isStorageError(e, "backend"));
  });

  it("lists with a bare prefix (no trailing slash) and an unknown prefix", async () => {
    const storage = createFsStorage({ root });
    await storage.put("p/alpha", bytesOf("1"));
    await storage.put("p/beta", bytesOf("2"));
    await storage.put("pq/gamma", bytesOf("3"));
    const page = await storage.list({ prefix: "p" });
    expect(page.objects.map((o) => o.key)).toEqual(["p/alpha", "p/beta", "pq/gamma"]);
    expect((await storage.list({ prefix: "p/" })).objects.map((o) => o.key)).toEqual([
      "p/alpha",
      "p/beta",
    ]);
    expect((await storage.list({ prefix: "zzz/never" })).objects).toEqual([]);
    await expect(storage.list({ prefix: "../x" })).rejects.toSatisfy((e) =>
      isStorageError(e, "invalid_key"),
    );
  });
});
