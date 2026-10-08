import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "@fundroom/storage/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStorage, type FsStorage } from "./fs-storage.js";
import { createTusUploadServer, type TusUploadFinished, type TusUploadServer } from "./tus.js";

const BASE = "http://portal.test";
const PATH = "/api/v1/uploads/tus";
const KNOWN = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b";
const SMALL = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5c";
const KEY =
  "ws/0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a50/quarantine/0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b";

function tusHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Tus-Resumable": "1.0.0", ...extra };
}

function metadata(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString("base64")}`)
    .join(",");
}

describe("tus upload server (fs driver)", () => {
  let root: string;
  let staging: string;
  let storage: FsStorage;
  let server: TusUploadServer;
  let finished: TusUploadFinished[];
  let resolves: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fundroom-tus-"));
    staging = join(root, "staging");
    storage = createFsStorage({ root: join(root, "storage") });
    finished = [];
    resolves = [];
    server = createTusUploadServer({
      storage,
      stagingDir: staging,
      path: PATH,
      maxSize: 1024 * 1024,
      resolveUpload: async (_req, id) => {
        resolves.push(id);
        if (id === KNOWN) return { key: KEY };
        if (id === SMALL) return { key: KEY.replace(KNOWN, SMALL), maxSize: 10 };
        return undefined;
      },
      onUploadFinish: async (u) => {
        finished.push(u);
      },
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  async function create(id: string, length: number, extra: Record<string, string> = {}) {
    return server.handle(
      new Request(`${BASE}${PATH}`, {
        method: "POST",
        headers: tusHeaders({
          "Upload-Length": String(length),
          "Upload-Metadata": metadata({ upload: id, filetype: "application/pdf", ...extra }),
        }),
      }),
    );
  }

  async function patch(location: string, offset: number, bytes: Uint8Array) {
    return server.handle(
      new Request(`${BASE}${location}`, {
        method: "PATCH",
        headers: tusHeaders({
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
          "Content-Length": String(bytes.byteLength),
        }),
        body: bytes,
      }),
    );
  }

  it("answers OPTIONS with the protocol capabilities", async () => {
    const res = await server.handle(new Request(`${BASE}${PATH}`, { method: "OPTIONS" }));
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("tus-version")).toContain("1.0.0");
    expect(res.headers.get("tus-extension")).toContain("creation");
  });

  it("uploads in two chunks, resumes from HEAD, and lands the object at the resolved key", async () => {
    const data = randomBytes(3000);
    const created = await create(KNOWN, data.byteLength);
    expect(created.status).toBe(201);
    const location = created.headers.get("location");
    expect(location).toBe(`${PATH}/${KNOWN}`);

    const first = await patch(location as string, 0, data.subarray(0, 1000));
    expect(first.status).toBe(204);
    expect(first.headers.get("upload-offset")).toBe("1000");

    const head = await server.handle(
      new Request(`${BASE}${location}`, { method: "HEAD", headers: tusHeaders() }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("upload-offset")).toBe("1000");
    expect(head.headers.get("upload-length")).toBe("3000");
    expect(finished).toEqual([]);

    const second = await patch(location as string, 1000, data.subarray(1000));
    expect(second.status).toBe(204);
    expect(second.headers.get("upload-offset")).toBe("3000");

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ uploadId: KNOWN, key: KEY });
    expect(finished[0]?.stat.size).toBe(3000);
    expect(finished[0]?.stat.contentType).toBe("application/pdf");

    const stored = await storage.get(KEY);
    const back = await collect((stored as NonNullable<typeof stored>).body);
    expect(createHash("sha256").update(back).digest("hex")).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    expect(await readdir(staging)).toEqual([]);
    expect(resolves.every((id) => id === KNOWN)).toBe(true);
  });

  it("rejects an offset conflict", async () => {
    const created = await create(KNOWN, 10);
    const location = created.headers.get("location") as string;
    const res = await patch(location, 5, randomBytes(5));
    expect(res.status).toBe(409);
  });

  it("rejects an unknown upload id on create, patch and head", async () => {
    const unknown = "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a99";
    expect((await create(unknown, 10)).status).toBe(404);
    expect((await patch(`${PATH}/${unknown}`, 0, randomBytes(10))).status).toBe(404);
    expect(
      (
        await server.handle(
          new Request(`${BASE}${PATH}/${unknown}`, { method: "HEAD", headers: tusHeaders() }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await server.handle(
          new Request(`${BASE}${PATH}/not-a-uuid`, { method: "HEAD", headers: tusHeaders() }),
        )
      ).status,
    ).toBe(404);
    expect(await readdir(staging).catch(() => [])).toEqual([]);
  });

  it("refuses to name an upload without the app-issued id", async () => {
    const res = await server.handle(
      new Request(`${BASE}${PATH}`, {
        method: "POST",
        headers: tusHeaders({
          "Upload-Length": "10",
          "Upload-Metadata": metadata({ filename: "x" }),
        }),
      }),
    );
    expect(res.status).toBe(400);
    const none = await server.handle(
      new Request(`${BASE}${PATH}`, {
        method: "POST",
        headers: tusHeaders({ "Upload-Length": "10" }),
      }),
    );
    expect(none.status).toBe(400);
  });

  it("enforces the server default and the per-upload size ceiling", async () => {
    expect((await create(KNOWN, 2 * 1024 * 1024)).status).toBe(413);
    expect((await create(SMALL, 11)).status).toBe(413);
    const ok = await create(SMALL, 10);
    expect(ok.status).toBe(201);
    // Bytes beyond the declared length are refused too.
    const res = await patch(ok.headers.get("location") as string, 0, randomBytes(11));
    expect(res.status).toBe(413);
  });

  it("requires the Tus-Resumable header", async () => {
    const res = await server.handle(new Request(`${BASE}${PATH}/${KNOWN}`, { method: "HEAD" }));
    expect(res.status).toBe(412);
  });
});
